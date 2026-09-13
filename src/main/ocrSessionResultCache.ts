import type { OcrRecognizeResult } from '../shared/ocrEngine'
import type { OcrSelectionBounds, Settings } from '../shared/types'

/**
 * 影响 OCR 识别结果的设置子集。
 *
 * 截图会话内的识别结果复用必须与这些设置严格绑定：任一字段变化都代表
 * 识别输入语义改变，缓存必须视为未命中，避免把旧设置下的文本翻译成新设置的结果。
 */
export type OcrSessionOcrSettings = Pick<
  Settings,
  'ocrLang' | 'ocrScale' | 'ocrEnginePreference' | 'ocrTesseractEnabled'
>

/** 会话识别结果缓存条目：缓存键与识别结果一一对应。 */
interface OcrSessionResultEntry {
  /** 构造该条目时使用的缓存键。 */
  key: string
  /** 识别动作产出的 OCR 结果。 */
  result: OcrRecognizeResult
}

/**
 * 把选区归一化为缓存键片段，避免浮点尾差导致同一选区被判为不同键。
 * @param bounds 选区矩形（截图窗口内逻辑坐标）。
 * @returns 形如 `x,y,w,h` 的稳定片段。
 * @author zhenghq
 */
function formatBounds(bounds: OcrSelectionBounds): string {
  const round = (value: number): number => Math.round(value)
  return [round(bounds.x), round(bounds.y), round(bounds.width), round(bounds.height)].join(',')
}

/**
 * 构造会话级 OCR 识别结果缓存键。
 *
 * 键覆盖会话序号、归一化选区与全部 OCR 相关设置，保证只有「同一会话、同一选区、
 * 同一设置」才可能命中；跨会话、调整选区或修改设置都会得到不同键。
 * @param sessionId 截图会话自增序号。
 * @param bounds 选区矩形（截图窗口内逻辑坐标）。
 * @param settings 影响 OCR 结果的设置子集。
 * @returns 稳定且可读的缓存键。
 * @author zhenghq
 */
export function buildOcrSessionResultKey(
  sessionId: number,
  bounds: OcrSelectionBounds,
  settings: OcrSessionOcrSettings
): string {
  const fingerprint = [
    settings.ocrLang,
    String(settings.ocrScale),
    settings.ocrEnginePreference,
    settings.ocrTesseractEnabled ? '1' : '0'
  ].join('|')
  return `${sessionId}|${formatBounds(bounds)}|${fingerprint}`
}

/**
 * 会话级 OCR 识别结果缓存：只保留最近一次识别结果。
 *
 * 截图会话中同一时刻只有一个有效选区，保留历史条目既无收益又会带来误命中风险，
 * 因此容量固定为 1，写入新结果即覆盖旧结果，内存占用与识别次数无关。
 * @author zhenghq
 */
export class OcrSessionResultCache {
  private entry: OcrSessionResultEntry | null = null

  /**
   * 读取指定键的识别结果。
   * @param key 缓存键。
   * @returns 命中的识别结果；键不匹配时返回 null。
   * @author zhenghq
   */
  get(key: string): OcrRecognizeResult | null {
    if (!this.entry || this.entry.key !== key) return null
    return this.entry.result
  }

  /**
   * 写入识别结果并覆盖旧条目。
   * @param key 缓存键。
   * @param result 识别动作产出的结果。
   * @returns 无返回值。
   * @author zhenghq
   */
  set(key: string, result: OcrRecognizeResult): void {
    this.entry = { key, result }
  }

  /**
   * 清空缓存；在会话终止或结果被消费后调用。
   * @returns 无返回值。
   * @author zhenghq
   */
  clear(): void {
    this.entry = null
  }

  /** 当前缓存条目数，恒为 0 或 1。 */
  get size(): number {
    return this.entry ? 1 : 0
  }
}
