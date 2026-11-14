/** 文档恢复态延迟译文渲染控制器。 */
import type { DocumentWorkspaceSnapshot } from '../../shared/types'
import type { DocumentWorkspaceTab } from './documentUiModel'

/** 延迟译文渲染控制器依赖。 */
export interface DocumentDeferredTranslationRenderDependencies {
  /** 判断指定 Tab 的译文是否已经完整渲染。 */
  isTranslationRendered(tab: DocumentWorkspaceTab): boolean
  /** 判断快照是否仍属于当前活动 Tab。 */
  canRender(snapshot: DocumentWorkspaceSnapshot, tab: DocumentWorkspaceTab): boolean
  /** 执行完整快照渲染。 */
  render(snapshot: DocumentWorkspaceSnapshot, tab: DocumentWorkspaceTab): void
  /** 记录译文构建失败；不得向首帧回调继续抛错。 */
  onError(error: unknown): void
}

/** 延迟译文渲染控制器对外接口。 */
export interface DocumentDeferredTranslationRenderController {
  /** 取消尚未执行的恢复态译文构建。 */
  cancel(): void
  /** 原文首帧完成后构建恢复态译文。 */
  schedule(snapshot: DocumentWorkspaceSnapshot, tab: DocumentWorkspaceTab): void
}

/** 已排队但尚未执行的恢复态译文渲染任务。 */
interface DeferredRestoredTranslationRender {
  /** 用于取消 Tab 切换后迟到的首帧回调。 */
  token: symbol
  /** 创建任务时的快照；只有仍是当前 Tab 快照时才允许执行。 */
  snapshot: DocumentWorkspaceSnapshot
  /** 任务所属的 Tab 标识。 */
  tabId: string
}

/**
 * 等待浏览器完成后续两个渲染帧，确保刚挂载的页面已经实际绘制。
 * @param callback 绘制帧完成后执行的回调。
 * @returns 无返回值。
 * @author zhenghq
 */
export function runAfterNextPaint(callback: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(callback))
}

/**
 * 创建恢复态延迟译文渲染控制器。
 * @param dependencies 当前 Tab 校验、渲染与错误处理依赖。
 * @returns 可取消和调度恢复态译文渲染的控制器。
 * @author zhenghq
 */
export function createDocumentDeferredTranslationRenderController(
  dependencies: DocumentDeferredTranslationRenderDependencies
): DocumentDeferredTranslationRenderController {
  let deferredRender: DeferredRestoredTranslationRender | null = null

  /**
   * 取消尚未执行的恢复态译文构建。
   * @returns 无返回值。
   * @author zhenghq
   */
  function cancel(): void {
    deferredRender = null
  }

  /**
   * 原文首帧完成后构建恢复态译文；Tab、快照或文件身份变化时丢弃迟到回调。
   * @param snapshot 待渲染的恢复快照。
   * @param tab 快照所属的文档 Tab。
   * @returns 无返回值。
   * @author zhenghq
   */
  function schedule(snapshot: DocumentWorkspaceSnapshot, tab: DocumentWorkspaceTab): void {
    if (!dependencies.canRender(snapshot, tab) || dependencies.isTranslationRendered(tab)) return
    const token = Symbol('restored-translation-render')
    deferredRender = { token, snapshot, tabId: tab.id }
    try {
      // 首帧回调本身已等待绘制帧，可以立即开始构建同步译文 DOM。
      dependencies.render(snapshot, tab)
    } catch (error) {
      dependencies.onError(error)
    } finally {
      if (deferredRender?.token === token) deferredRender = null
    }
  }

  return { cancel, schedule }
}
