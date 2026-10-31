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
