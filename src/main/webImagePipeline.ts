/**
 * 网页图片 OCR 与翻译管道模块。
 *
 * 按候选顺序对页面图片执行取图、OCR、质量门禁与翻译，并把结果写回候选对象。
 * 单张图片的任何失败都只影响该图片本身，不会中断其余图片或整页文本翻译。
 * 该模块不依赖 Electron，便于通过依赖注入进行单元测试。
 *
 * @author zhenghq
 */

import { summarizeWebImageProgress, type WebImageProgressSummary } from '../shared/webImageOcr'
import type { WebImageCandidate } from '../shared/webPageTranslation'
import type { WebImageSource } from './webImageSource'

/** 单张图片的 OCR 结果。 */
export interface WebImageRecognition {
  /** 清洗后的识别文本。 */
  text: string
  /** OCR 文本质量分。 */
  score: number
}

/** 图片管道依赖。 */
export interface WebImagePipelineDeps {
  /** 图片取图器。 */
  source: WebImageSource
  /**
   * 对图片字节执行 OCR。
   * @param bytes 图片字节。
   * @param candidate 图片候选。
   * @returns 识别文本与质量分。
   */
  recognize(bytes: Buffer, candidate: WebImageCandidate): Promise<WebImageRecognition>
  /**
   * 翻译识别文本。
   * @param text 识别文本。
   * @param candidate 图片候选。
   * @returns 译文。
   */
  translate(text: string, candidate: WebImageCandidate): Promise<{ translation: string }>
  /** 本次任务源语言。 */
  sourceLang: string
  /** 本次任务目标语言。 */
  targetLang: string
  /** 最低 OCR 质量分，低于该值视为噪声跳过。 */
  minScore?: number
  /** 任务取消信号。 */
  signal?: AbortSignal
}

/** 图片管道处理结果。 */
export interface WebImagePipelineResult {
  /** 带有识别与译文结果的候选列表。 */
  candidates: WebImageCandidate[]
  /** 图片维度进度汇总。 */
  summary: WebImageProgressSummary
  /** 是否因取消而提前结束。 */
  cancelled: boolean
}

/**
 * 把一批图片处理结果合并进当前候选列表。
 *
 * 已存在的候选按 `imageId` 原位替换，未出现过的候选追加到末尾，
 * 保证同一候选不会因「先替换再追加」而重复计数。
 *
 * @param existing 当前已收集的图片候选。
 * @param processed 本批次新处理完成的图片候选。
 * @returns 合并后的候选列表；输入数组不会被修改。
 * @author zhenghq
 */
export function mergeWebImageResults(
  existing: readonly WebImageCandidate[],
  processed: readonly WebImageCandidate[]
): WebImageCandidate[] {
  const processedById = new Map(processed.map((candidate) => [candidate.imageId, candidate]))
  const existingIds = new Set(existing.map((candidate) => candidate.imageId))
  const merged = existing.map((candidate) => processedById.get(candidate.imageId) ?? candidate)
  for (const candidate of processed) {
    if (existingIds.has(candidate.imageId)) continue
    existingIds.add(candidate.imageId)
    merged.push(candidate)
  }
  return merged
}

/**
 * 处理一批图片候选：取图、OCR、质量门禁与翻译。
 * @param candidates 待处理的图片候选。
 * @param deps 管道依赖。
 * @returns 带结果的候选列表、进度汇总与取消标记。
 * @author zhenghq
 */
export async function processWebImageCandidates(
  candidates: readonly WebImageCandidate[],
  deps: WebImagePipelineDeps
): Promise<WebImagePipelineResult> {
  const minScore = Number.isFinite(deps.minScore) ? Number(deps.minScore) : 0.35
  const results: WebImageCandidate[] = []
  let cancelled = false

  for (const candidate of candidates) {
    if (deps.signal?.aborted) {
      cancelled = true
      results.push({ ...candidate, skippedReason: 'cancelled' })
      continue
    }
    const fetched = await deps.source.fetch(candidate)
    if (deps.signal?.aborted) {
      cancelled = true
      results.push({ ...candidate, skippedReason: 'cancelled' })
      continue
    }
    if (!fetched.ok || !fetched.bytes) {
      results.push({ ...candidate, skippedReason: fetched.reason ?? 'fetch-failed' })
      continue
    }
    let recognition: WebImageRecognition
    try {
      recognition = await deps.recognize(fetched.bytes, candidate)
    } catch {
      results.push({ ...candidate, error: 'ocr-failed' })
      continue
    }
    const text = String(recognition.text || '').trim()
    if (!text) {
      results.push({ ...candidate, skippedReason: 'no-text' })
      continue
    }
    if (!Number.isFinite(recognition.score) || recognition.score < minScore) {
      results.push({ ...candidate, ocrText: text, skippedReason: 'low-quality' })
      continue
    }
    try {
      const translated = await deps.translate(text, candidate)
      const translation = String(translated.translation || '').trim()
      if (!translation) {
        results.push({ ...candidate, ocrText: text, error: 'translate-failed' })
        continue
      }
      results.push({ ...candidate, ocrText: text, translation })
    } catch (error) {
      results.push({
        ...candidate,
        ocrText: text,
        error: error instanceof Error && error.message ? error.message : 'translate-failed'
      })
    }
  }

  return {
    candidates: results,
    summary: summarizeWebImageProgress(results),
    cancelled
  }
}
