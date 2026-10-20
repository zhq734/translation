/**
 * 判断一次原文点击是否应触发单词音标查询。
 *
 * 选区、拖拽和双击都优先于查词；只有指针几乎没有移动、没有非空选区且仅单击
 * 可查询单词时才返回 true，避免破坏用户选择与复制原文的既有行为。
 * @param interaction 点击目标类型、选区状态、指针移动距离和点击次数。
 * @returns 应查询单词音标时返回 true。
 * @author zhenghq
 */
export function shouldLookupPronunciationWord(interaction: {
  /** 事件委托识别出的目标类型。 */
  targetKind: 'word' | 'text'
  /** 当前是否存在非空文本选区。 */
  hasSelection: boolean
  /** 指针按下到抬起之间的移动像素数。 */
  pointerTravel: number
  /** 当前点击次数，2 表示双击。 */
  clickCount: number
}): boolean {
  return interaction.targetKind === 'word'
    && !interaction.hasSelection
    && interaction.pointerTravel <= 4
    && interaction.clickCount === 1
}

/** 双击门控依赖的定时器能力，便于测试注入。 */
export interface PronunciationClickGateOptions {
  /** 等待第二次点击的毫秒数。 */
  delayMs: number
  /** 安排延迟回调并返回定时器标识。 */
  schedule(callback: () => void): unknown
  /** 取消尚未执行的延迟回调。 */
  cancel(timer: unknown): void
}

/** 用于区分单击与双击的点击门控。 */
export interface PronunciationClickGate {
  /** 登记一次有效单击；延迟结束后才执行查词。 */
  click(callback: () => void): void
  /** 取消待执行单击，并忽略紧随其后的第二次 click。 */
  doubleClick(): void
}

/**
 * 创建单击/双击门控，避免双击的第一次 click 提前触发查词。
 * @param options 延迟时长与定时器实现。
 * @returns 点击门控实例。
 * @author zhenghq
 */
export function createPronunciationClickGate(
  options: PronunciationClickGateOptions
): PronunciationClickGate {
  let pendingTimer: unknown = null
  let pendingCallback: (() => void) | null = null
  let suppressNextClick = false

  /**
   * 取消当前待执行单击。
   * @returns 无返回值。
   * @author zhenghq
   */
  function cancelPending(): void {
    if (pendingTimer === null) return
    options.cancel(pendingTimer)
    pendingTimer = null
    pendingCallback = null
  }

  return {
    click(callback: () => void): void {
      if (suppressNextClick) {
        suppressNextClick = false
        return
      }
      cancelPending()
      pendingCallback = callback
      pendingTimer = options.schedule(() => {
        const run = pendingCallback
        pendingTimer = null
        pendingCallback = null
        run?.()
      })
    },
    doubleClick(): void {
      cancelPending()
      suppressNextClick = true
    }
  }
}
