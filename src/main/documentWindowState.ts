import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import type { Rectangle } from 'electron'

/** 文档工作台窗口状态文件名。 */
export const DOCUMENT_WINDOW_STATE_FILE = 'document-workspace-window.json'

/**
 * 判断未知值是否为有限数字。
 * @param value 待判断值。
 * @returns 是有限数字时返回 true。
 * @author zhenghq
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 读取文档工作台上次保存的窗口边界。
 * 文件缺失、内容损坏或字段非法时安全回退为 null，避免阻断窗口打开。
 * @param filePath 状态文件绝对路径。
 * @returns 合法窗口边界；无法恢复时返回 null。
 * @author zhenghq
 */
export function loadDocumentWindowState(filePath: string): Rectangle | null {
  if (!existsSync(filePath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const value = parsed as Record<string, unknown>
    const x = value['x']
    const y = value['y']
    const width = value['width']
    const height = value['height']
    if (
      !isFiniteNumber(x) ||
      !isFiniteNumber(y) ||
      !isFiniteNumber(width) ||
      !isFiniteNumber(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return null
    }
    return { x, y, width, height }
  } catch {
    return null
  }
}

/**
 * 原子保存文档工作台窗口边界。
 * 仅持久化位置与尺寸，不记录文件名、路径、正文或 OCR 内容。
 * @param filePath 状态文件绝对路径。
 * @param bounds 当前窗口边界。
 * @returns 无返回值。
 * @author zhenghq
 */
export function saveDocumentWindowState(filePath: string, bounds: Rectangle): void {
  const payload = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  }
  mkdirSync(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(payload), { mode: 0o600 })
  renameSync(temporaryPath, filePath)
}
