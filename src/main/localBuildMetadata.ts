import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BUILD_METADATA_FILE_NAME,
  parseBuildMetadata,
  type BuildMetadata
} from '../shared/buildMetadata'

/** 读取本地构建元数据的依赖与运行环境。 */
export interface LocalBuildMetadataOptions {
  /** 当前应用是否为正式打包版本。 */
  packaged: boolean
  /** Electron 应用资源目录（`process.resourcesPath`）。 */
  resourcesPath: string
  /** 需要交叉校验的当前应用版本；省略时不做版本校验。 */
  expectedVersion?: string
  /**
   * 读取文本文件内容，便于测试注入。
   * @param path 待读取的文件路径。
   * @returns 文件的 UTF-8 文本。
   * @author zhenghq
   */
  readFile?: (path: string) => Promise<string>
}

/**
 * 计算安装包内构建元数据的约定路径。
 * @param resourcesPath Electron 应用资源目录。
 * @returns `build-info.json` 的完整路径。
 * @author zhenghq
 */
export function resolveLocalBuildMetadataPath(resourcesPath: string): string {
  return join(resourcesPath, BUILD_METADATA_FILE_NAME)
}

/**
 * 从应用资源目录读取并校验本地构建元数据。
 * 开发环境、旧安装包、读取失败或格式非法时返回不可用结果，不抛出异常阻断更新检查。
 * @param options 打包状态、资源目录、期望版本与文件读取实现。
 * @returns 有效的本地构建元数据；不可用时返回 undefined。
 * @author zhenghq
 */
export async function readLocalBuildMetadata(
  options: LocalBuildMetadataOptions
): Promise<BuildMetadata | undefined> {
  if (!options.packaged || !options.resourcesPath) return undefined
  const read = options.readFile ?? ((path: string) => readFile(path, 'utf8'))
  let content: string
  try {
    content = await read(resolveLocalBuildMetadataPath(options.resourcesPath))
  } catch {
    return undefined
  }
  const parsed = parseBuildMetadata(
    content,
    options.expectedVersion === undefined ? {} : { expectedVersion: options.expectedVersion }
  )
  return parsed.ok ? parsed.metadata : undefined
}
