import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync('src/renderer/index.html', 'utf8')
const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
const styles = readFileSync('src/renderer/src/style.css', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')
const types = readFileSync('src/shared/types.ts', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')

test('原文区应提供朗读原文入口和固定音标卡结构', () => {
  assert.match(html, /id="read-original"[^>]*type="button"/u)
  assert.match(html, /id="pronunciation-card"[^>]*hidden/u)
  assert.match(html, /id="pronunciation-word"/u)
  assert.match(html, /id="pronunciation-variants"[^>]*aria-live="polite"/u)
  assert.match(html, /id="pronunciation-close"[^>]*type="button"/u)
})

test('Renderer 应让单个英文词与段落都只渲染可点击片段', () => {
  assert.match(renderer, /splitPronunciationText/u)
  assert.match(renderer, /window\.api\.lookupPronunciation\(/u)
  assert.match(renderer, /shouldLookupPronunciationWord\(/u)
  assert.match(renderer, /addEventListener\(['"]pointerdown['"]/u)
  assert.match(renderer, /addEventListener\(['"]pointerup['"]/u)
  assert.match(renderer, /addEventListener\(['"]click['"]/u)
  assert.match(renderer, /getSelection\(\)/u)
  assert.match(renderer, /origin === ['"]ocr['"]/u)
  assert.doesNotMatch(renderer, /manualSourceEl\.innerHTML/u)
  assert.doesNotMatch(renderer, /autoLookup/u)
})

test('Renderer 应在单个单词与段落中统一渲染可点击词，并在点击后查询', () => {
  const renderOriginal = renderer.match(/function renderOriginalPronunciation\(text: string\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''

  assert.ok(renderOriginal, '应存在原文音标渲染函数')
  assert.match(renderOriginal, /const segments = splitPronunciationText\(text\)/u)
  assert.match(renderOriginal, /for \(const segment of segments\)/u)
  assert.match(renderOriginal, /word\.className = ['"]pronunciation-word-token['"]/u)
  assert.match(renderOriginal, /word\.dataset\.pronunciationWord = segment\.word\.word/u)
  assert.doesNotMatch(renderOriginal, /lookupPronunciation\(/u)
  assert.match(renderer, /renderOriginalPronunciation\(payload\.original\)/u)
  assert.doesNotMatch(renderer, /renderOriginalPronunciation\(payload\.original,\s*true\)/u)
  assert.match(renderer, /originalEl\.addEventListener\(['"]pointerdown['"]/u)
  assert.match(renderer, /originalEl\.addEventListener\(['"]pointerup['"]/u)
  assert.match(renderer, /originalEl\.addEventListener\(['"]click['"]/u)
  assert.match(renderer, /originalClickGate\.click\(\(\) => void lookupPronunciation\(word, ['"]source['"]\)\)/u)
  assert.match(renderer, /pointerTravel/u)
  assert.match(renderer, /event\.detail/u)
  assert.match(renderer, /data-pronunciation-word/u)
})

test('Preload 与主进程应暴露受限音标查询和音频接口', () => {
  assert.match(types, /lookupPronunciation\(word: string, requestId\?: string\): Promise<PronunciationResult>/u)
  assert.match(types, /fetchPronunciationAudio\(\s*word: string,\s*variantId: string,\s*requestId\?: string\s*\): Promise<PronunciationAudioResult>/u)
  assert.match(preload, /lookupPronunciation:[\s\S]*?ipcRenderer\.invoke\(['"]pronunciation:lookup['"], word, requestId\)/u)
  assert.match(preload, /fetchPronunciationAudio:[\s\S]*?ipcRenderer\.invoke\(['"]pronunciation:audio['"], word, variantId, requestId\)/u)
  assert.match(main, /ipcMain\.handle\(['"]pronunciation:lookup['"]/u)
  assert.match(main, /ipcMain\.handle\(['"]pronunciation:audio['"]/u)
  assert.match(main, /translationFetch/u)
})

test('音标查询与音频接口应支持受限请求取消', () => {
  assert.match(types, /lookupPronunciation\(word: string, requestId\?: string\): Promise<PronunciationResult>/u)
  assert.match(types, /fetchPronunciationAudio\(\s*word: string,\s*variantId: string,\s*requestId\?: string\s*\): Promise<PronunciationAudioResult>/u)
  assert.match(types, /cancelPronunciationRequest\(requestId: string\): void/u)
  assert.match(preload, /cancelPronunciationRequest\([^)]*\)[\s\S]*?ipcRenderer\.send\(['"]pronunciation:cancel['"], requestId\)/u)
  assert.match(main, /ipcMain\.on\(['"]pronunciation:cancel['"]/u)
  assert.match(main, /pronunciationRequests\.cancel/u)
  assert.match(renderer, /cancelPronunciationLookup\(\)/u)
  assert.match(renderer, /pronunciation:cancel|api\.cancelPronunciationRequest/u)
})

test('音标卡样式应使用主题变量和可换行自适应布局', () => {
  assert.match(styles, /\.pronunciation-card\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/su)
  assert.match(styles, /\.pronunciation-variant\s*\{[^}]*min-width:\s*0;/su)
  assert.match(styles, /\.pronunciation-card\s*\{[^}]*background:\s*var\(--/su)
  assert.doesNotMatch(styles, /\.pronunciation-[^{]*\{[^}]*(?:#[0-9a-fA-F]{3,8}|rgb\()/su)
})

test('原文与译文区域应各有当前音标卡插槽', () => {
  assert.match(html, /id="pronunciation-card"/u)
  assert.match(html, /id="translation-pronunciation-card"/u)
  assert.match(renderer, /pronunciationCardEl\.parentElement/u)
  assert.match(renderer, /translationPronunciationCardEl/u)
})

test('译文英文单词应可点击查询且中文译文不分词', () => {
  assert.match(renderer, /renderTranslationPronunciation/u)
  assert.match(renderer, /splitPronunciationText\(text\)/u)
  assert.match(renderer, /data-pronunciation-word/u)
  assert.match(renderer, /translationPronunciationWordTarget/u)
  assert.match(renderer, /resultEl\.addEventListener\(['"]pointerdown['"]/u)
  assert.match(renderer, /resultEl\.addEventListener\(['"]click['"]/u)
})

test('流式展示期间译文保持纯文本，完整展示后即使在线结果也应绑定单词', () => {
  const reveal = renderer.match(/function renderRevealText\(target: ['"]selection['"] \| ['"]manual['"]\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''

  assert.match(reveal, /visibleLength < state\.fullText\.length/u)
  assert.match(reveal, /visibleLength >= state\.fullText\.length/u)
  assert.match(reveal, /renderTranslationPronunciation\(text\)/u)
  assert.match(reveal, /else\s*\{\s*element\.textContent = text/u)
  assert.doesNotMatch(reveal, /state\.settled/u)
})

test('音标卡应渲染释义且空释义时不产生空节点', () => {
  const renderCard = renderer.match(/function renderPronunciationCard\(\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''
  const renderDefinitions = renderer.match(/function renderPronunciationDefinitions\(definitions: PronunciationDefinition\[\]\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''
  assert.match(renderCard, /pronunciationCard\.definitions/u)
  assert.match(renderCard, /renderPronunciationDefinitions\(definitions\)/u)
  assert.match(renderDefinitions, /pronunciation-definition/u)
  assert.match(renderDefinitions, /definitions\.length/u)
})

test('切换单词进入加载态时应先清除上一词释义', () => {
  const renderCard = renderer.match(/function renderPronunciationCard\(\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''
  const loadingStart = renderCard.indexOf("pronunciationCard.status === 'loading'")
  const loadingEnd = renderCard.indexOf('if (pronunciationCard.status !==', loadingStart)
  const loadingBranch = renderCard.slice(loadingStart, loadingEnd)

  assert.ok(loadingStart >= 0 && loadingEnd > loadingStart, '应存在独立的音标加载分支')
  assert.match(loadingBranch, /renderPronunciationDefinitions\(definitions\)/u)
  assert.ok(
    loadingBranch.indexOf('renderPronunciationDefinitions(definitions)') < loadingBranch.indexOf('return'),
    '加载态必须在提前返回前清理上一词释义'
  )
})

test('雅思词汇应作为本地补充来源且运行时不下载整页词表', () => {
  assert.match(main, /Iscorevoc|iscorevoc/u)
  assert.doesNotMatch(main, /iscorevoc\.pages\.dev/u)
  assert.match(styles, /\.pronunciation-definition/u)
  assert.match(styles, /\.translation-pronunciation-card/u)
})

test('主进程外部隐藏弹窗时应通知 Renderer 清理全部发音资源', () => {
  const popup = readFileSync('src/main/popup.ts', 'utf8')
  const hidePopupBlock = popup.match(/export function hidePopup\([\s\S]*?\n\}/u)?.[0] ?? ''
  const hiddenHandler = renderer.match(/function handlePopupHidden\(\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''

  assert.match(hidePopupBlock, /webContents\.send\(['"]popup:hidden['"]\)/u)
  assert.match(types, /onPopupHidden\(cb: \(\) => void\): \(\) => void/u)
  assert.match(preload, /onPopupHidden\(callback: \(\) => void\)[\s\S]*?ipcRenderer\.on\(['"]popup:hidden['"], listener\)/u)
  assert.match(renderer, /window\.api\.onPopupHidden\(handlePopupHidden\)/u)
  assert.match(hiddenHandler, /stopPronunciationPlayback\(\)/u)
  assert.match(hiddenHandler, /closePronunciation\(\)/u)
  assert.match(hiddenHandler, /stopSpeech\(\)/u)
})

test('Renderer 主动隐藏弹窗时必须在异步前台交还前广播清理事件', () => {
  const popup = readFileSync('src/main/popup.ts', 'utf8')
  const hidePopupBlock = popup.match(/export function hidePopup\([\s\S]*?\n\}/u)?.[0] ?? ''
  const hideIndex = hidePopupBlock.indexOf('win?.hide()')
  const sendIndex = hidePopupBlock.indexOf("webContents.send('popup:hidden')")

  assert.ok(sendIndex >= 0, '隐藏弹窗必须广播 popup:hidden')
  assert.ok(
    sendIndex < hideIndex,
    'popup:hidden 必须在 win.hide() 前广播，避免窗口隐藏后消息无法及时送达 Renderer'
  )
})
