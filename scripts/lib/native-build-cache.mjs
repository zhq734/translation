import { statSync } from 'node:fs'

/**
 * 判断构建命令是否显式要求强制重建。
 * @param args 命令行参数列表。
 * @returns 包含 --force 时返回 true。
 * @author zhenghq
 */
export function hasNativeBuildForceFlag(args = process.argv.slice(2)) {
  return args.includes('--force')
}

/**
 * 读取文件修改时间，文件不存在或不可访问时返回 null。
 * @param path 文件路径。
 * @returns 修改时间毫秒数或 null。
 * @author zhenghq
 */
function readMtimeMs(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * 判断原生构建产物是否覆盖全部输入，可在开发启动时跳过重复编译。
 * @param outputs 需要存在的产物路径。
 * @param inputs 参与构建的源码和依赖路径。
 * @returns 全部产物存在且不早于任一输入时返回 true。
 * @author zhenghq
 */
export function isNativeBuildUpToDate(outputs, inputs) {
  if (outputs.length === 0 || inputs.length === 0) return false
  const outputMtimes = outputs.map(readMtimeMs)
  if (outputMtimes.some((mtime) => mtime === null)) return false
  const oldestOutputMtime = Math.min(...outputMtimes)

  return inputs.every((path) => {
    const inputMtime = readMtimeMs(path)
    return inputMtime !== null && inputMtime <= oldestOutputMtime
  })
}

/**
 * 输出统一的增量构建跳过日志。
 * @param label 构建目标名称。
 * @returns 无返回值。
 * @author zhenghq
 */
export function logNativeBuildUpToDate(label) {
  console.log(`[native-build] skip ${label} (up to date)`)
}
