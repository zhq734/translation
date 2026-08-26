import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizePaddleLines,
  joinOcrFragments,
  PaddleOcrEngine,
  type PaddleDetectItem
} from '../src/main/paddleOcr.ts'

/**
 * 构造测试用 PaddleOCR 检测条目。
 * @param text 文本。
 * @param box 包围盒四点坐标。
 * @returns 检测条目。
 * @author zhenghq
 */
function makeItem(
  text: string,
  box: [[number, number], [number, number], [number, number], [number, number]],
  confidence = 0.9
): PaddleDetectItem {
  return { text, box, confidence }
}

/**
 * 校验空输入返回空数组。
 * @returns 无返回值。
 * @author zhenghq
 */
test('normalizePaddleLines 空输入应返回空数组', () => {
  assert.deepEqual(normalizePaddleLines([]), [])
  assert.deepEqual(normalizePaddleLines(null as never), [])
})

/**
 * 校验低置信度行被过滤。
 * @returns 无返回值。
 * @author zhenghq
 */
test('normalizePaddleLines 低置信度行应被过滤', () => {
  const items = [
    makeItem('hello', [[0,0],[100,0],[100,20],[0,20]], 0.9),
    makeItem('low', [[0,30],[100,30],[100,50],[0,50]], 0.2)
  ]
  const lines = normalizePaddleLines(items)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.text, 'hello')
})

/**
 * 校验空白文本被过滤。
 * @returns 无返回值。
 * @author zhenghq
 */
test('normalizePaddleLines 空白文本应被过滤', () => {
  const items = [
    makeItem('  ', [[0,0],[100,0],[100,20],[0,20]], 0.9),
    makeItem('text', [[0,30],[100,30],[100,50],[0,50]], 0.9)
  ]
  const lines = normalizePaddleLines(items)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.text, 'text')
})

/**
 * 校验同一行内的文本按 x 坐标拼接。
 * @returns 无返回值。
 * @author zhenghq
 */
test('normalizePaddleLines 同行文本应按 X 排序后拼接', () => {
  const items = [
    makeItem('世界', [[60,0],[120,0],[120,20],[60,20]], 0.9),
    makeItem('你好', [[0,0],[50,0],[50,20],[0,20]], 0.9)
  ]
  const lines = normalizePaddleLines(items)
  assert.equal(lines.length, 1)
  // 按 x 排序后应为"你好世界"（CJK 无空格拼接）
  assert.equal(lines[0]!.text, '你好世界')
})

/**
 * 校验不同行的文本按 Y 顺序排列。
 * @returns 无返回值。
 * @author zhenghq
 */
test('normalizePaddleLines 不同行应按 Y 顺序排列', () => {
  const items = [
    makeItem('第二行', [[0,40],[100,40],[100,60],[0,60]], 0.9),
    makeItem('第一行', [[0,0],[100,0],[100,20],[0,20]], 0.9)
  ]
  const lines = normalizePaddleLines(items)
  assert.equal(lines.length, 2)
  assert.equal(lines[0]!.text, '第一行')
  assert.equal(lines[1]!.text, '第二行')
})

/**
 * 校验 CJK 文字片段无空格拼接。
 * @returns 无返回值。
 * @author zhenghq
 */
test('joinOcrFragments CJK 片段应无空格拼接', () => {
  assert.equal(joinOcrFragments(['你好', '世界']), '你好世界')
})

/**
 * 校验英文片段有空格拼接。
 * @returns 无返回值。
 * @author zhenghq
 */
test('joinOcrFragments 英文片段应有空格拼接', () => {
  assert.equal(joinOcrFragments(['Hello', 'World']), 'Hello World')
})

/**
 * 校验标点前无空格拼接。
 * @returns 无返回值。
 * @author zhenghq
 */
test('joinOcrFragments 标点前应无空格', () => {
  assert.equal(joinOcrFragments(['Hello', '.', 'World']), 'Hello. World')
})

/**
 * 校验空数组返回空字符串。
 * @returns 无返回值。
 * @author zhenghq
 */
test('joinOcrFragments 空数组应返回空字符串', () => {
  assert.equal(joinOcrFragments([]), '')
})

/**
 * 校验 PaddleOCR 引擎会把随包模型路径传给 @gutenye/ocr-node。
 * @returns 无返回值。
 * @author zhenghq
 */
test('PaddleOcrEngine 应传入自定义 PP-OCRv6_tiny 模型路径', async () => {
  let receivedModels: unknown
  const engine = new PaddleOcrEngine({
    models: {
      detectionPath: '/tmp/det.onnx',
      recognitionPath: '/tmp/rec.onnx',
      dictionaryPath: '/tmp/dict.txt'
    },
    tmpDir: () => '/tmp',
    writeFile: async () => undefined,
    unlink: async () => undefined,
    createOcrNode: async (options) => {
      receivedModels = options?.models
      return {
        detect: async () => [
          makeItem('你好', [[0,0],[30,0],[30,20],[0,20]], 0.99)
        ]
      }
    }
  })

  const result = await engine.recognize({
    imageBytes: new Uint8Array([1, 2, 3]),
    language: 'zh-Hans'
  })

  assert.deepEqual(receivedModels, {
    detectionPath: '/tmp/det.onnx',
    recognitionPath: '/tmp/rec.onnx',
    dictionaryPath: '/tmp/dict.txt'
  })
  assert.equal(result.text, '你好')
})

/**
 * 校验 PaddleOCR runtime 初始化失败时应保留脱敏后的诊断原因。
 * @returns 无返回值。
 * @author zhenghq
 */
test('PaddleOcrEngine 初始化失败应返回具体不可用原因', async () => {
  const engine = new PaddleOcrEngine({
    createOcrNode: async () => {
      throw new Error('native binding load failed')
    }
  })

  assert.equal(await engine.isAvailable(), false)
  assert.equal(engine.getUnavailableReason(), 'PaddleOCR runtime 初始化失败: native binding load failed')
})
