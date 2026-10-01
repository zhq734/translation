import {
  createTranslator,
  type TranslationParams,
  type Translator
} from '../shared/i18n'

/**
 * 主进程共享的当前界面语言翻译器。
 * 应用启动早期、测试或语言运行时尚未初始化时，统一回退到英文目录，
 * 避免任何用户可见文案退回硬编码中文。
 */
let currentTranslator: Translator = createTranslator('en-US')

/**
 * 更新主进程共享翻译器。
 * @param translator 当前界面语言对应的翻译器。
 * @returns 无返回值。
 * @author zhenghq
 */
export function setMainMessageTranslator(translator: Translator): void {
  currentTranslator = translator
}

/**
 * 读取主进程共享翻译器。
 * @returns 当前界面语言对应的翻译器。
 * @author zhenghq
 */
export function getMainMessageTranslator(): Translator {
  return currentTranslator
}

/**
 * 翻译主进程用户可见文案。
 * @param key 语义化词条 key。
 * @param params 可选插值参数。
 * @returns 当前界面语言下的词条文本。
 * @author zhenghq
 */
export function translateMain(key: string, params?: TranslationParams): string {
  return currentTranslator.t(key, params)
}

/**
 * 按数量选择主进程用户可见复数词条。
 * @param key 语义化词条 key。
 * @param count 用于选择复数分支的数量。
 * @param params 可选插值参数。
 * @returns 当前界面语言下的复数词条文本。
 * @author zhenghq
 */
export function pluralMain(
  key: string,
  count: number,
  params?: TranslationParams
): string {
  return currentTranslator.plural(key, count, params)
}

/**
 * 将主进程共享翻译器重置为英文，供测试隔离使用。
 * @returns 无返回值。
 * @author zhenghq
 */
export function resetMainMessageTranslator(): void {
  currentTranslator = createTranslator('en-US')
}
