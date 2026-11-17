import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const renderer = readFileSync('src/renderer/src/selection.ts', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')
const html = readFileSync('src/renderer/selection.html', 'utf8')
const css = readFileSync('src/renderer/src/selection.css', 'utf8')

/** 校验聚光预览真正接入页面，不与导出聚光标注混淆；无参数，返回测试断言结果。@author zhenghq */
test('截图页面接入独立候选预览与单层挖空暗幕', () => {
  assert.match(renderer, /createScreenshotWindowSelectionState\(payload\)/u)
  assert.match(renderer, /type: 'snapshot', payload/u)
  assert.match(renderer, /function renderWindowSpotlight/u)
  assert.match(html, /id="ocr-window-candidate"/u)
  assert.match(html, /id="ocr-spotlight-mask"/u)
  assert.match(css, /\.ocr-spotlight-mask\s*\{[^}]*var\(--ocr-selection-mask\)/su)
  assert.doesNotMatch(css, /box-shadow:\s*0 0 0 9999px/u)
  assert.match(renderer, /clipPath/u)
})

/** 校验主进程在显示前收集窗口并同会话传输；无参数，返回测试断言结果。@author zhenghq */
test('主进程并发采集窗口候选，在覆盖窗口显示前汇合并传输局部光标', () => {
  const start = main.indexOf('async function openOcrSelection')
  const source = main.slice(start, main.indexOf('\n}\n', start))
  const collect = source.indexOf('collectScreenshotWindowCandidates(')
  assert.ok(collect >= 0)
  assert.ok(collect < source.lastIndexOf('win.show()'))
  assert.match(source, /cursorPoint: \{ x: anchor.x - display.bounds.x, y: anchor.y - display.bounds.y \}/u)
  assert.match(source, /autoTranslate \? Promise.resolve\(\[\]\)/u)
  assert.match(source, /capturePromise,\s*windowCandidatesPromise/u)
  assert.match(source, /windowCandidates,\s*\.\.\.previewPayload/u)
})

/** 校验重选确认、安全清理和中英词条；无参数，返回测试断言结果。@author zhenghq */
test('重新选区必须保护标注并提供取消确认入口', () => {
  assert.match(html, /id="ocr-reselect"/u)
  assert.match(html, /id="ocr-reselect-confirmation"/u)
  assert.match(renderer, /annotationController.annotations.length/u)
  assert.match(renderer, /function confirmOcrReselect/u)
  for (const locale of ['zh-CN', 'en-US']) {
    const catalog = readFileSync(`src/shared/i18n/catalog.${locale}.base.ts`, 'utf8')
    for (const key of ['selection.windowSpotlightTip', 'selection.reselect', 'selection.reselectConfirm']) {
      assert.ok(catalog.includes(`'${key}'`), `${locale} 缺少 ${key}`)
    }
  }
})

/** 校验确认框保留原生按钮键盘激活，不触发截图 Enter 提交；无参数，返回断言结果。@author zhenghq */
test('重选确认框中 Enter 和空格保留按钮激活语义', () => {
  const start = renderer.indexOf('function handleKeyDown')
  const dialogBranch = renderer.slice(start, renderer.indexOf('// 文字编辑框', start))
  assert.match(dialogBranch, /event.key === 'Enter' \|\| event.key === ' '/u)
  assert.ok(dialogBranch.indexOf("event.key === 'Enter'") < dialogBranch.indexOf('event.preventDefault()'))
})
