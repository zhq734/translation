import {
  DocumentWorkerHost,
  connectDocumentWorkerPort,
  type DocumentWorkerExecutor
} from './documentWorker.ts'
import type { DocumentWorkerResponseMessage } from '../shared/documentWorkerProtocol.ts'

/** worker 入口使用的父端口最小接口。 */
export interface DocumentWorkerEntryPort {
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
   * 向父进程发送协议响应。
   * @param message 已校验的响应消息。
   * @returns 无返回值。
   * @author zhenghq
   */
  postMessage(message: DocumentWorkerResponseMessage): void
}

/** worker 入口可注入依赖，测试无需启动 Electron。 */
export interface DocumentWorkerEntryDependencies {
  /**
   * 创建生产任务执行器。
   * @returns 文档 worker 执行器。
   * @author zhenghq
   */
  createExecutor(): DocumentWorkerExecutor
}

/**
 * 启动 worker 消息入口并返回幂等清理函数。
 * @param port 父进程消息端口。
 * @param dependencies 执行器工厂。
 * @returns 注销监听并释放宿主的清理函数。
 * @author zhenghq
 */
export function startDocumentWorkerEntry(
  port: DocumentWorkerEntryPort,
  dependencies: DocumentWorkerEntryDependencies
): () => void {
  const host = new DocumentWorkerHost(
    dependencies.createExecutor(),
    (response) => port.postMessage(response)
  )
  let stopped = false
  const disconnect = connectDocumentWorkerPort(host, port)
  return () => {
    if (stopped) return
    stopped = true
    disconnect()
  }
}
