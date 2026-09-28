import { defineCatalog } from './catalog.ts'

/** 中文界面词条目录：dingtalk 领域补充。 */
export const dingtalkZhCN = defineCatalog({
  'dingtalk.error.authentication': '钉钉鉴权失败',
  'dingtalk.error.permission': '钉钉应用权限不足',
  'dingtalk.error.rateLimit': '钉钉接口请求过于频繁',
  'dingtalk.error.parameter': '钉钉请求参数无效',
  'dingtalk.error.serviceUnavailable': '钉钉服务暂时不可用',
  'dingtalk.error.timeout': '钉钉请求超时',
  'dingtalk.error.network': '钉钉网络连接失败',
  'dingtalk.error.configurationIncomplete': '钉钉配置不完整，请填写 CorpId、ClientId 和 ClientSecret',
  'dingtalk.error.authenticationStatus': '钉钉鉴权失败，请检查 CorpId、ClientId 和 ClientSecret',
  'dingtalk.error.permissionStatus': '钉钉应用未获得文本翻译权限',
  'dingtalk.error.rateLimitStatus': '钉钉接口请求过于频繁，请稍后重试',
  'dingtalk.error.parameterStatus': '钉钉翻译请求参数不受支持',
  'dingtalk.error.serviceStatus': '钉钉服务暂时不可用，请稍后重试',
  'dingtalk.error.tokenResponseInvalid': '钉钉 Token 响应格式无效',
  'dingtalk.error.tokenResponseParse': '钉钉 Token 响应无法解析',
  'dingtalk.error.translationResponseEmpty': '钉钉翻译响应为空',
  'dingtalk.error.translationResponseParse': '钉钉翻译响应无法解析',
  'dingtalk.credential.secureStorageUnavailableRead': '当前系统无法使用安全存储，无法读取钉钉凭证',
  'dingtalk.credential.readFailed': '无法读取已保存的钉钉凭证，请重新配置',
  'dingtalk.credential.secureStorageUnavailableSave': '当前系统安全存储不可用，无法保存钉钉凭证'
})
