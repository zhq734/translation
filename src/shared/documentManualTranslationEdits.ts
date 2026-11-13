import type {
  DocumentBlock,
  DocumentImageBlock,
  DocumentModel,
  DocumentTableCell,
  DocumentTextBlock
} from './documentTypes.ts'

/** 单次导入手动译文编辑的最大数量。 */
const MAX_MANUAL_TRANSLATION_EDITS = 10_000

/** 手动编辑目标标识的最大长度。 */
const MAX_TARGET_ID_LENGTH = 512

/** 单条手动译文的字符数上限。 */
const MAX_MANUAL_TRANSLATION_TEXT_LENGTH = 200_000

/** 普通文本 run 的手动译文编辑。 */
export interface DocumentManualTranslationRunEdit {
  /** 所属页面稳定标识。 */
  pageId: string
  /** 所属文本区块稳定标识；表格单元格内区块同样适用。 */
  blockId: string
  /** 文本片段稳定标识。 */
  runId: string
  /** 用户最终确认的译文。 */
  text: string
}

/** OCR 区域的手动译文编辑。 */
export interface DocumentManualTranslationOcrEdit {
  /** 所属页面稳定标识。 */
  pageId: string
  /** 所属图片区块稳定标识。 */
  blockId: string
  /** OCR 区域稳定标识。 */
  regionId: string
  /** 用户最终确认的 OCR 译文。 */
  text: string
}

/** 手动译文编辑联合类型。 */
export type DocumentManualTranslationEdit =
  | DocumentManualTranslationRunEdit
  | DocumentManualTranslationOcrEdit

/**
 * 校验稳定的编辑目标标识，拒绝空值、超长和控制字符。
 * @param value 未信任标识。
 * @returns 合法标识，否则返回 null。
 * @author zhenghq
 */
function normalizeEditId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TARGET_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)) return null
  return value
}

/**
 * 校验用户可编辑的译文文本。
 * @param value 未信任译文。
 * @returns 合法文本，否则返回 null。
 * @author zhenghq
 */
function normalizeEditText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_MANUAL_TRANSLATION_TEXT_LENGTH) return null
  // 换行是可安全保留的排版字符；其余控制字符（含 CR、TAB）不得进入导出模型。
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value)) return null
  return value
}

/**
 * 规范化 Renderer 提交的手动译文编辑列表。
 * @param value 未信任编辑列表。
 * @returns 仅含白名单字段的编辑列表；任一字段非法时返回 null。
 * @author zhenghq
 */
export function normalizeDocumentManualTranslationEdits(
  value: unknown
): DocumentManualTranslationEdit[] | null {
  if (!Array.isArray(value) || value.length > MAX_MANUAL_TRANSLATION_EDITS) return null
  const normalized: DocumentManualTranslationEdit[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const candidate = item as Record<string, unknown>
    const pageId = normalizeEditId(candidate.pageId)
    const blockId = normalizeEditId(candidate.blockId)
    const text = normalizeEditText(candidate.text)
    const runId = candidate.runId === undefined ? undefined : normalizeEditId(candidate.runId)
    const regionId = candidate.regionId === undefined ? undefined : normalizeEditId(candidate.regionId)
    if (!pageId || !blockId || text === null || Boolean(runId) === Boolean(regionId)) return null
    if (candidate.runId !== undefined && runId === null) return null
    if (candidate.regionId !== undefined && regionId === null) return null
    normalized.push(runId
      ? { pageId, blockId, runId, text }
      : { pageId, blockId, regionId: regionId!, text })
  }
  return normalized
}

/**
 * 在页面区块树中原地定位稳定区块标识；表格单元格会递归搜索。
 * @param blocks 当前区块数组。
 * @param blockId 目标区块标识。
 * @returns 命中的区块，否则返回 null。
 * @author zhenghq
 */
function findBlock(blocks: DocumentBlock[], blockId: string): DocumentBlock | null {
  for (const block of blocks) {
    if (block.blockId === blockId) return block
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) {
        const nested = findBlock(cell.blocks, blockId)
        if (nested) return nested
      }
    }
  }
  return null
}

/**
 * 应用单条手动译文编辑。
 * @param model 待修改模型副本。
 * @param edit 已规范化的编辑。
 * @returns 是否成功定位并写入。
 * @author zhenghq
 */
function applySingleEdit(model: DocumentModel, edit: DocumentManualTranslationEdit): boolean {
  const page = model.pages.find((candidate) => candidate.pageId === edit.pageId)
  if (!page) return false
  const block = findBlock(page.blocks, edit.blockId)
  if (!block) return false
  if ('runId' in edit) {
    if (block.kind !== 'text') return false
    const run = block.runs.find((candidate) => candidate.runId === edit.runId)
    if (!run) return false
    run.text = edit.text
    run.manuallyEdited = true
    return true
  }
  if (block.kind !== 'image') return false
  const region = block.ocrRegions?.find((candidate) => candidate.regionId === edit.regionId)
  if (!region) return false
  region.translatedText = edit.text
  region.manuallyEdited = true
  return true
}

/**
 * 将手动译文编辑原子地应用到文档模型。
 * @param model 当前文档模型。
 * @param edits 未规范化的编辑列表。
 * @returns 写入后的新模型；任一目标缺失或输入非法时返回 null。
 * @author zhenghq
 */
export function applyDocumentManualTranslationEdits(
  model: DocumentModel,
  edits: unknown
): DocumentModel | null {
  const normalized = normalizeDocumentManualTranslationEdits(edits)
  if (!normalized) return null
  const updated = structuredClone(model)
  for (const edit of normalized) {
    if (!applySingleEdit(updated, edit)) return null
  }
  return updated
}

/**
 * 设置单个文本 run 或 OCR 区域的手动译文。
 * @param model 当前文档模型。
 * @param edit 单条编辑。
 * @returns 不可变的新模型；目标或输入非法时返回 null。
 * @author zhenghq
 */
export function setDocumentManualTranslationText(
  model: DocumentModel,
  edit: DocumentManualTranslationEdit
): DocumentModel | null {
  return applyDocumentManualTranslationEdits(model, [edit])
}

/**
 * 将目录标题聚合成一次原子编辑：首个非受保护 run 承载完整标题，其余可见 run 清空。
 * 目录页码等受保护片段必须原样保留。
 * @param model 当前文档模型。
 * @param pageId 目录项所属页面标识。
 * @param blockId 目录文本区块标识。
 * @param text 用户确认后的完整目录标题。
 * @returns 可直接交给原子编辑应用的 run 编辑列表；目标不存在时返回空数组。
 * @author zhenghq
 */
export function createDocumentManualTocEdits(
  model: DocumentModel,
  pageId: string,
  blockId: string,
  text: string
): DocumentManualTranslationRunEdit[] {
  const page = model.pages.find((candidate) => candidate.pageId === pageId)
  if (!page) return []
  const block = findBlock(page.blocks, blockId)
  if (!block || block.kind !== 'text' || !block.toc) return []
  return createTextBlockRunEdits(block, pageId, text)
}

/**
 * 将普通文本块或目录标题聚合成原子编辑：首个非受保护 run 承载完整文本，其余可编辑 run 清空。
 * 受保护片段必须原样保留，因此混合文本块仍可安全复用该聚合结果。
 * @param model 当前文档模型。
 * @param pageId 文本区块所属页面标识。
 * @param blockId 文本区块标识。
 * @param text 用户确认后的完整译文。
 * @returns 可直接交给原子编辑应用的 run 编辑列表；目标不存在时返回空数组。
 * @author zhenghq
 */
export function createDocumentManualTextBlockEdits(
  model: DocumentModel,
  pageId: string,
  blockId: string,
  text: string
): DocumentManualTranslationRunEdit[] {
  const page = model.pages.find((candidate) => candidate.pageId === pageId)
  if (!page) return []
  const block = findBlock(page.blocks, blockId)
  if (!block || block.kind !== 'text') return []
  return createTextBlockRunEdits(block, pageId, text)
}

/**
 * 将完整文本写入文本块中首个可编辑 run，并清空其余可编辑 run。
 * @param block 目标文本区块。
 * @param pageId 区块所属页面标识。
 * @param text 用户确认后的完整文本。
 * @returns run 编辑列表；没有可编辑 run 时返回空数组。
 * @author zhenghq
 */
function createTextBlockRunEdits(
  block: DocumentTextBlock,
  pageId: string,
  text: string
): DocumentManualTranslationRunEdit[] {
  const editableRuns = block.runs.filter((run) => run.protected !== true)
  if (editableRuns.length === 0) return []
  return editableRuns.map((run, index) => ({
    pageId,
    blockId: block.blockId,
    runId: run.runId,
    text: index === 0 ? text : ''
  }))
}

/**
 * 递归收集文本区块中已手动编辑的 run。
 * @param block 当前区块。
 * @param pageId 页面标识。
 * @param output 收集结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function collectTextBlockEdits(
  block: DocumentBlock,
  pageId: string,
  output: DocumentManualTranslationEdit[]
): void {
  if (block.kind === 'text') {
    for (const run of block.runs) {
      if (run.manuallyEdited === true) output.push({ pageId, blockId: block.blockId, runId: run.runId, text: run.text })
    }
    return
  }
  if (block.kind === 'table') {
    for (const row of block.rows) {
      for (const cell of row.cells) {
        for (const child of cell.blocks) collectTextBlockEdits(child, pageId, output)
      }
    }
    return
  }
  if (block.kind === 'image') {
    for (const region of block.ocrRegions ?? []) {
      if (region.manuallyEdited === true && region.translatedText !== undefined) {
        output.push({ pageId, blockId: block.blockId, regionId: region.regionId, text: region.translatedText })
      }
    }
  }
}

/**
 * 从文档模型收集所有已标记的手动译文编辑，保持页面与区块阅读顺序。
 * @param model 当前文档模型。
 * @returns 可与导出请求共同提交的手动编辑列表。
 * @author zhenghq
 */
export function collectDocumentManualTranslationEdits(model: DocumentModel): DocumentManualTranslationEdit[] {
  const output: DocumentManualTranslationEdit[] = []
  for (const page of model.pages) {
    for (const block of page.blocks) collectTextBlockEdits(block, page.pageId, output)
  }
  return output
}

/**
 * 将当前模型中的手动译文覆盖到最新的自动生成快照。
 * 流式更新可能暂时缺少某个页面、区块或 run；这类目标会被安全跳过，而不会使整次合并失败。
 * @param current 当前可能包含用户手改的模型。
 * @param incoming 最新自动生成模型；未提供时保留当前模型的副本。
 * @returns 已保留手改标记与文本的新模型。
 * @author zhenghq
 */
export function preserveDocumentManualTranslationEdits(
  current: DocumentModel,
  incoming: DocumentModel | undefined
): DocumentModel {
  if (!incoming) return structuredClone(current)
  const merged = structuredClone(incoming)
  for (const edit of collectDocumentManualTranslationEdits(current)) {
    // 自动更新尚未产出同一目标时保留旧手改，等待目标重新出现后再继续覆盖后续自动结果。
    applySingleEdit(merged, edit)
  }
  return merged
}
