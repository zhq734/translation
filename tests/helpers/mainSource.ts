import { readFileSync, readdirSync } from 'node:fs'

const MAIN_SOURCE_PATHS = [
  'src/main/index.ts',
  ...readdirSync('src/main/ipc')
    .filter((fileName) => fileName.endsWith('.ts'))
    .sort()
    .map((fileName) => `src/main/ipc/${fileName}`),
  'src/main/translationHistoryController.ts',
  'src/main/documentRuntime.ts'
]

/**
 * 聚合主进程入口与按职责拆出的实现模块源码，供契约测试统一审计。
 * @returns 使用换行连接的主进程实现源码。
 * @author zhenghq
 */
export function readMainSource(): string {
  return MAIN_SOURCE_PATHS.map((path) => readFileSync(path, 'utf8')).join('\n')
}

/**
 * 按括号配对截取单个 IPC 注册的完整源码，避免拆分模块或嵌套回调影响结束边界。
 * @param source 聚合后的主进程源码。
 * @param channel IPC 通道名。
 * @param method IPC 注册方法，默认为 handle。
 * @returns 从注册起点到对应回调结束的源码。
 * @author zhenghq
 */
export function extractIpcRegistration(
  source: string,
  channel: string,
  method: 'handle' | 'on' = 'handle'
): string {
  const signature = `ipcMain.${method}('${channel}'`
  const start = source.indexOf(signature)
  if (start < 0) throw new Error(`未找到 IPC ${channel}`)
  const bodyStart = source.indexOf('{', start)
  if (bodyStart < 0) throw new Error(`IPC ${channel} 缺少注册回调`)

  let depth = 0
  let quote: "'" | '"' | '`' | null = null
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = bodyStart; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (current === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (current === '\\') {
        escaped = true
      } else if (current === quote) {
        quote = null
      }
      continue
    }
    if (current === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (current === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (current === "'" || current === '"' || current === '`') {
      quote = current
      continue
    }
    if (current === '{') depth += 1
    if (current === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`IPC ${channel} 的回调未闭合`)
}
