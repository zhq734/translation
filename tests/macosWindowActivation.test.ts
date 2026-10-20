import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  activateMacosWindowSnapshot,
  classifyMacosWindowHelperFailure,
  isExactWindowActivationConfirmed,
  isFailedWindowActivation,
  MACOS_WINDOW_ENUMERATION_TIMEOUT_MS,
  type MacosWindowActivationResult,
  type MacosWindowActivationDeps
} from '../src/main/macosWindowActivation.ts'
import type { FrontmostWindowSnapshot, MacosWindowInfo } from '../src/shared/macosWindowSnapshot.ts'

const macForegroundSource = readFileSync('src/main/macForeground.ts', 'utf8')

/**
 * 从源码中截取指定函数的完整片段。
 * @param source 待检索源码。
 * @param signature 函数签名起始片段。
 * @returns 从签名到函数结束的源码。
 * @author zhenghq
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end)
}

/**
 * 去掉源码注释，避免注释文本干扰接线断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

/**
 * 构造测试用窗口快照。
 * @param overrides 快照覆盖字段。
 * @returns 窗口级快照。
 * @author zhenghq
 */
function makeSnapshot(overrides: Partial<FrontmostWindowSnapshot> = {}): FrontmostWindowSnapshot {
  return {
    bundleId: 'com.tencent.xinwechat',
    pid: 4242,
    windowNumber: 102,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    capturedAt: 1,
    ...overrides
  }
}

/**
 * 构造测试用普通窗口。
 * @param overrides 窗口覆盖字段。
 * @returns 窗口信息。
 * @author zhenghq
 */
function makeWindow(overrides: Partial<MacosWindowInfo> = {}): MacosWindowInfo {
  return {
    pid: 4242,
    windowNumber: 102,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    title: '窗口 B',
    layer: 0,
    ...overrides
  }
}

/**
 * 创建可注入的激活依赖。
 * @param overrides 依赖覆盖项。
 * @returns 激活依赖。
 * @author zhenghq
 */
function makeDeps(overrides: Partial<MacosWindowActivationDeps> = {}): MacosWindowActivationDeps {
  return {
    enumerateWindows: async () => ({ windows: [makeWindow()] }),
    readFrontmostWindowNumber: async () => null,
    raiseWindow: async () => true,
    readFocusedWindowNumber: async () => 102,
    openApplication: () => true,
    isProcessAlive: () => true,
    now: () => 1_000,
    sleep: async () => undefined,
    ...overrides
  }
}

/**
 * 校验窗口枚举超时足以覆盖 helper 进程冷启动与 CGWindowList 查询。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口枚举硬超时应覆盖 helper 实测启动开销', () => {
  assert.ok(MACOS_WINDOW_ENUMERATION_TIMEOUT_MS >= 150,
    '50ms 会周期性截断实测 50-90ms 的 helper 启动，至少应放宽到 150ms')
})

/**
 * 校验源窗口已在前台时不重复发起窗口激活。
 * 真机日志中 handBack 与 captureByCopy 会连续执行两次激活，导致微信窗口切换。
 * @returns 无返回值。
 * @author zhenghq
 */
test('源窗口已在前台时不得再次 raise 或 open -b', async () => {
  let raiseCalls = 0
  let openCalls = 0
  const windows = [
    makeWindow(),
    makeWindow({ windowNumber: 101, bounds: { x: 900, y: 0, width: 800, height: 600 } })
  ]
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => ({ windows }),
    readFocusedWindowNumber: async () => 102,
    raiseWindow: async () => {
      raiseCalls += 1
      return true
    },
    openApplication: () => {
      openCalls += 1
      return true
    }
  }))
  assert.deepEqual(result, {
    activated: true,
    confirmed: true,
    outcome: 'exact',
    windowCount: 2,
    windowMatched: true
  })
  assert.equal(raiseCalls, 0, '目标窗口已是 focused window 时不得重复 raise')
  assert.equal(openCalls, 0, '目标窗口已在前台时不得重复 open -b')
})

/**
 * 校验微信不暴露 AX focused window 时，可通过 CGWindowList 最前窗口顺序确认目标窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('AX focused 不可用时应使用 CGWindowList 最前窗口确认目标窗口', async () => {
  let raiseCalls = 0
  let openCalls = 0
  const windows = [
    makeWindow(),
    makeWindow({ windowNumber: 101, bounds: { x: 900, y: 0, width: 800, height: 600 } })
  ]
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => ({
      windows,
      frontmostWindowNumber: 102,
      frontmostPid: 4242
    }),
    readFocusedWindowNumber: async () => null,
    raiseWindow: async () => {
      raiseCalls += 1
      return true
    },
    openApplication: () => {
      openCalls += 1
      return true
    }
  }))
  assert.deepEqual(result, {
    activated: true,
    confirmed: true,
    outcome: 'exact',
    windowCount: 2,
    windowMatched: true
  })
  assert.equal(raiseCalls, 0, '目标窗口已是全局最前窗口时不得调用 AXRaise')
  assert.equal(openCalls, 0, '目标窗口已是全局最前窗口时不得调用 open -b')
})

/**
 * 校验 CGWindowList 最前窗口属于另一个微信窗口时，仍必须尝试精确激活目标窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('全局最前窗口不是目标窗口时不得误判为已激活', async () => {
  let raiseCalls = 0
  let focusReads = 0
  let now = 1_000
  const windows = [
    makeWindow({ windowNumber: 101, bounds: { x: 900, y: 0, width: 800, height: 600 } }),
    makeWindow()
  ]
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => ({
      windows,
      frontmostWindowNumber: 101,
      frontmostPid: 4242
    }),
    readFocusedWindowNumber: async () => {
      focusReads += 1
      return focusReads === 1 ? null : 102
    },
    now: () => now,
    sleep: async () => {
      now += 50
    },
    raiseWindow: async () => {
      raiseCalls += 1
      return true
    }
  }))
  assert.equal(result.outcome, 'exact')
  assert.equal(raiseCalls, 1, '目标窗口不是全局最前窗口时必须尝试精确激活')
})

/**
 * 校验窗口级激活成功后返回精确命中，且不会调用应用级 open -b。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口级激活成功时应确认 focused window 且不退化为应用级', async () => {
  let openCalls = 0
  let now = 1_000
  const windows = [makeWindow(), makeWindow({ windowNumber: 101, bounds: { x: 900, y: 0, width: 800, height: 600 } })]
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => ({
      windows,
      frontmostWindowNumber: 101,
      frontmostPid: 4242
    }),
    readFocusedWindowNumber: async () => 102,
    now: () => now,
    sleep: async () => {
      now += 50
    },
    openApplication: () => {
      openCalls += 1
      return true
    }
  }))
  assert.deepEqual(result, {
    activated: true,
    confirmed: true,
    outcome: 'exact',
    windowCount: 2,
    windowMatched: true
  })
  assert.equal(openCalls, 0)
})

/**
 * 校验微信不暴露 AX focused window 时，raise 后仍可通过 CGWindowList 确认目标窗口。
 *
 * 真机微信的 AXFocusedWindow 持续返回 -25201；若 raise 后只轮询 AX，
 * 会把已经成功置前的目标窗口误判为失败并再次执行 open -b，从而切到另一个微信窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('raise 后 AX focused 不可用时应通过 CGWindowList 确认且不得再次 open -b', async () => {
  let openCalls = 0
  let frontmostReads = 0
  let now = 1_000
  const windows = [
    makeWindow({ windowNumber: 101, bounds: { x: 900, y: 0, width: 800, height: 600 } }),
    makeWindow()
  ]
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => ({
      windows,
      frontmostWindowNumber: 101,
      frontmostPid: 4242
    }),
    readFrontmostWindowNumber: async () => {
      frontmostReads += 1
      return 102
    },
    readFocusedWindowNumber: async () => null,
    raiseWindow: async () => true,
    now: () => now,
    sleep: async () => {
      now += 20
    },
    openApplication: () => {
      openCalls += 1
      return true
    }
  }))
  assert.deepEqual(result, {
    activated: true,
    confirmed: true,
    outcome: 'exact',
    windowCount: 2,
    windowMatched: true
  })
  assert.ok(frontmostReads >= 1, 'raise 后必须轮询 CGWindowList 最前窗口')
  assert.equal(openCalls, 0, 'CGWindowList 已确认目标窗口时不得再次 open -b')
})

/**
 * 校验目标窗口已关闭时不得尝试 raise 不存在的窗口或执行应用级 open -b。
 * @returns 无返回值。
 * @author zhenghq
 */
test('目标窗口已关闭时应返回 failed 且不得执行 open -b', async () => {
  let raiseCalls = 0
  let openCalls = 0
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => ({ windows: [makeWindow({
      windowNumber: 101,
      bounds: { x: 900, y: 0, width: 800, height: 600 },
      title: '窗口 A'
    })] }),
    raiseWindow: async () => {
      raiseCalls += 1
      return true
    },
    openApplication: () => {
      openCalls += 1
      return true
    }
  }))
  assert.deepEqual(result, {
    activated: false,
    confirmed: false,
    outcome: 'failed',
    windowCount: 1,
    windowMatched: false
  })
  assert.equal(raiseCalls, 0)
  assert.equal(openCalls, 0)
})

/**
 * 校验窗口枚举失败时不得把未知窗口数量伪报为 0，也不得执行应用级 open -b。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口枚举失败时应返回 failed、不记录 windowCount 且不得 open -b', async () => {
  let openCalls = 0
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => {
      throw new Error('枚举超时')
    },
    openApplication: () => {
      openCalls += 1
      return true
    }
  }))
  assert.deepEqual(result, {
    activated: false,
    confirmed: false,
    outcome: 'failed',
    windowMatched: false
  })
  assert.equal(openCalls, 0)
})

/**
 * 校验入口已精确命中的窗口在后续枚举失败时不得直接复用旧快照。
 *
 * 真机日志中入口刚记录到 `windowLocate=exact`，但复制前 helper 超时后无法
 * 再次确认目标窗口仍在前台。此时若继续注入 Cmd+C，按键可能落到同进程的
 * 另一个窗口；必须安全失败，等待下一次入口重新记录并确认窗口。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('入口精确命中后复制前枚举失败必须安全失败', async () => {
  let openCalls = 0
  const result = await activateMacosWindowSnapshot(
    makeSnapshot({ windowLocate: 'exact' }),
    makeDeps({
      enumerateWindows: async () => {
        throw new Error('窗口 helper 超时')
      },
      openApplication: () => {
        openCalls += 1
        return true
      }
    })
  )

  assert.deepEqual(result, {
    activated: false,
    confirmed: false,
    outcome: 'failed',
    windowMatched: false
  })
  assert.equal(openCalls, 0, '无法确认目标窗口时不得退化为应用级 open -b')
})

/**
 * 校验入口精确命中后复制前无法匹配目标窗口时必须安全失败。
 *
 * Chrome for Testing 双窗口真机日志中，入口记录为 `windowLocate=exact`，
 * 复制前再次枚举却只返回一个不同窗口。入口记录不能证明该窗口仍是当前
 * focused/frontmost 窗口，因此必须安全失败；既不能 open -b，也不能继续
 * 向不确定的窗口注入 Cmd+C。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('入口精确命中后复制前目标窗口不匹配时必须安全失败', async () => {
  let openCalls = 0
  const result = await activateMacosWindowSnapshot(
    makeSnapshot({ windowLocate: 'exact' }),
    makeDeps({
      enumerateWindows: async () => ({
        windows: [makeWindow({
          windowNumber: 999,
          bounds: { x: 900, y: 0, width: 800, height: 600 }
        })]
      }),
      openApplication: () => {
        openCalls += 1
        return true
      }
    })
  )

  assert.deepEqual(result, {
    activated: false,
    confirmed: false,
    outcome: 'failed',
    windowCount: 1,
    windowMatched: false
  })
  assert.equal(openCalls, 0, '目标窗口不匹配时不得执行 open -b')
})

/**
 * 校验复制链路只会在窗口激活失败时提前终止，不影响应用级或已确认结果。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口激活失败必须触发复制链路早退', () => {
  assert.equal(isFailedWindowActivation(null), false)
  assert.equal(isFailedWindowActivation({
    activated: false,
    confirmed: false,
    outcome: 'failed',
    windowMatched: false
  }), true)
  assert.equal(isFailedWindowActivation({
    activated: true,
    confirmed: true,
    outcome: 'exact',
    windowMatched: true
  }), false)
  assert.equal(isFailedWindowActivation({
    activated: true,
    confirmed: true,
    outcome: 'app-fallback',
    windowMatched: false
  }), false)
})

/**
 * 校验只有精确确认的目标窗口可以作为取词前交还完成。
 * 应用级退化只能继续走失活轮询，未确认的 raise 与 blur 兜底都不能标记 settled。
 * @returns 无返回值。
 * @author zhenghq
 */
test('只有精确确认的窗口激活可作为取词交还完成', () => {
  assert.equal(isExactWindowActivationConfirmed({
    activated: true,
    confirmed: true,
    outcome: 'exact',
    windowMatched: true
  }), true)
  assert.equal(isExactWindowActivationConfirmed({
    activated: true,
    confirmed: false,
    outcome: 'exact',
    windowMatched: true
  }), false)
  assert.equal(isExactWindowActivationConfirmed({
    activated: true,
    confirmed: true,
    outcome: 'app-fallback',
    windowMatched: false
  }), false)
  assert.equal(isExactWindowActivationConfirmed({
    activated: false,
    confirmed: false,
    outcome: 'failed',
    windowMatched: false
  }), false)
})

/**
 * 校验入口精确命中的窗口已经关闭时不得继续信任旧快照。
 *
 * 入口事实只能在“无法再次确认”时作为保守回退；若复制前成功枚举到零个普通
 * 窗口，说明目标应用已经没有可用取词窗口。此时必须返回 failed，不能对已关闭
 * 窗口注入 Cmd+C，也不能用 open -b 猜测其它窗口。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('入口精确命中的窗口已关闭时应返回 failed 且不得 open -b', async () => {
  let openCalls = 0
  const result = await activateMacosWindowSnapshot(
    makeSnapshot({ windowLocate: 'exact' }),
    makeDeps({
      enumerateWindows: async () => ({ windows: [] }),
      openApplication: () => {
        openCalls += 1
        return true
      }
    })
  )

  assert.deepEqual(result, {
    activated: false,
    confirmed: false,
    outcome: 'failed',
    windowCount: 0,
    windowMatched: false
  })
  assert.equal(openCalls, 0, '入口窗口已关闭时不得用 open -b 猜测同进程其它窗口')
})

/**
 * 校验多窗口场景下窗口枚举失败时不得执行应用级 open -b。
 *
 * 微信的多个独立聊天窗口共享同一个 bundle id，应用级激活会把另一个窗口带到
 * 最前；随后注入的 Cmd+C 落在错误窗口上，反而使原本可用的选区取词超时。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('多窗口快照枚举失败时不得退化为应用级 open -b', async () => {
  let openCalls = 0
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => {
      throw new Error('枚举超时')
    },
    openApplication: () => {
      openCalls += 1
      return true
    }
  }))
  assert.deepEqual(result, {
    activated: false,
    confirmed: false,
    outcome: 'failed',
    windowMatched: false
  })
  assert.equal(openCalls, 0, '多窗口无法确认目标时不得执行会切错窗口的 open -b')
})

/**
 * 校验 raise 本身失败时不得追加应用级 open -b。
 *
 * 此时仍无法确认目标窗口，应用级激活会切换到同进程的另一个窗口，
 * 因此只能返回失败，由上层走弹窗 blur 兜底。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('多窗口精确 raise 失败时不得退化为应用级 open -b', async () => {
  let openCalls = 0
  const windows = [
    makeWindow({ windowNumber: 101, bounds: { x: 900, y: 0, width: 800, height: 600 } }),
    makeWindow()
  ]
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => ({
      windows,
      frontmostWindowNumber: 101,
      frontmostPid: 4242
    }),
    readFocusedWindowNumber: async () => 101,
    raiseWindow: async () => false,
    openApplication: () => {
      openCalls += 1
      return true
    }
  }))
  assert.deepEqual(result, {
    activated: false,
    confirmed: false,
    outcome: 'failed',
    windowCount: 2,
    windowMatched: true
  })
  assert.equal(openCalls, 0, 'raise 失败时不得切换同进程其它窗口')
})

/**
 * 校验多窗口场景下快照窗口已失效时不得执行应用级 open -b。
 *
 * 快照明确指向过某个窗口，但当前枚举结果中已找不到它时，应用级激活仍可能
 * 把同进程的其它窗口切到最前，因此必须放弃激活并由调用方走 blur 兜底。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('多窗口快照目标失效时不得退化为应用级 open -b', async () => {
  let openCalls = 0
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => ({
      windows: [
        makeWindow({ windowNumber: 101, bounds: { x: 900, y: 0, width: 800, height: 600 } }),
        makeWindow({ windowNumber: 103, bounds: { x: 1800, y: 0, width: 800, height: 600 } })
      ]
    }),
    openApplication: () => {
      openCalls += 1
      return true
    }
  }))
  assert.deepEqual(result, {
    activated: false,
    confirmed: false,
    outcome: 'failed',
    windowCount: 2,
    windowMatched: false
  })
  assert.equal(openCalls, 0, '目标窗口失效时不得切到同进程的其它微信窗口')
})

/**
 * 校验多窗口场景下精确激活确认超时后不得执行应用级 open -b。
 *
 * raise 已发出但 200ms 内无法确认目标窗口时，应用级激活同样可能改变微信
 * 当前窗口；应保留已发出的精确激活结果并交由调用方 blur 兜底。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('多窗口精确激活确认超时后不得再次 open -b', async () => {
  let now = 1_000
  let openCalls = 0
  const windows = [
    makeWindow(),
    makeWindow({ windowNumber: 101, bounds: { x: 900, y: 0, width: 800, height: 600 } })
  ]
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => ({
      windows,
      frontmostWindowNumber: 101,
      frontmostPid: 4242
    }),
    readFocusedWindowNumber: async () => 101,
    raiseWindow: async () => true,
    now: () => now,
    sleep: async () => {
      now += 50
    },
    openApplication: () => {
      openCalls += 1
      return true
    }
  }))
  assert.deepEqual(result, {
    activated: true,
    confirmed: false,
    outcome: 'failed',
    windowCount: 2,
    windowMatched: true
  })
  assert.equal(openCalls, 0, '精确 raise 已发出时不得再用 open -b 改变微信当前窗口')
})

/**
 * 校验取词入口记录窗口时，枚举失败必须保留未知状态而不是回退为空数组。
 * @returns 无返回值。
 * @author zhenghq
 */
test('记录源窗口时枚举失败不得把未知窗口数量伪报为 0', () => {
  const source = stripComments(
    extractFunction(
      macForegroundSource,
      'export async function rememberFrontmostWindowAtPoint('
    )
  )
  assert.match(source, /let windowList:[^=]+(?:\|\s*null)?\s*$/mu,
    '窗口变量必须允许 null 表示枚举失败')
  assert.match(source, /catch\s*\{[\s\S]*?windowList\s*=\s*null/u,
    '枚举异常必须记录为 null')
  assert.doesNotMatch(source, /catch\s*\{[\s\S]*?windowList\s*=\s*\{[^}]*windows\s*:\s*\[\]/u,
    '枚举异常不得伪装成成功枚举的空窗口列表')
  assert.match(source, /windowCount=\$\{target\.windowCount\s*\?\?\s*'unknown'\}/u,
    '未知窗口数量必须输出 unknown')
  assert.match(source, /windowLocate:\s*target\.outcome/u,
    '记录阶段必须把窗口定位失败状态写入快照')
})

/**
 * 校验入口上下文保留窗口定位失败状态，供复制链路阻止 open -b。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取词入口上下文必须保留窗口定位失败状态', () => {
  const hotkeySource = stripComments(
    extractFunction(macForegroundSource, 'export async function rememberFrontmostWindowAtPoint(')
  )
  assert.match(hotkeySource, /windowLocate:\s*target\.outcome/u)

  const indexSource = readFileSync('src/main/index.ts', 'utf8')
  const contextAssignments = [
    extractFunction(indexSource, 'function onHotkey(): void {'),
    extractFunction(indexSource, 'function scheduleSelectionAction(anchor: { x: number; y: number }): void {')
  ]
  for (const assignment of contextAssignments) {
    assert.match(assignment, /windowLocate:\s*recorded\.snapshot\.windowLocate/u,
      '入口上下文必须透传窗口定位失败状态')
  }
})

/**
 * 校验单窗口的窗口级快照仍须精确确认目标窗口，不得调用应用级 open -b。
 *
 * Chrome for Testing 只有一个窗口时，入口已经记录到精确窗口编号；若复制前
 * 因为窗口数量为 1 就改走 open -b，会让 macOS 再拉起一个应用入口，并可能
 * 使随后注入的 Cmd+C 落不到原窗口。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('单窗口窗口级快照应精确确认且不得执行 open -b', async () => {
  let raiseCalls = 0
  let focusReads = 0
  let openCalls = 0
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => ({ windows: [makeWindow()] }),
    raiseWindow: async () => {
      raiseCalls += 1
      return true
    },
    readFocusedWindowNumber: async () => {
      focusReads += 1
      return 102
    },
    openApplication: () => {
      openCalls += 1
      return true
    }
  }))
  assert.equal(raiseCalls, 0)
  assert.equal(focusReads, 1, '单窗口也必须读取 focused window 确认目标窗口')
  assert.equal(openCalls, 0, '窗口级快照不得因窗口数量为 1 而调用 open -b')
  assert.deepEqual(result, {
    activated: true,
    confirmed: true,
    outcome: 'exact',
    windowCount: 1,
    windowMatched: true
  })
})

/**
 * 校验单窗口不在前台时只 raise 该窗口，确认成功后仍不得调用 open -b。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('单窗口目标不在前台时应精确 raise 且不得执行 open -b', async () => {
  let now = 1_000
  let focusReads = 0
  let raiseCalls = 0
  let openCalls = 0
  const result = await activateMacosWindowSnapshot(makeSnapshot(), makeDeps({
    enumerateWindows: async () => ({
      windows: [makeWindow()],
      frontmostWindowNumber: 999,
      frontmostPid: 4242
    }),
    readFocusedWindowNumber: async () => {
      focusReads += 1
      return focusReads === 1 ? 999 : 102
    },
    raiseWindow: async () => {
      raiseCalls += 1
      return true
    },
    now: () => now,
    sleep: async () => {
      now += 20
    },
    openApplication: () => {
      openCalls += 1
      return true
    }
  }))
  assert.equal(raiseCalls, 1, '目标窗口不在前台时必须精确 raise')
  assert.equal(openCalls, 0, '单窗口精确 raise 不得退化为应用级 open -b')
  assert.deepEqual(result, {
    activated: true,
    confirmed: true,
    outcome: 'exact',
    windowCount: 1,
    windowMatched: true
  })
})

/**
 * 校验带窗口编号的旧快照即使保留 app-fallback 标记，也不得改走 open -b。
 *
 * `app-fallback` 只描述入口记录时没有精确匹配到窗口，不能覆盖快照中已有的
 * 窗口身份；复制前必须继续按窗口编号精确确认，避免 Chrome for Testing 或
 * 微信因应用级激活被额外拉起或切换到错误窗口。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('带窗口编号的快照不得因 app-fallback 标记执行 open -b', async () => {
  let openCalls = 0
  const result = await activateMacosWindowSnapshot(
    makeSnapshot({ windowLocate: 'app-fallback' }),
    makeDeps({
      enumerateWindows: async () => ({ windows: [makeWindow()] }),
      readFocusedWindowNumber: async () => 102,
      openApplication: () => {
        openCalls += 1
        return true
      }
    })
  )

  assert.deepEqual(result, {
    activated: true,
    confirmed: true,
    outcome: 'exact',
    windowCount: 1,
    windowMatched: true
  })
  assert.equal(openCalls, 0, '带窗口编号的快照不得执行应用级 open -b')
})

/**
 * 校验应用级快照不会枚举窗口，直接退化为 open -b。
 * @returns 无返回值。
 * @author zhenghq
 */
test('应用级快照应直接走 open -b 退化路径', async () => {
  let enumerateCalls = 0
  const result = await activateMacosWindowSnapshot(
    makeSnapshot({ windowNumber: undefined, bounds: undefined }),
    makeDeps({
      enumerateWindows: async () => {
        enumerateCalls += 1
        return { windows: [] }
      }
    })
  )
  assert.equal(enumerateCalls, 0)
  assert.equal(result.outcome, 'app-fallback')
})

/**
 * 校验记录阶段窗口定位失败时，即使快照没有窗口编号也不得执行 open -b。
 * 微信多窗口共享 bundle id，应用级激活会把同进程另一个窗口带到最前。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('窗口定位失败的应用级快照不得退化为 open -b', async () => {
  let enumerateCalls = 0
  let openCalls = 0
  const result = await activateMacosWindowSnapshot(
    makeSnapshot({
      windowNumber: undefined,
      bounds: undefined,
      windowLocate: 'failed'
    }),
    makeDeps({
      enumerateWindows: async () => {
        enumerateCalls += 1
        return { windows: [] }
      },
      openApplication: () => {
        openCalls += 1
        return true
      }
    })
  )

  assert.deepEqual(result, {
    activated: false,
    confirmed: false,
    outcome: 'failed',
    windowMatched: false
  })
  assert.equal(enumerateCalls, 0, '已明确失败时不得重新枚举并猜测窗口')
  assert.equal(openCalls, 0, '窗口定位失败时不得切换同进程的其它窗口')
})

/**
 * 校验统一的源快照激活入口会原样保留窗口定位失败结果。
 *
 * 微信与 Chrome for Testing 都可能在应用级快照中只留下 `windowLocate=failed`；
 * 此时任何调用方都不得绕过窗口激活模块，改用 `open -b` 猜测同进程窗口。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('统一源快照激活入口不得让窗口定位失败快照绕过 open -b 限制', () => {
  const source = stripComments(
    extractFunction(macForegroundSource, 'async function activateFrontmostSnapshot(')
  )
  assert.match(source, /Promise<MacosWindowActivationResult>/u,
    '统一入口必须返回完整激活结果，调用方才能区分 exact、app-fallback 与 failed')
  assert.match(source, /windowLocate\s*===\s*'failed'/u,
    '没有窗口定位字段时仍必须先拦截 windowLocate=failed')
  assert.match(source, /activateMacosWindowSnapshot\(/u,
    '统一入口必须复用窗口激活模块的失败保护')
  assert.match(source, /outcome:\s*'failed'/u,
    '窗口定位失败必须显式返回 failed')
  assert.doesNotMatch(
    source,
    /if \(!hasWindowLocator\(snapshot\)\)\s*\{\s*return activateFrontmostApp\(snapshot\)/u,
    'windowLocate=failed 的纯应用快照不得直接执行 open -b'
  )
})

/**
 * 校验原生对话框收尾复用统一激活入口，且失败时只安全让出。
 * @returns 无返回值。
 * @author zhenghq
 */
test('原生对话框收尾不得让窗口定位失败快照绕过 open -b 限制', () => {
  const source = stripComments(
    extractFunction(macForegroundSource, 'export async function handBackFrontmostApp(): Promise<boolean> {')
  )
  assert.match(source, /activateFrontmostSnapshot\(target\)/u,
    '原生对话框收尾必须复用统一源快照激活入口')
  assert.doesNotMatch(source, /activateFrontmostApp\(target\)/u,
    '统一入口已负责应用级退化，收尾不得再追加 open -b 旁路')
  assert.match(
    source,
    /if \(!activation\.activated\)[\s\S]*?yieldFrontmostApp/u,
    '未发出激活或窗口定位失败时必须安全让出，而不是猜测窗口'
  )
})

/**
 * 校验弹窗交还日志使用真实激活结果，不把失败或应用级退化写成 exact。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗交还日志必须输出真实 windowLocate 结果', () => {
  const source = stripComments(
    extractFunction(macForegroundSource, 'export function handBackFrontmostThen(')
  )
  assert.match(source, /activateFrontmostSnapshot\(target\)/u,
    '弹窗交还必须复用统一源快照激活入口')
  assert.match(source, /windowLocate=\$\{activation\.outcome\}/u,
    '日志必须使用激活结果中的真实 outcome')
  assert.doesNotMatch(source, /windowLocate=exact/u,
    '不得把任何带窗口定位字段的结果都硬编码为 exact')
})

/**
 * 校验交还结果区分“已发出激活”与“已确认交还”。
 * 确认超时只能用于避免复制链路重复激活，不能声明 key window 已经交还。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口激活结果应区分已发出动作与确认状态', () => {
  const source = stripComments(
    readFileSync('src/main/macosWindowActivation.ts', 'utf8')
  )
  assert.match(source, /confirmed:\s*boolean/u, '激活结果必须提供确认状态')
})

/**
 * 校验取词前交还只在真正确认后返回成功。
 * raise 已发出但确认超时时可以跳过重复激活，但必须让调用方继续走 blur 兜底。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取词前交还不得把未确认的 raise 当成成功', () => {
  const source = stripComments(
    extractFunction(macForegroundSource, 'export async function handBackKeyWindowToFrontmostApp(): Promise<boolean> {')
  )
  assert.match(source, /activation\.confirmed/u, '交还必须以 confirmed 而非 activated 判定成功')
  assert.match(source, /activation\.activated/u, '已发出激活时仍应避免重复激活')
  assert.match(source, /\.blur\(\)/u, '未确认时必须继续 blur 兜底')
})

/**
 * 校验 blur 兜底成功不能冒充源窗口已精确交还。
 * 调用方只有拿到精确确认结果时才可设置 windowActivationSettled，否则复制链路
 * 会跳过自己的窗口确认，把 Cmd+C 注入到同进程的另一个窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取词前交还只能在精确确认后返回成功，blur 兜底不得标记完成', () => {
  const source = stripComments(
    extractFunction(macForegroundSource, 'export async function handBackKeyWindowToFrontmostApp(): Promise<boolean> {')
  )
  assert.match(source, /isExactWindowActivationConfirmed\(activation\)/u,
    '必须依据精确确认结果决定是否报告交还成功')
  assert.match(source, /\.blur\(\)[\s\S]*?return false/u,
    'blur 兜底只能解除自有窗口焦点，不能报告源窗口已精确交还')
  assert.doesNotMatch(source, /\.blur\(\)[\s\S]*?return !focusedAfter/u,
    '不得把 blur 后自有窗口失去焦点直接当成源窗口交还成功')
  assert.doesNotMatch(source, /if \(handedBack\)\s*\{[\s\S]*?return true/u,
    '应用失活轮询不能冒充源窗口精确交还成功')
})

/**
 * 校验 helper 构建脚本与打包资源已接入窗口激活 helper。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口激活 helper 应接入构建脚本与 mac 打包资源', () => {
  const buildScript = readFileSync('scripts/build-macos-window-helper.mjs', 'utf8')
  assert.match(buildScript, /helpers\/macos-window-helper\/main\.m/u)
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.match(packageJson.scripts.dev, /build-macos-window-helper/u)
  assert.match(packageJson.scripts.build, /build-macos-window-helper/u)
  const resources = packageJson.build.mac.extraResources as Array<{ from: string; to: string }>
  assert.ok(resources.some((entry) => entry.from === 'build/macos-window-helper'))
})

/**
 * 校验窗口枚举与激活确认使用不同的硬超时，避免 raise/focused 被 50ms 枚举超时截断。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口 helper 应为枚举与激活确认分别设置超时', () => {
  const source = readFileSync('src/main/macosWindowActivation.ts', 'utf8')
  assert.match(source, /MACOS_WINDOW_ENUMERATION_TIMEOUT_MS\s*=\s*200/u)
  assert.match(source, /MACOS_WINDOW_ACTIVATION_TIMEOUT_MS\s*=\s*200/u)
  assert.match(
    source,
    /args\[0\]\s*===\s*'list'[\s\S]*?MACOS_WINDOW_ENUMERATION_TIMEOUT_MS[\s\S]*?MACOS_WINDOW_ACTIVATION_TIMEOUT_MS/u,
    'list 应使用枚举超时，raise/focused 应使用激活确认超时'
  )
})

/**
 * 校验原生 raise 只报告动作结果，不把异步焦点切换误判为 raise 失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口 helper 的 raise 不应在原生侧立即自证 focused window', () => {
  const source = readFileSync('helpers/macos-window-helper/main.m', 'utf8')
  const raiseStart = source.indexOf('static BOOL RaiseWindow(')
  const raiseEnd = source.indexOf('\n}', raiseStart)
  assert.ok(raiseStart >= 0 && raiseEnd > raiseStart, '应存在 RaiseWindow 实现')
  const raiseSource = source.slice(raiseStart, raiseEnd)
  assert.doesNotMatch(raiseSource, /CopyFocusedWindowNumber/u,
    'focused window 确认应由 Node 侧在 200ms 内轮询完成')
})

/**
 * 校验窗口 list 子命令只依赖 CGWindowList，避免微信 AX 响应慢时拖垮 50ms 枚举。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口 list 枚举不得同步依赖 AX 窗口列表或 AX 标题', () => {
  const source = readFileSync('helpers/macos-window-helper/main.m', 'utf8')
  const start = source.indexOf('static NSArray<NSDictionary *> *EnumerateWindows(')
  const end = source.indexOf('\n}', start)
  assert.ok(start >= 0 && end > start, '应存在 EnumerateWindows 实现')
  const enumerateSource = source.slice(start, end)
  assert.match(enumerateSource, /CGWindowListCopyWindowInfo/u, 'list 必须使用 CGWindowList')
  assert.doesNotMatch(enumerateSource, /AXUIElementCreateApplication/u,
    'list 不得同步创建 AX application 元素')
  assert.doesNotMatch(enumerateSource, /kAXWindowsAttribute/u,
    'list 不得同步读取 AX 窗口列表')
  assert.doesNotMatch(enumerateSource, /CopyWindowTitle/u,
    'list 不得逐窗口同步读取 AX 标题')
  assert.match(enumerateSource, /kCGWindowName/u,
    '标题只能从 CGWindow 可选字段读取，缺失时保持空串')
  assert.match(enumerateSource, /@"pid": @\(pid\)/u, '仍必须返回 pid')
  assert.match(enumerateSource, /@"windowNumber": windowNumber/u, '仍必须返回窗口编号')
  assert.match(enumerateSource, /@"layer": layer/u, '仍必须返回窗口层级')
  assert.match(enumerateSource, /@"bounds"/u, '仍必须返回窗口边界')
})

/**
 * 校验 helper 在窗口列表中返回 CGWindowList 顺序的最前普通窗口。
 * 微信的 AXFocusedWindow 返回 -25201，不能作为唯一的前台窗口判断依据。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口 helper 应输出 CGWindowList 最前普通窗口编号与进程号', () => {
  const source = readFileSync('helpers/macos-window-helper/main.m', 'utf8')
  assert.match(source, /frontmostWindowNumber/u, 'list 应输出最前普通窗口编号')
  assert.match(source, /frontmostPid/u, 'list 应输出最前普通窗口所属进程号')
  assert.match(source, /kCGWindowListOptionOnScreenOnly/u, '最前窗口应来自屏幕可见窗口列表')
})

/**
 * 校验 CGWindowList 不可用时 helper 明确失败，不能伪装成成功枚举空列表。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口 list 在 CGWindowList 不可用时应输出明确失败', () => {
  const source = readFileSync('helpers/macos-window-helper/main.m', 'utf8')
  assert.match(source, /if \(!windowList\) return nil;/u,
    '枚举函数必须用 nil 区分列表不可用与真实空列表')
  assert.match(source, /if \(!windows\) \{[\s\S]*?window-list-unavailable[\s\S]*?return 1;/u,
    'list 子命令遇到 nil 列表必须输出 window-list-unavailable 并非零退出')
})

/**
 * 校验 helper 失败分类稳定且只使用固定枚举。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口 helper 失败应归类为固定原因', () => {
  assert.equal(classifyMacosWindowHelperFailure({ code: 'ENOENT' }), 'enoent')
  assert.equal(classifyMacosWindowHelperFailure({ killed: true, signal: 'SIGTERM' }), 'timeout')
  assert.equal(
    classifyMacosWindowHelperFailure({ code: 1 }, '{"ok":false,"error":"window-list-unavailable"}'),
    'window-list-unavailable'
  )
  assert.equal(classifyMacosWindowHelperFailure({ code: 1 }, ''), 'nonzero-exit')
})

/**
 * 校验 helper 失败日志不拼接 stdout/stderr，避免窗口标题等用户数据泄漏。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口 helper 失败日志只能输出固定分类', () => {
  const source = readFileSync('src/main/macosWindowActivation.ts', 'utf8')
  const logStart = source.indexOf('function logWindowHelperFailure(')
  const logEnd = source.indexOf('\n}\n', logStart)
  assert.ok(logStart >= 0 && logEnd > logStart, '应存在窗口 helper 失败日志函数')
  const logSource = source.slice(logStart, logEnd)
  assert.match(logSource, /reason=\$\{reason\}/u)
  assert.doesNotMatch(logSource, /stdout|stderr|title|text|clipboard/u,
    '失败日志不得拼接窗口标题、选区文本或剪贴板内容')
})

/**
 * 校验前台应用快照保留应用级字段，同时可选承载窗口定位信息。
 * @returns 无返回值。
 * @author zhenghq
 */
test('FrontmostAppSnapshot 应可选承载窗口级快照字段', () => {
  const source = stripComments(
    extractFunction(macForegroundSource, 'export interface FrontmostAppSnapshot {')
  )
  assert.match(source, /bundleId:\s*string/u, '必须保留应用 bundle id')
  assert.match(source, /pid:\s*number/u, '必须保留应用进程号')
  assert.match(source, /windowNumber\?:\s*number/u, '必须可选记录窗口编号')
  assert.match(source, /bounds\?:\s*WindowBounds/u, '必须可选记录窗口边界')
  assert.match(source, /titleFingerprint\?:\s*string/u, '必须可选记录标题指纹')
  assert.match(source, /capturedAt\?:\s*number/u, '必须可选记录采集时间')
})

/**
 * 校验取词前交还优先使用窗口级激活，同时保留应用级退化和 blur 兜底。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取词前交还应在窗口快照存在时使用精确窗口激活', () => {
  const source = stripComments(
    extractFunction(
      macForegroundSource,
      'export async function handBackKeyWindowToFrontmostApp(): Promise<boolean> {'
    )
  )
  const activationSource = stripComments(
    extractFunction(macForegroundSource, 'async function activateFrontmostSnapshot(')
  )
  assert.match(source, /activateFrontmostSnapshot\(/u, '取词前交还必须复用统一源快照激活入口')
  assert.match(activationSource, /activateMacosWindowSnapshot\(/u,
    '窗口快照存在时必须精确激活源窗口')
  assert.match(activationSource, /activateFrontmostApp\(/u,
    '应用级快照仍必须保留 open -b 退化路径')
  assert.match(source, /\.blur\(\)/u, '精确激活失败时仍必须 blur 自有窗口兜底')
  assert.match(source, /BrowserWindow\.getFocusedWindow\(\)/u, '仍必须读取真实 key window 归属')
})

/**
 * 校验窗口级激活结果可以直接映射为诊断字段，且不暴露窗口标题明文。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口级激活结果应提供白名单诊断字段', () => {
  const result: MacosWindowActivationResult = {
    activated: true,
    confirmed: true,
    outcome: 'exact',
    windowCount: 2,
    windowMatched: true
  }
  assert.deepEqual(Object.keys(result).sort(), [
    'activated',
    'confirmed',
    'outcome',
    'windowCount',
    'windowMatched'
  ])
})
