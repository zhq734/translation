import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import {
  parseDelimitedDocument,
  parseHtmlDocument,
  parseMarkdownDocument,
  parseSubtitleDocument,
  parseTextDocument
} from '../src/main/documentTextParser.ts'
import { parseDocxDocument } from '../src/main/documentDocxParser.ts'
import { parseEpubDocument } from '../src/main/documentEpubParser.ts'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'
import type { DocumentModel } from '../src/shared/documentTypes.ts'

/** 测试文档统一使用的稳定指纹。 */
const FINGERPRINT = 'fixture-sha256'

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

  const vtt = parseSubtitleDocument(textInput([
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:03.000',
    'Hello VTT'
  ].join('\n'), 'captions.vtt', 'vtt'))
  assert.deepEqual(translatableText(vtt), ['Hello VTT'])
})

test('HTML 应保留原文件供源文预览，翻译模型只提取受控语义内容', () => {
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
  assert.equal(model.warnings.some((warning) => warning.code === 'remote-resource-removed'), false)
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
  assert.equal(model.pages[0]!.blocks.filter((block) => block.kind === 'text').length, 0)

  const cellTextBlocks = table.rows.flatMap((row) => row.cells.flatMap((cell) =>
    cell.blocks.filter((block) => block.kind === 'text')))
  assert.equal(cellTextBlocks.length, 4)
  assert.equal(new Set(cellTextBlocks.map((block) => block.blockId)).size, cellTextBlocks.length)
  const runIds = cellTextBlocks.flatMap((block) => block.runs.map((run) => run.runId))
  assert.equal(new Set(runIds).size, runIds.length)
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
  const first = textBlocks.find((block) => block.kind === 'text' && block.runs[0]?.text === 'First body line')
  const second = textBlocks.find((block) => block.kind === 'text' && block.runs[0]?.text === 'Second body line')
  const third = textBlocks.find((block) => block.kind === 'text' && block.runs[0]?.text === 'Third body line')
  const paragraph = textBlocks.find((block) => block.kind === 'text' && block.runs[0]?.text === 'Next paragraph')
  assert.ok(first?.kind === 'text' && second?.kind === 'text' && third?.kind === 'text' && paragraph?.kind === 'text')
  assert.ok(Math.abs((first.runs[0]?.style?.lineHeight ?? 0) - 14) < 1)
  assert.ok(Math.abs((second.runs[0]?.style?.lineHeight ?? 0) - 14) < 1)
  // 段后最后一行没有可靠的下一条正文基线，不应把段间距写入行高。
  assert.equal(paragraph.runs[0]?.style?.lineHeight, undefined)

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
  const wideFirst = spacedBlocks.find((block) => block.kind === 'text' && block.runs[0]?.text === 'Wide line height first line')
  const wideSecond = spacedBlocks.find((block) => block.kind === 'text' && block.runs[0]?.text === 'Wide line height second line')
  const spacedParagraph = spacedBlocks.find((block) => block.kind === 'text' && block.runs[0]?.text === 'Spaced paragraph after wide body lines')
  assert.ok(wideFirst?.kind === 'text' && wideSecond?.kind === 'text' && spacedParagraph?.kind === 'text')
  assert.ok(Math.abs((wideFirst.runs[0]?.style?.lineHeight ?? 0) - 28.56) < 0.2)
  assert.ok(Math.abs((wideSecond.runs[0]?.style?.lineHeight ?? 0) - 28.56) < 0.2)
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

test('PDF 普通正文的短行与续行不得因左右留白接近而误判为居中', async () => {
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
  const bodyBlocks = textBlocks.filter((block) => block.kind === 'text' &&
    lines.some((line) => block.runs.map((run) => run.text).join('').includes(line.slice(0, 20))))
  assert.equal(bodyBlocks.length, lines.length)
  assert.deepEqual(bodyBlocks.map((block) => block.kind === 'text' ? block.textAlign : 'center'), [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined
  ])
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
