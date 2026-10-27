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

test('取词、翻译与 OCR 交互期间都不得按 Dock 激活处理', () => {
  // panel 落地后内部窗口显隐不再触发应用级 activate，判定只需覆盖仍会真实
  // 抢占前台的内部动作：选区交互、取词按钮、翻译弹窗、OCR 与 hiservices 修复流程。
  const base = {
    selectionButtonVisible: false,
    popupVisible: false,
    hiServicesRepairRunning: false,
    ocrVisible: false,
    listenerPausedForOcr: false,
    now: 1000
  }

  assert.equal(canTreatActivateAsDockLaunch({ ...base, interactionState: 'capturing' }).allowed, false)
  assert.equal(canTreatActivateAsDockLaunch({ ...base, interactionState: 'translating' }).allowed, false)
  assert.equal(canTreatActivateAsDockLaunch({ ...base, interactionState: 'ocr-selecting' }).allowed, false)
  // hiservices 自动修复执行期间仍可能有内部 activate，必须被抑制，
  // 否则应用内已有的设置页或网页翻译窗口会被系统顶到最前。
  assert.equal(canTreatActivateAsDockLaunch({
    ...base,
    interactionState: 'idle',
    hiServicesRepairRunning: true
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

test('全部内部窗口与交互状态空闲时真实 Dock 启动必须放行', () => {
  const base = {
    interactionState: 'idle' as const,
    selectionButtonVisible: false,
    popupVisible: false,
    hiServicesRepairRunning: false,
    ocrVisible: false,
    listenerPausedForOcr: false,
    now: 1000
  }

  // 内部状态全部空闲时，activate 只能来自 Dock / 系统入口，必须放行。
  assert.equal(canTreatActivateAsDockLaunch(base).allowed, true)
  // 任一内部窗口或交互仍活跃时都必须拦截，避免内部 activate 误开设置页。
  assert.equal(canTreatActivateAsDockLaunch({ ...base, selectionButtonVisible: true }).allowed, false)
  assert.equal(canTreatActivateAsDockLaunch({ ...base, popupVisible: true }).allowed, false)
  assert.equal(canTreatActivateAsDockLaunch({ ...base, ocrVisible: true }).allowed, false)
  assert.equal(canTreatActivateAsDockLaunch({ ...base, listenerPausedForOcr: true }).allowed, false)
})

test('划词手势刚结束的内部 activate 必须被短租约拦截，真实 Dock 激活在租约过期后放行', () => {
  const base = {
    interactionState: 'idle' as const,
    selectionButtonVisible: false,
    popupVisible: false,
    hiServicesRepairRunning: false,
    ocrVisible: false,
    listenerPausedForOcr: false,
    now: 1000
  }

  // 划词手势已结束、按钮或弹窗尚未接管焦点时，activate 会短暂呈现全空闲。
  // 该窗口期只能按最近一次内部激活时间拦截，否则会把内部激活误当成 Dock 点击，
  // 从而打开/置前设置页。
  const leased = canTreatActivateAsDockLaunch({
    ...base,
    selectionActivationSuppressUntil: 1400
  })
  assert.equal(leased.allowed, false)
  assert.equal(leased.reason, 'selection-activation-suppressed')

  const expired = canTreatActivateAsDockLaunch({
    ...base,
    selectionActivationSuppressUntil: 900
  })
  assert.equal(expired.allowed, true)
})

test('activate 放行时必须返回判定依据，供日志区分误放行与真实 Dock 启动', () => {
  const base = {
    interactionState: 'idle' as const,
    selectionButtonVisible: false,
    popupVisible: false,
    hiServicesRepairRunning: false,
    ocrVisible: false,
    listenerPausedForOcr: false,
    now: 1000
  }

  const allowed = canTreatActivateAsDockLaunch(base)
  assert.equal(allowed.allowed, true)
  // 放行路径原本完全静默：必须带回各检查项取值，才能事后判定是否存在内部 activate 误放行。
  assert.deepEqual(allowed.checks, {
    selectionInteractionActive: false,
    selectionButtonVisible: false,
    popupVisible: false,
    hiServicesRepairRunning: false,
    ocrVisible: false,
    listenerPausedForOcr: false,
    selectionActivationSuppressed: false
  })

  const blocked = canTreatActivateAsDockLaunch({ ...base, popupVisible: true })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.reason, 'translation-popup-visible')
  assert.equal(blocked.checks?.popupVisible, true)
})
