import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 内置 CJK 字体相对应用资源的路径。 */
export const DOCUMENT_PDF_CJK_FONT_RELATIVE_PATH = 'assets/fonts/NotoSansSC-Regular.ttf'

/** 字体加载器依赖。 */
export interface DocumentPdfFontDependencies {
  /** 应用是否运行在打包产物中。 */
  isPackaged: boolean
  /** 开发环境应用根目录。 */
  appPath: string
  /** 打包产物 Resources 目录。 */
  resourcesPath: string
  /** 可注入的文件读取函数。 */
  readFile?: (path: string) => Promise<Uint8Array>
}

let cachedFontBytes: Uint8Array | null = null

/**
 * 计算内置 CJK 字体的运行时可读路径。
 * @param dependencies 打包状态与资源目录。
 * @returns 字体绝对路径。
 * @author zhenghq
 */
export function resolveDocumentPdfFontPath(dependencies: Pick<
  DocumentPdfFontDependencies,
  'isPackaged' | 'appPath' | 'resourcesPath'
>): string {
  return dependencies.isPackaged
    ? join(dependencies.resourcesPath, DOCUMENT_PDF_CJK_FONT_RELATIVE_PATH)
    : join(dependencies.appPath, DOCUMENT_PDF_CJK_FONT_RELATIVE_PATH)
}

/**
 * 读取并缓存可嵌入 PDF 的 CJK 字体；读取失败时返回 null，由导出层给出稳定错误。
 * @param dependencies 打包状态、资源目录与可选文件读取函数。
 * @returns 字体字节或 null。
 * @author zhenghq
 */
export async function loadDocumentPdfFontBytes(
  dependencies: DocumentPdfFontDependencies
): Promise<Uint8Array | null> {
  if (cachedFontBytes) return cachedFontBytes
  try {
    const reader = dependencies.readFile ?? readFile
    const bytes = await reader(resolveDocumentPdfFontPath(dependencies))
    if (!bytes || bytes.byteLength === 0) return null
    cachedFontBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    return cachedFontBytes
  } catch {
    return null
  }
}

/**
 * 清除字体缓存，供测试或运行时资源更新后重新读取。
 * @returns 无返回值。
 * @author zhenghq
 */
export function resetDocumentPdfFontCache(): void {
  cachedFontBytes = null
}
