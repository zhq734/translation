import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createScreenshotWindowSelectionState,
  hitTestScreenshotWindowCandidate,
  normalizeScreenshotWindowCandidates,
  reduceScreenshotWindowSelectionState,
  type ScreenshotWindowCandidate,
  type ScreenshotWindowSelectionState
} from '../src/shared/screenshotWindowSelection'
import type { OcrSelectionBeginPayload, OcrSelectionSnapshotPayload } from '../src/shared/types'

const displayBounds = { x: 0, y: 0, width: 500, height: 400 }
const back: ScreenshotWindowCandidate = {
  id: 'back', appName: '后层应用', bounds: { x: 10, y: 10, width: 300, height: 250 }, zOrder: 9
}
const front: ScreenshotWindowCandidate = {
  id: 'front', appName: '前层应用', bounds: { x: 20, y: 20, width: 350, height: 300 }, zOrder: 1
}

/**
 * 创建已收到本屏候选的测试会话。
 * @param sessionId 会话序号，默认使用 1。
 * @param autoTranslate 是否启用快捷 OCR，默认关闭。
 * @returns 已初始化候选和鼠标位置的状态。
 * @author zhenghq
 */
function readyState(sessionId = 1, autoTranslate = false): ScreenshotWindowSelectionState {
  return reduceScreenshotWindowSelectionState(
    createScreenshotWindowSelectionState({
      sessionId, bounds: displayBounds, autoTranslate, cursorPoint: { x: 50, y: 50 }
    }),
    { type: 'snapshot', payload: { sessionId, windowCandidates: [back, front] } }
  )
}

/**
 * 校验类型新增字段可选，兼容旧调用且候选只通过快照传输。
 * @returns 无返回值。
 * @author zhenghq
 */
test('旧 begin 与 snapshot 调用无需传入新字段', () => {
  const begin: OcrSelectionBeginPayload = { sessionId: 1, bounds: displayBounds, autoTranslate: false }
  const snapshot: OcrSelectionSnapshotPayload = { sessionId: 1, bounds: displayBounds }
  const state = reduceScreenshotWindowSelectionState(createScreenshotWindowSelectionState(begin), {
    type: 'snapshot', payload: snapshot
  })
  assert.deepEqual(state.candidates, [])
  assert.equal(state.hoverCandidate, null)
  assert.equal(state.currentRect, null)
})

/**
 * 校验全局负坐标和跨屏窗口被裁剪为当前副屏的局部 DIP，不除缩放倍率。
 * @returns 无返回值。
 * @author zhenghq
 */
test('负坐标副屏裁剪保留小数 DIP 并且不修改原候选', () => {
  const candidate = { ...front, bounds: { x: -2050.5, y: -220.25, width: 2500, height: 1100 } }
  const original = structuredClone(candidate)
  const normalized = normalizeScreenshotWindowCandidates([candidate], {
    x: -1920, y: -200, width: 1920, height: 1080
  })
  assert.deepEqual(normalized, [{ ...front, bounds: { x: 0, y: 0, width: 1920, height: 1079.75 } }])
  assert.deepEqual(candidate, original)
  assert.deepEqual(normalizeScreenshotWindowCandidates([
    { ...back, bounds: { x: -1850.5, y: -170.25, width: 80.5, height: 60.25 } }
  ], { x: -1920, y: -200, width: 1920, height: 1080 })[0].bounds,
  { x: 69.5, y: 29.75, width: 80.5, height: 60.25 })
})

/**
 * 校验过小、屏外、负尺寸和非有限值边界被过滤，最小有效边长为 8 DIP。
 * @returns 无返回值。
 * @author zhenghq
 */
test('候选裁剪后过滤非有限值和不足 8 DIP 的区域', () => {
  const candidates = [
    { ...front, id: 'minimum', bounds: { x: 0, y: 0, width: 8, height: 8 } },
    { ...front, bounds: { x: 496, y: 0, width: 100, height: 100 } },
    { ...front, bounds: { x: 0, y: 0, width: 7.99, height: 100 } },
    { ...front, bounds: { x: 0, y: 0, width: 100, height: 7.99 } },
    { ...front, bounds: { x: 600, y: 0, width: 100, height: 100 } },
    { ...front, bounds: { x: 0, y: 0, width: -10, height: 100 } },
    { ...front, bounds: { x: NaN, y: 0, width: 100, height: 100 } },
    { ...front, bounds: { x: 0, y: Infinity, width: 100, height: 100 } },
    { ...front, bounds: { x: 0, y: 0, width: Infinity, height: 100 } },
    { ...front, bounds: { x: 0, y: 0, width: 100, height: NaN } },
    { ...front, zOrder: NaN },
    { ...front, zOrder: Infinity },
    { ...front, bounds: { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 100 } }
  ]
  assert.deepEqual(normalizeScreenshotWindowCandidates(candidates, displayBounds).map((item) => item.id), ['minimum'])
})

/**
 * 校验显示器非法时归一化直接返回空列表。
 * @returns 无返回值。
 * @author zhenghq
 */
test('无效显示器边界安全降级', () => {
  for (const bounds of [
    { ...displayBounds, x: NaN }, { ...displayBounds, y: Infinity },
    { ...displayBounds, width: 0 }, { ...displayBounds, height: -1 },
    { ...displayBounds, width: Infinity },
    { ...displayBounds, x: Number.MAX_VALUE, width: Number.MAX_VALUE }
  ]) assert.deepEqual(normalizeScreenshotWindowCandidates([front], bounds), [])
})

/**
 * 校验重叠时按更小层级命中而不是按面积或输入顺序选择。
 * @returns 无返回值。
 * @author zhenghq
 */
test('重叠窗口按最小 zOrder 命中并保持输入顺序', () => {
  const candidates = [back, front]
  assert.equal(hitTestScreenshotWindowCandidate(candidates, { x: 50, y: 50 }), front)
  assert.equal(hitTestScreenshotWindowCandidate([front, back], { x: 50, y: 50 }), front)
  assert.equal(hitTestScreenshotWindowCandidate(candidates, { x: 15, y: 15 }), back)
  assert.equal(hitTestScreenshotWindowCandidate([{ ...back, zOrder: -3 }, front], { x: 50, y: 50 })?.id, 'back')
  assert.deepEqual(candidates, [back, front])
})

/**
 * 校验非法输入、相同层级和相邻边界命中的确定性。
 * @returns 无返回值。
 * @author zhenghq
 */
test('命中使用左上包含右下排除且同层保持首个候选', () => {
  assert.equal(hitTestScreenshotWindowCandidate([front, { ...back, zOrder: 1 }], { x: 50, y: 50 }), front)
  assert.equal(hitTestScreenshotWindowCandidate([front], { x: 20, y: 20 }), front)
  assert.equal(hitTestScreenshotWindowCandidate([front], { x: 370, y: 50 }), null)
  assert.equal(hitTestScreenshotWindowCandidate([front], { x: 50, y: 320 }), null)
  assert.equal(hitTestScreenshotWindowCandidate([front], { x: NaN, y: 50 }), null)
  assert.equal(hitTestScreenshotWindowCandidate([front], { x: 50, y: Infinity }), null)
  assert.equal(hitTestScreenshotWindowCandidate([
    { ...front, zOrder: NaN }, { ...front, bounds: { x: 0, y: 0, width: 2, height: 2 } }
  ], { x: 1, y: 1 }), null)
})

/**
 * 校验初始鼠标位置用于候选预览，候选并非正式选区。
 * @returns 无返回值。
 * @author zhenghq
 */
test('begin 鼠标定位初始候选而不写入正式选区', () => {
  const state = readyState()
  assert.equal(state.phase, 'hover')
  assert.equal(state.hoverCandidate?.id, 'front')
  assert.equal(state.currentRect, null)
  assert.equal(state.pressPoint, null)
})

/**
 * 校验快照晚到使用最新鼠标位置而非 begin 中的旧位置。
 * @returns 无返回值。
 * @author zhenghq
 */
test('候选晚到按最新悬停坐标更新且不二次转换全局坐标', () => {
  let state = createScreenshotWindowSelectionState({
    sessionId: 1, bounds: { ...displayBounds, x: -500 }, autoTranslate: false, cursorPoint: { x: 50, y: 50 }
  })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-move', sessionId: 1, point: { x: 15, y: 15 } })
  state = reduceScreenshotWindowSelectionState(state, { type: 'snapshot', payload: { sessionId: 1, windowCandidates: [back, front] } })
  assert.equal(state.hoverCandidate?.id, 'back')
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-move', sessionId: 1, point: { x: 450, y: 350 } })
  assert.equal(state.hoverCandidate, null)
})

/**
 * 校验按下不确认候选，阈值内松开才锁定。
 * @returns 无返回值。
 * @author zhenghq
 */
test('候选按下仅进入 pressed 且 3 DIP 内松开确认整窗', () => {
  const initial = readyState()
  const pressed = reduceScreenshotWindowSelectionState(initial, { type: 'pointer-down', sessionId: 1, point: { x: 50, y: 50 } })
  assert.equal(initial.phase, 'hover')
  assert.equal(pressed.phase, 'pressed')
  assert.equal(pressed.currentRect, null)
  const locked = reduceScreenshotWindowSelectionState(pressed, { type: 'pointer-up', sessionId: 1, point: { x: 53, y: 50 } })
  assert.equal(locked.phase, 'locked')
  assert.deepEqual(locked.currentRect, front.bounds)
  assert.equal(locked.hoverCandidate, null)
  assert.equal(locked.pressPoint, null)
})

/**
 * 校验候选内部越过阈值直接绘制局部选区而非移动整窗。
 * @returns 无返回值。
 * @author zhenghq
 */
test('候选内部超过 3 DIP 后从按下点绘制且松开锁定局部区域', () => {
  let state = readyState()
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-down', sessionId: 1, point: { x: 50, y: 50 } })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-move', sessionId: 1, point: { x: 60, y: 70 } })
  assert.equal(state.phase, 'drawing')
  assert.equal(state.hoverCandidate, null)
  assert.deepEqual(state.currentRect, { x: 50, y: 50, width: 10, height: 20 })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-up', sessionId: 1, point: { x: 80, y: 90 } })
  assert.equal(state.phase, 'locked')
  assert.deepEqual(state.currentRect, { x: 50, y: 50, width: 30, height: 40 })
})

/**
 * 校验阈值用欧氏距离，严格超过 3 才开始且回退不变成候选单击。
 * @returns 无返回值。
 * @author zhenghq
 */
test('欧氏距离超过 3 后不能回退为整窗单击', () => {
  let state = reduceScreenshotWindowSelectionState(readyState(), { type: 'pointer-down', sessionId: 1, point: { x: 50, y: 50 } })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-move', sessionId: 1, point: { x: 53, y: 50 } })
  assert.equal(state.phase, 'pressed')
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-move', sessionId: 1, point: { x: 52.2, y: 52.2 } })
  assert.equal(state.phase, 'drawing')
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-up', sessionId: 1, point: { x: 50, y: 50 } })
  assert.equal(state.phase, 'hover')
  assert.equal(state.currentRect, null)
})

/**
 * 校验鼠标抬起即使没有中间移动事件也识别拖拽，逆向绘制被限制在本屏。
 * @returns 无返回值。
 * @author zhenghq
 */
test('无 move 事件的逆向拖拽按抬起点计算并裁剪到本屏', () => {
  const pressed = reduceScreenshotWindowSelectionState(readyState(), { type: 'pointer-down', sessionId: 1, point: { x: 50, y: 50 } })
  const state = reduceScreenshotWindowSelectionState(pressed, { type: 'pointer-up', sessionId: 1, point: { x: -30, y: -10 } })
  assert.equal(state.phase, 'locked')
  assert.deepEqual(state.currentRect, { x: 0, y: 0, width: 50, height: 50 })
})

/**
 * 校验空白单击不建选区，枚举失败时仍可手动拖拽。
 * @returns 无返回值。
 * @author zhenghq
 */
test('空候选降级到手动框选且空白单击不锁定', () => {
  let state = createScreenshotWindowSelectionState({ sessionId: 1, bounds: displayBounds, autoTranslate: false })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-down', sessionId: 1, point: { x: 30, y: 40 } })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-up', sessionId: 1, point: { x: 30, y: 40 } })
  assert.equal(state.phase, 'hover')
  assert.equal(state.currentRect, null)
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-down', sessionId: 1, point: { x: 30, y: 40 } })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-up', sessionId: 1, point: { x: 530, y: 430 } })
  assert.equal(state.phase, 'locked')
  assert.deepEqual(state.currentRect, { x: 30, y: 40, width: 470, height: 360 })
})

/**
 * 校验锁定后的悬停、空白按下和候选响应不改变正式选区。
 * @returns 无返回值。
 * @author zhenghq
 */
test('锁定后不再悬停或接管已有移动缩放与空白单击', () => {
  let state = reduceScreenshotWindowSelectionState(readyState(), { type: 'pointer-down', sessionId: 1, point: { x: 50, y: 50 } })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-up', sessionId: 1, point: { x: 50, y: 50 } })
  for (const type of ['pointer-move', 'pointer-down', 'pointer-up'] as const) {
    state = reduceScreenshotWindowSelectionState(state, { type, sessionId: 1, point: { x: 15, y: 15 } })
    assert.equal(state.phase, 'locked')
    assert.equal(state.hoverCandidate, null)
    assert.deepEqual(state.currentRect, front.bounds)
  }
  state = reduceScreenshotWindowSelectionState(state, { type: 'snapshot', payload: { sessionId: 1, windowCandidates: [back] } })
  assert.equal(state.hoverCandidate, null)
  assert.deepEqual(state.currentRect, front.bounds)
})

/**
 * 校验重新选择只在调用确认后的事件时清除正式选区，并保留本会话候选。
 * @returns 无返回值。
 * @author zhenghq
 */
test('显式重新选区保留候选并按最新鼠标位置恢复预览', () => {
  let state = reduceScreenshotWindowSelectionState(readyState(), { type: 'pointer-down', sessionId: 1, point: { x: 50, y: 50 } })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-up', sessionId: 1, point: { x: 50, y: 50 } })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-move', sessionId: 1, point: { x: 15, y: 15 } })
  state = reduceScreenshotWindowSelectionState(state, { type: 'reselect', sessionId: 1 })
  assert.equal(state.phase, 'hover')
  assert.equal(state.currentRect, null)
  assert.equal(state.hoverCandidate?.id, 'back')
  assert.equal(state.candidates.length, 2)
})

/**
 * 校验取消清理及新会话拒绝旧候选、鼠标、取消和重新选择事件。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取消重开后拒绝旧 session 的全部事件', () => {
  const cancelled = reduceScreenshotWindowSelectionState(readyState(), { type: 'cancel', sessionId: 1 })
  assert.equal(cancelled.sessionId, null)
  assert.equal(cancelled.phase, 'cancelled')
  assert.deepEqual(cancelled.candidates, [])
  assert.equal(cancelled.hoverCandidate, null)
  assert.equal(cancelled.currentRect, null)
  assert.equal(cancelled.cursorPoint, null)
  assert.equal(reduceScreenshotWindowSelectionState(cancelled, { type: 'snapshot', payload: { sessionId: 1, windowCandidates: [front] } }), cancelled)
  const current = createScreenshotWindowSelectionState({ sessionId: 2, bounds: displayBounds, autoTranslate: false })
  assert.equal(reduceScreenshotWindowSelectionState(current, { type: 'snapshot', payload: { sessionId: 1, windowCandidates: [front] } }), current)
  for (const type of ['pointer-move', 'pointer-down', 'pointer-up'] as const) {
    assert.equal(reduceScreenshotWindowSelectionState(current, { type, sessionId: 1, point: { x: 50, y: 50 } }), current)
  }
  assert.equal(reduceScreenshotWindowSelectionState(current, { type: 'cancel', sessionId: 1 }), current)
  assert.equal(reduceScreenshotWindowSelectionState(current, { type: 'reselect', sessionId: 1 }), current)
})

/**
 * 校验快捷 OCR 不启用候选吸附且无候选单击提交行为。
 * @returns 无返回值。
 * @author zhenghq
 */
test('快捷 OCR 忽略窗口候选并仍支持手动框选', () => {
  let state = readyState(1, true)
  assert.equal(state.enabled, false)
  assert.deepEqual(state.candidates, [])
  assert.equal(state.hoverCandidate, null)
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-down', sessionId: 1, point: { x: 50, y: 50 } })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-up', sessionId: 1, point: { x: 50, y: 50 } })
  assert.equal(state.currentRect, null)
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-down', sessionId: 1, point: { x: 50, y: 50 } })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-up', sessionId: 1, point: { x: 80, y: 90 } })
  assert.deepEqual(state.currentRect, { x: 50, y: 50, width: 30, height: 40 })
})

/**
 * 校验非有限鼠标事件被忽略，候选晚到可参与尚未拖拽的单击但不覆盖手动框选。
 * @returns 无返回值。
 * @author zhenghq
 */
test('异常鼠标被忽略且候选晚到不覆盖 drawing', () => {
  const initial = readyState()
  assert.equal(reduceScreenshotWindowSelectionState(initial, { type: 'pointer-down', sessionId: 1, point: { x: NaN, y: 50 } }), initial)
  let state = createScreenshotWindowSelectionState({ sessionId: 1, bounds: displayBounds, autoTranslate: false })
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-down', sessionId: 1, point: { x: 50, y: 50 } })
  const pressed = reduceScreenshotWindowSelectionState(state, { type: 'snapshot', payload: { sessionId: 1, windowCandidates: [front] } })
  assert.equal(reduceScreenshotWindowSelectionState(pressed, { type: 'pointer-up', sessionId: 1, point: { x: 50, y: 50 } }).phase, 'locked')
  state = reduceScreenshotWindowSelectionState(state, { type: 'pointer-move', sessionId: 1, point: { x: 70, y: 80 } })
  state = reduceScreenshotWindowSelectionState(state, { type: 'snapshot', payload: { sessionId: 1, windowCandidates: [front] } })
  assert.equal(state.phase, 'drawing')
  assert.equal(state.hoverCandidate, null)
  assert.deepEqual(state.currentRect, { x: 50, y: 50, width: 20, height: 30 })
})
