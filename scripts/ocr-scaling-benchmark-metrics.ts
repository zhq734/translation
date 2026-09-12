/**
 * 将 OCR 基准文本归一化为仅包含 Unicode 字母和数字的大写字符串。
 * @param text 待归一化的 OCR 文本。
 * @returns 去除空白、标点和符号后的大写文本。
 * @author zhenghq
 */
export function normalizeOcrBenchmarkText(text: string): string {
  return String(text ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toUpperCase()
}

/**
 * 计算两个字符串之间的 Levenshtein 编辑距离。
 * @param actual 实际识别文本。
 * @param expected 期望文本。
 * @returns 将实际文本转换为期望文本所需的最少编辑次数。
 * @author zhenghq
 */
function calculateLevenshteinDistance(actual: string, expected: string): number {
  if (actual === expected) return 0
  if (actual.length === 0) return expected.length
  if (expected.length === 0) return actual.length

  let previous = Array.from({ length: expected.length + 1 }, (_, index) => index)
  for (let actualIndex = 1; actualIndex <= actual.length; actualIndex += 1) {
    const current = [actualIndex]
    for (let expectedIndex = 1; expectedIndex <= expected.length; expectedIndex += 1) {
      const substitutionCost = actual[actualIndex - 1] === expected[expectedIndex - 1] ? 0 : 1
      current[expectedIndex] = Math.min(
        current[expectedIndex - 1]! + 1,
        previous[expectedIndex]! + 1,
        previous[expectedIndex - 1]! + substitutionCost
      )
    }
    previous = current
  }
  return previous[expected.length]!
}

/**
 * 按归一化文本的编辑距离计算 OCR 字符准确率。
 * @param actual OCR 实际识别文本。
 * @param expected 样本期望文本。
 * @returns 0～1 范围内的字符准确率；两个空文本返回 1。
 * @author zhenghq
 */
export function calculateCharacterAccuracy(actual: string, expected: string): number {
  const normalizedActual = normalizeOcrBenchmarkText(actual)
  const normalizedExpected = normalizeOcrBenchmarkText(expected)
  const maxLength = Math.max(normalizedActual.length, normalizedExpected.length)
  if (maxLength === 0) return 1
  const distance = calculateLevenshteinDistance(normalizedActual, normalizedExpected)
  return Math.max(0, 1 - distance / maxLength)
}
