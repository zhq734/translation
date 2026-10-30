import { createDocumentWorkerExecutor } from './documentWorker.ts'
import { startDocumentWorkerEntry } from './documentWorkerEntry.ts'

/** utility process 父端口的最小接口；普通 Node 导入时不存在。 */
export interface DocumentWorkerRuntimePort {
  /**
   * 订阅父进程消息。
   * @param event 固定消息事件。
   * @param listener 消息监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  /**
   * 注销父进程消息监听。
   * @param event 固定消息事件。
   * @param listener 已注册的消息监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  off(event: 'message', listener: (event: { data: unknown }) => void): void
  /**
   * 向父进程发送 worker 响应。
   * @param message 已校验的响应消息。
   * @returns 无返回值。
   * @author zhenghq
   */
  postMessage(message: unknown): void
}

/** 运行时依赖；测试可替换父端口与执行器工厂。 */
export interface DocumentWorkerRuntimeDependencies {
  /**
   * 解析当前 utility process 父端口。
   * @returns 可用端口；普通 Node 进程返回 null。
   * @author zhenghq
   */
  resolveParentPort(): DocumentWorkerRuntimePort | null
  /**
   * 创建生产任务执行器。
   * @returns 文档 worker 执行器。
   * @author zhenghq
   */
  createExecutor(): ReturnType<typeof createDocumentWorkerExecutor>
}

/**
 * 从 Electron utility process 读取父端口；该属性只在 utility process 中存在。
 * @returns 父端口；普通 Node 进程返回 null。
 * @author zhenghq
 */
function resolveProcessParentPort(): DocumentWorkerRuntimePort | null {
  const candidate = process.parentPort as unknown as DocumentWorkerRuntimePort | null
  return candidate ?? null
}

/**
 * 启动 Electron utility process 文档 worker，并把生产依赖接入纯入口。
 * @param dependencies 可注入的父端口与执行器工厂；生产入口必须显式组合依赖。
 * @returns 幂等清理函数。
 * @throws 当运行时不在 utility process 父端口环境时抛出稳定错误。
 * @author zhenghq
 */
export function runDocumentWorkerRuntime(
  dependencies: DocumentWorkerRuntimeDependencies
): () => void {
  const port = dependencies.resolveParentPort()
  if (!port) throw new Error('document-worker-parent-port-unavailable')
  return startDocumentWorkerEntry(port, {
    createExecutor: dependencies.createExecutor
  })
}
