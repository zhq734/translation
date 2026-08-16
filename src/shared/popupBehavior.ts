/**
 * 判断翻译弹窗失去焦点时是否应该自动关闭。
 * @param pinned 弹窗是否已被图钉固定。
 * @returns 未固定时返回 true，固定后返回 false。
 * @author zhenghq
 */
export function shouldDismissPopupOnBlur(pinned: boolean): boolean {
  return !pinned
}
