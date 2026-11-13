/** 可参与 Dock 最近窗口选择的常规应用窗口。 */
export type OwnedWindowKind = 'settings' | 'web-reader' | 'document-workspace'
/** Electron 窗口的最小必要接口。 */
type WindowLike = import('electron').BrowserWindow

/** 自有窗口焦点分类所需的最小窗口归属接口。 */
interface OwnedWindowOwner { ownsWindow(window: WindowLike): boolean }

/** 窗口类型及其当前实例；null 表示该类型没有存活窗口。 */
export type OwnedWindowCandidate = Readonly<{
  kind: OwnedWindowKind
  window: WindowLike | null
}>

/**
 * 收集设置页、网页翻译和文件翻译窗口。
 * @param settings 设置页窗口。
 * @param reader 网页翻译窗口。
 * @param document 文件翻译窗口。
 * @returns 窗口候选。
 * @author zhenghq
 */
export function collectOwnedWindowCandidates(
  settings: WindowLike | null,
  reader: WindowLike | null,
  document: WindowLike | null
): OwnedWindowCandidate[] {
  return [
    { kind: 'settings', window: settings },
    { kind: 'web-reader', window: reader },
    { kind: 'document-workspace', window: document }
  ]
}

/**
 * 判断焦点窗口所属的自有窗口类型。
 * @returns 匹配类型；外部窗口返回 null。
 * @author zhenghq
 */
export function resolveOwnedWindowKind(
  window: WindowLike,
  settings: WindowLike | null,
  reader: OwnedWindowOwner | null,
  document: OwnedWindowOwner | null
): OwnedWindowKind | null {
  return window === settings ? 'settings'
    : reader?.ownsWindow(window) ? 'web-reader'
      : document?.ownsWindow(window) ? 'document-workspace' : null
}

/**
 * 记录应用自有常规窗口最近一次获得焦点的时间。
 *
 * Dock 激活的语义是恢复最近的窗口，而不是固定优先某个工作区。使用递增序号
 * 代替墙钟时间，避免同一毫秒内连续 focus 事件无法区分先后。
 * @author zhenghq
 */
export class OwnedWindowFocusRecency {
  private readonly lastFocusedSequence = new Map<OwnedWindowKind, number>()
  private sequence = 0

  /**
   * 登记指定自有窗口刚刚获得焦点。
   * @param kind 获得焦点的窗口类型。
   * @returns 无返回值。
   * @author zhenghq
   */
  touch(kind: OwnedWindowKind): void {
    this.sequence += 1
    this.lastFocusedSequence.set(kind, this.sequence)
  }

  /**
   * 在仍存活且可见的候选中选择最近获得焦点的窗口。
   * @param available 当前仍可恢复的窗口类型。
   * @returns 最近获得的窗口；没有候选时返回 null。
   * @author zhenghq
   */
  mostRecent(available: readonly OwnedWindowKind[]): OwnedWindowKind | null {
    let selected: OwnedWindowKind | null = null
    let selectedSequence = 0
    for (const kind of available) {
      const sequence = this.lastFocusedSequence.get(kind) ?? 0
      if (sequence > selectedSequence) {
        selected = kind
        selectedSequence = sequence
      }
    }
    return selected
  }

  /**
   * 收集当前存活窗口，并选择最近获得焦点的目标。
   * @param candidates 当前自有窗口候选。
   * @returns 最近使用的候选；没有存活窗口时返回 null。
   * @author zhenghq
   */
  resolveMostRecent(
    candidates: readonly OwnedWindowCandidate[]
  ): OwnedWindowCandidate | null {
    const available: OwnedWindowKind[] = []
    for (const candidate of candidates) {
      if (candidate.window && !candidate.window.isDestroyed()) available.push(candidate.kind)
    }
    const kind = this.mostRecent(available)
    return kind ? candidates.find((candidate) => candidate.kind === kind) ?? null : null
  }
}
