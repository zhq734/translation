import type { PopupLanguageInteractionScope } from '../shared/types'

/**
 * 翻译弹窗语言交互保护状态。
 *
 * 原生下拉控件和异步重译是两条独立交互链路：下拉收起产生的 focusout 不能
 * 提前解除仍在进行的重译保护。使用按保护域记录的集合，既避免两个链路互相
 * 覆盖，也让重复的 pointerdown/focusin 通知保持幂等。
 * @author zhenghq
 */
export class PopupLanguageInteractionGuard {
  /** 当前处于激活状态的保护域。 */
  private readonly activeScopes = new Set<PopupLanguageInteractionScope>()

  /**
   * 开启或关闭指定保护域。
   * @param active 是否开启保护。
   * @param scope 语言交互保护域。
   * @returns 无返回值。
   * @author zhenghq
   */
  set(active: boolean, scope: PopupLanguageInteractionScope): void {
    if (active) {
      this.activeScopes.add(scope)
      return
    }
    this.activeScopes.delete(scope)
  }

  /**
   * 判断是否仍有任意语言交互保护处于激活状态。
   * @returns 至少一个保护域激活时返回 true。
   * @author zhenghq
   */
  isActive(): boolean {
    return this.activeScopes.size > 0
  }

  /**
   * 清空全部保护域，避免保护状态粘滞到下一轮弹窗。
   * @returns 无返回值。
   * @author zhenghq
   */
  reset(): void {
    this.activeScopes.clear()
  }
}
