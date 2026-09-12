import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildEngineQueue,
  OcrDispatcher,
  type OcrDispatcherDeps
} from '../src/main/ocrDispatcher.ts'
import {
  OcrEngineError,
  type OcrEngine,
  type OcrRecognizeInput,
  type OcrRecognizeResult
} from '../src/shared/ocrEngine.ts'

/**
 * 构造可注入的假 OCR 引擎。
 * @param id 引擎标识。
 * @param available 是否可用。
 * @param result 识别结果或异常。
 * @returns 假引擎。
 * @author zhenghq
 */
function makeEngine(
  id: OcrEngine['id'],
  available: boolean,
  result: OcrRecognizeResult | Error
): OcrEngine {
  return {
    id,
    isAvailable: async () => available,
    recognize: async (_input: OcrRecognizeInput): Promise<OcrRecognizeResult> => {
      if (result instanceof Error) throw result
      return result
    }
  }
}

/**
 * 构造可统计识别调用次数的假 OCR 引擎。
 * @param id 引擎标识。
 * @param result 识别结果或异常。
 * @returns 假引擎及识别调用次数读取函数。
 * @author zhenghq
 */
function makeTrackedEngine(
  id: OcrEngine['id'],
  result: OcrRecognizeResult | Error
): { engine: OcrEngine; getRecognizeCount: () => number } {
  let recognizeCount = 0
  return {
    engine: {
      id,
      isAvailable: async () => true,
      recognize: async (_input: OcrRecognizeInput): Promise<OcrRecognizeResult> => {
        recognizeCount += 1
        if (result instanceof Error) throw result
        return result
      }
    },
    getRecognizeCount: () => recognizeCount
  }
}

/**
 * 校验 auto 模式在 macOS 下优先 Tesseract，Paddle 放最后避免英文截图乱码。
 * @returns 无返回值。
 * @author zhenghq
 */
test('buildEngineQueue auto 在 macOS 应排序 tesseract>system>paddle', () => {
  const queue = buildEngineQueue('auto', 'darwin')
  assert.deepEqual(queue, ['tesseract', 'system', 'paddle'])
})

/**
 * 校验 auto 模式在 Windows 下先排系统 OCR，Paddle 放最后。
 * @returns 无返回值。
 * @author zhenghq
 */
test('buildEngineQueue auto 在 Windows 应排序 system>tesseract>paddle', () => {
  const queue = buildEngineQueue('auto', 'win32')
  assert.deepEqual(queue, ['system', 'tesseract', 'paddle'])
})

/**
 * 校验 auto 模式在 Linux 下优先 Tesseract，Paddle 兜底。
 * @returns 无返回值。
 * @author zhenghq
 */
test('buildEngineQueue auto 在 Linux 应排序 tesseract>paddle', () => {
  const queue = buildEngineQueue('auto', 'linux')
  assert.deepEqual(queue, ['tesseract', 'paddle'])
})

/**
 * 校验 system 偏好只调系统 OCR。
 * @returns 无返回值。
 * @author zhenghq
 */
test('buildEngineQueue system 偏好只返回 system', () => {
  const queue = buildEngineQueue('system', 'darwin')
  assert.deepEqual(queue, ['system'])
})

/**
 * 校验 paddle 偏好只返回 paddle。
 * @returns 无返回值。
 * @author zhenghq
 */
test('buildEngineQueue paddle 偏好只返回 paddle', () => {
  const queue = buildEngineQueue('paddle', 'darwin')
  assert.deepEqual(queue, ['paddle'])
})

/**
 * 校验 tesseract 偏好只返回 tesseract。
 * @returns 无返回值。
 * @author zhenghq
 */
test('buildEngineQueue tesseract 偏好只返回 tesseract', () => {
  const queue = buildEngineQueue('tesseract', 'darwin')
  assert.deepEqual(queue, ['tesseract'])
})

/**
 * 校验调度器在第一个引擎返回空结果时自动降级到下一层。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OcrDispatcher 首引擎空结果应降级到下一层', async () => {
  const emptyResult: OcrRecognizeResult = { lines: [], text: '', engine: 'tesseract' }
  const goodResult: OcrRecognizeResult = {
    lines: [{ text: '你好' }], text: '你好', engine: 'paddle'
  }
  const deps: OcrDispatcherDeps = {
    platform: 'linux',
    engines: {
      system: makeEngine('system', false, new Error('n/a')),
      paddle: makeEngine('paddle', true, goodResult),
      tesseract: makeEngine('tesseract', true, emptyResult)
    }
  }
  const dispatcher = new OcrDispatcher(deps)
  const result = await dispatcher.recognize({
    imageBytes: Buffer.from([1, 2, 3]),
    language: 'zh',
    timeoutMs: 500
  }, 'auto')
  assert.equal(result.engine, 'paddle')
  assert.equal(result.text, '你好')
})

/**
 * 校验调度器在引擎失败时自动降级到下一层。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OcrDispatcher 引擎失败应自动降级', async () => {
  const tesseractResult: OcrRecognizeResult = {
    lines: [{ text: 'fallback' }], text: 'fallback', engine: 'tesseract'
  }
  const deps: OcrDispatcherDeps = {
    platform: 'linux',
    engines: {
      system: makeEngine('system', false, new Error('not on linux')),
      paddle: makeEngine('paddle', true, new OcrEngineError('engine-unavailable', 'paddle error', 'paddle')),
      tesseract: makeEngine('tesseract', true, tesseractResult)
    }
  }
  const dispatcher = new OcrDispatcher(deps)
  const result = await dispatcher.recognize({
    imageBytes: Buffer.from([1, 2, 3]),
    language: 'en',
    timeoutMs: 500
  }, 'auto')
  assert.equal(result.engine, 'tesseract')
  assert.equal(result.text, 'fallback')
})

/**
 * 校验调度器在 Paddle 返回罕见汉字乱码时继续降级到后续引擎。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('OcrDispatcher Paddle 乱码结果应降级到后续引擎', async () => {
  const paddleGarbled: OcrRecognizeResult = {
    lines: [{ text: '原蹿眼晏录科里东2瞠珈唐阶灿爸梓航1航晏眼汇消原汇捌傍蹿蛰钻险酱捌字晏科韵里傍盎盎眼里' }],
    text: '原蹿眼晏录科里东2瞠珈唐阶灿爸梓航1航晏眼汇消原汇捌傍蹿蛰钻险酱捌字晏科韵里傍盎盎眼里',
    engine: 'paddle'
  }
  const tesseractResult: OcrRecognizeResult = {
    lines: [{ text: '[network] proxy mode applied: system' }],
    text: '[network] proxy mode applied: system',
    engine: 'tesseract'
  }
  const deps: OcrDispatcherDeps = {
    platform: 'linux',
    engines: {
      paddle: makeEngine('paddle', true, paddleGarbled),
      tesseract: makeEngine('tesseract', true, tesseractResult)
    }
  }
  const dispatcher = new OcrDispatcher(deps)
  const result = await dispatcher.recognize({
    imageBytes: Buffer.from([1, 2, 3]),
    language: 'auto',
    timeoutMs: 500
  }, 'auto')
  assert.equal(result.engine, 'tesseract')
  assert.equal(result.text, '[network] proxy mode applied: system')
})

/**
 * 校验调度器会拒绝 PP-OCRv6_tiny 产生的混合全角符号乱码。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('OcrDispatcher 应拒绝 PP-OCRv6_tiny 混合乱码并继续降级', async () => {
  const paddleGarbled: OcrRecognizeResult = {
    lines: [{ text: 'qＭ胍罘凄 与处傍蹿眼月傍航 揉贰即 备月 ，]，全涸匾升忐´舅全栈揉贰即宫丈Ｍ意珍酥鄂减' }],
    text: 'qＭ胍罘凄 与处傍蹿眼月傍航 揉贰即 备月 ，]，全涸匾升忐´舅全栈揉贰即宫丈Ｍ意珍酥鄂减',
    engine: 'paddle'
  }
  const tesseractResult: OcrRecognizeResult = {
    lines: [{ text: 'FineVis 可视化大屏' }],
    text: 'FineVis 可视化大屏',
    engine: 'tesseract'
  }
  const deps: OcrDispatcherDeps = {
    platform: 'linux',
    engines: {
      paddle: makeEngine('paddle', true, paddleGarbled),
      tesseract: makeEngine('tesseract', true, tesseractResult)
    }
  }
  const dispatcher = new OcrDispatcher(deps)
  const result = await dispatcher.recognize({
    imageBytes: Buffer.from([1, 2, 3]),
    language: 'auto',
    timeoutMs: 500
  }, 'auto')
  assert.equal(result.engine, 'tesseract')
  assert.equal(result.text, 'FineVis 可视化大屏')
})

/**
 * 校验所有引擎均失败时抛出 engine-unavailable 错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OcrDispatcher 所有引擎失败应抛出 engine-unavailable', async () => {
  const deps: OcrDispatcherDeps = {
    platform: 'linux',
    engines: {
      system: makeEngine('system', false, new Error('n/a')),
      paddle: makeEngine('paddle', true, new OcrEngineError('engine-unavailable', 'err', 'paddle')),
      tesseract: makeEngine('tesseract', true, new OcrEngineError('engine-unavailable', 'err', 'tesseract'))
    }
  }
  const dispatcher = new OcrDispatcher(deps)
  await assert.rejects(
    () => dispatcher.recognize({ imageBytes: Buffer.from([1]), timeoutMs: 500 }, 'auto'),
    (err: unknown) => {
      assert.ok(err instanceof OcrEngineError)
      assert.equal(err.code, 'engine-unavailable')
      return true
    }
  )
})

/**
 * 校验多引擎结果择优：质量分高的胜出。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OcrDispatcher 多引擎结果应择优', async () => {
  // system 返回短噪声文本，paddle 返回高质量中文 → dispatcher 应取 paddle
  const systemResult: OcrRecognizeResult = {
    lines: [{ text: '□□□' }], text: '□□□', engine: 'system'
  }
  const paddleResult: OcrRecognizeResult = {
    lines: [{ text: '你好世界这是正常中文文本' }],
    text: '你好世界这是正常中文文本',
    engine: 'paddle'
  }
  const deps: OcrDispatcherDeps = {
    platform: 'darwin',
    engines: {
      system: makeEngine('system', true, systemResult),
      paddle: makeEngine('paddle', true, paddleResult),
      tesseract: makeEngine('tesseract', true, { lines: [], text: '', engine: 'tesseract' })
    }
  }
  const dispatcher = new OcrDispatcher(deps)
  const result = await dispatcher.recognize({
    imageBytes: Buffer.from([1, 2, 3]),
    language: 'zh',
    timeoutMs: 500
  }, 'auto')
  assert.equal(result.engine, 'paddle')
})

/**
 * 校验所有引擎均返回空时抛出 empty 错误码。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OcrDispatcher 所有引擎空结果应抛出 empty', async () => {
  const empty = (id: OcrEngine['id']): OcrRecognizeResult => ({ lines: [], text: '', engine: id })
  const deps: OcrDispatcherDeps = {
    platform: 'linux',
    engines: {
      system: makeEngine('system', false, new Error('n/a')),
      paddle: makeEngine('paddle', true, empty('paddle')),
      tesseract: makeEngine('tesseract', true, empty('tesseract'))
    }
  }
  const dispatcher = new OcrDispatcher(deps)
  await assert.rejects(
    () => dispatcher.recognize({ imageBytes: Buffer.from([1]), timeoutMs: 500 }, 'auto'),
    (err: unknown) => {
      assert.ok(err instanceof OcrEngineError)
      assert.equal(err.code, 'empty')
      return true
    }
  )
})

/**
 * 校验用户中文截图对应的 Tesseract 拉丁乱码不会阻断 PaddleOCR。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('OcrDispatcher 中文截图的长拉丁乱码应继续降级并选择高置信中文', async () => {
  const tesseractResult: OcrRecognizeResult = {
    lines: [{ text: 'Shuzi hua chengguo jieshou yi jing jiagong hao de dangan shuju' }],
    text: 'Shuzi hua chengguo jieshou yi jing jiagong hao de dangan shuju',
    engine: 'tesseract'
  }
  const paddleResult: OcrRecognizeResult = {
    lines: [
      { text: '数字化成果接收', confidence: 0.998 },
      { text: '已经加工好的档案数字化成果，在该模块进行档案条目导入和档', confidence: 0.992 },
      { text: '案原文挂接。大于1GB的数据包不建议直接上传，请联系系统管', confidence: 0.988 },
      { text: '理员后台上传。', confidence: 0.995 }
    ],
    text: '数字化成果接收\n已经加工好的档案数字化成果，在该模块进行档案条目导入和档\n案原文挂接。大于1GB的数据包不建议直接上传，请联系系统管\n理员后台上传。',
    engine: 'paddle'
  }
  const tesseract = makeTrackedEngine('tesseract', tesseractResult)
  const paddle = makeTrackedEngine('paddle', paddleResult)
  const dispatcher = new OcrDispatcher({
    platform: 'darwin',
    engines: { tesseract: tesseract.engine, paddle: paddle.engine }
  })

  const result = await dispatcher.recognize({
    imageBytes: Buffer.from([1, 2, 3]),
    language: 'zh',
    timeoutMs: 500
  }, 'auto')

  assert.equal(result.engine, 'paddle')
  assert.equal(result.text, paddleResult.text)
  assert.equal(tesseract.getRecognizeCount(), 1)
  assert.equal(paddle.getRecognizeCount(), 1)
})

/**
 * 校验 auto 语言也按中文优先策略继续尝试高置信中文引擎。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('OcrDispatcher auto 输入的长拉丁乱码应继续降级', async () => {
  const tesseract = makeTrackedEngine('tesseract', {
    lines: [{ text: 'Dang an yuan wen gua jie data package upload administrator' }],
    text: 'Dang an yuan wen gua jie data package upload administrator',
    engine: 'tesseract'
  })
  const paddle = makeTrackedEngine('paddle', {
    lines: [{ text: '档案原文挂接，请联系系统管理员后台上传。', confidence: 0.99 }],
    text: '档案原文挂接，请联系系统管理员后台上传。',
    engine: 'paddle'
  })
  const dispatcher = new OcrDispatcher({
    platform: 'linux',
    engines: { tesseract: tesseract.engine, paddle: paddle.engine }
  })

  const result = await dispatcher.recognize({
    imageBytes: Buffer.from([1]),
    language: 'auto'
  }, 'auto')

  assert.equal(result.engine, 'paddle')
  assert.equal(paddle.getRecognizeCount(), 1)
})

/**
 * 校验明确英文输入维持首个高质量结果快速返回。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('OcrDispatcher 正常英文结果应快速返回且不调用 PaddleOCR', async () => {
  const tesseract = makeTrackedEngine('tesseract', {
    lines: [{ text: 'Upload the archive package from the administration console.' }],
    text: 'Upload the archive package from the administration console.',
    engine: 'tesseract'
  })
  const paddle = makeTrackedEngine('paddle', {
    lines: [{ text: '错误后备结果', confidence: 0.99 }],
    text: '错误后备结果',
    engine: 'paddle'
  })
  const dispatcher = new OcrDispatcher({
    platform: 'linux',
    engines: { tesseract: tesseract.engine, paddle: paddle.engine }
  })

  const result = await dispatcher.recognize({
    imageBytes: Buffer.from([1]),
    language: 'en'
  }, 'auto')

  assert.equal(result.engine, 'tesseract')
  assert.equal(paddle.getRecognizeCount(), 0)
})

/**
 * 校验明确指定单引擎时不触发跨引擎语言降级。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('OcrDispatcher 明确指定 Tesseract 时应保持单引擎语义', async () => {
  const tesseract = makeTrackedEngine('tesseract', {
    lines: [{ text: 'Latin result for selected engine' }],
    text: 'Latin result for selected engine',
    engine: 'tesseract'
  })
  const paddle = makeTrackedEngine('paddle', {
    lines: [{ text: '中文结果', confidence: 0.99 }],
    text: '中文结果',
    engine: 'paddle'
  })
  const dispatcher = new OcrDispatcher({
    platform: 'linux',
    engines: { tesseract: tesseract.engine, paddle: paddle.engine }
  })

  const result = await dispatcher.recognize({
    imageBytes: Buffer.from([1]),
    language: 'zh'
  }, 'tesseract')

  assert.equal(result.engine, 'tesseract')
  assert.equal(paddle.getRecognizeCount(), 0)
})

/**
 * 校验语言可疑候选在后续引擎失败时仍可作为兜底结果。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('OcrDispatcher 后续引擎不可用时应返回已有的语言可疑候选', async () => {
  const suspiciousResult: OcrRecognizeResult = {
    lines: [{ text: 'Dang an data package administrator upload' }],
    text: 'Dang an data package administrator upload',
    engine: 'tesseract'
  }
  const dispatcher = new OcrDispatcher({
    platform: 'linux',
    engines: {
      tesseract: makeEngine('tesseract', true, suspiciousResult),
      paddle: makeEngine(
        'paddle',
        true,
        new OcrEngineError('engine-unavailable', '模型未就绪', 'paddle')
      )
    }
  })

  const result = await dispatcher.recognize({
    imageBytes: Buffer.from([1]),
    language: 'zh'
  }, 'auto')

  assert.equal(result, suspiciousResult)
})

/**
 * 校验同语言候选优先使用逐行平均置信度，而不是只按文本长度选择。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('OcrDispatcher 同语言候选应选择平均置信度更高的结果', async () => {
  const lowConfidence: OcrRecognizeResult = {
    lines: [{ text: '档案数字化成果接收和处理流程说明文字', confidence: 0.35 }],
    text: '档案数字化成果接收和处理流程说明文字',
    engine: 'tesseract'
  }
  const highConfidence: OcrRecognizeResult = {
    lines: [{ text: '档案数字化成果接收', confidence: 0.99 }],
    text: '档案数字化成果接收',
    engine: 'paddle'
  }
  const dispatcher = new OcrDispatcher({
    platform: 'linux',
    engines: {
      tesseract: makeEngine('tesseract', true, lowConfidence),
      paddle: makeEngine('paddle', true, highConfidence)
    }
  })

  const result = await dispatcher.recognize({
    imageBytes: Buffer.from([1]),
    language: 'zh'
  }, 'auto')

  assert.equal(result.engine, 'paddle')
})

/**
 * 校验置信度都缺失时继续使用原有文本质量分择优。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('OcrDispatcher 置信度缺失时应回退到文本质量分', async () => {
  const shorter: OcrRecognizeResult = {
    lines: [{ text: 'Archive upload' }], text: 'Archive upload', engine: 'tesseract'
  }
  const longer: OcrRecognizeResult = {
    lines: [{ text: 'Archive package upload complete' }],
    text: 'Archive package upload complete',
    engine: 'paddle'
  }
  const dispatcher = new OcrDispatcher({
    platform: 'linux',
    engines: {
      tesseract: makeEngine('tesseract', true, shorter),
      paddle: makeEngine('paddle', true, longer)
    }
  })

  const result = await dispatcher.recognize({
    imageBytes: Buffer.from([1]),
    language: 'zh'
  }, 'auto')

  assert.equal(result.engine, 'paddle')
})
