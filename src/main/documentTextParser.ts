import {
  createDocumentBlockId,
  createDocumentPageId,
  type DocumentBlock,
  type DocumentBoundingBox,
  type DocumentModel,
  type DocumentPage,
  type DocumentTableBlock,
  type DocumentTableCell,
  type DocumentTableRow,
  type DocumentTextBlock,
  type DocumentTextRole,
  type DocumentTextRun,
  type DocumentTextStyle
} from '../shared/documentTypes.ts'
import {
  createDocumentModel,
  createMultiRunTextBlock,
  createTableCellId,
  createTableRowId,
  createTextBlock,
  createDocumentWarning,
  decodeDocumentText,
  decodeHtmlEntities,
  limitDocumentBlocks,
  sanitizeDocumentText,
  splitTextParagraphs,
  type DocumentParseInput
} from './documentParserShared.ts'

/** 受保护片段在文本 run 中的稳定前缀。 */
const PROTECTED_TOKEN_PREFIX = 'DOC_PROTECTED_'

/** Markdown 受控行内标签允许保留的 CSS 颜色格式。 */
const SAFE_MARKDOWN_COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/iu

/** 需要在 Markdown 预览中隐藏的块级 HTML 标签。 */
const MARKDOWN_HIDDEN_BLOCK_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'button', 'input', 'textarea', 'select', 'svg', 'canvas'
])

/** 不渲染内容但需要中断段落的 HTML 标签。 */
const MARKDOWN_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'div', 'dl', 'dt', 'dd', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'section', 'table', 'tbody',
  'thead', 'tfoot', 'tr', 'ul'
])

/** 不声明语言时允许识别的行注释标记。 */
const DEFAULT_CODE_COMMENT_MARKERS = ['#', '//'] as const

/** 使用 # 作为行注释的常见语言。 */
const HASH_COMMENT_LANGUAGES = new Set([
  'bash', 'console', 'elixir', 'fish', 'makefile', 'perl', 'powershell', 'ps1', 'python', 'py',
  'r', 'ruby', 'rb', 'sh', 'shell', 'toml', 'yaml', 'yml', 'zsh'
])

/** 使用 // 作为行注释的常见语言。 */
const SLASH_COMMENT_LANGUAGES = new Set([
  'c', 'cc', 'cpp', 'cs', 'csharp', 'dart', 'go', 'groovy', 'java', 'js', 'jsx', 'kt', 'kotlin',
  'php', 'rust', 'rs', 'scala', 'swift', 'ts', 'tsx'
])

/** 使用 -- 作为行注释的常见语言。 */
const DASH_COMMENT_LANGUAGES = new Set(['lua', 'sql'])

/**
 * 创建文本类文档模型并写入单页区块。
 * @param input 解析输入。
 * @param blocks 页面区块。
 * @param options 可选标题。
 * @returns 文本类文档模型。
 * @author zhenghq
 */
function finishTextDocument(
  input: DocumentParseInput,
  blocks: DocumentBlock[],
  options: { title?: string } = {}
): DocumentModel {
  const model = createDocumentModel(input, options)
  model.pages[0]!.blocks = limitDocumentBlocks(blocks, model.warnings)
  return model
}

/**
 * 生成不暴露原文的受保护占位符。
 * @param kind 受保护内容类型。
 * @param index 序号。
 * @returns 保护标记文本。
 * @author zhenghq
 */
function protectedToken(kind: string, index: number): string {
  return `{{${PROTECTED_TOKEN_PREFIX}${kind}_${index}}}`
}

/**
 * 构造 JSON 中的可翻译字符串区块。
 * JSON 键名和结构不进入文本区块，避免翻译服务改写键名。
 * @param value 当前 JSON 值。
 * @param path 当前值路径，仅用于稳定顺序。
 * @returns 可翻译字符串路径与内容。
 * @author zhenghq
 */
function collectJsonStrings(value: unknown, path: string[] = []): Array<{ path: string[]; text: string }> {
  if (typeof value === 'string') return [{ path, text: value }]
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectJsonStrings(item, [...path, String(index)]))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => collectJsonStrings(child, [...path, key]))
  }
  return []
}

/**
 * 解析 JSON 文档，仅把字符串值转换为可翻译文本块。
 * @param input 解析输入。
 * @returns JSON 文档模型。
 * @author zhenghq
 */
function parseJsonDocument(input: DocumentParseInput): DocumentModel {
  const content = decodeDocumentText(input.bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    const model = createDocumentModel(input)
    model.warnings.push(createDocumentWarning('invalid-json', 'The JSON content could not be parsed and was treated as plain text.'))
    model.pages[0]!.blocks = splitTextParagraphs(content).map((paragraph, index) =>
      createTextBlock(input, model.pages[0]!.pageId, index, paragraph))
    return model
  }
  const model = createDocumentModel(input)
  const blocks = collectJsonStrings(parsed).map((entry, index) =>
    createTextBlock(input, model.pages[0]!.pageId, index, entry.text))
  return finishTextDocument(input, blocks)
}

/**
 * 解析 TXT 文档并保留段落边界。
 * @param input 解析输入。
 * @returns TXT 文档模型。
 * @author zhenghq
 */
export function parseTextDocument(input: DocumentParseInput): DocumentModel {
  if (input.format === 'json') return parseJsonDocument(input)
  const content = decodeDocumentText(input.bytes)
  const blocks = splitTextParagraphs(content).map((paragraph, index) =>
    createTextBlock(input, createDocumentModel(input).pages[0]!.pageId, index, paragraph))
  return finishTextDocument(input, blocks)
}

/**
 * 提取受控 HTML 标签中的颜色；非颜色属性一律忽略。
 * @param attributes 标签属性文本。
 * @returns 可安全写入模型样式的 CSS 颜色。
 * @author zhenghq
 */
function markdownTagColor(attributes: string): string | undefined {
  const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(attributes)
  const color = /\bcolor\s*:\s*([^;]+)/iu.exec(style?.[1] ?? style?.[2] ?? '')?.[1]?.trim()
  return color && SAFE_MARKDOWN_COLOR.test(color) ? color : undefined
}

/**
 * 解析行内 Markdown 与受控 HTML，保护代码、链接目标、邮箱和路径。
 * HTML 注释不进入可见文本；font/span 标签转换为受控颜色样式，br 转换为换行，
 * 其余未知标签保持原有受保护行为，避免把任意 HTML 交给 Renderer 执行。
 * @param line Markdown 行。
 * @returns 文本 run 数组。
 * @author zhenghq
 */
function parseMarkdownRuns(line: string): Array<Omit<DocumentTextRun, 'runId'>> {
  const runs: Array<Omit<DocumentTextRun, 'runId'>> = []
  let textBuffer = ''
  const styleStack: Array<{
    tagName: string
    color?: string
    bold: boolean
    italic: boolean
  }> = []
  let boldDepth = 0
  let italicDepth = 0

  /**
   * 提交普通可翻译文本，并应用当前受控行内样式。
   * @returns 无返回值。
   * @author zhenghq
   */
  const flushText = (): void => {
    if (textBuffer.length === 0) return
    const style: DocumentTextStyle = {}
    const activeStyle = styleStack[styleStack.length - 1]
    const activeColor = activeStyle?.color
    if (activeColor) style.color = activeColor
    if (boldDepth > 0 || activeStyle?.bold) style.fontWeight = 700
    if (italicDepth > 0 || activeStyle?.italic) style.italic = true
    runs.push({
      text: textBuffer,
      ...(Object.keys(style).length > 0 ? { style } : {})
    })
    textBuffer = ''
  }

  /**
   * 添加受保护 token；相邻保护 token 会合并以保持输出简洁。
   * @param text 需要原样保留的文本。
   * @returns 无返回值。
   * @author zhenghq
   */
  const pushProtected = (text: string): void => {
    flushText()
    const previous = runs[runs.length - 1]
    if (previous?.protected === true) {
      previous.text += text
    } else {
      runs.push({ text, protected: true })
    }
  }

  /**
   * 添加链接文字或图片替代文字；文字仍允许翻译，但不暴露目标地址。
   * @param label 标签文字。
   * @returns 无返回值。
   * @author zhenghq
   */
  const pushLabel = (label: string): void => {
    flushText()
    runs.push(...parseMarkdownRuns(label))
  }

  let cursor = 0
  // 路径以字母、下划线、点或波浪线开头，避免把 5s/10s、真人/动画等普通斜杠文本保护成路径。
  const pattern = /<!--[\s\S]*?-->|`[^`]*`|!\[([^\]]*)\]\(([^)]*)\)|\[([^\]]*)\]\(([^)]*)\)|<\/?([a-z][a-z0-9:-]*)(?:\s[^>]*)?>|https?:\/\/[^\s<>)\]]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\/{1,2}|\.{1,2}\/)[A-Za-z_.~][^\s<>)\]]*|(\*\*|__)(?=\S)|(?<=\S)(\*\*|__)|(?<!\*)\*(?=\S)|(?<=\S)\*(?!\*)/giu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > cursor) textBuffer += line.slice(cursor, match.index)
    const token = match[0]
    const imageLabel = match[1]
    const imageTarget = match[2]
    const linkLabel = match[3]
    const linkTarget = match[4]
    const tagName = match[5]?.toLowerCase()
    if (token.startsWith('<!--')) {
      // HTML 注释属于编辑器元数据，不作为正文显示或翻译。
    } else if (token.startsWith('`')) {
      pushProtected(token)
    } else if (imageLabel !== undefined) {
      // 首版不加载 Markdown 远程图片，只保留可读的替代文字。
      if (imageLabel.trim().length > 0) pushLabel(imageLabel)
    } else if (linkLabel !== undefined) {
      if (linkLabel.length > 0) pushLabel(linkLabel)
      if (linkTarget) pushProtected(linkTarget)
    } else if (tagName) {
      const isClosing = /^<\//u.test(token)
      const openIndex = isClosing
        ? styleStack.map((entry) => entry.tagName).lastIndexOf(tagName)
        : -1
      if (isClosing && openIndex >= 0) {
        flushText()
        styleStack.length = openIndex
      } else if (tagName === 'font' || tagName === 'span') {
        flushText()
        styleStack.push({ tagName, color: markdownTagColor(token), bold: false, italic: false })
      } else if (tagName === 'strong' || tagName === 'b') {
        flushText()
        if (isClosing) styleStack.length = Math.max(0, styleStack.length - 1)
        else styleStack.push({ tagName, bold: true, italic: false })
      } else if (tagName === 'em' || tagName === 'i') {
        flushText()
        if (isClosing) styleStack.length = Math.max(0, styleStack.length - 1)
        else styleStack.push({ tagName, bold: false, italic: true })
      } else if (tagName === 'br') {
        flushText()
        textBuffer += '\n'
      } else if (!MARKDOWN_HIDDEN_BLOCK_TAGS.has(tagName)) {
        pushProtected(token)
      }
    } else if (token === '**' || token === '__') {
      flushText()
      boldDepth = boldDepth > 0 ? boldDepth - 1 : 1
    } else if (token === '*' || token === '_') {
      flushText()
      italicDepth = italicDepth > 0 ? italicDepth - 1 : 1
    } else {
      pushProtected(token)
    }
    cursor = match.index + token.length
  }
  if (cursor < line.length) textBuffer += line.slice(cursor)
  flushText()
  return runs
}

/**
 * 拆分 Markdown 代码块中的注释正文，让注释可翻译而代码与注释标记保持原样。
 * 仅处理单行 # 与 // 注释；字符串中的 #、// 以及块注释保持不变。
 * @param line 代码块中的单行文本。
 * @returns 按原文顺序排列的受保护代码片段与可翻译注释片段。
 * @author zhenghq
 */
function parseMarkdownCodeRuns(
  line: string,
  language = ''
): Array<Omit<DocumentTextRun, 'runId'>> {
  const normalizedLanguage = language.toLowerCase()
  const markers = HASH_COMMENT_LANGUAGES.has(normalizedLanguage)
    ? ['#']
    : SLASH_COMMENT_LANGUAGES.has(normalizedLanguage)
      ? ['//']
      : DASH_COMMENT_LANGUAGES.has(normalizedLanguage)
        ? ['--']
        : [...DEFAULT_CODE_COMMENT_MARKERS]
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    const marker = markers.find((candidate) => line.startsWith(candidate, index))
    if (!marker) continue
    if (marker === '#' && index > 0 && !/\s/u.test(line[index - 1]!)) continue
    if (marker === '//' && index > 0 && (line[index - 1] === ':' || line[index - 1] === '\\')) continue
    if (marker === '--' && index > 0 && !/\s/u.test(line[index - 1]!)) continue
    const commentBody = line.slice(index + marker.length)
    if (!commentBody.trim() || commentBody.startsWith('!')) return [{ text: line, protected: true }]
    return [
      { text: line.slice(0, index + marker.length), protected: true },
      { text: commentBody }
    ]
  }
  return [{ text: line, protected: true }]
}

/**
 * 将围栏块构造为多 run 文本区块；未声明语言时按纯文本翻译，声明语言时仅翻译注释正文。
 * @param input 解析输入。
 * @param pageId 页面标识。
 * @param readingOrder 页面内阅读顺序。
 * @param lines 代码块行。
 * @param language 围栏语言标记；为空表示未声明语言。
 * @returns 代码角色文本区块。
 * @author zhenghq
 */
function createMarkdownCodeBlock(
  input: DocumentParseInput,
  pageId: string,
  readingOrder: number,
  lines: string[],
  language = ''
): DocumentTextBlock {
  // 无语言围栏常被用于提示词、模板和普通文本；整块翻译，避免正文被当成代码而漏译。
  const runs = language.trim().length === 0
    ? parseMarkdownRuns(lines.join('\n'))
    : lines.flatMap((line, index) => [
        ...(index > 0 ? [{ text: '\n', protected: true }] : []),
        ...parseMarkdownCodeRuns(line, language)
      ])
  return createMultiRunTextBlock(input, pageId, readingOrder, runs, 'code')
}

/**
 * 拆分 GFM 表格行，支持首尾竖线和反斜杠转义的单元格内竖线。
 * @param line 表格行文本。
 * @returns 去除首尾空白的单元格文本。
 * @author zhenghq
 */
function splitMarkdownTableRow(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  const trimmed = line.trim()
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!
    if (character === '\\' && trimmed[index + 1] === '|') {
      cell += '|'
      index += 1
    } else if (character === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
  }
  cells.push(cell.trim())
  if (trimmed.startsWith('|')) cells.shift()
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) cells.pop()
  return cells
}

/**
 * 判断一行是否为 GFM 表格分隔行。
 * @param line 待判断行。
 * @param columnCount 表头列数。
 * @returns 是否为匹配列数的分隔行。
 * @author zhenghq
 */
function isMarkdownTableDelimiter(line: string, columnCount: number): boolean {
  if (!line.includes('|')) return false
  const cells = splitMarkdownTableRow(line)
  return cells.length === columnCount && cells.every((cell) => /^:?-{3,}:?$/u.test(cell))
}

/**
 * 将 GFM 表格文本转换为文档表格区块。
 * @param input 解析输入。
 * @param pageId 页面标识。
 * @param readingOrder 表格在页面中的阅读顺序。
 * @param rawRows 表头与数据行。
 * @returns 表格区块。
 * @author zhenghq
 */
function createMarkdownTableBlock(
  input: DocumentParseInput,
  pageId: string,
  readingOrder: number,
  rawRows: string[][]
): DocumentTableBlock {
  const tableId = createDocumentBlockId(input.sha256, pageId, readingOrder, 'table')
  const columnCount = Math.max(1, rawRows[0]?.length ?? 1)
  const rows: DocumentTableRow[] = rawRows.map((rawRow, rowIndex) => ({
    rowId: createTableRowId(tableId, rowIndex),
    cells: Array.from({ length: columnCount }, (_, cellIndex): DocumentTableCell => {
      const cellText = rawRow[cellIndex] ?? ''
      const childReadingOrder = readingOrder * 100000 + rowIndex * columnCount + cellIndex
      return {
        cellId: createTableCellId(input.sha256, pageId, tableId, rowIndex, cellIndex),
        rowSpan: 1,
        colSpan: 1,
        blocks: cellText.length > 0
          ? [createMultiRunTextBlock(
              input,
              pageId,
              childReadingOrder,
              parseMarkdownRuns(cellText),
              'paragraph'
            )]
          : []
      }
    })
  }))
  return {
    kind: 'table',
    blockId: tableId,
    readingOrder,
    translatable: true,
    rows,
    headerRows: 1
  }
}

/**
 * 解析 Markdown 文档，保护代码与注释标记、行内代码、链接目标、邮箱和路径。
 * 代码块中的行注释正文会作为可翻译片段保留，避免代码结构和标识符被改写。
 * @param input 解析输入。
 * @returns Markdown 文档模型。
 * @author zhenghq
 */
export function parseMarkdownDocument(input: DocumentParseInput): DocumentModel {
  const content = sanitizeDocumentText(decodeDocumentText(input.bytes))
  const model = createDocumentModel(input)
  const pageId = model.pages[0]!.pageId
  const blocks: DocumentBlock[] = []
  const lines = content.split('\n')
  let paragraphLines: string[] = []
  let inFence = false
  let fenceLines: string[] = []
  let fenceLanguage = ''
  let inHtmlComment = false

  /**
   * 提交累计的普通段落。
   * @returns 无返回值。
   * @author zhenghq
   */
  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return
    const text = paragraphLines.join('\n')
    blocks.push(createMultiRunTextBlock(input, pageId, blocks.length, parseMarkdownRuns(text), 'paragraph'))
    paragraphLines = []
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!
    const fence = /^```\s*([^\s`]*)\s*$/u.exec(line)
    if (fence) {
      if (inFence) {
        blocks.push(createMarkdownCodeBlock(input, pageId, blocks.length, fenceLines, fenceLanguage))
        fenceLines = []
        fenceLanguage = ''
        inFence = false
      } else {
        flushParagraph()
        inFence = true
        fenceLanguage = fence[1] ?? ''
      }
      continue
    }
    if (inFence) {
      fenceLines.push(line)
      continue
    }
    if (inHtmlComment) {
      if (line.includes('-->')) inHtmlComment = false
      continue
    }
    if (/^\s*<!--/u.test(line)) {
      flushParagraph()
      if (!line.includes('-->')) inHtmlComment = true
      continue
    }
    if (line.trim().length === 0) {
      flushParagraph()
      continue
    }
    const headerCells = splitMarkdownTableRow(line)
    const delimiterLine = lines[lineIndex + 1]
    if (headerCells.length > 1 && delimiterLine !== undefined && isMarkdownTableDelimiter(delimiterLine, headerCells.length)) {
      flushParagraph()
      const tableRows = [headerCells]
      let rowIndex = lineIndex + 2
      while (rowIndex < lines.length) {
        const rowLine = lines[rowIndex]!
        if (rowLine.trim().length === 0 || !rowLine.includes('|')) break
        const rowCells = splitMarkdownTableRow(rowLine)
        tableRows.push(Array.from({ length: headerCells.length }, (_, cellIndex) => rowCells[cellIndex] ?? ''))
        rowIndex += 1
      }
      blocks.push(createMarkdownTableBlock(input, pageId, blocks.length, tableRows))
      lineIndex = rowIndex - 1
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
    if (heading) {
      flushParagraph()
      const block = createMultiRunTextBlock(input, pageId, blocks.length, parseMarkdownRuns(heading[2]!), 'heading')
      block.style = { fontSize: Math.max(14, 30 - (heading[1]!.length - 1) * 3), fontWeight: 700 }
      blocks.push(block)
      continue
    }
    const listItem = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/u.exec(line)
    if (listItem) {
      flushParagraph()
      blocks.push(createMultiRunTextBlock(input, pageId, blocks.length, parseMarkdownRuns(listItem[1]!), 'list-item'))
      continue
    }
    if (/^\s*>/u.test(line)) {
      flushParagraph()
      blocks.push(createMultiRunTextBlock(
        input,
        pageId,
        blocks.length,
        parseMarkdownRuns(line.replace(/^\s*>\s?/u, '')),
        'quote'
      ))
      continue
    }
    paragraphLines.push(line)
  }
  flushParagraph()
  if (inFence || fenceLines.length > 0) {
    blocks.push(createMarkdownCodeBlock(input, pageId, blocks.length, fenceLines, fenceLanguage))
    model.warnings.push(createDocumentWarning('unclosed-code-fence', 'The Markdown code fence was not closed and was preserved as protected code.'))
  }
  return finishTextDocument(input, blocks)
}

/**
 * 解析 CSV/TSV 表格，支持双引号转义和单元格内换行。
 * @param content 原始分隔文本。
 * @param delimiter 分隔符。
 * @returns 二维单元格文本。
 * @author zhenghq
 */
function parseDelimitedRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
      continue
    }
    if (character === '"') {
      quoted = true
    } else if (character === delimiter) {
      row.push(cell)
      cell = ''
    } else if (character === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (character !== '\r') {
      cell += character
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/**
 * 解析 CSV/TSV 文档为表格区块。
 * @param input 解析输入。
 * @returns 表格文档模型。
 * @author zhenghq
 */
export function parseDelimitedDocument(input: DocumentParseInput): DocumentModel {
  const content = sanitizeDocumentText(decodeDocumentText(input.bytes))
  const delimiter = input.format === 'csv' && input.fileName.toLowerCase().endsWith('.tsv') ? '\t' : ','
  const rawRows = parseDelimitedRows(content, delimiter)
  const columnCount = Math.max(0, ...rawRows.map((row) => row.length))
  const model = createDocumentModel(input)
  const pageId = model.pages[0]!.pageId
  const tableId = `table-${input.sha256.slice(0, 12)}`
  const rows: DocumentTableRow[] = rawRows.map((row, rowIndex) => ({
    rowId: createTableRowId(tableId, rowIndex),
    cells: Array.from({ length: columnCount }, (_, cellIndex): DocumentTableCell => {
      const cellText = row[cellIndex] ?? ''
      return {
        cellId: createTableCellId(input.sha256, pageId, tableId, rowIndex, cellIndex),
        rowSpan: 1,
        colSpan: 1,
        blocks: cellText.length > 0
          ? [createTextBlock(input, pageId, rowIndex * Math.max(1, columnCount) + cellIndex, cellText)]
          : []
      }
    })
  }))
  const table: DocumentTableBlock = {
    kind: 'table',
    blockId: tableId,
    readingOrder: 0,
    translatable: true,
    rows,
    headerRows: 1
  }
  model.pages[0]!.blocks = [table]
  return model
}

/**
 * 解析 SRT/VTT 字幕，时间轴和序号保存在文本块元数据中。
 * @param input 解析输入。
 * @returns 字幕文档模型。
 * @author zhenghq
 */
export function parseSubtitleDocument(input: DocumentParseInput): DocumentModel {
  const content = sanitizeDocumentText(decodeDocumentText(input.bytes))
  const model = createDocumentModel(input)
  const pageId = model.pages[0]!.pageId
  const blocks: DocumentBlock[] = []
  const lines = content.split('\n')
  let index = 0
  let sequence = 0
  while (index < lines.length) {
    const line = lines[index]!.trim()
    if (!line || line.toUpperCase() === 'WEBVTT') {
      index += 1
      continue
    }
    let sequenceValue: number | undefined
    if (/^\d+$/u.test(line)) {
      sequenceValue = Number(line)
      index += 1
    }
    const timing = lines[index]?.trim() ?? ''
    if (!/^\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[.,]\d{3}/u.test(timing)) {
      index += 1
      continue
    }
    index += 1
    const subtitleLines: string[] = []
    while (index < lines.length && lines[index]!.trim().length > 0) {
      subtitleLines.push(lines[index]!)
      index += 1
    }
    if (subtitleLines.length === 0) continue
    const block = createTextBlock(
      input,
      pageId,
      blocks.length,
      subtitleLines.join('\n'),
      'caption',
      {
        timing,
        ...(sequenceValue === undefined ? {} : { sequence: sequenceValue })
      }
    )
    blocks.push(block)
    sequence += 1
  }
  if (blocks.length === 0) {
    model.warnings.push(createDocumentWarning('invalid-subtitle', 'No valid subtitle timeline was found.'))
  }
  return finishTextDocument(input, blocks)
}

/** HTML 解析树节点。 */
interface HtmlNode {
  /** 标签名；纯文本节点使用 #text。 */
  name: string
  /** 文本节点内容。 */
  text?: string
  /** 标签属性。 */
  attributes: Record<string, string>
  /** 子节点。 */
  children: HtmlNode[]
}

/**
 * 安全解析 HTML 为简化节点树，不执行脚本，也不创建 DOM。
 * @param html HTML 文本。
 * @returns 根节点。
 * @author zhenghq
 */
function parseHtmlTree(html: string): HtmlNode {
  const root: HtmlNode = { name: '#root', attributes: {}, children: [] }
  const stack: HtmlNode[] = [root]
  // XML 声明、处理指令和 DOCTYPE 都只属于文档元数据，不能作为可见正文进入翻译模型。
  const tokenPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/?[a-z][^>]*>|[^<]+/giu
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(html)) !== null) {
    const token = match[0]
    if (token.startsWith('<!--') || token.startsWith('<!') || token.startsWith('<?')) continue
    if (token.startsWith('</')) {
      const closing = token.slice(2, -1).trim().toLowerCase()
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index]!.name === closing) {
          stack.length = index
          break
        }
      }
      continue
    }
    if (token.startsWith('<')) {
      const tagMatch = /^<([a-z][a-z0-9:-]*)([^>]*)>/iu.exec(token)
      if (!tagMatch) continue
      const name = tagMatch[1]!.toLowerCase()
      const attributes: Record<string, string> = {}
      const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu
      let attribute: RegExpExecArray | null
      while ((attribute = attributePattern.exec(tagMatch[2] ?? '')) !== null) {
        attributes[attribute[1]!.toLowerCase()] = decodeHtmlEntities(
          attribute[2] ?? attribute[3] ?? attribute[4] ?? ''
        )
      }
      const node: HtmlNode = { name, attributes, children: [] }
      stack[stack.length - 1]!.children.push(node)
      if (!/\/\s*>$/u.test(token) && !['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'].includes(name)) {
        stack.push(node)
      }
      continue
    }
    const text = decodeHtmlEntities(token)
    if (text.trim().length > 0) {
      stack[stack.length - 1]!.children.push({ name: '#text', text, attributes: {}, children: [] })
    }
  }
  return root
}

/**
 * 递归查找指定标签节点。
 * @param node 当前节点。
 * @param names 标签集合。
 * @returns 匹配节点数组。
 * @author zhenghq
 */
function findHtmlNodes(node: HtmlNode, names: ReadonlySet<string>): HtmlNode[] {
  const result: HtmlNode[] = []
  for (const child of node.children) {
    if (names.has(child.name)) result.push(child)
    result.push(...findHtmlNodes(child, names))
  }
  return result
}

/**
 * 提取 HTML 节点下的纯文本。
 * @param node 当前节点。
 * @returns 纯文本。
 * @author zhenghq
 */
function htmlText(node: HtmlNode): string {
  if (node.name === '#text') return node.text ?? ''
  return node.children.map(htmlText).join('')
}

/** SVG 中一个文本块的文字、边界和样式；分页扫描件按语义段落聚合视觉行。 */
interface SvgTextLine {
  /** 合并后的段落文本。 */
  text: string
  /** SVG 在页面中的绝对边界。 */
  bbox?: DocumentBoundingBox
  /** 从 text 节点提取的受控样式。 */
  style?: DocumentTextStyle
}

/** 从 SVG 文本行推断出的页面正文排版基准。 */
interface SvgParagraphLayout {
  /** 页面正文最常见的左边界。 */
  bodyLeft: number
  /** 页面正文最常见的视觉行高。 */
  bodyLineHeight: number
  /** 页面正文最常见的行距。 */
  bodyLineGap: number
}

/**
 * 根据页面视觉行估算正文排版基准，用于区分段内换行和首行缩进的新段落。
 * 标题、居中行和短行会因出现次数较少而自然排除在基准之外。
 * @param lines 页面内按文档顺序排列的 SVG 文本行。
 * @returns 正文左边界与行底边；没有坐标时返回 undefined。
 * @author zhenghq
 */
function inferSvgParagraphLayout(lines: SvgTextLine[]): SvgParagraphLayout | undefined {
  const leftCounts = new Map<number, number>()
  const lineHeightCounts = new Map<number, number>()
  const lineGapCounts = new Map<number, number>()
  for (const line of lines) {
    if (!line.bbox) continue
    const left = Math.round(line.bbox.x)
    const lineHeight = Math.round(line.bbox.height)
    leftCounts.set(left, (leftCounts.get(left) ?? 0) + 1)
    lineHeightCounts.set(lineHeight, (lineHeightCounts.get(lineHeight) ?? 0) + 1)
  }
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1]?.bbox
    const current = lines[index]?.bbox
    if (!previous || !current) continue
    const gap = Math.round(current.y - (previous.y + previous.height))
    lineGapCounts.set(gap, (lineGapCounts.get(gap) ?? 0) + 1)
  }
  if (lineGapCounts.size === 0) {
    for (let index = 0; index < lines.length; index += 1) {
      const bbox = lines[index]?.bbox
      if (bbox) lineGapCounts.set(Math.max(0, Math.round(bbox.height * 0.5)), 1)
    }
  }
  const mostFrequent = (counts: Map<number, number>): number | undefined => {
    let selected: number | undefined
    let selectedCount = 0
    for (const [value, count] of counts) {
      if (count > selectedCount) {
        selected = value
        selectedCount = count
      }
    }
    return selected
  }
  const bodyLeft = mostFrequent(leftCounts)
  const bodyLineHeight = mostFrequent(lineHeightCounts)
  const bodyLineGap = mostFrequent(lineGapCounts)
  const repeatedBodyLeft = bodyLeft !== undefined && (leftCounts.get(bodyLeft) ?? 0) > 1
  const repeatedBodyLineGap = bodyLineGap !== undefined && (lineGapCounts.get(bodyLineGap) ?? 0) > 1
  return !repeatedBodyLeft || bodyLeft === undefined || bodyLineHeight === undefined ||
      bodyLineGap === undefined || !repeatedBodyLineGap
    ? undefined
    : { bodyLeft, bodyLineHeight, bodyLineGap }
}

/**
 * 判断当前视觉行是否为上一正文行的段尾短行。
 * 段尾通常只有少量字符、宽度明显小于正文行，且不会向左越过正文左边界。
 * @param line 当前视觉行。
 * @param previous 上一视觉行。
 * @param layout 页面正文排版基准。
 * @returns 是段尾短行时返回 true。
 * @author zhenghq
 */
function isSvgParagraphTail(
  line: SvgTextLine,
  previous: SvgTextLine | undefined,
  layout: SvgParagraphLayout | undefined
): boolean {
  if (!layout || !line.bbox || !previous?.bbox) return false
  const lineWidth = line.bbox.width
  const previousWidth = previous.bbox.width
  return line.text.trim().length <= 20 && lineWidth < previousWidth * 0.7 &&
    line.bbox.x >= layout.bodyLeft - Math.max(8, (line.style?.fontSize ?? 12) * 0.5)
}

/**
 * 判断视觉行是否以条款、章节或中文列表编号开头。
 * 这些编号具有明确的语义边界，不能因坐标接近而并入上一段。
 * @param text 视觉行文本。
 * @returns 是语义段落起始行时返回 true。
 * @author zhenghq
 */
function startsSvgSemanticParagraph(text: string): boolean {
  const normalized = text.trim()
  return /^(?:第[〇零一二三四五六七八九十百千万两\d]+(?:条|章|节|款|项)|[（(][〇零一二三四五六七八九十百千万两\d]+[）)]|[〇零一二三四五六七八九十百千万两\d]+[、.．])/u
    .test(normalized)
}

/**
 * 将 SVG 视觉行按语义段落聚合，翻译和换行均以完整段落为单位。
 * 首行缩进、超出常规行距或字号变化会开启新段落；同一段落中的视觉行直接拼接。
 * @param lines 页面内按文档顺序排列的 SVG 文本行。
 * @param pageWidth 页面宽度；用于识别居中标题和居中续行。
 * @returns 按段落聚合后的文本块。
 * @author zhenghq
 */
function mergeSvgTextLinesIntoParagraphs(lines: SvgTextLine[], pageWidth?: number): SvgTextLine[] {
  const layout = inferSvgParagraphLayout(lines)
  const paragraphs: SvgTextLine[] = []
  let previous: SvgTextLine | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const current = paragraphs[paragraphs.length - 1]
    const previousBBox = previous?.bbox
    const currentBBox = line.bbox
    const verticalGap = previousBBox && currentBBox
      ? currentBBox.y - (previousBBox.y + previousBBox.height)
      : 0
    const currentFontSize = line.style?.fontSize ?? 12
    const indentation = Math.max(8, currentFontSize * 0.8)
    const currentCenter = currentBBox
      ? currentBBox.x + currentBBox.width / 2
      : undefined
    const previousCenter = previousBBox
      ? previousBBox.x + previousBBox.width / 2
      : undefined
    const previousFontSize = previous?.style?.fontSize ?? 12
    const centerTolerance = Math.max(12, currentFontSize * 0.8)
    const bodyAlignmentTolerance = Math.max(4, currentFontSize * 0.25)
    // 正文续行即使几何中心接近页面中心，只要左边界贴近正文基准线，仍属于左对齐正文。
    const isCentered = layout !== undefined && pageWidth !== undefined && currentCenter !== undefined &&
      Math.abs(currentCenter - pageWidth / 2) <= centerTolerance &&
      currentBBox !== undefined && currentBBox.x > layout.bodyLeft + bodyAlignmentTolerance
    const previousBodyAlignmentTolerance = Math.max(4, previousFontSize * 0.25)
    const previousIsCentered = layout !== undefined && pageWidth !== undefined && previousCenter !== undefined &&
      Math.abs(previousCenter - pageWidth / 2) <= Math.max(12, previousFontSize * 0.8) &&
      previousBBox !== undefined && previousBBox.x > layout.bodyLeft + previousBodyAlignmentTolerance
    const isIndented = layout !== undefined && currentBBox !== undefined &&
      currentBBox.x - layout.bodyLeft > indentation
    const lineHeight = currentBBox?.height ?? currentFontSize
    const exceedsBodyLineGap = layout !== undefined &&
      verticalGap > Math.max(layout.bodyLineGap + lineHeight * 0.5, lineHeight * 0.9)
    const hasComparableGeometry = currentBBox !== undefined && previousBBox !== undefined &&
      layout !== undefined
    // 没有坐标或页面排版基准时无法可靠判断段落，保留视觉行边界，避免错误粘连正文。
    const hasReliableLayout = hasComparableGeometry &&
      layout.bodyLineGap >= Math.max(2, layout.bodyLineHeight * 0.05)
    const startsNewParagraph = current === undefined || !hasReliableLayout ||
      startsSvgSemanticParagraph(line.text) ||
      exceedsBodyLineGap || isCentered !== previousIsCentered ||
      (!isCentered && isIndented && !isSvgParagraphTail(line, previous, layout))
    if (startsNewParagraph || current === undefined) {
      paragraphs.push({ ...line })
    } else {
      current.text = `${current.text}${line.text}`
      if (currentBBox && current.bbox) {
        current.bbox = {
          x: Math.min(current.bbox.x, currentBBox.x),
          y: Math.min(current.bbox.y, currentBBox.y),
          width: Math.max(
            current.bbox.x + current.bbox.width,
            currentBBox.x + currentBBox.width
          ) - Math.min(current.bbox.x, currentBBox.x),
          height: Math.max(
            current.bbox.y + current.bbox.height,
            currentBBox.y + currentBBox.height
          ) - Math.min(current.bbox.y, currentBBox.y)
        }
      }
    }
    previous = line
  }
  return paragraphs
}

/**
 * 解析内联样式中的像素长度。
 * @param style 内联样式。
 * @param property CSS 属性名。
 * @returns 像素数值；缺失或无法解析时返回 undefined。
 * @author zhenghq
 */
function inlineStylePixels(style: string | undefined, property: string): number | undefined {
  if (!style) return undefined
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':')
    if (separator < 0 || declaration.slice(0, separator).trim().toLowerCase() !== property) continue
    const value = declaration.slice(separator + 1).trim()
    const match = /^(-?\d+(?:\.\d+)?)px$/iu.exec(value)
    if (!match) return undefined
    const number = Number.parseFloat(match[1]!)
    return Number.isFinite(number) ? number : undefined
  }
  return undefined
}

/**
 * 解析内联样式中的受控颜色值，避免把 URL 或任意 CSS 写入模型。
 * @param style 内联样式。
 * @param property CSS 属性名。
 * @returns 安全的 CSS 颜色；无法识别时返回 undefined。
 * @author zhenghq
 */
function inlineStyleColor(style: string | undefined, property: string): string | undefined {
  if (!style) return undefined
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':')
    if (separator < 0 || declaration.slice(0, separator).trim().toLowerCase() !== property) continue
    const value = declaration.slice(separator + 1).trim().toLowerCase()
    return value !== 'transparent' && SAFE_MARKDOWN_COLOR.test(value) ? value : undefined
  }
  return undefined
}

/**
 * 读取 SVG 文本节点的数字属性。
 * @param node SVG 节点。
 * @param name 属性名。
 * @returns 有限数值；缺失时返回 undefined。
 * @author zhenghq
 */
function htmlNumberAttribute(node: HtmlNode, name: string): number | undefined {
  const value = Number.parseFloat(node.attributes[name] ?? '')
  return Number.isFinite(value) ? value : undefined
}

/**
 * 提取 SVG 文本节点的字体、字号和颜色样式。
 * @param node text 节点。
 * @returns 受控文本样式。
 * @author zhenghq
 */
function svgTextStyle(node: HtmlNode): DocumentTextStyle | undefined {
  const style = node.attributes.style
  const fontSize = inlineStylePixels(style, 'font-size')
  const fontWeightValue = style
    ?.split(';')
    .map((declaration) => declaration.split(':', 2))
    .find(([property]) => property?.trim().toLowerCase() === 'font-weight')?.[1]
    ?.trim()
    .toLowerCase()
  const numericWeight = Number.parseInt(fontWeightValue ?? '', 10)
  const fontWeight = Number.isFinite(numericWeight)
    ? numericWeight
    : fontWeightValue === 'bold' ? 700 : undefined
  const rawFontFamily = style
    ?.split(';')
    .map((declaration) => declaration.split(':', 2))
    .find(([property]) => property?.trim().toLowerCase() === 'font-family')?.[1]
    ?.trim()
  const fontFamily = rawFontFamily
    ?.replace(/[;{}<>]/gu, '')
    .slice(0, 200)
    .trim()
  const fill = node.attributes.fill?.trim().toLowerCase()
  const color = fill && fill !== 'transparent' && SAFE_MARKDOWN_COLOR.test(fill)
    ? fill
    : inlineStyleColor(style, 'color')
  const result: DocumentTextStyle = {
    ...(fontFamily ? { fontFamily } : {}),
    ...(fontSize === undefined ? {} : { fontSize }),
    ...(fontWeight === undefined ? {} : { fontWeight }),
    ...(color ? { color } : {})
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * 从 SVG 节点中提取按视觉顺序排列的文本行。
 * 扫描件 HTML 常把每行正文拆成多个 text 节点，图形 path 不包含可翻译文本。
 * @param svg 当前 SVG 节点。
 * @returns 带坐标与样式的文本行数组。
 * @author zhenghq
 */
function extractSvgTextLines(svg: HtmlNode): SvgTextLine[] {
  const lines = new Map<string, SvgTextLine>()
  const width = inlineStylePixels(svg.attributes.style, 'width')
  const height = inlineStylePixels(svg.attributes.style, 'height')
  const left = inlineStylePixels(svg.attributes.style, 'left') ?? 0
  const top = inlineStylePixels(svg.attributes.style, 'top') ?? 0
  const bbox = width !== undefined && height !== undefined
    ? { x: left, y: top, width, height }
    : undefined
  const textNodes = findHtmlNodes(svg, new Set(['text']))
  for (let index = 0; index < textNodes.length; index += 1) {
    const node = textNodes[index]!
    const y = htmlNumberAttribute(node, 'y')
    // 同一视觉行通常共享 y 坐标；缺少坐标时按节点顺序各自成行。
    const lineKey = y === undefined ? `line-${index}` : String(y)
    const text = htmlText(node)
    if (!text) continue
    const current = lines.get(lineKey)
    lines.set(lineKey, {
      text: `${current?.text ?? ''}${text}`,
      ...(bbox ? { bbox } : {}),
      ...(current?.style ?? svgTextStyle(node) ? { style: current?.style ?? svgTextStyle(node) } : {})
    })
  }
  return [...lines.values()]
    .map((line) => ({ ...line, text: line.text.replace(/\s+/gu, ' ').trim() }))
    .filter((line) => line.text.length > 0)
}

/**
 * 判断 HTML 节点是否是可分页的扫描件页面容器。
 * 固定宽高且包含 SVG 或白色背景的 div 视为页面，避免把普通布局卡片拆成页面。
 * @param node HTML 节点。
 * @returns 页面尺寸；不是页面容器时返回 undefined。
 * @author zhenghq
 */
function htmlPageDimensions(node: HtmlNode): { width: number; height: number; background?: string } | undefined {
  if (node.name !== 'div') return undefined
  const style = node.attributes.style
  const width = inlineStylePixels(style, 'width')
  const height = inlineStylePixels(style, 'height')
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined
  const background = inlineStyleColor(style, 'background') ?? inlineStyleColor(style, 'background-color')
  const containsSvg = findHtmlNodes(node, new Set(['svg'])).length > 0
  if (!background && !containsSvg) return undefined
  return { width, height, ...(background ? { background } : {}) }
}

/**
 * 按文档顺序查找最外层扫描件页面容器，并停止深入已识别页面。
 * @param node 当前节点。
 * @returns 页面节点数组。
 * @author zhenghq
 */
function findHtmlPageContainers(node: HtmlNode): HtmlNode[] {
  const pages: HtmlNode[] = []
  const visit = (current: HtmlNode): void => {
    for (const child of current.children) {
      if (htmlPageDimensions(child)) {
        pages.push(child)
        continue
      }
      visit(child)
    }
  }
  visit(node)
  return pages
}

/**
 * 解析单个扫描件页面中的 SVG 文本区块。
 * @param page 页面节点。
 * @param input 解析输入。
 * @param pageId 页面标识。
 * @param startOrder 起始阅读顺序。
 * @returns 文本区块数组。
 * @author zhenghq
 */
function parseHtmlSvgBlocks(
  page: HtmlNode,
  input: DocumentParseInput,
  pageId: string,
  startOrder: number,
  pageWidth?: number
): DocumentTextBlock[] {
  const blocks: DocumentTextBlock[] = []
  const lines: SvgTextLine[] = []
  for (const svg of findHtmlNodes(page, new Set(['svg']))) {
    lines.push(...extractSvgTextLines(svg))
  }
  for (const paragraph of mergeSvgTextLinesIntoParagraphs(lines, pageWidth)) {
    const block = createTextBlock(
      input,
      pageId,
      startOrder + blocks.length,
      paragraph.text,
      'paragraph',
      paragraph.style ? { style: paragraph.style } : {}
    )
    if (paragraph.bbox) block.bbox = paragraph.bbox
    blocks.push(block)
  }
  return blocks
}

/**
 * 递归解析 HTML 语义内容，生成文本、表格和图片区块。
 * 源文栏由隔离 webview 原样展示文件，此模型只服务翻译与导出，不执行或加载原始资源。
 * @param node 当前节点。
 * @param context HTML 解析上下文。
 * @returns 区块数组。
 * @author zhenghq
 */
function parseHtmlBlocks(node: HtmlNode, context: {
  input: DocumentParseInput
  pageId: string
}): DocumentBlock[] {
  const blocks: DocumentBlock[] = []
  const blockTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'pre', 'caption'])
  const ignoredTags = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'button', 'input', 'textarea', 'select', 'canvas'])
  for (const child of node.children) {
    if (child.name === '#text') {
      const text = child.text?.trim() ?? ''
      if (text) blocks.push(createTextBlock(context.input, context.pageId, 0, text))
      continue
    }
    if (ignoredTags.has(child.name)) continue
    if (child.name === 'svg') continue
    if (child.name === 'table') {
      const rows = findHtmlNodes(child, new Set(['tr'])).map((rowNode, rowIndex) => ({
        rowId: createTableRowId(`table-${rowIndex}`, rowIndex),
        cells: rowNode.children
          .filter((cell) => cell.name === 'td' || cell.name === 'th')
          .map((cell, cellIndex): DocumentTableCell => {
            const text = htmlText(cell).replace(/\s+/gu, ' ').trim()
            return {
              cellId: createTableCellId(context.input.sha256, context.pageId, `table-${rowIndex}`, rowIndex, cellIndex),
              rowSpan: Number.parseInt(cell.attributes['rowspan'] ?? '1', 10) || 1,
              colSpan: Number.parseInt(cell.attributes['colspan'] ?? '1', 10) || 1,
              blocks: text ? [createTextBlock(context.input, context.pageId, 0, text)] : []
            }
          })
      }))
      blocks.push({
        kind: 'table',
        blockId: `table-${context.input.sha256.slice(0, 12)}-${context.pageId}`,
        readingOrder: 0,
        translatable: true,
        rows
      })
      continue
    }
    if (child.name === 'img' || child.name === 'br') continue
    if (blockTags.has(child.name)) {
      const text = htmlText(child).replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim()
      if (text) {
        const role: DocumentTextRole = /^h[1-6]$/u.test(child.name)
          ? 'heading'
          : child.name === 'li'
            ? 'list-item'
            : child.name === 'pre'
              ? 'code'
              : child.name === 'caption'
                ? 'caption'
                : 'paragraph'
        blocks.push(createTextBlock(
          context.input,
          context.pageId,
          blocks.length,
          text,
          role,
          { protected: child.name === 'pre' }
        ))
      }
      continue
    }
    blocks.push(...parseHtmlBlocks(child, context))
  }
  return blocks
}

/**
 * 解析 HTML 文档的可翻译语义内容。
 * 源文预览直接加载原始文件，因此这里不生成资源清理告警；脚本、框架和事件属性
 * 仅从翻译模型中排除，不会被复制到译文渲染 DOM。
 * @param input 解析输入。
 * @returns HTML 文档模型。
 * @author zhenghq
 */
export function parseHtmlDocument(input: DocumentParseInput): DocumentModel {
  const html = decodeDocumentText(input.bytes)
  const tree = parseHtmlTree(html)
  const titleNode = findHtmlNodes(tree, new Set(['title']))[0]
  const title = titleNode ? htmlText(titleNode).trim() : undefined
  const body = findHtmlNodes(tree, new Set(['body']))[0] ?? tree
  const model = createDocumentModel(input, title ? { title } : {})
  const pageContainers = findHtmlPageContainers(body)
  if (pageContainers.length === 0) {
    const blocks = parseHtmlBlocks(body, {
      input,
      pageId: model.pages[0]!.pageId
    })
    // 非分页 HTML 没有可靠的页面边界，保留原单页流式行为，仅附加 SVG 文本。
    for (const svg of findHtmlNodes(body, new Set(['svg']))) {
      for (const line of extractSvgTextLines(svg)) {
        const block = createTextBlock(
          input,
          model.pages[0]!.pageId,
          blocks.length,
          line.text,
          'paragraph',
          line.style ? { style: line.style } : {}
        )
        if (line.bbox) block.bbox = line.bbox
        blocks.push(block)
      }
    }
    model.pages[0]!.blocks = limitDocumentBlocks(blocks, model.warnings)
    return model
  }

  const pages: DocumentPage[] = pageContainers.map((container, pageIndex) => {
    const dimensions = htmlPageDimensions(container)!
    const pageId = createDocumentPageId(input.sha256, pageIndex)
    const blocks = parseHtmlSvgBlocks(container, input, pageId, 0, dimensions.width)
    const page: DocumentPage = {
      pageId,
      index: pageIndex,
      width: dimensions.width,
      height: dimensions.height,
      blocks: limitDocumentBlocks(blocks, model.warnings)
    }
    if (dimensions.background) {
      page.background = { kind: 'solid', color: dimensions.background }
    }
    return page
  })
  model.pages = pages
  model.source.pageCount = pages.length
  return model
}

/**
 * 导出 Markdown 行内受保护片段，供后续翻译流水线复用的稳定约定。
 * @param block 文本区块。
 * @returns 可翻译文本与保护片段。
 * @author zhenghq
 */
export function getMarkdownProtectedRuns(block: DocumentTextBlock): DocumentTextRun[] {
  return block.runs.filter((run) => run.protected === true)
}
