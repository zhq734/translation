/**
 * 绑定弹窗次级入口的展开菜单。
 * @param toggle 展开按钮。
 * @param panel 包含既有动作按钮的面板。
 * @returns 关闭与解绑入口。
 * @author zhenghq
 */
export function bindPopupMenu(toggle: HTMLButtonElement, panel: HTMLElement) {
  const document = panel.ownerDocument
  const window = document.defaultView

  /** 获取当前可操作入口；无参数；返回非隐藏且未禁用的按钮。@author zhenghq */
  function items(): HTMLButtonElement[] {
    return Array.from(panel.querySelectorAll<HTMLButtonElement>('button'))
      .filter((item) => !item.disabled && !item.hidden)
  }

  /** 关闭菜单；参数控制是否归还焦点；无返回值。@author zhenghq */
  function close(restoreFocus = false): void {
    panel.hidden = true
    toggle.setAttribute('aria-expanded', 'false')
    if (restoreFocus) toggle.focus()
  }

  /** 展开菜单并聚焦入口；参数控制是否选择末项；无返回值。@author zhenghq */
  function open(last = false): void {
    panel.hidden = false
    toggle.setAttribute('aria-expanded', 'true')
    const available = items()
    available[last ? available.length - 1 : 0]?.focus()
  }

  /** 响应原生按钮点击（含 Enter/空格）；无参数、无返回值。@author zhenghq */
  function onToggle(): void {
    if (panel.hidden) open()
    else close(true)
  }

  /** 从展开按钮以方向键进入菜单；参数为键盘事件；无返回值。@author zhenghq */
  function onToggleKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    event.stopPropagation()
    open(event.key === 'ArrowUp')
  }

  /** 优先处理菜单 Esc 和方向键，Tab 保持自然顺序；参数为键盘事件；无返回值。@author zhenghq */
  function onKey(event: KeyboardEvent): void {
    if (panel.hidden) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      close(true)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const available = items()
    if (!available.length) return
    const current = available.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length
    event.preventDefault()
    event.stopPropagation()
    available[next].focus()
  }

  /** 动作执行后收起菜单，不拦截既有点击回调；参数为点击事件；无返回值。@author zhenghq */
  function onAction(event: MouseEvent): void {
    if (items().some((item) => item.contains(event.target as Node))) close(true)
  }

  /** 外部点击或 Tab 离开时收起，不抢占新焦点；参数为 DOM 事件；无返回值。@author zhenghq */
  function onOutside(event: Event): void {
    const target = event.target as Node | null
    if (!panel.hidden && !panel.contains(target) && !toggle.contains(target)) close()
  }

  /** 窗口失焦时清理展开态；无参数、无返回值。@author zhenghq */
  function onBlur(): void { close() }

  /** 关闭菜单并移除所有监听；无参数、无返回值。@author zhenghq */
  function destroy(): void {
    close()
    toggle.removeEventListener('click', onToggle)
    toggle.removeEventListener('keydown', onToggleKey)
    panel.removeEventListener('click', onAction)
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('pointerdown', onOutside)
    document.removeEventListener('focusin', onOutside)
    window?.removeEventListener('blur', onBlur)
  }

  close()
  toggle.addEventListener('click', onToggle)
  toggle.addEventListener('keydown', onToggleKey)
  panel.addEventListener('click', onAction)
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onOutside)
  document.addEventListener('focusin', onOutside)
  window?.addEventListener('blur', onBlur)
  return { close, destroy }
}
