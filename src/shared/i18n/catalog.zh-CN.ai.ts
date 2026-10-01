import { defineCatalog } from './catalog.ts'

/** 中文界面词条目录：ai 领域补充。 */
export const aiZhCN = defineCatalog({
  'ai.check.incomplete': 'AI 配置不完整，请填写 Base URL 和模型',
  'ai.check.available': 'AI 翻译配置可用',
  'ai.check.permission': 'AI 应用权限不足',
  'ai.check.rateLimit': 'AI 接口请求过于频繁，请稍后重试',
  'ai.check.serviceUnavailable': 'AI 服务暂时不可用，请稍后重试',
  'ai.credentials.secureStorageReadUnavailable': '当前系统无法使用安全存储，无法读取 AI 凭证',
  'ai.credentials.readFailed': '无法读取已保存的 AI 凭证，请重新配置',
  'ai.credentials.secureStorageWriteUnavailable': '当前系统安全存储不可用，无法保存 AI 凭证',
  'ai.error.authentication': 'AI 鉴权失败，请检查 API Key',
  'ai.error.rateLimit': 'AI 接口请求限流，请稍后重试',
  'ai.error.notFound': 'AI 模型不存在或路径错误',
  'ai.error.serviceUnavailable': 'AI 服务暂时不可用',
  'ai.error.httpStatus': 'AI 服务返回错误（HTTP {{status}}）',
  'ai.error.timeout': 'AI 请求超时',
  'ai.error.network': 'AI 网络连接失败',
  'ai.error.requestBuild': 'AI 请求构造失败',
  'ai.error.nonJsonResponse': 'AI 服务返回非 JSON 响应',
  'ai.error.responseParse': 'AI 服务响应解析失败',
  'ai.error.emptyTranslation': 'AI 返回译文为空',
  'ai.modelDiscovery.unsupported': '当前服务不支持模型列表，请手动输入模型名称',
  'ai.modelDiscovery.unsupportedResponse': '模型列表响应格式不受支持',
  'ai.modelDiscovery.parseFailed': '模型列表解析失败',
  'ai.modelDiscovery.authentication': '模型列表鉴权失败，请检查 API Key',
  'ai.modelDiscovery.rateLimit': '模型列表请求过于频繁，请稍后重试',
  'ai.modelDiscovery.loadFailed': '模型列表加载失败'
})
