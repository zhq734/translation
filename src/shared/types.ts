/** 划词后的弹窗触发方式。 */
export type TriggerMode = 'auto' | 'button' | 'hotkey'

/** 翻译请求使用的代理方式。 */
export type ProxyMode = 'system' | 'direct' | 'custom'

export interface TranslatePayload {
  ok: boolean
  loading?: boolean
  original?: string
  translation?: string
  detectedLang?: string
  sourceLang?: string
  targetLang?: string
  /** 用户选择的源语言偏好，用于弹窗控件回显。 */
  sourcePreference?: string
  /** 用户选择的目标语言偏好，auto 表示自动中英互译。 */
  targetPreference?: string
  channel?: string
  error?: string
}

export interface Settings {
  /** 设置结构版本，用于自动升级旧配置。 */
  schemaVersion: number
  targetLang: string
  sourceLang: string
  hotkey: string
  autoHideMs: number
  /** 自建 DeepLX 端点，留空则不启用自建通道。 */
  deepLxUrl: string
  /** 划词后的触发方式。 */
  triggerMode: TriggerMode
  /** 翻译网络代理模式。 */
  proxyMode: ProxyMode
  /** Electron 自定义代理规则，例如 http://127.0.0.1:7890。 */
  proxyRules: string
  /** 不经过代理的地址规则，例如 <local>;localhost。 */
  proxyBypassRules: string
  /** 是否启用钉钉翻译通道。 */
  dingTalkEnabled: boolean
  /** 钉钉企业内部应用 CorpId。 */
  dingTalkCorpId: string
  /** 钉钉企业内部应用 ClientId。 */
  dingTalkClientId: string
  /** 是否已经安全保存 ClientSecret。 */
  dingTalkSecretConfigured: boolean
}

export interface DingTalkConfigPatch {
  /** 是否启用钉钉翻译。 */
  enabled?: boolean
  /** 钉钉 CorpId。 */
  corpId?: string
  /** 钉钉 ClientId。 */
  clientId?: string
  /** 新 ClientSecret；空字符串表示保留原值。 */
  clientSecret?: string
}

export type DingTalkCheckCode =
  | 'available'
  | 'incomplete'
  | 'storage-unavailable'
  | 'authentication'
  | 'permission'
  | 'rate-limit'
  | 'parameter'
  | 'network'
  | 'service'

export interface DingTalkCheckStatus {
  /** 检测是否通过。 */
  ok: boolean
  /** 脱敏后的状态分类。 */
  code: DingTalkCheckCode
  /** 面向用户的提示。 */
  message: string
}

export interface DeepLxStatus {
  url: string
  online: boolean
  message?: string
}

export interface Api {
  // 悬浮窗
  onResult(cb: (p: TranslatePayload) => void): () => void
  copy(text: string): void
  hide(): void
  /** 从翻译弹窗打开设置页面。 */
  openSettings(): void
  /** 停止后台翻译服务并退出应用。 */
  stopService(): void
  /** 设置翻译弹窗是否固定。 */
  setPinned(pinned: boolean): void
  /** 订阅翻译弹窗固定状态变化。 */
  onPinnedChanged(cb: (pinned: boolean) => void): () => void
  /** 点击选区旁的“译”按钮后请求翻译当前选中文字。 */
  translateSelection(): void
  /** 使用弹窗中的语言偏好重新翻译当前文本。 */
  retranslate(sourceLang: string, targetLang: string): Promise<void>

  // 设置
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  onSettingsChanged(cb: (s: Settings) => void): () => void
  checkDeepLx(url: string): Promise<DeepLxStatus>
  /** 保存钉钉公开配置和可选 ClientSecret。 */
  setDingTalkConfig(patch: DingTalkConfigPatch): Promise<Settings>
  /** 显式清除已保存的钉钉 ClientSecret。 */
  clearDingTalkSecret(): Promise<Settings>
  /** 检测钉钉 Token 和文本翻译链路。 */
  checkDingTalk(): Promise<DingTalkCheckStatus>
  getDockerCommand(port: number): Promise<string>
  openDeployDoc(): void
}
