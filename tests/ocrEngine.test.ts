import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OcrEngineError,
  joinOcrLines,
  recognizeWithTimeout,
  type OcrEngine,
  type OcrRecognizeInput,
  type OcrRecognizeResult
} from '../src/shared/ocrEngine.ts'
import type { OcrTextLine } from '../src/shared/types.ts'

/**
 * 构造可注入的假 OCR 引擎，便于验证超时与取消语义。
 * @param id 引擎标识。
 * @param recognize 识别实现。
 * @returns OCR 引擎。
 * @author zhenghq
 */
function makeEngine(
  id: OcrEngine['id'],
  recognize: (input: OcrRecognizeInput) => Promise<OcrRecognizeResult>
): OcrEngine {
  return {
    id,
    async isAvailable() {
      return true
    },
    recognize
  }
}

/**
 * 校验文本行按包围盒 Y/X 排序后拼接为多行文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 文本行应按 Y 再 X 排序后拼接', () => {
  const lines: OcrTextLine[] = [
    { text: 'B', box: { x: 10, y: 20, width: 5, height: 5 } },
    { text: 'A', box: { x: 0, y: 0, width: 5, height: 5 } },
    { text: 'C', box: { x: 40, y: 20, width: 5, height: 5 } }
  ]
  assert.equal(joinOcrLines(lines), 'A\nB C')
})

/**
 * 校验引擎超时被统一转换为 timeout 错误码。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 引擎超时应抛出 timeout 错误', async () => {
  const engine = makeEngine('system', async (input) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 80)
      input.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      })
    })
    return { engine: 'system', lines: [{ text: 'late' }], text: 'late' }
  })

  await assert.rejects(
    () => recognizeWithTimeout(engine, { imageBytes: Buffer.from('png'), timeoutMs: 20 }),
    (error: unknown) => {
      assert.ok(error instanceof OcrEngineError)
      assert.equal(error.code, 'timeout')
      return true
    }
  )
})

/**
 * 校验外部取消信号会中止识别并映射为 timeout 错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('外部 AbortSignal 取消 OCR 时应映射为 timeout', async () => {
  const controller = new AbortController()
  const engine = makeEngine('paddle', async (input) => {
    await new Promise<void>((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
    return { engine: 'paddle', lines: [], text: '' }
  })

  const pending = recognizeWithTimeout(engine, {
    imagePath: '/tmp/demo.png',
    signal: controller.signal,
    timeoutMs: 1000
  })
  controller.abort()

  await assert.rejects(
    () => pending,
    (error: unknown) => {
      assert.ok(error instanceof OcrEngineError)
      assert.equal(error.code, 'timeout')
      return true
    }
  )
})

/**
 * 校验空输入被拒绝，避免引擎收到无意义请求。
 * @returns 无返回值。
 * @author zhenghq
 */
test('缺少图片字节与路径时应抛出 engine-unavailable', async () => {
  const engine = makeEngine('tesseract', async () => ({
    engine: 'tesseract',
    lines: [{ text: 'x' }],
    text: 'x'
  }))
  await assert.rejects(
    () => recognizeWithTimeout(engine, { timeoutMs: 50 }),
    (error: unknown) => {
      assert.ok(error instanceof OcrEngineError)
      assert.equal(error.code, 'engine-unavailable')
      return true
    }
  )
})

/**
 * 校验正常识别结果保留文本行与拼接文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('正常识别应返回文本行与拼接文本', async () => {
  const engine = makeEngine('system', async (input) => {
    assert.ok(input.imageBytes)
    return {
      engine: 'system',
      lines: [{ text: '你好' }, { text: '世界' }],
      text: '你好\n世界'
    }
  })
  const result = await recognizeWithTimeout(engine, {
    imageBytes: Buffer.from([1, 2, 3]),
    language: 'zh-Hans',
    timeoutMs: 200
  })
  assert.equal(result.engine, 'system')
  assert.equal(result.text, '你好\n世界')
  assert.equal(result.lines.length, 2)
})
