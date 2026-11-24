import type { Settings } from '../shared/types'
import type { AiConfigurationService } from './aiConfig'
import type { DingTalkConfigurationService } from './dingtalkConfig'
import { resolveLanguagePair } from '../shared/selectionBehavior'
import { translateMain } from './messages'
import { translateStream } from './translate'

/**
 * 翻译 OCR 面板原文，等待服务就绪并沿用当前语言及提供商配置。
 * @param text OCR 原文。
 * @param whenReady 等待后台服务就绪后执行动作。
 * @param getSettings 读取当前设置。
 * @param getDingTalk 读取钉钉配置。
 * @param getAi 读取 AI 配置。
 * @param onDelta 接收翻译增量，供结果面板实时展示。
 * @returns 译文。
 * @author zhenghq
 */
export async function translateOcrPanelText(
  text: string,
  whenReady: <T>(action: () => T | Promise<T>) => Promise<T>,
  getSettings: () => Settings,
  getDingTalk: () => DingTalkConfigurationService,
  getAi: () => AiConfigurationService,
  onDelta: (delta: string) => void
): Promise<string> {
  const source = text.trim()
  if (!source || source.length > 5000) throw new Error(translateMain('error.noTranslatableText'))
  return whenReady(async () => {
    const settings = getSettings()
    const pair = resolveLanguagePair(source, settings.sourceLang, settings.targetLang)
    const credentials = settings.dingTalkEnabled ? getDingTalk().getCredentialsSnapshot() : null
    const key = settings.aiEnabled ? getAi().getApiKey() : null
    return (await translateStream(source, { ...settings, ...pair }, credentials, key, { onDelta })).translation
  })
}
