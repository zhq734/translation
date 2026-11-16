import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { translateMain } from './messages'
import type { PortableRuntimeInfo } from '../shared/portable'

/** 便携模式接管的 Electron 路径。 */
export type PortablePathName = 'userData' | 'sessionData' | 'logs' | 'temp' | 'crashDumps'

/** 不依赖 Electron 的初始化输入，便于验证启动顺序和失败隔离。 */
export interface PortableRuntimeOptions {
  platform: string
  packaged: boolean
  win7: boolean
  arch: string
  execPath: string
  env: Record<string, string | undefined>
  /** 设置 Electron 路径；参数为路径名和绝对路径，无返回值。@author zhenghq */
  setPath(name: PortablePathName, path: string): void
  /** 可注入的探写；参数为已创建目录，失败时抛出异常，无返回值。@author zhenghq */
  probeDirectory?(directory: string): void
}

/**
 * 检查路径类型，允许不存在但拒绝符号链接和其他非预期类型。
 * @param path 待检查路径。
 * @param directory 是否要求目录，否则要求普通文件。
 * @returns 路径存在时返回 true。
 * @author zhenghq
 */
function validatePath(path: string, directory: boolean): boolean {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) {
      throw new Error(translateMain('portable.startup.pathType', { path }))
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * 通过独占创建、写入及删除临时文件验证目录权限，不覆盖用户文件。
 * @param directory 已存在的目录。
 * @returns 无返回值；不可写时抛出异常。
 * @author zhenghq
 */
function probeWritableDirectory(directory: string): void {
  const path = join(directory, `.portable-write-${randomUUID()}`)
  const fd = openSync(path, 'wx', 0o600)
  try {
    const content = 'portable'
    if (writeSync(fd, content) !== Buffer.byteLength(content)) {
      throw new Error(translateMain('portable.startup.shortWrite', { directory }))
    }
  } finally {
    try {
      closeSync(fd)
    } finally {
      unlinkSync(path)
    }
  }
}

/**
 * 在主进程其余模块加载前识别便携标识、验证数据目录并接管持久化路径。
 * @param options 当前运行环境和路径适配器。
 * @returns 便携状态；普通安装不产生任何文件或路径副作用。
 * @author zhenghq
 */
export function initializePortableRuntime(options: PortableRuntimeOptions): PortableRuntimeInfo {
  const disabled: PortableRuntimeInfo = { enabled: false, dataDirectory: null }
  if (options.platform !== 'win32' || !options.packaged || options.win7) return disabled
  const base = dirname(options.execPath)
  const marker = join(base, 'portable.json')
  try {
    if (!validatePath(marker, false)) return disabled
    const config: unknown = JSON.parse(readFileSync(marker, 'utf8'))
    if (!config || typeof config !== 'object' || (config as { version?: unknown }).version !== 1) {
      throw new Error(translateMain('portable.startup.marker'))
    }
    if (options.arch !== 'x64' && options.arch !== 'arm64') throw new Error(translateMain('portable.startup.arch'))
    const dataDirectory = join(base, 'data')
    const directories: Record<PortablePathName, string> = {
      userData: join(dataDirectory, 'user-data'),
      sessionData: join(dataDirectory, 'session'),
      logs: join(dataDirectory, 'logs'),
      temp: join(dataDirectory, 'temp'),
      crashDumps: join(dataDirectory, 'crash-dumps')
    }
    // 所有探写成功后才设置路径，避免权限失败后混用安装版与便携版目录。
    for (const directory of [dataDirectory, ...Object.values(directories)]) {
      if (!validatePath(directory, true)) mkdirSync(directory)
      ;(options.probeDirectory ?? probeWritableDirectory)(directory)
    }
    for (const name of Object.keys(directories) as PortablePathName[]) options.setPath(name, directories[name])
    // app.setPath('temp') 不改变 node:os.tmpdir；同步进程和后续子进程的临时目录。
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) options.env[name] = directories.temp
    return { enabled: true, dataDirectory }
  } catch (error) {
    throw new Error(translateMain('portable.startup.failed', { directory: base, error: (error as Error).message }))
  }
}
