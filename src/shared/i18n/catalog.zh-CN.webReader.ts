import { defineCatalog } from './catalog.ts'

/** 中文界面词条目录：webReader 领域补充。 */
export const webReaderZhCN = defineCatalog({
  'webReader.error.disabled': '网页全文翻译已在设置中关闭',
  'webReader.error.pageChanged': '网页已变化，请重新提取',
  'webReader.error.extractFirst': '请先提取当前网页文本',
  'webReader.error.loadFailed': '网页加载失败：{{description}}',
  'webReader.error.notOpen': '网页阅读器尚未打开',
  'webReader.error.urlRequired': '请先打开一个 HTTP 或 HTTPS 网页',
  'webReader.error.onlyHttp': '网页阅读器仅支持 HTTP 或 HTTPS 地址',
  'webReader.error.invalidUrl': '请输入有效的网页地址',
  'webReader.error.extractionTimeout': '网页文本提取超时',
  'webReader.error.extractionFailed': '网页文本提取失败，请检查页面是否已加载完成',
  'webReader.error.documentNotReady': '网页主文档尚未准备好，请稍候再试',
  'webReader.error.rootNotReady': '网页根节点尚未创建，请稍候再试',
  'webReader.error.translationFailed': '翻译失败',
  'webReader.mainWindowTitle': '划词翻译 · 网页翻译'
})
