import type { DocumentBlock, DocumentModel } from './documentTypes.ts'

/** 文档任务的语言偏好与解析后的实际语言对。 */
export interface DocumentLanguagePreference {
  /** 用户选择的源语言偏好，可保留 auto。 */
  sourcePreference: string
  /** 用户选择的目标语言偏好，可保留 auto。 */
  targetPreference: string
}

/** 文档任务冻结的实际语言方向。 */
export interface DocumentLanguagePair {
  /** 实际源语言；auto 可继续交由提供方检测。 */
  sourceLang: string
  /** 实际目标语言。 */
  targetLang: string
}

/** 文档任务冻结的语言偏好与实际语言方向。 */
export interface DocumentLanguageResolution extends DocumentLanguagePreference {
  /** 整份文档一次性解析出的实际语言对。 */
  languagePair: DocumentLanguagePair
}

/**
 * 判断文本是否更接近中文内容，用于文档级自动中英方向选择。
 * @param text 整份文档汇总后的可翻译正文。
 * @returns 文本是否以中文为主。
 * @author zhenghq
 */
function isChineseDocumentText(text: string): boolean {
  const chineseCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length
  const latinCount = (text.match(/[A-Za-z]/g) ?? []).length
  return chineseCount > 0 && chineseCount >= latinCount
}

/**
 * 收集单个区块中可参与文档方向判定的正文，剔除保护片段。
 * @param block 待检查区块。
 * @param output 按阅读顺序累积的正文。
 * @returns 无返回值。
 * @author zhenghq
 */
function collectBlockText(block: DocumentBlock, output: string[]): void {
  if (block.kind === 'text') {
    if (!block.translatable) return
    for (const run of block.runs) {
      if (run.protected || !run.text.trim()) continue
      output.push(run.text)
    }
    return
  }
  if (block.kind === 'image') {
    for (const region of block.ocrRegions ?? []) {
      if (region.status !== 'recognized' || !region.text.trim()) continue
      output.push(region.text)
    }
    return
  }
  if (block.kind !== 'table') return
  for (const row of block.rows) {
    for (const cell of row.cells) {
      for (const child of cell.blocks) collectBlockText(child, output)
    }
  }
}

/**
 * 汇总整份文档的可翻译正文，供文档级语言方向解析使用。
 * @param model 已完成解析和 OCR 的文档模型。
 * @returns 按阅读顺序拼接的正文；没有可翻译文本时为空字符串。
 * @author zhenghq
 */
export function collectDocumentLanguageText(model: DocumentModel): string {
  const text: string[] = []
  for (const page of model.pages) {
    for (const block of page.blocks) collectBlockText(block, text)
  }
  return text.join('\n')
}

/**
 * 在文档级解析一次语言方向，并保留用户原始语言偏好。
 * @param model 已完成解析和 OCR 的文档模型。
 * @param preference 用户语言偏好。
 * @returns 原始偏好与任务级实际语言对。
 * @author zhenghq
 */
export function resolveDocumentLanguagePair(
  model: DocumentModel,
  preference: DocumentLanguagePreference
): DocumentLanguageResolution {
  const sourcePreference = preference.sourcePreference || 'auto'
  const targetPreference = preference.targetPreference || 'auto'
  const documentText = collectDocumentLanguageText(model)
  const normalizedSource = sourcePreference.toUpperCase()
  const explicitTarget = targetPreference.toLowerCase() !== 'auto'
  const sourceIsChinese = normalizedSource === 'ZH' ||
    (sourcePreference.toLowerCase() === 'auto' && isChineseDocumentText(documentText))
  return {
    sourcePreference,
    targetPreference,
    languagePair: {
      sourceLang: sourcePreference,
      targetLang: explicitTarget ? targetPreference.toUpperCase() : (sourceIsChinese ? 'EN' : 'ZH')
    }
  }
}
