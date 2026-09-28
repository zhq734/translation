import { defineCatalog } from './catalog.ts'

/** 中文界面词条目录：主进程服务与启动错误。 */
export const appZhCN = defineCatalog({
  'app.serviceNotInitialized.dingtalk': '钉钉配置服务尚未初始化',
  'app.serviceNotInitialized.aiConfig': 'AI 配置服务尚未初始化',
  'app.serviceNotInitialized.deepLx': 'DeepLX 配置服务尚未初始化',
  'app.serviceNotInitialized.update': '自动更新服务尚未初始化',
  'app.serviceNotInitialized.webReader': '网页阅读器尚未初始化',
  'app.serviceNotInitialized.deepLxCheck': 'DeepLX 检测服务尚未初始化',
  'app.serviceNotInitialized.aiModelDiscovery': 'AI 模型发现服务尚未初始化',
  'app.serviceNotInitialized.aiCheck': 'AI 检测服务尚未初始化',
  'app.selectionListenerUnavailable': '划词监听未能启动，划词与双击将不可用，快捷键仍可使用'
})
