/** 当前统一的播放目标。 */
export type PronunciationPlaybackTarget = 'translation' | 'source' | 'word'

/** 一次播放会话的租约；迟到回调通过它判断是否仍属于当前会话。 */
export interface PronunciationPlaybackLease {
  /** 判断该会话是否仍为当前会话。 */
  isCurrent(): boolean
}

/** 播放切换结果。 */
export interface PronunciationPlaybackToggleResult {
  /** 本次操作是开始还是停止。 */
  action: 'start' | 'stop'
  /** 开始播放时返回的会话租约。 */
  lease?: PronunciationPlaybackLease
}

/** 播放协调器依赖。 */
export interface PronunciationPlaybackCoordinatorOptions {
  /** 停止指定目标时调用，由界面负责释放对应音频资源。 */
  onStop(target: PronunciationPlaybackTarget): void
}

/** 三种播放目标共享的互斥协调器。 */
export interface PronunciationPlaybackCoordinator {
  /** 开始指定目标并停止其它目标。 */
  start(target: PronunciationPlaybackTarget): PronunciationPlaybackLease
  /** 重复点击同一目标时停止，否则开始新目标。 */
  toggle(target: PronunciationPlaybackTarget): PronunciationPlaybackToggleResult
  /** 返回当前播放目标。 */
  activeTarget(): PronunciationPlaybackTarget | null
  /** 停止当前会话。 */
  stop(): void
}

/**
 * 创建统一的互斥播放协调器。
 * @param options 停止目标时的清理回调。
 * @returns 播放协调器实例。
 * @author zhenghq
 */
export function createPronunciationPlaybackCoordinator(
  options: PronunciationPlaybackCoordinatorOptions
): PronunciationPlaybackCoordinator {
  let session = 0
  let active: PronunciationPlaybackTarget | null = null

  /**
   * 停止当前会话并递增序号，使旧回调立即失效。
   * @returns 无返回值。
   * @author zhenghq
   */
  function stop(): void {
    if (active === null) return
    const previous = active
    active = null
    session += 1
    options.onStop(previous)
  }

  /**
   * 开始指定目标；已有会话时先停止旧目标。
   * @param target 新的播放目标。
   * @returns 当前播放会话租约。
   * @author zhenghq
   */
  function start(target: PronunciationPlaybackTarget): PronunciationPlaybackLease {
    stop()
    active = target
    const currentSession = ++session
    return {
      isCurrent: () => currentSession === session && active === target
    }
  }

  /**
   * 切换指定目标的播放状态。
   * @param target 用户点击的播放目标。
   * @returns 开始或停止结果。
   * @author zhenghq
   */
  function toggle(target: PronunciationPlaybackTarget): PronunciationPlaybackToggleResult {
    if (active === target) {
      stop()
      return { action: 'stop' }
    }
    return { action: 'start', lease: start(target) }
  }

  return {
    start,
    toggle,
    activeTarget: () => active,
    stop
  }
}
