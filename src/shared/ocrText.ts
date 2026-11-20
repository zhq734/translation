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
 * URL 片段仅接受链接字符及有明确标点连接的异常空白，不跨越普通词间空格。
 * ASCII 句点和末尾斜线后的空格有说明文字边界歧义，保守保留，不猜测拼接。
 * @author zhenghq
 */
const URL_LIKE_PATTERN = new RegExp(
  '[A-Za-z][A-Za-z0-9+.-]*(?:[:：][A-Za-z][A-Za-z0-9+.-]*)*[:：][ \\t]*[/／][ \\t]*[/／]' +
  '(?:' + [
    // 全角 URL 标点及数字间点号是明确的识别错误，可修复两侧空白。
    '[ \\t]*[／．？＆＝％＃＠][ \\t]*(?=[A-Za-z0-9_~%+\\[/-])',
    '(?<=\\d)[ \\t]*[.。｡][ \\t]*(?=\\d)',
    // 端口前的冒号只在后面是数字时允许连接空白。
    '[ \\t]*[:：][ \\t]*(?=\\d)',
    // 分隔符前有空格或查询参数符号后有空格时，限定为链接内的连续片段。
    '[ \\t]+[/?#&=@][ \\t]*(?=[A-Za-z0-9_~%+\\[/-])',
    '[?#&=@][ \\t]+(?=[A-Za-z0-9_~%+\\[/-])',
    "[A-Za-z0-9_~!$'()*+,;%\\[\\]-]+",
    '[./?:#&=@／．：？＆＝％＃＠]'
  ].join('|') + ')+',
  'gu'
)

/**
 * 仅归一化匹配到的 URL/JDBC 片段，恢复全角标点并移除链接内部的异常空白。
 * @param url 不含前后说明文字的 URL 片段。
 * @returns 归一化后的链接，保留所有原有 ASCII 字母和数字。
 * @author zhenghq
 */
function normalizeUrlLikeFragment(url: string): string {
  // OCR 可能把协议分隔符整体识别成全角形式，在链接片段内部统一恢复。
  return url
    .replace(/[:：]\s*[／/]\s*[／/]/gu, '://')
    .replace(/[／？＆＝％＃＠]/gu, (character) =>
      URL_PUNCTUATION_MAP[character] ?? character)
    // 冒号仅在紧邻 ASCII 标识符、数字或 `//` 时转换，避免改写中文说明中的全角冒号。
    .replace(/(?<=[A-Za-z0-9_\]\-])：/gu, ':')
    .replace(/：(?=\/\/|\d)/gu, ':')
    // 全角句点通常在 IP 地址中替代半角点，仅处理数字之间的句点。
    .replace(/\s*．\s*/gu, '.')
    .replace(/(\d)\s*[。｡]\s*(?=\d)/gu, '$1.')
    .replace(/\s*([.:/?#&=@])\s*/gu, '$1')
    .replace(/\s+/gu, '')
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
    .map((line) => line.trim()
      .replace(/\s+([,.!?;:，。！？、；：])/g, '$1')
      .replace(URL_LIKE_PATTERN, normalizeUrlLikeFragment))
    .filter(Boolean)
    .join('\n')
    .trim()
}
