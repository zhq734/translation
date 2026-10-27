import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildWebBilingualInjectScript,
  buildWebTextApplyScript
} from '../src/main/webTextExtractionScript.ts'
import {
  buildWebTypewriterCancelScript,
  resolveWebTypewriterTuning
} from '../src/main/webTypewriterScript.ts'

test('页面打字机缓存命中应使用更短的间隔且步长始终为正', () => {
  const normal = resolveWebTypewriterTuning(200, false)
  const cached = resolveWebTypewriterTuning(200, true)
  assert.ok(cached.intervalMs < normal.intervalMs)
  assert.ok(cached.step >= 1)
  assert.ok(normal.step >= 1)
  assert.ok(resolveWebTypewriterTuning(0, false).step >= 1)
})

test('原位写回脚本应支持可取消的单元级打字机写回', () => {
  const script = buildWebTextApplyScript([{
    unitId: 'u1',
    sourceText: ' Hello ',
    translation: '你好，世界',
    anchor: { parentSelector: '#article', textNodeIndex: 0, sourceFingerprint: 'abcdef12' }
  }], 'target', { typewriter: true })

  assert.match(script, /__selectionTranslatorTypewriter/u)
  assert.match(script, /setTimeout/u)
  assert.match(script, /cancel/u)
  assert.match(script, /generation/u)
  assert.match(script, /options\.typewriter/u)
  // 原文模式与关闭打字机时必须保持一次性写回。
  const instant = buildWebTextApplyScript([], 'source')
  assert.doesNotMatch(instant, /__selectionTranslatorTypewriter/u)
})

test('对照注入脚本应复用同一页面打字机运行时', () => {
  const script = buildWebBilingualInjectScript([
    { blockId: 'b1', selector: '#p1', translation: '你好，世界' }
  ], 'ZH', { typewriter: true, cached: true })

  assert.match(script, /__selectionTranslatorTypewriter/u)
  assert.match(script, /const options = \{[^}]*"cached":true/u)
  assert.match(script, /options\.typewriter/u)
})

test('取消脚本应清空计时器并递增代次以阻止迟到写回', () => {
  const script = buildWebTypewriterCancelScript()
  assert.match(script, /clearTimeout/u)
  assert.match(script, /cancel\(\)/u)
})

test('阅读器运行时应在单元完成和缓存命中时启用打字机并串行写回', () => {
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const runMethod = manager.slice(manager.indexOf('async run('), manager.indexOf('/** 取消当前任务'))

  assert.match(runMethod, /applyUnits\('target', new Set\(blockUnitIds\), \{ typewriter: true \}\)/u)
  assert.match(runMethod, /applyUnits\(\s*'target',\s*new Set\(units\.map\(\(unit\) => unit\.id\)\),\s*\{ typewriter: true, cached: true \}\s*\)/u)
  assert.match(runMethod, /applyBilingual\(new Set\(\[completedUnit\.blockId\]\), \{ typewriter: true \}\)/u)
  assert.match(runMethod, /applyQueue = applyQueue\.then/u)
})

test('取消、导航与任务失效应停止未完成的页面打字机', () => {
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const invalidate = manager.slice(manager.indexOf('private invalidateActiveJob'), manager.indexOf('private startPageChangePolling'))
  const advance = manager.slice(manager.indexOf('private advancePage'), manager.indexOf('private installPageChangeMonitoring'))

  assert.match(invalidate, /cancelTypewriter\(\)/u)
  assert.match(advance, /invalidateActiveJob\(true\)/u)
  assert.match(manager, /buildWebTypewriterCancelScript/u)
})

test('页面单元翻译失败应跳过写回并保留其它单元继续完成', () => {
  const script = buildWebTextApplyScript([{
    unitId: 'u1',
    sourceText: 'Hello',
    anchor: { parentSelector: '#p1', textNodeIndex: 0, sourceFingerprint: 'abcdef12' }
  }], 'target', { typewriter: true })

  assert.match(script, /typeof operation\.translation !== 'string'[\s\S]*?stats\.skipped \+= 1; continue/u)
})
