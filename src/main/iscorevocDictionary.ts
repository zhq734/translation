import iscorevocWords from './iscorevocData.json'
import { parseIscorevocWords, type IscorevocEntry } from '../shared/pronunciationIscorevoc'

/**
 * 本地雅思词汇查询器，启动时只解析随应用打包的紧凑词表。
 * @author zhenghq
 */
export class IscorevocDictionary {
  private readonly entries: Map<string, IscorevocEntry>

  /**
   * 创建本地词表并建立小写单词索引。
   * @param payload 随应用打包的紧凑词表数组。
   * @author zhenghq
   */
  constructor(payload: unknown = iscorevocWords) {
    this.entries = new Map(
      parseIscorevocWords(JSON.stringify(payload)).map((entry) => [entry.word, entry])
    )
  }

  /**
   * 查询本地雅思词条。
   * @param word 已规范化的英文单词。
   * @returns 命中的词条；未命中时返回 null。
   * @author zhenghq
   */
  lookup(word: string): IscorevocEntry | null {
    return this.entries.get(word.trim().toLowerCase()) ?? null
  }
}

/** 应用共享的本地雅思词表查询器。 */
export const iscorevocDictionary = new IscorevocDictionary()
