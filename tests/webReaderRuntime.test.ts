import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWebDocumentReadyScript,
  buildWebIncrementalCollectorDrainScript,
  buildWebIncrementalCollectorStartScript,
  buildWebIncrementalCollectorStopScript,
  buildWebPageChangeObserverScript,
  buildWebPageChangeStatusScript,
  buildWebBilingualClearScript,
  buildWebBilingualInjectScript,
  buildWebBilingualStyleSheet,
  buildWebTextApplyScript,
  buildWebTextExtractionScript,
  buildWebImageOverlayClearScript,
  buildWebImageOverlayInjectScript,
  buildWebImageOverlayStyleSheet,
  executeWebTextExtraction,
  waitForWebDocumentReady
} from '../src/main/webTextExtractionScript'
import { normalizeWebReaderUrl, sanitizeWebViewBounds } from '../src/main/webReaderSecurity'

test('阅读器 URL 只允许 HTTP(S) 且可为普通域名补全 HTTPS', () => {
  assert.equal(normalizeWebReaderUrl('example.com/path'), 'https://example.com/path')
  assert.equal(normalizeWebReaderUrl('http://example.com'), 'http://example.com/')
  assert.throws(() => normalizeWebReaderUrl('file:///etc/passwd'), /仅支持 HTTP 或 HTTPS/u)
  assert.throws(() => normalizeWebReaderUrl('javascript:alert(1)'), /仅支持 HTTP 或 HTTPS/u)
})

test('原生 View bounds 应取整、过滤负值并限制在窗口内容区', () => {
  assert.deepEqual(
    sanitizeWebViewBounds({ x: -3.2, y: 20.8, width: 999, height: 500 }, { width: 800, height: 400 }),
    { x: 0, y: 21, width: 800, height: 379 }
  )
})

test('注入提取脚本只读当前主文档可见 DOM 且不包含网络请求', () => {
  const script = buildWebTextExtractionScript()
  assert.match(script, /document\.body/u)
  assert.match(script, /getComputedStyle/u)
  assert.match(script, /getBoundingClientRect/u)
  assert.match(script, /document\.documentElement\.lang/u)
  assert.match(script, /textNodeIndex/u)
  assert.match(script, /contentEditable|isContentEditable/u)
  assert.doesNotMatch(script, /fetch\s*\(|XMLHttpRequest|appendChild|removeChild|\.value\b/u)
  assert.match(script, /shadowRoot/u)
})

test('提取脚本不应因 display contents 包装节点没有布局矩形而丢弃其可见子树', () => {
  const extraction = buildWebTextExtractionScript()
  const incremental = buildWebIncrementalCollectorStartScript(300)

  assert.match(extraction, /style\.display === 'contents'/u)
  assert.match(incremental, /style\.display === 'contents'/u)
})

test('提取脚本应收集可见图片候选并跳过已注入的图片覆盖层', () => {
  const script = buildWebTextExtractionScript()
  assert.match(script, /collectImageCandidates/u)
  assert.match(script, /getBoundingClientRect/u)
  assert.match(script, /naturalWidth/u)
  assert.match(script, /backgroundImage/u)
  assert.match(script, /data-st-image-translation/u)
  assert.match(script, /imageCandidates/u)
})

test('图片覆盖层脚本应幂等注入、支持两种展示位置并可完整清理', () => {
  const inject = buildWebImageOverlayInjectScript([])
  const clear = buildWebImageOverlayClearScript()
  const style = buildWebImageOverlayStyleSheet()

  assert.match(inject, /data-st-image-translation-for/u)
  assert.match(inject, /data-st-image-placement/u)
  assert.match(inject, /overlay/u)
  assert.match(inject, /insertBefore/u)
  assert.match(clear, /data-st-image-translation/u)
  assert.match(clear, /removeChild/u)
  assert.match(style, /data-st-image-translation/u)
  assert.match(style, /data-st-image-placement='overlay'/u)
})

test('图片覆盖层注入不应把覆盖层自身再次当作图片候选', () => {
  const script = buildWebTextExtractionScript()
  assert.match(script, /closest\('\[data-st-image-translation\]'\)/u)
})

test('提取脚本应覆盖开放 Shadow DOM 的相对时间和表单语义提示，并支持受控写回', () => {
  const extraction = buildWebTextExtractionScript()
  const incremental = buildWebIncrementalCollectorStartScript(300)
  const apply = buildWebTextApplyScript([], 'target')

  assert.match(extraction, /shadowRoot/u)
  assert.match(extraction, /placeholder/u)
  assert.match(extraction, /aria-label/u)
  assert.doesNotMatch(extraction, /\.value\b/u)
  assert.match(incremental, /shadowRoot/u)
  assert.match(incremental, /placeholder/u)
  assert.match(incremental, /aria-label/u)
  assert.match(apply, /setAttribute/u)
  assert.match(apply, /shadowRoot/u)
})

test('提取执行器应返回快照并将超时转换为细分错误', async () => {
  const snapshot = await executeWebTextExtraction(async () => ({
    snapshot: { kind: 'element', tag: 'body', visible: true, children: [] },
    pageMeta: { url: 'https://example.com/', title: '示例' }
  }), 100)
  assert.equal(snapshot.pageMeta.title, '示例')

  await assert.rejects(
    executeWebTextExtraction(() => new Promise(() => undefined), 5),
    /网页文本提取超时/u
  )
})

test('页面主文档根节点出现时即应允许提取，不等待 DOMContentLoaded 或网络请求停止', async () => {
  const script = buildWebDocumentReadyScript()
  assert.match(script, /document\.readyState/u)
  assert.match(script, /document\.body/u)

  let calls = 0
  const readiness = await waitForWebDocumentReady(async () => {
    calls += 1
    if (calls === 1) return { readyState: 'loading', hasRoot: true, url: 'https://example.com/' }
    return { readyState: 'interactive', hasRoot: true, url: 'https://example.com/' }
  }, 100, 0)

  assert.equal(readiness.readyState, 'loading')
  assert.equal(calls, 1)
})

test('原位写回脚本只能修改匹配锚点的 TextNode.nodeValue', () => {
  const script = buildWebTextApplyScript([{
    unitId: 'u1',
    sourceText: ' Hello ',
    translation: '你好',
    anchor: { parentSelector: '#article', textNodeIndex: 0, sourceFingerprint: 'abcdef12' }
  }], 'target')
  assert.match(script, /querySelector/u)
  assert.match(script, /Node\.TEXT_NODE/u)
  assert.match(script, /nodeValue/u)
  assert.match(script, /sourceFingerprint/u)
  assert.doesNotMatch(script, /innerHTML|fetch\s*\(|XMLHttpRequest|appendChild|removeChild/u)
})

test('页面变化观察脚本只记录状态且能忽略应用自身写回', () => {
  const observer = buildWebPageChangeObserverScript()
  const status = buildWebPageChangeStatusScript()
  assert.match(observer, /MutationObserver/u)
  assert.match(observer, /characterData/u)
  assert.match(observer, /childList/u)
  assert.match(observer, /suppressed/u)
  assert.doesNotMatch(observer, /fetch\s*\(|XMLHttpRequest/u)
  assert.match(status, /pageUpdated/u)
})

test('增量收集器应扫描当前根节点并对受影响子树防抖去重', () => {
  const start = buildWebIncrementalCollectorStartScript(300)
  const drain = buildWebIncrementalCollectorDrainScript()
  const stop = buildWebIncrementalCollectorStopScript()

  assert.match(start, /document\.body \|\| document\.documentElement/u)
  assert.match(start, /MutationObserver/u)
  assert.match(start, /characterData/u)
  assert.match(start, /childList/u)
  assert.match(start, /setTimeout/u)
  assert.match(start, /300/u)
  assert.match(start, /seen/u)
  assert.match(start, /sourceFingerprint/u)
  assert.match(start, /suppressed/u)
  assert.match(start, /contentEditable|isContentEditable/u)
  assert.doesNotMatch(start, /fetch\s*\(|XMLHttpRequest|\.value\b/u)
  assert.match(start, /shadowRoot/u)
  assert.match(start, /record\.addedNodes[\s\S]*?observeShadowRoots\(node\)/u)
  assert.match(drain, /pending/u)
  assert.match(drain, /splice/u)
  assert.match(stop, /disconnect/u)
  assert.match(stop, /clearTimeout/u)
  assert.match(stop, /active = false/u)
})

test('对照注入脚本应幂等 upsert 并写入语言方向与布局标记', () => {
  const script = buildWebBilingualInjectScript([
    { blockId: 'b1', selector: '#p1', translation: '你好' }
  ], 'ZH')
  assert.match(script, /data-st-translation-for/u)
  assert.match(script, /createElement\('span'\)/u)
  assert.match(script, /appendChild/u)
  assert.match(script, /data-st-parent-display/u)
  assert.match(script, /data-st-dimmed/u)
  assert.match(script, /setAttribute\('lang', targetLang\)/u)
  assert.match(script, /setAttribute\('dir', 'auto'\)/u)
  assert.match(script, /state\.suppressed = true/u)
  assert.doesNotMatch(script, /innerHTML|fetch\s*\(|XMLHttpRequest/u)
})

test('对照清理脚本应移除注入节点与全部标记且可重复执行', () => {
  const script = buildWebBilingualClearScript()
  assert.match(script, /data-st-translation/u)
  assert.match(script, /data-st-dimmed/u)
  assert.match(script, /data-st-parent-display/u)
  assert.match(script, /removeAttribute/u)
  assert.match(script, /removeChild/u)
  assert.match(script, /state\.suppressed = true/u)
  assert.doesNotMatch(script, /innerHTML|fetch\s*\(|XMLHttpRequest/u)
})

test('对照样式表应继承页面排版并为 flex/grid 父元素独占整行', () => {
  const css = buildWebBilingualStyleSheet()
  assert.match(css, /color: inherit/u)
  assert.match(css, /font: inherit/u)
  assert.match(css, /line-height: inherit/u)
  assert.match(css, /flex: 1 0 100%/u)
  assert.match(css, /grid-column: 1 \/ -1/u)
  assert.match(css, /opacity: 0\.6/u)
  assert.doesNotMatch(css, /var\(--/u)
})

test('提取脚本与增量收集器都应跳过对照注入节点及其子树', () => {
  assert.match(buildWebTextExtractionScript(), /closest\('\[data-st-translation\],?\[?data-st-image-translation\]?'\)/u)
  assert.match(buildWebIncrementalCollectorStartScript(300), /closest\('\[data-st-translation\],?\[?data-st-image-translation\]?'\)/u)
})

test('提取脚本与增量收集器都应为 html 和 body 生成稳定根选择器', () => {
  const stableRootSelector = /tag === 'html' \|\| tag === 'body' \? tag : tag \+ ':nth-child\('/u
  assert.match(buildWebTextExtractionScript(), stableRootSelector)
  assert.match(buildWebIncrementalCollectorStartScript(300), stableRootSelector)
})
