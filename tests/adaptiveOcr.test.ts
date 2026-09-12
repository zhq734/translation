import assert from 'node:assert/strict'
import test from 'node:test'
import {
  recognizeAdaptiveOcr,
  type AdaptiveOcrDiagnostic
} from '../src/main/adaptiveOcr.ts'
import { OcrEngineError, type OcrRecognizeResult } from '../src/shared/ocrEngine.ts'

/**
 * 构造协调器测试使用的 OCR 结果。
 * @param text 识别文本。
 * @param confidence 可选置信度。
 * @returns OCR 识别结果。
 * @author zhenghq
 */
function result(text: string, confidence?: number): OcrRecognizeResult {
  return {
    text,
    lines: text ? [{ text, confidence }] : [],
    engine: 'tesseract'
  }
}

/**
 * 构造不依赖真实 PNG 解码的协调器图片依赖。
 * @param diagnostics 诊断事件接收数组。
 * @returns 可注入的基线、备用图片与日志依赖。
 * @author zhenghq
 */
function imageDeps(diagnostics: AdaptiveOcrDiagnostic[] = []) {
  return {
    createBaseline: () => Buffer.from('baseline'),
    createFallback: () => ({
      imageBytes: Buffer.from('fallback'),
      strategy: 'moderate-scale' as const,
      requestedScale: 3,
      actualScale: 2
    }),
    logger: (diagnostic: AdaptiveOcrDiagnostic) => diagnostics.push(diagnostic),
    now: (() => {
      let current = 100
      return () => current += 5
    })()
  }
}

/**
 * 校验安全基线直接返回且不会创建备用图片。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应 OCR 应在高质量基线后停止且仅识别一次', async () => {
  let recognizeCount = 0
  let fallbackCount = 0
  const output = await recognizeAdaptiveOcr(
    { imageBytes: Buffer.from('source'), maxScale: 3, language: 'zh' },
    {
      ...imageDeps(),
      createFallback: () => {
        fallbackCount += 1
        throw new Error('不应生成备用图片')
      },
      recognize: async () => {
        recognizeCount += 1
        return result('清晰中文文本内容', 0.95)
      }
    }
  )

  assert.equal(output.text, '清晰中文文本内容')
  assert.equal(recognizeCount, 1)
  assert.equal(fallbackCount, 0)
})

/**
 * 校验低质量基线只允许一轮备用识别，不会出现第三轮。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应 OCR 低质量基线最多回退一次', async () => {
  const outputs = [result('模糊', 0.2), result('仍模糊', 0.2), result('第三轮', 1)]
  let recognizeCount = 0
  const output = await recognizeAdaptiveOcr(
    { imageBytes: Buffer.from('source'), maxScale: 3, language: 'zh' },
    {
      ...imageDeps(),
      recognize: async () => outputs[recognizeCount++]!
    }
  )

  assert.equal(recognizeCount, 2)
  assert.notEqual(output.text, '第三轮')
})

/**
 * 校验备用结果仅在质量严格改善时替换基线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应 OCR 应选择严格更优的备用结果', async () => {
  const outputs = [result('模糊文本', 0.2), result('改善后的中文文本', 0.9)]
  const output = await recognizeAdaptiveOcr(
    { imageBytes: Buffer.from('source'), maxScale: 2, language: 'zh' },
    { ...imageDeps(), recognize: async () => outputs.shift()! }
  )

  assert.equal(output.text, '改善后的中文文本')
})

/**
 * 校验较差和平局备用结果均不能覆盖基线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应 OCR 应在备用较差或平局时保留基线', async () => {
  for (const fallback of [result('差', 0.1), result('基线文本', 0.4)]) {
    const baseline = result('基线文本', 0.4)
    const outputs = [baseline, fallback]
    const output = await recognizeAdaptiveOcr(
      { imageBytes: Buffer.from('source'), maxScale: 2, language: 'zh' },
      { ...imageDeps(), recognize: async () => outputs.shift()! }
    )
    assert.equal(output, baseline)
  }
})

/**
 * 校验缺失置信度不能单独证明备用结果优于基线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应 OCR 对不可比较置信度应确定性保留基线', async () => {
  const baseline = result('相同文本', 0.4)
  const outputs = [baseline, result('相同文本')]
  const output = await recognizeAdaptiveOcr(
    { imageBytes: Buffer.from('source'), maxScale: 2, language: 'zh' },
    { ...imageDeps(), recognize: async () => outputs.shift()! }
  )

  assert.equal(output, baseline)
})

/**
 * 校验备用预处理或识别异常不会覆盖已有有效基线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应 OCR 回退异常时应保留有效基线', async () => {
  const baseline = result('可用基线', 0.3)
  const preprocessingOutput = await recognizeAdaptiveOcr(
    { imageBytes: Buffer.from('source'), maxScale: 2, language: 'zh' },
    {
      ...imageDeps(),
      createFallback: () => { throw new Error('预处理失败') },
      recognize: async () => baseline
    }
  )
  let count = 0
  const recognitionOutput = await recognizeAdaptiveOcr(
    { imageBytes: Buffer.from('source'), maxScale: 2, language: 'zh' },
    {
      ...imageDeps(),
      recognize: async () => {
        count += 1
        if (count === 2) throw new Error('识别失败')
        return baseline
      }
    }
  )

  assert.equal(preprocessingOutput, baseline)
  assert.equal(recognitionOutput, baseline)
})

/**
 * 校验基线失败时允许备用结果恢复，两轮均失败时保留基线错误语义。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应 OCR 应使用备用恢复基线失败并传播两轮失败', async () => {
  const baselineError = new OcrEngineError('empty', '基线为空')
  let count = 0
  const recovered = await recognizeAdaptiveOcr(
    { imageBytes: Buffer.from('source'), maxScale: 2, language: 'zh' },
    {
      ...imageDeps(),
      recognize: async () => {
        count += 1
        if (count === 1) throw baselineError
        return result('备用恢复文本', 0.9)
      }
    }
  )
  assert.equal(recovered.text, '备用恢复文本')

  count = 0
  await assert.rejects(
    recognizeAdaptiveOcr(
      { imageBytes: Buffer.from('source'), maxScale: 2, language: 'zh' },
      {
        ...imageDeps(),
        recognize: async () => {
          count += 1
          throw count === 1 ? baselineError : new Error('备用失败')
        }
      }
    ),
    (error: unknown) => error === baselineError
  )
})

/**
 * 校验基线失败后备用结果仍无效时保持基线错误语义。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应 OCR 在基线失败且备用结果无效时应传播基线错误', async () => {
  const baselineError = new OcrEngineError('empty', '基线为空')
  let count = 0

  await assert.rejects(
    recognizeAdaptiveOcr(
      { imageBytes: Buffer.from('source'), maxScale: 2, language: 'zh' },
      {
        ...imageDeps(),
        recognize: async () => {
          count += 1
          if (count === 1) throw baselineError
          return result('')
        }
      }
    ),
    (error: unknown) => error === baselineError
  )
  assert.equal(count, 2)
})

/**
 * 校验基线超时保持既有立即传播语义，不再执行备用识别。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应 OCR 基线超时应立即传播', async () => {
  let count = 0
  const timeout = new OcrEngineError('timeout', '识别超时')
  await assert.rejects(
    recognizeAdaptiveOcr(
      { imageBytes: Buffer.from('source'), maxScale: 2, language: 'zh' },
      {
        ...imageDeps(),
        recognize: async () => {
          count += 1
          throw timeout
        }
      }
    ),
    (error: unknown) => error === timeout
  )
  assert.equal(count, 1)
})

/**
 * 校验诊断包含策略、倍率、质量和耗时，但不泄漏图片及完整文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应 OCR 诊断应结构化且不包含敏感内容', async () => {
  const diagnostics: AdaptiveOcrDiagnostic[] = []
  const secretText = '不得出现在诊断中的完整识别文字'
  const outputs = [result('差', 0.2), result(secretText, 0.9)]
  await recognizeAdaptiveOcr(
    { imageBytes: Buffer.from('private-image-bytes'), maxScale: 3, language: 'zh' },
    { ...imageDeps(diagnostics), recognize: async () => outputs.shift()! }
  )

  assert.deepEqual(diagnostics.map((item) => item.event), [
    'fallback-triggered',
    'fallback-completed'
  ])
  const completed = diagnostics[1]!
  assert.equal(completed.strategy, 'moderate-scale')
  assert.equal(completed.requestedScale, 3)
  assert.equal(completed.actualScale, 2)
  assert.ok(completed.baselineQuality)
  assert.ok(completed.fallbackQuality)
  assert.equal(completed.selected, 'fallback')
  assert.ok((completed.elapsedMs ?? 0) > 0)
  const serialized = JSON.stringify(diagnostics)
  assert.doesNotMatch(serialized, /private-image-bytes/u)
  assert.doesNotMatch(serialized, new RegExp(secretText, 'u'))
  assert.doesNotMatch(serialized, /imageBytes|"text"/u)
})

/**
 * 校验备用识别失败时诊断仍记录已生成候选的策略和倍率。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应 OCR 回退识别异常诊断应保留候选策略信息', async () => {
  const diagnostics: AdaptiveOcrDiagnostic[] = []
  let count = 0
  const baseline = result('低质量基线', 0.2)
  const output = await recognizeAdaptiveOcr(
    { imageBytes: Buffer.from('source'), maxScale: 3, language: 'zh' },
    {
      ...imageDeps(diagnostics),
      recognize: async () => {
        count += 1
        if (count === 1) return baseline
        throw new Error('备用识别失败')
      }
    }
  )

  assert.equal(output, baseline)
  const failed = diagnostics.at(-1)!
  assert.equal(failed.event, 'fallback-failed')
  assert.equal(failed.strategy, 'moderate-scale')
  assert.equal(failed.requestedScale, 3)
  assert.equal(failed.actualScale, 2)
  assert.equal(failed.selected, 'baseline')
  assert.ok((failed.elapsedMs ?? 0) > 0)
})
