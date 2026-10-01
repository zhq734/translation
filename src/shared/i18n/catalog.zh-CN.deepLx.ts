import { defineCatalog } from './catalog.ts'

/** 中文界面词条目录：DeepLX 与翻译通道。 */
export const deepLxZhCN = defineCatalog({
  'deepLx.check.notConfigured': '未配置地址',
  'deepLx.check.summary': '{{online}}/{{total}} 个服务在线',
  'deepLx.check.timeout': '连接超时',
  'deepLx.check.network': '网络连接失败',
  'translate.error.tooLong': '单次翻译最多支持 {{max}} 个字符，请先分段',
  'translate.error.allChannelsFailed': '所有翻译通道均失败',
  'translate.error.unknown': '未知错误',
  'translate.channel.cached': '缓存',
  'translate.channel.ai': 'AI 翻译',
  'translate.channel.dingtalk': '钉钉翻译',
  'translate.channel.microsoft': '微软翻译',
  'translate.channel.selfHostedDeepLx': '自建 DeepLX',
  'translate.channel.selfHostedDeepLxIndexed': '自建 DeepLX {{index}}',
  'translate.channel.publicDeepLx': '公共 DeepLX',
  'translate.check.dingtalkIncomplete': '钉钉配置不完整',
  'translate.check.dingtalkAvailable': '钉钉翻译在线且可用',
  'translate.check.microsoftAvailable': '微软翻译在线且可用',
  'translate.check.sampleText': '你好',
  'translate.deepLx.rateLimited': '限流 (429)',
  'translate.google.blocked': '被拦截（非 JSON 响应）',
  'translate.google.empty': '返回为空',
  'translate.myMemory.quotaExceeded': '免费额度已用完',
  'translate.myMemory.noResult': '无结果'
})
