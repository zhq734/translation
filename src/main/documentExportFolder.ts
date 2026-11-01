import { dirname } from 'node:path'

/** 打开导出目录所需的系统文件管理器能力。 */
export interface DocumentExportFolderDependencies {
  /** 在系统文件管理器中选中文件；无返回值，失败时抛出异常。 */
  showItemInFolder(path: string): void
  /** 使用系统默认文件管理器打开指定目录；空字符串表示成功。 */
  openPath(path: string): Promise<string>
}

/**
 * 打开已导出文件所在目录。
 * 不预先 stat 文件：文件可能位于系统文件管理器可访问、但 Node 进程无法直接访问的位置，
 * 预检会把原本可定位的文件误判为不存在。与历史可用版本一致，优先由文件管理器定位。
 * @param filePath 主进程记录的导出文件路径。
 * @param dependencies 系统文件管理器依赖。
 * @returns 成功调用定位或回退打开父目录时返回 true，否则返回 false。
 * @author zhenghq
 */
export async function openDocumentExportFolder(
  filePath: string,
  dependencies: DocumentExportFolderDependencies
): Promise<boolean> {
  if (!filePath || typeof filePath !== 'string') return false
  try {
    // 与旧版行为一致，优先在系统文件管理器中选中导出文件。
    dependencies.showItemInFolder(filePath)
    return true
  } catch {
    try {
      // 文件管理器拒绝定位时再退回到打开父目录。
      const errorMessage = await dependencies.openPath(dirname(filePath))
      return errorMessage === ''
    } catch {
      return false
    }
  }
}
