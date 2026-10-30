import {
  createDocumentBlockId,
  createDocumentPageId,
  type DocumentBlock,
  type DocumentBoundingBox,
  type DocumentImageBlock,
  type DocumentListInfo,
  type DocumentModel,
  type DocumentPage,
  type DocumentTableBlock,
  type DocumentTableCell,
  type DocumentTableRow,
  type DocumentTextBlock,
  type DocumentTextRole,
  type DocumentTextRun,
  type DocumentTextStyle,
  type DocumentWarning
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
  // 路径规则只匹配盘符、UNC 或明确的相对路径起点，避免把 5s/10s、真人/动画等普通斜杠文本保护成路径。
  const pattern = /<!--[\s\S]*?-->|`[^`]*`|!\[([^\]]*)\]\(([^)]*)\)|\[([^\]]*)\]\(([^)]*)\)|<\/?([a-z][a-z0-9:-]*)(?:\s[^>]*)?>|https?:\/\/[^\s<>)\]]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|[a-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*|\\\\[^\\\s]+\\[^\\\s]+(?:\\[^\\/:*?"<>|\r\n]*)*|(?:\/{1,2}|\.{1,2}\/)[A-Za-z_.~][^\s<>)\]]*|(\*\*|__)(?=\S)|(?<=\S)(\*\*|__)|(?<!\*)\*(?=\S)|(?<=\S)\*(?!\*)/giu
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

/** EPUB 章节图片解析结果。 */
export interface HtmlDocumentImage {
  /** 已登记资源的稳定标识。 */
  assetId: string
  /** 图片替代文本。 */
  alt?: string
}

/** HTML/EPUB 语义解析的受控扩展选项。 */
export interface HtmlDocumentParseOptions {
  /** 额外样式表；仅接受已净化且不含资源型规则的普通声明。 */
  css?: string[]
  /** 将包内相对图片解析为已登记资源；返回 undefined 时忽略该图片。 */
  resolveImage?: (source: string) => HtmlDocumentImage | undefined
}

/** HTML 源文预览允许保留的标签白名单。 */
const HTML_PREVIEW_ALLOWED_TAGS = new Set([
  'html', 'head', 'body', 'title', 'style', 'article', 'section', 'main', 'header', 'footer', 'a',
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt',
  'dd', 'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
  'mark', 'small', 'sub', 'sup', 'br', 'hr', 'table', 'caption', 'thead', 'tbody', 'tfoot',
  'tr', 'th', 'td', 'colgroup', 'col', 'figure', 'figcaption', 'picture', 'img', 'video',
  'audio', 'source', 'track', 'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line',
  'polyline', 'polygon', 'text', 'tspan', 'defs', 'clipPath', 'use', 'symbol', 'title',
  'desc', 'details', 'summary'
])

/** HTML 源文预览中必须丢弃整个子树的高风险标签。 */
const HTML_PREVIEW_DROPPED_TAGS = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'link',
  'meta', 'form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'canvas',
  'template', 'noscript', 'portal', 'math', 'foreignObject'
])

/** 可保留的普通 HTML 属性白名单。 */
const HTML_PREVIEW_ALLOWED_ATTRIBUTES = new Set([
  'class', 'id', 'title', 'lang', 'dir', 'role', 'aria-label', 'aria-hidden', 'aria-describedby',
  'alt', 'width', 'height', 'colspan', 'rowspan', 'scope', 'headers', 'start', 'reversed',
  'datetime', 'cite', 'open', 'viewbox', 'preserveaspectratio', 'fill', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'points', 'transform', 'opacity', 'fill-opacity',
  'stroke-opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline'
])

/** 需要按 URL 规则净化的资源与链接属性。 */
const HTML_PREVIEW_URL_ATTRIBUTES = new Set([
  'href', 'src', 'poster', 'xlink:href', 'action', 'formaction'
])

/** CSS 属性白名单；只允许排版、颜色、边框和受控背景。 */
const HTML_PREVIEW_CSS_PROPERTIES = new Set([
  'color', 'background', 'background-color', 'font-family', 'font-size', 'font-style',
  'font-weight', 'font-variant', 'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-indent', 'text-transform', 'text-decoration', 'text-shadow',
  'vertical-align', 'white-space', 'word-break', 'overflow-wrap', 'direction', 'unicode-bidi',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border', 'border-top',
  'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style',
  'border-width', 'border-radius', 'border-collapse', 'border-spacing', 'background-clip',
  'background-origin', 'background-position', 'background-repeat', 'background-size',
  'list-style', 'list-style-type', 'list-style-position', 'table-layout', 'caption-side',
  'empty-cells', 'display', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items',
  'align-content', 'align-self', 'gap', 'row-gap', 'column-gap', 'grid-template-columns',
  'grid-template-rows', 'grid-column', 'grid-row', 'width', 'min-width', 'max-width', 'height',
  'min-height', 'max-height', 'box-sizing', 'object-fit', 'object-position', 'page-break-before',
  'page-break-after', 'page-break-inside', 'break-before', 'break-after', 'break-inside'
])

/** CSS 属性值中明确禁止的危险表达式与网络资源。 */
const HTML_PREVIEW_UNSAFE_CSS = /(?:expression\s*\(|@import|url\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:)/iu

/** 资源 URL 中的危险协议。 */
const HTML_PREVIEW_UNSAFE_URL_SCHEME = /^(?:javascript|vbscript|data|file|filesystem|blob|about):/iu

/**
 * 查找 HTML 标签的结束尖括号。
 * 合法属性引号中的 `<` 与 `>` 会被跳过；遇到下一个标签起始位置时，
 * 将未闭合的畸形属性视为在上一个 `>` 结束，防止其吞并后续真实节点。
 * @param html 原始 HTML。
 * @param start 标签起始位置。
 * @returns 结束尖括号位置；未闭合时返回 -1。
 * @author zhenghq
 */
function findHtmlTagEnd(html: string, start: number): number {
  let quote = ''
  let lastTagEnd = -1
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index]!
    if (quote) {
      if (character === quote) {
        quote = ''
      } else if (character === '>') {
        // 记录引号内的 `>` 作为畸形未闭合属性的回退边界，但继续等待合法闭合引号。
        lastTagEnd = index
      } else if (character === '<' && findNextHtmlTagStart(html, index) === index) {
        const closingQuote = html.indexOf(quote, index + 1)
        const nextTag = findNextHtmlTagStart(html, index + 1)
        if (closingQuote < 0 || (nextTag >= 0 && nextTag < closingQuote)) {
          return lastTagEnd >= 0 ? lastTagEnd : index - 1
        }
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      lastTagEnd = index
      return index
    }
  }
  return lastTagEnd
}

/**
 * 查找下一个可能开始 HTML 标签的位置。
 * @param html 原始 HTML。
 * @param start 搜索起点。
 * @returns 下一个标签起始位置；不存在时返回 -1。
 * @author zhenghq
 */
function findNextHtmlTagStart(html: string, start: number): number {
  for (let index = start; index < html.length; index += 1) {
    if (html[index] !== '<') continue
    const next = html[index + 1] ?? ''
    if (/[a-z!?]/iu.test(next) || (next === '/' && /[a-z]/iu.test(html[index + 2] ?? ''))) return index
  }
  return -1
}

/**
 * 安全解析 HTML 为简化节点树，不执行脚本，也不创建 DOM。
 * 解析器按引号感知方式读取标签，避免属性值中的 `<svg>` 被误识别为真实节点。
 * @param html HTML 文本。
 * @returns 根节点。
 * @author zhenghq
 */
function parseHtmlTree(html: string): HtmlNode {
  const root: HtmlNode = { name: '#root', attributes: {}, children: [] }
  const stack: HtmlNode[] = [root]
  let cursor = 0
  while (cursor < html.length) {
    const tagStart = findNextHtmlTagStart(html, cursor)
    if (tagStart < 0) {
      const text = decodeHtmlEntities(html.slice(cursor))
      // 保留空白文本节点，源文预览才能维持 inline 元素之间的自然间距；
      // 翻译模型仍会在提取区块时自行 trim，不会把纯空白送去翻译。
      stack[stack.length - 1]!.children.push({ name: '#text', text, attributes: {}, children: [] })
      break
    }
    if (tagStart > cursor) {
      const text = decodeHtmlEntities(html.slice(cursor, tagStart))
      stack[stack.length - 1]!.children.push({ name: '#text', text, attributes: {}, children: [] })
    }
    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4)
      cursor = commentEnd < 0 ? html.length : commentEnd + 3
      continue
    }
    const tagEnd = findHtmlTagEnd(html, tagStart)
    if (tagEnd < 0) {
      const text = decodeHtmlEntities(html.slice(tagStart))
      stack[stack.length - 1]!.children.push({ name: '#text', text, attributes: {}, children: [] })
      break
    }
    const token = html.slice(tagStart, tagEnd + 1)
    cursor = tagEnd + 1
    // XML 声明、处理指令和 DOCTYPE 都只属于文档元数据，不能作为可见正文进入翻译模型。
    if (token.startsWith('<!') || token.startsWith('<?')) continue
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
    const tagMatch = /^<([a-z][a-z0-9:-]*)([\s\S]*)$/iu.exec(token.slice(0, -1))
    if (!tagMatch) continue
    const isSelfClosing = /\/\s*>$/u.test(token)
    const rawAttributes = tagMatch[2] ?? ''
    const hasUnclosedAttributeQuote = (() => {
      let quote = ''
      for (let index = 0; index < rawAttributes.length; index += 1) {
        const character = rawAttributes[index]!
        if (quote) {
          if (character === quote) quote = ''
        } else if (character === '"' || character === "'") {
          quote = character
        }
      }
      return quote.length > 0
    })()
    // 未闭合属性属于畸形输入；丢弃该标签及其属性残片，避免属性内容被当作真实节点。
    if (hasUnclosedAttributeQuote) continue
    const name = tagMatch[1]!.toLowerCase()
    const attributes: Record<string, string> = {}
    const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu
    let attribute: RegExpExecArray | null
    while ((attribute = attributePattern.exec(rawAttributes)) !== null) {
      attributes[attribute[1]!.toLowerCase()] = decodeHtmlEntities(
        attribute[2] ?? attribute[3] ?? attribute[4] ?? ''
      )
    }
    const node: HtmlNode = { name, attributes, children: [] }
    stack[stack.length - 1]!.children.push(node)
    if (!isSelfClosing && !['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'].includes(name)) {
      stack.push(node)
    }
  }
  return root
}

/**
 * 将文本转义为可安全写入 HTML 正文的内容。
 * @param value 原始文本。
 * @returns 转义后的文本。
 * @author zhenghq
 */
function escapeHtmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

/**
 * 将文本转义为可安全写入双引号 HTML 属性的值。
 * @param value 原始属性值。
 * @returns 转义后的属性值。
 * @author zhenghq
 */
function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/gu, '&quot;')
}

/**
 * 归一化 URL 中的空白和控制字符，避免通过字符夹带绕过协议检查。
 * @param value 原始 URL。
 * @returns 去除首尾空白及内部控制字符后的 URL。
 * @author zhenghq
 */
function normalizeHtmlUrl(value: string): string {
  return value
    .replace(/[\u0000-\u0020\u007f]+/gu, '')
    .trim()
}

/**
 * 判断资源 URL 是否为允许的包内相对路径。
 * @param value 已归一化的 URL。
 * @returns 不含协议、网络定位或脚本伪协议时返回 true。
 * @author zhenghq
 */
function isSafeRelativeResourceUrl(value: string): boolean {
  if (!value || value.startsWith('//') || value.startsWith('\\\\')) return false
  if (value.startsWith('#') || value.startsWith('?')) return true
  return !/^[a-z][a-z0-9+.-]*:/iu.test(value)
}

/**
 * 判断普通链接 URL 是否安全；允许 HTTP(S)、邮件、电话、锚点和相对链接。
 * @param value 已归一化的 URL。
 * @returns 可安全写入 href 时返回 true。
 * @author zhenghq
 */
function isSafeLinkUrl(value: string): boolean {
  if (isSafeRelativeResourceUrl(value)) return true
  return /^(?:https?:|mailto:|tel:)/iu.test(value)
}

/**
 * 判断 URL 是否为远程网络资源。
 * @param value 已归一化的 URL。
 * @returns 使用 HTTP(S) 或协议相对地址时返回 true。
 * @author zhenghq
 */
function isRemoteResourceUrl(value: string): boolean {
  return /^(?:https?:)?\/\//iu.test(value)
}

/**
 * 按声明边界拆分 CSS，避免引号或函数中的分号被错误截断。
 * @param value CSS 声明文本。
 * @returns 去除空项后的声明数组。
 * @author zhenghq
 */
function splitCssDeclarations(value: string): string[] {
  const declarations: string[] = []
  let start = 0
  let quote = ''
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') depth += 1
    else if (character === ')' && depth > 0) depth -= 1
    else if (character === ';' && depth === 0) {
      const declaration = value.slice(start, index).trim()
      if (declaration) declarations.push(declaration)
      start = index + 1
    }
  }
  const tail = value.slice(start).trim()
  if (tail) declarations.push(tail)
  return declarations
}

/**
 * 判断 CSS 值是否含有可加载资源、执行脚本或逃逸样式块的危险内容。
 * @param value 已去除首尾空白的 CSS 值。
 * @returns 可安全保留时返回 true。
 * @author zhenghq
 */
function isSafeCssValue(value: string): boolean {
  if (!value || value.length > 2000) return false
  if (HTML_PREVIEW_UNSAFE_CSS.test(value)) return false
  // 反斜杠可把 url、expression 等关键字拆开，受控预览不接受 CSS 转义。
  if (/[\\<>{}@]/u.test(value)) return false
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return false
  return true
}

/**
 * 按属性白名单净化 CSS 声明，并保留安全的排版与颜色规则。
 * @param css 内联或样式表中的声明文本。
 * @param warnings 告警收集数组。
 * @returns 只包含白名单属性的声明文本。
 * @author zhenghq
 */
function sanitizeCssDeclarations(css: string, warnings: DocumentWarning[]): string {
  const safe: string[] = []
  for (const declaration of splitCssDeclarations(css.replace(/\/\*[\s\S]*?\*\//gu, ''))) {
    const separator = declaration.indexOf(':')
    if (separator <= 0) {
      if (declaration.trim()) addHtmlSanitizeWarning(warnings, 'unsafe-html-removed')
      continue
    }
    const property = declaration.slice(0, separator).trim().toLowerCase()
    const value = declaration.slice(separator + 1).trim()
    if (!HTML_PREVIEW_CSS_PROPERTIES.has(property) || !isSafeCssValue(value)) {
      addHtmlSanitizeWarning(warnings, 'unsafe-html-removed')
      if (HTML_PREVIEW_UNSAFE_CSS.test(value) && /url\s*\(/iu.test(value)) {
        addHtmlSanitizeWarning(warnings, 'remote-resource-removed')
      }
      continue
    }
    safe.push(`${property}: ${value}`)
  }
  return safe.join('; ')
}

/**
 * 删除样式表中的全部 at-rule。
 * 支持分号结尾与块结尾两类规则，并在跳过块时感知引号和括号，
 * 避免 `@import` 后的首个普通规则被错误吞掉。
 * @param css 已移除注释的样式表。
 * @param warnings 告警收集数组。
 * @returns 仅含普通规则候选的样式表。
 * @author zhenghq
 */
function removeCssAtRules(css: string, warnings: DocumentWarning[]): string {
  let result = ''
  let cursor = 0
  while (cursor < css.length) {
    const atIndex = css.indexOf('@', cursor)
    if (atIndex < 0) {
      result += css.slice(cursor)
      break
    }
    result += css.slice(cursor, atIndex)
    addHtmlSanitizeWarning(warnings, 'unsafe-html-removed')
    let quote = ''
    let parentheses = 0
    let braces = 0
    let index = atIndex + 1
    for (; index < css.length; index += 1) {
      const character = css[index]!
      if (quote) {
        if (character === '\\') index += 1
        else if (character === quote) quote = ''
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
      } else if (character === '(') {
        parentheses += 1
      } else if (character === ')' && parentheses > 0) {
        parentheses -= 1
      } else if (character === '{' && parentheses === 0) {
        braces += 1
      } else if (character === '}' && parentheses === 0 && braces > 0) {
        braces -= 1
        if (braces === 0) {
          index += 1
          break
        }
      } else if (character === ';' && parentheses === 0 && braces === 0) {
        index += 1
        break
      }
    }
    cursor = index
  }
  return result
}

/**
 * 将普通 CSS 样式表拆分为选择器与声明块。
 * 只接受顶层花括号规则；嵌套结构、未闭合规则和规则外垃圾均不会进入输出。
 * @param css 已移除 at-rule 的样式表。
 * @returns 选择器与声明块数组。
 * @author zhenghq
 */
function parseCssStyleRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = []
  let cursor = 0
  while (cursor < css.length) {
    const openBrace = css.indexOf('{', cursor)
    if (openBrace < 0) break
    const selector = css.slice(cursor, openBrace).trim()
    let quote = ''
    let parentheses = 0
    let depth = 1
    let closeBrace = -1
    for (let index = openBrace + 1; index < css.length; index += 1) {
      const character = css[index]!
      if (quote) {
        if (character === '\\') index += 1
        else if (character === quote) quote = ''
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
      } else if (character === '(') {
        parentheses += 1
      } else if (character === ')' && parentheses > 0) {
        parentheses -= 1
      } else if (parentheses === 0 && character === '{') {
        depth += 1
      } else if (parentheses === 0 && character === '}') {
        depth -= 1
        if (depth === 0) {
          closeBrace = index
          break
        }
      }
    }
    if (closeBrace < 0) break
    rules.push({ selector, body: css.slice(openBrace + 1, closeBrace) })
    cursor = closeBrace + 1
  }
  return rules
}

/**
 * 净化样式表，删除资源型 at-rule 并逐条过滤声明。
 * @param css 样式表文本。
 * @param warnings 告警收集数组。
 * @returns 可安全放入 style 标签的样式表。
 * @author zhenghq
 */
function sanitizeCssStylesheet(css: string, warnings: DocumentWarning[]): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, '')
  // 所有 at-rule 都可能引入字体、资源、动画或嵌套逃逸；首版预览只保留普通样式规则。
  const withoutAtRules = removeCssAtRules(withoutComments, warnings)
  return parseCssStyleRules(withoutAtRules).map(({ selector, body }) => {
    const safeSelector = selector.trim()
    if (!safeSelector || safeSelector.length > 1000 || /[<>{}@\\\u0000-\u001f\u007f]/u.test(safeSelector)) {
      addHtmlSanitizeWarning(warnings, 'unsafe-html-removed')
      return ''
    }
    const declarations = sanitizeCssDeclarations(body, warnings)
    return declarations ? `${safeSelector}{${declarations}}` : ''
  }).join('')
}

/**
 * 净化 EPUB 章节样式表，保留普通排版规则并移除资源型 at-rule。
 * @param css 样式表文本。
 * @returns 可安全解析的样式表与去重告警。
 * @author zhenghq
 */
export function sanitizeDocumentCss(css: string): { css: string; warnings: DocumentWarning[] } {
  const warnings: DocumentWarning[] = []
  return { css: sanitizeCssStylesheet(css, warnings), warnings }
}

/**
 * 添加去重后的 HTML 净化告警。
 * @param warnings 告警收集数组。
 * @param code 稳定告警码。
 * @author zhenghq
 */
function addHtmlSanitizeWarning(warnings: DocumentWarning[], code: 'remote-resource-removed' | 'unsafe-html-removed'): void {
  if (warnings.some((warning) => warning.code === code)) return
  warnings.push(createDocumentWarning(
    code,
    code === 'remote-resource-removed'
      ? 'Remote resources were removed from the HTML preview.'
      : 'Unsafe HTML or CSS was removed from the preview.'
  ))
}

/**
 * 净化 srcset 候选列表，只保留安全的包内相对资源。
 * @param value 原始 srcset。
 * @param warnings 告警收集数组。
 * @returns 安全的 srcset；没有候选时返回 undefined。
 * @author zhenghq
 */
function sanitizeSrcset(value: string, warnings: DocumentWarning[]): string | undefined {
  const candidates: string[] = []
  for (const candidate of value.split(',')) {
    const parts = candidate.trim().split(/\s+/u)
    const url = normalizeHtmlUrl(parts[0] ?? '')
    if (!url) continue
    if (isRemoteResourceUrl(url)) {
      addHtmlSanitizeWarning(warnings, 'remote-resource-removed')
      continue
    }
    if (HTML_PREVIEW_UNSAFE_URL_SCHEME.test(url) || !isSafeRelativeResourceUrl(url)) {
      addHtmlSanitizeWarning(warnings, 'unsafe-html-removed')
      continue
    }
    candidates.push([url, ...parts.slice(1)].join(' '))
  }
  return candidates.length > 0 ? candidates.join(', ') : undefined
}

/**
 * 按元素类型净化单个属性值。
 * @param tagName 小写标签名。
 * @param name 小写属性名。
 * @param value 已解码的属性值。
 * @param warnings 告警收集数组。
 * @returns 可保留的属性值；应删除属性时返回 undefined。
 * @author zhenghq
 */
function sanitizeHtmlAttribute(
  tagName: string,
  name: string,
  value: string,
  warnings: DocumentWarning[]
): string | undefined {
  if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'action') {
    addHtmlSanitizeWarning(warnings, 'unsafe-html-removed')
    return undefined
  }
  if (name === 'style') {
    const style = sanitizeCssDeclarations(value, warnings)
    return style || undefined
  }
  if (name === 'srcset' || name === 'imagesrcset') return sanitizeSrcset(value, warnings)
  if (HTML_PREVIEW_URL_ATTRIBUTES.has(name)) {
    const normalized = normalizeHtmlUrl(value)
    if (!normalized) return undefined
    if (HTML_PREVIEW_UNSAFE_URL_SCHEME.test(normalized) || normalized.startsWith('//')) {
      addHtmlSanitizeWarning(warnings, 'unsafe-html-removed')
      return undefined
    }
    if (tagName === 'a' && name === 'href') {
      if (!isSafeLinkUrl(normalized)) {
        addHtmlSanitizeWarning(warnings, 'unsafe-html-removed')
        return undefined
      }
      return normalized
    }
    if (isRemoteResourceUrl(normalized)) {
      addHtmlSanitizeWarning(warnings, 'remote-resource-removed')
      return undefined
    }
    if (!isSafeRelativeResourceUrl(normalized)) {
      addHtmlSanitizeWarning(warnings, 'unsafe-html-removed')
      return undefined
    }
    return normalized
  }
  if (name === 'fill' || name === 'stroke') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'none' || normalized === 'currentcolor' || SAFE_MARKDOWN_COLOR.test(normalized)) return value.trim()
    addHtmlSanitizeWarning(warnings, 'unsafe-html-removed')
    return undefined
  }
  if (HTML_PREVIEW_ALLOWED_ATTRIBUTES.has(name)) {
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      addHtmlSanitizeWarning(warnings, 'unsafe-html-removed')
      return undefined
    }
    return value
  }
  // data-* 只用于受控布局标记，不接收任意自定义属性。
  if (name.startsWith('data-') && /^[a-z0-9_-]+$/iu.test(name) && !/[\u0000-\u001f\u007f]/u.test(value)) {
    return value
  }
  return undefined
}

/**
 * 递归序列化受控 HTML 节点，未知标签仅保留子内容。
 * @param node 当前节点。
 * @param warnings 告警收集数组。
 * @returns 安全 HTML 片段。
 * @author zhenghq
 */
function serializeSafeHtmlNode(node: HtmlNode, warnings: DocumentWarning[]): string {
  if (node.name === '#text') return escapeHtmlText(node.text ?? '')
  if (HTML_PREVIEW_DROPPED_TAGS.has(node.name)) {
    addHtmlSanitizeWarning(warnings, 'unsafe-html-removed')
    return ''
  }
  if (!HTML_PREVIEW_ALLOWED_TAGS.has(node.name)) {
    return node.children.map((child) => serializeSafeHtmlNode(child, warnings)).join('')
  }
  const attributes: string[] = []
  for (const [name, value] of Object.entries(node.attributes)) {
    const safeValue = sanitizeHtmlAttribute(node.name, name, value, warnings)
    if (safeValue !== undefined) attributes.push(`${name}="${escapeHtmlAttribute(safeValue)}"`)
  }
  if (node.name === 'style') {
    const css = sanitizeCssStylesheet(htmlText(node), warnings)
    return css ? `<style>${css}</style>` : ''
  }
  const attributeText = attributes.length > 0 ? ` ${attributes.join(' ')}` : ''
  if (['area', 'br', 'col', 'hr', 'img', 'source', 'track', 'wbr', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'use'].includes(node.name)) {
    return `<${node.name}${attributeText}>`
  }
  const children = node.children.map((child) => serializeSafeHtmlNode(child, warnings)).join('')
  return `<${node.name}${attributeText}>${children}</${node.name}>`
}

/**
 * 将任意 HTML 文档净化成可交给隔离 webview 的受控预览。
 * 脚本、框架、表单、远程资源、事件属性与危险 URL 均不会进入输出。
 * @param html 原始 HTML 文本。
 * @returns 净化后的完整 HTML 与去重告警。
 * @author zhenghq
 */
export function sanitizeHtmlPreview(html: string): { html: string; warnings: DocumentWarning[] } {
  const root = parseHtmlTree(html)
  const warnings: DocumentWarning[] = []
  const htmlNode = root.children.find((node) => node.name === 'html')
  const htmlAttributes = htmlNode
    ? Object.entries(htmlNode.attributes)
      .map(([name, value]) => sanitizeHtmlAttribute('html', name, value, warnings))
      .filter((value): value is string => value !== undefined)
    : []
  const headNode = (htmlNode ?? root).children.find((node) => node.name === 'head')
  const bodyNode = (htmlNode ?? root).children.find((node) => node.name === 'body')
  const headNodes = headNode?.children ?? []
  const bodyNodes = bodyNode?.children ?? (htmlNode
    ? htmlNode.children.filter((node) => node.name !== 'head' && node.name !== 'body')
    : root.children.filter((node) => node.name !== 'head'))
  const head = headNodes.map((node) => serializeSafeHtmlNode(node, warnings)).join('')
  const body = bodyNodes.map((node) => serializeSafeHtmlNode(node, warnings)).join('')
  const bodyAttributes = bodyNode
    ? Object.entries(bodyNode.attributes)
      .map(([name, value]) => sanitizeHtmlAttribute('body', name, value, warnings))
      .filter((value): value is string => value !== undefined)
    : []
  const htmlAttributeText = htmlAttributes.length > 0 ? ` ${htmlAttributes.join(' ')}` : ''
  const bodyAttributeText = bodyAttributes.length > 0 ? ` ${bodyAttributes.join(' ')}` : ''
  return {
    html: `<!doctype html><html${htmlAttributeText}><head>${head}</head><body${bodyAttributeText}>${body}</body></html>`,
    warnings
  }
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
 * 规范化受控 CSS 字体族，去除字体名称外层引号并保留逗号分隔的回退顺序。
 * @param value 原始 font-family 属性值。
 * @returns 适合写入文档模型的字体族；无有效内容时返回 undefined。
 * @author zhenghq
 */
function normalizeCssFontFamily(value: string | undefined): string | undefined {
  if (!value) return undefined
  const sanitized = value.replace(/[;{}<>]/gu, '').trim()
  if (!sanitized) return undefined
  const families: string[] = []
  let current = ''
  let quote = ''
  for (const character of sanitized) {
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? '' : character
      current += character
      continue
    }
    if (character === ',' && !quote) {
      families.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  families.push(current.trim())
  const normalized = families
    .map((family) => family.replace(/^(["'])([\s\S]*)\1$/u, '$2').trim())
    .filter(Boolean)
    .join(', ')
  return normalized ? normalized.slice(0, 200) : undefined
}

/**
 * 将受控 CSS 声明转换为文档样式。
 * @param style CSS 声明文本。
 * @returns 仅包含白名单字段的样式。
 * @author zhenghq
 */
function documentTextStyleFromCss(style: string | undefined): DocumentTextStyle | undefined {
  if (!style) return undefined
  const fontSize = inlineStylePixels(style, 'font-size')
  const color = inlineStyleColor(style, 'color')
  const backgroundColor = inlineStyleColor(style, 'background-color')
  const rawFontFamily = normalizeCssFontFamily(cssDeclarationValue(style, 'font-family'))
  const rawFontWeight = cssDeclarationValue(style, 'font-weight')?.toLowerCase()
  const numericWeight = Number.parseInt(rawFontWeight ?? '', 10)
  const fontWeight = Number.isFinite(numericWeight)
    ? numericWeight
    : rawFontWeight === 'bold'
      ? 700
      : rawFontWeight === 'normal'
        ? 400
        : undefined
  const fontStyle = cssDeclarationValue(style, 'font-style')?.toLowerCase()
  const textDecoration = cssDeclarationValue(style, 'text-decoration')?.toLowerCase()
  const result: DocumentTextStyle = {
    ...(rawFontFamily ? { fontFamily: rawFontFamily } : {}),
    ...(fontSize === undefined ? {} : { fontSize }),
    ...(fontWeight === undefined ? {} : { fontWeight }),
    ...(color ? { color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(fontStyle === 'italic' || fontStyle === 'oblique' ? { italic: true } : {}),
    ...(textDecoration?.includes('underline') ? { underline: true } : {}),
    ...(textDecoration?.includes('line-through') ? { strikethrough: true } : {})
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * 读取 CSS 声明中的单个属性值。
 * @param style CSS 声明文本。
 * @param property 小写属性名。
 * @returns 原始属性值。
 * @author zhenghq
 */
function cssDeclarationValue(style: string | undefined, property: string): string | undefined {
  if (!style) return undefined
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':')
    if (separator < 0 || declaration.slice(0, separator).trim().toLowerCase() !== property) continue
    return declaration.slice(separator + 1).trim()
  }
  return undefined
}

/**
 * 合并继承、样式表与内联样式；后者覆盖前者。
 * @param styles 按优先级从低到高的样式。
 * @returns 合并后的样式。
 * @author zhenghq
 */
function mergeDocumentTextStyles(...styles: Array<DocumentTextStyle | undefined>): DocumentTextStyle | undefined {
  const merged = Object.assign({}, ...styles.filter((style): style is DocumentTextStyle => Boolean(style))) as DocumentTextStyle
  return Object.keys(merged).length > 0 ? merged : undefined
}

/** 已解析的受控 HTML CSS 规则。 */
interface HtmlCssRule {
  /** 逗号分隔后的单个选择器，按空格拆成后代匹配片段。 */
  selectorParts: string[]
  /** 规则中的受控文本样式。 */
  style?: DocumentTextStyle
  /** 规则中的文本对齐方式。 */
  textAlign?: DocumentTextBlock['textAlign']
  /** CSS 优先级，用于稳定覆盖。 */
  specificity: number
  /** 原始规则顺序。 */
  order: number
}

/**
 * 解析受控 CSS 文本对齐值。
 * @param style CSS 声明文本。
 * @returns 文档模型支持的文本对齐方式。
 * @author zhenghq
 */
function documentTextAlignFromCss(style: string | undefined): DocumentTextBlock['textAlign'] | undefined {
  const value = cssDeclarationValue(style, 'text-align')?.toLowerCase()
  return value === 'left' || value === 'center' || value === 'right' || value === 'justify'
    ? value
    : undefined
}

/**
 * 计算简单选择器的 CSS 优先级。
 * @param selector 选择器文本。
 * @returns 数值优先级。
 * @author zhenghq
 */
function cssSelectorSpecificity(selector: string): number {
  const ids = selector.match(/#[a-z0-9_-]+/giu)?.length ?? 0
  const classes = selector.match(/\.[a-z0-9_-]+/giu)?.length ?? 0
  const tags = selector.match(/(?:^|\s)([a-z][a-z0-9-]*)/giu)?.length ?? 0
  return ids * 100 + classes * 10 + tags
}

/**
 * 判断选择器片段是否只包含受支持的类型、类、ID 与通配符。
 * @param selector 单个选择器片段。
 * @returns 可安全匹配时返回 true。
 * @author zhenghq
 */
function isSupportedCssSelector(selector: string): boolean {
  return /^(?:(?:[a-z][a-z0-9-]*|\*)?(?:[.#][a-z0-9_-]+)*)$/iu.test(selector) &&
    selector !== '' && selector !== '.'
}

/**
 * 解析样式表中的普通规则，并丢弃无法安全匹配的选择器。
 * @param css 已净化样式表。
 * @returns 受控规则数组。
 * @author zhenghq
 */
function parseDocumentCssRules(css: string): HtmlCssRule[] {
  const warnings: DocumentWarning[] = []
  const rules: HtmlCssRule[] = []
  let order = 0
  for (const rule of parseCssStyleRules(css.replace(/\/\*[\s\S]*?\*\//gu, ''))) {
    const declarations = sanitizeCssDeclarations(rule.body, warnings)
    const style = documentTextStyleFromCss(declarations)
    const textAlign = documentTextAlignFromCss(declarations)
    if (!style && !textAlign) continue
    for (const selector of rule.selector.split(',')) {
      const parts = selector.trim().split(/\s+/u).filter(Boolean)
      if (parts.length === 0 || parts.some((part) => !isSupportedCssSelector(part))) continue
      rules.push({
        selectorParts: parts,
        ...(style ? { style } : {}),
        ...(textAlign ? { textAlign } : {}),
        specificity: cssSelectorSpecificity(selector),
        order
      })
      order += 1
    }
  }
  return rules
}

/**
 * 判断节点是否匹配单个简单选择器。
 * @param node HTML 节点。
 * @param selector 简单选择器。
 * @returns 匹配时返回 true。
 * @author zhenghq
 */
function matchesSimpleCssSelector(node: HtmlNode, selector: string): boolean {
  const tag = /^([a-z][a-z0-9-]*|\*)/iu.exec(selector)?.[1]?.toLowerCase()
  if (tag && tag !== '*' && node.name !== tag) return false
  const ids = selector.match(/#([a-z0-9_-]+)/giu)?.map((value) => value.slice(1)) ?? []
  if (ids.some((id) => node.attributes.id !== id)) return false
  const classes = new Set((node.attributes.class ?? '').split(/\s+/u).filter(Boolean))
  const requiredClasses = selector.match(/\.([a-z0-9_-]+)/giu)?.map((value) => value.slice(1)) ?? []
  return requiredClasses.every((className) => classes.has(className))
}

/**
 * 判断节点是否匹配支持的后代选择器。
 * @param node 待匹配节点。
 * @param ancestors 从根到父节点的祖先链。
 * @param selectorParts 选择器片段。
 * @returns 匹配时返回 true。
 * @author zhenghq
 */
function matchesCssSelector(node: HtmlNode, ancestors: HtmlNode[], selectorParts: string[]): boolean {
  let ancestorIndex = ancestors.length - 1
  for (let index = selectorParts.length - 1; index >= 0; index -= 1) {
    const part = selectorParts[index]!
    if (index === selectorParts.length - 1) {
      if (!matchesSimpleCssSelector(node, part)) return false
      continue
    }
    while (ancestorIndex >= 0 && !matchesSimpleCssSelector(ancestors[ancestorIndex]!, part)) {
      ancestorIndex -= 1
    }
    if (ancestorIndex < 0) return false
    ancestorIndex -= 1
  }
  return true
}

/**
 * 计算节点自身命中的样式表规则。
 * @param node HTML 节点。
 * @param ancestors 祖先链。
 * @param rules 已解析 CSS 规则。
 * @returns 合并后的样式与对齐方式。
 * @author zhenghq
 */
function matchedCssStyle(
  node: HtmlNode,
  ancestors: HtmlNode[],
  rules: HtmlCssRule[]
): { style?: DocumentTextStyle; textAlign?: DocumentTextBlock['textAlign'] } {
  const matched = rules
    .filter((rule) => matchesCssSelector(node, ancestors, rule.selectorParts))
    .sort((left, right) => left.specificity - right.specificity || left.order - right.order)
  const style = mergeDocumentTextStyles(...matched.map((rule) => rule.style))
  const textAlign = [...matched].reverse().find((rule) => rule.textAlign)?.textAlign
  return { ...(style ? { style } : {}), ...(textAlign ? { textAlign } : {}) }
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
  const fontFamily = normalizeCssFontFamily(rawFontFamily)
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
  cssRules?: HtmlCssRule[]
  resolveImage?: HtmlDocumentParseOptions['resolveImage']
  ancestors?: HtmlNode[]
  inheritedStyle?: DocumentTextStyle
  list?: {
    level: number
    ordered: boolean
    counters: Map<number, number>
    itemCount: number
    nestedItemCounts: Map<number, number>
  }
}): DocumentBlock[] {
  const blocks: DocumentBlock[] = []
  const blockTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'pre', 'caption'])
  const ignoredTags = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'button', 'input', 'textarea', 'select', 'canvas'])
  const ancestors = [...(context.ancestors ?? []), node]
  for (const child of node.children) {
    if (child.name === '#text') {
      const text = child.text?.trim() ?? ''
      if (text) {
        blocks.push(createTextBlock(context.input, context.pageId, blocks.length, text, 'paragraph', {
          ...(context.inheritedStyle ? { style: context.inheritedStyle } : {})
        }))
      }
      continue
    }
    if (ignoredTags.has(child.name)) continue
    if (child.name === 'svg') continue
    const cssStyle = context.cssRules ? matchedCssStyle(child, ancestors, context.cssRules) : {}
    const inlineStyle = documentTextStyleFromCss(child.attributes.style)
    const childStyle = mergeDocumentTextStyles(context.inheritedStyle, cssStyle.style, inlineStyle)
    const childTextAlign = documentTextAlignFromCss(child.attributes.style) ?? cssStyle.textAlign
    if (child.name === 'img') {
      const source = child.attributes.src?.trim()
      const image = source && context.resolveImage ? context.resolveImage(source) : undefined
      if (image) {
        const readingOrder = blocks.length
        const block: DocumentImageBlock = {
          kind: 'image',
          blockId: createDocumentBlockId(context.input.sha256, context.pageId, readingOrder, 'image'),
          readingOrder,
          translatable: false,
          assetId: image.assetId,
          ...(image.alt ? { alt: image.alt } : {})
        }
        blocks.push(block)
      }
      continue
    }
    if (child.name === 'table') {
      const rows = findHtmlNodes(child, new Set(['tr'])).map((rowNode, rowIndex) => ({
        rowId: createTableRowId(`table-${rowIndex}`, rowIndex),
        cells: rowNode.children
          .filter((cell) => cell.name === 'td' || cell.name === 'th')
          .map((cell, cellIndex): DocumentTableCell => {
            const text = htmlText(cell).replace(/\s+/gu, ' ').trim()
            const cellCssStyle = context.cssRules
              ? matchedCssStyle(cell, [...ancestors, child], context.cssRules)
              : {}
            const cellStyle = mergeDocumentTextStyles(
              childStyle,
              cellCssStyle.style,
              documentTextStyleFromCss(cell.attributes.style)
            )
            return {
              cellId: createTableCellId(context.input.sha256, context.pageId, `table-${rowIndex}`, rowIndex, cellIndex),
              rowSpan: Number.parseInt(cell.attributes['rowspan'] ?? '1', 10) || 1,
              colSpan: Number.parseInt(cell.attributes['colspan'] ?? '1', 10) || 1,
              blocks: text ? [createTextBlock(context.input, context.pageId, 0, text, 'paragraph', {
                ...(cellStyle ? { style: cellStyle } : {})
              })] : []
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
    if (child.name === 'br') continue
    if (child.name === 'ul' || child.name === 'ol') {
      const level = context.list ? context.list.level + 1 : 0
      const ordered = child.name === 'ol'
      const start = Number.parseInt(child.attributes.start ?? '1', 10)
      const counters = new Map(context.list?.counters ?? [])
      if (!counters.has(level)) counters.set(level, Number.isFinite(start) ? start : 1)
      blocks.push(...parseHtmlBlocks(child, {
        ...context,
        ancestors,
        ...(childStyle ? { inheritedStyle: childStyle } : {}),
        list: { level, ordered, counters, itemCount: 0, nestedItemCounts: new Map() }
      }))
      continue
    }
    const listInfo: DocumentListInfo | undefined = child.name === 'li' && context.list
      ? (() => {
          const level = context.list.level
          const current = (context.list.counters.get(level) ?? 1) + context.list.itemCount
          // 列表上下文在同级子节点之间共享；在生成当前项后立即递增，保证后续项序号连续。
          context.list.itemCount += 1
          return {
            level,
            marker: context.list.ordered ? `${current}.` : '•',
            ordered: context.list.ordered
          }
        })()
      : undefined
    if (blockTags.has(child.name) && !(child.name === 'li' && child.children.some((item) => item.name === 'ul' || item.name === 'ol'))) {
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
          {
            ...(childStyle ? { style: childStyle } : {}),
            ...(childTextAlign ? { textAlign: childTextAlign } : {}),
            ...(listInfo ? { list: listInfo } : {}),
            protected: child.name === 'pre'
          }
        ))
      }
      continue
    }
    blocks.push(...parseHtmlBlocks(child, {
      ...context,
      ancestors,
      ...(childStyle ? { inheritedStyle: childStyle } : {}),
      ...(context.list && child.name === 'li'
        ? {
            list: {
              ...context.list,
              nestedItemCounts: new Map(context.list.nestedItemCounts).set(
                context.list.level,
                (context.list.nestedItemCounts.get(context.list.level) ?? 0) + 1
              )
            }
          }
        : {})
    }))
  }
  return blocks
}

/**
 * 解析 HTML 文档的可翻译语义内容。
 * 源文预览会经过受控 HTML/CSS 净化，因此这里同时返回远程资源与危险内容清理告警；
 * 翻译模型只提取语义正文，不把脚本、框架和事件属性复制到译文渲染 DOM。
 * @param input 解析输入。
 * @param options 可选的受控 CSS 与包内图片解析扩展。
 * @returns HTML 文档模型。
 * @author zhenghq
 */
export function parseHtmlDocument(input: DocumentParseInput, options: HtmlDocumentParseOptions = {}): DocumentModel {
  const html = decodeDocumentText(input.bytes)
  const tree = parseHtmlTree(html)
  const titleNode = findHtmlNodes(tree, new Set(['title']))[0]
  const title = titleNode ? htmlText(titleNode).trim() : undefined
  const body = findHtmlNodes(tree, new Set(['body']))[0] ?? tree
  const model = createDocumentModel(input, title ? { title } : {})
  const cssWarnings: DocumentWarning[] = []
  const safeCss: string[] = []
  // 源文预览与后续 EPUB 章节共用同一净化规则，解析告警必须随模型返回，
  // 不能只在实际加载预览时才提示用户远程资源或危险内容已被移除。
  const preview = sanitizeHtmlPreview(html)
  for (const css of options.css ?? []) {
    const sanitized = sanitizeDocumentCss(css)
    if (sanitized.css) safeCss.push(sanitized.css)
    cssWarnings.push(...sanitized.warnings)
  }
  const cssRules = parseDocumentCssRules(safeCss.join('\n'))
  for (const warning of [...preview.warnings, ...cssWarnings]) {
    if (!model.warnings.some((existing) => existing.code === warning.code)) model.warnings.push(warning)
  }
  const pageContainers = findHtmlPageContainers(body)
  if (pageContainers.length === 0) {
    const blocks = parseHtmlBlocks(body, {
      input,
      pageId: model.pages[0]!.pageId,
      cssRules,
      ...(options.resolveImage ? { resolveImage: options.resolveImage } : {})
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
