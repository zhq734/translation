import assert from 'node:assert/strict'
import test from 'node:test'
import { translateOcrResult, type OcrTranslateDeps } from '../src/main/ocrTranslate.ts'
import type { OcrRecognizeResult } from '../src/shared/ocrEngine.ts'
import type { Settings } from '../src/shared/types.ts'
import { DEFAULT_SETTINGS } from '../src/shared/settingsDefaults.ts'

/**
 * 构造最小 Settings 快照。
 * @returns 默认设置。
 * @author zhenghq
 */
function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

/**
 * 构造测试用 OCR 识别结果。
 * @param text OCR 文本。
 * @returns OCR 结果。
 * @author zhenghq
 */
function makeOcrResult(text: string): OcrRecognizeResult {
  return {
    lines: text ? [{ text }] : [],
    text,
    engine: 'system'
  }
}

/**
 * 校验 OCR 文本经清洗后传入翻译管道并返回译文。
 * @returns 无返回值。
 * @author zhenghq
 */
test('translateOcrResult 应清洗 OCR 文本后调用翻译并返回结果', async () => {
  let capturedText: string | undefined
  const deps: OcrTranslateDeps = {
    translate: async (text) => {
      capturedText = text
      return { translation: 'Hello World', provider: 'google' as never }
    }
  }
  const ocr = makeOcrResult('你好\u200b世界')  // 含零宽字符
  const result = await translateOcrResult(ocr, makeSettings(), deps)
  assert.ok(capturedText !== undefined)
  // 零宽字符应被清洗
  assert.ok(!capturedText!.includes('\u200b'), '零宽字符应被清洗')
  assert.equal(result.translation, 'Hello World')
  assert.equal(result.ocrText, '你好世界')
  assert.equal(result.ocrEngine, 'system')
})

/**
 * 校验 OCR 文本为噪声时不调用翻译，返回 ocrCode: noise。
 * @returns 无返回值。
 * @author zhenghq
 */
test('translateOcrResult OCR 噪声文本应返回 noise 错误码', async () => {
  let called = false
  const deps: OcrTranslateDeps = {
    translate: async () => {
      called = true
      return { translation: '', provider: 'google' as never }
    }
  }
  const ocr = makeOcrResult('□□□□□□□□□□□□□□□□□□□□')  // 全部替换符
  const result = await translateOcrResult(ocr, makeSettings(), deps)
  assert.equal(called, false, '噪声文本不应调用翻译')
  assert.equal(result.ocrCode, 'noise')
})

/**
 * 校验 OCR 识别为空时不调用翻译，返回 ocrCode: empty。
 * @returns 无返回值。
 * @author zhenghq
 */
test('translateOcrResult OCR 空结果应返回 empty 错误码', async () => {
  let called = false
  const deps: OcrTranslateDeps = {
    translate: async () => {
      called = true
      return { translation: '', provider: 'google' as never }
    }
  }
  const ocr = makeOcrResult('')
  const result = await translateOcrResult(ocr, makeSettings(), deps)
  assert.equal(called, false, '空结果不应调用翻译')
  assert.equal(result.ocrCode, 'empty')
})

/**
 * 校验翻译失败时 error 字段被传递。
 * @returns 无返回值。
 * @author zhenghq
 */
test('translateOcrResult 翻译失败应携带 error 字段', async () => {
  const deps: OcrTranslateDeps = {
    translate: async () => {
      throw new Error('network error')
    }
  }
  const ocr = makeOcrResult('Hello World')
  const result = await translateOcrResult(ocr, makeSettings(), deps)
  assert.ok(result.error !== undefined)
  assert.ok(result.error!.includes('network error'))
  assert.equal(result.ocrEngine, 'system')
})

/**
 * 校验清洗后的文本作为 ocrText 返回，即使翻译成功。
 * @returns 无返回值。
 * @author zhenghq
 */
test('translateOcrResult 应返回清洗后的 ocrText', async () => {
  const deps: OcrTranslateDeps = {
    translate: async () => ({ translation: '翻译结果', provider: 'google' as never })
  }
  const ocr = makeOcrResult('  Hello  World  ')
  const result = await translateOcrResult(ocr, makeSettings(), deps)
  assert.equal(result.ocrText, 'Hello World')  // cleanOcrText 会合并内部连续空格
  assert.equal(result.translation, '翻译结果')
})

/**
 * 校验 OCR 翻译结果同时保留清洗后原文和引擎原始输出，供弹窗双 Tab 展示。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('translateOcrResult 应保留 OCR 原始文本用于弹窗展示', async () => {
  const deps: OcrTranslateDeps = {
    translate: async () => ({ translation: 'Translated', provider: 'google' as never })
  }
  const result = await translateOcrResult(makeOcrResult('Hello   \n   World'), makeSettings(), deps)

  assert.equal(result.ocrText, 'Hello\nWorld')
  assert.equal(result.ocrRawText, 'Hello   \n   World')
})

/**
 * 校验 OCR 翻译进入运行时前应解析自动语言对，避免把 targetLang=auto 传给翻译服务。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('translateOcrResult 应按 OCR 文本解析自动目标语言后再调用翻译', async () => {
  let capturedSettings: Settings | undefined
  const deps: OcrTranslateDeps = {
    translate: async (_text, settings) => {
      capturedSettings = settings
      return { translation: 'Hello World', provider: 'google' as never }
    }
  }
  const result = await translateOcrResult(makeOcrResult('你好世界'), makeSettings({
    sourceLang: 'auto',
    targetLang: 'auto'
  }), deps)

  assert.equal(result.translation, 'Hello World')
  assert.equal(capturedSettings?.sourceLang, 'auto')
  assert.equal(capturedSettings?.targetLang, 'EN')
})
