import { cleanOcrText } from './ocrText'

const COMMON_CJK_CHARS =
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞'

/**
 * 判断 CJK 文本是否像 OCR 将其他文字误识别成的罕见汉字串。
 * @param clean 已清洗文本。
 * @returns 是否疑似罕见汉字乱码。
 * @author zhenghq
 */
function isLikelyGarbledCjk(clean: string): boolean {
  const chars = [...clean]
  const cjk = chars.filter((ch) => /[\u4e00-\u9fff]/u.test(ch))
  if (cjk.length < 12) return false
  const latin = chars.filter((ch) => /[A-Za-z]/u.test(ch)).length
  const kana = chars.filter((ch) => /[\u3040-\u30ff]/u.test(ch)).length
  const hangul = chars.filter((ch) => /[\uac00-\ud7af]/u.test(ch)).length
  if (kana > 0 || hangul > 0) return false
  const fullWidth = chars.filter((ch) => /[\uff00-\uffef]/u.test(ch)).length
  const oddSymbols = chars.filter((ch) => /[´★□<>[\]]/u.test(ch)).length
  const common = cjk.filter((ch) => COMMON_CJK_CHARS.includes(ch)).length
  const commonRatio = common / cjk.length
  const uniqueRatio = new Set(cjk).size / cjk.length
  const latinRatio = latin / Math.max(1, cjk.length)
  const diverseRareCjk = commonRatio < 0.45 && uniqueRatio > 0.25 && latinRatio < 0.12
  const repetitiveRareCjk = commonRatio < 0.45 && uniqueRatio < 0.24 && cjk.length >= 60
  const mixedGarbled = commonRatio < 0.55 && uniqueRatio > 0.18 && latinRatio < 0.12 &&
    (fullWidth > 0 || oddSymbols > 0)
  return diverseRareCjk || repetitiveRareCjk || mixedGarbled
}

/**
 * 计算 OCR 文本质量分：按总长、中文字符（加权 6 倍）、拉丁字母、数字、标点计分，
 * 乱码替换符（U+FFFD）与方块符（U+25A1）每个重罚 12 分。
 * @param text 待评分的 OCR 文本。
 * @returns 质量分，空文本为 0，乱码文本可能为负。
 * @author zhenghq
 */
export function scoreOcrText(text: string): number {
  const clean = cleanOcrText(text)
  if (!clean) return 0
  const cjk = (clean.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (clean.match(/[A-Za-z]/g) || []).length
  const digits = (clean.match(/\d/g) || []).length
  const bad = (clean.match(/[\uFFFD\u25A1]/g) || []).length
  const punctuation = (clean.match(/[,.!?;:，。！？、；：]/g) || []).length
  const lines = clean.split('\n').filter(Boolean).length
  return clean.length + cjk * 6 + latin + digits + punctuation * 0.3 + lines - bad * 12
}

/**
 * 判断 OCR 文本是否主要为噪声：空文本、有效信号不足 2 个字符、
 * 乱码占信号一半以上或有效信号密度过低时判定为噪声。
 * @param text 待判断的 OCR 文本。
 * @returns 是否为噪声文本。
 * @author zhenghq
 */
export function isMostlyNoise(text: string): boolean {
  const clean = cleanOcrText(text)
  if (!clean) return true
  const signal = (clean.match(/[\p{L}\p{N}\u4e00-\u9fff]/gu) || []).length
  const replacement = (clean.match(/[\uFFFD\u25A1]/g) || []).length
  if (signal < 2) return true
  if (isLikelyGarbledCjk(clean)) return true
  if (replacement > 0 && replacement >= signal / 2) return true
  if (clean.length > 8 && signal / clean.length < 0.35) return true
  return false
}

/**
 * 在多引擎 OCR 结果中择优：返回质量分更高（含相等时取候选）的清洗后文本；
 * 任一侧为空时返回另一侧。
 * @param current 当前已选中的文本。
 * @param candidate 候选文本。
 * @returns 更优的清洗后文本；两侧均无有效内容时返回空字符串。
 * @author zhenghq
 */
export function chooseBetterOcrText(current: string, candidate: string): string {
  const a = cleanOcrText(current)
  const b = cleanOcrText(candidate)
  if (!b) return a
  if (!a) return b
  return scoreOcrText(b) >= scoreOcrText(a) ? b : a
}
