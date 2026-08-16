import { contextBridge, ipcRenderer } from 'electron'
import type { Api, TranslatePayload, Settings, DeepLxStatus, DingTalkConfigPatch } from '../shared/types'

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
   * 使用手动语言偏好重新翻译当前文本。
   * @param sourceLang 源语言偏好。
   * @param targetLang 目标语言偏好。
   * @returns 重新翻译完成后的 Promise。
   * @author zhenghq
   */
  retranslate: (sourceLang: string, targetLang: string) =>
    ipcRenderer.invoke('popup:retranslate', sourceLang, targetLang),

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
  openDeployDoc: () => ipcRenderer.send('deeplx:open-doc')
}

contextBridge.exposeInMainWorld('api', api)
