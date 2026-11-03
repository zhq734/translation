import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  MacosAxCopyStatus,
  MacosAxEnhancementResult,
  NativeSelectionReadResult
} from '../shared/platformCapture'

/** 主进程 N-API AX addon 暴露的异步能力。 */
export interface MacosAxAddon {
  /**
   * 读取目标窗口或当前焦点下的选中文字。
   * @param options 窗口编号、进程号、边界与标题指纹等可选上下文。
   * @returns 结构化选区读取结果。
   * @author zhenghq
   */
  readSelection(options?: {
    windowNumber?: number
    pid?: number
    bounds?: { x: number; y: number; width: number; height: number }
    titleFingerprint?: string
  }): Promise<NativeSelectionReadResult>

  /**
   * 在目标应用菜单栏中执行唯一的 Command+C 菜单动作。
   * @param pid 目标应用进程号。
   * @returns 固定复制状态。
   * @author zhenghq
   */
  performCopy(pid: number): Promise<MacosAxCopyStatus>

  /**
   * 请求目标 Chromium/Electron 应用启用完整辅助功能树。
   * @param pid 目标应用进程号。
   * @returns 增强请求结果。
   * @author zhenghq
   */
  enhanceAccessibility(pid: number): Promise<MacosAxEnhancementResult>
}

/** addon 加载失败分类，仅用于脱敏诊断。 */
export type MacosAxAddonLoadFailure = 'missing' | 'load-error' | 'invalid-export'

/** addon 加载器依赖注入选项。 */
export interface MacosAxAddonLoaderOptions {
  /** 当前平台；默认取 process.platform。 */
  platform?: NodeJS.Platform
  /** 打包后的 Electron resources 目录。 */
  resourcesPath?: string
  /** 仓库根目录；默认取 process.cwd()。 */
  cwd?: string
  /** 文件存在性判断；默认使用 fs.existsSync。 */
  fileExists?: (candidate: string) => boolean
  /** 原生模块加载函数；默认使用 createRequire(import.meta.url)。 */
  requireModule?: (modulePath: string) => unknown
}

/** addon 路径解析选项。 */
export type MacosAxAddonPathOptions = Pick<
  MacosAxAddonLoaderOptions,
  'resourcesPath' | 'cwd' | 'fileExists'
>

/** 惰性缓存的原生模块加载器。 */
export interface MacosAxAddonLoader {
  /**
   * 加载并校验 addon；失败时返回 null，供调用方回退 CLI helper。
   * @returns 已校验的 addon 实例或 null。
   * @author zhenghq
   */
  load(): MacosAxAddon | null

  /**
   * 获取最近一次加载失败的脱敏分类。
   * @returns 失败分类；尚未失败或已成功加载时返回 null。
   * @author zhenghq
   */
  getLastFailure(): MacosAxAddonLoadFailure | null
}

/**
 * 解析 macOS AX addon 路径：打包环境优先 resourcesPath，开发环境回退 build 目录。
 * @param options 路径解析选项。
 * @returns addon 绝对路径；不存在时返回 null。
 * @author zhenghq
 */
export function resolveMacosAxAddonPath(options?: MacosAxAddonPathOptions): string | null {
  const fileExists = options?.fileExists ?? existsSync
  const cwd = options?.cwd ?? process.cwd()
  const resourcesPath = options?.resourcesPath
  const candidates = [
    resourcesPath ? join(resourcesPath, 'macos-ax-reader.node') : null,
    join(cwd, 'build', 'macos-ax-reader.node')
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) => fileExists(candidate)) ?? null
}

/**
 * 校验原生模块是否完整导出三类异步方法。
 * @param value 原生模块导出值。
 * @returns 完整实现 MacosAxAddon 接口时返回 true。
 * @author zhenghq
 */
function isMacosAxAddon(value: unknown): value is MacosAxAddon {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<MacosAxAddon>
  return typeof candidate.readSelection === 'function' &&
    typeof candidate.performCopy === 'function' &&
    typeof candidate.enhanceAccessibility === 'function'
}

/**
 * 创建惰性 addon 加载器；加载失败只记录固定分类，不抛出到取词主流程。
 * @param options 加载器依赖注入选项。
 * @returns 带缓存与失败分类的加载器。
 * @author zhenghq
 */
export function createMacosAxAddonLoader(
  options: MacosAxAddonLoaderOptions = {}
): MacosAxAddonLoader {
  const platform = options.platform ?? process.platform
  const fileExists = options.fileExists ?? existsSync
  const requireModule = options.requireModule ??
    ((modulePath: string) => createRequire(import.meta.url)(modulePath))
  let loaded = false
  let addon: MacosAxAddon | null = null
  let lastFailure: MacosAxAddonLoadFailure | null = null

  return {
    load(): MacosAxAddon | null {
      if (platform !== 'darwin') return null
      if (loaded) return addon
      loaded = true

      const addonPath = resolveMacosAxAddonPath({
        resourcesPath: options.resourcesPath,
        cwd: options.cwd,
        fileExists
      })
      if (!addonPath) {
        lastFailure = 'missing'
        return null
      }

      try {
        const loadedModule = requireModule(addonPath)
        if (!isMacosAxAddon(loadedModule)) {
          lastFailure = 'invalid-export'
          return null
        }
        addon = loadedModule
        lastFailure = null
        return addon
      } catch {
        lastFailure = 'load-error'
        return null
      }
    },

    getLastFailure(): MacosAxAddonLoadFailure | null {
      return lastFailure
    }
  }
}
