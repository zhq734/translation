import type { DocumentModel } from '../shared/documentTypes.ts'
import { parseDocxDocument } from './documentDocxParser.ts'
import { parseEpubDocument, type ParseEpubOptions } from './documentEpubParser.ts'
import { parseImageDocument } from './documentImageParser.ts'
import { parsePdfDocument, type ParsePdfOptions } from './documentPdfParser.ts'
import type { DocumentParseInput } from './documentParserShared.ts'
import {
  parseDelimitedDocument,
  parseHtmlDocument,
  parseMarkdownDocument,
  parseSubtitleDocument,
  parseTextDocument
} from './documentTextParser.ts'

/** 统一文档解析调度器可注入的格式解析函数。 */
export interface DocumentParserDependencies {
  /** 解析 TXT 与 JSON 文本。 */
  parseText(input: DocumentParseInput): Promise<DocumentModel>
  /** 解析 Markdown。 */
  parseMarkdown(input: DocumentParseInput): Promise<DocumentModel>
  /** 解析 CSV。 */
  parseDelimited(input: DocumentParseInput): Promise<DocumentModel>
  /** 解析 SRT 与 VTT。 */
  parseSubtitle(input: DocumentParseInput): Promise<DocumentModel>
  /** 解析 HTML。 */
  parseHtml(input: DocumentParseInput): Promise<DocumentModel>
  /** 解析 PDF。 */
  parsePdf(input: DocumentParseInput, options: ParsePdfOptions): Promise<DocumentModel>
  /** 解析 DOCX。 */
  parseDocx(input: DocumentParseInput): Promise<DocumentModel>
  /** 解析 EPUB，并允许限制章节数量。 */
  parseEpub(input: DocumentParseInput, options?: ParseEpubOptions): Promise<DocumentModel>
  /** 解析单张图片。 */
  parseImage(input: DocumentParseInput, registerAssetBytes?: ParsePdfOptions['registerAssetBytes']): Promise<DocumentModel>
  /** 可选的 PDF 页面栅格化函数。 */
  renderPageToImage?: ParsePdfOptions['renderPageToImage']
  /** 可选的 PDF 页面区域裁切函数。 */
  renderPageRegionToImage?: ParsePdfOptions['renderPageRegionToImage']
  /** 可选的 PDF 内嵌图片对象导出函数。 */
  renderEmbeddedImageToImage?: ParsePdfOptions['renderEmbeddedImageToImage']
  /** 可选的 PDF 解析期资源字节登记函数。 */
  registerAssetBytes?: ParsePdfOptions['registerAssetBytes']
  /** 可选的 PDF 解析取消信号。 */
  signal?: AbortSignal
  /** 可选的最大页数或章节数，由当前设置动态提供。 */
  maxPages?: number
}

/** 默认解析器依赖；生产环境直接使用各格式适配器。 */
const DEFAULT_DEPENDENCIES: DocumentParserDependencies = {
  parseText: async (input) => parseTextDocument(input),
  parseMarkdown: async (input) => parseMarkdownDocument(input),
  parseDelimited: async (input) => parseDelimitedDocument(input),
  parseSubtitle: async (input) => parseSubtitleDocument(input),
  parseHtml: async (input) => parseHtmlDocument(input),
  parsePdf: async (input, options) => parsePdfDocument(input, options),
  parseDocx: async (input) => parseDocxDocument(input),
  parseEpub: async (input, options) => parseEpubDocument(input, options),
  parseImage: async (input, registerAssetBytes) => parseImageDocument(input, registerAssetBytes)
}

/**
 * 按已校验格式分发到对应文档解析器。
 * @param input 已通过文件校验并读取完整内容的解析输入。
 * @param overrides 可注入的解析器与 PDF 栅格化函数。
 * @returns 统一文档模型。
 * @author zhenghq
 */
export async function parseDocument(
  input: DocumentParseInput,
  overrides: Partial<DocumentParserDependencies> = {}
): Promise<DocumentModel> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  switch (input.format) {
    case 'txt':
    case 'json':
      return dependencies.parseText(input)
    case 'markdown':
      return dependencies.parseMarkdown(input)
    case 'csv':
      return dependencies.parseDelimited(input)
    case 'srt':
    case 'vtt':
      return dependencies.parseSubtitle(input)
    case 'html':
      return dependencies.parseHtml(input)
    case 'pdf':
      return dependencies.parsePdf(input, {
        ...(dependencies.renderPageToImage
          ? { renderPageToImage: dependencies.renderPageToImage }
          : {}),
        ...(dependencies.renderPageRegionToImage
          ? { renderPageRegionToImage: dependencies.renderPageRegionToImage }
          : {}),
        ...(dependencies.renderEmbeddedImageToImage
          ? { renderEmbeddedImageToImage: dependencies.renderEmbeddedImageToImage }
          : {}),
        ...(dependencies.registerAssetBytes
          ? { registerAssetBytes: dependencies.registerAssetBytes }
          : {}),
        ...(dependencies.signal ? { signal: dependencies.signal } : {}),
        ...(dependencies.maxPages !== undefined ? { maxPages: dependencies.maxPages } : {})
      })
    case 'docx':
      return dependencies.parseDocx(input)
    case 'epub':
      return dependencies.parseEpub(input, dependencies.maxPages !== undefined
        ? { maxPages: dependencies.maxPages }
        : undefined)
    case 'image':
      return dependencies.parseImage(input, dependencies.registerAssetBytes)
    default:
      throw new Error('unsupported document format')
  }
}
