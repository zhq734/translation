/**
 * 判断翻译弹窗失去焦点时是否应该自动关闭。
 * @param pinned 弹窗是否已被图钉固定。
 * @param restoringForeground 是否正在为取词主动归还前台焦点。
 * @returns 未固定时返回 true，固定后返回 false。
 * @author zhenghq
 */
export function shouldDismissPopupOnBlur(
  pinned: boolean,
  restoringForeground = false
): boolean {
  // 取词前由应用主动让弹窗退出前台时会触发 blur，这属于内部动作而非用户点击外部，
  // 此时关闭弹窗会让「正在读取选中文字…」瞬间消失，必须短路。
  if (restoringForeground) return false
  return !pinned
}
