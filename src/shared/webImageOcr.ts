/**
 * 网页图片 OCR 共享纯函数模块。
 *
 * 负责图片候选的校验、过滤、标识派生、取图策略与覆盖层渲染决策，
 * 以及图片维度进度汇总。这些逻辑不依赖 Electron 或 DOM，便于单元测试，
 * 并被主进程的图片 OCR 管道与阅读器运行时共同复用。
 *
 * @author zhenghq
 */

import {
  isWebImageKind,
  isWebImageOverlayPlacement,
  type WebImageAnchor,
  type WebImageCandidate,
  type WebImageCandidateFilterOptions,
  type WebImageCandidateFilterResult,
  type WebImageOverlayPlacement,
  type WebImageProgressSummary,
  type WebImageRenderDecision,
  type WebImageSourceStrategy,
  type WebTextRect
} from './webPageTranslation'

export { isWebImageKind, isWebImageOverlayPlacement }
export type {
  WebImageAnchor,
  WebImageCandidate,
  WebImageCandidateFilterOptions,
  WebImageCandidateFilterResult,
  WebImageOverlayPlacement,
  WebImageProgressSummary,
  WebImageRenderDecision,
  WebImageSourceStrategy
} from './webPageTranslation'

/**
 * 计算短哈希，用于稳定标识与指纹派生。
 * @param value 待哈希字符串。
 * @returns 8 位十六进制哈希。
 * @author zhenghq
 */
function shortHash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16).padStart(8, '0')
}

/**
 * 判断矩形是否为有效且非零面积的页面矩形。
 * @param rect 待校验矩形。
 * @returns 是否有效。
 * @author zhenghq
 */
function isValidRect(rect: unknown): rect is WebTextRect {
  if (!rect || typeof rect !== 'object') return false
  const value = rect as Partial<WebTextRect>
  return [value.x, value.y, value.width, value.height].every((part) => Number.isFinite(part)) &&
    Number(value.width) > 0 && Number(value.height) > 0
}

/**
 * 判断未知值是否为合法图片候选。
 * @param value 待校验值。
 * @returns 是否为合法候选。
 * @author zhenghq
 */
export function isWebImageCandidate(value: unknown): value is WebImageCandidate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WebImageCandidate>
  return typeof candidate.imageId === 'string' && candidate.imageId !== '' &&
    isWebImageKind(candidate.kind) &&
    typeof candidate.selector === 'string' && candidate.selector !== '' &&
    isValidRect(candidate.rect)
}

/**
 * 派生图片候选的稳定标识。
 * @param candidate 图片候选或最小字段集合。
 * @returns 以 `web-image-` 为前缀的稳定标识。
 * @author zhenghq
 */
export function buildWebImageId(
  candidate: Pick<WebImageCandidate, 'selector' | 'rect' | 'kind' | 'sourceFingerprint'> & {
    shadowPath?: number[]
  }
): string {
  const rect = candidate.rect
  return `web-image-${shortHash(JSON.stringify([
    candidate.selector,
    candidate.kind,
    candidate.shadowPath ?? [],
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.width),
    Math.round(rect.height),
    candidate.sourceFingerprint ?? ''
  ]))}`
}

/**
 * 创建图片定位锚点，缺省指纹时按锚点字段派生。
 * @param candidate 图片候选。
 * @returns 可序列化的图片锚点。
 * @author zhenghq
 */
export function createWebImageAnchor(candidate: WebImageCandidate): WebImageAnchor {
  const sourceFingerprint = candidate.sourceFingerprint?.trim() ||
    shortHash(JSON.stringify([candidate.src ?? '', candidate.alt ?? '', candidate.kind]))
  return {
    selector: candidate.selector,
    rect: { ...candidate.rect },
    sourceFingerprint,
    kind: candidate.kind,
    ...(candidate.shadowPath !== undefined ? { shadowPath: [...candidate.shadowPath] } : {})
  }
}

/**
 * 判断候选是否达到最小边长要求。
 * @param candidate 图片候选。
 * @param minSize 最小边长像素。
 * @returns 是否达标。
 * @author zhenghq
 */
function meetsMinimumSize(candidate: WebImageCandidate, minSize: number): boolean {
  const limit = Math.max(0, minSize)
  return candidate.rect.width >= limit && candidate.rect.height >= limit
}

/**
 * 过滤图片候选：排除微小、装饰与超出数量上限的图片。
 * @param candidates 原始候选列表。
 * @param options 过滤配置。
 * @returns 通过过滤的候选与被跳过数量。
 * @author zhenghq
 */
export function filterWebImageCandidates(
  candidates: readonly WebImageCandidate[],
  options: WebImageCandidateFilterOptions
): WebImageCandidateFilterResult {
  const maxImages = Math.max(0, Math.floor(options.maxImages))
  const accepted: WebImageCandidate[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const candidate of candidates) {
    if (!isWebImageCandidate(candidate) || candidate.decorative || !meetsMinimumSize(candidate, options.minSize)) {
      skipped += 1
      continue
    }
    const id = candidate.imageId || buildWebImageId(candidate)
    if (seen.has(id)) {
      skipped += 1
      continue
    }
    if (accepted.length >= maxImages) {
      skipped += 1
      continue
    }
    seen.add(id)
    accepted.push(candidate)
  }
  return { accepted, skipped }
}

/**
 * 选择图片取图策略：Canvas、内联资源或请求受限时回退区域截图。
 * @param candidate 图片候选。
 * @returns 取图策略。
 * @author zhenghq
 */
export function selectWebImageSourceStrategy(candidate: WebImageCandidate): WebImageSourceStrategy {
  if (candidate.kind === 'canvas' || candidate.inline || candidate.requestBlocked) return 'capture'
  if (typeof candidate.src !== 'string' || candidate.src.trim() === '') return 'capture'
  return 'session'
}

/**
 * 解析图片译文的渲染决策。
 * @param candidate 图片候选。
 * @param mode 当前网页展示模式。
 * @param placement 用户选择的图片译文展示位置。
 * @returns 渲染决策；缺少识别文本或译文时返回 none。
 * @author zhenghq
 */
export function resolveWebImageRenderDecision(
  candidate: WebImageCandidate,
  mode: 'source' | 'target' | 'bilingual',
  placement: WebImageOverlayPlacement
): WebImageRenderDecision {
  if (mode === 'source') return 'none'
  const hasOcr = typeof candidate.ocrText === 'string' && candidate.ocrText.trim() !== ''
  const hasTranslation = typeof candidate.translation === 'string' && candidate.translation.trim() !== ''
  if (!hasOcr || !hasTranslation) return 'none'
  if (mode === 'bilingual') return 'bilingual'
  return placement === 'overlay' ? 'overlay' : 'below'
}

/**
 * 汇总图片维度的处理进度。
 * @param candidates 当前快照的图片候选。
 * @returns 候选、已处理、跳过与失败数量。
 * @author zhenghq
 */
export function summarizeWebImageProgress(
  candidates: readonly WebImageCandidate[]
): WebImageProgressSummary {
  let imageProcessed = 0
  let imageSkipped = 0
  let imageFailed = 0
  for (const candidate of candidates) {
    if (typeof candidate.translation === 'string' && candidate.translation.trim() !== '') imageProcessed += 1
    else if (candidate.skippedReason) imageSkipped += 1
    else if (candidate.error) imageFailed += 1
  }
  return {
    imageCandidates: candidates.length,
    imageProcessed,
    imageSkipped,
    imageFailed
  }
}
