import { randomUUID } from 'node:crypto'

/** 原子文件写入所需的最小文件系统依赖。 */
export interface DocumentAtomicFileDependencies {
  /** 将完整字节写入临时文件。 */
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  /** 将临时文件替换为目标文件。 */
  rename(source: string, target: string): Promise<void>
  /** 清理失败或取消后遗留的临时文件。 */
  unlink(path: string): Promise<void>
}

/** 原子写入替换前的可取消检查点。 */
export interface DocumentAtomicFileOptions {
  /** 在临时文件完整写入后、替换目标文件前执行；可在此再次检查取消信号。 */
  beforeRename?(): void | Promise<void>
}

/**
 * 创建标准 AbortError，便于上层统一映射为取消结果。
 * @param signal 已取消的信号。
 * @returns 名称为 AbortError 的错误。
 * @author zhenghq
 */
function createAbortError(signal: AbortSignal): Error {
  const error = new Error(signal.reason instanceof Error ? signal.reason.message : 'document-write-cancelled')
  error.name = 'AbortError'
  return error
}

/**
 * 在目标文件同目录写入临时文件，成功后再原子替换目标文件。
 * 写入或替换失败时尽力删除临时文件，并保留原目标文件不变。
 * @param targetPath 用户选择的最终文件路径。
 * @param bytes 完整输出字节。
 * @param dependencies 文件系统依赖。
 * @param signal 可选取消信号；取消后不替换目标文件。
 * @param options 可选替换前检查点。
 * @returns 无返回值。
 * @author zhenghq
 */
export async function writeDocumentFileAtomically(
  targetPath: string,
  bytes: Uint8Array,
  dependencies: DocumentAtomicFileDependencies,
  signal?: AbortSignal,
  options: DocumentAtomicFileOptions = {}
): Promise<void> {
  if (signal?.aborted) throw createAbortError(signal)
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`
  try {
    await dependencies.writeFile(temporaryPath, bytes)
    if (signal?.aborted) throw createAbortError(signal)
    await options.beforeRename?.()
    if (signal?.aborted) throw createAbortError(signal)
    await dependencies.rename(temporaryPath, targetPath)
  } catch (error) {
    try {
      await dependencies.unlink(temporaryPath)
    } catch {
      // 清理失败不能覆盖原始写入错误；下次导出仍会使用新的随机临时路径。
    }
    throw error
  }
}
