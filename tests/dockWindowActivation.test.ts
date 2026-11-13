import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  collectOwnedWindowCandidates,
  OwnedWindowFocusRecency,
  resolveOwnedWindowKind,
  type OwnedWindowKind
} from '../src/main/dockWindowActivation.ts'
import { readMainSource } from './helpers/mainSource.ts'

/**
 * 截取源码中指定函数的完整片段。
 * @param source 待检索源码。
 * @param signature 函数签名起始片段。
 * @returns 从签名到函数结束的源码。
 * @author zhenghq
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end + 2)
}

test('Dock 激活必须选择仍然存在且最近获得焦点的自有窗口', () => {
  const recency = new OwnedWindowFocusRecency()
  recency.touch('settings')
  recency.touch('document-workspace')
  recency.touch('web-reader')

  assert.equal(recency.mostRecent([
    'settings',
    'document-workspace',
    'web-reader'
  ]), 'web-reader')
  assert.equal(recency.mostRecent([
    'settings',
    'document-workspace'
  ]), 'document-workspace')
  assert.equal(recency.mostRecent(['settings']), 'settings')
  assert.equal(recency.mostRecent([]), null)
})

test('最近窗口已销毁时必须回退到下一个最近的自有窗口', () => {
  const recency = new OwnedWindowFocusRecency()
  recency.touch('settings')
  recency.touch('web-reader')
  recency.touch('document-workspace')

  const available: OwnedWindowKind[] = ['settings', 'web-reader']
  assert.equal(recency.mostRecent(available), 'web-reader')
})

test('自有窗口候选必须覆盖设置页、网页翻译与文件翻译', () => {
  const candidates = collectOwnedWindowCandidates(null, null, null)
  assert.deepEqual(candidates.map(({ kind }) => kind), [
    'settings',
    'web-reader',
    'document-workspace'
  ])
})

test('焦点事件必须能识别三类自有窗口并忽略外部窗口', () => {
  const settings = {} as never
  const reader = {} as never
  const document = {} as never
  const external = {} as never
  const ownsReader = (window: unknown): boolean => window === reader
  const ownsDocument = (window: unknown): boolean => window === document

  assert.equal(resolveOwnedWindowKind(settings, settings, null, null), 'settings')
  assert.equal(resolveOwnedWindowKind(reader, settings, { ownsWindow: ownsReader }, null), 'web-reader')
  assert.equal(resolveOwnedWindowKind(document, settings, { ownsWindow: ownsReader }, {
    ownsWindow: ownsDocument
  }), 'document-workspace')
  assert.equal(resolveOwnedWindowKind(external, settings, { ownsWindow: ownsReader }, {
    ownsWindow: ownsDocument
  }), null)
})

test('真实 Dock 激活必须先锁定最近窗口，再恢复其余窗口并只聚焦目标', () => {
  const source = readMainSource()
  const activateSource = extractFunction(
    source,
    'function activateExistingPageOrOpenSettings(): void {'
  )

  const resolveTargetIndex = activateSource.indexOf(
    'ownedWindowFocusRecency.resolveMostRecent(ownedWindows)'
  )
  const restoreSettingsIndex = activateSource.indexOf(
    'resumeSettingsWindowAfterExternalSelection()'
  )
  const restoreDocumentIndex = activateSource.indexOf(
    'documentWorkspace?.restoreAfterExternalSelection(process.platform)'
  )
  const restoreLoopIndex = activateSource.indexOf('for (const { window: win } of ownedWindows)')
  const focusTargetIndex = activateSource.indexOf('showOwnWindowForInteraction(target)')

  assert.ok(resolveTargetIndex >= 0, 'Dock 激活必须先按最近获得焦点的顺序锁定目标窗口')
  assert.ok(restoreSettingsIndex > resolveTargetIndex,
    '设置页恢复动作不得在锁定最近窗口之前改变焦点顺序')
  assert.ok(restoreDocumentIndex > resolveTargetIndex,
    '文件翻译恢复动作不得在锁定最近窗口之前改变焦点顺序')
  assert.ok(restoreLoopIndex > resolveTargetIndex,
    '其余窗口必须等最近窗口锁定后再做非聚焦恢复')
  assert.ok(focusTargetIndex > restoreLoopIndex,
    '最终聚焦必须发生在全部窗口恢复之后')
  assert.match(
    activateSource,
    /resumeSettingsWindowAfterExternalSelection\(\)/u,
    'Dock 激活必须先恢复因划词隐藏的设置页'
  )
  assert.match(
    activateSource,
    /documentWorkspace\?\.restoreAfterExternalSelection\(process\.platform\)/u,
    'Dock 激活必须恢复因划词隐藏的文件翻译窗口'
  )
  assert.match(
    activateSource,
    /ownedWindowFocusRecency\.resolveMostRecent\(/u,
    'Dock 激活必须按最近获得焦点的顺序选择目标窗口'
  )
  assert.match(
    activateSource,
    /target\s*!==\s*settingsWin[\s\S]*?showOwnWindowForInteraction\(target\)/u,
    '非设置页目标必须通过统一入口聚焦'
  )
  assert.match(
    activateSource,
    /openSettings\(\{[\s\S]*?source:\s*'dock'[\s\S]*?dockActivationEpoch[\s\S]*?\}\)/u,
    '设置页目标必须继续走带来源与代际的 Dock 安全置前入口'
  )
})

test('文档工作台必须支持恢复划词期间隐藏的已有窗口', () => {
  const managerSource = readFileSync('src/main/documentWorkspaceWindow.ts', 'utf8')
  const restoreSource = extractFunction(
    managerSource,
    'restoreAfterExternalSelection(platform: NodeJS.Platform): boolean {'
  )

  assert.match(restoreSource, /platform\s*!==\s*'darwin'/u,
    '恢复划词隐藏只应影响 macOS')
  assert.match(
    restoreSource,
    /hiddenForSelection\s*=\s*false[\s\S]*?\.show\(\)/u,
    '必须先解除 show 拦截再恢复文档窗口'
  )
})
