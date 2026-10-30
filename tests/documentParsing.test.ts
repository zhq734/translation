import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import JSZip from 'jszip'
import {
  PDFDocument,
  StandardFonts,
  clipEvenOdd,
  degrees,
  endPath,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setFillingRgbColor,
  stroke
} from 'pdf-lib'
import {
  parseDelimitedDocument,
  parseHtmlDocument,
  parseMarkdownDocument,
  parseSubtitleDocument,
  parseTextDocument,
  sanitizeHtmlPreview
} from '../src/main/documentTextParser.ts'
import { parseDocxDocument } from '../src/main/documentDocxParser.ts'
import { parseEpubDocument } from '../src/main/documentEpubParser.ts'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'
import {
  DocumentPackageSecurityError,
  loadSafeDocumentPackage
} from '../src/main/documentPackageShared.ts'
import type { DocumentModel } from '../src/shared/documentTypes.ts'

/** 测试文档统一使用的稳定指纹。 */
const FINGERPRINT = 'fixture-sha256'

/**
 * 构造带真实像素尺寸的 PNG 文件头。
 * @param width 图片像素宽度。
 * @param height 图片像素高度。
 * @returns 仅含签名与 IHDR 尺寸的最小 PNG 字节。
 * @author zhenghq
 */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  return bytes
}

/**
 * 构造最小 DOCX 包，正文只包含一个段落。
 * @param extraFiles 额外写入包内的文件。
 * @returns DOCX 字节。
 * @author zhenghq
 */
async function minimalDocx(extraFiles: Record<string, Uint8Array | string> = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Safe paragraph</w:t></w:r></w:p></w:body></w:document>')
  for (const [path, content] of Object.entries(extraFiles)) zip.file(path, content)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } })
}

/**
 * 断言解析器抛出的稳定文档包安全错误。
 * @param operation 待执行解析操作。
 * @param code 期望错误码。
 * @returns 无返回值。
 * @author zhenghq
 */
async function assertPackageSecurityError(operation: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal(error instanceof DocumentPackageSecurityError, true)
    assert.equal((error as DocumentPackageSecurityError).code, code)
    return true
  })
}

/**
 * 构造解析输入。
 * @param content 文本内容。
 * @param fileName 文件名。
 * @param format 已探测格式。
 * @returns 文本解析输入。
 * @author zhenghq
 */
function textInput(content: string, fileName: string, format: 'txt' | 'markdown' | 'html' | 'json' | 'csv' | 'srt' | 'vtt') {
  return {
    path: `/tmp/${fileName}`,
    fileName,
    format,
    sha256: FINGERPRINT,
    bytes: new TextEncoder().encode(content)
  } as const
}

/**
 * 读取模型中的全部可翻译文本。
 * @param model 文档模型。
 * @returns 文本数组。
 * @author zhenghq
 */
function translatableText(model: DocumentModel): string[] {
  return model.pages.flatMap((page) => page.blocks.flatMap((block) => {
    if (block.kind === 'text') return [block.runs.map((run) => run.text).join('')]
    if (block.kind === 'table') {
      return block.rows.flatMap((row) => row.cells.flatMap((cell) =>
        cell.blocks.flatMap((child) => child.kind === 'text'
          ? [child.runs.map((run) => run.text).join('')]
          : [])
      ))
    }
    return []
  }))
}

/**
 * 提取模型中的稳定页面与区块标识，供跨解析器重复解析回归使用。
 * @param model 文档模型。
 * @returns 页面标识及按页面分组的区块标识。
 * @author zhenghq
 */
function stableDocumentIdentities(model: DocumentModel): {
  pageIds: string[]
  blockIds: string[][]
} {
  return {
    pageIds: model.pages.map((page) => page.pageId),
    blockIds: model.pages.map((page) => page.blocks.map((block) => block.blockId))
  }
}

test('TXT 应保留段落与空行边界，并生成稳定页面和区块标识', () => {
  const input = textInput('第一段\n第二行\n\nSecond paragraph', 'notes.txt', 'txt')
  const first = parseTextDocument(input)
  const second = parseTextDocument(input)

  assert.deepEqual(translatableText(first), ['第一段\n第二行', 'Second paragraph'])
  assert.equal(first.pages.length, 1)
  assert.deepEqual(
    first.pages[0]!.blocks.map((block) => block.blockId),
    second.pages[0]!.blocks.map((block) => block.blockId)
  )
  assert.equal(first.source.sha256, FINGERPRINT)
  assert.equal(first.metadata.direction, 'auto')
})

test('Markdown 应识别标题、列表并保护代码块、行内代码和链接目标', () => {
  const model = parseMarkdownDocument(textInput([
    '# Title',
    '',
    'Translate **this** and `inlineCode`.',
    '',
    '- First item',
    '- Second item',
    '',
    '```ts',
    'const value = 1',
    '```',
    '',
    '[docs](https://example.com/path)'
  ].join('\n'), 'guide.md', 'markdown'))

  assert.equal(model.pages[0]!.blocks[0]!.kind, 'text')
  const heading = model.pages[0]!.blocks[0]
  assert.equal(heading.kind === 'text' ? heading.role : '', 'heading')
  const allRuns = model.pages.flatMap((page) => page.blocks).flatMap((block) =>
    block.kind === 'text' ? block.runs : []
  )
  assert.equal(allRuns.some((run) => run.text.includes('inlineCode') && run.protected === true), true)
  assert.equal(allRuns.some((run) => run.text.includes('const value = 1') && run.protected === true), true)
  assert.equal(allRuns.some((run) => run.text.includes('https://example.com/path') && run.protected === true), true)
})

test('Markdown 代码块应保留代码和注释标记，仅把注释正文暴露给翻译', () => {
  const model = parseMarkdownDocument(textInput([
    '```yaml',
    'borrow:',
    '  is-encrypt: true      #开启加密',
    '  # 档案防篡改配置',
    '',
    'ext-pwd-plugin:',
    '  jar:',
    '    config:',
    '      jarDir: D:\\tdr\\      #路径为插件包的路径',
    'url: "https://example.com/#anchor"',
    'raw-url: https://example.com/#anchor',
    'value: C#',
    '```'
  ].join('\n'), 'config.md', 'markdown'))

  const code = model.pages[0]!.blocks.find((block) => block.kind === 'text' && block.role === 'code')
  assert.equal(code?.kind, 'text')
  if (code?.kind !== 'text') return
  assert.equal(code.translatable, true)
  assert.equal(code.runs.some((run) => run.text.includes('is-encrypt: true') && run.protected === true), true)
  assert.equal(code.runs.some((run) => run.text.includes('#') && run.protected === true), true)
  assert.equal(code.runs.some((run) => run.text === '开启加密' && run.protected !== true), true)
  assert.equal(code.runs.some((run) => run.text.trimEnd() === '  #' && run.protected === true), true)
  assert.equal(code.runs.some((run) => run.text.trim() === '档案防篡改配置' && run.protected !== true), true)
  assert.equal(code.runs.some((run) => run.text === '路径为插件包的路径' && run.protected !== true), true)
  assert.equal(code.runs.some((run) => run.protected !== true && run.text.includes('#anchor')), false)
  assert.equal(code.runs.some((run) => run.protected !== true && run.text.includes('C#')), false)
})

test('Markdown 未声明语言的围栏应按纯文本翻译并保留代码块换行', () => {
  const model = parseMarkdownDocument(textInput([
    '```',
    '生成视频：',
    '【场景设定】',
    '{根据选定美术风格填充场景、光影、构图、环境细节}',
    '',
    '【整体视频要求】',
    '配音规范：全程使用固定真人音色。',
    '```'
  ].join('\n'), 'prompt.md', 'markdown'))

  const code = model.pages[0]!.blocks.find((block) => block.kind === 'text' && block.role === 'code')
  assert.equal(code?.kind, 'text')
  if (code?.kind !== 'text') return
  assert.equal(code.translatable, true)
  assert.equal(
    code.runs.filter((run) => run.protected !== true).map((run) => run.text).join(''),
    '生成视频：\n【场景设定】\n{根据选定美术风格填充场景、光影、构图、环境细节}\n\n【整体视频要求】\n配音规范：全程使用固定真人音色。'
  )
  assert.equal(code.runs.some((run) => run.text.includes('生成视频') && run.protected === true), false)
  assert.equal(code.runs.some((run) => run.text.includes('配音规范') && run.protected === true), false)
})

test('Markdown 行内路径保护不应把提示词中的斜杠分隔文本截断', () => {
  const text = '{拆分后的镜头，台词与动作一一绑定，适配本段5s/10s时长}\n' +
    '字幕设置：【无任何画面字幕，后期自行添加】/底部中英双语字幕，同步语音，圆润清晰字体\n' +
    '高清画质，真人/动画演绎，生活化表演感。'
  const model = parseMarkdownDocument(textInput(text, 'prompt.md', 'markdown'))
  const block = model.pages[0]!.blocks[0]
  assert.equal(block?.kind, 'text')
  if (block?.kind !== 'text') return
  assert.equal(block.runs.map((run) => run.text).join(''), text)
  assert.equal(block.runs.some((run) => run.protected === true), false)
})

test('Markdown 应保护邮箱、Windows 路径和 URL，只翻译周围说明文字', () => {
  const model = parseMarkdownDocument(textInput([
    '请联系 owner+docs@example.com。',
    '文件位于 C:\\Users\\alice\\文档\\report.pdf。',
    '共享盘是 \\\\server\\share\\manual.txt。',
    '访问 https://example.com/guide 获取说明。'
  ].join('\n'), 'contacts.md', 'markdown'))
  const block = model.pages[0]!.blocks[0]
  assert.equal(block?.kind, 'text')
  if (block?.kind !== 'text') return

  const protectedText = block.runs.filter((run) => run.protected === true).map((run) => run.text).join('\n')
  const translatable = block.runs.filter((run) => run.protected !== true).map((run) => run.text).join('')
  assert.match(protectedText, /owner\+docs@example\.com/u)
  assert.match(protectedText, /C:\\Users\\alice\\文档\\report\.pdf/u)
  assert.match(protectedText, /\\\\server\\share\\manual\.txt/u)
  assert.match(protectedText, /https:\/\/example\.com\/guide/u)
  assert.doesNotMatch(translatable, /owner\+docs@example\.com|C:\\Users|\\\\server|https:\/\//u)
  assert.match(translatable, /请联系/u)
  assert.match(translatable, /文件位于/u)
  assert.match(translatable, /共享盘是/u)
  assert.match(translatable, /获取说明/u)
})

test('Markdown 代码注释识别应避开 C 预处理指令、URL 与字符串内容', () => {
  const model = parseMarkdownDocument(textInput([
    '```c',
    '#include <stdio.h>',
    'const char *url = "https://example.com"; //输出地址',
    'const char *hash = "#不是注释";',
    '```'
  ].join('\n'), 'main.md', 'markdown'))

  const code = model.pages[0]!.blocks.find((block) => block.kind === 'text' && block.role === 'code')
  assert.equal(code?.kind, 'text')
  if (code?.kind !== 'text') return
  assert.equal(code.runs.some((run) => run.protected !== true && run.text.includes('include')), false)
  assert.equal(code.runs.some((run) => run.protected !== true && run.text.includes('#不是注释')), false)
  assert.equal(code.runs.some((run) => run.text === '输出地址' && run.protected !== true), true)
})

test('Markdown 应渲染 GFM 表格并隐藏注释、图片地址和受控字体标签', () => {
  const model = parseMarkdownDocument(textInput([
    '## <font style="color:rgb(8, 8, 8);">配置说明</font>',
    '',
    '<!-- 这是一段不应显示的图片说明 -->',
    '',
    '| **<font style="color:rgb(8, 8, 8);">配置项</font>** | **示例** | 说明 |',
    '| --- | :---: | --- |',
    '| <font style="color:rgb(8, 8, 8);">名称</font> | <font style="color:rgb(8, 8, 8);">不动产档案系统</font> | 名称随意 |',
    '| [<font style="color:rgb(49, 95, 189);">授权地址</font>](http://example.com/auth) | **bdc** | 使用\\|分隔 |',
    '| [<font style="color:rgb(49, 95, 189);">http://example.com/login</font>](http://example.com/login) | token | 链接地址 |',
    '| 图片 | ![架构图](https://example.com/private.png) | <br>换行内容 |'
  ].join('\n'), 'table.md', 'markdown'))

  const heading = model.pages[0]!.blocks[0]
  assert.equal(heading?.kind, 'text')
  if (heading?.kind !== 'text') return
  assert.equal(heading.runs.map((run) => run.text).join(''), '配置说明')
  assert.equal(heading.runs.some((run) => run.text.includes('<font')), false)
  assert.equal(heading.runs[0]?.style?.color, 'rgb(8, 8, 8)')

  const table = model.pages[0]!.blocks[1]
  assert.equal(table?.kind, 'table')
  if (table?.kind !== 'table') return
  assert.equal(table.headerRows, 1)
  assert.equal(table.rows.length, 5)
  assert.deepEqual(table.rows.map((row) => row.cells.length), [3, 3, 3, 3, 3])

  const tableText = table.rows.flatMap((row) => row.cells.flatMap((cell) =>
    cell.blocks.flatMap((block) => block.kind === 'text' ? [block.runs.map((run) => run.text).join('')] : [])
  )).join('\n')
  assert.match(tableText, /配置项/u)
  assert.match(tableText, /不动产档案系统/u)
  assert.match(tableText, /授权地址/u)
  assert.match(tableText, /http:\/\/example\.com\/login/u)
  assert.match(tableText, /架构图/u)
  assert.match(tableText, /使用\|分隔/u)
  assert.doesNotMatch(tableText, /<font|<\/font>|\*\*|<!--|https:\/\/example\.com\/private\.png/u)
  assert.equal(table.rows[0]!.cells[0]!.blocks[0]?.kind === 'text'
    ? table.rows[0]!.cells[0]!.blocks[0]!.runs[0]?.style?.fontWeight
    : undefined, 700)
  assert.equal(table.rows[1]!.cells[1]!.blocks[0]?.kind === 'text'
    ? table.rows[1]!.cells[1]!.blocks[0]!.runs[0]?.style?.color
    : undefined, 'rgb(8, 8, 8)')
})

test('JSON 应保留键名并仅翻译字符串值，CSV 应生成行列结构', () => {
  const json = parseTextDocument(textInput(JSON.stringify({
    title: 'Hello world',
    nested: { label: 'Translate me' },
    count: 3
  }), 'data.json', 'json'))
  const jsonText = translatableText(json).join('\n')
  assert.match(jsonText, /Hello world/u)
  assert.match(jsonText, /Translate me/u)
  assert.doesNotMatch(jsonText, /title|nested|label/u)
  assert.deepEqual(translatableText(json), ['Hello world', 'Translate me'])

  const csv = parseDelimitedDocument(textInput('name,description\nA,"First row"\nB,"Second row"', 'items.csv', 'csv'))
  const table = csv.pages[0]!.blocks[0]
  assert.equal(table.kind, 'table')
  if (table.kind !== 'table') return
  assert.equal(table.rows.length, 3)
  assert.equal(table.rows[1]!.cells.length, 2)
  assert.equal(table.rows[1]!.cells[1]!.blocks[0]!.kind, 'text')
})

test('SRT 与 VTT 应保留时间轴和序号，仅将字幕文本作为可翻译块', () => {
  const srt = parseSubtitleDocument(textInput([
    '1',
    '00:00:01,000 --> 00:00:03,000',
    'Hello subtitle',
    '',
    '2',
    '00:00:04,000 --> 00:00:06,000',
    'Second line'
  ].join('\n'), 'captions.srt', 'srt'))
  assert.deepEqual(translatableText(srt), ['Hello subtitle', 'Second line'])
  assert.match(JSON.stringify(srt), /00:00:01,000/u)
  assert.match(JSON.stringify(srt), /"readingOrder":0/u)
  assert.deepEqual(srt.pages[0]!.blocks.map((block) => block.kind === 'text' ? block.timing : undefined), [
    '00:00:01,000 --> 00:00:03,000',
    '00:00:04,000 --> 00:00:06,000'
  ])
  assert.deepEqual(srt.pages[0]!.blocks.map((block) => block.kind === 'text' ? block.sequence : undefined), [1, 2])
  assert.equal(translatableText(srt).some((text) => /00:00:|\d{3}\s+-->/u.test(text)), false)

  const vtt = parseSubtitleDocument(textInput([
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:03.000',
    'Hello VTT'
  ].join('\n'), 'captions.vtt', 'vtt'))
  assert.deepEqual(translatableText(vtt), ['Hello VTT'])
})

test('HTML 应清理危险内容并为源文预览提供净化结果', () => {
  const model = parseHtmlDocument(textInput([
    '<!doctype html><html><head><title>Example</title></head><body>',
    '<h1>Heading</h1>',
    '<p onclick="alert(1)">Safe <a href="javascript:alert(1)">bad</a> <a href="https://example.com">good</a></p>',
    '<script>alert(1)</script><iframe src="https://evil.example"></iframe>',
    '<img src="https://evil.example/a.png" onerror="alert(1)">',
    '</body></html>'
  ].join(''), 'page.html', 'html'))

  const serialized = JSON.stringify(model)
  assert.match(serialized, /Heading/u)
  assert.doesNotMatch(serialized, /script|iframe|onclick|onerror|javascript:/iu)
  assert.equal(model.assets.length, 0)
  assert.equal(model.warnings.some((warning) => warning.code === 'remote-resource-removed'), true)
})

test('HTML 源文预览必须移除脚本、事件属性、危险 URL 与远程资源', () => {
  const preview = sanitizeHtmlPreview([
    '<!doctype html><html><head>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<base href="https://evil.example/">',
    '<link rel="stylesheet" href="https://evil.example/site.css">',
    '<style>',
    '@import url("https://evil.example/import.css");',
    'p{color:#123456;background:url(https://evil.example/a.png);width:expression(alert(1))}',
    'a{position:fixed;inset:0;font-family:"Noto Sans";font-size:16px;line-height:1.6;text-align:left;color:rgb(1,2,3)}',
    '</style></head><body onload="alert(1)">',
    '<h1 onclick="alert(1)">Safe heading</h1>',
    '<p style="color:red;background-image:url(javascript:alert(1));width:expression(alert(1))">Safe text</p>',
    '<a href="javascript:alert(1)" onmouseover="alert(1)">bad</a>',
    '<a href="https://example.com">remote link</a>',
    '<img src="https://evil.example/a.png" onerror="alert(1)">',
    '<img src="data:image/svg+xml,<svg onload=alert(1)>">',
    '<img src="images/local.png">',
    '<iframe src="https://evil.example"></iframe>',
    '<script>alert(1)</script>',
    '</body></html>'
  ].join(''), 'safe-preview.html', 'html')

  assert.match(preview.html, /Safe heading/u)
  assert.match(preview.html, /Safe text/u)
  assert.match(preview.html, /href="https:\/\/example\.com"/u)
  assert.match(preview.html, /src="images\/local\.png"/u)
  assert.doesNotMatch(preview.html, /<script|onclick|onerror|onload|onmouseover/iu)
  assert.doesNotMatch(preview.html, /javascript:|vbscript:|expression\(|@import/iu)
  assert.doesNotMatch(preview.html, /<iframe|<meta[^>]+refresh|<base\b|<link\b/iu)
  assert.doesNotMatch(preview.html, /https:\/\/evil\.example/iu)
  assert.doesNotMatch(preview.html, /data:image\/svg/iu)
  assert.match(preview.html, /<style>/u)
  assert.match(preview.html, /color:\s*#123456/iu)
  assert.match(preview.html, /font-size:\s*16px/iu)
  assert.doesNotMatch(preview.html, /position:\s*fixed|inset:\s*0/iu)
  assert.equal(preview.warnings.some((warning) => warning.code === 'remote-resource-removed'), true)
  assert.equal(preview.warnings.some((warning) => warning.code === 'unsafe-html-removed'), true)
})

test('HTML 净化预览必须保持无危险内容且允许安全的包内相对资源', () => {
  const preview = sanitizeHtmlPreview([
    '<html><body>',
    '<picture><source srcset="https://evil.example/a.webp"><img src="./images/local.png" alt="local"></picture>',
    '<video poster="https://evil.example/poster.png"><source src="media/local.mp4"></video>',
    '<div style="font-weight:700;color:#abc;background-color:rgba(1,2,3,.5);border:1px solid #000">Content</div>',
    '</body></html>'
  ].join(''), 'relative.html', 'html')

  assert.match(preview.html, /src="\.\/images\/local\.png"/u)
  assert.match(preview.html, /src="media\/local\.mp4"/u)
  assert.doesNotMatch(preview.html, /evil\.example/iu)
  assert.match(preview.html, /font-weight:\s*700/iu)
  assert.match(preview.html, /border:\s*1px solid #000/iu)
})

test('HTML 应忽略 XML 声明而不是把声明作为正文送去翻译', () => {
  const model = parseHtmlDocument(textInput([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<div><h1>Heading</h1><p>Translatable paragraph</p></div>'
  ].join('\n'), 'page.html', 'html'))

  assert.deepEqual(translatableText(model), ['Heading', 'Translatable paragraph'])
  assert.equal(JSON.stringify(model).includes('?xml version='), false)
})

test('HTML 扫描件应提取 SVG 文本并忽略图形路径', () => {
  const model = parseHtmlDocument(textInput([
    '<!doctype html><html><body>',
    '<div style="width:987px;height:1395px">',
    '<svg style="position:absolute;width:289px;height:31px">',
    '<text x="0" y="24" fill="transparent">机</text>',
    '<text x="36" y="24" fill="transparent">关</text>',
    '<text x="72" y="24" fill="transparent">档</text>',
    '<text x="108" y="24" fill="transparent">案</text>',
    '<path d="M151 210 L173 197 L164 193"/>',
    '</svg>',
    '<svg style="position:absolute;width:665px;height:25px">',
    '<text x="0" y="19" fill="transparent">2018 年 10 月 11 日</text>',
    '</svg>',
    '<svg style="position:absolute;width:665px;height:25px">',
    '<text x="0" y="19" fill="transparent">机关档案管理规定</text>',
    '</svg>',
    '</div>',
    '</body></html>'
  ].join(''), 'scanned.html', 'html'))

  assert.deepEqual(translatableText(model), ['机关档案', '2018 年 10 月 11 日', '机关档案管理规定'])
  assert.equal(JSON.stringify(model).includes('M151 210'), false)
})

test('HTML 扫描件同一视觉行的分栏 SVG 文本不能被错误粘连', () => {
  const model = parseHtmlDocument(textInput([
    '<!doctype html><html><body>',
    '<svg style="width:300px;height:30px"><text x="0" y="20">左栏内容</text></svg>',
    '<svg style="width:300px;height:30px"><text x="0" y="20">右栏内容</text></svg>',
    '</body></html>'
  ].join(''), 'columns.html', 'html'))

  assert.deepEqual(translatableText(model), ['左栏内容', '右栏内容'])
})

test('HTML 扫描件应按页面容器保留 SVG 坐标、字号和字体，而不是压成单页流', () => {
  const model = parseHtmlDocument(textInput([
    '<!doctype html><html><body>',
    '<div style="background: white; width: 987px;height: 1395px;">',
    '<div style="position: absolute;width:987px;height:1395px;">',
    '<svg style="overflow:visible;position:absolute;width:289.3px;height:30.6px;left:348.2px;top:140.9px;z-index:50">',
    '<text x="0" y="24.5" style="font-weight:400;font-size:26px;font-family:simSum;" fill="transparent">机关档案</text>',
    '</svg>',
    '</div></div>',
    '<div style="background: white; width: 987px;height: 1395px;">',
    '<div style="position: absolute;width:987px;height:1395px;">',
    '<svg style="overflow:visible;position:absolute;width:665.3px;height:24.7px;left:164.7px;top:261.8px;z-index:51">',
    '<text x="0" y="19.5" style="font-weight:600;font-size:20px;font-family:simSun;" fill="transparent">第二页内容</text>',
    '</svg>',
    '</div></div>',
    '</body></html>'
  ].join(''), 'scanned-pages.html', 'html'))

  assert.equal(model.pages.length, 2)
  assert.deepEqual(model.pages.map((page) => [page.width, page.height]), [[987, 1395], [987, 1395]])
  assert.deepEqual(translatableText(model), ['机关档案', '第二页内容'])
  const first = model.pages[0]!.blocks[0]
  assert.equal(first?.kind, 'text')
  if (first?.kind !== 'text') return
  assert.deepEqual(first.bbox, { x: 348.2, y: 140.9, width: 289.3, height: 30.6 })
  assert.equal(first.style?.fontSize, 26)
  assert.equal(first.style?.fontWeight, 400)
  assert.equal(first.style?.fontFamily, 'simSum')
  assert.notEqual(first.style?.color, 'transparent')
})

test('HTML 扫描件同页多行 SVG 应保持各自坐标，不能合并成同一定位块', () => {
  const model = parseHtmlDocument(textInput([
    '<!doctype html><html><body>',
    '<div style="width:987px;height:1395px">',
    '<svg style="position:absolute;width:400px;height:30px;left:100px;top:200px">',
    '<text x="0" y="24" style="font-size:26px">第一行</text>',
    '</svg>',
    '<svg style="position:absolute;width:500px;height:30px;left:80px;top:240px">',
    '<text x="0" y="24" style="font-size:26px">第二行</text>',
    '</svg>',
    '</div></body></html>'
  ].join(''), 'scanned-lines.html', 'html'))

  assert.equal(model.pages.length, 1)
  assert.equal(model.pages[0]!.blocks.length, 2)
  assert.deepEqual(model.pages[0]!.blocks.map((block) => block.bbox && [block.bbox.x, block.bbox.y]), [[100, 200], [80, 240]])
})

test('HTML 扫描件应按段落合并 SVG 视觉行，不能把原文每一行拆成独立翻译块', () => {
  const model = parseHtmlDocument(textInput([
    '<!doctype html><html><body>',
    '<div style="width:1000px;height:1000px">',
    '<svg style="position:absolute;width:700px;height:30px;left:150px;top:200px">',
    '<text x="0" y="24" style="font-size:20px">第一条为了加强机关档案管理，</text>',
    '</svg>',
    '<svg style="position:absolute;width:700px;height:30px;left:150px;top:250px">',
    '<text x="0" y="24" style="font-size:20px">制定本规定。</text>',
    '</svg>',
    '<svg style="position:absolute;width:650px;height:30px;left:200px;top:300px">',
    '<text x="0" y="24" style="font-size:20px">第二条本规定适用于各级机关。</text>',
    '</svg>',
    '</div></body></html>'
  ].join(''), 'scanned-paragraphs.html', 'html'))

  assert.deepEqual(translatableText(model), [
    '第一条为了加强机关档案管理，制定本规定。',
    '第二条本规定适用于各级机关。'
  ])
  assert.equal(model.pages[0]!.blocks.length, 2)
  assert.deepEqual(model.pages[0]!.blocks[0]?.bbox, {
    x: 150,
    y: 200,
    width: 700,
    height: 80
  })
})

test('HTML 扫描件不能把接近页面中心的正文续行误判为居中标题', () => {
  const svg = (left: number, top: number, width: number, height: number, text: string): string =>
    `<svg style="position:absolute;width:${width}px;height:${height}px;left:${left}px;top:${top}px">` +
    `<text x="0" y="${Math.max(1, height - 5)}" style="font-size:20px">${text}</text></svg>`
  const model = parseHtmlDocument(textInput([
    '<!doctype html><html><body>',
    '<div style="width:987px;height:1395px">',
    svg(348.2, 140.9, 289.3, 30.6, '机关档案管理规定'),
    svg(164.7, 261.8, 665.3, 24.7, '(2018年10月11日国家档案局令第13号公布'),
    svg(389.2, 314, 194.2, 24.7, '自2019年1月1日起施行）'),
    svg(409.9, 414.2, 163.2, 29.4, '第一章 总则'),
    svg(201.4, 468.4, 634.7, 24.7, '第一条为了加强各级党和国家机关、人民团体（以下'),
    svg(151.2, 522.1, 683.3, 20.3, '统称机关）档案工作，推进机关档案科学、规范管理，丰富'),
    svg(150, 571.4, 686, 24.7, '国家档案资源，为各项工作提供有效服务，根据《中华人民'),
    svg(148.4, 624, 687.6, 24.7, '共和国档案法》《机关档案工作条例》等法律法规，制定本'),
    svg(144.1, 671.7, 86.7, 32.2, '规定。'),
    svg(201.4, 727, 634.7, 24.7, '第二条本规定所称的机关档案，是指机关在公务活动'),
    svg(151.2, 780.7, 683.3, 20.3, '中形成的，对国家和社会有查考、利用和保存价值的各种形'),
    svg(148.4, 830.5, 320.3, 24.7, '式、各种载体的历史记录。'),
    svg(202.5, 884.2, 631.9, 20.3, '第三条机关档案工作是档案工作开展的基础，是国家'),
    svg(148.4, 933.6, 317.2, 24.7, '档案事业的重要组成部分。'),
    svg(202.5, 987.3, 631.9, 20.3, '机关档案工作是机关不可缺少的基础性工作，是推进依'),
    svg(150, 1039.8, 684.4, 20.3, '法行政、促进科学决策、提高治理水平的必要条件，是保护'),
    svg(148.4, 1087.6, 692, 26.3, '单位和个人合法权益、维护机关历史真实面貌的一项重要工'),
    svg(142.5, 1134.1, 63.3, 39.4, '作。'),
    svg(201.4, 1192.2, 568.6, 25.1, '第四条机关档案工作实行统一领导、分级管理。'),
    '</div></body></html>'
  ].join(''), 'scanned-real-layout.html', 'html'))

  assert.deepEqual(translatableText(model), [
    '机关档案管理规定',
    '(2018年10月11日国家档案局令第13号公布自2019年1月1日起施行）',
    '第一章 总则',
    '第一条为了加强各级党和国家机关、人民团体（以下统称机关）档案工作，推进机关档案科学、规范管理，丰富国家档案资源，为各项工作提供有效服务，根据《中华人民共和国档案法》《机关档案工作条例》等法律法规，制定本规定。',
    '第二条本规定所称的机关档案，是指机关在公务活动中形成的，对国家和社会有查考、利用和保存价值的各种形式、各种载体的历史记录。',
    '第三条机关档案工作是档案工作开展的基础，是国家档案事业的重要组成部分。',
    '机关档案工作是机关不可缺少的基础性工作，是推进依法行政、促进科学决策、提高治理水平的必要条件，是保护单位和个人合法权益、维护机关历史真实面貌的一项重要工作。',
    '第四条机关档案工作实行统一领导、分级管理。'
  ])
  assert.equal(model.pages[0]!.blocks.length, 8)
})

test('HTML 扫描件应按条款和列表编号拆分语义段落，且不能跨页粘连', () => {
  const svg = (left: number, top: number, width: number, height: number, text: string): string =>
    `<svg style="position:absolute;width:${width}px;height:${height}px;left:${left}px;top:${top}px">` +
    `<text x="0" y="${Math.max(1, height - 5)}" style="font-size:20px">${text}</text></svg>`
  const model = parseHtmlDocument(textInput([
    '<!doctype html><html><body>',
    '<div style="width:987px;height:1395px">',
    svg(201.4, 140, 634.7, 24.7, '第五十九条机关应当开展室藏传统载体档案'),
    svg(150, 192, 684.4, 20.3, '数字化工作，逐步实现传统载体档案数字'),
    svg(150, 244, 684.4, 20.3, '化。'),
    svg(201.4, 300, 634.7, 24.7, '第六十条机关应当建立电子文件归档与'),
    svg(150, 352, 684.4, 20.3, '电子档案管理制度。'),
    svg(201.4, 408, 634.7, 24.7, '第六十一条机关配备的网络基础设施、'),
    svg(150, 460, 684.4, 20.3, '系统硬件和基础软件。'),
    svg(202.5, 516, 631.9, 20.3, '（一）贯彻执行档案工作的法律法规和方针政策，'),
    svg(150, 568, 684.4, 20.3, '建立健全档案工作规章制度。'),
    svg(202.5, 624, 631.9, 20.3, '（二）制定并组织实施档案工作发展规划或计划；'),
    svg(201.4, 680, 634.7, 24.7, '第六十二条机关办公自动化系统和其他业务系统'),
    svg(150, 732, 684.4, 20.3, '应当与电子档案管理系统衔接。'),
    '</div>',
    '<div style="width:987px;height:1395px">',
    svg(202.5, 140, 630.3, 20.3, '第六十六条机关应当统筹开展传统载体档案数字化、'),
    svg(150, 192.7, 684.4, 20.3, '电子文件归档与电子档案管理的安全保密工作。'),
    svg(150, 244.7, 684.4, 20.3, '涉密档案应当严格遵守保密规定。'),
    svg(201.4, 296.7, 634.7, 25.1, '第六十七条有下列情形之一的，由县级以上档案行政'),
    svg(150, 348.7, 684.4, 20.3, '管理部门给予表彰奖励。'),
    svg(201.4, 400.7, 634.7, 25.1, '第六十八条有下列行为之一的，由县级以上档案行政'),
    svg(150, 452.7, 684.4, 20.3, '管理部门责令限期改正。'),
    '</div></body></html>'
  ].join(''), 'scanned-clauses.html', 'html'))

  assert.deepEqual(translatableText(model), [
    '第五十九条机关应当开展室藏传统载体档案数字化工作，逐步实现传统载体档案数字化。',
    '第六十条机关应当建立电子文件归档与电子档案管理制度。',
    '第六十一条机关配备的网络基础设施、系统硬件和基础软件。',
    '（一）贯彻执行档案工作的法律法规和方针政策，建立健全档案工作规章制度。',
    '（二）制定并组织实施档案工作发展规划或计划；',
    '第六十二条机关办公自动化系统和其他业务系统应当与电子档案管理系统衔接。',
    '第六十六条机关应当统筹开展传统载体档案数字化、电子文件归档与电子档案管理的安全保密工作。涉密档案应当严格遵守保密规定。',
    '第六十七条有下列情形之一的，由县级以上档案行政管理部门给予表彰奖励。',
    '第六十八条有下列行为之一的，由县级以上档案行政管理部门责令限期改正。'
  ])
  assert.equal(model.pages.length, 2)
  assert.equal(model.pages[1]!.blocks.length, 3)
})

test('DOCX 应解析段落、表格、图片关系和 OMML 公式', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>')
  zip.file('word/document.xml', `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
      <w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>Doc heading</w:t></w:r></w:p>
        <w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId1"/></w:drawing></w:r></w:p>
        <w:p><m:oMath><m:r><m:t>x^2+1</m:t></m:r></m:oMath></w:p>
      </w:body>
    </w:document>`)
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`)
  zip.file('word/media/image1.png', new Uint8Array([137, 80, 78, 71]))
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const model = await parseDocxDocument({
    path: '/tmp/sample.docx',
    fileName: 'sample.docx',
    format: 'docx',
    sha256: FINGERPRINT,
    bytes
  })

  assert.deepEqual(translatableText(model), ['Doc heading', 'First paragraph', 'Cell A', 'Cell B'])
  assert.equal(model.assets.length, 1)
  assert.equal(model.pages.flatMap((page) => page.blocks).some((block) => block.kind === 'image'), true)
  assert.equal(model.pages.flatMap((page) => page.blocks).some((block) => block.kind === 'formula'), true)
  const heading = model.pages[0]!.blocks[0]
  assert.equal(heading.kind === 'text' ? heading.role : '', 'heading')
})

test('DOCX、EPUB 与 PDF 重复解析必须生成稳定页面、区块和资源标识', async () => {
  const docx = new JSZip()
  docx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>')
  docx.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Stable DOCX paragraph</w:t></w:r></w:p></w:body></w:document>')
  const docxBytes = await docx.generateAsync({ type: 'uint8array' })
  const docxInput = {
    path: '/tmp/stable.docx',
    fileName: 'stable.docx',
    format: 'docx' as const,
    sha256: FINGERPRINT,
    bytes: docxBytes
  }
  const firstDocx = await parseDocxDocument(docxInput)
  const secondDocx = await parseDocxDocument(docxInput)

  const epub = new JSZip()
  epub.file('mimetype', 'application/epub+zip')
  epub.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  epub.file('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Stable EPUB</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>')
  epub.file('OEBPS/chapter.xhtml', '<html><body><h1>Stable EPUB heading</h1><p>Stable EPUB paragraph</p></body></html>')
  const epubBytes = await epub.generateAsync({ type: 'uint8array' })
  const epubInput = {
    path: '/tmp/stable.epub',
    fileName: 'stable.epub',
    format: 'epub' as const,
    sha256: FINGERPRINT,
    bytes: epubBytes
  }
  const firstEpub = await parseEpubDocument(epubInput)
  const secondEpub = await parseEpubDocument(epubInput)

  const pdf = await PDFDocument.create()
  const page = pdf.addPage([600, 800])
  page.drawText('Stable PDF paragraph', { x: 50, y: 700, size: 20 })
  const pdfBytes = await pdf.save()
  const pdfInput = {
    path: '/tmp/stable.pdf',
    fileName: 'stable.pdf',
    format: 'pdf' as const,
    sha256: FINGERPRINT,
    bytes: pdfBytes
  }
  const firstPdf = await parsePdfDocument(pdfInput)
  const secondPdf = await parsePdfDocument(pdfInput)

  for (const [label, first, second] of [
    ['DOCX', firstDocx, secondDocx],
    ['EPUB', firstEpub, secondEpub],
    ['PDF', firstPdf, secondPdf]
  ] as const) {
    assert.deepEqual(stableDocumentIdentities(first), stableDocumentIdentities(second), `${label} 重复解析标识必须一致`)
    assert.deepEqual(first.assets.map((asset) => asset.assetId), second.assets.map((asset) => asset.assetId), `${label} 重复解析资源标识必须一致`)
  }
})

test('DOCX 包单条目超过限制时必须返回稳定安全错误且不泄露路径', async () => {
  const bytes = await minimalDocx({
    'word/media/large.bin': new Uint8Array(2_048)
  })
  await assertPackageSecurityError(async () => {
    await loadSafeDocumentPackage({
      path: '/tmp/secret.docx',
      fileName: 'secret.docx',
      format: 'docx',
      sha256: FINGERPRINT,
      bytes
    }, {
      maxEntryBytes: 1_024,
      maxUncompressedBytes: 10_000,
      maxCompressionRatio: 10_000
    })
  }, 'package-entry-too-large')
})

test('DOCX 包解包总大小超过限制时必须中止解析并返回稳定错误', async () => {
  const bytes = await minimalDocx({
    'word/media/first.bin': new Uint8Array(800),
    'word/media/second.bin': new Uint8Array(800)
  })
  await assertPackageSecurityError(async () => {
    await loadSafeDocumentPackage({
      path: '/tmp/secret.docx',
      fileName: 'secret.docx',
      format: 'docx',
      sha256: FINGERPRINT,
      bytes
    }, {
      maxEntryBytes: 1_024,
      maxUncompressedBytes: 1_500,
      maxCompressionRatio: 10_000
    })
  }, 'package-uncompressed-too-large')
})

test('DOCX 高压缩比条目必须作为压缩炸弹中止解析', async () => {
  const bytes = await minimalDocx({
    'word/media/bomb.bin': new Uint8Array(16_384)
  })
  await assertPackageSecurityError(async () => {
    await loadSafeDocumentPackage({
      path: '/tmp/secret.docx',
      fileName: 'secret.docx',
      format: 'docx',
      sha256: FINGERPRINT,
      bytes
    }, {
      maxEntryBytes: 64 * 1024,
      maxUncompressedBytes: 128 * 1024,
      maxCompressionRatio: 2
    })
  }, 'package-compression-ratio-too-high')
})

test('DOCX 图片像素超过上限时必须跳过资源并保留可本地化告警', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  zip.file('word/document.xml', `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <w:body>
        <w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>
        <w:p><w:r><w:t>Visible paragraph</w:t></w:r></w:p>
      </w:body>
    </w:document>`)
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/huge.png"/></Relationships>')
  zip.file('word/media/huge.png', pngHeader(5_000, 5_000))
  const model = await parseDocxDocument({
    path: '/tmp/pixel-limit.docx',
    fileName: 'pixel-limit.docx',
    format: 'docx',
    sha256: FINGERPRINT,
    bytes: await zip.generateAsync({ type: 'uint8array' })
  })

  assert.equal(model.assets.length, 0)
  assert.deepEqual(translatableText(model), ['Visible paragraph'])
  assert.equal(model.warnings.some((warning) => warning.code === 'image-pixel-limit-reached'), true)
})

test('EPUB 页数超过限制时必须停止新增章节并保留可本地化告警', async () => {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Paged book</dc:title></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`)
  zip.file('OEBPS/one.xhtml', '<html><body><p>First chapter</p></body></html>')
  zip.file('OEBPS/two.xhtml', '<html><body><p>Second chapter</p></body></html>')
  const model = await parseEpubDocument({
    path: '/tmp/paged-book.epub',
    fileName: 'paged-book.epub',
    format: 'epub',
    sha256: FINGERPRINT,
    bytes: await zip.generateAsync({ type: 'uint8array' })
  }, { maxPages: 1 })

  assert.equal(model.pages.length, 1)
  assert.deepEqual(translatableText(model), ['First chapter'])
  assert.equal(model.warnings.some((warning) => warning.code === 'page-limit-reached'), true)
})

test('EPUB 图片像素超过上限时必须跳过资源并保留正文', async () => {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Pixel book</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>')
  zip.file('OEBPS/chapter.xhtml', '<html><body><p>Visible chapter text</p><img src="images/huge.png"/></body></html>')
  zip.file('OEBPS/images/huge.png', pngHeader(5_000, 5_000))
  const model = await parseEpubDocument({
    path: '/tmp/pixel-book.epub',
    fileName: 'pixel-book.epub',
    format: 'epub',
    sha256: FINGERPRINT,
    bytes: await zip.generateAsync({ type: 'uint8array' })
  })

  assert.equal(model.assets.length, 0)
  assert.deepEqual(translatableText(model), ['Visible chapter text'])
  assert.equal(model.warnings.some((warning) => warning.code === 'image-pixel-limit-reached'), true)
})

test('DOCX 应解析编号列表、纵向合并、单元格语义与 OMML 结构', async () => {
  const zip = new JSZip()
  zip.file('word/document.xml', `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
      <w:body>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested item</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second item</w:t></w:r></w:p>
        <w:tbl>
          <w:tr>
            <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="Heading2"/><w:jc w:val="center"/></w:pPr><w:r><w:t>Merged heading</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:tc></w:tr>
          <w:tr><w:tc><w:tcPr><w:vMerge w:val="continue"/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>Footer</w:t></w:r></w:p></w:tc></w:tr>
        </w:tbl>
        <w:p><m:oMath><m:f><m:num><m:r><m:t>x</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f><m:sSup><m:e><m:r><m:t>y</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></w:p>
      </w:body>
    </w:document>`)
  zip.file('word/numbering.xml', `<?xml version="1.0"?>
    <w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:abstractNum w:abstractNumId="0">
        <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
    </w:numbering>`)
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const model = await parseDocxDocument({
    path: '/tmp/lists-and-merges.docx',
    fileName: 'lists-and-merges.docx',
    format: 'docx',
    sha256: FINGERPRINT,
    bytes
  })

  const listItems = model.pages[0]!.blocks.filter((block) => block.kind === 'text' && block.role === 'list-item')
  assert.deepEqual(listItems.map((block) => block.kind === 'text' ? block.list : undefined), [
    { level: 0, marker: '1.', ordered: true },
    { level: 1, marker: 'a.', ordered: true },
    { level: 0, marker: '2.', ordered: true }
  ])

  const table = model.pages[0]!.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind, 'table')
  if (table?.kind !== 'table') return
  assert.equal(table.rows.length, 3)
  assert.equal(table.rows[0]!.cells[0]!.rowSpan, 3)
  assert.equal(table.rows[1]!.cells.length, 1)
  assert.equal(table.rows[2]!.cells.length, 1)
  const mergedHeading = table.rows[0]!.cells[0]!.blocks[0]
  assert.equal(mergedHeading?.kind === 'text' ? mergedHeading.role : '', 'heading')
  assert.equal(mergedHeading?.kind === 'text' ? mergedHeading.textAlign : undefined, 'center')

  const formula = model.pages[0]!.blocks.find((block) => block.kind === 'formula')
  assert.equal(formula?.kind, 'formula')
  if (formula?.kind !== 'formula') return
  assert.match(formula.mathml ?? '', /^<math\b/u)
  assert.match(formula.mathml ?? '', /<mfrac>/u)
  assert.match(formula.mathml ?? '', /<msup>/u)
  assert.equal(formula.mathml?.includes('<script') ?? true, false)
})

test('DOCX 应继承文档默认、段落和字符样式，并允许直接格式覆盖', async () => {
  const zip = new JSZip()
  zip.file('word/document.xml', `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Styled heading</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Numbered"/></w:pPr><w:r><w:t>Styled list item</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:rStyle w:val="Emphasis"/></w:rPr><w:t>Character style</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:rStyle w:val="Emphasis"/><w:b/><w:sz w:val="40"/><w:color w:val="abcdef"/><w:i w:val="0"/></w:rPr><w:t>Direct override</w:t></w:r></w:p>
      </w:body>
    </w:document>`)
  zip.file('word/styles.xml', `<?xml version="1.0"?>
    <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:docDefaults>
        <w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/><w:color w:val="222222"/></w:rPr></w:rPrDefault>
        <w:pPrDefault><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrDefault>
      </w:docDefaults>
      <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading1">
        <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
        <w:pPr><w:jc w:val="center"/></w:pPr>
        <w:rPr><w:rFonts w:ascii="Aptos Display"/><w:sz w:val="32"/><w:color w:val="112233"/><w:b/></w:rPr>
      </w:style>
      <w:style w:type="paragraph" w:styleId="Numbered">
        <w:name w:val="List Number"/><w:basedOn w:val="Normal"/>
        <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>
      </w:style>
      <w:style w:type="character" w:styleId="Emphasis">
        <w:name w:val="Emphasis"/><w:rPr><w:i/><w:u/><w:color w:val="445566"/></w:rPr>
      </w:style>
    </w:styles>`)
  zip.file('word/numbering.xml', `<?xml version="1.0"?>
    <w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>
      <w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>
    </w:numbering>`)
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const model = await parseDocxDocument({
    path: '/tmp/styles.docx',
    fileName: 'styles.docx',
    format: 'docx',
    sha256: FINGERPRINT,
    bytes
  })

  const blocks = model.pages[0]!.blocks
  const heading = blocks[0]
  assert.equal(heading?.kind === 'text' ? heading.role : '', 'heading')
  assert.equal(heading?.kind === 'text' ? heading.textAlign : undefined, 'center')
  assert.deepEqual(heading?.kind === 'text' ? heading.runs[0]?.style : undefined, {
    fontFamily: 'Aptos Display',
    fontSize: 16,
    color: '#112233',
    fontWeight: 700
  })

  const listItem = blocks[1]
  assert.equal(listItem?.kind === 'text' ? listItem.role : '', 'list-item')
  assert.deepEqual(listItem?.kind === 'text' ? listItem.list : undefined, {
    level: 0,
    marker: '1.',
    ordered: true
  })

  const characterStyle = blocks[2]
  assert.deepEqual(characterStyle?.kind === 'text' ? characterStyle.runs[0]?.style : undefined, {
    fontFamily: 'Aptos',
    fontSize: 11,
    color: '#445566',
    italic: true,
    underline: true
  })

  const directOverride = blocks[3]
  assert.deepEqual(directOverride?.kind === 'text' ? directOverride.runs[0]?.style : undefined, {
    fontFamily: 'Aptos',
    fontSize: 20,
    color: '#abcdef',
    fontWeight: 700,
    italic: false,
    underline: true
  })
})

test('DOCX 应保持段落内文本、公式、图片顺序，并在分页符处切页', async () => {
  const zip = new JSZip()
  zip.file('word/document.xml', `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
      <w:body>
        <w:p>
          <w:r><w:t>Before formula</w:t></w:r>
          <m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>
          <w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId1"/></w:drawing></w:r>
          <w:r><w:t>After image</w:t></w:r>
        </w:p>
        <w:p><w:r><w:t>Page one</w:t><w:br w:type="page"/><w:t>Page two</w:t></w:r></w:p>
        <w:tbl>
          <w:tr>
            <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Wide cell</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl>
      </w:body>
    </w:document>`)
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`)
  zip.file('word/media/image1.png', new Uint8Array([137, 80, 78, 71]))
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const model = await parseDocxDocument({
    path: '/tmp/ordered-and-paged.docx',
    fileName: 'ordered-and-paged.docx',
    format: 'docx',
    sha256: FINGERPRINT,
    bytes
  })

  assert.equal(model.pages.length, 2)
  assert.deepEqual(model.pages[0]!.blocks.map((block) => block.kind), ['text', 'formula', 'image', 'text', 'text'])
  assert.deepEqual(model.pages[0]!.blocks.flatMap((block) => block.kind === 'text'
    ? [block.runs.map((run) => run.text).join('')]
    : []), ['Before formula', 'After image', 'Page one'])
  assert.deepEqual(translatableText({ ...model, pages: [model.pages[1]!] }), ['Page two', 'Wide cell'])
  const table = model.pages[1]!.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind === 'table' ? table.rows[0]?.cells[0]?.colSpan : undefined, 2)
})

test('EPUB 应按 OPF spine 顺序生成章节而不是按文件名排序', async () => {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture book</dc:title></metadata><manifest><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>`)
  zip.file('OEBPS/a.xhtml', '<html><body><h1>Chapter A</h1></body></html>')
  zip.file('OEBPS/b.xhtml', '<html><body><h1>Chapter B</h1></body></html>')
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const model = await parseEpubDocument({
    path: '/tmp/book.epub',
    fileName: 'book.epub',
    format: 'epub',
    sha256: FINGERPRINT,
    bytes
  })

  assert.deepEqual(translatableText(model), ['Chapter B', 'Chapter A'])
  assert.equal(model.metadata.title, 'Fixture book')
})

test('EPUB 章节图片应登记资源并生成可 OCR 的图片区块', async () => {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Image book</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="image" href="images/scan.png" media-type="image/png"/></manifest><spine><itemref idref="chapter"/></spine></package>`)
  zip.file('OEBPS/chapter.xhtml', '<html><body><h1>Chapter</h1><p>Before image</p><img src="images/scan.png" alt="scanned note"/><p>After image</p></body></html>')
  zip.file('OEBPS/images/scan.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]))
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const model = await parseEpubDocument({
    path: '/tmp/image-book.epub',
    fileName: 'image-book.epub',
    format: 'epub',
    sha256: FINGERPRINT,
    bytes
  })

  assert.equal(model.assets.length, 1)
  const imageBlocks = model.pages.flatMap((page) => page.blocks).filter((block) => block.kind === 'image')
  assert.equal(imageBlocks.length, 1)
  assert.equal(imageBlocks[0]?.kind === 'image' ? imageBlocks[0].assetId : '', model.assets[0]!.assetId)
})

test('EPUB3 应读取 nav 目录、包内 CSS 与内联样式，并按正文顺序保留图片', async () => {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Styled book</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="styles/book.css" media-type="text/css"/><item id="image" href="images/scan.png" media-type="image/png"/></manifest><spine><itemref idref="chapter"/></spine></package>`)
  zip.file('OEBPS/nav.xhtml', '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml#start">目录中的章节标题</a></li></ol></nav></body></html>')
  zip.file('OEBPS/styles/book.css', '#start{font-family:"Noto Serif";font-size:18px;font-weight:700;text-align:center}p{color:#123456;text-align:center}@import url("https://evil.example/x.css");p{background-image:url("https://evil.example/a.png")}')
  zip.file('OEBPS/chapter.xhtml', '<html><head><link rel="stylesheet" href="styles/book.css"/><style>h2{color:#abcdef}</style></head><body><h2 id="start">Heading</h2><p>Before image</p><img src="images/scan.png" alt="scanned note"/><p style="color:#654321;font-size:20px">After image</p><ol><li>One</li><li>Two</li></ol><table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table></body></html>')
  zip.file('OEBPS/images/scan.png', new Uint8Array([137, 80, 78, 71, 4, 5, 6]))
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const first = await parseEpubDocument({
    path: '/tmp/styled-book.epub',
    fileName: 'styled-book.epub',
    format: 'epub',
    sha256: FINGERPRINT,
    bytes
  })
  const second = await parseEpubDocument({
    path: '/tmp/styled-book.epub',
    fileName: 'styled-book.epub',
    format: 'epub',
    sha256: FINGERPRINT,
    bytes
  })

  assert.equal(first.pages[0]?.title, '目录中的章节标题')
  assert.deepEqual(first.pages[0]?.blocks.map((block) => block.kind), ['text', 'text', 'image', 'text', 'text', 'text', 'table'])
  assert.deepEqual(translatableText(first), ['Heading', 'Before image', 'After image', 'One', 'Two', 'Name', 'Value', 'A', '1'])
  const heading = first.pages[0]?.blocks[0]
  assert.deepEqual(heading?.kind === 'text' ? heading.runs[0]?.style : undefined, {
    fontFamily: 'Noto Serif',
    fontSize: 18,
    fontWeight: 700,
    color: '#abcdef'
  })
  const styledParagraph = first.pages[0]?.blocks.find((block) =>
    block.kind === 'text' && block.runs.some((run) => run.text === 'After image'))
  assert.deepEqual(styledParagraph?.kind === 'text' ? styledParagraph.runs[0]?.style : undefined, {
    fontSize: 20,
    color: '#654321'
  })
  const listItems = first.pages[0]?.blocks.filter((block) => block.kind === 'text' && block.role === 'list-item') ?? []
  assert.deepEqual(listItems.map((block) => block.kind === 'text' ? block.list : undefined), [
    { level: 0, marker: '1.', ordered: true },
    { level: 0, marker: '2.', ordered: true }
  ])
  assert.equal(first.warnings.some((warning) => warning.code === 'remote-resource-removed'), true)
  assert.equal(first.warnings.some((warning) => warning.code === 'unsafe-html-removed'), true)
  assert.deepEqual(
    first.pages[0]?.blocks.map((block) => block.blockId),
    second.pages[0]?.blocks.map((block) => block.blockId)
  )
  assert.deepEqual(first.assets.map((asset) => asset.assetId), second.assets.map((asset) => asset.assetId))
})

test('EPUB2 缺少 nav 时应回退读取 toc.ncx 目录标题', async () => {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('OPS/book.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>EPUB2 book</dc:title></metadata><manifest><item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="chapter"/></spine></package>`)
  zip.file('OPS/toc.ncx', '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="chapter"><navLabel><text>NCX 章节标题</text></navLabel><content src="text/chapter.xhtml"/></navPoint></navMap></ncx>')
  zip.file('OPS/text/chapter.xhtml', '<html><body><h1>Body heading</h1><p>Content</p></body></html>')
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const model = await parseEpubDocument({
    path: '/tmp/epub2-book.epub',
    fileName: 'epub2-book.epub',
    format: 'epub',
    sha256: FINGERPRINT,
    bytes
  })

  assert.equal(model.pages[0]?.title, 'NCX 章节标题')
  assert.deepEqual(translatableText(model), ['Body heading', 'Content'])
})

test('EPUB 应忽略远程图片与不安全目录链接，且不登记远程资源', async () => {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Safe book</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>`)
  zip.file('OEBPS/nav.xhtml', '<html><body><nav role="doc-toc"><a href="https://evil.example/">Remote</a></nav></body></html>')
  zip.file('OEBPS/chapter.xhtml', '<html><body><h1>Safe chapter</h1><img src="https://evil.example/tracker.png"/><img src="data:image/svg+xml,alert(1)"/></body></html>')
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const model = await parseEpubDocument({
    path: '/tmp/safe-book.epub',
    fileName: 'safe-book.epub',
    format: 'epub',
    sha256: FINGERPRINT,
    bytes
  })

  assert.equal(model.pages[0]?.title, 'Safe chapter')
  assert.deepEqual(model.assets, [])
  assert.deepEqual(model.pages[0]?.blocks.map((block) => block.kind), ['text'])
  assert.equal(model.warnings.some((warning) => warning.code === 'remote-resource-removed'), true)
})

test('PDF 原生文本页应读取坐标与字体样式，完全空白页不应标记待 OCR', async () => {
  const bytes = readFileSync('tests/fixtures/document/sample.pdf')
  const model = await parsePdfDocument({
    path: '/tmp/sample.pdf',
    fileName: 'sample.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes
  })

  assert.equal(model.pages.length, 2)
  assert.equal(model.pages[0]!.width > 0, true)
  assert.equal(model.pages[0]!.blocks.some((block) => block.kind === 'text'), true)
  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  assert.equal(textBlocks[0]?.kind === 'text' ? textBlocks[0].runs[0]?.style?.color : '', '#1a334c')
  assert.equal(textBlocks[1]?.kind === 'text' ? textBlocks[1].runs[0]?.style?.color : '', '#000000')
  assert.equal(textBlocks[0]?.kind === 'text' ? textBlocks[0].textAlign : undefined, undefined)
  assert.deepEqual(model.pages[1]!.blocks, [])
  assert.deepEqual(model.pages[1]!.background, { kind: 'solid', color: '#ffffff' })
  assert.equal(model.warnings.some((warning) => warning.code === 'ocr-required'), false)
})

test('PDF 目录行应保护点线与页码，只暴露标题给翻译', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const size = 12
  const title = '2.1.3. Software installation'
  const leader = '.............................................................'
  const pageNumber = '2'
  const leaderX = 90 + font.widthOfTextAtSize(`${title} `, size)
  const pageNumberX = 505.27 - font.widthOfTextAtSize(pageNumber, size)
  page.drawText(title, { x: 90, y: 700, size, font })
  page.drawText(leader, { x: leaderX, y: 700, size, font })
  page.drawText(pageNumber, { x: pageNumberX, y: 700, size, font })
  page.drawText('This sentence ends with dots and the number 2......2', { x: 90, y: 660, size, font })

  const model = await parsePdfDocument({
    path: '/tmp/table-of-contents.pdf',
    fileName: 'table-of-contents.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  const toc = textBlocks.find((block) => block.kind === 'text' && block.toc?.pageNumber === pageNumber)
  assert.equal(toc?.kind, 'text')
  if (toc?.kind !== 'text') return
  assert.equal(toc.runs.filter((run) => run.protected !== true).map((run) => run.text).join(''), title)
  assert.equal(toc.runs.some((run) => /^\.{6,}$/u.test(run.text) && run.protected === true), true)
  assert.equal(toc.runs.some((run) => run.text === pageNumber && run.protected === true), true)

  const ordinary = textBlocks.find((block) =>
    block.kind === 'text' && block.runs.map((run) => run.text).join('').includes('This sentence'))
  assert.equal(ordinary?.kind === 'text' ? ordinary.toc : undefined, undefined)
  assert.equal(ordinary?.kind === 'text' ? ordinary.runs.some((run) => run.protected === true) : true, false)
})

test('PDF 相邻目录行必须保持独立并逐行保护页码', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const size = 12
  const entries = [
    { title: '2.1.2. Software installation', pageNumber: '2' },
    { title: '2.1.3. Software uninstallation', pageNumber: '3' }
  ]
  entries.forEach((entry, index) => {
    const y = 700 - index * 24
    page.drawText(entry.title, { x: 90, y, size, font })
    page.drawText('.............................................................', {
      x: 90 + font.widthOfTextAtSize(`${entry.title} `, size),
      y,
      size,
      font
    })
    page.drawText(entry.pageNumber, {
      x: 505.27 - font.widthOfTextAtSize(entry.pageNumber, size),
      y,
      size,
      font
    })
  })

  const model = await parsePdfDocument({
    path: '/tmp/adjacent-table-of-contents.pdf',
    fileName: 'adjacent-table-of-contents.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const tocBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text' && block.toc)
  assert.deepEqual(
    tocBlocks.map((block) => block.kind === 'text' ? block.toc?.pageNumber : undefined),
    ['2', '3']
  )
  assert.deepEqual(
    tocBlocks.map((block) => block.kind === 'text'
      ? block.runs.filter((run) => run.protected !== true).map((run) => run.text).join('')
      : ''),
    entries.map((entry) => entry.title)
  )
})

test('PDF 完全空白页应保留白色页面背景，不生成扫描图或 OCR 告警', async () => {
  const document = await PDFDocument.create()
  document.addPage([600, 800])
  let renderCount = 0

  const model = await parsePdfDocument({
    path: '/tmp/blank-page.pdf',
    fileName: 'blank-page.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderPageToImage: async () => {
      renderCount += 1
      return new Uint8Array([137, 80, 78, 71, 9, 9])
    }
  })

  assert.equal(renderCount, 0)
  assert.deepEqual(model.pages[0]!.blocks, [])
  assert.deepEqual(model.pages[0]!.background, { kind: 'solid', color: '#ffffff' })
  assert.equal(model.assets.length, 0)
  assert.equal(model.warnings.some((warning) => warning.code === 'ocr-required'), false)
})

test('PDF 无文本但含可见矢量绘制时应生成扫描页，栅格化成功后不保留待渲染告警', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  page.drawRectangle({ x: 80, y: 120, width: 440, height: 560 })
  let renderCount = 0

  const model = await parsePdfDocument({
    path: '/tmp/vector-page.pdf',
    fileName: 'vector-page.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderPageToImage: async () => {
      renderCount += 1
      return new Uint8Array([137, 80, 78, 71, 9, 9])
    }
  })

  assert.equal(renderCount, 1)
  assert.equal(model.pages[0]!.blocks.some((block) => block.kind === 'image'), true)
  assert.equal(model.assets.length, 1)
  assert.equal(model.warnings.some((warning) => warning.code === 'ocr-required'), false)
})

test('PDF 扫描页未注入栅格化器时才应保留待渲染告警', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  page.drawRectangle({ x: 80, y: 120, width: 440, height: 560 })

  const model = await parsePdfDocument({
    path: '/tmp/scanned-pending.pdf',
    fileName: 'scanned-pending.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const scanned = model.pages[0]!.blocks.find((block) => block.kind === 'image')
  assert.equal(scanned?.kind === 'image' ? scanned.renderPending : false, true)
  const warning = model.warnings.find((candidate) => candidate.code === 'ocr-required')
  assert.equal(warning?.pageId, model.pages[0]!.pageId)
  assert.equal(warning?.blockId, scanned?.blockId)
})

test('PDF 文本层仅有页眉页码且主体为大图时仍应生成整页扫描图', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64'
  )
  const image = await document.embedPng(png)
  page.drawImage(image, { x: 60, y: 80, width: 480, height: 640 })
  page.drawText('Quarterly report', { x: 72, y: 760, size: 10, font })
  page.drawText('1', { x: 294, y: 28, size: 10, font })
  let renderCount = 0

  const model = await parsePdfDocument({
    path: '/tmp/low-text-density-scan.pdf',
    fileName: 'low-text-density-scan.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderPageToImage: async () => {
      renderCount += 1
      return new Uint8Array([137, 80, 78, 71, 9, 9])
    },
    renderEmbeddedImageToImage: async () => new Uint8Array([137, 80, 78, 71, 8, 8])
  })

  const imageBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'image')
  assert.equal(renderCount, 1)
  assert.equal(imageBlocks.length, 1)
  assert.deepEqual(imageBlocks[0]!.bbox, {
    x: 0,
    y: 0,
    width: model.pages[0]!.width,
    height: model.pages[0]!.height
  })
  assert.equal(model.pages[0]!.blocks.some((block) =>
    block.kind === 'text' && block.runs.map((run) => run.text).join('').includes('Quarterly report')), false)
})

test('PDF 正常正文页即使存在页眉页码也不得误判为扫描页', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const lines = [
    'The first body line contains enough text to establish a normal text layer.',
    'The second body line continues the report with meaningful document content.',
    'The third body line keeps the page readable without invoking OCR.',
    'The fourth body line closes the paragraph for this layout fixture.'
  ]
  page.drawText('Quarterly report', { x: 72, y: 760, size: 10, font })
  lines.forEach((line, index) => {
    page.drawText(line, { x: 72, y: 700 - index * 24, size: 12, font })
  })
  page.drawText('1', { x: 294, y: 28, size: 10, font })
  let renderCount = 0

  const model = await parsePdfDocument({
    path: '/tmp/normal-text-page.pdf',
    fileName: 'normal-text-page.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderPageToImage: async () => {
      renderCount += 1
      return new Uint8Array([137, 80, 78, 71, 9, 9])
    }
  })

  assert.equal(renderCount, 0)
  assert.equal(model.pages[0]!.blocks.some((block) => block.kind === 'image'), false)
  assert.equal(translatableText(model).some((text) => text.includes('The first body line')), true)
})

test('PDF 正常正文页内的大图不得触发重复的整页 OCR', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64'
  )
  const image = await document.embedPng(png)
  const body = 'A complete paragraph remains in the native text layer and must not be replaced by whole-page OCR.'
  // 图片先绘制，正文覆盖在图片上方；这是海报、报告和网页导出中常见的
  // “原生文本层 + 背景大图”结构，不能因为文本面积小就重复识别整页。
  page.drawImage(image, { x: 60, y: 80, width: 480, height: 560 })
  page.drawText(body, { x: 72, y: 720, size: 12, font })
  let renderPageCount = 0
  let renderRegionCount = 0

  const model = await parsePdfDocument({
    path: '/tmp/text-with-large-image.pdf',
    fileName: 'text-with-large-image.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderPageToImage: async () => {
      renderPageCount += 1
      return new Uint8Array([137, 80, 78, 71, 9, 9])
    },
    renderEmbeddedImageToImage: async () => {
      renderRegionCount += 1
      return new Uint8Array([137, 80, 78, 71, 8, 8])
    }
  })

  const imageBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'image')
  assert.equal(renderPageCount, 0)
  assert.equal(renderRegionCount, 1)
  assert.equal(imageBlocks.length, 1)
  assert.notDeepEqual(imageBlocks[0]!.bbox, {
    x: 0,
    y: 0,
    width: model.pages[0]!.width,
    height: model.pages[0]!.height
  })
  // PDF.js 会去掉文本项末尾的句点，夹具断言按可见正文前缀匹配。
  assert.equal(translatableText(model).some((text) => text.includes(body.slice(0, -1))), true)
})

test('PDF 原生表格应识别矢量网格并保留单元格文字与列宽', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawText('Name', { x: 82, y: 695, size: 12, font })
  page.drawText('Value', { x: 310, y: 695, size: 12, font })
  page.drawText('Alice', { x: 82, y: 655, size: 12, font })
  page.drawText('42', { x: 310, y: 655, size: 12, font })
  for (const y of [720, 680, 640]) {
    page.drawLine({ start: { x: 72, y }, end: { x: 528, y }, thickness: 1 })
  }
  for (const x of [72, 300, 528]) {
    page.drawLine({ start: { x, y: 640 }, end: { x, y: 720 }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/table.pdf',
    fileName: 'table.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const table = model.pages[0]!.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind, 'table')
  if (table?.kind !== 'table') return
  assert.equal(table.rows.length, 2)
  assert.deepEqual(table.rows.map((row) => row.cells.length), [2, 2])
  assert.deepEqual(table.columnWidths, [228, 228])
  assert.deepEqual(translatableText(model), ['Name', 'Value', 'Alice', '42'])
  assert.equal(
    translatableText(model).every((text) => text === text.trim()),
    true,
    '表格单元格不得因视觉行合并而生成前导空格'
  )
  assert.equal(model.pages[0]!.blocks.filter((block) => block.kind === 'text').length, 0)

  const cellTextBlocks = table.rows.flatMap((row) => row.cells.flatMap((cell) =>
    cell.blocks.filter((block) => block.kind === 'text')))
  assert.equal(cellTextBlocks.length, 4)
  assert.equal(new Set(cellTextBlocks.map((block) => block.blockId)).size, cellTextBlocks.length)
  const runIds = cellTextBlocks.flatMap((block) => block.runs.map((run) => run.runId))
  assert.equal(new Set(runIds).size, runIds.length)
})

test('PDF 细长填充矩形应恢复表格边框，大面积背景与裁剪路径仍应忽略', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const borderColor = rgb(0.81, 0.81, 0.81)
  page.drawText('Name', { x: 82, y: 695, size: 12, font })
  page.drawText('Value', { x: 310, y: 695, size: 12, font })
  page.drawText('Alice', { x: 82, y: 655, size: 12, font })
  page.drawText('42', { x: 310, y: 655, size: 12, font })
  // 大面积背景只负责底色，不能被拆成四条页面边框。
  page.drawRectangle({ x: 0, y: 0, width: 600, height: 800, color: rgb(0.98, 0.98, 0.98) })
  // 真实 PDF 中的表格线由约 0.72pt 的细长填充矩形绘制，而不是 stroke。
  for (const y of [720, 680, 640]) {
    page.drawRectangle({ x: 72, y, width: 456, height: 0.72, color: borderColor })
  }
  for (const x of [72, 300, 528]) {
    page.drawRectangle({ x, y: 640, width: 0.72, height: 80, color: borderColor })
  }
  page.pushOperators(
    pushGraphicsState(),
    rectangle(10, 10, 100, 100),
    clipEvenOdd(),
    endPath(),
    popGraphicsState()
  )

  const model = await parsePdfDocument({
    path: '/tmp/filled-table-grid.pdf',
    fileName: 'filled-table-grid.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const table = model.pages[0]!.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind, 'table')
  if (table?.kind !== 'table') return
  assert.equal(table.rows.length, 2)
  assert.deepEqual(table.rows.map((row) => row.cells.length), [2, 2])
  assert.deepEqual(table.columnWidths, [228, 228])
  assert.equal(model.pages[0]!.blocks.some((block) => block.kind === 'shape' &&
    (block.bbox?.width ?? 0) >= 590 && (block.bbox?.height ?? 0) >= 790), false,
  '大面积背景不能被转换为页面装饰线')
  assert.equal(model.pages[0]!.blocks.some((block) => block.kind === 'shape' &&
    (block.bbox?.width ?? 0) >= 90 && (block.bbox?.height ?? 0) >= 90), false,
  '裁剪路径不能被转换为可见形状')
})

test('PDF 网页文件列表仅含左右外框和行线时也必须识别为三列表格', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.92, 842.88])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const left = 68
  const right = 528
  const rowTops = [330, 372, 414, 456]
  const rows = [
    ['docs', 'Update docs', 'Last month'],
    ['src', 'Refactor parser', 'Last week'],
    ['tests', 'Add coverage', 'Yesterday']
  ]
  rows.forEach((texts, rowIndex) => {
    const y = drawY(rowTops[rowIndex]! + 22)
    page.drawText(texts[0]!, { x: 78, y, size: 10, font })
    page.drawText(texts[1]!, { x: 220, y, size: 10, font })
    page.drawText(texts[2]!, { x: 455, y, size: 10, font })
  })
  // 网页文件列表只有容器左右边线和逐行横线，没有贯穿各行的列竖线。
  for (const y of rowTops) {
    page.drawLine({ start: { x: left, y: drawY(y) }, end: { x: right, y: drawY(y) }, thickness: 0.72 })
  }
  page.drawLine({ start: { x: left, y: drawY(rowTops[0]!) }, end: { x: left, y: drawY(rowTops[rowTops.length - 1]!) }, thickness: 0.72 })
  page.drawLine({ start: { x: right, y: drawY(rowTops[0]!) }, end: { x: right, y: drawY(rowTops[rowTops.length - 1]!) }, thickness: 0.72 })

  const model = await parsePdfDocument({
    path: '/tmp/web-file-list.pdf',
    fileName: 'web-file-list.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const tables = model.pages[0]!.blocks.filter((block) => block.kind === 'table')
  assert.equal(tables.length, 1, '网页文件列表必须整体识别为一个表格')
  const table = tables[0]!
  if (table.kind !== 'table') return
  assert.equal(table.rows.length, rows.length)
  assert.deepEqual(table.rows.map((row) => row.cells.length), [3, 3, 3])
  assert.deepEqual(translatableText(model), rows.flat())
  assert.equal(table.columnWidths.every((width) => width > 100), true,
    `三列宽度应由文本分布恢复，实际 ${table.columnWidths.join(',')}`)
})

test('PDF 网页表格完全没有竖线时也必须根据稳定行线识别为三列表格', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.92, 842.88])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const left = 53
  const right = 543
  const rowTops = [330, 372, 414, 456]
  const rows = [
    ['docs', 'Update docs', 'Last month'],
    ['src', 'Refactor parser', 'Last week'],
    ['tests', 'Add coverage', 'Yesterday']
  ]
  rows.forEach((texts, rowIndex) => {
    const y = drawY(rowTops[rowIndex]! + 22)
    page.drawText(texts[0]!, { x: 74, y, size: 10, font })
    page.drawText(texts[1]!, { x: 212, y, size: 10, font })
    page.drawText(texts[2]!, { x: 445, y, size: 10, font })
  })
  // 网页转出的 PDF 可能只保留每行底边，完全没有左右或内部竖线。
  for (const y of rowTops) {
    page.drawLine({ start: { x: left, y: drawY(y) }, end: { x: right, y: drawY(y) }, thickness: 0.72 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/web-row-only-table.pdf',
    fileName: 'web-row-only-table.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  const tables = parsedPage.blocks.filter((block) => block.kind === 'table')
  assert.equal(tables.length, 1, '只有稳定行线的网页表格必须被识别')
  const table = tables[0]!
  if (table.kind !== 'table') return
  assert.deepEqual(table.rows.map((row) => row.cells.length), [3, 3, 3])
  assert.deepEqual(translatableText(model), rows.flat())
  assert.equal(parsedPage.blocks.filter((block) => block.kind === 'shape').length, 0,
    '被表格接管的行线不能再作为独立 shape 下推')
})

test('PDF 无竖线表格的首列长文本不能被列起点中点拆到下一列', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.92, 842.88])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const left = 53
  const right = 543
  const rowTops = [330, 372, 414, 456]
  const longFirstColumn = 'requirements-desktop-verification'
  const rows = [
    [longFirstColumn, 'Main', 'Last month'],
    [longFirstColumn, 'Docs', 'Last week'],
    [longFirstColumn, 'Tests', 'Yesterday']
  ]
  rows.forEach((texts, rowIndex) => {
    const y = drawY(rowTops[rowIndex]! + 22)
    page.drawText(texts[0]!, { x: 74, y, size: 10, font })
    page.drawText(texts[1]!, { x: 212, y, size: 10, font })
    page.drawText(texts[2]!, { x: 445, y, size: 10, font })
  })
  for (const y of rowTops) {
    page.drawLine({ start: { x: left, y: drawY(y) }, end: { x: right, y: drawY(y) }, thickness: 0.72 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/web-row-only-long-first-column.pdf',
    fileName: 'web-row-only-long-first-column.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const table = model.pages[0]!.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind, 'table')
  if (table?.kind !== 'table') return
  assert.deepEqual(table.rows.map((row) => row.cells.length), [3, 3, 3])
  const firstColumnText = table.rows.flatMap((row) => row.cells[0]?.blocks ?? [])
    .filter((block) => block.kind === 'text')
    .map((block) => block.kind === 'text' ? block.runs.map((run) => run.text).join('') : '')
  assert.deepEqual(firstColumnText, [longFirstColumn, longFirstColumn, longFirstColumn],
    '首列长文本必须完整留在第一列')
})

test('PDF 网页表格每行由多段横线组成时也必须恢复列边界', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.92, 842.88])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const columnBoundaries = [51, 252, 452, 552]
  const rowTops = [608, 649, 690, 731]
  const rows = [
    ['name', 'description', 'updated'],
    ['alpha', 'first package', 'today'],
    ['beta', 'second package', 'yesterday']
  ]
  rows.forEach((texts, rowIndex) => {
    const y = drawY(rowTops[rowIndex]! + 22)
    page.drawText(texts[0]!, { x: 61, y, size: 10, font })
    page.drawText(texts[1]!, { x: 262, y, size: 10, font })
    page.drawText(texts[2]!, { x: 462, y, size: 10, font })
  })
  // 真实网页表格会为每个单元格绘制一段横向底边，线段端点就是列边界。
  for (const y of rowTops) {
    for (let index = 0; index < columnBoundaries.length - 1; index += 1) {
      page.drawLine({
        start: { x: columnBoundaries[index]!, y: drawY(y) },
        end: { x: columnBoundaries[index + 1]!, y: drawY(y) },
        thickness: 0.72
      })
    }
  }
  page.drawLine({ start: { x: columnBoundaries[0]!, y: drawY(rowTops[0]!) }, end: { x: columnBoundaries[0]!, y: drawY(rowTops[rowTops.length - 1]!) }, thickness: 0.72 })
  page.drawLine({ start: { x: columnBoundaries[columnBoundaries.length - 1]!, y: drawY(rowTops[0]!) }, end: { x: columnBoundaries[columnBoundaries.length - 1]!, y: drawY(rowTops[rowTops.length - 1]!) }, thickness: 0.72 })

  const model = await parsePdfDocument({
    path: '/tmp/web-segmented-table.pdf',
    fileName: 'web-segmented-table.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const tables = model.pages[0]!.blocks.filter((block) => block.kind === 'table')
  assert.equal(tables.length, 1, '分段横线表格必须整体识别为一个表格')
  const table = tables[0]!
  if (table.kind !== 'table') return
  assert.deepEqual(table.rows.map((row) => row.cells.length), [3, 3, 3])
  assert.deepEqual(translatableText(model), rows.flat())
  assert.equal(model.pages[0]!.blocks.filter((block) => block.kind === 'shape').length, 0,
    '表格内部横线不能继续作为独立 shape 下推')
})

test('PDF 非闭合代码框的细长填充矩形应保留为独立边框线', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawText('public static void main(String[] args) {', { x: 96, y: 700, size: 9, font })
  // 真实 PDF 会直接把单个 rectangle 路径填充成细线，而不是拆成 moveTo/lineTo 子路径。
  for (const [x, y, width, height] of [
    [89, 660, 428, 0.72],
    [89, 660, 0.72, 50],
    [516.28, 660, 0.72, 50]
  ]) {
    page.pushOperators(
      pushGraphicsState(),
      setFillingRgbColor(0.81, 0.81, 0.81),
      rectangle(x!, y!, width!, height!),
      fill(),
      popGraphicsState()
    )
  }

  const model = await parsePdfDocument({
    path: '/tmp/filled-code-frame.pdf',
    fileName: 'filled-code-frame.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const shapes = model.pages[0]!.blocks.filter((block) => block.kind === 'shape')
  assert.equal(shapes.length, 3)
  assert.equal(shapes.filter((block) => block.kind === 'shape' &&
    block.line?.orientation === 'horizontal').length, 1)
  assert.equal(shapes.filter((block) => block.kind === 'shape' &&
    block.line?.orientation === 'vertical').length, 2)
  assert.equal(shapes.every((block) => block.kind === 'shape' &&
    block.line?.color === '#cfcfcf'), true)
})

test('PDF 代码区域的多行填充线不能被合并成单列表格', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Courier)
  const codeLines = [
    'packet.metadata(Const.Meta.CUSTOM_DATA, en.getValue());',
    'final HTTPAgent agent = new HTTPAgent("http://192.168.31.5:9");',
    'agent.setConnectionTimeout(3000);'
  ]
  codeLines.forEach((line, index) => {
    page.drawText(line, { x: 102, y: 700 - index * 19, size: 9, font })
  })
  const borderColor = rgb(0.81, 0.81, 0.81)
  // 复现真实 PDF 的代码框：每行都有左右短边线，顶部与底部各有一条横线，
  // 内部没有列分隔线。若按普通网格识别，会错误生成一列表格并吞掉代码框边界。
  const rowBottoms = [694, 675, 656]
  for (const bottom of rowBottoms) {
    page.drawRectangle({ x: 89.14, y: bottom, width: 0.72, height: 19, color: borderColor })
    page.drawRectangle({ x: 517.29, y: bottom, width: 0.72, height: 19, color: borderColor })
  }
  for (const y of [713, 694, 675, 656]) {
    page.drawRectangle({ x: 89.14, y, width: 428.87, height: 0.72, color: borderColor })
  }

  const model = await parsePdfDocument({
    path: '/tmp/filled-multiline-code-frame.pdf',
    fileName: 'filled-multiline-code-frame.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'table'), false,
    '代码框不能仅因多行左右边线而被识别为单列表格')
  const codeBlocks = parsedPage.blocks.filter((block) => block.kind === 'text' && block.role === 'code')
  assert.equal(codeBlocks.length, 1, '同一代码框内的连续行必须合并为一个代码区块')
  assert.equal(
    codeBlocks[0]?.kind === 'text' ? codeBlocks[0].runs.map((run) => run.text).join('') : '',
    codeLines.join('\n'),
    '代码区块必须保留原始换行和片段间空格'
  )
  const text = translatableText(model).join('\n')
  for (const line of codeLines) {
    // 代码框内每一行必须原样保留，不能因为相邻代码行被误合并而改变源码内容。
    assert.equal(text.includes(line), true, `代码行必须保留：${line}`)
  }
  assert.deepEqual(codeBlocks[0]?.kind === 'text' ? codeBlocks[0].codeFrame : undefined, {
    x: 89.14,
    y: 128.17999999999998,
    width: 428.87,
    height: 57
  }, '代码文本块必须携带完整代码框边界，供译文边框随内容增长')
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'shape'),
    false, '代码框外框不能继续生成会停留在原页坐标的独立形状')
})

test('PDF 单列代码框即使没有内部横线也必须识别为代码区域', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Courier)
  const codeLines = [
    'public static void main(String[] args) {',
    '  final HTTPAgent agent = new HTTPAgent("http://localhost");',
    '  System.out.println(agent);',
    '}'
  ]
  codeLines.forEach((line, index) => {
    page.drawText(line, { x: 102, y: 700 - index * 19, size: 9, font })
  })
  const borderColor = rgb(0.81, 0.81, 0.81)
  // 真实 PDF 第 82 页只有上下两条完整横线和左右两条完整竖线，没有内部行线。
  page.drawRectangle({ x: 89.14, y: 646, width: 428.87, height: 0.72, color: borderColor })
  page.drawRectangle({ x: 89.14, y: 721, width: 428.87, height: 0.72, color: borderColor })
  page.drawRectangle({ x: 89.14, y: 646, width: 0.72, height: 75, color: borderColor })
  page.drawRectangle({ x: 517.29, y: 646, width: 0.72, height: 75, color: borderColor })

  const model = await parsePdfDocument({
    path: '/tmp/single-column-code-frame.pdf',
    fileName: 'single-column-code-frame.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'table'), false,
    '单列代码框不能被识别为表格')
  const codeBlock = parsedPage.blocks.find((block) => block.kind === 'text' && block.role === 'code')
  assert.equal(codeBlock?.kind, 'text')
  assert.equal(codeBlock?.kind === 'text' ? codeBlock.runs.map((run) => run.text).join('') : '',
    codeLines.join('\n'), '单列代码框必须保留所有源码行')
  assert.deepEqual(codeBlock?.kind === 'text' ? codeBlock.codeFrame : undefined, {
    x: 89.14,
    y: 120.17999999999998,
    width: 428.87,
    height: 75
  }, '单列代码框边界必须附着在代码文本块上')
  assert.equal(parsedPage.blocks.filter((block) => block.kind === 'shape').length, 0,
    '代码框不能再输出会随译文高度错位的独立形状')
})

test('PDF 开放代码容器不能被局部横线误判为单列表格', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Courier)
  const drawY = (y: number): number => page.getHeight() - y
  const left = 89.14
  const right = 517.29
  const codeLines = [
    'public interface Converter {',
    '  String convert(String value);',
    '}'
  ]
  codeLines.forEach((line, index) => {
    page.drawText(line, { x: 102, y: drawY(535 + index * 18), size: 9, font })
  })
  // 复现真实 PDF 第 72、75 页：章节代码容器的左右竖线贯穿页面，
  // 局部横线只是章节分隔，不应把开放容器识别为单列表格。
  page.drawLine({ start: { x: left, y: drawY(82) }, end: { x: left, y: drawY(703) }, thickness: 1 })
  page.drawLine({ start: { x: right, y: drawY(82) }, end: { x: right, y: drawY(703) }, thickness: 1 })
  // 真实 PDF 的顶部横线右端没有精确触达右边线，仍应视为跨页续框的顶边。
  page.drawLine({ start: { x: left + 0.86, y: drawY(81.1) }, end: { x: right - 11.99, y: drawY(81.1) }, thickness: 1 })
  page.drawLine({ start: { x: left, y: drawY(125.75) }, end: { x: right, y: drawY(125.75) }, thickness: 1 })
  page.drawLine({ start: { x: left, y: drawY(496.45) }, end: { x: right, y: drawY(496.45) }, thickness: 1 })
  page.drawLine({ start: { x: left, y: drawY(540.25) }, end: { x: right, y: drawY(540.25) }, thickness: 1 })

  const model = await parsePdfDocument({
    path: '/tmp/open-code-container.pdf',
    fileName: 'open-code-container.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'table'), false,
    '开放代码容器不能被识别为表格')
  const codeBlock = parsedPage.blocks.find((block) => block.kind === 'text' && block.role === 'code')
  assert.equal(codeBlock?.kind, 'text', '开放容器内的代码文本必须保留')
  const longVerticalShapes = parsedPage.blocks.filter((block) => block.kind === 'shape' &&
    block.line?.orientation === 'vertical' && (block.bbox?.height ?? 0) > 400)
  assert.equal(longVerticalShapes.length, 0,
    '开放容器边界不能在译文中残留为长竖线')
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'shape' &&
    block.line?.orientation === 'vertical'), false,
  '开放代码框左右边线即使只有局部高度，也必须完全由代码框边框接管')
})

test('PDF 非等宽但代码符号密集的开放容器必须生成可随译文增长的代码框', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  // 真实接口文档第 72、75 页使用 serif 字体绘制 Java 示例；代码语义只能由符号密度恢复。
  const font = await document.embedFont(StandardFonts.TimesRoman)
  const drawY = (y: number): number => page.getHeight() - y
  const left = 89.14
  const right = 517.29
  const codeLines = [
    'final HTTPAgent agent = new HTTPAgent("http://192.168.31.5:9000/v1/");',
    'Map<String, String> metas = new HashMap<>();',
    'metas.put("Title", "converted");',
    'agent.templateToOFD("template", template, cacheKey, data, out, metas);',
    'agent.close();'
  ]
  codeLines.forEach((line, index) => {
    page.drawText(line, { x: 101.9, y: drawY(456.5 + index * 19.1), size: 9, font })
  })
  page.drawLine({ start: { x: left, y: drawY(82) }, end: { x: left, y: drawY(703) }, thickness: 1 })
  page.drawLine({ start: { x: right, y: drawY(82) }, end: { x: right, y: drawY(703) }, thickness: 1 })
  for (const y of [81.1, 421.4, 446.5, 551.8]) {
    page.drawLine({ start: { x: left, y: drawY(y) }, end: { x: right, y: drawY(y) }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/open-code-serif.pdf',
    fileName: 'open-code-serif.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'table'), false,
    '开放代码容器不能被局部横线识别为表格')
  const codeBlock = parsedPage.blocks.find((block) => block.kind === 'text' && block.role === 'code')
  assert.equal(codeBlock?.kind, 'text', '符号密集的非等宽代码行也必须恢复为代码块')
  if (codeBlock?.kind !== 'text') return
  assert.match(codeBlock.runs.map((run) => run.text).join(''), /HashMap/u)
  assert.deepEqual(codeBlock.codeFrame, {
    x: left,
    y: 81.1,
    width: right - left,
    height: 621.9
  }, '开放代码框必须携带完整容器边界供界面绘制边框')
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'shape' &&
    block.line?.orientation === 'vertical' && (block.bbox?.height ?? 0) > 400), false,
  '开放代码框内部长竖线必须被裁掉')
})

test('PDF 开放代码容器只有成对长竖线时仍必须裁掉残留边框', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Courier)
  const drawY = (y: number): number => page.getHeight() - y
  const left = 89.14
  const right = 517.29
  const codeLines = [
    'public class Converter {',
    '  public void convert() {',
    '    return;',
    '  }',
    '}'
  ]
  codeLines.forEach((line, index) => {
    page.drawText(line, { x: 102, y: drawY(456.5 + index * 19.1), size: 9, font })
  })
  // 复现真实 PDF 第 72 页：代码容器只有左右长竖线，没有可依赖的横线。
  page.drawLine({ start: { x: left, y: drawY(431.3) }, end: { x: left, y: drawY(702.95) }, thickness: 1 })
  page.drawLine({ start: { x: right, y: drawY(431.3) }, end: { x: right, y: drawY(702.95) }, thickness: 1 })

  const model = await parsePdfDocument({
    path: '/tmp/open-code-no-horizontal.pdf',
    fileName: 'open-code-no-horizontal.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  const codeBlock = parsedPage.blocks.find((block) => block.kind === 'text' && block.role === 'code')
  assert.equal(codeBlock?.kind, 'text', '成对长竖线内的连续代码行必须恢复为代码块')
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'shape' &&
    block.line?.orientation === 'vertical'), false,
  '开放代码容器没有横线时也必须裁掉左右长竖线')
})

test('PDF 跨页代码框只剩一行源码时仍必须保留代码框并裁掉独立边线', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Courier)
  const drawY = (y: number): number => page.getHeight() - y
  const left = 89.14
  const right = 517.29
  const codeLines = [
    'public interface Converter {',
    '  String convert(String value);',
    '}'
  ]
  page.drawText('agent.close();', { x: 102, y: drawY(96.76), size: 9, font })
  codeLines.forEach((line, index) => {
    page.drawText(line, { x: 102, y: drawY(535 + index * 18), size: 9, font })
  })
  // 复现真实 PDF 第 75 页：上一页代码框在新页只延续一行源码，且只有顶部横线。
  // 顶部短框必须保持为代码框，不能把左右边线留成页眉形状。
  page.drawLine({ start: { x: left, y: drawY(81.95) }, end: { x: left, y: drawY(125) }, thickness: 1 })
  page.drawLine({ start: { x: right, y: drawY(81.95) }, end: { x: right, y: drawY(125) }, thickness: 1 })
  // 真实 PDF 的顶部横线右端未精确触达右边线，短续框仍必须识别。
  page.drawLine({ start: { x: left + 0.86, y: drawY(81.1) }, end: { x: right - 11.99, y: drawY(81.1) }, thickness: 1 })
  page.drawLine({ start: { x: left + 0.86, y: drawY(81.1) }, end: { x: right, y: drawY(81.1) }, thickness: 1 })
  page.drawLine({ start: { x: left, y: drawY(431.3) }, end: { x: left, y: drawY(702.95) }, thickness: 1 })
  page.drawLine({ start: { x: right, y: drawY(431.3) }, end: { x: right, y: drawY(702.95) }, thickness: 1 })
  page.drawLine({ start: { x: left, y: drawY(496.45) }, end: { x: right, y: drawY(496.45) }, thickness: 1 })
  page.drawLine({ start: { x: left, y: drawY(540.25) }, end: { x: right, y: drawY(540.25) }, thickness: 1 })

  const model = await parsePdfDocument({
    path: '/tmp/open-code-continuation.pdf',
    fileName: 'open-code-continuation.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  const codeBlocks = parsedPage.blocks.filter((block) => block.kind === 'text' && block.role === 'code')
  assert.equal(codeBlocks.length, 2, '跨页单行代码框和下方主体代码框都必须保留')
  const continuationBlock = codeBlocks.find((block) => block.kind === 'text' &&
    block.runs.map((run) => run.text).join('').includes('agent.close();'))
  assert.equal(continuationBlock?.kind, 'text', '跨页代码框内的单行源码必须保留')
  assert.deepEqual(continuationBlock?.kind === 'text' ? continuationBlock.codeFrame : undefined, {
    x: left,
    y: 81.1,
    width: right - left,
    height: 43.9
  }, '跨页单行代码框必须携带完整外框')
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'shape' &&
    block.line?.orientation === 'vertical'), false,
  '跨页代码框的左右边线必须由代码框边框接管')
})

test('PDF 等宽字体的普通多列表格不能被开放代码容器误吞', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Courier)
  const drawY = (y: number): number => page.getHeight() - y
  const left = 89.14
  const right = 517.29
  const columnX = [left, 230, right]
  const rowY = [120, 160, 200, 240]
  const cells = [
    ['Method', 'Description'],
    ['GET', '/api/users'],
    ['POST', '/api/users'],
    ['DELETE', '/api/users/{id}']
  ]
  cells.forEach((row, rowIndex) => {
    page.drawText(row[0]!, { x: columnX[0]! + 12, y: drawY(rowY[rowIndex]! + 25), size: 10, font })
    page.drawText(row[1]!, { x: columnX[1]! + 12, y: drawY(rowY[rowIndex]! + 25), size: 10, font })
  })
  for (const y of rowY) {
    page.drawLine({ start: { x: left, y: drawY(y) }, end: { x: right, y: drawY(y) }, thickness: 1 })
  }
  for (const x of columnX) {
    page.drawLine({ start: { x, y: drawY(rowY[0]!) }, end: { x, y: drawY(rowY[rowY.length - 1]!) }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/monospace-table.pdf',
    fileName: 'monospace-table.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  const table = parsedPage.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind, 'table', '带内部列分隔的等宽字体表格必须保留为表格')
  if (table?.kind !== 'table') return
  assert.equal(table.rows.length >= 3, true, '表格必须保留主要数据行')
  assert.equal(table.rows.every((row) => row.cells.length === 2), true)
  assert.equal(translatableText(model).some((text) => text.includes('/api/users/{id}')), true,
    '表格单元格内容不能被开放代码容器吞掉')
})

test('PDF 表头上方同列竖线必须随表格一起裁剪', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const left = 109.96
  const right = 485.34
  const columns = [left, 210.4, 321.2, right]
  const tableTop = 111.29
  const tableBottom = 250
  page.drawText('Name', { x: 120, y: drawY(140), size: 10, font })
  page.drawText('Value', { x: 330, y: drawY(140), size: 10, font })
  page.drawText('Row', { x: 120, y: drawY(190), size: 10, font })
  for (const y of [tableTop, 180, tableBottom]) {
    page.drawLine({ start: { x: left, y: drawY(y) }, end: { x: right, y: drawY(y) }, thickness: 1 })
  }
  // 真实 PDF 第 78 页的列分隔线从表头内容上方开始，表格闭合区却从表头下缘开始。
  for (const x of columns) {
    page.drawLine({ start: { x, y: drawY(81.95) }, end: { x, y: drawY(tableBottom) }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/table-header-overhang.pdf',
    fileName: 'table-header-overhang.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  const table = parsedPage.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind, 'table', '表头与数据区必须保留为完整表格')
  const overhangShapes = parsedPage.blocks.filter((block) => block.kind === 'shape' &&
    block.line?.orientation === 'vertical' &&
    (block.bbox?.y ?? Number.POSITIVE_INFINITY) < tableTop - 2 &&
    (block.bbox?.y ?? 0) + (block.bbox?.height ?? 0) > tableTop)
  assert.equal(overhangShapes.length, 0,
    '与表格列边界对齐的表头上方竖线不能残留为独立形状')
})

test('PDF 表头位于闭合数据区上方时横竖线必须整体并入表格', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const headerLeft = 110.2
  const headerRight = 485.1
  const tableLeft = 109.96
  const tableRight = 485.34
  const headerTop = 81.1
  const headerBottom = 111.29
  const tableBottom = 250
  const columns = [headerLeft, 210.4, 321.2, headerRight]
  page.drawText('Name', { x: 120, y: drawY(97), size: 10, font })
  page.drawText('Type', { x: 220, y: drawY(97), size: 10, font })
  page.drawText('Description', { x: 330, y: drawY(97), size: 10, font })
  page.drawText('Value', { x: 400, y: drawY(97), size: 10, font })
  page.drawText('Row', { x: 120, y: drawY(180), size: 10, font })
  // 复现真实 PDF 第 78 页：表头上下横线比数据区更宽，列竖线从表头顶部
  // 延伸到页底，而闭合数据网格从表头下缘才开始。
  page.drawLine({ start: { x: 90, y: drawY(headerTop) }, end: { x: 505.3, y: drawY(headerTop) }, thickness: 1 })
  page.drawLine({ start: { x: tableLeft, y: drawY(headerBottom) }, end: { x: tableRight, y: drawY(headerBottom) }, thickness: 1 })
  page.drawLine({ start: { x: tableLeft, y: drawY(180) }, end: { x: tableRight, y: drawY(180) }, thickness: 1 })
  page.drawLine({ start: { x: tableLeft, y: drawY(tableBottom) }, end: { x: tableRight, y: drawY(tableBottom) }, thickness: 1 })
  for (const x of columns) {
    page.drawLine({ start: { x, y: drawY(headerTop + 0.85) }, end: { x, y: drawY(tableBottom) }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/table-header-overhang-real-layout.pdf',
    fileName: 'table-header-overhang-real-layout.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  const table = parsedPage.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind, 'table', '表头与数据区必须保留为完整表格')
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'shape'), false,
    '表头横竖线必须由表格边框绘制，不能作为独立形状错位下推')
  assert.equal(translatableText(model).some((text) => text.includes('Description')), true,
    '表头文本必须进入表格单元格')
})

test('PDF 表头列竖线只覆盖表头高度时仍必须并入数据表格', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const headerLeft = 110.2
  const headerRight = 485.1
  const tableLeft = 109.96
  const tableRight = 485.34
  const headerTop = 81.1
  const headerBottom = 111.29
  const dataTop = 149.89
  const dataBottom = 237.09
  const columns = [headerLeft, 210.4, 321.2, headerRight]
  page.drawText('Name', { x: 120, y: drawY(97), size: 10, font })
  page.drawText('Type', { x: 220, y: drawY(97), size: 10, font })
  page.drawText('Description', { x: 330, y: drawY(97), size: 10, font })
  page.drawText('Value', { x: 400, y: drawY(97), size: 10, font })
  page.drawText('first', { x: 120, y: drawY(175), size: 10, font })
  page.drawText('second', { x: 120, y: drawY(215), size: 10, font })
  // 复现真实 PDF 第 78 页：表头竖线只覆盖 81.95..111.05，
  // 与数据区 149.89 的顶边之间有明显空白，不能因此丢失表头。
  page.drawLine({ start: { x: 90, y: drawY(headerTop) }, end: { x: 505.3, y: drawY(headerTop) }, thickness: 1 })
  page.drawLine({ start: { x: tableLeft, y: drawY(headerBottom) }, end: { x: tableRight, y: drawY(headerBottom) }, thickness: 1 })
  for (const y of [dataTop, 178.94, 208.04, dataBottom]) {
    page.drawLine({ start: { x: tableLeft, y: drawY(y) }, end: { x: tableRight, y: drawY(y) }, thickness: 1 })
  }
  for (const x of columns) {
    page.drawLine({ start: { x, y: drawY(81.95) }, end: { x, y: drawY(111.05) }, thickness: 1 })
    page.drawLine({ start: { x, y: drawY(dataTop) }, end: { x, y: drawY(dataBottom) }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/table-header-partial-verticals.pdf',
    fileName: 'table-header-partial-verticals.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  const table = parsedPage.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind, 'table', '表头必须与数据区合并为同一张表')
  if (table?.kind !== 'table') return
  assert.equal(table.rows.length, 3, '表头和两行数据之间不能生成空白行')
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'shape'), false,
    '表头横竖线必须由表格边框绘制，不能残留为独立形状')
})

test('PDF 表头与数据区存在空白间隔时必须使用稀疏行带保留表头且不生成空行', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const headerLeft = 110.2
  const headerRight = 485.1
  const tableLeft = 109.96
  const tableRight = 485.34
  const headerTop = 81.1
  const headerBottom = 111.29
  const dataTop = 149.89
  const dataBottom = 237.09
  const columns = [headerLeft, 210.4, 321.2, headerRight]
  page.drawText('Name', { x: 120, y: drawY(97), size: 10, font })
  page.drawText('Type', { x: 220, y: drawY(97), size: 10, font })
  page.drawText('Description', { x: 330, y: drawY(97), size: 10, font })
  page.drawText('Value', { x: 400, y: drawY(97), size: 10, font })
  page.drawText('first', { x: 120, y: drawY(175), size: 10, font })
  page.drawText('second', { x: 120, y: drawY(215), size: 10, font })
  page.drawLine({ start: { x: 90, y: drawY(headerTop) }, end: { x: 505.3, y: drawY(headerTop) }, thickness: 1 })
  page.drawLine({ start: { x: tableLeft, y: drawY(headerBottom) }, end: { x: tableRight, y: drawY(headerBottom) }, thickness: 1 })
  for (const y of [dataTop, 178.94, 208.04, dataBottom]) {
    page.drawLine({ start: { x: tableLeft, y: drawY(y) }, end: { x: tableRight, y: drawY(y) }, thickness: 1 })
  }
  for (const x of columns) {
    page.drawLine({ start: { x, y: drawY(headerTop + 0.85) }, end: { x, y: drawY(dataBottom) }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/table-header-sparse-bands.pdf',
    fileName: 'table-header-sparse-bands.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  const table = parsedPage.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind, 'table', '表头与数据区必须保留为同一张表')
  if (table?.kind !== 'table') return
  assert.equal(table.rows.length, 3, '表头与两行数据之间不能生成空白行')
  assert.equal(table.headerRows, 1)
  assert.equal(table.rows[0]?.cells.some((cell) => cell.blocks.some((block) =>
    block.kind === 'text' && block.runs.some((run) => run.text.includes('Description')))), true,
  '表头文本必须位于表头行')
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'shape'), false,
    '表头横竖线必须由表格边框绘制')
})

test('PDF 分隔线 bbox 必须从原始线条位置开始，不能向左上偏移半个线宽', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawText('Section title', { x: 72, y: 700, size: 16, font })
  page.drawLine({ start: { x: 72, y: 680 }, end: { x: 528, y: 680 }, thickness: 2 })

  const model = await parsePdfDocument({
    path: '/tmp/divider-position.pdf',
    fileName: 'divider-position.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const divider = model.pages[0]!.blocks.find((block) => block.kind === 'shape')
  assert.equal(divider?.kind, 'shape')
  if (divider?.kind !== 'shape') return
  assert.ok(Math.abs((divider.bbox?.x ?? 0) - 72) <= 0.05, '水平线必须从原始 x 起点开始')
  assert.ok(Math.abs((divider.bbox?.y ?? 0) - 120) <= 0.05, '水平线必须从原始 y 起点开始')
})

test('PDF 表格内嵌图片必须归属单元格并避免页面级重复输出', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64'
  )
  const image = await document.embedPng(png)
  const drawY = (y: number): number => page.getHeight() - y
  page.drawText('Certificate', { x: 82, y: drawY(105), size: 12, font })
  page.drawText('Barcode', { x: 310, y: drawY(105), size: 12, font })
  page.drawImage(image, { x: 360, y: drawY(150), width: 80, height: 40 })
  for (const y of [70, 130, 190]) {
    page.drawLine({ start: { x: 72, y: drawY(y) }, end: { x: 528, y: drawY(y) }, thickness: 1 })
  }
  for (const x of [72, 300, 528]) {
    page.drawLine({ start: { x, y: drawY(190) }, end: { x, y: drawY(70) }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/table-image.pdf',
    fileName: 'table-image.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderEmbeddedImageToImage: async () => new Uint8Array([137, 80, 78, 71, 9, 9])
  })

  const parsedPage = model.pages[0]!
  const table = parsedPage.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind, 'table')
  if (table?.kind !== 'table') return
  const cellImages = table.rows.flatMap((row) => row.cells.flatMap((cell) =>
    cell.blocks.filter((block) => block.kind === 'image')))
  assert.equal(cellImages.length, 1, '表格内图片必须进入所属单元格')
  assert.deepEqual(cellImages[0]?.bbox, { x: 360, y: 110, width: 80, height: 40 },
    '表格图片必须保留原始页面坐标供单元格内相对定位使用')
  assert.equal(table.bbox.x, 72)
  assert.equal(table.bbox.width, 456)
  assert.deepEqual(table.columnWidths, [228, 228])
  assert.deepEqual(table.rows.map((row) => row.cells.length), [2, 2],
    '表格必须保留真实行列结构，单元格边框才能对齐')
  assert.equal(parsedPage.blocks.filter((block) => block.kind === 'image').length, 0,
    '表格内图片不能同时作为页面级区块重复输出')
})

test('PDF 稀疏表头下图片独占无文本行时仍必须归属单元格', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64'
  )
  const image = await document.embedPng(png)
  const drawY = (y: number): number => page.getHeight() - y
  const headerTop = 50
  const headerBottom = 90
  const dataTop = 130
  const dataBottom = 280
  const columns = [72, 300, 528]
  page.drawText('Certificate', { x: 82, y: drawY(70), size: 12, font })
  page.drawText('Barcode', { x: 310, y: drawY(70), size: 12, font })
  page.drawText('first', { x: 82, y: drawY(155), size: 12, font })
  // 图片所在数据行没有任何文本。表头扩展后会产生稀疏行带，旧逻辑会删掉
  // 该行带，导致图片落到表格外并打乱后续横线位置。
  page.drawImage(image, { x: 360, y: drawY(225), width: 80, height: 40 })
  page.drawLine({ start: { x: 60, y: drawY(headerTop) }, end: { x: 540, y: drawY(headerTop) }, thickness: 1 })
  page.drawLine({ start: { x: 72, y: drawY(headerBottom) }, end: { x: 528, y: drawY(headerBottom) }, thickness: 1 })
  for (const y of [dataTop, 180, 230, dataBottom]) {
    page.drawLine({ start: { x: 72, y: drawY(y) }, end: { x: 528, y: drawY(y) }, thickness: 1 })
  }
  for (const x of columns) {
    page.drawLine({ start: { x, y: drawY(headerTop) }, end: { x, y: drawY(headerBottom) }, thickness: 1 })
    page.drawLine({ start: { x, y: drawY(dataTop) }, end: { x, y: drawY(dataBottom) }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/table-image-only-row.pdf',
    fileName: 'table-image-only-row.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderEmbeddedImageToImage: async () => new Uint8Array([137, 80, 78, 71, 9, 9])
  })

  const parsedPage = model.pages[0]!
  const table = parsedPage.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind, 'table')
  if (table?.kind !== 'table') return
  assert.equal(table.rows.length, 3, '表头、文本行和图片行必须完整保留')
  const cellImages = table.rows.flatMap((row, rowIndex) => row.cells.flatMap((cell, cellIndex) =>
    cell.blocks.filter((block) => block.kind === 'image').map((block) => ({ rowIndex, cellIndex, block }))))
  assert.equal(cellImages.length, 1, '独占行的表格图片必须保留在所属单元格')
  assert.equal(cellImages[0]?.rowIndex, 2, '图片必须进入对应的无文本数据行')
  assert.equal(cellImages[0]?.cellIndex, 1, '图片必须进入右侧单元格')
  assert.equal(parsedPage.blocks.filter((block) => block.kind === 'image').length, 0,
    '表格图片不能溢出为页面级图片')
})

test('PDF 仅与表格边缘轻微接触的页眉图片不能被吸入单元格', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64'
  )
  const image = await document.embedPng(png)
  const drawY = (y: number): number => page.getHeight() - y
  page.drawText('Certificate', { x: 82, y: drawY(105), size: 12, font })
  page.drawText('Barcode', { x: 310, y: drawY(105), size: 12, font })
  // 图片中心在表格上方，仅底部 2pt 与表格顶边相触，不能按正面积重叠归入单元格。
  page.drawImage(image, { x: 360, y: drawY(72), width: 80, height: 40 })
  for (const y of [70, 130, 190]) {
    page.drawLine({ start: { x: 72, y: drawY(y) }, end: { x: 528, y: drawY(y) }, thickness: 1 })
  }
  for (const x of [72, 300, 528]) {
    page.drawLine({ start: { x, y: drawY(190) }, end: { x, y: drawY(70) }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/table-image-edge-touch.pdf',
    fileName: 'table-image-edge-touch.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderEmbeddedImageToImage: async () => new Uint8Array([137, 80, 78, 71, 9, 9])
  })

  const parsedPage = model.pages[0]!
  const table = parsedPage.blocks.find((block) => block.kind === 'table')
  assert.equal(table?.kind, 'table')
  if (table?.kind !== 'table') return
  const cellImages = table.rows.flatMap((row) => row.cells.flatMap((cell) =>
    cell.blocks.filter((block) => block.kind === 'image')))
  assert.equal(cellImages.length, 0, '仅边缘接触的图片不能进入表格单元格')
  assert.equal(parsedPage.blocks.filter((block) => block.kind === 'image').length, 1,
    '未归属单元格的页眉图片必须保留为页面级图片')
})

test('PDF 同列但中间存在空白的分段横线不能合并成跨页长线', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  page.drawText('Section A', { x: 72, y: drawY(120), size: 12, font })
  page.drawText('Section B', { x: 72, y: drawY(320), size: 12, font })
  // 两段横线纵坐标一致但横向完全分离，中间空白不能被合并成一条长线。
  page.drawLine({ start: { x: 72, y: drawY(200) }, end: { x: 180, y: drawY(200) }, thickness: 1 })
  page.drawLine({ start: { x: 420, y: drawY(200) }, end: { x: 528, y: drawY(200) }, thickness: 1 })

  const model = await parsePdfDocument({
    path: '/tmp/disjoint-grid-lines.pdf',
    fileName: 'disjoint-grid-lines.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const horizontalShapes = model.pages[0]!.blocks.filter((block) => block.kind === 'shape' &&
    block.line?.orientation === 'horizontal')
  assert.equal(horizontalShapes.length, 2, '中间有空白的横线必须保留为两条独立线段')
  assert.deepEqual(horizontalShapes.map((block) => block.bbox?.width).sort((left, right) => left! - right!),
    [108, 108])
})

test('PDF 页眉横线不能生成与闭合正文表格重叠的幻影表格', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  // WinAnsi 标准字体不能编码中文；该夹具只需要表格行与列证据，
  // 用可编码的英文描述验证幻影表过滤即可。
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const tableLeft = 109.96
  const tableRight = 485.34
  const tableTop = 111.29
  const tableBottom = 710.84
  const columns = [tableLeft, 210.4, 321.2, tableRight]
  const rows = [tableTop, 149.89, 178.94, 208.04, 237.09, 266.19, 295.24, 324.34,
    381.99, 439.64, 468.69, 507.29, 536.39, 565.44, 594.54, 623.59, 652.69, 681.74, tableBottom]
  const cells = [
    ['sealID', 'String', 'Seal identifier'],
    ['text', 'String', 'Watermark text'],
    ['fontName', 'String', 'Watermark font'],
    ['fontSize', 'float', 'Watermark font size'],
    ['color', 'String', 'Watermark color'],
    ['rotate', 'int', 'Rotation angle'],
    ['xAlign', 'Const.XAlign', 'Horizontal alignment'],
    ['yAlign', 'Const.YAlign', 'Vertical alignment'],
    ['tiled', 'boolean', 'Whether tiled']
  ]
  cells.forEach((cell, index) => {
    page.drawText(cell[0]!, { x: 115.6, y: drawY(rows[index]! + 24), size: 9, font })
    page.drawText(cell[1]!, { x: 215.8, y: drawY(rows[index]! + 24), size: 9, font })
    page.drawText(cell[2]!, { x: 326.6, y: drawY(rows[index]! + 24), size: 9, font })
  })
  // 页眉 logo 框的底边与正文首条表线接近，旧逻辑会跨过整段空白生成幻影表格。
  page.drawLine({ start: { x: 90, y: drawY(81.1) }, end: { x: 505.3, y: drawY(81.1) }, thickness: 1 })
  page.drawLine({ start: { x: 90, y: drawY(324.34) }, end: { x: 505.3, y: drawY(324.34) }, thickness: 1 })
  for (const y of rows) {
    page.drawLine({ start: { x: tableLeft, y: drawY(y) }, end: { x: tableRight, y: drawY(y) }, thickness: 1 })
  }
  for (const x of columns) {
    page.drawLine({ start: { x, y: drawY(81.95) }, end: { x, y: drawY(tableBottom) }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/header-phantom-table.pdf',
    fileName: 'header-phantom-table.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const tables = model.pages[0]!.blocks.filter((block) => block.kind === 'table')
  assert.equal(tables.length, 1, '页眉与正文之间只能保留一张真实表格')
  assert.ok(Math.abs((tables[0]?.bbox?.y ?? 0) - tableTop) <= 1,
    '正文表格必须从首条真实表线开始，不能包含页眉区域')
})

test('PDF 表头局部竖线与共享左右边界的相邻网格必须并入完整表格', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const tableLeft = 89.14
  const tableRight = 517.29
  const headerBottom = 111.29
  const tableBottom = 710.84
  page.drawText('Name', { x: 110.2, y: drawY(96), size: 10, font })
  page.drawText('Type', { x: 210.4, y: drawY(96), size: 10, font })
  page.drawText('Description', { x: 321.2, y: drawY(96), size: 10, font })
  page.drawText('Value', { x: 485.1, y: drawY(96), size: 10, font })
  page.drawText('Request body', { x: 110.2, y: drawY(140), size: 10, font })
  // 完整数据表从表头下缘延伸到页底，但左右边线在表头与正文之间短暂断开。
  for (const y of [81.1, headerBottom, 180, 300, 430, tableBottom]) {
    page.drawLine({ start: { x: tableLeft, y: drawY(y) }, end: { x: tableRight, y: drawY(y) }, thickness: 1 })
  }
  page.drawLine({ start: { x: tableLeft, y: drawY(81.1) }, end: { x: tableLeft, y: drawY(headerBottom) }, thickness: 1 })
  page.drawLine({ start: { x: tableRight, y: drawY(81.1) }, end: { x: tableRight, y: drawY(headerBottom) }, thickness: 1 })
  page.drawLine({ start: { x: tableLeft, y: drawY(headerBottom) }, end: { x: tableLeft, y: drawY(tableBottom) }, thickness: 1 })
  page.drawLine({ start: { x: tableRight, y: drawY(headerBottom) }, end: { x: tableRight, y: drawY(tableBottom) }, thickness: 1 })
  for (const x of [210.4, 321.2, 485.1]) {
    page.drawLine({ start: { x, y: drawY(81.1) }, end: { x, y: drawY(headerBottom) }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/adjacent-table-grid.pdf',
    fileName: 'adjacent-table-grid.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  const tables = parsedPage.blocks.filter((block) => block.kind === 'table')
  assert.equal(tables.length, 1, '共享左右边界的表头与数据区必须合并成一个表格')
  const table = tables[0]!
  if (table.kind !== 'table') return
  assert.ok(Math.abs(table.bbox.y - 81.1) <= 1.5, `表格顶部应为表头顶部，实际 ${table.bbox.y}`)
  assert.ok(Math.abs(table.bbox.y + table.bbox.height - tableBottom) <= 1.5,
    `表格底部应为数据区底部，实际 ${table.bbox.y + table.bbox.height}`)
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'shape' &&
    block.line?.orientation === 'vertical'), false,
  '并入表格的表头竖线不能再残留为独立形状')
  assert.equal(translatableText(model).some((text) => text.includes('Request body')), true,
    '合并后的表格仍必须保留正文单元格文本')
})

test('PDF 表格相邻行区间的局部网格必须合并并裁剪内部横线', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const left = 72
  const right = 528
  page.drawText('Header', { x: 82, y: drawY(95), size: 11, font })
  page.drawText('First', { x: 82, y: drawY(145), size: 11, font })
  page.drawText('Second', { x: 82, y: drawY(205), size: 11, font })
  for (const y of [70, 120, 180, 230]) {
    page.drawLine({ start: { x: left, y: drawY(y) }, end: { x: right, y: drawY(y) }, thickness: 1 })
  }
  // 上下两个闭合网格共用一条边界，但中间行线比左右外框稍短。
  for (const y of [70, 120, 180, 230]) {
    page.drawLine({ start: { x: left, y: drawY(y) }, end: { x: right, y: drawY(y) }, thickness: 1 })
  }
  for (const x of [left, right]) {
    page.drawLine({ start: { x, y: drawY(70) }, end: { x, y: drawY(120) }, thickness: 1 })
    page.drawLine({ start: { x, y: drawY(120) }, end: { x, y: drawY(180) }, thickness: 1 })
    page.drawLine({ start: { x, y: drawY(180) }, end: { x, y: drawY(230) }, thickness: 1 })
  }

  const model = await parsePdfDocument({
    path: '/tmp/adjacent-row-grid.pdf',
    fileName: 'adjacent-row-grid.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const parsedPage = model.pages[0]!
  const tables = parsedPage.blocks.filter((block) => block.kind === 'table')
  assert.equal(tables.length, 1, '相邻行区间的局部网格必须合并为一个表格')
  assert.equal(parsedPage.blocks.filter((block) => block.kind === 'shape' &&
    block.line?.orientation === 'horizontal').length, 0,
  '表格内部横线必须由单元格边框绘制，不能再作为 shape 下推')
})

test('PDF 非闭合横线不应误判为表格', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawText('Section title', { x: 72, y: 700, size: 16, font })
  page.drawLine({ start: { x: 72, y: 680 }, end: { x: 528, y: 680 }, thickness: 1 })

  const model = await parsePdfDocument({
    path: '/tmp/divider.pdf',
    fileName: 'divider.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.equal(model.pages[0]!.blocks.some((block) => block.kind === 'table'), false)
  const divider = model.pages[0]!.blocks.find((block) => block.kind === 'shape')
  assert.equal(divider?.kind, 'shape')
  if (divider?.kind === 'shape') {
    assert.deepEqual(divider.line?.orientation, 'horizontal')
    assert.ok(Math.abs((divider.bbox?.width ?? 0) - 456) <= 2)
  }
  assert.deepEqual(translatableText(model), ['Section title'])
})

test('PDF 整页边框内的封面分隔线必须保留，边框自身不能重复输出为形状', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawRectangle({
    x: 1,
    y: 1,
    width: 598,
    height: 798,
    borderWidth: 1
  })
  page.drawText('Product guide', { x: 90, y: 700, size: 16, font })
  page.drawLine({ start: { x: 90, y: 680 }, end: { x: 505.3, y: 680 }, thickness: 0.72 })

  const model = await parsePdfDocument({
    path: '/tmp/page-frame-divider.pdf',
    fileName: 'page-frame-divider.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const shapes = model.pages[0]!.blocks.filter((block) => block.kind === 'shape')
  const horizontal = shapes.filter((block) => block.kind === 'shape' && block.line?.orientation === 'horizontal')
  assert.equal(horizontal.length, 1)
  if (horizontal[0]?.kind === 'shape') {
    assert.ok(Math.abs((horizontal[0].bbox?.x ?? 0) - 90) <= 1)
    assert.ok(Math.abs((horizontal[0].bbox?.width ?? 0) - 415.3) <= 2)
  }
  assert.equal(model.pages[0]!.blocks.some((block) => block.kind === 'table'), false)
})

test('PDF 仅用于裁剪的矩形路径不能被输出为黑色装饰线', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawText('Header content', { x: 370, y: 755, size: 12, font })
  page.pushOperators(
    pushGraphicsState(),
    rectangle(361.6, 732, 149.15, 25.45),
    clipEvenOdd(),
    endPath(),
    popGraphicsState()
  )
  page.pushOperators(
    pushGraphicsState(),
    moveTo(90, 720),
    lineTo(505.3, 720),
    stroke(),
    popGraphicsState()
  )

  const model = await parsePdfDocument({
    path: '/tmp/clip-only-header.pdf',
    fileName: 'clip-only-header.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const shapes = model.pages[0]!.blocks.filter((block) => block.kind === 'shape')
  assert.equal(shapes.length, 1)
  const divider = shapes[0]
  assert.equal(divider?.kind === 'shape' ? divider.line?.orientation : undefined, 'horizontal')
  assert.ok(Math.abs((divider?.bbox?.width ?? 0) - 415.3) <= 2)
  assert.equal(shapes.length, 1)
  assert.ok(Math.abs((divider?.bbox?.x ?? 0) - 90) <= 1)
  assert.ok(Math.abs((divider?.bbox?.y ?? 0) - 79.5) <= 1)
})

test('PDF 顶部小图片与同一视觉行文字必须共享稳定的 flowGroupId', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.HelveticaBold)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64'
  )
  const image = await document.embedPng(png)
  page.drawImage(image, { x: 366.96, y: 738.7, width: 18.6, height: 18.6 })
  page.drawText('Conversion suite', { x: 397.32, y: 744.41, size: 12, font })
  page.drawText('A regular paragraph below the header.', { x: 90, y: 680, size: 12, font })

  const model = await parsePdfDocument({
    path: '/tmp/header-flow-group.pdf',
    fileName: 'header-flow-group.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderEmbeddedImageToImage: async () => new Uint8Array([137, 80, 78, 71, 7, 7])
  })

  const headerBlocks = model.pages[0]!.blocks.filter((block) => (block.bbox?.y ?? 0) < 100)
  assert.deepEqual(headerBlocks.map((block) => block.kind), ['image', 'text'])
  assert.equal(headerBlocks[0]?.flowGroupId, headerBlocks[1]?.flowGroupId)
  assert.ok(headerBlocks[0]?.flowGroupId)
  const paragraph = model.pages[0]!.blocks.find((block) =>
    block.kind === 'text' && block.runs.some((run) => run.text.includes('regular paragraph')))
  assert.equal(paragraph?.flowGroupId, undefined)
})

test('PDF 页眉的单行图片框不能被识别为表格，图片与公司名必须保持同行', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64'
  )
  const image = await document.embedPng(png)
  const drawY = (y: number): number => page.getHeight() - y

  page.drawRectangle({ x: 362.45, y: drawY(67.05), width: 29.5, height: 24.5, borderWidth: 1 })
  page.drawRectangle({ x: 391.9, y: drawY(67.05), width: 118.85, height: 24.5, borderWidth: 1 })
  page.drawImage(image, { x: 367.8, y: drawY(61.2), width: 18.6, height: 18.6 })
  page.drawText('Acme Technology Ltd', { x: 397.32, y: drawY(55.4), size: 9, font })

  const model = await parsePdfDocument({
    path: '/tmp/header-image-box.pdf',
    fileName: 'header-image-box.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderEmbeddedImageToImage: async () => new Uint8Array([137, 80, 78, 71, 7, 7])
  })

  const headerBlocks = model.pages[0]!.blocks.filter((block) => (block.bbox?.y ?? 0) < 70)
  assert.equal(headerBlocks.some((block) => block.kind === 'table'), false)
  const headerImage = headerBlocks.find((block) => block.kind === 'image')
  const companyName = headerBlocks.find((block) =>
    block.kind === 'text' && block.runs.some((run) => run.text.includes('Acme Technology Ltd')))
  assert.equal(headerImage?.kind, 'image')
  assert.equal(companyName?.kind, 'text')
  assert.ok(headerImage?.flowGroupId)
  assert.equal(headerImage?.flowGroupId, companyName?.flowGroupId)
})

test('PDF 原生文本应保留居中、右对齐与字号颜色，避免译文丢失原版式', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.HelveticaBold)
  const page = document.addPage([600, 800])
  const title = 'Centered heading'
  const titleSize = 28
  const titleWidth = font.widthOfTextAtSize(title, titleSize)
  page.drawText(title, {
    x: (600 - titleWidth) / 2,
    y: 700,
    size: titleSize,
    font,
    color: { type: 'RGB', red: 0.1, green: 0.2, blue: 0.3 } as never
  })
  const footer = 'Right aligned footer'
  const footerSize = 14
  const footerWidth = font.widthOfTextAtSize(footer, footerSize)
  page.drawText(footer, { x: 600 - 72 - footerWidth, y: 80, size: footerSize, font })

  const model = await parsePdfDocument({
    path: '/tmp/aligned.pdf',
    fileName: 'aligned.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  const heading = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes(title))
  const footerBlock = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes(footer))
  assert.equal(heading?.kind === 'text' ? heading.textAlign : undefined, 'center')
  assert.equal(footerBlock?.kind === 'text' ? footerBlock.textAlign : undefined, 'right')
  const headingFontSize = heading?.kind === 'text' ? heading.runs[0]?.style?.fontSize ?? 0 : 0
  assert.ok(Math.abs(headingFontSize - titleSize) < 1)
  assert.equal(heading?.kind === 'text' ? heading.runs[0]?.style?.color : undefined, '#1a334c')
})

test('PDF 行高应来自相邻行基线推进，且大段间距不能被误当成行内行高', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const size = 12
  page.drawText('First body line', { x: 72, y: 700, size, font })
  page.drawText('Second body line', { x: 72, y: 686, size, font })
  page.drawText('Third body line', { x: 72, y: 672, size, font })
  page.drawText('Next paragraph', { x: 72, y: 620, size, font })

  const model = await parsePdfDocument({
    path: '/tmp/line-height.pdf',
    fileName: 'line-height.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  const paragraph = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes('First body line'))
  const nextParagraph = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('') === 'Next paragraph')
  assert.ok(paragraph?.kind === 'text' && nextParagraph?.kind === 'text')
  assert.equal(paragraph.runs.map((run) => run.text).join(''), 'First body line Second body line Third body line')
  assert.equal(paragraph.runs.every((run) => Math.abs((run.style?.lineHeight ?? 0) - 14) < 1), true)
  // 段后最后一行没有可靠的下一条正文基线，不应把段间距写入行高。
  assert.equal(nextParagraph.runs[0]?.style?.lineHeight, undefined)

  const spacedDocument = await PDFDocument.create()
  const spacedFont = await spacedDocument.embedFont(StandardFonts.Helvetica)
  const spacedPage = spacedDocument.addPage([600, 800])
  // 真实样例：12pt 宋体正文相邻基线推进约 28.56pt，必须识别为正文行高而不是段间距。
  spacedPage.drawText('Wide line height first line', { x: 72, y: 700, size, font: spacedFont })
  spacedPage.drawText('Wide line height second line', { x: 72, y: 671.44, size, font: spacedFont })
  spacedPage.drawText('Wide line height third line', { x: 72, y: 642.88, size, font: spacedFont })
  // 70pt 以上的跳跃仍属于段间距，不能成为行高。
  spacedPage.drawText('Spaced paragraph after wide body lines', { x: 72, y: 570, size, font: spacedFont })
  const spacedModel = await parsePdfDocument({
    path: '/tmp/wide-line-height.pdf',
    fileName: 'wide-line-height.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await spacedDocument.save()
  })
  const spacedBlocks = spacedModel.pages[0]!.blocks.filter((block) => block.kind === 'text')
  const wideParagraph = spacedBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes('Wide line height first line'))
  const spacedParagraph = spacedBlocks.find((block) => block.kind === 'text' && block.runs[0]?.text === 'Spaced paragraph after wide body lines')
  assert.ok(wideParagraph?.kind === 'text' && spacedParagraph?.kind === 'text')
  assert.equal(wideParagraph.runs.every((run) => Math.abs((run.style?.lineHeight ?? 0) - 28.56) < 0.2), true)
  assert.equal(spacedParagraph.runs[0]?.style?.lineHeight, undefined)
})

test('PDF 12pt 居中图注应识别居中，而正文左边界上的短行必须保持左对齐', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const bodyLines = [
    'This body line establishes a stable left content boundary for the page.',
    'Another body line keeps the left content boundary consistent.',
    'A third body line makes the body layout representative.',
    'A fourth body line avoids a one-off layout estimate.'
  ]
  bodyLines.forEach((line, index) => {
    page.drawText(line, { x: 90, y: 700 - index * 20, size: 12, font })
  })
  const caption = 'Figure 1. Device deployment overview'
  const captionSize = 12
  const captionWidth = font.widthOfTextAtSize(caption, captionSize)
  page.drawText(caption, {
    x: (600 - captionWidth) / 2,
    y: 580,
    size: captionSize,
    font
  })
  page.drawText('Short left note', { x: 90, y: 540, size: 12, font })

  const model = await parsePdfDocument({
    path: '/tmp/caption-alignment.pdf',
    fileName: 'caption-alignment.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  const captionBlock = textBlocks.find((block) => block.kind === 'text' && block.runs[0]?.text === caption)
  const shortBlock = textBlocks.find((block) => block.kind === 'text' && block.runs[0]?.text === 'Short left note')
  assert.equal(captionBlock?.kind === 'text' ? captionBlock.textAlign : undefined, 'center')
  assert.equal(shortBlock?.kind === 'text' ? shortBlock.textAlign : undefined, undefined)
})

test('PDF 宽标题居中时仍应识别对齐，而正文左对齐不能误判为居中', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.HelveticaBold)
  const page = document.addPage([600, 800])
  const title = 'Centered document heading with full width styling'
  const titleSize = 21
  const titleWidth = font.widthOfTextAtSize(title, titleSize)
  page.drawText(title, {
    x: (600 - titleWidth) / 2,
    y: 720,
    size: titleSize,
    font
  })
  const body = 'Left aligned body text that reaches the right content boundary without being centered and continues far enough to validate the full-width guard.'
  const bodySize = 12
  const bodyWidth = font.widthOfTextAtSize(body, bodySize)
  page.drawText(body, { x: 72, y: 680, size: bodySize, font })

  const model = await parsePdfDocument({
    path: '/tmp/wide-alignment.pdf',
    fileName: 'wide-alignment.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.ok(titleWidth > 600 * 0.82, `fixture title width ${titleWidth} should exceed the old threshold`)
  assert.ok(bodyWidth > 600 * 0.82, `fixture body width ${bodyWidth} should exceed the old threshold`)
  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  const titleBlock = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes(title))
  const bodyBlock = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes(body))
  assert.equal(titleBlock?.kind === 'text' ? titleBlock.textAlign : undefined, 'center')
  assert.equal(bodyBlock?.kind === 'text' ? bodyBlock.textAlign : undefined, undefined)
})

test('PDF 解析应持久化正文区右边界，供译文保留与原文一致的右侧页边距', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const contentLeft = 72
  const contentRight = 528
  const size = 12
  const lines = [
    'This body line reaches the right content boundary.',
    'Another body line keeps the content area stable.',
    'A third body line establishes the page layout.',
    'The final body line keeps the right margin visible.'
  ]
  lines.forEach((line, index) => {
    const width = font.widthOfTextAtSize(line, size)
    page.drawText(line, { x: contentLeft, y: 700 - index * 24, size, font })
    // 补齐正文行到同一右边界，模拟正常 PDF 中稳定的左右页边距。
    if (index < lines.length - 1) {
      page.drawText('.', { x: contentRight - font.widthOfTextAtSize('.', size), y: 700 - index * 24, size, font })
    }
    assert.ok(width > 0)
  })

  const model = await parsePdfDocument({
    path: '/tmp/content-area.pdf',
    fileName: 'content-area.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.ok(model.pages[0]!.contentArea)
  assert.ok(Math.abs(model.pages[0]!.contentArea!.left - contentLeft) <= 2)
  assert.ok(Math.abs(model.pages[0]!.contentArea!.right - contentRight) <= 2)
  assert.ok(model.pages[0]!.contentArea!.right < model.pages[0]!.width)
})

test('PDF 正文行右边界不齐时应按正文最大右边界推断内容区，避免左对齐标题提前换行', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([595.3, 841.9])
  const contentLeft = 90
  const contentRight = 505.27
  const size = 12
  const bodyLines = [
    'The first body line has a naturally shorter right edge.',
    'Another body line ends at a slightly different horizontal position.',
    'A third body line establishes the actual body content area.',
    'The final body line is short without reaching the content boundary.'
  ]
  bodyLines.forEach((line, index) => {
    page.drawText(line, { x: index === 1 ? 72 : contentLeft, y: 700 - index * 31.2, size, font })
  })
  // 模拟真实 PDF 中仅由个别正文行触及右侧内容边界，其他行均自然短于该边界。
  const boundaryText = 'The first body line has a naturally shorter right edge'
  page.drawText(boundaryText, { x: contentLeft, y: 700, size, font })
  page.drawText('.', {
    x: contentRight - font.widthOfTextAtSize('.', size),
    y: 700,
    size,
    font,
    // 正文末行保留一个空格，使 PDF.js 不会把紧邻右边界的小句点合并到标题段落。
    wordBreaks: [boundaryText.length]
  })
  const title = 'June 2026 blueberry price guide'
  page.drawText(title, { x: contentLeft, y: 780, size, font })
  assert.ok(font.widthOfTextAtSize(boundaryText, size) < contentRight - contentLeft)

  const model = await parsePdfDocument({
    path: '/tmp/variable-content-right.pdf',
    fileName: 'variable-content-right.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.ok(model.pages[0]!.contentArea)
  assert.ok(Math.abs(model.pages[0]!.contentArea!.left - contentLeft) <= 2)
  assert.ok(Math.abs(model.pages[0]!.contentArea!.right - contentRight) <= 2)
  assert.ok(model.pages[0]!.contentArea!.right < model.pages[0]!.width)
  const titleBlock = model.pages[0]!.blocks.find((block) =>
    block.kind === 'text' && block.runs.map((run) => run.text).join('') === title)
  assert.equal(titleBlock?.kind === 'text' ? titleBlock.textAlign : undefined, undefined)
  assert.ok((titleBlock?.bbox?.width ?? 0) < contentRight - contentLeft)
})

test('PDF 接近整页的页面边框不能被识别为表格，封面文字仍应保持文本区块', async () => {
  const document = await PDFDocument.create()
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const page = document.addPage([595.3, 841.9])
  // 模拟办公软件导出的整页边框，它只是页面装饰，不是包含行列数据的表格。
  page.drawRectangle({
    x: 0.5,
    y: 0.5,
    width: 594.3,
    height: 840.9,
    borderWidth: 1
  })
  page.drawText('Product conversion suite', { x: 90, y: 760, size: 22, font: bold })
  page.drawText('User guide', { x: 90, y: 710, size: 22, font: bold })
  page.drawText('Version 1.0', { x: 90, y: 680, size: 12, font: regular })

  const model = await parsePdfDocument({
    path: '/tmp/page-frame.pdf',
    fileName: 'page-frame.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.equal(model.pages[0]!.blocks.some((block) => block.kind === 'table'), false)
  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  assert.deepEqual(
    textBlocks.map((block) => block.kind === 'text' ? block.runs.map((run) => run.text).join('') : ''),
    ['Product conversion suite User guide', 'Version 1.0']
  )
  // 页面坐标自顶部向下；封面文字位于页面上半部，不能被整页表格压到页面底部。
  assert.ok(textBlocks.every((block) => (block.bbox?.y ?? Number.POSITIVE_INFINITY) < 300))
})

test('PDF 正文尺寸的近整行缩进文本不能仅因中心接近内容区中线而误判居中', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([595.28, 841.89])
  const contentLeft = 111
  const contentRight = 505.32
  const bodyLines = [
    'A stable body line establishes a content boundary and keeps the body font size.',
    'Another stable body line establishes a content boundary and keeps the body size.',
    'A third stable body line establishes a content boundary and keeps the body size.'
  ]
  bodyLines.forEach((line, index) => {
    page.drawText(line, { x: contentLeft, y: 740 - index * 28, size: 12, font })
  })

  const bodyText = 'WindowsServer series: 64-bit operating system, 2012 or later.'
  const bodyWidth = font.widthOfTextAtSize(bodyText, 12)
  // 模拟真实 PDF 中左侧缩进、右侧未顶满的正文行：其中心接近内容区中线，但并非居中排版。
  const bodyX = (contentLeft + contentRight) / 2 - bodyWidth / 2
  page.drawText(bodyText, { x: bodyX, y: 640, size: 12, font })

  const model = await parsePdfDocument({
    path: '/tmp/indented-body-alignment.pdf',
    fileName: 'indented-body-alignment.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  const bodyBlock = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes(bodyText))
  assert.ok(bodyBlock?.kind === 'text')
  assert.ok(Math.abs(bodyBlock.bbox!.width - bodyWidth) < 2)
  assert.equal(bodyBlock?.kind === 'text' ? bodyBlock.textAlign : undefined, undefined)
})

test('PDF 普通正文应按段落合并视觉行，不能逐行翻译导致句子截断', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const lines = [
    'By default, the product uses its own Tomcat container, which can be started',
    'independently and provide services. This chapter is mainly described in',
    'Deployment process under middleware, such as TongWeb, Tomcat, Kingdee,',
    'etc. This document uses TongWeb as an example.',
    'Other middleware processes are basically the same.'
  ]
  const size = 12
  // 模拟真实 PDF 的缩进续行：首行从 111pt 开始，后续行从 90pt 开始，短尾行保持左对齐。
  lines.forEach((line, index) => {
    page.drawText(line, {
      x: index === 0 ? 111 : 90,
      y: 700 - index * 28,
      size,
      font
    })
  })

  const model = await parsePdfDocument({
    path: '/tmp/left-aligned-body.pdf',
    fileName: 'left-aligned-body.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  assert.equal(textBlocks.length, 1)
  assert.deepEqual(translatableText(model), [lines.join(' ')])
  assert.equal(textBlocks[0]?.kind === 'text' ? textBlocks[0].textAlign : 'center', undefined)
  assert.equal(textBlocks[0]?.kind === 'text' ? textBlocks[0].runs.length : 0, lines.length)
})

test('PDF 同一段落中的字体子集变化不能阻止视觉行合并', async () => {
  const document = await PDFDocument.create()
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const page = document.addPage([600, 800])
  const leadingValue = '20-40'
  const firstLine = ' yuan per jin is the lowest seasonal price and'
  const secondLine = 'continues into the next visual line without a paragraph break.'

  // 真实 PDF 常把行首数字与强调片段拆成不同子集字体；首个片段不能代表整行主样式。
  page.drawText(leadingValue, { x: 90, y: 700, size: 12, font: bold })
  page.drawText(firstLine, {
    x: 90 + bold.widthOfTextAtSize(leadingValue, 12),
    y: 700,
    size: 12,
    font: regular
  })
  page.drawText(secondLine, { x: 90, y: 672, size: 12, font: regular })

  const model = await parsePdfDocument({
    path: '/tmp/pdf-subset-font-paragraph.pdf',
    fileName: 'pdf-subset-font-paragraph.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const texts = translatableText(model)
  assert.equal(texts.length, 1)
  assert.equal(texts[0]?.replace(/\s+/gu, '').startsWith('20-40yuanperjin'), true, JSON.stringify(texts))
  assert.equal(texts[0]?.includes(secondLine), true)
})

test('PDF 同一段落内颜色碎片交错不能拆开视觉续行', async () => {
  const document = await PDFDocument.create()
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const gray = rgb(0.35, 0.39, 0.43)
  const dark = rgb(0.12, 0.14, 0.16)
  const left = 90
  const firstGray = 'The first visual line is mostly gray and'
  const firstDark = ' a short dark tail.'
  const secondDark = 'The second visual line is mostly dark and'
  const secondGray = ' a short gray tail.'

  // 网页导出的 PDF 会把同一段落内不同片段渲染成不同颜色；两行各含两种颜色，
  // 但主导色在相邻行正好相反，严格的颜色比较会把正常的视觉续行误判为新段落。
  page.drawText(firstGray, { x: left, y: 700, size: 12, font: regular, color: gray })
  page.drawText(firstDark, {
    x: left + regular.widthOfTextAtSize(firstGray, 12),
    y: 700,
    size: 12,
    font: regular,
    color: dark
  })
  page.drawText(secondDark, { x: left, y: 672, size: 12, font: regular, color: dark })
  page.drawText(secondGray, {
    x: left + regular.widthOfTextAtSize(secondDark, 12),
    y: 672,
    size: 12,
    font: regular,
    color: gray
  })

  const model = await parsePdfDocument({
    path: '/tmp/pdf-mixed-color-paragraph.pdf',
    fileName: 'pdf-mixed-color-paragraph.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const texts = translatableText(model)
  assert.equal(texts.length, 1, JSON.stringify(texts))
  assert.equal(texts[0]?.includes('gray tail'), true, JSON.stringify(texts))
  assert.equal(texts[0]?.includes('dark tail'), true, JSON.stringify(texts))
})

test('PDF 同一段落内字体族碎片交错不能拆开视觉续行', async () => {
  const document = await PDFDocument.create()
  const helvetica = await document.embedFont(StandardFonts.Helvetica)
  const times = await document.embedFont(StandardFonts.TimesRoman)
  const page = document.addPage([600, 800])
  const left = 90
  const firstHelvetica = 'The first visual line is mostly Helvetica and'
  const firstTimes = ' a shorter Times tail.'
  const secondTimes = 'The second visual line is mostly Times and'
  const secondHelvetica = ' a shorter Helvetica tail.'

  // 真实网页 PDF 中，中英文回退字体会在相邻行内交错出现，主导字体随之互换；
  // 只要两行共享同一组字体，就仍应视为同一自然段的视觉续行。
  page.drawText(firstHelvetica, { x: left, y: 700, size: 12, font: helvetica })
  page.drawText(firstTimes, {
    x: left + helvetica.widthOfTextAtSize(firstHelvetica, 12),
    y: 700,
    size: 12,
    font: times
  })
  page.drawText(secondTimes, { x: left, y: 672, size: 12, font: times })
  page.drawText(secondHelvetica, {
    x: left + times.widthOfTextAtSize(secondTimes, 12),
    y: 672,
    size: 12,
    font: helvetica
  })

  const model = await parsePdfDocument({
    path: '/tmp/pdf-mixed-font-paragraph.pdf',
    fileName: 'pdf-mixed-font-paragraph.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const texts = translatableText(model)
  assert.equal(texts.length, 1, JSON.stringify(texts))
  assert.equal(texts[0]?.includes('Helvetica tail'), true, JSON.stringify(texts))
  assert.equal(texts[0]?.includes('Times tail'), true, JSON.stringify(texts))
})

test('PDF 列表项续行缩进到正文列时仍应与列表首行合并', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const marker = '1.'
  const firstLine = 'Season prices in June remain the lowest of the year and'
  const secondLine = 'continue into the next visual line without a paragraph break.'

  // 列表标记位于悬挂缩进列，正文和续行都从正文列开始，不能把这种缩进当成段间距。
  page.drawText(marker, { x: 72, y: 700, size: 12, font })
  page.drawText(firstLine, {
    x: 90,
    y: 700,
    size: 12,
    font
  })
  page.drawText(secondLine, { x: 90, y: 672, size: 12, font })

  const model = await parsePdfDocument({
    path: '/tmp/pdf-list-continuation.pdf',
    fileName: 'pdf-list-continuation.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.deepEqual(translatableText(model), [`${marker}${firstLine} ${secondLine}`])
})

test('PDF 已以句号结束的列表项不能吞并下一段缩进正文', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const marker = '3.'
  const listItem = 'Choose medium berries for everyday use; larger berries cost more.'
  const nextParagraph = 'Would you like a simple guide for choosing fresh blueberries?'

  // 列表正文列与下一段缩进相同；上一行已经完整结束，不能把下一段误当作悬挂续行。
  page.drawText(marker, { x: 72, y: 700, size: 12, font })
  page.drawText(listItem, { x: 90, y: 700, size: 12, font })
  page.drawText(nextParagraph, { x: 90, y: 668.8, size: 12, font })

  const model = await parsePdfDocument({
    path: '/tmp/pdf-list-followed-by-paragraph.pdf',
    fileName: 'pdf-list-followed-by-paragraph.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.deepEqual(translatableText(model), [`${marker}${listItem}`, nextParagraph])
})

test('PDF 相同样式的连续列表项不能合并成同一段落', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const firstItem = '1) First list item remains independent from its neighbour.'
  const secondItem = '2) Second list item must start a new translation paragraph.'

  page.drawText(firstItem, { x: 90, y: 700, size: 12, font })
  page.drawText(secondItem, { x: 90, y: 672, size: 12, font })

  const model = await parsePdfDocument({
    path: '/tmp/pdf-consecutive-list-items.pdf',
    fileName: 'pdf-consecutive-list-items.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.deepEqual(translatableText(model), [firstItem, secondItem])
})

test('PDF 同一样式的相邻正文在段间距增大时仍必须分段', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const firstLine = 'First list item has a wrapped continuation line.'
  const continuation = 'The wrapped continuation remains inside the first item.'
  const nextParagraph = 'A separate closing question starts after extra paragraph spacing.'

  page.drawText(firstLine, { x: 72, y: 700, size: 12, font })
  page.drawText(continuation, { x: 72, y: 672, size: 12, font })
  // 第二行到结尾问句的基线推进为 55.2pt，明显大于正文行高，不能并入上一段。
  page.drawText(nextParagraph, { x: 72, y: 616.8, size: 12, font })

  const model = await parsePdfDocument({
    path: '/tmp/pdf-paragraph-gap.pdf',
    fileName: 'pdf-paragraph-gap.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.deepEqual(translatableText(model), [`${firstLine} ${continuation}`, nextParagraph])
})

test('PDF 同一视觉行的导航项在明显横向空洞处必须拆成独立文本块', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const items = ['Code', 'Issues', 'Pull requests', 'Actions', 'Projects']
  const positions = [54, 98, 148, 280, 350]

  items.forEach((item, index) => {
    page.drawText(item, { x: positions[index]!, y: 730, size: 10, font })
  })

  const model = await parsePdfDocument({
    path: '/tmp/pdf-navigation-gaps.pdf',
    fileName: 'pdf-navigation-gaps.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.deepEqual(translatableText(model), items)

  // 区块仍需保持独立（不能被拼成一句话），但同一视觉行的导航项应共享 flowGroupId，
  // 供译文预览横向排布而不是每个标签各占一行。
  const navigationText = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  const navigationGroups = new Set(
    navigationText.map((block) => block.kind === 'text' ? block.flowGroupId : undefined)
  )
  assert.equal(navigationGroups.size, 1)
  assert.ok(navigationText.every((block) => block.flowGroupId !== undefined))
})

test('PDF 不同基线的侧栏标签不能因 bbox 接近而合并成一块', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])

  page.drawText('Readme', { x: 48, y: 610, size: 11, font })
  page.drawText('License', { x: 48, y: 590, size: 11, font })

  const model = await parsePdfDocument({
    path: '/tmp/pdf-sidebar-baselines.pdf',
    fileName: 'pdf-sidebar-baselines.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const texts = translatableText(model)
  assert.equal(texts.some((text) => text.includes('Readme') && text.includes('License')), false, JSON.stringify(texts))
  assert.equal(texts.includes('Readme'), true, JSON.stringify(texts))
  assert.equal(texts.includes('License'), true, JSON.stringify(texts))
})

test('PDF 正常行距的短正文续行仍应合并为同一段落', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const lines = [
    'The short first line remains connected',
    'to its wrapped continuation.'
  ]

  lines.forEach((line, index) => {
    page.drawText(line, { x: 90, y: 700 - index * 18, size: 12, font })
  })

  const model = await parsePdfDocument({
    path: '/tmp/pdf-short-paragraph.pdf',
    fileName: 'pdf-short-paragraph.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.deepEqual(translatableText(model), [lines.join(' ')])
})

test('PDF 双栏正文应分别按段落合并，不能跨栏粘连句子', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const size = 12
  const leftLines = [
    'Left column first line continues',
    'into the left column second line.'
  ]
  const rightLines = [
    'Right column first line continues',
    'into the right column second line.'
  ]
  leftLines.forEach((line, index) => {
    page.drawText(line, { x: 60, y: 700 - index * 20, size, font })
  })
  rightLines.forEach((line, index) => {
    page.drawText(line, { x: 330, y: 700 - index * 20, size, font })
  })

  const model = await parsePdfDocument({
    path: '/tmp/two-columns.pdf',
    fileName: 'two-columns.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.deepEqual(translatableText(model), [leftLines.join(' '), rightLines.join(' ')])
  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  const leftParagraph = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes(leftLines[0]!))
  const rightParagraph = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes(rightLines[0]!))
  // 双栏右栏正文只是位于页面右侧，并不代表段落本身采用右对齐排版。
  assert.equal(leftParagraph?.kind === 'text' ? leftParagraph.textAlign : undefined, undefined)
  assert.equal(rightParagraph?.kind === 'text' ? rightParagraph.textAlign : undefined, undefined)
})

test('PDF 双栏内容流交错时必须先完成左栏再读取右栏，并保留跨栏标题', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const page = document.addPage([600, 800])
  page.drawText('Shared document heading', { x: 60, y: 740, size: 18, font: bold })

  // 模拟常见的 PDF 内容流顺序：左右栏逐行交错绘制，而不是先完整绘制左栏。
  // 阅读顺序恢复必须在段落分组前完成，否则会生成左一、右一、左二、右二。
  const leftLines = [
    'Left column starts here and continues',
    'with a second wrapped line.',
    'Left column ends with this sentence.'
  ]
  const rightLines = [
    'Right column starts after the left column',
    'and carries its own continuation.',
    'Right column ends here.'
  ]
  for (let index = 0; index < Math.max(leftLines.length, rightLines.length); index += 1) {
    if (leftLines[index]) page.drawText(leftLines[index]!, { x: 60, y: 680 - index * 18, size: 11, font })
    if (rightLines[index]) page.drawText(rightLines[index]!, { x: 330, y: 680 - index * 18, size: 11, font })
  }

  const model = await parsePdfDocument({
    path: '/tmp/interleaved-two-columns.pdf',
    fileName: 'interleaved-two-columns.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const texts = translatableText(model)
  assert.equal(texts[0], 'Shared document heading')
  assert.equal(texts[1], leftLines.join(' '))
  assert.equal(texts[2], rightLines.join(' '))
  const leftIndex = texts.findIndex((text) => text.includes('Left column starts'))
  const rightIndex = texts.findIndex((text) => text.includes('Right column starts'))
  assert.ok(leftIndex >= 0 && rightIndex >= 0 && leftIndex < rightIndex,
    `左栏必须完整排在右栏之前，实际顺序: ${JSON.stringify(texts)}`)
})

test('PDF 双栏正文上方的右侧独立表格必须先按视觉纵坐标输出', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const drawY = (y: number): number => page.getHeight() - y

  // 右上角是独立的流水号表格；双栏正文从表格下方开始。
  page.drawText('Serial number', { x: 430, y: drawY(38), size: 9, font })
  page.drawText('2026R11L3505485', { x: 430, y: drawY(58), size: 9, font })
  for (const y of [24, 48, 72]) {
    page.drawLine({ start: { x: 418, y: drawY(y) }, end: { x: 536, y: drawY(y) }, thickness: 1 })
  }
  for (const x of [418, 536]) {
    page.drawLine({ start: { x, y: drawY(24) }, end: { x, y: drawY(72) }, thickness: 1 })
  }

  const leftLines = [
    'Left column body starts below the header block.',
    'Left column continues with another sentence.',
    'Left column ends before the right column.'
  ]
  const rightLines = [
    'Right column body follows the complete left column.',
    'Right column continues with another sentence.',
    'Right column ends at the bottom of the body.'
  ]
  leftLines.forEach((line, index) => {
    page.drawText(line, { x: 60, y: drawY(150 + index * 24), size: 10, font })
  })
  rightLines.forEach((line, index) => {
    page.drawText(line, { x: 330, y: drawY(150 + index * 24), size: 10, font })
  })

  const model = await parsePdfDocument({
    path: '/tmp/two-column-top-right-table.pdf',
    fileName: 'two-column-top-right-table.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const blocks = model.pages[0]!.blocks
  const tableIndex = blocks.findIndex((block) => block.kind === 'table')
  const leftBodyIndex = blocks.findIndex((block) =>
    block.kind === 'text' && block.runs.some((run) => run.text.includes(leftLines[0]!)))
  assert.ok(tableIndex >= 0, `必须识别右上角独立表格，实际区块: ${JSON.stringify(blocks.map((block) => block.kind))}`)
  assert.ok(leftBodyIndex >= 0, '必须识别左栏正文')
  assert.ok(tableIndex < leftBodyIndex,
    `顶部表格必须先于双栏正文输出，实际顺序: ${JSON.stringify(translatableText(model))}`)
  assert.ok((blocks[tableIndex]!.bbox?.y ?? Infinity) < (blocks[leftBodyIndex]!.bbox?.y ?? Infinity),
    '顶部表格的视觉纵坐标必须小于正文')
})

test('PDF 单栏表单右侧签名和日期字段不得触发双栏区块重排', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const drawY = (y: number): number => page.getHeight() - y

  // 单栏表单：左侧是连续正文，右侧只有签名和日期两个字段。
  // 两侧都有多行且栏宽接近，但右侧字段的纵向跨度明显短于正文，不能判成双栏。
  const leftRows = [
    { y: 100, text: 'Applicant name: Lin Wei', match: 'Applicant name' },
    { y: 200, text: 'Contact phone: 13800000000', match: 'Contact phone' },
    { y: 300, text: 'Mailing address: No. 8 Example Road', match: 'Mailing address' }
  ]
  const rightRows = [
    { y: 100, text: 'Signature: Lin Wei ____________________', match: 'Signature' },
    { y: 200, text: 'Date: 2026-10-12 ______________________', match: 'Date' }
  ]
  leftRows.forEach((row) => {
    page.drawText(row.text, { x: 70, y: drawY(row.y), size: 10, font })
  })
  rightRows.forEach((row) => {
    page.drawText(row.text, { x: 420, y: drawY(row.y), size: 10, font })
  })

  const model = await parsePdfDocument({
    path: '/tmp/single-column-form-fields.pdf',
    fileName: 'single-column-form-fields.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const blocks = model.pages[0]!.blocks
  const expectedRows = [...leftRows, ...rightRows]
    .sort((left, right) => left.y - right.y)
  const rowIndexes = expectedRows.map((row) => blocks.findIndex((block) =>
    block.kind === 'text' && block.runs.some((run) => run.text.includes(row.match))))
  assert.ok(rowIndexes.every((index) => index >= 0), '表单正文、签名和日期字段都必须被解析')
  assert.deepEqual(rowIndexes, [...rowIndexes].sort((left, right) => left - right),
    `单栏表单必须保持原始视觉顺序，实际区块顺序: ${JSON.stringify(blocks.map((block) => block.bbox?.y))}`)
  assert.equal(model.warnings.some((warning) => warning.code === 'pdf-reading-order-uncertain'), false)
})

test('PDF 旋转文本必须保留并生成稳定告警', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  page.drawText('Horizontal body text', { x: 72, y: 700, size: 12, font })
  page.drawText('Rotated margin label', { x: 540, y: 300, size: 11, font, rotate: degrees(90) })

  const model = await parsePdfDocument({
    path: '/tmp/rotated-text.pdf',
    fileName: 'rotated-text.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.equal(translatableText(model).some((text) => text.includes('Rotated margin label')), true)
  assert.equal(model.warnings.some((warning) => warning.code === 'pdf-rotated-text'), true)
})

test('PDF 显著重叠文本必须告警，但正常同行和表格单元格不得误报', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const drawY = (y: number): number => page.getHeight() - y
  page.drawText('Overlapping foreground', { x: 80, y: drawY(180), size: 14, font })
  page.drawText('Overlapping background', { x: 84, y: drawY(181), size: 14, font })
  page.drawText('Navigation', { x: 80, y: drawY(260), size: 11, font })
  page.drawText('Reference', { x: 260, y: drawY(260), size: 11, font })
  page.drawText('Cell A', { x: 80, y: drawY(500), size: 11, font })
  page.drawText('Cell B', { x: 260, y: drawY(500), size: 11, font })
  page.drawRectangle({ x: 70, y: drawY(520), width: 420, height: 40, borderWidth: 1 })
  page.drawLine({ start: { x: 240, y: drawY(520) }, end: { x: 240, y: drawY(480) }, thickness: 1 })

  const model = await parsePdfDocument({
    path: '/tmp/overlapping-text.pdf',
    fileName: 'overlapping-text.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderEmbeddedImageToImage: async () => null,
    renderPageRegionToImage: async () => null
  })

  const overlapWarnings = model.warnings.filter((warning) => warning.code === 'pdf-overlapping-text')
  assert.equal(overlapWarnings.length, 1)
})

test('PDF 独立公式必须生成不可翻译公式区块并保留原文', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  page.drawText('The equation below defines the relation.', { x: 72, y: 700, size: 12, font })
  page.drawText('E = mc^2', { x: 240, y: 660, size: 14, font })
  page.drawText('where E is energy and m is mass.', { x: 72, y: 620, size: 12, font })

  const model = await parsePdfDocument({
    path: '/tmp/formula-block.pdf',
    fileName: 'formula-block.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const formula = model.pages[0]!.blocks.find((block) => block.kind === 'formula')
  assert.equal(formula?.kind, 'formula')
  if (formula?.kind !== 'formula') return
  assert.equal(formula.translatable, false)
  assert.equal(formula.sourceText, 'E = mc^2')
  assert.equal(translatableText(model).some((text) => text.includes('E = mc^2')), false)
  assert.equal(model.warnings.some((warning) => warning.code === 'formula-unrecognized'), true)
})

test('PDF 双栏右栏的普通正文不能被右边缘对齐启发式误判为右对齐', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const size = 12
  const leftLines = [
    'Left column body line establishes a stable left column boundary.',
    'Another left column line keeps the two column layout balanced.',
    'The last left column line ends at the normal column boundary.'
  ]
  const rightLines = [
    'Right column body line begins near the right column boundary.',
    'Another right column line continues the ordinary paragraph.',
    'The last right column line remains left aligned within its column.'
  ]
  leftLines.forEach((line, index) => {
    page.drawText(line, { x: 60, y: 700 - index * 40, size, font })
  })
  rightLines.forEach((line, index) => {
    page.drawText(line, { x: 330, y: 700 - index * 40, size, font })
  })

  const model = await parsePdfDocument({
    path: '/tmp/two-column-right-alignment.pdf',
    fileName: 'two-column-right-alignment.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const rightTextBlocks = model.pages[0]!.blocks.filter((block) =>
    block.kind === 'text' && (block.bbox?.x ?? 0) >= 330
  )
  assert.equal(rightTextBlocks.length, rightLines.length)
  assert.deepEqual(
    rightTextBlocks.map((block) => block.kind === 'text' ? block.textAlign : 'right'),
    [undefined, undefined, undefined]
  )
})

test('PDF 居中标题应保留居中，左对齐同级标题不能仅因字号较大而居中', async () => {
  const document = await PDFDocument.create()
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const page = document.addPage([600, 800])
  const body = 'A long body line that establishes the page body font size and keeps ordinary paragraphs left aligned.'
  page.drawText(body, { x: 72, y: 700, size: 12, font: regular })
  page.drawText('Left aligned section heading', { x: 72, y: 650, size: 20, font: bold })
  const centeredTitle = 'Centered chapter heading'
  const centeredWidth = bold.widthOfTextAtSize(centeredTitle, 22)
  page.drawText(centeredTitle, { x: (600 - centeredWidth) / 2, y: 600, size: 22, font: bold })

  const model = await parsePdfDocument({
    path: '/tmp/heading-alignment.pdf',
    fileName: 'heading-alignment.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  const leftHeading = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes('Left aligned section heading'))
  const centerHeading = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes(centeredTitle))
  assert.equal(leftHeading?.kind === 'text' ? leftHeading.textAlign : undefined, undefined)
  assert.equal(centerHeading?.kind === 'text' ? centerHeading.textAlign : undefined, 'center')
})

test('PDF 拆分标题共享同一中心线时应识别为居中，即使中心线相对页面略有偏移', async () => {
  const document = await PDFDocument.create()
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const page = document.addPage([595.28, 841.89])
  const bodySize = 12
  const headingSize = 15
  const bodyText = 'Municipal drainage and flood prevention implementation plan body text for alignment inference. '
  const bodyWidth = regular.widthOfTextAtSize(bodyText, bodySize)
  // 正文左右边界约为 100pt 与 520pt，标题中心线比页面中心右移约 4pt。
  for (let index = 0; index < 4; index += 1) {
    page.drawText(bodyText, { x: 100, y: 650 - index * 22, size: bodySize, font: regular })
  }
  const headingCenter = 301.64
  const firstHeading = 'Municipal drainage and flood prevention implementation plan'
  const secondHeading = '(2018-2022) notification'
  const firstWidth = bold.widthOfTextAtSize(firstHeading, headingSize)
  const secondWidth = bold.widthOfTextAtSize(secondHeading, headingSize)
  page.drawText(firstHeading, { x: headingCenter - firstWidth / 2, y: 760, size: headingSize, font: bold })
  page.drawText(secondHeading, { x: headingCenter - secondWidth / 2, y: 738, size: headingSize, font: bold })

  const model = await parsePdfDocument({
    path: '/tmp/split-heading-alignment.pdf',
    fileName: 'split-heading-alignment.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  assert.ok(bodyWidth >= 420)
  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  const headings = textBlocks.filter((block) => block.kind === 'text' &&
    [firstHeading, secondHeading].includes(block.runs.map((run) => run.text).join('')))
  assert.equal(headings.length, 2)
  assert.deepEqual(headings.map((block) => block.kind === 'text' ? block.textAlign : undefined), [
    'center',
    'center'
  ])
})

test('PDF 原生文本应保留字体粗细与斜体，供译文预览和导出复用', async () => {
  const document = await PDFDocument.create()
  const boldFont = await document.embedFont(StandardFonts.HelveticaBold)
  const italicFont = await document.embedFont(StandardFonts.HelveticaOblique)
  const page = document.addPage([600, 800])
  page.drawText('Bold title', { x: 72, y: 700, size: 24, font: boldFont })
  page.drawText('Italic note', { x: 72, y: 660, size: 14, font: italicFont })

  const model = await parsePdfDocument({
    path: '/tmp/font-styles.pdf',
    fileName: 'font-styles.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  })

  const textBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'text')
  const boldBlock = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes('Bold title'))
  const italicBlock = textBlocks.find((block) => block.kind === 'text' && block.runs.map((run) => run.text).join('').includes('Italic note'))
  assert.equal(boldBlock?.kind === 'text' ? boldBlock.runs[0]?.style?.fontWeight : undefined, 700)
  assert.equal(italicBlock?.kind === 'text' ? italicBlock.runs[0]?.style?.italic : undefined, true)
})

test('PDF 扫描页栅格化后必须登记资源字节供 OCR 读取', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  page.drawRectangle({ x: 80, y: 120, width: 440, height: 560 })
  const bytes = await document.save()
  const registered = new Map<string, Uint8Array>()
  const model = await parsePdfDocument({
    path: '/tmp/scanned-page.pdf',
    fileName: 'scanned-page.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes
  }, {
    renderPageToImage: async () => new Uint8Array([137, 80, 78, 71, 9, 9]),
    registerAssetBytes: (assetId, assetBytes) => registered.set(assetId, assetBytes)
  })

  const scanned = model.pages[0]!.blocks.find((block) => block.kind === 'image')
  assert.equal(model.pages[0]!.blocks.filter((block) => block.kind === 'image').length, 1)
  assert.equal(scanned?.kind === 'image' ? scanned.renderPending : true, false)
  assert.equal(registered.size, 1)
  assert.equal(registered.has(scanned?.kind === 'image' ? scanned.assetId : ''), true)
})

test('PDF 原生文本页应提取页内图片区域并登记 OCR 资源', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  page.drawText('Native text', { x: 50, y: 700, size: 20 })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64'
  )
  const image = await document.embedPng(png)
  page.drawImage(image, { x: 100, y: 200, width: 200, height: 100 })
  const bytes = await document.save()
  const registered = new Map<string, Uint8Array>()
  const embeddedImages: Array<{ pageIndex: number; objectId: string }> = []
  let regionRenderCount = 0

  const model = await parsePdfDocument({
    path: '/tmp/image-text.pdf',
    fileName: 'image-text.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes
  }, {
    renderEmbeddedImageToImage: async (_page, pageIndex, objectId) => {
      embeddedImages.push({ pageIndex, objectId })
      return new Uint8Array([137, 80, 78, 71, 7, 7])
    },
    renderPageRegionToImage: async () => {
      regionRenderCount += 1
      return new Uint8Array([137, 80, 78, 71, 8, 8])
    },
    registerAssetBytes: (assetId, assetBytes) => registered.set(assetId, assetBytes)
  })

  const imageBlocks = model.pages[0]!.blocks.filter((block) => block.kind === 'image')
  assert.equal(imageBlocks.length, 1)
  assert.equal(embeddedImages.length, 1)
  assert.equal(embeddedImages[0]!.pageIndex, 0)
  assert.match(embeddedImages[0]!.objectId, /^img_/u)
  assert.equal(regionRenderCount, 0)
  assert.deepEqual(imageBlocks[0]!.bbox, { x: 100, y: 500, width: 200, height: 100 })
  assert.equal(imageBlocks[0]!.kind === 'image' ? imageBlocks[0].renderPending : true, false)
  assert.equal(registered.size, 1)
  assert.equal(registered.has(imageBlocks[0]!.kind === 'image' ? imageBlocks[0].assetId : ''), true)
  assert.equal(model.assets.length, 1)
  assert.equal(model.warnings.some((warning) => warning.code === 'embedded-image-ocr-required'), true)
})

test('PDF 页数超过限制时必须停止后续页面并保留可本地化告警', async () => {
  const document = await PDFDocument.create()
  document.addPage([600, 800]).drawText('First page', { x: 50, y: 700, size: 20 })
  document.addPage([600, 800]).drawText('Second page', { x: 50, y: 700, size: 20 })
  const model = await parsePdfDocument({
    path: '/tmp/paged.pdf',
    fileName: 'paged.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, { maxPages: 1 })

  assert.equal(model.pages.length, 1)
  assert.deepEqual(translatableText(model), ['First page'])
  assert.equal(model.warnings.some((warning) => warning.code === 'page-limit-reached'), true)
})

test('PDF 内嵌图片像素超过上限时必须跳过资源并保留原生正文', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  page.drawText('Native text', { x: 50, y: 700, size: 20 })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64'
  )
  const image = await document.embedPng(png)
  page.drawImage(image, { x: 100, y: 200, width: 200, height: 100 })
  const registered = new Map<string, Uint8Array>()
  const model = await parsePdfDocument({
    path: '/tmp/pixel-image.pdf',
    fileName: 'pixel-image.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderEmbeddedImageToImage: async () => pngHeader(5_000, 5_000),
    registerAssetBytes: (assetId, bytes) => registered.set(assetId, bytes)
  })

  assert.deepEqual(translatableText(model), ['Native text'])
  assert.equal(model.pages[0]!.blocks.some((block) => block.kind === 'image'), false)
  assert.equal(model.assets.length, 0)
  assert.equal(registered.size, 0)
  assert.equal(model.warnings.some((warning) => warning.code === 'image-pixel-limit-reached'), true)
  assert.equal(
    model.warnings.some((warning) => warning.code === 'embedded-image-ocr-required'),
    false,
    '图片全部因像素上限被跳过时不得误报图片文字会进入 OCR'
  )
})

test('PDF 页面区块应按版面位置合并文本与图片，保持原文阅读顺序', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  page.drawText('Text before image', { x: 72, y: 700, size: 16 })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64'
  )
  const image = await document.embedPng(png)
  page.drawImage(image, { x: 100, y: 350, width: 200, height: 100 })
  page.drawText('Text after image', { x: 72, y: 250, size: 16 })

  const model = await parsePdfDocument({
    path: '/tmp/image-between-text.pdf',
    fileName: 'image-between-text.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderEmbeddedImageToImage: async () => new Uint8Array([137, 80, 78, 71, 7, 7])
  })

  const blocks = model.pages[0]!.blocks
  assert.deepEqual(blocks.map((block) => block.kind), ['text', 'image', 'text'])
  assert.deepEqual(blocks.map((block) => block.readingOrder), [0, 1, 2])
  assert.equal(new Set(blocks.map((block) => block.blockId)).size, blocks.length)
  assert.ok(blocks[0]!.bbox!.y < blocks[1]!.bbox!.y)
  assert.ok(blocks[1]!.bbox!.y < blocks[2]!.bbox!.y)

  const textBlocks = blocks.filter((block) => block.kind === 'text')
  for (const block of textBlocks) {
    assert.deepEqual(
      block.runs.map((run) => run.runId),
      block.runs.map((_run, index) => `${block.blockId}-run-${index}`)
    )
  }
})

test('PDF 内嵌图片直接导出失败时应回退到页面区域裁切', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  page.drawText('Native text', { x: 50, y: 700, size: 20 })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64'
  )
  const image = await document.embedPng(png)
  page.drawImage(image, { x: 100, y: 200, width: 200, height: 100 })
  let regionRenderCount = 0

  const model = await parsePdfDocument({
    path: '/tmp/image-fallback.pdf',
    fileName: 'image-fallback.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderEmbeddedImageToImage: async () => null,
    renderPageRegionToImage: async (_page, _pageIndex, bbox) => {
      regionRenderCount += 1
      assert.deepEqual(bbox, { x: 100, y: 500, width: 200, height: 100 })
      return new Uint8Array([137, 80, 78, 71, 8, 8])
    }
  })

  const imageBlock = model.pages[0]!.blocks.find((block) => block.kind === 'image')
  assert.equal(regionRenderCount, 1)
  assert.equal(imageBlock?.kind === 'image' ? imageBlock.renderPending : true, false)
})

test('PDF 表单的页面外框、T 型表头接缝与签名横线不能破坏表格识别', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.28, 841.89])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const tableLeft = 60
  const tableRight = 535.5
  const splitX = 141
  const rowPositions = [100.5, 109.87, 132.75, 154.5, 176.25, 198, 281.25, 364.5, 447.75, 531, 614.25]
  // 页面坐标自上而下，转换为 pdf-lib 自下而上的绘制坐标。
  const drawY = (y: number): number => page.getHeight() - y

  page.drawRectangle({ x: 0.5, y: 0.5, width: 594.3, height: 840.9, borderWidth: 1 })
  page.drawLine({ start: { x: tableLeft, y: drawY(22.5) }, end: { x: tableLeft, y: drawY(804) }, thickness: 1 })
  page.drawLine({ start: { x: tableRight, y: drawY(22.5) }, end: { x: tableRight, y: drawY(804) }, thickness: 1 })
  // 表头列分隔线从表头下缘开始，形成 T 型接缝而不是贯穿表头的竖线。
  page.drawLine({ start: { x: splitX, y: drawY(110.25) }, end: { x: splitX, y: drawY(615) }, thickness: 1 })
  for (const y of rowPositions) {
    page.drawLine({ start: { x: tableLeft, y: drawY(y) }, end: { x: tableRight, y: drawY(y) }, thickness: 1 })
  }
  page.drawLine({ start: { x: 145.5, y: drawY(128.25) }, end: { x: 253.5, y: drawY(128.25) }, thickness: 1 })
  page.drawLine({ start: { x: 65.25, y: drawY(670.5) }, end: { x: 524.25, y: drawY(670.5) }, thickness: 1 })
  page.drawLine({ start: { x: tableLeft, y: drawY(802.5) }, end: { x: tableRight, y: drawY(802.5) }, thickness: 1 })
  page.drawText('Submit material list', { x: 82, y: drawY(122), size: 10, font })
  page.drawText('Certificate copies', { x: 82, y: drawY(748), size: 10, font })

  const model = await parsePdfDocument({
    path: '/tmp/form-grid.pdf',
    fileName: 'form-grid.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderEmbeddedImageToImage: async () => null,
    renderPageRegionToImage: async () => null
  })

  const parsedPage = model.pages[0]!
  const tables = parsedPage.blocks.filter((block) => block.kind === 'table')
  assert.equal(tables.length, 1, '表单网格应整体成为一个表格区块')
  const table = tables[0]!
  if (table.kind !== 'table') return
  assert.equal(table.rows.length >= 8, true, `实际行数 ${table.rows.length}`)
  assert.ok(Math.abs(table.bbox.y + table.bbox.height - 614.25) <= 1.5,
    `表格底边应停在真实数据行，实际为 ${table.bbox.y + table.bbox.height}`)
  assert.deepEqual(table.columnWidths, [81, 394.5])
  assert.equal(translatableText(model).some((text) => text.includes('Submit material list')), true)
  assert.equal(translatableText(model).some((text) => text.includes('Certificate copies')), true)
  assert.equal(parsedPage.blocks.filter((block) => block.kind === 'shape' &&
    block.line?.orientation === 'horizontal' &&
    (block.bbox?.y ?? 0) > 100 && (block.bbox?.y ?? 0) < 615).length, 0,
  '表格内部横线应由表格边框绘制，不能再作为独立 shape 下推')
  assert.equal(parsedPage.blocks.filter((block) => block.kind === 'shape' &&
    block.line?.orientation === 'vertical' &&
    (block.bbox?.x ?? 0) >= 59 && (block.bbox?.x ?? 0) <= 61 &&
    (block.bbox?.y ?? 0) < 614.25 && (block.bbox?.y ?? 0) + (block.bbox?.height ?? 0) > 100.5).length, 0,
  '贯穿表格的整页竖线必须在表格区间内截断，不能作为独立 shape 下推')
  const formBottom = parsedPage.blocks.find((block) => block.kind === 'shape' &&
    block.line?.orientation === 'horizontal' &&
    Math.abs((block.bbox?.y ?? 0) - 802.5) <= 1.5)
  assert.ok(formBottom, '表单容器底边必须保留，不能随页面外框一起被过滤')
  assert.ok(Math.abs((formBottom.bbox?.width ?? 0) - 475.5) <= 2)
})

test('PDF 贴纸张边缘的整页装饰线不能进入译文预览', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([594.96, 841.92])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y

  // 复现用户 PDF 中的外围装饰线：左右竖线接近整页高度，底部横线接近整页宽度。
  page.drawLine({ start: { x: -0.5, y: drawY(22.5) }, end: { x: -0.5, y: drawY(842) }, thickness: 1 })
  page.drawLine({ start: { x: 594.5, y: drawY(22.5) }, end: { x: 594.5, y: drawY(842) }, thickness: 1 })
  page.drawLine({ start: { x: 0, y: drawY(841.5) }, end: { x: 595, y: drawY(841.5) }, thickness: 1 })
  // 正常页眉线与表格线必须保留，不能随外围装饰线一起被过滤。
  page.drawLine({ start: { x: 417.75, y: drawY(88) }, end: { x: 535.5, y: drawY(88) }, thickness: 1 })
  page.drawRectangle({ x: 60, y: drawY(614.25), width: 475.5, height: 513.75, borderWidth: 1 })
  page.drawLine({ start: { x: 60, y: drawY(200) }, end: { x: 535.5, y: drawY(200) }, thickness: 1 })
  page.drawText('Table content', { x: 82, y: drawY(180), size: 10, font })

  const model = await parsePdfDocument({
    path: '/tmp/page-edge-decoration.pdf',
    fileName: 'page-edge-decoration.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderEmbeddedImageToImage: async () => null,
    renderPageRegionToImage: async () => null
  })

  const parsedPage = model.pages[0]!
  const shapes = parsedPage.blocks.filter((block) => block.kind === 'shape')
  assert.equal(shapes.filter((block) => block.line?.orientation === 'vertical' &&
    (block.bbox?.x ?? 0) <= 2 && (block.bbox?.height ?? 0) >= parsedPage.height * 0.9).length, 0,
  '贴左纸张边缘的整页竖线必须被过滤')
  assert.equal(shapes.filter((block) => block.line?.orientation === 'vertical' &&
    (block.bbox?.x ?? 0) + (block.bbox?.width ?? 0) >= parsedPage.width - 2 &&
    (block.bbox?.height ?? 0) >= parsedPage.height * 0.9).length, 0,
  '贴右纸张边缘的整页竖线必须被过滤')
  assert.equal(shapes.filter((block) => block.line?.orientation === 'horizontal' &&
    (block.bbox?.y ?? 0) >= parsedPage.height - 2 &&
    (block.bbox?.width ?? 0) >= parsedPage.width * 0.9).length, 0,
  '贴底部纸张边缘的整页横线必须被过滤')
  assert.equal(shapes.some((block) => block.line?.orientation === 'horizontal' &&
    Math.abs((block.bbox?.x ?? 0) - 417.75) <= 1.5 &&
    Math.abs((block.bbox?.y ?? 0) - 88) <= 1.5 &&
    Math.abs((block.bbox?.width ?? 0) - 117.75) <= 1.5), true,
  '正常页眉横线必须保留')
  assert.equal(parsedPage.blocks.some((block) => block.kind === 'table'), true,
  '正常表格必须保留')
})

test('PDF 页眉长横线在小 logo 附近时必须被过滤，短页眉线仍保留', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([595.3, 841.9])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64'
  )
  const image = await document.embedPng(png)
  const drawY = (y: number): number => page.getHeight() - y
  page.drawImage(image, { x: 367.8, y: drawY(61.2), width: 18.6, height: 18.6 })
  page.drawText('Acme Technology Ltd', { x: 397.32, y: drawY(55.4), size: 9, font })
  // 长线是页眉装饰；短线下方的文字区说明短页眉线是正常结构线，必须保留。
  page.drawLine({ start: { x: 90, y: drawY(81.1) }, end: { x: 505.3, y: drawY(81.1) }, thickness: 1 })
  page.drawLine({ start: { x: 417.75, y: drawY(88) }, end: { x: 535.5, y: drawY(88) }, thickness: 1 })
  page.drawText('Body text', { x: 90, y: drawY(180), size: 12, font })

  const model = await parsePdfDocument({
    path: '/tmp/header-long-divider.pdf',
    fileName: 'header-long-divider.pdf',
    format: 'pdf',
    sha256: FINGERPRINT,
    bytes: await document.save()
  }, {
    renderEmbeddedImageToImage: async () => new Uint8Array([137, 80, 78, 71, 7, 7])
  })

  const horizontalShapes = model.pages[0]!.blocks.filter((block) => block.kind === 'shape' &&
    block.line?.orientation === 'horizontal')
  assert.equal(horizontalShapes.some((block) =>
    Math.abs((block.bbox?.x ?? 0) - 90) <= 1.5 &&
    Math.abs((block.bbox?.y ?? 0) - 81.1) <= 1.5), false,
  '页眉 logo 附近的超宽横线不能作为独立形状进入译文')
  assert.equal(horizontalShapes.some((block) =>
    Math.abs((block.bbox?.x ?? 0) - 417.75) <= 1.5 &&
    Math.abs((block.bbox?.y ?? 0) - 88) <= 1.5), true,
  '普通短页眉线必须保留')
})
