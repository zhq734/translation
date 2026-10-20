/**
 * 按 Renderer 请求 ID 管理可取消的音标查询与音频下载。
 * @author zhenghq
 */
export class PronunciationRequestRegistry {
  private readonly requests = new Map<string, AbortController>()

  /**
   * 登记请求，并在完成时自动清理同一个请求 ID。
   * @param requestId Renderer 生成的请求 ID。
   * @param controller 请求对应的取消控制器。
   * @returns 请求完成后的结果。
   * @author zhenghq
   */
  async run<T>(requestId: string, controller: AbortController, task: Promise<T>): Promise<T> {
    this.cancel(requestId)
    this.requests.set(requestId, controller)
    try {
      return await task
    } finally {
      if (this.requests.get(requestId) === controller) this.requests.delete(requestId)
    }
  }

  /**
   * 取消并移除指定请求。
   * @param requestId Renderer 生成的请求 ID。
   * @returns 是否找到并取消了请求。
   * @author zhenghq
   */
  cancel(requestId: string): boolean {
    const controller = this.requests.get(requestId)
    if (!controller) return false
    this.requests.delete(requestId)
    controller.abort()
    return true
  }

  /**
   * 取消全部仍在进行的请求，用于弹窗关闭或进程清理。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelAll(): void {
    const controllers = Array.from(this.requests.values())
    this.requests.clear()
    for (const controller of controllers) controller.abort()
  }
}
