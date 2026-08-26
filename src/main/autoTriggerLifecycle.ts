/** 全局钩子支持的事件名称。 */
export type AutoTriggerHookEvent = 'mousedown' | 'mouseup' | 'keydown'

/** 全局钩子事件监听函数。 */
export type AutoTriggerHookListener = (...args: never[]) => void

/** 启动生命周期需要的最小全局钩子接口。 */
export interface AutoTriggerHook {
  on: (event: AutoTriggerHookEvent, listener: AutoTriggerHookListener) => void
  off: (event: AutoTriggerHookEvent, listener: AutoTriggerHookListener) => void
  start: () => void
}

/** 全局钩子的固定事件监听器集合。 */
export interface AutoTriggerHookListeners {
  mousedown: AutoTriggerHookListener
  mouseup: AutoTriggerHookListener
  keydown: AutoTriggerHookListener
}

/** 启动全局钩子生命周期的依赖。 */
export interface AutoTriggerLifecycleOptions {
  hook: AutoTriggerHook
  listeners: AutoTriggerHookListeners
  clearCallbackState: () => void
  logFailure: (error: unknown) => void
}

/**
 * 解绑全局钩子的固定事件监听器。
 * @param hook 待清理的全局钩子。
 * @param listeners 已注册的事件监听器集合。
 * @returns 无返回值。
 * @author zhenghq
 */
export function detachAutoTriggerHookListeners(
  hook: AutoTriggerHook,
  listeners: AutoTriggerHookListeners
): void {
  hook.off('mousedown', listeners.mousedown)
  hook.off('mouseup', listeners.mouseup)
  hook.off('keydown', listeners.keydown)
}

/**
 * 注册并启动全局钩子，失败时原子清理监听器与回调状态。
 * @param options 全局钩子、监听器、回调清理和日志依赖。
 * @returns 启动成功时返回 true，失败并完成清理时返回 false。
 * @author zhenghq
 */
export function startAutoTriggerLifecycle(options: AutoTriggerLifecycleOptions): boolean {
  const { hook, listeners } = options
  hook.on('mousedown', listeners.mousedown)
  hook.on('mouseup', listeners.mouseup)
  hook.on('keydown', listeners.keydown)
  try {
    hook.start()
    return true
  } catch (error) {
    detachAutoTriggerHookListeners(hook, listeners)
    options.clearCallbackState()
    options.logFailure(error)
    return false
  }
}
