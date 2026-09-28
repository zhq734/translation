import { defineCatalog } from './catalog.ts'

/** 英文界面词条目录：主进程服务与启动错误。 */
export const appEnUS = defineCatalog({
  'app.serviceNotInitialized.dingtalk': 'The DingTalk configuration service is not initialized yet',
  'app.serviceNotInitialized.aiConfig': 'The AI configuration service is not initialized yet',
  'app.serviceNotInitialized.deepLx': 'The DeepLX configuration service is not initialized yet',
  'app.serviceNotInitialized.update': 'The update service is not initialized yet',
  'app.serviceNotInitialized.webReader': 'The web reader is not initialized yet',
  'app.serviceNotInitialized.deepLxCheck': 'The DeepLX check service is not initialized yet',
  'app.serviceNotInitialized.aiModelDiscovery': 'The AI model discovery service is not initialized yet',
  'app.serviceNotInitialized.aiCheck': 'The AI check service is not initialized yet',
  'app.selectionListenerUnavailable': 'The selection listener could not start; selection and double-click translation are unavailable, but hotkeys still work'
})
