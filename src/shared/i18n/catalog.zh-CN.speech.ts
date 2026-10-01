import { defineCatalog } from './catalog.ts'

/** 中文界面词条目录：speech 领域补充。 */
export const speechZhCN = defineCatalog({
  'speech.error.emptyText': '朗读文本为空',
  'speech.error.cancelled': 'Edge 语音请求已取消',
  'speech.error.connectionFailed': 'Edge 语音服务连接失败',
  'speech.error.timeout': 'Edge 语音请求超时',
  'speech.error.noAudio': 'Edge 语音服务未返回音频',
  'speech.error.connectionClosed': 'Edge 语音服务连接已关闭',
  'speech.error.proxyUnsupported': '当前代理类型不支持 Edge 在线语音'
})
