import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  buildFrontmostWindowSnapshot,
  containsPoint,
  createWindowTitleFingerprint,
  resolveWindowCaptureTarget,
  resolveTargetWindow,
  resolveWindowLocateOutcome,
  type FrontmostWindowSnapshot,
  type MacosWindowInfo
} from '../src/shared/macosWindowSnapshot.ts'

/** 构造测试用窗口信息。 */
function makeWindow(overrides: Partial<MacosWindowInfo> = {}): MacosWindowInfo {
  return {
    pid: 4242,
    windowNumber: 101,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    title: '微信',
    layer: 0,
    ...overrides
  }
}

/**
 * 校验窗口边界包含判断覆盖内部、边界与外部点。
 * @returns 无返回值。
 * @author zhenghq
 */
test('containsPoint 应判断点是否落在窗口边界内', () => {
  const bounds = { x: 100, y: 100, width: 200, height: 100 }
  assert.equal(containsPoint(bounds, { x: 100, y: 100 }), true)
  assert.equal(containsPoint(bounds, { x: 300, y: 200 }), true)
  assert.equal(containsPoint(bounds, { x: 99, y: 150 }), false)
  assert.equal(containsPoint(bounds, { x: 301, y: 150 }), false)
})

/**
 * 校验标题指纹只输出稳定哈希且不包含标题明文。
 * @returns 无返回值。
 * @author zhenghq
 */
test('createWindowTitleFingerprint 应输出稳定哈希且不含明文', () => {
  const fingerprint = createWindowTitleFingerprint('张三 - 微信')
  const expected = createHash('sha256').update('张三 - 微信').digest('hex').slice(0, 12)
  assert.equal(fingerprint, expected)
  assert.equal(fingerprint.length, 12)
  assert.ok(!fingerprint.includes('张三'))
})

/**
 * 校验空标题返回空指纹，避免把空值误判为同一窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('createWindowTitleFingerprint 应对空标题返回空串', () => {
  assert.equal(createWindowTitleFingerprint(''), '')
  assert.equal(createWindowTitleFingerprint('   '), '')
  assert.equal(createWindowTitleFingerprint(undefined), '')
})

/**
 * 校验按锚点选择窗口时优先命中包含坐标的普通窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveTargetWindow 应按锚点坐标选择包含该点的窗口', () => {
  const windows = [
    makeWindow({ windowNumber: 101, bounds: { x: 0, y: 0, width: 400, height: 400 } }),
    makeWindow({ windowNumber: 102, bounds: { x: 500, y: 0, width: 400, height: 400 } })
  ]
  const selected = resolveTargetWindow({ windows, point: { x: 550, y: 100 }, pid: 4242 })
  assert.equal(selected?.windowNumber, 102)
})

/**
 * 校验坐标不命中任何窗口时返回 null，由调用方退化为应用级快照。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveTargetWindow 应在坐标不命中时返回 null', () => {
  const windows = [makeWindow()]
  assert.equal(resolveTargetWindow({ windows, point: { x: 900, y: 900 }, pid: 4242 }), null)
})

/**
 * 校验非普通层级窗口与其它进程窗口被排除。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveTargetWindow 应排除非普通层与其它进程窗口', () => {
  const windows = [
    makeWindow({ windowNumber: 1, layer: 25 }),
    makeWindow({ windowNumber: 2, pid: 9999 })
  ]
  assert.equal(resolveTargetWindow({ windows, point: { x: 10, y: 10 }, pid: 4242 }), null)
})

/**
 * 校验多窗口重叠时优先保留 CGWindowList 的前后顺序。
 *
 * 微信两个窗口可能几乎完全重叠；此时面积差异只是窗口尺寸噪声，
 * 不能覆盖系统给出的“哪个窗口更靠前”这一权威信号。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveTargetWindow 应在重叠时优先选择 CGWindowList 更靠前的窗口', () => {
  const windows = [
    makeWindow({ windowNumber: 101, bounds: { x: 0, y: 0, width: 800, height: 601 } }),
    makeWindow({ windowNumber: 102, bounds: { x: 0, y: 0, width: 800, height: 600 } })
  ]
  const selected = resolveTargetWindow({ windows, point: { x: 150, y: 150 }, pid: 4242 })
  assert.equal(selected?.windowNumber, 101,
    '坐标重叠时必须相信 CGWindowList 顺序，不能因 1px 面积差选中后台窗口')
})

/**
 * 校验窗口快照包含应用级字段与窗口级字段，并生成标题指纹。
 * @returns 无返回值。
 * @author zhenghq
 */
test('buildFrontmostWindowSnapshot 应生成窗口级快照', () => {
  const snapshot = buildFrontmostWindowSnapshot({
    bundleId: 'com.tencent.xinWeChat',
    pid: 4242,
    window: makeWindow({ windowNumber: 102, title: '李四 - 微信' }),
    capturedAt: 1_700_000_000_000
  })
  assert.equal(snapshot.bundleId, 'com.tencent.xinwechat')
  assert.equal(snapshot.pid, 4242)
  assert.equal(snapshot.windowNumber, 102)
  assert.deepEqual(snapshot.bounds, { x: 0, y: 0, width: 800, height: 600 })
  assert.equal(snapshot.titleFingerprint.length, 12)
  assert.ok(!JSON.stringify(snapshot).includes('李四'))
})

/**
 * 校验缺少窗口信息时构建应用级快照，窗口字段全部为可选缺省值。
 * @returns 无返回值。
 * @author zhenghq
 */
test('buildFrontmostWindowSnapshot 应在无窗口信息时退化为应用级快照', () => {
  const snapshot = buildFrontmostWindowSnapshot({
    bundleId: 'com.apple.Safari',
    pid: 100,
    window: null,
    capturedAt: 1_700_000_000_000
  })
  assert.equal(snapshot.bundleId, 'com.apple.safari')
  assert.equal(snapshot.windowNumber, undefined)
  assert.equal(snapshot.bounds, undefined)
  assert.equal(snapshot.titleFingerprint, undefined)
})

/**
 * 校验窗口定位尝试失败时，应用级快照仍保留失败标记。
 * 微信多窗口场景若丢失该标记，后续激活会误走 open -b 并切到另一个窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('buildFrontmostWindowSnapshot 应保留窗口定位失败状态', () => {
  const snapshot = buildFrontmostWindowSnapshot({
    bundleId: 'com.tencent.xinwechat',
    pid: 4242,
    window: null,
    capturedAt: 1,
    windowLocate: 'failed'
  })

  assert.equal(snapshot.windowLocate, 'failed')
  assert.equal(snapshot.windowNumber, undefined)
  assert.equal(snapshot.bounds, undefined)
})

/**
 * 校验窗口定位结果分类：精确命中、应用级退化与失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveWindowLocateOutcome 应区分精确命中与应用级退化', () => {
  assert.equal(resolveWindowLocateOutcome({ hasWindow: true, exactMatched: true }), 'exact')
  assert.equal(resolveWindowLocateOutcome({ hasWindow: true, exactMatched: false }), 'failed')
  assert.equal(resolveWindowLocateOutcome({ hasWindow: false, exactMatched: false }), 'app-fallback')
})

/**
 * 校验按坐标解析窗口时保留目标窗口数量与匹配结果，供入口诊断使用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveWindowCaptureTarget 应返回窗口数量与命中状态', () => {
  const windows = [
    makeWindow({ windowNumber: 101, bounds: { x: 0, y: 0, width: 400, height: 400 } }),
    makeWindow({ windowNumber: 102, bounds: { x: 500, y: 0, width: 400, height: 400 } })
  ]
  const target = resolveWindowCaptureTarget({
    windows,
    pid: 4242,
    point: { x: 550, y: 100 }
  })

  assert.equal(target.windowCount, 2)
  assert.equal(target.windowMatched, true)
  assert.equal(target.window?.windowNumber, 102)
  assert.equal(target.outcome, 'exact')
})

/**
 * 校验坐标不命中时返回应用级退化，而不是抛出异常。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveWindowCaptureTarget 应在坐标不命中时返回应用级退化', () => {
  const target = resolveWindowCaptureTarget({
    windows: [makeWindow()],
    pid: 4242,
    point: { x: 900, y: 900 }
  })

  assert.equal(target.windowCount, 1)
  assert.equal(target.windowMatched, false)
  assert.equal(target.window, null)
  assert.equal(target.outcome, 'app-fallback')
})

/**
 * 校验多窗口场景下坐标未命中时不得退化为应用级激活。
 *
 * 微信与 Chrome for Testing 的同进程多窗口共享 bundle id，坐标未命中时
 * 无法判断用户目标窗口，应用级 open -b 会把另一个窗口带到最前并导致取词超时。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveWindowCaptureTarget 应在多窗口坐标未命中时返回 failed', () => {
  const target = resolveWindowCaptureTarget({
    windows: [
      makeWindow({ windowNumber: 101 }),
      makeWindow({ windowNumber: 102, bounds: { x: 900, y: 0, width: 800, height: 600 } })
    ],
    pid: 4242,
    point: { x: 2_000, y: 2_000 }
  })

  assert.equal(target.windowCount, 2)
  assert.equal(target.windowMatched, false)
  assert.equal(target.window, null)
  assert.equal(target.outcome, 'failed')
})

/**
 * 校验窗口枚举失败时保留未知语义，不能把无法读取的窗口数量伪报为 0。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveWindowCaptureTarget 应在窗口枚举失败时返回 failed 与未知数量', () => {
  const target = resolveWindowCaptureTarget({
    windows: null,
    pid: 4242,
    point: { x: 100, y: 100 }
  })

  assert.equal(target.windowCount, undefined)
  assert.equal(target.windowMatched, false)
  assert.equal(target.window, null)
  assert.equal(target.outcome, 'failed')
})

/**
 * 校验窗口枚举成功但结果为空时仍报告真实窗口数量 0，并允许应用级退化。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveWindowCaptureTarget 应在成功枚举空窗口时返回数量 0', () => {
  const target = resolveWindowCaptureTarget({
    windows: [],
    pid: 4242,
    point: { x: 100, y: 100 }
  })

  assert.equal(target.windowCount, 0)
  assert.equal(target.windowMatched, false)
  assert.equal(target.window, null)
  assert.equal(target.outcome, 'app-fallback')
})

/**
 * 校验窗口编号优先于边界与标题指纹匹配。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口匹配应优先使用窗口编号', () => {
  const snapshot: FrontmostWindowSnapshot = {
    bundleId: 'com.tencent.xinwechat',
    pid: 4242,
    windowNumber: 102,
    bounds: { x: 0, y: 0, width: 400, height: 400 },
    titleFingerprint: createWindowTitleFingerprint('窗口 B'),
    capturedAt: 1
  }
  const windows = [
    makeWindow({ windowNumber: 101, bounds: { x: 0, y: 0, width: 400, height: 400 }, title: '窗口 A' }),
    makeWindow({ windowNumber: 102, bounds: { x: 500, y: 0, width: 400, height: 400 }, title: '窗口 B' })
  ]
  const matched = resolveTargetWindow({ windows, snapshot, pid: 4242 })
  assert.equal(matched?.windowNumber, 102)
})

/**
 * 校验窗口编号缺失时按边界与标题指纹匹配。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口匹配应在编号缺失时按边界与标题指纹匹配', () => {
  const bounds = { x: 500, y: 0, width: 400, height: 400 }
  const snapshot: FrontmostWindowSnapshot = {
    bundleId: 'com.tencent.xinwechat',
    pid: 4242,
    bounds,
    titleFingerprint: createWindowTitleFingerprint('窗口 B'),
    capturedAt: 1
  }
  const windows = [
    makeWindow({ windowNumber: 101, bounds: { x: 0, y: 0, width: 400, height: 400 }, title: '窗口 A' }),
    makeWindow({ windowNumber: 102, bounds, title: '窗口 B' })
  ]
  const matched = resolveTargetWindow({ windows, snapshot, pid: 4242 })
  assert.equal(matched?.windowNumber, 102)
})

/**
 * 校验快照窗口已失效时返回 null，由调用方退化为应用级。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口匹配应在快照窗口已关闭时返回 null', () => {
  const snapshot: FrontmostWindowSnapshot = {
    bundleId: 'com.tencent.xinwechat',
    pid: 4242,
    windowNumber: 102,
    bounds: { x: 500, y: 0, width: 400, height: 400 },
    titleFingerprint: createWindowTitleFingerprint('窗口 B'),
    capturedAt: 1
  }
  const windows = [makeWindow({ windowNumber: 101, title: '窗口 A' })]
  assert.equal(resolveTargetWindow({ windows, snapshot, pid: 4242 }), null)
})

/**
 * 校验窗口编号因窗口重建而失效时，仍可用边界与标题指纹命中同一逻辑窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口匹配应在编号失效时回退到边界与标题指纹', () => {
  const bounds = { x: 500, y: 0, width: 400, height: 400 }
  const snapshot: FrontmostWindowSnapshot = {
    bundleId: 'com.tencent.xinwechat',
    pid: 4242,
    windowNumber: 102,
    bounds,
    titleFingerprint: createWindowTitleFingerprint('窗口 B'),
    capturedAt: 1
  }
  const windows = [
    makeWindow({ windowNumber: 101, bounds: { x: 0, y: 0, width: 400, height: 400 }, title: '窗口 A' }),
    makeWindow({ windowNumber: 205, bounds, title: '窗口 B' })
  ]
  const matched = resolveTargetWindow({ windows, snapshot, pid: 4242 })
  assert.equal(matched?.windowNumber, 205)
})
