import type { DocumentWorkspaceSnapshot } from '../shared/documentWorkspace.ts'

/** 文档 worker 当前任务的源文件标识。 */
interface DocumentWorkerSource {
  /** 已获主进程授权的源文件绝对路径。 */
  path: string
  /** 源文件格式。 */
  format: string
}

/** 创建文档 worker 源文件访问器的依赖。 */
export interface DocumentWorkerSourceAccessDependencies {
  /** 判断路径是否已由当前文档窗口批准。 */
  isApprovedPath(path: string): boolean
  /** 读取完整文件字节；由生产接线注入 Node.js 文件系统能力。 */
  readFile(path: string): Promise<Uint8Array>
}

/** 文档 worker 源文件受控访问器。 */
export interface DocumentWorkerSourceAccess {
  /**
   * 记录主进程即将发送的工作台快照中的源文件标识。
   * @param snapshot 主进程推送给文档工作台的快照。
   * @returns 无返回值。
   * @author zhenghq
   */
  rememberSnapshot(snapshot: DocumentWorkspaceSnapshot): void
  /**
   * 读取当前任务已授权源文件，并对 HTML 执行脱敏。
   * @param path 可选的已授权源文件路径；准备阶段快照尚未携带源模型时可显式传入。
   * @returns 不暴露路径的源文件读取结果。
   * @author zhenghq
   */
  getSourceBytes(path?: string): Promise<DocumentSourceReadResult>
}

/** 文档源文件读取结果；失败时不携带原始路径。 */
interface DocumentSourceReadResult {
  /** 是否读取成功。 */
  ok: boolean
  /** 成功时返回源文件 MIME。 */
  mimeType?: string
  /** 成功时返回源文件字节。 */
  bytes?: Uint8Array
  /** 失败时的稳定错误分类。 */
  code?: string
}

/**
 * 创建仅能读取当前快照记录且仍获授权的源文件访问器。
 * 文件只在请求时读取，避免任务会话长期持有完整文档字节。
 * @param dependencies 授权判断与文件读取依赖。
 * @returns 文档 worker 源文件访问器。
 * @author zhenghq
 */
export function createDocumentWorkerSourceAccess(
  dependencies: DocumentWorkerSourceAccessDependencies
): DocumentWorkerSourceAccess {
  let currentSource: DocumentWorkerSource | null = null

  return {
    rememberSnapshot(snapshot): void {
      const source = snapshot.source?.source
      if (source?.path) currentSource = { path: source.path, format: source.format }
    },

    async getSourceBytes(path?: string): Promise<DocumentSourceReadResult> {
      const source = path ? { path, format: inferSourceFormat(path) } : currentSource
      if (!source || !dependencies.isApprovedPath(source.path)) {
        return { ok: false, code: 'source-not-found' }
      }
      try {
        const bytes = await dependencies.readFile(source.path)
        if (source.format === 'html') {
          const [{ decodeDocumentText }, { sanitizeHtmlPreview }] = await Promise.all([
            import('./documentParserShared.ts'),
            import('./documentTextParser.ts')
          ])
          const sanitized = sanitizeHtmlPreview(decodeDocumentText(bytes)).html
          return {
            ok: true,
            mimeType: 'text/html; charset=utf-8',
            bytes: new TextEncoder().encode(sanitized)
          }
        }
        if (source.format !== 'pdf') return { ok: false, code: 'source-not-found' }
        return { ok: true, mimeType: 'application/pdf', bytes }
      } catch {
        return { ok: false, code: 'source-unavailable' }
      }
    }
  }
}

/**
 * 从已授权路径推断可预览格式；仅 PDF 与 HTML 会返回原始字节。
 * @param path 已获授权的源文件路径。
 * @returns 小写扩展名。
 * @author zhenghq
 */
function inferSourceFormat(path: string): string {
  const match = /\.([^.\\/]+)$/u.exec(path)
  return match?.[1]?.toLowerCase() ?? ''
}
