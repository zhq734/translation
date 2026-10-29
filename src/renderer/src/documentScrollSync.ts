/** 文档双栏中可主动触发滚动联动的侧。 */
export type DocumentScrollSide = 'source' | 'translation'

/** 判断双栏滚动事件是否应触发联动所需的运行状态。 */
export interface DocumentScrollSyncState {
  /** 最近一次真实用户滚动意图所属的栏；没有用户意图时为 null。 */
  userScrollSide: DocumentScrollSide | null
  /** 当前事件是否已确认来自程序性 scrollTop 写入。 */
  programmatic: boolean
  /** 译文页面是否正在执行流式重排。 */
  translationLayoutUpdating: boolean
}

/**
 * 判断一次 scroll 事件是否允许驱动另一栏。
 * 程序性写入和流式布局引发的译文滚动必须忽略，只有真实用户操作才能双向联动。
 * @param side 产生 scroll 事件的栏。
 * @param state 当前滚动同步状态。
 * @returns 是否应执行比例同步。
 * @author zhenghq
 */
export function shouldSyncDocumentScroll(
  side: DocumentScrollSide,
  state: DocumentScrollSyncState
): boolean {
  if (state.programmatic) return false
  if (state.userScrollSide !== side) return false
  if (side === 'translation' && state.translationLayoutUpdating) return false
  return true
}
