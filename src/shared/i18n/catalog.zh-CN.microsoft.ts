import { defineCatalog } from './catalog.ts'

/** 中文界面词条目录：microsoft 领域补充。 */
export const microsoftZhCN = defineCatalog({
  'microsoft.error.authentication': '微软翻译网页会话已失效',
  'microsoft.error.rateLimit': '微软翻译接口请求过于频繁',
  'microsoft.error.parameter': '微软翻译请求参数无效',
  'microsoft.error.serviceUnavailable': '微软翻译服务暂时不可用',
  'microsoft.error.timeout': '微软翻译请求超时',
  'microsoft.error.network': '微软翻译网络连接失败',
  'microsoft.error.authenticationStatus': '微软翻译网页会话获取失败，请稍后重试',
  'microsoft.error.rateLimitStatus': '微软翻译接口请求过于频繁，请稍后重试',
  'microsoft.error.parameterStatus': '微软翻译请求参数不受支持',
  'microsoft.error.serviceStatus': '微软翻译服务暂时不可用，请稍后重试',
  'microsoft.error.textEmpty': '微软翻译文本不能为空',
  'microsoft.error.responseEmpty': '微软翻译响应为空',
  'microsoft.error.pageReadFailed': '微软翻译网页响应无法读取',
  'microsoft.error.redirectInvalid': '微软翻译网页重定向地址无效',
  'microsoft.error.authParametersParse': '微软翻译网页鉴权参数无法解析',
  'microsoft.error.authExpiryInvalid': '微软翻译网页鉴权有效期无效',
  'microsoft.error.responseParse': '微软翻译响应无法解析'
})
