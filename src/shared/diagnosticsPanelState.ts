/**
 * 取词诊断面板的展开状态类型：true 表示展开，false 表示收起。
 * @author zhenghq
 */
export type DiagnosticsPanelExpanded = boolean

/**
 * 根据当前展开状态计算点击收起/展开按钮后的下一个状态。
 * @param currentlyExpanded 当前是否展开。
 * @returns 点击后的下一个展开状态。
 * @author zhenghq
 */
export function nextDiagnosticsExpandedState(currentlyExpanded: DiagnosticsPanelExpanded): DiagnosticsPanelExpanded {
  return !currentlyExpanded
}
