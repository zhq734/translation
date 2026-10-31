import type { DocumentWarning } from './documentTypes.ts'

/**
 * 仅用于内部阶段流转、不应直接展示给用户的告警码。
 * OCR 是否执行由任务阶段和 OCR 控件表达，重复展示只会形成临时技术提示。
 */
const INTERNAL_DOCUMENT_WARNING_CODES = new Set([
  'ocr-required',
  'embedded-image-ocr-required'
])

/**
 * 判断告警是否适合展示在文档工作台。
 * @param warning 待判断的文档告警。
 * @returns 内部阶段提示返回 false，其余告警返回 true。
 * @author zhenghq
 */
export function isVisibleDocumentWarning(warning: DocumentWarning): boolean {
  return !INTERNAL_DOCUMENT_WARNING_CODES.has(warning.code)
}

/**
 * 生成告警的稳定去重键；同一告警可能同时出现在源模型和译文模型。
 * @param warning 文档告警。
 * @returns 由告警码、页面和区块组成的稳定键。
 * @author zhenghq
 */
function documentWarningKey(warning: DocumentWarning): string {
  return JSON.stringify([warning.code, warning.pageId ?? '', warning.blockId ?? ''])
}

/**
 * 过滤内部提示，并按稳定关联键合并多组告警。
 * @param warningGroups 需要合并的源、译文或其他告警组。
 * @returns 按首次出现顺序排列的可见告警。
 * @author zhenghq
 */
export function filterVisibleDocumentWarnings(
  ...warningGroups: ReadonlyArray<readonly DocumentWarning[]>
): DocumentWarning[] {
  const seen = new Set<string>()
  const visible: DocumentWarning[] = []
  for (const group of warningGroups) {
    for (const warning of group) {
      if (!isVisibleDocumentWarning(warning)) continue
      const key = documentWarningKey(warning)
      if (seen.has(key)) continue
      seen.add(key)
      visible.push(warning)
    }
  }
  return visible
}

/**
 * 统计界面实际可见的告警数量。
 * @param warningGroups 需要合并的源、译文或其他告警组。
 * @returns 过滤并去重后的告警数量。
 * @author zhenghq
 */
export function countVisibleDocumentWarnings(
  ...warningGroups: ReadonlyArray<readonly DocumentWarning[]>
): number {
  return filterVisibleDocumentWarnings(...warningGroups).length
}
