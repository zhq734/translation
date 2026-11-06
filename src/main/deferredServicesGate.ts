/**
 * 延迟启动服务的就绪状态机。
 * 纯逻辑模块不依赖 Electron，可单独用于启动时序与失败回归测试。
 * @author zhenghq
 */

/** 延迟启动服务的就绪门控。 */
export interface DeferredServicesGate {
  /**
   * 判断重后台服务是否已经完成初始化。
   * @returns 已完成初始化时返回 true。
   * @author zhenghq
   */
  isReady(): boolean
  /**
   * 获取唯一的后台初始化 Promise。
   * @returns 成功就绪时完成、启动失败时拒绝的 Promise。
   * @author zhenghq
   */
  getInitializationPromise(): Promise<void>
  /**
   * 登记仅在服务就绪后执行的用户动作。
   * @param action 待执行的无参数动作。
   * @returns 无返回值。
   * @author zhenghq
   */
  whenReady(action: () => void): void
  /**
   * 标记服务就绪并按登记顺序执行等待动作。
   * @returns 无返回值。
   * @author zhenghq
   */
  markReady(): void
  /**
   * 标记服务启动失败并丢弃全部等待动作。
   * @param error 启动失败原因。
   * @returns 无返回值。
   * @author zhenghq
   */
  fail(error: unknown): void
}

/**
 * 创建一份被动等待重后台服务就绪的门控。
 * @returns 独立且未被触发的服务就绪门控。
 * @author zhenghq
 */
export function createDeferredServicesGate(): DeferredServicesGate {
  let ready = false
  let settled = false
  let resolveInitialization: () => void = () => undefined
  let rejectInitialization: (error: unknown) => void = () => undefined
  const pendingActions: Array<() => void> = []
  const initializationPromise = new Promise<void>((resolve, reject) => {
    resolveInitialization = resolve
    rejectInitialization = reject
  })
  void initializationPromise.catch(() => undefined)

  return {
    isReady: (): boolean => ready,
    getInitializationPromise: (): Promise<void> => initializationPromise,
    whenReady: (action: () => void): void => {
      if (ready) {
        action()
        return
      }
      if (!settled) pendingActions.push(action)
    },
    markReady: (): void => {
      if (settled) return
      settled = true
      ready = true
      const actions = pendingActions.splice(0, pendingActions.length)
      resolveInitialization()
      for (const action of actions) action()
    },
    fail: (error: unknown): void => {
      if (settled) return
      settled = true
      pendingActions.splice(0, pendingActions.length)
      rejectInitialization(error)
    }
  }
}

/**
 * 将指定门控标记为重后台服务已就绪。
 * @param gate 待标记的服务就绪门控。
 * @returns 无返回值。
 * @author zhenghq
 */
export function markDeferredServicesReady(gate: DeferredServicesGate): void {
  gate.markReady()
}

/**
 * 将指定门控标记为重后台服务启动失败。
 * @param gate 待标记的服务就绪门控。
 * @param error 启动失败原因。
 * @returns 无返回值。
 * @author zhenghq
 */
export function markDeferredServicesFailed(gate: DeferredServicesGate, error: unknown): void {
  gate.fail(error)
}
