/**
 * 判断文件 Tab 栏是否需要把当前激活项滚动到可视区域。
 * 状态刷新会重建 Tab 节点，但只有用户真正切换激活项时才应改变横向滚动位置。
 * @param activeTabId 当前激活 Tab 标识。
 * @param lastRevealedTabId 上一次已自动定位的激活 Tab 标识。
 * @returns 激活项变化且存在有效 Tab 时返回 true。
 * @author zhenghq
 */
export function shouldRevealActiveDocumentTab(
  activeTabId: string | null,
  lastRevealedTabId: string | null
): boolean {
  return activeTabId !== null && activeTabId !== lastRevealedTabId
}

/**
 * 计算文件 Tab 左右滚动按钮的可用状态。
 * @param scrollLeft 当前横向滚动位置。
 * @param clientWidth Tab 栏可视宽度。
 * @param scrollWidth Tab 栏内容总宽度。
 * @returns 左右两个方向是否仍可滚动。
 * @author zhenghq
 */
export function resolveDocumentTabScrollState(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number
): { canScrollBackward: boolean; canScrollForward: boolean } {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
  // 小数缩放可能产生不足 1px 的误差，边界判断使用半像素容差。
  return {
    canScrollBackward: scrollLeft > 0.5,
    canScrollForward: scrollLeft < maxScrollLeft - 0.5
  }
}

/**
 * 计算文件 Tab 按钮点击后的目标横向滚动位置。
 * @param scrollLeft 当前横向滚动位置。
 * @param clientWidth Tab 栏可视宽度。
 * @param scrollWidth Tab 栏内容总宽度。
 * @param direction -1 表示向左，1 表示向右。
 * @returns 限制在合法范围内的目标滚动位置。
 * @author zhenghq
 */
export function resolveDocumentTabScrollTarget(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
  direction: -1 | 1
): number {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
  // 每次移动约四分之三可视宽度，既能快速翻页，也保留前后 Tab 的重叠上下文。
  const step = Math.max(1, clientWidth * 0.75)
  return Math.min(maxScrollLeft, Math.max(0, scrollLeft + direction * step))
}
