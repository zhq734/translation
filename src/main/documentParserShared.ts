import { createHash } from 'node:crypto'
import {
  DOCUMENT_MODEL_SCHEMA_VERSION,
  createDocumentBlockId,
  createDocumentPageId,
  type DocumentAsset,
  type DocumentBlock,
  type DocumentFormat,
  type DocumentMetadata,
  type DocumentModel,
  type DocumentPage,
  type DocumentTextBlock,
  type DocumentTextRole,
  type DocumentTextRun,
  type DocumentTextStyle,
  type DocumentWarning
} from '../shared/documentTypes.ts'

/** 文本类流式文档使用的归一化页面宽度。 */
export const DOCUMENT_TEXT_PAGE_WIDTH = 816

/** 文本类流式文档使用的归一化页面高度。 */
export const DOCUMENT_TEXT_PAGE_HEIGHT = 1056

/** 单个文档包允许的最大解包字节数。 */
export const DOCUMENT_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024

/** 单个包内资源允许的最大字节数。 */
export const DOCUMENT_MAX_ENTRY_BYTES = 64 * 1024 * 1024

/** 文档包允许的最大压缩比，用于阻止压缩炸弹。 */
export const DOCUMENT_MAX_COMPRESSION_RATIO = 200

/** 文档解析允许的最大页数。 */
export const DOCUMENT_MAX_PAGES = 2000

/** 文档解析允许的最大图片资源数。 */
export const DOCUMENT_MAX_IMAGES = 1000

/** 文档解析允许的最大区块数。 */
export const DOCUMENT_MAX_BLOCKS = 100000

/** 所有解析器共用的输入结构。 */
export interface DocumentParseInput {
  /** 用户选择的本地绝对路径；解析器不得把该字段写入日志。 */
  path: string
  /** 面向界面的文件名。 */
  fileName: string
  /** 已探测的文档格式。 */
  format: DocumentFormat
  /** 文件内容 SHA-256。 */
  sha256: string
  /** 完整文件字节。 */
  bytes: Uint8Array
}

/** 创建文档模型时可覆盖的元数据。 */
export interface CreateDocumentModelOptions {
  /** 文档标题。 */
  title?: string
  /** 文档作者。 */
  author?: string
  /** 文档语言。 */
  language?: string
  /** 主要文字方向。 */
  direction?: DocumentMetadata['direction']
  /** 分页格式页数。 */
  pageCount?: number
  /** 页面宽度。 */
  pageWidth?: number
  /** 页面高度。 */
  pageHeight?: number
}

/** 资源解析结果。 */
export interface ParsedDocumentAsset {
  /** 资源模型。 */
  asset: DocumentAsset
  /** 资源原始字节；仅在本机解析和 OCR 链路使用。 */
  bytes: Uint8Array
}

/**
 * 计算字节内容的 SHA-256 十六进制摘要。
 * @param bytes 待计算字节。
 * @returns 小写十六进制摘要。
 * @author zhenghq
 */
export function hashDocumentBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 根据源文件指纹创建稳定的文档标识。
 * @param fingerprint 源文件 SHA-256 或测试指纹。
 * @returns 稳定文档标识。
 * @author zhenghq
 */
export function createDocumentModelId(fingerprint: string): string {
  return `document-${hashDocumentBytes(new TextEncoder().encode(fingerprint)).slice(0, 16)}`
}

/**
 * 创建不含正文的文档模型骨架。
 * @param input 解析输入。
 * @param options 可选元数据与页面尺寸。
 * @returns 尚未添加区块的文档模型。
 * @author zhenghq
 */
export function createDocumentModel(
  input: DocumentParseInput,
  options: CreateDocumentModelOptions = {}
): DocumentModel {
  const pageId = createDocumentPageId(input.sha256, 0)
  const page: DocumentPage = {
    pageId,
    index: 0,
    width: options.pageWidth ?? DOCUMENT_TEXT_PAGE_WIDTH,
    height: options.pageHeight ?? DOCUMENT_TEXT_PAGE_HEIGHT,
    blocks: []
  }
  if (options.title) page.title = options.title
  return {
    schemaVersion: DOCUMENT_MODEL_SCHEMA_VERSION,
    documentId: createDocumentModelId(input.sha256),
    source: {
      path: input.path,
      fileName: input.fileName,
      format: input.format,
      sha256: input.sha256,
      size: input.bytes.byteLength,
      ...(options.pageCount === undefined ? {} : { pageCount: options.pageCount })
    },
    metadata: {
      direction: options.direction ?? 'auto',
      ...(options.title ? { title: options.title } : {}),
      ...(options.author ? { author: options.author } : {}),
      ...(options.language ? { language: options.language } : {})
    },
    pages: [page],
    assets: [],
    warnings: []
  }
}

/**
 * 为指定页面创建稳定的文本片段标识。
 * @param blockId 所属区块标识。
 * @param index 片段索引。
 * @returns 稳定片段标识。
 * @author zhenghq
 */
export function createTextRunId(blockId: string, index: number): string {
  return `${blockId}-run-${index}`
}

/**
 * 为表格单元格创建稳定标识。
 * @param fingerprint 文档指纹。
 * @param pageId 页面标识。
 * @param tableBlockId 表格区块标识。
 * @param rowIndex 行索引。
 * @param cellIndex 单元格索引。
 * @returns 稳定单元格标识。
 * @author zhenghq
 */
export function createTableCellId(
  fingerprint: string,
  pageId: string,
  tableBlockId: string,
  rowIndex: number,
  cellIndex: number
): string {
  const digest = hashDocumentBytes(new TextEncoder().encode(
    `${fingerprint}\u0000${pageId}\u0000${tableBlockId}\u0000${rowIndex}\u0000${cellIndex}`
  )).slice(0, 16)
  return `cell-${digest}`
}

/**
 * 为表格行创建稳定标识。
 * @param tableBlockId 表格区块标识。
 * @param rowIndex 行索引。
 * @returns 稳定行标识。
 * @author zhenghq
 */
export function createTableRowId(tableBlockId: string, rowIndex: number): string {
  return `${tableBlockId}-row-${rowIndex}`
}

/**
 * 构造一个文本区块。
 * @param input 解析输入。
 * @param pageId 页面标识。
 * @param readingOrder 页面内阅读顺序。
 * @param text 区块文本。
 * @param role 语义角色。
 * @param options 可选样式、对齐和字幕元数据。
 * @returns 文本区块。
 * @author zhenghq
 */
export function createTextBlock(
  input: DocumentParseInput,
  pageId: string,
  readingOrder: number,
  text: string,
  role: DocumentTextRole = 'paragraph',
  options: {
    style?: DocumentTextStyle
    textAlign?: DocumentTextBlock['textAlign']
    timing?: string
    sequence?: number
    protected?: boolean
  } = {}
): DocumentTextBlock {
  const blockId = createDocumentBlockId(input.sha256, pageId, readingOrder, 'text')
  const run: DocumentTextRun = {
    runId: createTextRunId(blockId, 0),
    text: sanitizeDocumentText(text),
    ...(options.style ? { style: options.style } : {}),
    ...(options.protected ? { protected: true } : {})
  }
  return {
    kind: 'text',
    blockId,
    readingOrder,
    translatable: options.protected !== true,
    role,
    runs: [run],
    ...(options.style ? { style: options.style } : {}),
    ...(options.textAlign ? { textAlign: options.textAlign } : {}),
    ...(options.timing ? { timing: options.timing } : {}),
    ...(options.sequence === undefined ? {} : { sequence: options.sequence })
  }
}

/**
 * 构造一个带多个 run 的文本区块。
 * @param input 解析输入。
 * @param pageId 页面标识。
 * @param readingOrder 页面内阅读顺序。
 * @param runs 不含 runId 的文本片段。
 * @param role 语义角色。
 * @returns 文本区块。
 * @author zhenghq
 */
export function createMultiRunTextBlock(
  input: DocumentParseInput,
  pageId: string,
  readingOrder: number,
  runs: Array<Omit<DocumentTextRun, 'runId'>>,
  role: DocumentTextRole = 'paragraph'
): DocumentTextBlock {
  const blockId = createDocumentBlockId(input.sha256, pageId, readingOrder, 'text')
  return {
    kind: 'text',
    blockId,
    readingOrder,
    translatable: runs.some((run) => run.protected !== true && run.text.trim().length > 0),
    role,
    runs: runs.map((run, index) => ({
      ...run,
      text: sanitizeDocumentText(run.text),
      runId: createTextRunId(blockId, index)
    }))
  }
}

/**
 * 移除 NUL 和不允许出现在 XML/JSON 文本中的控制字符。
 * @param value 原始文本。
 * @returns 可安全序列化的文本。
 * @author zhenghq
 */
export function sanitizeDocumentText(value: string): string {
  return String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
}

/**
 * 将文本按空行切分为段落，并保留段内换行。
 * @param content 原始文本。
 * @returns 非空段落数组。
 * @author zhenghq
 */
export function splitTextParagraphs(content: string): string[] {
  return sanitizeDocumentText(content)
    .split(/\n[ \t]*\n+/u)
    .map((paragraph) => paragraph.replace(/^\n+|\n+$/gu, ''))
    .filter((paragraph) => paragraph.trim().length > 0)
}

/**
 * 解码文本文件，支持 UTF-8 BOM、UTF-16 LE/BE，并在严格 UTF-8 失败时尝试 GB18030。
 * @param bytes 文件字节。
 * @returns 解码后的文本。
 * @author zhenghq
 */
export function decodeDocumentText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}

/**
 * 解析 HTML/XML 实体。
 * @param value 含实体的文本。
 * @returns 解码后的文本。
 * @author zhenghq
 */
export function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/giu, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    return named[entity.toLowerCase()] ?? match
  })
}

/**
 * 生成脱敏的解析告警。
 * @param code 稳定告警码。
 * @param message 英文兜底说明；不得包含文件名、路径或正文，界面按 code 本地化。
 * @param options 可选严重级别、页面和区块关联。
 * @returns 文档告警。
 * @author zhenghq
 */
export function createDocumentWarning(
  code: string,
  message: string,
  options: Partial<Pick<DocumentWarning, 'severity' | 'pageId' | 'blockId'>> = {}
): DocumentWarning {
  return {
    code,
    severity: options.severity ?? 'warning',
    message,
    ...(options.pageId ? { pageId: options.pageId } : {}),
    ...(options.blockId ? { blockId: options.blockId } : {})
  }
}

/**
 * 将区块限制在文档统一上限内。
 * @param blocks 待限制区块。
 * @param warnings 告警数组，超限时追加告警。
 * @returns 上限内的区块。
 * @author zhenghq
 */
export function limitDocumentBlocks(
  blocks: DocumentBlock[],
  warnings: DocumentWarning[]
): DocumentBlock[] {
  if (blocks.length <= DOCUMENT_MAX_BLOCKS) return blocks
  warnings.push(createDocumentWarning(
    'block-limit-reached',
    'The document block limit was reached; remaining blocks were skipped.'
  ))
  return blocks.slice(0, DOCUMENT_MAX_BLOCKS)
}

/**
 * 将 MIME 类型映射为稳定的文件扩展名。
 * @param mimeType MIME 类型。
 * @returns 常用扩展名；未知类型返回 bin。
 * @author zhenghq
 */
export function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(';', 1)[0]!.trim()
  const extensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'application/pdf': 'pdf',
    'application/octet-stream': 'bin'
  }
  return extensions[normalized] ?? 'bin'
}
