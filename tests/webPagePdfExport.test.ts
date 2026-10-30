import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrintToPDFOptions } from 'electron'
import {
  buildWebPagePrintCss,
  printWebPageToPdf,
  type WebPagePrintWebContents
} from '../src/main/webPagePdfExport.ts'

/**
 * 从打印 CSS 中提取并解码水印 SVG，验证浏览器实际收到的图形内容。
 * @param css 网页打印样式。
 * @returns 解码后的水印 SVG。
 * @author zhenghq
 */
function decodeWatermarkSvg(css: string): string {
  const match = css.match(/background-image:\s*url\("([^"]*)"\)/u)
  assert.ok(match, '打印样式必须包含完整的 background-image data URL')
  assert.doesNotMatch(match[1] ?? '', /["<>]/u, 'data URL 中不得保留会截断 CSS 字符串的原始字符')
  return decodeURIComponent((match[1] ?? '').replace(/^data:image\/svg\+xml;charset=utf-8,/u, ''))
}

/**
 * 创建记录调用的网页打印 webContents 假对象。
 * @param printResult 打印返回的字节或抛出的异常。
 * @returns 假对象及其调用记录。
 * @author zhenghq
 */
function createWebContentsFake(printResult: Uint8Array | Error = new Uint8Array([37, 80, 68, 70])): {
  webContents: WebPagePrintWebContents
  insertedCss: string[]
  executedScripts: string[]
  printOptions: PrintToPDFOptions[]
  removedCssKeys: string[]
} {
  const insertedCss: string[] = []
  const executedScripts: string[] = []
  const printOptions: PrintToPDFOptions[] = []
  const removedCssKeys: string[] = []
  return {
    insertedCss,
    executedScripts,
    printOptions,
    removedCssKeys,
    webContents: {
      async insertCSS(css: string): Promise<string> {
        insertedCss.push(css)
        return 'web-page-print-css'
      },
      async removeInsertedCSS(key: string): Promise<void> {
        removedCssKeys.push(key)
      },
      async executeJavaScript(script: string): Promise<unknown> {
        executedScripts.push(script)
        return true
      },
      async printToPDF(options: PrintToPDFOptions): Promise<Uint8Array> {
        printOptions.push(options)
        if (printResult instanceof Error) throw printResult
        return printResult
      }
    }
  }
}

test('网页 PDF 水印必须只在打印媒体中生效且复用文件翻译的品牌平铺规格', () => {
  const css = buildWebPagePrintCss()
  const watermarkSvg = decodeWatermarkSvg(css)

  assert.match(css, /@media print\s*\{/u)
  assert.match(css, /html::after/u)
  assert.match(css, /content:\s*''/u)
  assert.match(css, /position:\s*fixed/u)
  assert.match(css, /inset:\s*0/u)
  assert.match(css, /pointer-events:\s*none/u)
  assert.match(watermarkSvg, /划词翻译/u)
  assert.match(watermarkSvg, /Selection Translator/u)
  assert.match(watermarkSvg, /rounded-yi-glyph/u)
  assert.match(watermarkSvg, /data-font-family="Wawati SC"/u)
  assert.match(watermarkSvg, /viewBox="0 0 36 36"/u)
  assert.match(watermarkSvg, /stroke-width="5"/u)
  assert.match(watermarkSvg, /rotate\(-45 160 90\)/u)
  assert.match(watermarkSvg, /width="320"/u)
  assert.match(watermarkSvg, /height="180"/u)
  assert.match(watermarkSvg, /x="74"/u)
  assert.match(watermarkSvg, /y="96"/u)
  assert.match(watermarkSvg, /width="24"/u)
  assert.match(watermarkSvg, /height="24"/u)
  assert.match(watermarkSvg, /x="106"/u)
  assert.match(watermarkSvg, /y="107"/u)
  assert.match(watermarkSvg, /x="108"/u)
  assert.match(watermarkSvg, /y="127"/u)
  assert.match(watermarkSvg, /font-size="20"/u)
  assert.match(watermarkSvg, /font-size="14"/u)
  assert.match(watermarkSvg, /fill="rgba\(17, 24, 39, 0\.17\)"/u)
  assert.match(watermarkSvg, /stroke="rgba\(17, 24, 39, 0\.17\)"/u)
  assert.doesNotMatch(watermarkSvg, /fill="#111827"/u, 'SVG 内部不能使用不透明深色覆盖水印透明度')
  assert.match(css, /background-repeat:\s*repeat/u)
  assert.match(css, /background-size:\s*320px 180px/u)
  assert.match(css, /background-position:\s*-92px 0/u)
  assert.match(css, /rgba\(17,\s*24,\s*39,\s*0\.17\)/u)
  assert.doesNotMatch(css, /align-items:\s*center/u)
  assert.doesNotMatch(css, /justify-content:\s*center/u)
  assert.doesNotMatch(css, /content:\s*'划词翻译\\A Selection Translator'/u)
  assert.doesNotMatch(css, /@media screen\s*\{[^}]*watermark/isu)
  const watermarkIndex = css.indexOf('html::after')
  const mediaIndex = css.indexOf('@media print')
  assert.ok(mediaIndex >= 0 && watermarkIndex > mediaIndex, '水印规则必须位于打印媒体查询内')
})

test('网页 PDF 打印前应仅标记受高度或最大高度约束的滚动容器', () => {
  const fake = createWebContentsFake()
  return printWebPageToPdf(fake.webContents).then(() => {
    const script = fake.executedScripts[0] ?? ''
    assert.match(script, /querySelectorAll\('body \*'\)/u)
    assert.match(script, /overflowX\s*\+\s*' '\s*\+\s*style\.overflowY/u)
    assert.match(script, /style\.maxHeight\s*!==\s*'none'/u)
    assert.match(script, /!\[[^\]]*'auto'[^\]]*'0px'[^\]]*\]\.includes\(style\.height\)/u)
    assert.match(script, /setAttribute\(printScrollAttribute,\s*''\)/u)
  })
})

test('网页 PDF 打印样式必须展开滚动容器并保持表格、代码块分页完整', () => {
  const css = buildWebPagePrintCss()

  assert.match(css, /body\s*\{[^}]*height:\s*auto\s*!important/isu, '文档根节点必须按内容自然撑开')
  assert.match(css, /body\s*\{[^}]*overflow:\s*visible\s*!important/isu, '文档根节点不能保留滚动裁剪')
  assert.match(css, /body\s*\{[^}]*max-height:\s*none\s*!important/isu, '文档根节点必须取消最大高度限制')
  assert.match(css, /\[data-st-print-scroll-container\][^{]*\{[^}]*height:\s*auto\s*!important/isu,
    '标记出的滚动容器必须按内容自然撑开，避免溢出内容覆盖后续区块')
  assert.match(css, /\[data-st-print-scroll-container\][^{]*\{[^}]*max-height:\s*none\s*!important/isu,
    '打印时必须取消滚动容器的最大高度限制')
  assert.match(css, /\[data-st-print-scroll-container\][^{]*\{[^}]*overflow:\s*visible\s*!important/isu,
    '标记出的滚动容器必须在打印时展开')
  assert.match(css, /table\s*\{[^}]*break-inside:\s*auto/isu, '表格必须允许自然跨页')
  assert.match(css, /break-inside:\s*avoid/u, '表格行不能被分页拆开')
  assert.match(css, /page-break-inside:\s*avoid/u, '表格行需要兼容旧版分页属性')
  assert.match(css, /pre\s*\{[^}]*white-space:\s*pre-wrap/isu, '代码块必须换行而不是横向裁切')
  assert.match(css, /pre\s*\{[^}]*overflow-wrap:\s*anywhere/isu, '长代码行必须在打印时安全换行')
})

test('网页 PDF 打印时对照译文节点不得强制独占新行', () => {
  const css = buildWebPagePrintCss()

  assert.match(
    css,
    /body\s+\[data-st-translation\]\s*\{[^}]*display:\s*inline\s*!important/isu,
    '对照注入节点在 PDF 里应随译文段自然流动'
  )
  assert.match(
    css,
    /body\s+\[data-st-translation\]\s*\{[^}]*flex:\s*0\s+1\s+auto\s*!important/isu,
    'flex 父级中的对照注入节点打印时不应强制换行'
  )
  assert.match(
    css,
    /body\s+\[data-st-translation\]\s*\{[^}]*grid-column:\s*auto\s*!important/isu,
    'grid 父级中的对照注入节点打印时不应跨满整行'
  )
})

test('网页 PDF 应使用 A4 打印并保留页面背景', async () => {
  const fake = createWebContentsFake()

  const bytes = await printWebPageToPdf(fake.webContents)

  assert.deepEqual(bytes, new Uint8Array([37, 80, 68, 70]))
  assert.equal(fake.insertedCss.length, 1)
  assert.equal(fake.executedScripts.length, 1)
  assert.match(fake.executedScripts[0] ?? '', /document\.fonts/u)
  assert.match(fake.executedScripts[0] ?? '', /requestAnimationFrame/u)
  assert.deepEqual(fake.printOptions, [{
    pageSize: 'A4',
    printBackground: true,
    displayHeaderFooter: false,
    margins: { marginType: 'default' },
    preferCSSPageSize: true
  }])
  assert.deepEqual(fake.removedCssKeys, ['web-page-print-css'])
})

test('网页 PDF 打印失败时也必须移除注入样式', async () => {
  const fake = createWebContentsFake(new Error('print failed'))

  await assert.rejects(() => printWebPageToPdf(fake.webContents), /PDF print failed/u)
  assert.deepEqual(fake.removedCssKeys, ['web-page-print-css'])
})
