import { contextBridge, ipcRenderer } from 'electron'
import type {
  Api,
  TranslatePayload,
  ManualTranslateRequest,
  Settings,
  DeepLxStatus,
  DingTalkConfigPatch,
  AiConfigPatch,
  AiCheckStatus,
  AiModelListResult,
  MacOSQuarantineResult,
  UpdateStatus,
  EdgeSpeechResult,
  OcrSelectionBounds,
  OcrSelectionStartPayload,
  OcrStatus
} from '../shared/types'

const api: Api = {
  /**
   * 订阅翻译结果。
   * @param callback 翻译负载回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onResult(callback: (payload: TranslatePayload) => void) {
    const listener = (_event: unknown, payload: TranslatePayload): void => callback(payload)
    ipcRenderer.on('translate:result', listener)
    return () => ipcRenderer.removeListener('translate:result', listener)
  },
  /**
   * 订阅主进程打开手动翻译模式的通知。
   * @param callback 手动翻译打开回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onManualTranslateOpen(callback: () => void) {
    const listener = (): void => callback()
    ipcRenderer.on('manual-translate:open', listener)
    return () => ipcRenderer.removeListener('manual-translate:open', listener)
  },
  /**
   * 请求主进程显示并固定手动翻译模式。
   * @returns 无返回值。
   * @author zhenghq
   */
  openManualTranslate() {
    ipcRenderer.send('manual-translate:open-request')
  },
  /**
   * 复制文本到系统剪贴板。
   * @param text 待复制文本。
   * @returns 无返回值。
   * @author zhenghq
   */
  copy(text: string) {
    ipcRenderer.send('popup:copy', text)
  },
  /**
   * 关闭翻译弹窗。
   * @returns 无返回值。
   * @author zhenghq
   */
  hide() {
    ipcRenderer.send('popup:hide')
  },
  /**
   * 从翻译弹窗打开设置窗口。
   * @returns 无返回值。
   * @author zhenghq
   */
  openSettings() {
    ipcRenderer.send('settings:open')
  },
  /**
   * 停止后台翻译服务并退出应用。
   * @returns 无返回值。
   * @author zhenghq
   */
  stopService() {
    ipcRenderer.send('settings:stop-service')
  },
  /**
   * 设置翻译弹窗是否固定。
   * @param pinned 是否固定弹窗。
   * @returns 无返回值。
   * @author zhenghq
   */
  setPinned(pinned: boolean) {
    ipcRenderer.send('popup:set-pinned', pinned)
  },
  /**
   * 订阅翻译弹窗固定状态变化。
   * @param callback 固定状态回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onPinnedChanged(callback: (pinned: boolean) => void) {
    const listener = (_event: unknown, pinned: boolean): void => callback(pinned)
    ipcRenderer.on('popup:pinned', listener)
    return () => ipcRenderer.removeListener('popup:pinned', listener)
  },
  /**
   * 翻译当前选中文字。
   * @returns 无返回值。
   * @author zhenghq
   */
  translateSelection() {
    ipcRenderer.send('selection:translate')
  },
  /**
   * 请求主进程打开 OCR 框选窗口。
   * @returns 无返回值。
   * @author zhenghq
   */
  openOcrSelection() {
    ipcRenderer.send('ocr-selection:open')
  },
  /**
   * 请求主进程读取剪贴板图片并进行 OCR 翻译。
   * @returns 无返回值。
   * @author zhenghq
   */
  translateClipboardImage() {
    ipcRenderer.send('ocr-clipboard:translate')
  },
  /**
   * 订阅 OCR 框选模式启动通知。
   * @param callback 框选启动回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onOcrSelectionStart(callback: (payload: OcrSelectionStartPayload) => void) {
    const listener = (_event: unknown, payload: OcrSelectionStartPayload): void => callback(payload)
    ipcRenderer.on('ocr-selection:start', listener)
    return () => ipcRenderer.removeListener('ocr-selection:start', listener)
  },
  /**
   * 提交 OCR 框选截图区域。
   * @param bounds 框选区域。
   * @returns 无返回值。
   * @author zhenghq
   */
  submitOcrSelection(bounds: OcrSelectionBounds) {
    ipcRenderer.send('ocr-selection:submit', bounds)
  },
  /**
   * 取消 OCR 框选。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelOcrSelection() {
    ipcRenderer.send('ocr-selection:cancel')
  },
  /**
   * 使用手动语言偏好重新翻译当前文本。
   * @param sourceLang 源语言偏好。
   * @param targetLang 目标语言偏好。
   * @param origin 当前翻译来源。
   * @returns 重新翻译完成后的 Promise。
   * @author zhenghq
   */
  retranslate: (sourceLang: string, targetLang: string, origin?: TranslatePayload['origin']) =>
    ipcRenderer.invoke('popup:retranslate', sourceLang, targetLang, origin),
  /**
   * 提交手动翻译请求。
   * @param request 手动原文和语言偏好。
   * @returns 翻译流程完成后的 Promise。
   * @author zhenghq
   */
  translateManual: (request: ManualTranslateRequest): Promise<void> =>
    ipcRenderer.invoke('manual-translate:submit', request),

  /**
   * 请求主进程生成 Edge 在线语音临时音频。
   * @param text 待朗读译文。
   * @param language 目标语言代码。
   * @param requestId 可选请求标识，由 Renderer 生成并用于取消。
   * @returns 临时音频或脱敏错误。
   * @author zhenghq
   */
  synthesizeEdgeSpeech: (text: string, language: string, requestId?: string): Promise<EdgeSpeechResult> =>
    ipcRenderer.invoke(
      'speech:edge-synthesize',
      requestId || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text,
      language
    ),

  /**
   * 取消主进程中指定的 Edge 在线语音请求。
   * @param requestId Renderer 生成的请求标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelEdgeSpeech: (requestId: string): void => ipcRenderer.send('speech:edge-cancel', requestId),

  /**
   * 获取完整设置。
   * @returns 当前设置。
   * @author zhenghq
   */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  /**
   * 保存设置补丁。
   * @param patch 设置补丁。
   * @returns 保存后的设置。
   * @author zhenghq
   */
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),
  /**
   * 订阅设置变化。
   * @param callback 设置变化回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onSettingsChanged(callback: (settings: Settings) => void) {
    const listener = (_event: unknown, settings: Settings): void => callback(settings)
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  },
  /**
   * 获取 OCR 引擎与模型资产状态。
   * @returns OCR 状态。
   * @author zhenghq
   */
  getOcrStatus: (): Promise<OcrStatus> => ipcRenderer.invoke('ocr:get-status'),
  /**
   * 检测 DeepLX 服务状态。
   * @param url DeepLX 服务地址。
   * @returns 服务状态。
   * @author zhenghq
   */
  checkDeepLx: (url: string): Promise<DeepLxStatus> => ipcRenderer.invoke('deeplx:check', url),
  /**
   * 保存钉钉公开配置和可选 ClientSecret。
   * @param patch 钉钉配置补丁。
   * @returns 保存后的脱敏设置。
   * @author zhenghq
   */
  setDingTalkConfig: (patch: DingTalkConfigPatch): Promise<Settings> =>
    ipcRenderer.invoke('dingtalk:configure', patch),
  /**
   * 显式清除钉钉 ClientSecret。
   * @returns 清除后的脱敏设置。
   * @author zhenghq
   */
  clearDingTalkSecret: (): Promise<Settings> => ipcRenderer.invoke('dingtalk:clear-secret'),
  /**
   * 检测钉钉 Token 和文本翻译链路。
   * @returns 结构化脱敏检测状态。
   * @author zhenghq
   */
  checkDingTalk: () => ipcRenderer.invoke('dingtalk:check'),
  /**
   * 检测免订阅微软 Bing 在线翻译链路。
   * @returns 结构化脱敏检测状态。
   * @author zhenghq
   */
  checkMicrosoft: () => ipcRenderer.invoke('microsoft:check'),
  /**
   * 保存 AI 公共配置及可选新 API Key。
   * @param patch AI 配置补丁。
   * @returns 保存成功后的脱敏公开设置。
   * @author zhenghq
   */
  setAiConfig: (patch: AiConfigPatch): Promise<Settings> => ipcRenderer.invoke('ai:configure', patch),
  /**
   * 显式清除已保存的 AI API Key。
   * @returns 清除后的脱敏公开设置。
   * @author zhenghq
   */
  clearAiApiKey: (): Promise<Settings> => ipcRenderer.invoke('ai:clear-key'),
  /**
   * 根据当前 AI 配置加载模型列表。
   * @returns 结构化脱敏模型列表结果。
   * @author zhenghq
   */
  listAiModels: (): Promise<AiModelListResult> => ipcRenderer.invoke('ai:list-models'),
  /**
   * 检测 AI 配置能否完成一次最小翻译请求。
   * @returns 结构化脱敏检测状态。
   * @author zhenghq
   */
  checkAi: (): Promise<AiCheckStatus> => ipcRenderer.invoke('ai:check'),
  /**
   * 生成 DeepLX Docker 命令。
   * @param port 本机映射端口。
   * @returns Docker 命令。
   * @author zhenghq
   */
  getDockerCommand: (port: number): Promise<string> =>
    ipcRenderer.invoke('deeplx:docker-command', port),
  /**
   * 打开 DeepLX 部署文档。
   * @returns 无返回值。
   * @author zhenghq
   */
  openDeployDoc: () => ipcRenderer.send('deeplx:open-doc'),
  /**
   * 获取当前自动更新状态。
   * @returns 当前自动更新状态。
   * @author zhenghq
   */
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('updater:get-status'),
  /**
   * 主动检查 GitHub Release 最新版本。
   * @returns 检查请求发出后的自动更新状态。
   * @author zhenghq
   */
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke('updater:check'),
  /**
   * 下载新版本；手动 macOS 模式下保存并打开 DMG。
   * @returns 操作完成后的自动更新状态。
   * @author zhenghq
   */
  downloadUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke('updater:download'),
  /**
   * 安装已下载更新并重新启动应用。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate: () => ipcRenderer.send('updater:install'),
  /**
   * 打开 GitHub Release 页面。
   * @returns 页面打开完成后的 Promise。
   * @author zhenghq
   */
  openUpdatePage: (): Promise<void> => ipcRenderer.invoke('updater:open-release'),
  /**
   * 请求主进程在用户确认后解除固定 macOS 应用的隔离属性。
   * @returns 解除操作的结构化结果。
   * @author zhenghq
   */
  removeMacOSQuarantine: (): Promise<MacOSQuarantineResult> =>
    ipcRenderer.invoke('updater:remove-quarantine'),
  /**
   * 订阅自动更新状态变化。
   * @param callback 自动更新状态回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onUpdateStatusChanged(callback: (status: UpdateStatus) => void) {
    const listener = (_event: unknown, status: UpdateStatus): void => callback(status)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
