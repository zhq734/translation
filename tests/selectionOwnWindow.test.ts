import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  findOwnWindowHit,
  resolveAppFrontmostForExclusion,
  resolveOwnWindowExclusion,
  type OwnWindowCandidate
} from '../src/shared/selectionOwnWindow.ts'

/**
 * 构造一个自有窗口候选，便于逐项覆盖过滤条件。
 * @param overrides 需要覆盖的字段。
 * @returns 完整的自有窗口候选。
 * @author zhenghq
 */
function candidate(overrides: Partial<OwnWindowCandidate> = {}): OwnWindowCandidate {
  return {
    name: 'settings',
    focused: true,
    bounds: { x: 100, y: 100, width: 200, height: 200 },
    ...overrides
  }
}

test('应用不在最前时不得按自有窗口矩形排除划词', () => {
  // macOS 应用失活后 key window 仍可能报告 isFocused()===true，
  // 此时后台设置页的整块矩形会吞掉用户在其它应用里的划词起点。
  const settings = candidate()
  const webReader = candidate({ name: 'webReader', bounds: { x: 0, y: 0, width: 50, height: 50 } })

  assert.deepEqual(resolveOwnWindowExclusion(false, [settings, webReader]), [])
})

test('应用在最前时只保留持有焦点且有可见边界的自有窗口', () => {
  const focusedVisible = candidate()
  const unfocused = candidate({ name: 'unfocused', focused: false })
  const hidden = candidate({ name: 'hidden', bounds: null })

  assert.deepEqual(
    resolveOwnWindowExclusion(true, [focusedVisible, unfocused, hidden]),
    [focusedVisible]
  )
})

test('自有窗口命中判定应返回覆盖坐标的窗口', () => {
  const settings = candidate()
  const webReader = candidate({ name: 'webReader', bounds: { x: 400, y: 400, width: 100, height: 100 } })

  assert.equal(findOwnWindowHit({ x: 150, y: 150 }, [settings, webReader])?.name, 'settings')
  assert.equal(findOwnWindowHit({ x: 450, y: 450 }, [settings, webReader])?.name, 'webReader')
  assert.equal(findOwnWindowHit({ x: 350, y: 350 }, [settings, webReader]), null)
})

test('复现日志场景：应用失活后设置页矩形不得再吞掉外部划词', () => {
  // 取自 2026-09-15 真实日志：设置页矩形约 (270,40)-(1170,860)，
  // 应用失活后 (977,320) 等坐标被误判为应用内点击，导致 mouseup 报 no-start。
  const settings = candidate({
    name: 'settings',
    focused: true,
    bounds: { x: 270, y: 40, width: 900, height: 820 }
  })
  const externalSelectionPoint = { x: 977, y: 320 }

  const macAppActive = resolveAppFrontmostForExclusion('darwin', false)
  assert.equal(
    findOwnWindowHit(externalSelectionPoint, resolveOwnWindowExclusion(macAppActive, [settings])),
    null,
    '应用失活时不得把外部划词起点判为应用内点击'
  )

  const macAppActiveBack = resolveAppFrontmostForExclusion('darwin', true)
  assert.equal(
    findOwnWindowHit(externalSelectionPoint, resolveOwnWindowExclusion(macAppActiveBack, [settings]))?.name,
    'settings',
    '应用确实在最前时设置页内部点击仍应被排除'
  )
})

test('仅 macOS 需要应用激活事件门禁，其它平台保持窗口焦点判定', () => {
  // Windows/Linux 上窗口持有焦点即代表应用在前台，不应受 macOS 失活歧义影响。
  assert.equal(resolveAppFrontmostForExclusion('win32', false), true)
  assert.equal(resolveAppFrontmostForExclusion('linux', false), true)
  assert.equal(resolveAppFrontmostForExclusion('darwin', false), false)
  assert.equal(resolveAppFrontmostForExclusion('darwin', true), true)
})

test('自有窗口排除必须由应用级激活状态门禁后再按矩形判定', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const start = source.indexOf('function resolveOwnWindowExclusionState')
  assert.notEqual(start, -1, '应存在自有窗口排除状态解析函数')
  const end = source.indexOf('/**', start + 1)
  const functionSource = source.slice(start, end < 0 ? source.length : end)

  // 只按窗口 isFocused() 判断会让后台窗口继续吞掉划词，必须叠加应用级激活状态。
  assert.match(functionSource, /resolveOwnWindowExclusion\(/u, '必须调用应用级门禁过滤函数')
  assert.match(functionSource, /isMacAppActiveByEvents\(\)/u, '必须使用应用激活事件跟踪状态，而非窗口焦点')
  assert.doesNotMatch(functionSource, /isMacAppActive\(\)/u, '不得使用会因窗口焦点误报的应用激活判断')

  // 矩形排除与按下分类都必须复用同一份门禁结果，避免两条路径判定不一致。
  const boundsStart = source.indexOf('function getFocusedOwnWindowBounds')
  assert.notEqual(boundsStart, -1, '应存在自有窗口边界收集函数')
  const boundsSource = source.slice(boundsStart, source.indexOf('/**', boundsStart + 1))
  assert.match(boundsSource, /resolveOwnWindowExclusionState\(\)/u)
})
