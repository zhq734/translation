import { createTranslator, type Locale, type Translator } from './i18n'
import type { UpdateProgress } from './types'

/** 字节数格式化时使用的单位序列。 */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

/**
 * 将字节数格式化为便于阅读的容量文本。
 * @param bytes 字节数。
 * @returns 自动选择 B、KB、MB 或 GB 单位后的文本。
 * @author zhenghq
 */
export function formatUpdateBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1
  )
  const value = bytes / 1024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${BYTE_UNITS[unitIndex]}`
}

/**
 * 将下载进度格式化为设置页展示的单行文本。
 * @param progress 当前更新下载进度。
 * @returns 包含百分比、已下载量与瞬时速度的文本；总长度未知时只展示已下载量。
 * @author zhenghq
 */
export function formatUpdateProgressText(progress: UpdateProgress): string {
  return formatUpdateProgressTextForLocale(progress, 'en-US')
}

/**
 * 按指定界面语言格式化下载进度。
 * @param progress 当前更新下载进度。
 * @param locale 当前界面语言或翻译器。
 * @returns 本地化后的进度文本；总长度未知时只展示已下载量。
 * @author zhenghq
 */
export function formatUpdateProgressTextForLocale(
  progress: UpdateProgress,
  locale: Locale | Translator = 'en-US'
): string {
  const translator: Translator = typeof locale === 'string' ? createTranslator(locale) : locale
  const speedText = progress.bytesPerSecond > 0
    ? ` · ${formatUpdateBytes(progress.bytesPerSecond)}/s`
    : ''
  if (progress.total <= 0) {
    return `${translator.t('update.progress.downloaded', {
      size: formatUpdateBytes(progress.transferred)
    })}${speedText}`
  }
  const percent = Math.max(0, Math.min(100, progress.percent))
  const sizeText = `${formatUpdateBytes(progress.transferred)} / ${formatUpdateBytes(progress.total)}`
  return `${percent.toFixed(1)}% · ${sizeText}${speedText}`
}
