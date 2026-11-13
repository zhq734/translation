import type {
  DocumentAssetResult,
  DocumentExportRequest,
  DocumentExportResult,
  DocumentRunRequest,
  DocumentRunResult,
  DocumentSourceResult
} from '../shared/documentWorkspace.ts'

/**
 * 文档任务服务的最小结构接口。
 *
 * 主进程只依赖这些方法，从而既能运行进程内旧实现，也能切换到
 * utility process 隔离的 DocumentWorkerSession。
 * @author zhenghq
 */
export interface DocumentWorkspaceTaskServiceLike {
  /**
   * 接受并启动一次文档任务。
   * @param request Renderer 请求。
   * @param onAccepted 任务标识生成后的同步登记回调。
   * @returns 接受结果与任务标识。
   * @author zhenghq
   */
  run(
    request: DocumentRunRequest,
    onAccepted?: (jobId: string) => void
  ): Promise<DocumentRunResult>
  /**
   * 在不重新解析或 OCR 的前提下切换运行模式。
   * @param jobId 任务标识。
   * @param generation 当前代际。
   * @param nextGeneration 新代际。
   * @param mode 目标运行模式。
   * @returns 接受结果与任务标识。
   * @author zhenghq
   */
  switchMode(
    jobId: string,
    generation: number,
    nextGeneration: number,
    mode: DocumentRunRequest['mode']
  ): DocumentRunResult
  /** 使用新代际重试失败目标。 */
  retryFailed(generation: number): DocumentRunResult
  /** 使用新代际仅重试一个可重试目标。 */
  retryFailedTarget(generation: number, targetId: string): DocumentRunResult
  /** 强制重译一个目标，失败时保留旧译文。 */
  retranslateTarget(generation: number, targetId: string): DocumentRunResult
  /** 取消当前任务。 */
  cancel(jobId: string, generation: number): boolean
  /** 导出当前译文或 OCR 原文。 */
  exportPdf(request: DocumentExportRequest): Promise<DocumentExportResult>
  /** 取消正在执行的导出。 */
  cancelExport(jobId: string, generation: number): boolean
  /** 打开最近一次成功导出文件所在目录。 */
  openExportFolder(jobId: string, generation: number): Promise<boolean>
  /** 打开指定成功导出文件所在目录。 */
  openExportFolderPath(jobId: string, generation: number, filePath: string): Promise<boolean>
  /** 读取已声明资源字节。 */
  getAsset(assetId: string): Promise<DocumentAssetResult>
  /** 读取当前任务的源文件字节或净化后的 HTML 预览。 */
  getSource(): DocumentSourceResult | Promise<DocumentSourceResult>
  /** 释放任务占用的全部资源。 */
  dispose(): void
}
