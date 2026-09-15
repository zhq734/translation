import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SelectionInteractionController,
  canTreatActivateAsDockLaunch,
  classifySelectionPointerDown,
  resetPointerTrackingForWindowBlur,
  resolvePointerDownTracking
} from '../src/shared/selectionInteraction.ts'

test('选区交互状态应按按钮取词流程转换并保持同一 token', () => {
  const controller = new SelectionInteractionController()

  const buttonToken = controller.showButton()
  assert.deepEqual(controller.snapshot(), { state: 'button-visible', token: buttonToken })

  const captureToken = controller.beginButtonCapture()
  assert.equal(captureToken, buttonToken)
  assert.equal(controller.transition(captureToken as number, 'translating'), true)
  assert.equal(controller.release(captureToken as number), true)
  assert.deepEqual(controller.snapshot(), { state: 'idle', token: buttonToken })
})

test('旧 token 不得转换或清理新一轮选区交互状态', () => {
  const controller = new SelectionInteractionController()
  const oldToken = controller.showButton()
  assert.equal(controller.beginButtonCapture(), oldToken)

  const newToken = controller.showButton()
  assert.ok(newToken > oldToken)
  assert.equal(controller.transition(oldToken, 'translating'), false)
  assert.equal(controller.release(oldToken), false)
  assert.deepEqual(controller.snapshot(), { state: 'button-visible', token: newToken })
})

test('重复点击译按钮只能取得一次 capturing 所有权', () => {
  const controller = new SelectionInteractionController()
  const token = controller.showButton()

  assert.equal(controller.beginButtonCapture(), token)
  assert.equal(controller.beginButtonCapture(), null)
  assert.deepEqual(controller.snapshot(), { state: 'capturing', token })
})

test('普通选区失效不得中断 OCR 所有权，但应取消按钮和翻译流程', () => {
  const controller = new SelectionInteractionController()
  const buttonToken = controller.showButton()

  assert.ok(controller.invalidateSelectionFlow() > buttonToken)
  assert.equal(controller.snapshot().state, 'idle')

  const ocrToken = controller.beginOcrSelection()
  assert.equal(controller.invalidateSelectionFlow(), null)
  assert.deepEqual(controller.snapshot(), { state: 'ocr-selecting', token: ocrToken })
})

test('取词、翻译、OCR 和内部激活租约期间都不得按 Dock 激活处理', () => {
  const base = {
    selectionButtonVisible: false,
    popupVisible: false,
    popupHandingBackFront: false,
    hiServicesRepairPromptVisible: false,
    ocrVisible: false,
    listenerPausedForOcr: false,
    internalActivationLeaseUntil: 0,
    now: 1000
  }

  assert.equal(canTreatActivateAsDockLaunch({ ...base, interactionState: 'capturing' }).allowed, false)
  assert.equal(canTreatActivateAsDockLaunch({ ...base, interactionState: 'translating' }).allowed, false)
  assert.equal(canTreatActivateAsDockLaunch({ ...base, interactionState: 'ocr-selecting' }).allowed, false)
  assert.equal(canTreatActivateAsDockLaunch({
    ...base,
    interactionState: 'idle',
    internalActivationLeaseUntil: 1200
  }).allowed, false)
  // 弹窗正在把 macOS 前台交还给源应用时，其内部 activate 同样不能按 Dock 启动处理，
  // 否则已有的网页翻译或设置页会被顶到最前。
  assert.equal(canTreatActivateAsDockLaunch({
    ...base,
    interactionState: 'idle',
    popupHandingBackFront: true
  }).allowed, false)
  // 连续取词超时的原生修复对话框会激活本应用，其内部 activate 同样必须被抑制，
  // 否则应用内已有的网页翻译窗口会被系统顶到最前。
  assert.equal(canTreatActivateAsDockLaunch({
    ...base,
    interactionState: 'idle',
    hiServicesRepairPromptVisible: true
  }).allowed, false)
  assert.equal(canTreatActivateAsDockLaunch({ ...base, interactionState: 'idle' }).allowed, true)
})

test('鼠标按下应区分消费、自有窗口忽略和外部应用跟踪', () => {
  assert.equal(classifySelectionPointerDown({
    ocrActive: true,
    selectionButtonHit: false,
    popupHit: false,
    focusedOwnWindowHit: false
  }), 'consume')
  assert.equal(classifySelectionPointerDown({
    ocrActive: false,
    selectionButtonHit: true,
    popupHit: false,
    focusedOwnWindowHit: false
  }), 'consume')
  assert.equal(classifySelectionPointerDown({
    ocrActive: false,
    selectionButtonHit: false,
    popupHit: true,
    focusedOwnWindowHit: false
  }), 'ignore')
  assert.equal(classifySelectionPointerDown({
    ocrActive: false,
    selectionButtonHit: false,
    popupHit: false,
    focusedOwnWindowHit: true
  }), 'ignore')
  assert.equal(classifySelectionPointerDown({
    ocrActive: false,
    selectionButtonHit: false,
    popupHit: false,
    focusedOwnWindowHit: false
  }), 'track')
})

test('只有 track 结果会记录拖拽起点，ignore 与 consume 都会清理旧起点', () => {
  const point = { x: 120, y: 240 }
  const tracked = resolvePointerDownTracking('track', point, 1000, false)
  assert.deepEqual(tracked, {
    downAt: { x: 120, y: 240, time: 1000 },
    modifiersHeld: false
  })

  assert.deepEqual(resolvePointerDownTracking('ignore', point, 1001, false), {
    downAt: null,
    modifiersHeld: false
  })
  assert.deepEqual(resolvePointerDownTracking('consume', point, 1002, false), {
    downAt: null,
    modifiersHeld: false
  })
  assert.deepEqual(resolvePointerDownTracking('track', point, 1003, true), {
    downAt: null,
    modifiersHeld: true
  })
})

test('设置窗口失焦只清理窗口内旧起点，不得清除先到达的外部划词按下状态', () => {
  const settingsBounds = { x: 680, y: 100, width: 640, height: 820 }

  assert.deepEqual(resetPointerTrackingForWindowBlur({
    downAt: { x: 760, y: 180, time: 1000 },
    modifiersHeld: false
  }, settingsBounds), {
    downAt: null,
    modifiersHeld: false
  })

  assert.deepEqual(resetPointerTrackingForWindowBlur({
    downAt: { x: 320, y: 520, time: 1001 },
    modifiersHeld: false
  }, settingsBounds), {
    downAt: { x: 320, y: 520, time: 1001 },
    modifiersHeld: false
  })
})

test('内部窗口收尾抑制期内的 activate 必须被抑制，真实 Dock 启动仍放行', () => {
  const base = {
    interactionState: 'idle' as const,
    selectionButtonVisible: false,
    popupVisible: false,
    popupHandingBackFront: false,
    hiServicesRepairPromptVisible: false,
    ocrVisible: false,
    listenerPausedForOcr: false,
    internalActivationLeaseUntil: 0,
    now: 1000
  }

  // 收尾抑制期覆盖「交还前台 → 隐藏弹窗 → hide 生效」整段窗口期，
  // 期间到达的 activate 不能按 Dock 启动处理。
  assert.deepEqual(
    canTreatActivateAsDockLaunch({ ...base, internalWindowTeardown: true }),
    { allowed: false, reason: 'internal-window-teardown' }
  )
  // 抑制期结束且其余检查空闲时，真实 Dock 启动必须放行。
  assert.equal(canTreatActivateAsDockLaunch({ ...base, internalWindowTeardown: false }).allowed, true)
})

test('activate 放行时必须返回判定依据，供日志区分误放行与真实 Dock 启动', () => {
  const base = {
    interactionState: 'idle' as const,
    selectionButtonVisible: false,
    popupVisible: false,
    popupHandingBackFront: false,
    hiServicesRepairPromptVisible: false,
    ocrVisible: false,
    listenerPausedForOcr: false,
    internalActivationLeaseUntil: 0,
    internalWindowTeardown: false,
    now: 1000
  }

  const allowed = canTreatActivateAsDockLaunch(base)
  assert.equal(allowed.allowed, true)
  // 放行路径原本完全静默：必须带回各检查项取值，才能事后判定是否存在内部 activate 误放行。
  assert.deepEqual(allowed.checks, {
    selectionInteractionActive: false,
    selectionButtonVisible: false,
    popupVisible: false,
    popupHandingBackFront: false,
    hiServicesRepairPromptVisible: false,
    ocrVisible: false,
    listenerPausedForOcr: false,
    internalActivationLeaseActive: false,
    internalWindowTeardown: false
  })

  const blocked = canTreatActivateAsDockLaunch({ ...base, popupVisible: true })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.reason, 'translation-popup-visible')
  assert.equal(blocked.checks?.popupVisible, true)
})
