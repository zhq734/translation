/** 复数词条的可用分支。 */
export interface PluralForms {
  /** 数量为零时的可选词条。 */
  zero?: string
  /** 数量为一时使用的词条。 */
  one: string
  /** 其他数量使用的词条。 */
  other: string
}

/** 单个词条允许的字符串或复数形式。 */
export type CatalogValue = string | PluralForms

/** 语义化词条目录。 */
export type Catalog = Record<string, CatalogValue>

/** 翻译插值参数。 */
export type TranslationParams = Record<string, string | number>

/** 保留目录字面量类型，便于从英文目录推导合法 key。
 * @param catalog 待声明的词条目录。
 * @returns 原目录对象。
 * @author zhenghq
 */
export function defineCatalog<T extends Catalog>(catalog: T): T {
  return catalog
}

/** 递归收集目录中的全部语义 key。
 * @param catalog 待收集的词条目录。
 * @returns 按字典序排序的 key 列表。
 * @author zhenghq
 */
export function collectTranslationKeys(catalog: Catalog): string[] {
  return Object.keys(catalog).sort((left, right) => left.localeCompare(right))
}

/** 收集词条中的全部插值占位符。
 * @param value 字符串或复数词条。
 * @returns 去重并排序后的占位符名称。
 * @author zhenghq
 */
export function collectPlaceholders(value: CatalogValue): string[] {
  const text = typeof value === 'string'
    ? value
    : [value.zero, value.one, value.other].filter((part): part is string => typeof part === 'string').join('\n')
  const placeholders = new Set<string>()
  for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu)) {
    placeholders.add(match[1])
  }
  return [...placeholders].sort((left, right) => left.localeCompare(right))
}

/** 合并基础目录和覆盖目录，返回新的目录对象。
 * @param base 基础目录。
 * @param overrides 覆盖目录。
 * @returns 合并后的目录。
 * @author zhenghq
 */
export function mergeCatalogs(base: Catalog, overrides: Catalog): Catalog {
  return { ...base, ...overrides }
}
