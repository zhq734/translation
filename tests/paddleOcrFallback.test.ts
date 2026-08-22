import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PaddleOcrFallbackEngine
} from '../src/main/paddleOcrFallback.ts'

/**
 * 校验 paddleocr-json 不在 PATH 时 isAvailable 返回 false。
 * @returns 无返回值。
 * @author zhenghq
 */
test('PaddleOCR-json 不可用时 isAvailable 应返回 false', async () => {
  const engine = new PaddleOcrFallbackEngine({
    checkExecutable: async () => false
  })
  assert.equal(await engine.isAvailable(), false)
})

/**
 * 校验不可用时 recognize 抛出 engine-unavailable 错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('PaddleOCR-json 不可用时 recognize 应抛出 engine-unavailable', async () => {
  const engine = new PaddleOcrFallbackEngine({
    checkExecutable: async () => false
  })
  await assert.rejects(
    () => engine.recognize({ imageBytes: Buffer.from([1, 2, 3]) }),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.ok(err.message.includes('未找到') || err.message.includes('engine-unavailable') || (err as { code?: string }).code === 'engine-unavailable')
      return true
    }
  )
})

/**
 * 校验 paddleocr-json 可用时 recognize 解析 JSON 行输出。
 * @returns 无返回值。
 * @author zhenghq
 */
test('PaddleOCR-json 可用时应正确解析 JSON 行输出', async () => {
  const jsonOutput = JSON.stringify([{ text: '你好', confidence: 0.95, box: [[0,0],[100,0],[100,20],[0,20]] }]) + '\n' +
    JSON.stringify([{ text: '世界', confidence: 0.92, box: [[0,30],[100,30],[100,50],[0,50]] }])

  const engine = new PaddleOcrFallbackEngine({
    checkExecutable: async () => true,
    execFile: async () => ({ stdout: jsonOutput, stderr: '' }),
    writeFile: async () => undefined,
    unlink: async () => undefined,
    tmpDir: () => '/tmp'
  })

  const result = await engine.recognize({ imageBytes: Buffer.from([1, 2, 3]) })
  assert.equal(result.engine, 'paddle')
  assert.equal(result.lines.length, 2)
  assert.equal(result.lines[0]!.text, '你好')
  assert.equal(result.lines[1]!.text, '世界')
})

/**
 * 校验超时错误被映射为 timeout 错误码。
 * @returns 无返回值。
 * @author zhenghq
 */
test('PaddleOCR-json 超时应映射为 timeout 错误码', async () => {
  const engine = new PaddleOcrFallbackEngine({
    checkExecutable: async () => true,
    execFile: async (_, __, opts) =>
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('Command timed out')), 50)
        opts?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('timeout')) })
      }),
    writeFile: async () => undefined,
    unlink: async () => undefined,
    tmpDir: () => '/tmp'
  })

  await assert.rejects(
    () => engine.recognize({ imageBytes: Buffer.from([1, 2, 3]), timeoutMs: 30 }),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal((err as { code?: string }).code, 'timeout')
      return true
    }
  )
})

/**
 * 校验缺少图片输入时抛出 empty 错误码。
 * @returns 无返回值。
 * @author zhenghq
 */
test('PaddleOCR-json 缺少图片输入时应抛出 empty 错误', async () => {
  const engine = new PaddleOcrFallbackEngine({
    checkExecutable: async () => true,
    execFile: async () => ({ stdout: '', stderr: '' }),
    writeFile: async () => undefined,
    unlink: async () => undefined,
    tmpDir: () => '/tmp'
  })
  await assert.rejects(
    () => engine.recognize({}),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal((err as { code?: string }).code, 'empty')
      return true
    }
  )
})
