import type {
  TranslationHistoryEntry,
  TranslationOrigin,
  TranslationProviderId,
  TranslatePayload
} from '../shared/types'
import { TranslationHistoryStore } from './translationHistory'

/** 成功翻译结果中需要写入历史的字段。 */
export interface TranslationHistoryOutput {
  /** 最终译文。 */
  translation?: string
  /** 实际使用的翻译提供商。 */
  provider?: TranslationProviderId
}

/** 翻译历史控制器依赖。 */
export interface TranslationHistoryControllerDependencies {
  /** 返回当前用户数据目录。 */
  getDirectory(): string
  /** 返回最近一次 OCR 使用的引擎。 */
  getOcrEngine(): TranslatePayload['ocrEngine'] | undefined
  /** 写入不影响主流程的告警日志。 */
  reportWarning(message: string): void
}

/** 统一翻译历史控制器，隔离存储初始化与入口生命周期。 */
export interface TranslationHistoryController {
  /** 列出全部历史记录。 */
  list(): Promise<TranslationHistoryEntry[]>
  /** 设置指定记录的收藏状态。 */
  setFavorite(id: string, favorite: boolean): Promise<boolean>
  /** 删除指定记录。 */
  delete(id: string): Promise<boolean>
  /** 清空全部非收藏记录。 */
  clearNonFavorites(): Promise<number>
  /** 按标识查找历史记录。 */
  find(id: string): Promise<TranslationHistoryEntry | null>
  /** 记录一次成功翻译，失败时只上报告警。 */
  record(
    text: string,
    output: TranslationHistoryOutput,
    pair: { sourceLang: string; targetLang: string },
    origin: TranslationOrigin
  ): Promise<void>
}

/**
 * 创建统一翻译历史控制器。
 * @param dependencies 用户数据目录、OCR 引擎与告警日志依赖。
 * @returns 可被翻译 IPC 和翻译流程复用的历史控制器。
 * @author zhenghq
 */
export function createTranslationHistoryController(
  dependencies: TranslationHistoryControllerDependencies
): TranslationHistoryController {
  let store: TranslationHistoryStore | null = null

  /**
   * 获取或创建绑定当前用户数据目录的历史存储。
   * @returns 统一翻译历史存储实例。
   * @author zhenghq
   */
  const getStore = (): TranslationHistoryStore => {
    if (!store) {
      store = new TranslationHistoryStore({ directory: dependencies.getDirectory() })
    }
    return store
  }

  return {
    list: () => getStore().list(),
    setFavorite: (id, favorite) => getStore().setFavorite(id, favorite),
    delete: (id) => getStore().delete(id),
    clearNonFavorites: () => getStore().clearNonFavorites(),
    async find(id) {
      const entries = await getStore().list()
      return entries.find((entry) => entry.id === id) ?? null
    },
    async record(text, output, pair, origin) {
      try {
        await getStore().record({
          sourceText: text,
          translatedText: output.translation ?? '',
          sourceLang: pair.sourceLang,
          targetLang: pair.targetLang,
          provider: output.provider,
          origin,
          ocrEngine: origin === 'ocr' ? dependencies.getOcrEngine() : undefined
        })
      } catch (error) {
        dependencies.reportWarning(
          `[translation-history] write failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
}
