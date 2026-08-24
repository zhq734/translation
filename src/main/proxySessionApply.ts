/** 代理配置对象，结构与 Electron `Session.setProxy` 参数保持一致。 */
export interface SessionProxyConfig {
  /** 代理模式。 */
  mode?: string
  /** 固定代理规则。 */
  proxyRules?: string
  /** 代理绕过规则。 */
  proxyBypassRules?: string
}

/** 可应用代理配置的网络会话最小接口，便于单元测试注入假实现。 */
export interface ProxyCapableSession {
  /**
   * 为该会话设置代理配置。
   * @param config 代理配置。
   * @returns 配置生效后的 Promise。
   * @author zhenghq
   */
  setProxy(config: SessionProxyConfig): Promise<void>
  /**
   * 关闭该会话的现有连接，避免旧代理连接被继续复用。
   * @returns 连接关闭后的 Promise。
   * @author zhenghq
   */
  closeAllConnections(): Promise<void>
}

/**
 * 将同一份代理配置依次应用到多个网络会话，并释放各会话的旧连接。
 * 单个会话失败只记录日志，不影响其余会话继续应用配置。
 * @param sessions 需要应用代理的网络会话列表。
 * @param config 代理配置。
 * @returns 全部会话处理完成后的 Promise。
 * @author zhenghq
 */
export async function applyProxyToSessions(
  sessions: ProxyCapableSession[],
  config: SessionProxyConfig
): Promise<void> {
  for (const currentSession of sessions) {
    try {
      await currentSession.setProxy(config)
      await currentSession.closeAllConnections()
    } catch (error) {
      console.warn('[network] 会话代理应用失败:', (error as Error).message)
    }
  }
}
