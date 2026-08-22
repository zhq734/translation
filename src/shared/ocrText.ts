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
    .map((line) => line.trim().replace(/\s+([,.!?;:，。！？、；：])/g, '$1'))
    .filter(Boolean)
    .join('\n')
    .trim()
}
