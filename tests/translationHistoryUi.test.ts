import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const popupHtml = readFileSync('src/renderer/index.html', 'utf8')
const popupSource = readFileSync('src/renderer/src/popup.ts', 'utf8')
const popupCss = readFileSync('src/renderer/src/style.css', 'utf8')
const types = readFileSync('src/shared/types.ts', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')

test('翻译弹窗应提供统一历史入口、搜索、收藏、重译、删除与清空非收藏', () => {
  assert.match(popupHtml, /id="open-history"/u)
  assert.match(popupHtml, /id="history-view"/u)
  assert.match(popupHtml, /id="history-search"/u)
  assert.match(popupHtml, /id="history-list"/u)
  assert.match(popupHtml, /id="history-clear-unfavorited"/u)
  assert.match(popupSource, /listTranslationHistory/u)
  assert.match(popupSource, /setTranslationHistoryFavorite/u)
  assert.match(popupSource, /deleteTranslationHistory/u)
  assert.match(popupSource, /clearUnfavoritedTranslationHistory/u)
  assert.match(popupSource, /retranslateHistoryEntry/u)
})

test('统一历史 API 必须只暴露文本元数据并支持重新翻译', () => {
  assert.match(types, /interface TranslationHistoryEntry/u)
  assert.match(types, /listTranslationHistory\(\): Promise<TranslationHistoryEntry\[\]>/u)
  assert.match(types, /retranslateHistoryEntry\(id: string\): Promise<void>/u)
  assert.match(preload, /listTranslationHistory/u)
  assert.match(preload, /retranslateHistoryEntry/u)
  assert.match(main, /translation-history:list/u)
  assert.match(main, /translation-history:retranslate/u)
  assert.match(main, /recordTranslationHistory/u)
})

test('历史重译必须把手动记录显示在划词视图且保留原历史来源', () => {
  assert.match(
    main,
    /historyOrigin:\s*TranslationOrigin\s*=\s*origin/u,
    'translateText 必须分离界面展示来源与历史记录来源'
  )
  assert.match(
    main,
    /recordTranslationHistory\(text,\s*output,\s*pair,\s*historyOrigin\)/u,
    '历史写入必须使用原始来源，避免重译手动记录时产生重复条目'
  )
  assert.match(
    main,
    /entry\.origin\s*===\s*'manual'\s*\?\s*'selection'\s*:\s*entry\.origin/u,
    '手动历史重译必须复用划词结果视图'
  )
})

test('OCR 成功翻译必须写入统一历史并保留 ocr 来源', () => {
  assert.match(
    main,
    /const pair = resolveLanguagePair\(result\.ocrText,[\s\S]*?recordTranslationHistory\(result\.ocrText,\s*result,\s*pair,\s*'ocr'\)[\s\S]*?showPopup\(/u,
    'OCR 成功结果必须在展示前写入统一历史，并标记为 ocr 来源'
  )
})

test('翻译历史面板必须复用主题变量且不硬编码颜色', () => {
  const historyCss = popupCss.slice(
    popupCss.indexOf('.history-view'),
    popupCss.indexOf('.footer')
  )
  assert.ok(historyCss.length > 0)
  assert.doesNotMatch(historyCss, /#[0-9a-fA-F]{3,8}\b/u)
  assert.doesNotMatch(historyCss, /rgba?\(/u)
  assert.match(historyCss, /var\(--/u)
})

test('历史搜索框必须关闭原生 searchfield 外观，避免聚焦时出现双层边框', () => {
  const searchInputCss =
    popupCss.match(/#history-search\s*\{([\s\S]*?)\}/u)?.[1] ?? ''

  assert.match(searchInputCss, /(?:^|\n)\s*border:\s*0;/u)
  assert.match(searchInputCss, /(?:^|\n)\s*-webkit-appearance:\s*none;/u)
  assert.match(searchInputCss, /(?:^|\n)\s*appearance:\s*none;/u)
  assert.match(searchInputCss, /(?:^|\n)\s*box-shadow:\s*none;/u)
})

test('历史面板打开期间必须暂停自动隐藏，关闭或切换视图后恢复', () => {
  const openHistory = popupSource.match(/function openHistory\(\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''
  const closeHistory = popupSource.match(/function closeHistory\(\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''
  const manualOpen = popupSource.match(/function handleManualOpen\(\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''
  const selectionOpen = popupSource.match(/function handleSelectionOpen\(\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''

  assert.match(openHistory, /setPronunciationInteraction\(true\)/u)
  assert.match(closeHistory, /setPronunciationInteraction\(false\)/u)
  assert.match(manualOpen, /setPronunciationInteraction\(false\)/u)
  assert.match(selectionOpen, /setPronunciationInteraction\(false\)/u)
})

test('历史操作失败时必须被捕获且保留当前列表', () => {
  const handleHistoryAction = popupSource.match(/async function handleHistoryAction\([\s\S]*?\n\}/u)?.[0] ?? ''
  const clearHandler = popupSource.match(/historyClearUnfavoritedBtn\.addEventListener\('click', async \(\) => \{[\s\S]*?\n\}\)/u)?.[0] ?? ''

  assert.match(handleHistoryAction, /try\s*\{[\s\S]*catch\s*\{/u)
  assert.match(handleHistoryAction, /flashStatus\(/u)
  assert.match(clearHandler, /try\s*\{[\s\S]*catch\s*\{/u)
  assert.match(clearHandler, /flashStatus\(/u)
})
