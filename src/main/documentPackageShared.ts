import JSZip from 'jszip'
import {
  DOCUMENT_MAX_COMPRESSION_RATIO,
  DOCUMENT_MAX_ENTRY_BYTES,
  DOCUMENT_MAX_UNCOMPRESSED_BYTES,
  createDocumentWarning,
  type DocumentParseInput
} from './documentParserShared.ts'
import type { DocumentWarning } from '../shared/documentTypes.ts'

/** 已通过安全限制的文档包。 */
export interface SafeDocumentPackage {
  /** JSZip 实例。 */
  zip: JSZip
  /** 包内文件路径集合。 */
  entries: Map<string, JSZip.JSZipObject>
  /** 解包安全告警。 */
  warnings: DocumentWarning[]
  /** 加载该包时实际使用的安全限制。 */
  limits: DocumentPackageLimits
}

/** 文档包解包安全限制。 */
export interface DocumentPackageLimits {
  /** 单个包内条目的最大解包字节数。 */
  maxEntryBytes: number
  /** 整个文档包的最大解包字节数。 */
  maxUncompressedBytes: number
  /** 单条目与整包允许的最大压缩比。 */
  maxCompressionRatio: number
}

/** 文档包安全错误码。 */
export type DocumentPackageSecurityErrorCode =
  | 'package-entry-too-large'
  | 'package-uncompressed-too-large'
  | 'package-compression-ratio-too-high'

/** 文档包超出解包安全限制时抛出的稳定错误。 */
export class DocumentPackageSecurityError extends Error {
  /** 稳定的安全错误分类。 */
  readonly code: DocumentPackageSecurityErrorCode

  /**
   * 创建不包含文件名或路径的文档包安全错误。
   * @param code 稳定安全错误分类。
   * @author zhenghq
   */
  constructor(code: DocumentPackageSecurityErrorCode) {
    super({
      'package-entry-too-large': 'document package entry exceeds size limit',
      'package-uncompressed-too-large': 'document package exceeds uncompressed size limit',
      'package-compression-ratio-too-high': 'document package compression ratio exceeds safety limit'
    }[code])
    this.name = 'DocumentPackageSecurityError'
    this.code = code
  }
}

/** 默认文档包安全限制。 */
const DEFAULT_DOCUMENT_PACKAGE_LIMITS: DocumentPackageLimits = {
  maxEntryBytes: DOCUMENT_MAX_ENTRY_BYTES,
  maxUncompressedBytes: DOCUMENT_MAX_UNCOMPRESSED_BYTES,
  maxCompressionRatio: DOCUMENT_MAX_COMPRESSION_RATIO
}

/**
 * 规范化包内路径，拒绝绝对路径、空路径和目录穿越。
 * @param path 原始包内路径。
 * @returns 可安全使用的相对路径；非法时返回 null。
 * @author zhenghq
 */
export function normalizePackagePath(path: string): string | null {
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..' || segment === '')) return null
  return segments.join('/')
}

/**
 * 解析相对当前包内文件的引用路径。
 * @param baseDirectory 当前文件所在目录。
 * @param target 关系目标。
 * @returns 规范化后的包内路径；非法时返回 null。
 * @author zhenghq
 */
export function resolvePackagePath(baseDirectory: string, target: string): string | null {
  const cleanedTarget = target.replace(/\\/gu, '/').split('#', 1)[0]!.split('?', 1)[0]!
  if (!cleanedTarget) return null
  if (/^[a-z]+:/iu.test(cleanedTarget) || cleanedTarget.startsWith('//')) return null
  const segments = `${baseDirectory}/${cleanedTarget}`.split('/')
  const resolved: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (resolved.length === 0) return null
      resolved.pop()
    } else {
      resolved.push(segment)
    }
  }
  return resolved.join('/')
}

/**
 * 获取包内文件所在目录。
 * @param path 包内文件路径。
 * @returns 目录路径；根目录返回空字符串。
 * @author zhenghq
 */
export function packageDirectory(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

/**
 * 安全加载 DOCX/EPUB 包，限制单文件大小、总解包大小、压缩比和路径穿越。
 * @param input 文档解析输入。
 * @param limits 可选安全限制；省略时使用全局默认值。
 * @returns 已校验的包及安全告警。
 * @author zhenghq
 */
export async function loadSafeDocumentPackage(
  input: DocumentParseInput,
  limits: DocumentPackageLimits = DEFAULT_DOCUMENT_PACKAGE_LIMITS
): Promise<SafeDocumentPackage> {
  const effectiveLimits: DocumentPackageLimits = {
    maxEntryBytes: Math.max(1, limits.maxEntryBytes),
    maxUncompressedBytes: Math.max(1, limits.maxUncompressedBytes),
    maxCompressionRatio: Math.max(1, limits.maxCompressionRatio)
  }
  const zip = await JSZip.loadAsync(input.bytes, { checkCRC32: false, createFolders: false })
  const entries = new Map<string, JSZip.JSZipObject>()
  const warnings: DocumentWarning[] = []
  let totalUncompressed = 0
  let totalCompressed = Math.max(1, input.bytes.byteLength)
  for (const [rawPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const path = normalizePackagePath(rawPath)
    if (!path) {
      warnings.push(createDocumentWarning('unsafe-package-path', 'An unsafe path inside the document package was skipped.'))
      continue
    }
    const internal = entry as JSZip.JSZipObject & {
      _data?: { uncompressedSize?: number; compressedSize?: number }
    }
    const uncompressedSize = Number(internal._data?.uncompressedSize ?? 0)
    const compressedSize = Math.max(1, Number(internal._data?.compressedSize ?? 0))
    if (uncompressedSize > effectiveLimits.maxEntryBytes) {
      throw new DocumentPackageSecurityError('package-entry-too-large')
    }
    if (uncompressedSize > 0 && uncompressedSize / compressedSize > effectiveLimits.maxCompressionRatio) {
      throw new DocumentPackageSecurityError('package-compression-ratio-too-high')
    }
    totalUncompressed += uncompressedSize
    totalCompressed += compressedSize
    if (totalUncompressed > effectiveLimits.maxUncompressedBytes) {
      throw new DocumentPackageSecurityError('package-uncompressed-too-large')
    }
    if (totalUncompressed / totalCompressed > effectiveLimits.maxCompressionRatio) {
      throw new DocumentPackageSecurityError('package-compression-ratio-too-high')
    }
    entries.set(path, entry)
  }
  return { zip, entries, warnings, limits: effectiveLimits }
}

/**
 * 按包内路径读取文本文件；路径不存在时返回 null。
 * @param packageInfo 已校验文档包。
 * @param path 包内路径。
 * @returns 文件文本或 null。
 * @author zhenghq
 */
export async function readPackageText(
  packageInfo: SafeDocumentPackage,
  path: string
): Promise<string | null> {
  const entry = packageInfo.entries.get(path)
  if (!entry) return null
  const bytes = await entry.async('uint8array')
  if (bytes.byteLength > packageInfo.limits.maxEntryBytes) {
    throw new DocumentPackageSecurityError('package-entry-too-large')
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * 按包内路径读取二进制文件；路径不存在时返回 null。
 * @param packageInfo 已校验文档包。
 * @param path 包内路径。
 * @returns 文件字节或 null。
 * @author zhenghq
 */
export async function readPackageBytes(
  packageInfo: SafeDocumentPackage,
  path: string
): Promise<Uint8Array | null> {
  const entry = packageInfo.entries.get(path)
  if (!entry) return null
  const bytes = await entry.async('uint8array')
  if (bytes.byteLength > packageInfo.limits.maxEntryBytes) {
    throw new DocumentPackageSecurityError('package-entry-too-large')
  }
  return bytes
}

/**
 * 判断包内 MIME 是否为可 OCR 的图片类型。
 * @param mimeType MIME 类型。
 * @returns 是否支持作为图片资源。
 * @author zhenghq
 */
export function isSupportedImageMimeType(mimeType: string): boolean {
  return /^image\/(?:png|jpeg|gif|webp|bmp|tiff|svg\+xml)$/iu.test(mimeType)
}

/**
 * 根据文件扩展名推断图片 MIME 类型。
 * @param path 包内资源路径。
 * @returns MIME 类型；未知时返回 application/octet-stream。
 * @author zhenghq
 */
export function imageMimeTypeFromPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase()
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    svg: 'image/svg+xml'
  }
  return types[extension ?? ''] ?? 'application/octet-stream'
}
