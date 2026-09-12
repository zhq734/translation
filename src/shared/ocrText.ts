/** URL/JDBC 连接串中无歧义的全角标点到半角标点映射。 */
const URL_PUNCTUATION_MAP: Readonly<Record<string, string>> = {
  '／': '/',
  '？': '?',
  '＆': '&',
  '＝': '=',
  '％': '%',
  '＃': '#',
  '＠': '@'
}

/**
 * 判断文本中是否包含中日韩文字，用于决定 URL 行能否安全地移除全部空白。
 * @param text 待判断文本。
 * @returns 包含中日韩文字时返回 true。
 * @author zhenghq
 */
function containsCjkText(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(text)
}

/**
 * 归一化包含 `://` 的 URL/JDBC 行：恢复全角标点，并移除连接串标点周围的空格。
 * 仅处理含 `://` 的行，且行内没有中日韩文字时才移除剩余空白，避免误伤普通中英文句子。
 * @param line 单行 OCR 文本。
 * @returns 归一化后的文本行。
 * @author zhenghq
 */
function normalizeUrlLikeLine(line: string): string {
  // OCR 可能把协议分隔符整体识别成全角形式，先统一再判断是否为 URL 行。
  const protocolNormalized = line.replace(/：\s*[／/]\s*[／/]/gu, '://')
  if (!protocolNormalized.includes('://')) return line

  const normalized = protocolNormalized
    .replace(/[／？＆＝％＃＠]/gu, (character) =>
      URL_PUNCTUATION_MAP[character] ?? character)
    // 冒号仅在紧邻 ASCII 标识符、数字或 `//` 时转换，避免改写中文说明中的全角冒号。
    .replace(/(?<=[A-Za-z0-9_\]\-])：/gu, ':')
    .replace(/：(?=\/\/|\d)/gu, ':')
    // 全角句点通常在 IP 地址中替代半角点，仅处理数字之间的句点。
    .replace(/\s*．\s*/gu, '.')
    .replace(/(\d)\s*[。｡]\s*(?=\d)/gu, '$1.')
    .replace(/\s*([.:/?#&=@])\s*/gu, '$1')

  return containsCjkText(normalized) ? normalized : normalized.replace(/\s+/gu, '')
}

/**
 * 清洗 OCR 原始文本：移除零宽字符、收敛竖线与空白、规整标点前空格并过滤空行。
 * 迁移自 Lumi-translate 的 cleanOcrText 经验，保证进入翻译管道前文本干净稳定。
 * @param text OCR 引擎返回的原始文本。
 * @returns 清洗后的文本；无有效内容时返回空字符串。
 * @author zhenghq
 */
export function cleanOcrText(text: string): string {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[|｜]{2,}/g, '|')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((line) => normalizeUrlLikeLine(
      line.trim().replace(/\s+([,.!?;:，。！？、；：])/g, '$1')
    ))
    .filter(Boolean)
    .join('\n')
    .trim()
}
