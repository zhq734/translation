/**
 * OCR 覆盖窗口生命周期事件处理模块。
 *
 * 把「覆盖窗口 hide / closed 事件应做什么」从主进程 index.ts 抽出，使
 * 「窗口可见性变化不得释放当前会话快照」这条契约可以被真实执行与回归：
 * - hide：窗口只是暂时不可见，截图会话可能仍在进行（翻译流程正是先隐藏窗口再裁剪快照），
 *   因此只收敛等待态、活动请求与划词监听，绝不释放快照。
 * - closed：窗口被销毁意味着会话终止，除上述收尾外还必须释放当前会话快照。
 *
 * @author zhenghq
 */

/** OCR 覆盖窗口 hide 事件收尾依赖。 */
export interface OcrSelectionWindowHideDeps {
  /** 结束 Renderer 会话清理确认等待。 */
  resolveReady: (ready: boolean) => void
  /** 清空进行中的识别/复制/保存请求。 */
  clearActiveRequests: () => void
  /** 恢复普通划词监听（实现需自身幂等）。 */
  restoreSelectionListener: () => void
}

/** OCR 覆盖窗口 closed 事件收尾依赖。 */
export interface OcrSelectionWindowClosedDeps extends OcrSelectionWindowHideDeps {
  /** 释放当前会话快照。 */
  releaseSnapshot: () => void
}

/**
 * 处理 OCR 覆盖窗口 hide 事件。
 *
 * 关键契约：窗口隐藏只代表呈现状态变化，不代表截图会话终止，因此 MUST NOT 释放
 * 当前会话快照。翻译流程的既有顺序是「先隐藏覆盖窗口、再裁剪快照」，一旦在 hide
 * 中释放快照，Windows 上 hide 事件同步派发就会让紧随其后的裁剪取不到快照，报出
 * 「截图已失效，请重新截图」；macOS 上事件不同步派发因而掩盖了该缺陷。
 * @param deps 等待态、活动请求与划词监听的收尾回调。
 * @returns 无返回值。
 * @author zhenghq
 */
export function handleOcrSelectionWindowHide(deps: OcrSelectionWindowHideDeps): void {
  deps.resolveReady(false)
  deps.clearActiveRequests()
  deps.restoreSelectionListener()
}

/**
 * 处理 OCR 覆盖窗口 closed 事件。
 *
 * 窗口被销毁意味着截图会话终止，除常规收尾外必须释放当前会话快照，避免复用窗口
 * 的下一次会话读到上一轮图像。
 * @param deps 等待态、活动请求、快照释放与划词监听的收尾回调。
 * @returns 无返回值。
 * @author zhenghq
 */
export function handleOcrSelectionWindowClosed(deps: OcrSelectionWindowClosedDeps): void {
  deps.resolveReady(false)
  deps.clearActiveRequests()
  deps.releaseSnapshot()
  deps.restoreSelectionListener()
}
