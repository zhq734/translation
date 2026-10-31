import type { DocumentCapabilities, DocumentFormat } from './documentTypes.ts'

/** 单个文档允许的最大字节数，首版保守限制为 100 MB。 */
export const DOCUMENT_MAX_FILE_BYTES = 100 * 1024 * 1024

/** 文件选择阶段读取的尾部字节数，用于解析 ZIP 中央目录和 OOXML 条目。 */
export const DOCUMENT_ZIP_TAIL_BYTES = 1024 * 1024

/** 支持格式的扩展名白名单。 */
const EXTENSION_FORMATS: Readonly<Record<string, DocumentFormat>> = {
  pdf: 'pdf',
  docx: 'docx',
  epub: 'epub',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'txt',
  json: 'json',
  csv: 'csv',
  srt: 'srt',
  vtt: 'vtt',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image'
}

/** 各格式进入解析、OCR 与导出阶段的能力矩阵。 */
const FORMAT_CAPABILITIES: Readonly<Record<DocumentFormat, DocumentCapabilities>> = {
  pdf: {
    nativeLayout: true,
    ocrPageImages: true,
    ocrEmbeddedImages: true,
    preserveStyles: true,
    exportPdf: true
  },
  docx: {
    nativeLayout: false,
    ocrPageImages: false,
    ocrEmbeddedImages: true,
    preserveStyles: true,
    exportPdf: true
  },
  epub: {
    nativeLayout: false,
    ocrPageImages: false,
    ocrEmbeddedImages: true,
    preserveStyles: true,
    exportPdf: true
  },
  html: {
    nativeLayout: false,
    ocrPageImages: false,
    ocrEmbeddedImages: true,
    preserveStyles: true,
    exportPdf: true
  },
  markdown: {
    nativeLayout: false,
    ocrPageImages: false,
    ocrEmbeddedImages: false,
    preserveStyles: false,
    exportPdf: true
  },
  txt: {
    nativeLayout: false,
    ocrPageImages: false,
    ocrEmbeddedImages: false,
    preserveStyles: false,
    exportPdf: true
  },
  json: {
    nativeLayout: false,
    ocrPageImages: false,
    ocrEmbeddedImages: false,
    preserveStyles: false,
    exportPdf: true
  },
  csv: {
    nativeLayout: false,
    ocrPageImages: false,
    ocrEmbeddedImages: false,
    preserveStyles: false,
    exportPdf: true
  },
  srt: {
    nativeLayout: false,
    ocrPageImages: false,
    ocrEmbeddedImages: false,
    preserveStyles: false,
    exportPdf: true
  },
  vtt: {
    nativeLayout: false,
    ocrPageImages: false,
    ocrEmbeddedImages: false,
    preserveStyles: false,
    exportPdf: true
  },
  image: {
    nativeLayout: false,
    ocrPageImages: false,
    ocrEmbeddedImages: true,
    preserveStyles: false,
    exportPdf: true
  }
}

/** 格式探测成功结果。 */
export interface DocumentFormatDetected {
  /** 探测是否成功。 */
  ok: true
  /** 识别出的格式。 */
  format: DocumentFormat
}

/** 格式探测失败结果。 */
export interface DocumentFormatRejected {
  /** 探测是否成功。 */
  ok: false
  /** 失败分类。 */
  code: 'unsupported-format' | 'invalid-header'
  /** 扩展名声明的格式；完全未知时省略。 */
  format?: DocumentFormat
}

/** 格式探测结果。 */
export type DocumentFormatDetection = DocumentFormatDetected | DocumentFormatRejected

/** 文件校验输入，仅依赖文件名、大小和有限文件片段，避免在 UI 阶段读取整份文件。 */
export interface DocumentFileValidationInput {
  /** 用户选择的文件名。 */
  fileName: string
  /** 文件字节数。 */
  size: number
  /** 文件头字节，建议读取前 8192 字节。 */
  head: Uint8Array
  /** 文件尾字节，建议读取最后 1 MB，用于识别条目位于文件后部的 DOCX/EPUB。 */
  tail?: Uint8Array
  /** 精确读取的 ZIP 中央目录；中央目录超过尾部窗口时由调用方补充。 */
  zipDirectory?: Uint8Array
  /** 文件是否可读；未提供时视为可读。 */
  readable?: boolean
  /** 当前设置允许的最大文件字节数；未提供时使用默认上限。 */
  maxBytes?: number
}

/** 格式探测所需的有限文件内容。 */
export interface DocumentFormatDetectionInput {
  /** 文件头字节。 */
  head: Uint8Array
  /** 文件尾字节；提供后可解析 ZIP 中央目录。 */
  tail?: Uint8Array
  /** 精确读取的 ZIP 中央目录；用于中央目录大于尾部窗口的文档。 */
  zipDirectory?: Uint8Array
}

/** ZIP 中央目录在文件中的绝对字节范围。 */
export interface DocumentZipCentralDirectoryRange {
  /** 起始字节偏移。 */
  start: number
  /** 结束字节偏移，不包含该位置。 */
  end: number
}

/** 文件校验成功结果。 */
export interface DocumentFileValidationSuccess extends DocumentFormatDetected {
  /** 文件字节数。 */
  size: number
  /** 当前格式支持的能力。 */
  capabilities: DocumentCapabilities
}

/** 文件校验失败结果。 */
export interface DocumentFileValidationFailure {
  /** 校验是否成功。 */
  ok: false
  /** 失败分类，在格式探测分类之外扩展文件级错误。 */
  code: 'unsupported-format' | 'invalid-header' | 'empty-file' | 'too-large' | 'unreadable'
  /** 扩展名声明的格式；完全未知时省略。 */
  format?: DocumentFormat
}

/** 文件校验结果。 */
export type DocumentFileValidationResult = DocumentFileValidationSuccess | DocumentFileValidationFailure

/**
 * 从文件名中提取小写扩展名。
 * @param fileName 用户选择的文件名。
 * @returns 扩展名；没有扩展名时返回空字符串。
 * @author zhenghq
 */
function extensionOf(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.')
  if (lastDot < 0 || lastDot === fileName.length - 1) return ''
  return fileName.slice(lastDot + 1).toLowerCase()
}

/**
 * 判断文件头是否以指定字节序列开头。
 * @param head 文件头。
 * @param signature 需要匹配的签名。
 * @returns 是否匹配。
 * @author zhenghq
 */
function startsWithBytes(head: Uint8Array, signature: readonly number[]): boolean {
  if (head.length < signature.length) return false
  return signature.every((byte, index) => head[index] === byte)
}

/**
 * 把有限文件头解码为 UTF-8 文本；包含非法编码或 NUL 时返回 null。
 * @param head 文件头字节。
 * @returns 解码文本或 null。
 * @author zhenghq
 */
function decodeTextHead(head: Uint8Array): string | null {
  if (head.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(head)
  } catch {
    return null
  }
}

/**
 * 判断文件头是否包含 PDF 签名。
 * @param head 文件头字节。
 * @returns 是否为 PDF。
 * @author zhenghq
 */
function isPdfHeader(head: Uint8Array): boolean {
  const prefix = new TextDecoder('latin1').decode(head.subarray(0, Math.min(head.length, 1024)))
  return prefix.includes('%PDF-')
}

/**
 * 判断文件头是否包含 PNG 签名。
 * @param head 文件头字节。
 * @returns 是否为 PNG。
 * @author zhenghq
 */
function isPngHeader(head: Uint8Array): boolean {
  return startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

/**
 * 判断文件头是否包含 JPEG 签名。
 * @param head 文件头字节。
 * @returns 是否为 JPEG。
 * @author zhenghq
 */
function isJpegHeader(head: Uint8Array): boolean {
  return startsWithBytes(head, [0xff, 0xd8, 0xff])
}

/**
 * 判断文件头是否包含 GIF 签名。
 * @param head 文件头字节。
 * @returns 是否为 GIF。
 * @author zhenghq
 */
function isGifHeader(head: Uint8Array): boolean {
  const prefix = new TextDecoder('latin1').decode(head.subarray(0, Math.min(head.length, 6)))
  return prefix === 'GIF87a' || prefix === 'GIF89a'
}

/**
 * 判断文件头是否包含 BMP 签名。
 * @param head 文件头字节。
 * @returns 是否为 BMP。
 * @author zhenghq
 */
function isBmpHeader(head: Uint8Array): boolean {
  return startsWithBytes(head, [0x42, 0x4d])
}

/**
 * 判断文件头是否包含 WebP 签名。
 * @param head 文件头字节。
 * @returns 是否为 WebP。
 * @author zhenghq
 */
function isWebpHeader(head: Uint8Array): boolean {
  if (!startsWithBytes(head, [0x52, 0x49, 0x46, 0x46])) return false
  if (head.length < 12) return false
  return head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
}

/**
 * 判断文件头是否属于任一已支持图片格式。
 * @param head 文件头字节。
 * @returns 是否为图片。
 * @author zhenghq
 */
function isImageHeader(head: Uint8Array): boolean {
  return isPngHeader(head) ||
    isJpegHeader(head) ||
    isGifHeader(head) ||
    isBmpHeader(head) ||
    isWebpHeader(head)
}

/**
 * 判断 ZIP 容器中是否包含指定包内标记。
 * @param input 有限文件内容。
 * @param markers 需要同时出现的包内路径。
 * @returns 是否为对应 OOXML/EPUB 包。
 * @author zhenghq
 */
function isZipPackage(input: DocumentFormatDetectionInput, markers: readonly string[]): boolean {
  if (!startsWithBytes(input.head, [0x50, 0x4b, 0x03, 0x04])) return false
  const entries = input.zipDirectory
    ? readZipEntryNamesFromDirectory(input.zipDirectory)
    : readZipEntryNames(input.tail)
  if (entries) return markers.every((marker) => entries.has(marker.toLowerCase()))
  // 兼容只提供有限文件头的调用方；有 ZIP 尾部时以中央目录为唯一可信来源，
  // 避免普通 ZIP 因正文恰好包含标记文本而被误判为 DOCX/EPUB。
  if (!input.tail) {
    const text = new TextDecoder('latin1').decode(input.head)
    return markers.every((marker) => text.includes(marker))
  }
  return false
}

/**
 * 从 ZIP 尾部定位中央目录的绝对范围。
 *
 * 调用方可在中央目录大于尾部读取窗口时，按返回范围精确读取目录，避免读取整份文档。
 * 仅支持普通 ZIP；ZIP64、结构损坏或范围越界时返回 null。
 * @param tail 文件尾部字节。
 * @param fileSize 文件总字节数。
 * @returns 中央目录绝对范围；无法安全定位时返回 null。
 * @author zhenghq
 */
export function getDocumentZipCentralDirectoryRange(
  tail: Uint8Array,
  fileSize: number
): DocumentZipCentralDirectoryRange | null {
  if (!Number.isSafeInteger(fileSize) || fileSize < tail.length || tail.length < 22) return null
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  const eocdOffset = findZipEndOfCentralDirectory(view)
  if (eocdOffset < 0) return null
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true)
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)
  if (centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) return null
  const end = centralDirectoryOffset + centralDirectorySize
  if (end > fileSize || end < centralDirectoryOffset) return null
  return { start: centralDirectoryOffset, end }
}

/**
 * 从 ZIP 尾部读取中央目录中的完整条目名称。
 *
 * DOCX/EPUB 的正文条目可能位于 8KB 文件头之后，不能只依赖固定文件头。
 * 这里仅解析尾部已完整包含的中央目录；结构异常或 ZIP64 时返回 null，
 * 由调用方回退到有限文件头检查，不读取或解压正文。
 * @param tail 文件尾部字节。
 * @returns 条目名称集合；无法安全解析时返回 null。
 * @author zhenghq
 */
function readZipEntryNames(tail: Uint8Array | undefined): Set<string> | null {
  if (!tail || tail.length < 22) return null
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  const eocdOffset = findZipEndOfCentralDirectory(view)
  if (eocdOffset < 0) return null
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true)
  if (centralDirectorySize === 0xffffffff) return null
  const centralDirectoryOffset = eocdOffset - centralDirectorySize
  if (centralDirectoryOffset < 0 || centralDirectorySize > eocdOffset) return null
  return readZipEntryNamesFromDirectory(tail.subarray(centralDirectoryOffset, eocdOffset))
}

/**
 * 解析完整 ZIP 中央目录中的条目名称。
 * @param directory 中央目录字节。
 * @returns 条目名称集合；结构不完整时返回 null。
 * @author zhenghq
 */
function readZipEntryNamesFromDirectory(directory: Uint8Array): Set<string> | null {
  if (directory.length === 0) return null
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength)

  const entries = new Set<string>()
  let offset = 0
  while (offset + 46 <= directory.length) {
    if (view.getUint32(offset, true) !== 0x02014b50) return null
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > directory.length) return null
    const nameBytes = directory.subarray(offset + 46, offset + 46 + nameLength)
    entries.add(new TextDecoder('utf-8').decode(nameBytes).replace(/\\/gu, '/').toLowerCase())
    offset = nextOffset
  }
  return offset === directory.length ? entries : null
}

/**
 * 在文件尾块中定位 ZIP 中央目录结束记录。
 * @param view 文件尾块视图。
 * @returns 结束记录相对偏移；不存在时返回 -1。
 * @author zhenghq
 */
function findZipEndOfCentralDirectory(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - 22 - 0xffff)
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue
    const commentLength = view.getUint16(offset + 20, true)
    if (offset + 22 + commentLength === view.byteLength) return offset
  }
  return -1
}

/**
 * 判断文件头是否具有 HTML 文档特征。
 * @param head 文件头字节。
 * @returns 是否为 HTML。
 * @author zhenghq
 */
function isHtmlHeader(head: Uint8Array): boolean {
  const text = decodeTextHead(head)?.trimStart().toLowerCase()
  if (!text) return false
  return text.startsWith('<!doctype html') ||
    text.startsWith('<html') ||
    text.startsWith('<head') ||
    text.startsWith('<body')
}

/**
 * 判断已知文本格式的文件头是否可安全按 UTF-8 文本解析。
 * @param format 扩展名声明的格式。
 * @param head 文件头字节。
 * @returns 文件头是否合法。
 * @author zhenghq
 */
function isValidTextHeader(format: DocumentFormat, head: Uint8Array): boolean {
  const text = decodeTextHead(head)
  if (text === null) return false
  const trimmed = text.trimStart()
  if (format === 'json' && trimmed.length > 0) return trimmed.startsWith('{') || trimmed.startsWith('[')
  if (format === 'vtt' && trimmed.length > 0) return trimmed.toUpperCase().startsWith('WEBVTT')
  if (format === 'html') return isHtmlHeader(head)
  return true
}

/**
 * 判断扩展名声明格式与文件头是否一致。
 * @param format 扩展名声明的格式。
 * @param input 有限文件内容。
 * @returns 是否一致。
 * @author zhenghq
 */
function matchesDeclaredFormat(format: DocumentFormat, input: DocumentFormatDetectionInput): boolean {
  if (format === 'pdf') return isPdfHeader(input.head)
  if (format === 'image') return isImageHeader(input.head)
  if (format === 'docx') {
    return isZipPackage(input, ['[Content_Types].xml', 'word/document.xml'])
  }
  if (format === 'epub') {
    return isZipPackage(input, ['mimetype', 'META-INF/container.xml'])
  }
  return isValidTextHeader(format, input.head)
}

/**
 * 在没有可信扩展名时嗅探可唯一识别的格式。
 * @param input 有限文件内容。
 * @returns 识别出的格式；无法可靠识别时返回 null。
 * @author zhenghq
 */
function sniffFormat(input: DocumentFormatDetectionInput): DocumentFormat | null {
  if (isPdfHeader(input.head)) return 'pdf'
  if (isImageHeader(input.head)) return 'image'
  if (isZipPackage(input, ['[Content_Types].xml', 'word/document.xml'])) return 'docx'
  if (isZipPackage(input, ['mimetype', 'META-INF/container.xml'])) return 'epub'
  if (isHtmlHeader(input.head)) return 'html'
  return null
}

/**
 * 同时依据扩展名和有限文件头探测文档格式。
 * @param fileName 用户选择的文件名。
 * @param head 文件头字节。
 * @param tail 文件尾字节；用于识别条目位于文件后部的 ZIP 文档。
 * @returns 格式探测结果。
 * @author zhenghq
 */
export function detectDocumentFormat(
  fileName: string,
  head: Uint8Array,
  tail?: Uint8Array,
  zipDirectory?: Uint8Array
): DocumentFormatDetection {
  const input = {
    head,
    ...(tail ? { tail } : {}),
    ...(zipDirectory ? { zipDirectory } : {})
  }
  const declaredFormat = EXTENSION_FORMATS[extensionOf(fileName)]
  if (declaredFormat) {
    return matchesDeclaredFormat(declaredFormat, input)
      ? { ok: true, format: declaredFormat }
      : { ok: false, code: 'invalid-header', format: declaredFormat }
  }

  const sniffedFormat = sniffFormat(input)
  return sniffedFormat
    ? { ok: true, format: sniffedFormat }
    : { ok: false, code: 'unsupported-format' }
}

/**
 * 获取格式能力矩阵。
 * @param format 已支持的文档格式。
 * @returns 只读能力描述。
 * @author zhenghq
 */
export function getDocumentCapabilities(format: DocumentFormat): DocumentCapabilities {
  return FORMAT_CAPABILITIES[format]
}

/**
 * 在创建任务前校验文件格式、空文件、大小上限和可读性。
 * @param input 文件校验输入。
 * @returns 校验结果；失败时不会创建文档任务。
 * @author zhenghq
 */
export function validateDocumentFile(input: DocumentFileValidationInput): DocumentFileValidationResult {
  const detected = detectDocumentFormat(input.fileName, input.head, input.tail, input.zipDirectory)
  if (!detected.ok) return detected
  if (!Number.isFinite(input.size) || input.size <= 0) {
    return { ok: false, code: 'empty-file', format: detected.format }
  }
  const maxBytes = input.maxBytes ?? DOCUMENT_MAX_FILE_BYTES
  if (input.size > maxBytes) {
    return { ok: false, code: 'too-large', format: detected.format }
  }
  if (input.readable === false) {
    return { ok: false, code: 'unreadable', format: detected.format }
  }
  return {
    ok: true,
    format: detected.format,
    size: input.size,
    capabilities: getDocumentCapabilities(detected.format)
  }
}
