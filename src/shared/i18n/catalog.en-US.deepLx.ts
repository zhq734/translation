import { defineCatalog } from './catalog.ts'

/** 英文界面词条目录：DeepLX 与翻译通道。 */
export const deepLxEnUS = defineCatalog({
  'deepLx.check.notConfigured': 'No address configured',
  'deepLx.check.summary': '{{online}}/{{total}} services online',
  'deepLx.check.timeout': 'Connection timed out',
  'deepLx.check.network': 'Network connection failed',
  'translate.error.tooLong': 'A single translation supports up to {{max}} characters; please split the text first',
  'translate.error.allChannelsFailed': 'All translation channels failed',
  'translate.error.unknown': 'Unknown error',
  'translate.channel.cached': 'Cache',
  'translate.channel.ai': 'AI Translation',
  'translate.channel.dingtalk': 'DingTalk Translation',
  'translate.channel.microsoft': 'Microsoft Translator',
  'translate.channel.selfHostedDeepLx': 'Self-hosted DeepLX',
  'translate.channel.selfHostedDeepLxIndexed': 'Self-hosted DeepLX {{index}}',
  'translate.channel.publicDeepLx': 'Public DeepLX',
  'translate.check.dingtalkIncomplete': 'DingTalk configuration is incomplete',
  'translate.check.dingtalkAvailable': 'DingTalk translation is online and available',
  'translate.check.microsoftAvailable': 'Microsoft Translator is online and available',
  'translate.check.sampleText': 'Hello',
  'translate.deepLx.rateLimited': 'Rate limited (429)',
  'translate.google.blocked': 'Blocked (non-JSON response)',
  'translate.google.empty': 'Empty response',
  'translate.myMemory.quotaExceeded': 'Free quota exhausted',
  'translate.myMemory.noResult': 'No result'
})
