import assert from 'node:assert/strict'
import test from 'node:test'
import {
  tesseractLanguageTag,
  normalizeTesseractLines,
  type TesseractOcrDeps
} from '../src/main/tesseractOcr.ts'
import { OcrEngineError } from '../src/shared/ocrEngine.ts'

/**
 * 校验语言映射：中文 auto/zh-hans 映射为 chi_sim+eng。
 * @returns 无返回值。
 * @author zhenghq
 */
test('tesseractLanguageTag 中文应映射为 chi_sim+eng', () => {
  assert.equal(tesseractLanguageTag('auto'), 'chi_sim+eng')
  assert.equal(tesseractLanguageTag('zh'), 'chi_sim+eng')
  assert.equal(tesseractLanguageTag('zh-hans'), 'chi_sim+eng')
  assert.equal(tesseractLanguageTag('zh-Hans'), 'chi_sim+eng')
  assert.equal(tesseractLanguageTag(''), 'chi_sim+eng')
})

/**
 * 校验繁体中文映射为 chi_tra+eng。
 * @returns 无返回值。
 * @author zhenghq
 */
test('tesseractLanguageTag 繁体中文应映射为 chi_tra+eng', () => {
  assert.equal(tesseractLanguageTag('zh-hant'), 'chi_tra+eng')
  assert.equal(tesseractLanguageTag('zh-Hant'), 'chi_tra+eng')
})

/**
 * 校验英文映射为 eng。
 * @returns 无返回值。
 * @author zhenghq
 */
test('tesseractLanguageTag 英文应映射为 eng', () => {
  assert.equal(tesseractLanguageTag('en'), 'eng')
})

/**
 * 校验日文映射为 jpn+eng。
 * @returns 无返回值。
 * @author zhenghq
 */
test('tesseractLanguageTag 日文应映射为 jpn+eng', () => {
  assert.equal(tesseractLanguageTag('ja'), 'jpn+eng')
})

/**
 * 校验未知语言回退 chi_sim+eng。
 * @returns 无返回值。
 * @author zhenghq
 */
test('tesseractLanguageTag 未知语言应回退 chi_sim+eng', () => {
  assert.equal(tesseractLanguageTag('xx-unknown'), 'chi_sim+eng')
})

/**
 * 校验 Tesseract 原始输出规范化为文本行数组。
 * @returns 无返回值。
 * @author zhenghq
 */
test('normalizeTesseractLines 应拆分并过滤空行', () => {
  const lines = normalizeTesseractLines('Hello World\n\nFoo Bar\n')
  assert.equal(lines.length, 2)
  assert.equal(lines[0]!.text, 'Hello World')
  assert.equal(lines[1]!.text, 'Foo Bar')
})

/**
 * 校验空输出返回空数组。
 * @returns 无返回值。
 * @author zhenghq
 */
test('normalizeTesseractLines 空输出应返回空数组', () => {
  assert.deepEqual(normalizeTesseractLines(''), [])
  assert.deepEqual(normalizeTesseractLines('  \n  '), [])
})

/**
 * 校验 TesseractOcrDeps 接口可注入。
 * @returns 无返回值。
 * @author zhenghq
 */
test('TesseractOcrDeps 接口应可构造', () => {
  const deps: TesseractOcrDeps = {
    tessDataPath: '/tmp/tessdata',
    createWorker: async () => ({
      recognize: async () => ({ data: { text: '' } }),
      setParameters: async () => undefined,
      terminate: async () => undefined
    }),
    onProgress: () => undefined
  }
  assert.equal(deps.tessDataPath, '/tmp/tessdata')
})

/**
 * 校验引擎通过注入 worker 正常识别并返回文本行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('TesseractOcrEngine 正常识别应返回文本行', async () => {
  const { TesseractOcrEngine } = await import('../src/main/tesseractOcr.ts')
  const engine = new TesseractOcrEngine({
    tessDataPath: '/tmp/tessdata',
    createWorker: async (_lang: string) => ({
      recognize: async (_input: unknown) => ({
        data: { text: '你好世界\nHello\n' }
      }),
      setParameters: async (_params: unknown) => undefined,
      terminate: async () => undefined
    }),
    onProgress: () => undefined
  })
  const result = await engine.recognize({
    imageBytes: Buffer.from([1, 2, 3]),
    language: 'zh',
    timeoutMs: 500
  })
  assert.equal(result.engine, 'tesseract')
  assert.equal(result.lines.length, 2)
  assert.equal(result.lines[0]!.text, '你好世界')
})

/**
 * 校验缺少图片输入时抛出 engine-unavailable 错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('TesseractOcrEngine 缺少图片应抛出错误', async () => {
  const { TesseractOcrEngine } = await import('../src/main/tesseractOcr.ts')
  const engine = new TesseractOcrEngine({
    tessDataPath: '/tmp/tessdata',
    createWorker: async (_lang: string) => ({
      recognize: async (_input: unknown) => ({ data: { text: '' } }),
      setParameters: async (_params: unknown) => undefined,
      terminate: async () => undefined
    }),
    onProgress: () => undefined
  })
  await assert.rejects(
    () => engine.recognize({ timeoutMs: 200 }),
    (err: unknown) => {
      assert.ok(err instanceof OcrEngineError)
      assert.equal(err.code, 'engine-unavailable')
      return true
    }
  )
})

/**
 * 校验 Tesseract worker terminated 异常会转换为可展示的引擎错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('TesseractOcrEngine worker terminated 应转换为引擎不可用错误', async () => {
  const { TesseractOcrEngine } = await import('../src/main/tesseractOcr.ts')
  const engine = new TesseractOcrEngine({
    tessDataPath: '/tmp/tessdata',
    createWorker: async (_lang: string) => ({
      recognize: async (_input: unknown) => {
        throw new TypeError('terminated')
      },
      setParameters: async (_params: unknown) => undefined,
      terminate: async () => undefined
    }),
    onProgress: () => undefined
  })
  await assert.rejects(
    () => engine.recognize({ imageBytes: Buffer.from([1, 2, 3]), timeoutMs: 200 }),
    (err: unknown) => {
      assert.ok(err instanceof OcrEngineError)
      assert.equal(err.code, 'engine-unavailable')
      assert.equal(err.message, 'Tesseract OCR 已中断，请重新截图识别')
      return true
    }
  )
})
