import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildOcrSessionResultKey,
  OcrSessionResultCache,
  type OcrSessionOcrSettings
} from '../src/main/ocrSessionResultCache.ts'
import type { OcrRecognizeResult } from '../src/shared/ocrEngine.ts'

const main = readFileSync('src/main/index.ts', 'utf8')

/** 基准 OCR 设置：后续用例只改动其中一个字段，验证该维度必须参与缓存键。 */
const baseSettings: OcrSessionOcrSettings = {
  ocrLang: 'auto',
  ocrScale: 2,
  ocrEnginePreference: 'auto',
  ocrTesseractEnabled: false
}

/** 基准选区（截图窗口内逻辑坐标）。 */
const baseBounds = { x: 10, y: 20, width: 200, height: 100 }

/**
 * 构造一个可用于缓存的最小 OCR 识别结果。
 * @param text 识别文本。
 * @returns OCR 识别结果。
 * @author zhenghq
 */
function buildResult(text: string): OcrRecognizeResult {
  return { text, lines: [], engine: 'paddle' }
}

/**
 * 截取源码中指定函数的函数体文本。
 * @param source 源码文本。
 * @param signature 函数签名前缀。
 * @returns 函数体文本。
 * @author zhenghq
 */
function sliceFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.notStrictEqual(start, -1, `未找到函数 ${signature}`)
  const end = source.indexOf('\n}\n', start)
  assert.notStrictEqual(end, -1, `未找到函数 ${signature} 的结尾`)
  return source.slice(start, end)
}

/**
 * 校验同一会话、同一选区、同一设置生成相同缓存键。
 * @returns 无返回值。
 * @author zhenghq
 */
test('相同会话、选区与设置应生成相同缓存键', () => {
  assert.equal(
    buildOcrSessionResultKey(3, baseBounds, baseSettings),
    buildOcrSessionResultKey(3, { ...baseBounds }, { ...baseSettings })
  )
})

/**
 * 校验会话、选区或任一 OCR 设置变化都会得到不同缓存键。
 * @returns 无返回值。
 * @author zhenghq
 */
test('会话、选区或 OCR 设置任一变化应生成不同缓存键', () => {
  const base = buildOcrSessionResultKey(3, baseBounds, baseSettings)
  assert.notEqual(buildOcrSessionResultKey(4, baseBounds, baseSettings), base, '跨会话不得命中')
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    assert.notEqual(
      buildOcrSessionResultKey(3, { ...baseBounds, [field]: baseBounds[field] + 1 }, baseSettings),
      base,
      `选区 ${field} 变化不得命中`
    )
  }
  assert.notEqual(
    buildOcrSessionResultKey(3, baseBounds, { ...baseSettings, ocrLang: 'en' }),
    base,
    'OCR 语言变化不得命中'
  )
  assert.notEqual(
    buildOcrSessionResultKey(3, baseBounds, { ...baseSettings, ocrScale: 3 }),
    base,
    'OCR 放大倍率变化不得命中'
  )
  assert.notEqual(
    buildOcrSessionResultKey(3, baseBounds, { ...baseSettings, ocrEnginePreference: 'tesseract' }),
    base,
    'OCR 引擎偏好变化不得命中'
  )
  assert.notEqual(
    buildOcrSessionResultKey(3, baseBounds, { ...baseSettings, ocrTesseractEnabled: true }),
    base,
    'Tesseract 兜底开关变化不得命中'
  )
})

/**
 * 校验缓存只保留最近一条结果，不随识别次数增长。
 * @returns 无返回值。
 * @author zhenghq
 */
test('会话识别结果缓存应只保留最近一条', () => {
  const cache = new OcrSessionResultCache()
  const firstKey = buildOcrSessionResultKey(1, baseBounds, baseSettings)
  const secondKey = buildOcrSessionResultKey(1, { ...baseBounds, width: 300 }, baseSettings)
  cache.set(firstKey, buildResult('第一段'))
  assert.equal(cache.get(firstKey)?.text, '第一段')

  cache.set(secondKey, buildResult('第二段'))
  assert.equal(cache.size, 1, '缓存条目数必须恒为 1')
  assert.equal(cache.get(secondKey)?.text, '第二段')
  assert.equal(cache.get(firstKey), null, '被覆盖的旧结果不得再命中')
})

/**
 * 校验未命中返回 null，清空后全部键失效。
 * @returns 无返回值。
 * @author zhenghq
 */
test('缓存未命中与清空语义应正确', () => {
  const cache = new OcrSessionResultCache()
  const key = buildOcrSessionResultKey(1, baseBounds, baseSettings)
  assert.equal(cache.get(key), null)

  cache.set(key, buildResult('文本'))
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(cache.get(key), null)
})

/**
 * 校验识别动作在文本非空时写入缓存。
 * @returns 无返回值。
 * @author zhenghq
 */
test('识别动作应在文本非空时写入会话识别结果缓存', () => {
  const source = sliceFunction(main, 'async function recognizeOcrSelectionAction')
  assert.match(source, /ocrSessionResultCache\.set\(/u, '识别成功后应写入会话识别结果缓存')
  assert.match(source, /buildOcrSessionResultKey\(/u, '写入前必须按会话、选区与设置构造缓存键')
  assert.match(source, /text\s*\n?\s*\?/u, '只有非空文本才应写入缓存')
})

/**
 * 校验翻译动作在裁剪快照之前查询缓存，命中时跳过重复识别。
 * @returns 无返回值。
 * @author zhenghq
 */
test('翻译动作应在裁剪前查询缓存并跳过重复 OCR', () => {
  const source = sliceFunction(main, 'async function submitOcrSelection')
  const lookupIndex = source.indexOf('ocrSessionResultCache.get(')
  const cropIndex = source.indexOf('cropOcrSnapshotSelection(bounds)')
  assert.notStrictEqual(lookupIndex, -1, '翻译流程应查询会话识别结果缓存')
  assert.notStrictEqual(cropIndex, -1, '未命中缓存时仍应裁剪快照')
  assert.ok(lookupIndex < cropIndex, '必须先查缓存再裁剪，避免命中时白丢快照')
  assert.match(source, /translateRecognizedOcrResult\(cached/u, '命中缓存时应复用识别结果进入翻译管道')
  assert.match(source, /processOcrImageBytes\(imageBytes,\s*settings\)/u, '未命中缓存时应保持原有识别路径')
})

/**
 * 校验命中缓存与未命中路径共用同一套翻译结果装配逻辑。
 * @returns 无返回值。
 * @author zhenghq
 */
test('翻译结果装配逻辑应被两条路径共用', () => {
  const translateSource = sliceFunction(main, 'async function translateRecognizedOcrResult')
  assert.match(translateSource, /translateOcrResult\(/u, '共用装配函数必须调用 translateOcrResult')
  const processSource = sliceFunction(main, 'async function processOcrImageBytes')
  assert.match(processSource, /translateRecognizedOcrResult\(/u, '识别路径应复用同一装配函数')
  assert.equal(
    processSource.match(/recognizeAdaptiveOcr\(/gu)?.length,
    1,
    '识别路径仍只执行一次 OCR'
  )
})

/**
 * 校验会话终止点清空缓存，且覆盖窗口 hide 不清空。
 * @returns 无返回值。
 * @author zhenghq
 */
test('会话终止点应清空识别结果缓存且 hide 不清空', () => {
  for (const signature of [
    'function cancelOcrSelection',
    'function finishScreenshotSession'
  ]) {
    const source = sliceFunction(main, signature)
    assert.match(source, /ocrSessionResultCache\.clear\(\)/u, `${signature} 应清空识别结果缓存`)
  }

  const openSource = sliceFunction(main, 'async function openOcrSelection')
  assert.match(openSource, /ocrSessionResultCache\.clear\(\)/u, '开始新会话应清空识别结果缓存')

  const failSource = sliceFunction(main, 'function failOcrSelectionCapture')
  assert.match(failSource, /ocrSessionResultCache\.clear\(\)/u, '采集失败应清空识别结果缓存')

  const windowStart = main.indexOf('function getOcrSelectionWindow(): BrowserWindow')
  const windowEnd = main.indexOf('\n}\n', windowStart)
  const windowSource = main.slice(windowStart, windowEnd)
  const hideStart = windowSource.indexOf("on('hide'")
  const hideEnd = windowSource.indexOf("on('closed'")
  assert.notStrictEqual(hideStart, -1, '应注册 hide 事件')
  assert.notStrictEqual(hideEnd, -1, '应注册 closed 事件')
  assert.doesNotMatch(
    windowSource.slice(hideStart, hideEnd),
    /ocrSessionResultCache\.clear\(\)/u,
    'hide 只是窗口不可见，不得清空会话识别结果缓存'
  )
  assert.match(
    windowSource.slice(hideEnd),
    /ocrSessionResultCache\.clear\(\)/u,
    '窗口关闭意味着会话终止，应清空识别结果缓存'
  )
})
