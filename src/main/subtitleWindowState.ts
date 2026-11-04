import type { Rectangle } from 'electron'
import {
  loadDocumentWindowState,
  saveDocumentWindowState
} from './documentWindowState'

/** 实时字幕窗口状态文件名。 */
export const SUBTITLE_WINDOW_STATE_FILE = 'realtime-subtitle-window.json'

/**
 * 读取实时字幕窗口上次保存的位置与尺寸。
 * @param filePath 状态文件绝对路径。
 * @returns 合法边界；缺失或损坏时返回 null。
 * @author zhenghq
 */
export function loadSubtitleWindowState(filePath: string): Rectangle | null {
  return loadDocumentWindowState(filePath)
}

/**
 * 原子保存实时字幕窗口的位置与尺寸。
 * @param filePath 状态文件绝对路径。
 * @param bounds 当前窗口边界。
 * @returns 无返回值。
 * @author zhenghq
 */
export function saveSubtitleWindowState(filePath: string, bounds: Rectangle): void {
  saveDocumentWindowState(filePath, bounds)
}
