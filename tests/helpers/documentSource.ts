import { readFileSync } from 'node:fs'

const DOCUMENT_SOURCE_PATHS = [
  'src/renderer/src/document.ts',
  'src/renderer/src/documentHistoryController.ts',
  'src/renderer/src/documentNavigationController.ts',
  'src/renderer/src/documentExportController.ts',
  'src/renderer/src/documentManualEditController.ts',
  'src/renderer/src/documentSearchController.ts',
  'src/renderer/src/documentElements.ts',
  'src/renderer/src/documentUiModel.ts'
]

/**
 * 聚合文档工作台入口与按职责拆出的控制器源码，供契约测试统一审计。
 * @returns 使用换行连接的文档工作台实现源码。
 * @author zhenghq
 */
export function readDocumentSource(): string {
  return DOCUMENT_SOURCE_PATHS.map((path) => readFileSync(path, 'utf8')).join('\n')
}
