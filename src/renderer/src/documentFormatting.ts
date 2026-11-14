/**
 * 把文件字节数格式化为便于阅读的大小。
 * @param bytes 文件字节数。
 * @returns 带单位的大小文本。
 * @author zhenghq
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 根据当前进度和已用时间估算任务剩余毫秒数。
 * @param percent 当前任务完成百分比。
 * @param startedAt 任务开始时间戳。
 * @param now 当前时间戳，便于测试注入稳定时钟。
 * @returns 估算的剩余毫秒数；进度不可用时返回 null。
 * @author zhenghq
 */
export function calculateDocumentRemainingMilliseconds(
  percent: number,
  startedAt: number,
  now = Date.now()
): number | null {
  if (percent <= 0 || percent >= 100) return null
  const elapsed = now - startedAt
  if (elapsed <= 0) return null
  return Math.max(0, Math.round(elapsed / percent * (100 - percent)))
}

/**
 * 将毫秒时长格式化为紧凑的分钟/秒文本。
 * @param milliseconds 毫秒数。
 * @returns 面向进度栏的时长文本。
 * @author zhenghq
 */
export function formatDocumentDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
}
