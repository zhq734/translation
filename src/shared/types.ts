import type {
  ExtractedWebTextUnit,
  WebTextExtractionResult,
  WebTranslationMode,
  WebTranslationScope
} from './webPageTranslation'

export type { ExtractedWebTextUnit, WebTranslationMode, WebTranslationScope } from './webPageTranslation'

/** 划词后的弹窗触发方式。 */
export type TriggerMode = 'auto' | 'button' | 'hotkey'

/** 翻译请求的来源，用于隔离划词与手动输入状态。 */
export type TranslationOrigin = 'selection' | 'manual' | 'ocr'

/** 手动翻译允许提交的最大字符数。 */
export const MANUAL_TRANSLATION_MAX_CHARS = 5000

/** 手动翻译请求负载。 */
export interface ManualTranslateRequest {
  /** 待翻译的原文。 */
  text: string
  /** 源语言偏好。 */
  sourceLang: string
  /** 目标语言偏好。 */
  targetLang: string
}

/** 翻译请求使用的代理方式。 */
export type ProxyMode = 'system' | 'direct' | 'custom'

/** 译文朗读使用的语音引擎。 */
export type SpeechProvider = 'system' | 'edge'

/** 可供用户指定为首选项的翻译 API。 */
export type TranslationProviderId =
  | 'dingtalk'
  | 'microsoft'
  | 'ai'
  | 'dingtalk'
  | 'microsoft'
  | 'deeplx-self'
  | 'deeplx-public'
  | 'google'
  | 'mymemory'

/** 翻译 API 选择偏好，auto 表示沿用默认降级顺序。 */
export type TranslationProviderPreference = 'auto' | TranslationProviderId

/** AI 翻译支持的协议类型。 */
export type AiProtocol = 'ollama' | 'openai' | 'claude-code'

/** 默认 Ollama 本地服务地址。 */
export const DEFAULT_AI_BASE_URL = 'http://127.0.0.1:11434'

/**
 * 判断未知值是否为支持的 AI 协议。
 * @param value 待校验的协议值。
 * @returns 是否为合法 AI 协议。
 * @author zhenghq
 */
export function isAiProtocol(value: unknown): value is AiProtocol {
  return value === 'ollama' || value === 'openai' || value === 'claude-code'
}

/** AI 配置检测状态分类，与钉钉/微软保持兼容。 */
export type AiCheckCode =
  | 'available'
  | 'incomplete'
  | 'storage-unavailable'
  | 'authentication'
  | 'permission'
  | 'rate-limit'
  | 'not-found'
  | 'network'
  | 'timeout'
  | 'service'

/** AI 配置检测结果。 */
export interface AiCheckStatus {
  /** 检测是否通过。 */
  ok: boolean
  /** 脱敏后的状态分类。 */
  code: AiCheckCode
  /** 面向用户的提示。 */
  message: string
}

/** AI 模型列表加载状态。 */
export type AiModelListState = 'loading' | 'success' | 'error' | 'unsupported'

/** AI 模型列表加载结果。 */
export interface AiModelListResult {
  /** 当前加载状态。 */
  state: AiModelListState
  /** 已发现的模型名称列表。 */
  models: string[]
  /** 失败或不支持时的脱敏提示。 */
  message?: string
}

/** 自动更新当前所处阶段。 */
export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'manual-downloaded'
  | 'error'

/** 新版本采用的安装方式。 */
export type UpdateInstallMode = 'automatic' | 'manual' | 'disabled'

/** 本次更新可用的原因。 */
export type UpdateReason = 'higher-version' | 'same-version-new-build'

/** 本次更新可执行的交付动作。 */
export type UpdateAction =
  | 'automatic-download'
  | 'verified-manual-download'
  | 'open-release'

export interface UpdateProgress {
  /** 下载完成百分比。 */
  percent: number
  /** 已下载字节数。 */
  transferred: number
  /** 更新包总字节数。 */
  total: number
  /** 当前每秒下载字节数。 */
  bytesPerSecond: number
}

export interface UpdateStatus {
  /** 自动更新当前阶段。 */
  phase: UpdatePhase
  /** 当前安装版本。 */
  currentVersion: string
  /** 检测到的最新版本。 */
  latestVersion?: string
  /** 当前平台采用的安装方式。 */
  installMode: UpdateInstallMode
  /** 面向用户的状态说明。 */
  message: string
  /** 下载进度，仅下载阶段存在。 */
  progress?: UpdateProgress
  /** 手动下载和错误降级使用的 GitHub Release 地址。 */
  releaseUrl: string
  /** 手动安装模式下载到本地的 DMG 路径。 */
  manualDownloadPath?: string
  /** 当前更新是否提供可直接下载的 macOS DMG。 */
  manualDownloadAvailable?: boolean
  /** 最新安装包在 SHA256SUMS 中的校验状态。 */
  checksumStatus?: 'verified' | 'missing' | 'mismatch' | 'unreachable'
  /** 本次更新可用的原因；没有可用更新时不存在。 */
  updateReason?: UpdateReason
  /** 本次更新可执行的交付动作；没有可用更新时不存在。 */
  updateAction?: UpdateAction
  /** 当前安装构建标识的脱敏展示值。 */
  localBuildLabel?: string
  /** 远程构建标识的脱敏展示值。 */
  remoteBuildLabel?: string
  /** 本地与远程构建元数据是否均可用于比较。 */
  buildMetadataAvailable?: boolean
}

/** macOS 应用隔离属性处理结果。 */
export interface MacOSQuarantineResult {
  /** 命令是否执行成功，或应用本来就没有隔离属性。 */
  ok: boolean
  /** 面向用户展示的处理结果。 */
  message: string
}

export interface TranslatePayload {
  ok: boolean
  /** 本次结果属于划词还是手动翻译。 */
  origin?: TranslationOrigin
  /** 当前请求序号，用于 Renderer 丢弃过期结果。 */
  requestId?: number
  loading?: boolean
  /** loading 状态下展示给用户的阶段提示。 */
  loadingMessage?: string
  original?: string
  translation?: string
  detectedLang?: string
  sourceLang?: string
  targetLang?: string
  /** 用户选择的源语言偏好，用于弹窗控件回显。 */
  sourcePreference?: string
  /** 用户选择的目标语言偏好，auto 表示自动中英互译。 */
  targetPreference?: string
  /** 实际完成本次翻译的 API，用于弹窗展示降级结果。 */
  provider?: TranslationProviderId
  channel?: string
  /** 实际产出 OCR 原文的引擎，仅 OCR 翻译结果携带。 */
  ocrEngine?: OcrEngineId
  /** 清洗后的 OCR 原文，仅 OCR 翻译结果携带。 */
  ocrText?: string
  /** OCR 引擎返回的原始文本，仅 OCR 翻译结果携带。 */
  ocrRawText?: string
  /** OCR 识别失败时的细分错误分类，仅 OCR 翻译结果携带。 */
  ocrCode?: OcrErrorCode
  error?: string
}

/** 用户可选择的 OCR 引擎偏好，auto 表示按平台自动调度。 */
export type OcrEnginePreference = 'auto' | 'system' | 'paddle' | 'tesseract'

/** 实际产出 OCR 结果的引擎。 */
export type OcrEngineId = 'system' | 'paddle' | 'tesseract'

/** OCR 请求的细分错误分类，用于弹窗差异化提示。 */
export type OcrErrorCode =
  | 'permission'
  | 'no-clipboard-image'
  | 'engine-unavailable'
  | 'empty'
  | 'noise'
  | 'timeout'

/** OCR 文本行包围盒（图片像素坐标）。 */
export interface OcrBoundingBox {
  /** 左坐标。 */
  x: number
  /** 上坐标。 */
  y: number
  /** 宽度。 */
  width: number
  /** 高度。 */
  height: number
}

/** OCR 识别出的单行文本。 */
export interface OcrTextLine {
  /** 识别出的行文本。 */
  text: string
  /** 文本包围盒，部分引擎不提供。 */
  box?: OcrBoundingBox
  /** 识别置信度（0-1），部分引擎不提供。 */
  confidence?: number
}

/** OCR 框选截图区域（全局屏幕坐标）。 */
export interface OcrSelectionBounds {
  /** 左上角 x 坐标。 */
  x: number
  /** 左上角 y 坐标。 */
  y: number
  /** 选区宽度。 */
  width: number
  /** 选区高度。 */
  height: number
}

/** OCR 框选窗口启动时使用的屏幕快照。 */
export interface OcrSelectionStartPayload {
  /** 屏幕快照 PNG 的 data URL。 */
  imageDataUrl: string
  /** 快照对应的全局屏幕坐标区域。 */
  bounds: OcrSelectionBounds
}

/** OCR 引擎与模型资产状态，用于设置页展示版本、许可和就绪状态。 */
export interface OcrStatus {
  /** 系统 OCR 是否可在当前平台使用。 */
  systemAvailable: boolean
  /** PaddleOCR 主链路是否已安装可用。 */
  paddleAvailable: boolean
  /** Tesseract 兜底层是否可加载。 */
  tesseractAvailable: boolean
  /** Paddle 模型名称。 */
  modelName: string
  /** Paddle 模型版本。 */
  modelVersion: string
  /** 模型许可。 */
  license: string
  /** 当前分发方式。 */
  distribution: 'bundled' | 'on-demand' | 'unavailable'
  /** 面向用户展示的状态说明。 */
  message: string
}

/** 默认 OCR 图像放大倍率。 */
export const DEFAULT_OCR_SCALE = 1.25

/**
 * 判断未知值是否为支持的 OCR 引擎偏好。
 * @param value 待校验的值。
 * @returns 是否为合法 OCR 引擎偏好。
 * @author zhenghq
 */
export function isOcrEnginePreference(value: unknown): value is OcrEnginePreference {
  return value === 'auto' || value === 'system' || value === 'paddle' || value === 'tesseract'
}

/**
 * 规范化 OCR 放大倍率：非法值回退默认倍率，合法值限制在 1~3 之间。
 * @param value 待规范化的倍率。
 * @returns 规范化后的倍率。
 * @author zhenghq
 */
export function normalizeOcrScale(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_OCR_SCALE
  return Math.min(3, Math.max(1, numeric))
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
  /** 是否在 macOS Dock 栏显示应用图标。 */
  showDockIcon: boolean
  /** 是否随系统开机自动启动应用。 */
  autoLaunch: boolean
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
  /** 是否启用免订阅的微软 Bing 在线翻译通道。 */
  microsoftEnabled: boolean
  /** 是否启用 AI 翻译通道。 */
  aiEnabled: boolean
  /** AI 翻译协议类型。 */
  aiProtocol: AiProtocol
  /** AI 服务 Base URL。 */
  aiBaseUrl: string
  /** AI 模型名称，允许手动输入。 */
  aiModel: string
  /** 是否已安全保存 AI API Key。 */
  aiApiKeyConfigured: boolean
  /** 用户在弹窗底部选择的首选翻译 API。 */
  preferredTranslationProvider: TranslationProviderPreference
  /** 译文朗读使用的语音引擎，默认使用系统内置语音。 */
  speechProvider: SpeechProvider
  /** OCR 引擎偏好，auto 表示按平台自动调度。 */
  ocrEnginePreference: OcrEnginePreference
  /** 截图翻译快捷键。 */
  ocrHotkey: string
  /** OCR 语言，auto 表示自动。 */
  ocrLang: string
  /** OCR 前图像放大倍率（1~3）。 */
  ocrScale: number
  /** 是否启用 Tesseract 兜底层。 */
  ocrTesseractEnabled: boolean
  /** 是否启用内置网页全文翻译。 */
  webTranslationEnabled: boolean
  /** 网页翻译范围。 */
  webTranslationScope: WebTranslationScope
  /** 网页翻译最大块数。 */
  webTranslationMaxBlocks: number
  /** 网页翻译最大总字符数。 */
  webTranslationMaxChars: number
  /** 网页默认显示模式。 */
  webTranslationDefaultMode: WebTranslationMode
}

/** Renderer 上报给原生 WebContentsView 的窗口内容区矩形。 */
export interface WebViewBounds {
  /** 横坐标。 */
  x: number
  /** 纵坐标。 */
  y: number
  /** 宽度。 */
  width: number
  /** 高度。 */
  height: number
}

/** 内置网页阅读器导航和加载状态。 */
export interface WebReaderState {
  /** 阅读器实例标识。 */
  readerId: string
  /** 当前页面代次。 */
  pageRevision: number
  /** 当前 URL。 */
  url: string
  /** 当前标题。 */
  title: string
  /** 页面是否正在加载。 */
  loading: boolean
  /** 是否可后退。 */
  canGoBack: boolean
  /** 是否可前进。 */
  canGoForward: boolean
  /** 细分错误提示。 */
  error?: string
  /** 页面正文是否在快照后发生变化。 */
  pageUpdated?: boolean
  /** 初始加载增量翻译窗口是否仍在收集文本。 */
  translationWindowActive?: boolean
  /** 当前任务已发现的翻译分段数量。 */
  translationDiscovered?: number
  /** 当前任务已完成的翻译分段数量。 */
  translationDone?: number
  /** 当前任务页面缓存命中数量。 */
  translationCacheHits?: number
}

/** 携带任务代次的网页文本提取结果。 */
export interface WebTranslationExtractionPayload extends WebTextExtractionResult {
  /** 阅读器实例标识。 */
  readerId: string
  /** 页面代次。 */
  pageRevision: number
}

/** 网页翻译启动参数。 */
export interface WebTranslationRunRequest {
  /** 翻译范围；省略时使用设置。 */
  scope?: WebTranslationScope
  /** 本次任务源语言，auto 表示自动检测。 */
  sourceLang?: string
  /** 本次任务目标语言。 */
  targetLang?: string
}

/** 单个网页分段翻译结果。 */
export interface WebTranslationSegmentResult {
  /** 来源文本块标识。 */
  blockId: string
  /** 来源文本单元标识。 */
  unitId: string
  /** 分段标识。 */
  segmentId: string
  /** 分段原文。 */
  text: string
  /** 译文。 */
  translation?: string
  /** 失败原因。 */
  error?: string
}

/** 网页批量翻译进度。 */
export interface WebTranslationProgressPayload {
  /** 阅读器实例标识。 */
  readerId: string
  /** 页面代次。 */
  pageRevision: number
  /** 任务标识。 */
  jobId: string
  /** 已完成分段数。 */
  done: number
  /** 当前已经发现并接受的分段数。 */
  discovered: number
  /** 当前仍在队列中等待的分段数。 */
  queued: number
  /** 总分段数。 */
  total: number
  /** 失败分段数。 */
  failed: number
  /** 是否取消。 */
  cancelled: boolean
  /** 是否只完成部分网页。 */
  partial: boolean
  /** 增量输入窗口是否已经关闭。 */
  inputClosed: boolean
  /** 页面级缓存命中的文本单元数量。 */
  cacheHits?: number
  /** 本次任务源语言。 */
  sourceLang?: string
  /** 本次任务目标语言。 */
  targetLang?: string
}

/** 已聚合的文本单元翻译结果。 */
export interface WebTranslationUnitResult extends ExtractedWebTextUnit {
  /** 完整译文。 */
  translation?: string
  /** 单元失败原因。 */
  error?: string
}

/** 原位写回统计。 */
export interface WebTranslationApplyPayload {
  /** 成功处理数量。 */
  applied: number
  /** 锚点失配数量。 */
  mismatched: number
  /** 无译文等跳过数量。 */
  skipped: number
}

/** 网页批量翻译最终结果。 */
export interface WebTranslationRunPayload {
  /** 阅读器实例标识。 */
  readerId: string
  /** 页面代次。 */
  pageRevision: number
  /** 任务标识。 */
  jobId: string
  /** 完成或失败的分段。 */
  results: WebTranslationSegmentResult[]
  /** 最终进度。 */
  progress: WebTranslationProgressPayload
  /** 是否只完成部分网页。 */
  partial: boolean
  /** 聚合后的文本单元结果。 */
  units: WebTranslationUnitResult[]
  /** 原位写回统计。 */
  apply: WebTranslationApplyPayload
  /** 本次任务源语言。 */
  sourceLang: string
  /** 本次任务目标语言。 */
  targetLang: string
  /** 页面级缓存命中的文本单元数量。 */
  cacheHits?: number
}

/** Edge 在线语音合成结果。 */
export interface EdgeSpeechResult {
  /** 是否成功生成音频。 */
  ok: boolean
  /** 临时音频数据，成功时存在。 */
  audio?: Uint8Array
  /** 音频 MIME 类型。 */
  mimeType?: string
  /** 脱敏后的失败原因。 */
  error?: string
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

/** AI 配置补丁，用于通过专用 IPC 保存公共字段及可选新 API Key。 */
export interface AiConfigPatch {
  /** 是否启用 AI 翻译通道。 */
  enabled?: boolean
  /** AI 翻译协议类型。 */
  protocol?: AiProtocol
  /** AI 服务 Base URL。 */
  baseUrl?: string
  /** AI 模型名称。 */
  model?: string
  /** 新 API Key；空字符串表示保留旧值。 */
  apiKey?: string
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

export type MicrosoftCheckCode = DingTalkCheckCode

export interface MicrosoftCheckStatus {
  /** 检测是否通过。 */
  ok: boolean
  /** 脱敏后的状态分类。 */
  code: MicrosoftCheckCode
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
  /** 订阅主进程打开手动翻译模式的通知。 */
  onManualTranslateOpen(cb: () => void): () => void
  /** 请求主进程显示并固定手动翻译模式。 */
  openManualTranslate(): void
  copy(text: string): void
  hide(): void
  /** 从翻译弹窗打开设置页面。 */
  openSettings(): void
  /** 打开内置网页翻译阅读器。 */
  openWebReader(url?: string): void
  /** 关闭内置网页翻译阅读器。 */
  closeWebReader(): void
  /** 导航到地址栏 URL。 */
  navigateWebReader(url: string): Promise<WebReaderState>
  /** 阅读器后退。 */
  webViewBack(): void
  /** 阅读器前进。 */
  webViewForward(): void
  /** 阅读器刷新。 */
  webViewReload(): void
  /** 同步原生 View 矩形。 */
  webViewSetBounds(bounds: WebViewBounds): void
  /** 显式提取当前网页可见文本。 */
  webTranslateExtract(): Promise<WebTranslationExtractionPayload>
  /** 启动当前网页批量翻译。 */
  webTranslateRun(request?: WebTranslationRunRequest): Promise<WebTranslationRunPayload>
  /** 取消当前网页翻译任务。 */
  webTranslateCancel(): void
  /** 切换远程网页的原文或译文。 */
  webTranslateSetMode(mode: WebTranslationMode): Promise<WebTranslationApplyPayload>
  /** 订阅网页阅读器状态。 */
  onWebReaderState(cb: (state: WebReaderState) => void): () => void
  /** 订阅网页翻译进度。 */
  onWebTranslateProgress(cb: (progress: WebTranslationProgressPayload) => void): () => void
  /** 订阅页面正文更新提示。 */
  onWebTranslatePageUpdated(cb: (updated: boolean) => void): () => void
  /** 停止后台翻译服务并退出应用。 */
  stopService(): void
  /** 设置翻译弹窗是否固定。 */
  setPinned(pinned: boolean): void
  /** 订阅翻译弹窗固定状态变化。 */
  onPinnedChanged(cb: (pinned: boolean) => void): () => void
  /** 点击选区旁的“译”按钮后请求翻译当前选中文字。 */
  translateSelection(): void
  /** 请求主进程打开 OCR 框选窗口。 */
  openOcrSelection(): void
  /** 请求主进程读取剪贴板图片并进行 OCR 翻译。 */
  translateClipboardImage(): void
  /** 订阅主进程打开 OCR 框选模式的通知。 */
  onOcrSelectionStart(cb: (payload: OcrSelectionStartPayload) => void): () => void
  /** 提交 OCR 框选区域。 */
  submitOcrSelection(bounds: OcrSelectionBounds): void
  /** 取消 OCR 框选。 */
  cancelOcrSelection(): void
  /** 使用弹窗中的语言偏好重新翻译当前文本。 */
  retranslate(sourceLang: string, targetLang: string, origin?: TranslationOrigin): Promise<void>
  /** 提交一条手动翻译请求。 */
  translateManual(request: ManualTranslateRequest): Promise<void>

  /**
   * 请求主进程使用 Edge 在线服务合成一段临时音频。
   * @param text 待朗读译文。
   * @param language 目标语言代码。
   * @param requestId 可选的请求标识，由 Renderer 生成并用于取消。
   * @returns 临时音频或脱敏错误。
   * @author zhenghq
   */
  synthesizeEdgeSpeech(
    text: string,
    language: string,
    requestId?: string
  ): Promise<EdgeSpeechResult>

  /**
   * 取消主进程中指定的 Edge 在线语音请求。
   * @param requestId Renderer 生成的请求标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelEdgeSpeech(requestId: string): void

  // 设置
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  onSettingsChanged(cb: (s: Settings) => void): () => void
  /** 获取 OCR 引擎与模型资产状态。 */
  getOcrStatus(): Promise<OcrStatus>
  checkDeepLx(url: string): Promise<DeepLxStatus>
  /** 保存钉钉公开配置和可选 ClientSecret。 */
  setDingTalkConfig(patch: DingTalkConfigPatch): Promise<Settings>
  /** 显式清除已保存的钉钉 ClientSecret。 */
  clearDingTalkSecret(): Promise<Settings>
  /** 检测钉钉 Token 和文本翻译链路。 */
  checkDingTalk(): Promise<DingTalkCheckStatus>
  /**
   * 检测免订阅微软 Bing 在线翻译链路。
   * @returns 结构化脱敏检测状态。
   * @author zhenghq
   */
  checkMicrosoft(): Promise<MicrosoftCheckStatus>
  /**
   * 保存 AI 公共配置及可选新 API Key。
   * @param patch AI 配置补丁。
   * @returns 保存成功后的脱敏公开设置。
   * @author zhenghq
   */
  setAiConfig(patch: AiConfigPatch): Promise<Settings>
  /**
   * 显式清除已保存的 AI API Key。
   * @returns 清除后的脱敏公开设置。
   * @author zhenghq
   */
  clearAiApiKey(): Promise<Settings>
  /**
   * 根据当前 AI 配置加载模型列表。
   * @returns 结构化脱敏模型列表结果。
   * @author zhenghq
   */
  listAiModels(): Promise<AiModelListResult>
  /**
   * 检测 AI 配置能否完成一次最小翻译请求。
   * @returns 结构化脱敏检测状态。
   * @author zhenghq
   */
  checkAi(): Promise<AiCheckStatus>
  getDockerCommand(port: number): Promise<string>
  openDeployDoc(): void

  // 自动更新
  /**
   * 获取当前自动更新状态。
   * @returns 当前自动更新状态。
   * @author zhenghq
   */
  getUpdateStatus(): Promise<UpdateStatus>
  /**
   * 主动检查 GitHub Release 最新版本。
   * @returns 检查请求发出后的自动更新状态。
   * @author zhenghq
   */
  checkForUpdates(): Promise<UpdateStatus>
  /**
   * 下载更新；手动 macOS 模式下保存并打开 DMG。
   * @returns 操作完成后的自动更新状态。
   * @author zhenghq
   */
  downloadUpdate(): Promise<UpdateStatus>
  /**
   * 安装已下载更新并重新启动应用。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate(): void
  /**
   * 打开 GitHub Release 页面。
   * @returns 页面打开完成后的 Promise。
   * @author zhenghq
   */
  openUpdatePage(): Promise<void>
  /**
   * 在用户确认后解除固定 macOS 应用的隔离属性。
   * @returns 解除操作的结构化结果。
   * @author zhenghq
   */
  removeMacOSQuarantine(): Promise<MacOSQuarantineResult>
  /**
   * 订阅自动更新状态变化。
   * @param cb 自动更新状态回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onUpdateStatusChanged(cb: (status: UpdateStatus) => void): () => void
}
