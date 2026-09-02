import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  PREPARED_PREFETCH_WAIT_MS,
  SelectionCaptureCoordinator
} from '../src/shared/selectionCaptureCoordinator.ts'
import { resolveCapturedClipboardState } from '../src/shared/copyShortcutBehavior.ts'

/**
 * 构造一个可由测试手动完成的取词函数，用于模拟尚未结束的只读预取。
 * @returns 取词函数、开始通知与手动完成回调。
 * @author zhenghq
 */
function createControllablePrefetch(): {
  prefetch: (signal: AbortSignal) => Promise<string>
  started: Promise<void>
  finish: (text: string) => void
  abortObserved: () => boolean
} {
  let notifyStarted: (() => void) | undefined
  let resolveCapture: ((text: string) => void) | undefined
  let aborted = false
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })

  return {
    prefetch: (signal: AbortSignal) => new Promise<string>((resolve) => {
      resolveCapture = resolve
      signal.addEventListener('abort', () => {
        aborted = true
        resolve('')
      }, { once: true })
      notifyStarted?.()
    }),
    started,
    finish: (text: string) => resolveCapture?.(text),
    abortObserved: () => aborted
  }
}

/**
 * 校验按钮预取的默认等待窗口足够短，不会让点击“译”按钮出现可感知卡顿。
 * @returns 无返回值。
 * @author zhenghq
 */
test('按钮预取的默认等待窗口不得超过 100ms', () => {
  assert.ok(PREPARED_PREFETCH_WAIT_MS > 0)
  assert.ok(PREPARED_PREFETCH_WAIT_MS <= 100)
})

/**
 * 校验已完成且含文本的预取缓存会被立即命中，不需要任何等待。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('已完成的预取缓存应被立即命中且不进入等待', async () => {
  const anchor = { x: 200, y: 120 }
  const coordinator = new SelectionCaptureCoordinator(
    async () => '完整管线取词',
    async () => '已完成的预取文字'
  )

  await coordinator.prepare(anchor)
  const consumption = await coordinator.consumePreparedBounded()

  assert.equal(consumption.status, 'hit')
  assert.deepEqual(consumption.result, { text: '已完成的预取文字', anchor })
  assert.ok(consumption.waitedMs < PREPARED_PREFETCH_WAIT_MS)
})

/**
 * 校验快速点击“译”按钮时，窗口内完成的预取会被消费，不再退化到复制兜底。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('未完成的预取在有界窗口内返回文本时应被消费且不执行按钮专用取词', async () => {
  const controllable = createControllablePrefetch()
  let buttonCaptureCount = 0
  const coordinator = new SelectionCaptureCoordinator(
    async () => '完整管线取词',
    controllable.prefetch,
    async () => {
      buttonCaptureCount += 1
      return '按钮复制到的文字'
    }
  )
  const anchor = { x: 240, y: 160 }

  void coordinator.prepare(anchor)
  await controllable.started
  const consuming = coordinator.consumePreparedBounded()
  setTimeout(() => controllable.finish('  窗口内完成的预取文字  '), 10)
  const consumption = await consuming

  assert.equal(consumption.status, 'hit')
  assert.deepEqual(consumption.result, { text: '窗口内完成的预取文字', anchor })
  assert.equal(buttonCaptureCount, 0)
  assert.equal(controllable.abortObserved(), false)
})

/**
 * 校验预取卡住时等待按时结束，随后仍可取消预取并执行按钮专用复制兜底。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('预取超过有界窗口时应按时结束等待并允许回退按钮专用取词', async () => {
  const controllable = createControllablePrefetch()
  let buttonCaptureCount = 0
  const coordinator = new SelectionCaptureCoordinator(
    async () => '完整管线取词',
    controllable.prefetch,
    async () => {
      buttonCaptureCount += 1
      return '按钮复制到的文字'
    }
  )
  const anchor = { x: 280, y: 200 }

  void coordinator.prepare(anchor)
  await controllable.started
  const startedAt = performance.now()
  const consumption = await coordinator.consumePreparedBounded()
  const waited = performance.now() - startedAt

  assert.equal(consumption.status, 'timeout')
  assert.equal(consumption.result, null)
  // 等待必须有界：远小于原生直读 1.5 秒超时，避免按钮点击被长时间阻塞。
  assert.ok(waited < 500, `等待耗时应有界，实际 ${waited}ms`)
  assert.ok(consumption.waitedMs >= PREPARED_PREFETCH_WAIT_MS)

  const captured = await coordinator.captureFromButton(anchor)
  assert.deepEqual(captured, { text: '按钮复制到的文字', anchor })
  assert.equal(buttonCaptureCount, 1)
  assert.equal(controllable.abortObserved(), true)
})

/**
 * 有界等待的打点必须使用单调递增的亚毫秒时钟（performance.now），
 * 避免 Date.now 的毫秒取整误差让 waitedMs 在 CI 上偶发小于等待窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('有界等待的耗时打点应使用 performance.now 单调时钟', () => {
  const source = readFileSync('src/shared/selectionCaptureCoordinator.ts', 'utf8')
  const boundedBody = source.match(/consumePreparedBounded\([\s\S]*?^  \}/mu)?.[0] ?? ''

  assert.notEqual(boundedBody, '', '应能提取 consumePreparedBounded 实现')
  assert.match(boundedBody, /performance\.now\(\)/u)
  assert.doesNotMatch(boundedBody, /Date\.now\(\)/u)
})

/**
 * 校验等待期间请求失效时不会把过期预取结果交给翻译流程。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('有界等待期间请求失效时必须丢弃过期预取结果', async () => {
  const controllable = createControllablePrefetch()
  const coordinator = new SelectionCaptureCoordinator(
    async () => '完整管线取词',
    controllable.prefetch
  )

  void coordinator.prepare({ x: 320, y: 240 })
  await controllable.started
  const consuming = coordinator.consumePreparedBounded()
  coordinator.invalidate()
  controllable.finish('已经过期的预取文字')
  const consumption = await consuming

  assert.equal(consumption.result, null)
  assert.equal(consumption.status, 'stale')
})

/**
 * 校验没有缓存也没有进行中预取时立即返回未命中，不做任何等待。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('没有预取缓存与进行中预取时应立即返回未命中', async () => {
  const coordinator = new SelectionCaptureCoordinator(async () => '完整管线取词')

  const consumption = await coordinator.consumePreparedBounded()

  assert.equal(consumption.status, 'absent')
  assert.equal(consumption.result, null)
  assert.ok(consumption.waitedMs < PREPARED_PREFETCH_WAIT_MS)
})

/**
 * 校验快捷键直接取词会跳过完整原生直读管线，并复用及时发送复制键的专用取词函数。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('快捷键直接取词应跳过原生直读并调用复制取词函数', async () => {
  let fullCaptureCount = 0
  let directCaptureCount = 0
  const coordinator = new SelectionCaptureCoordinator(
    async () => {
      fullCaptureCount += 1
      return '原生直读结果'
    },
    undefined,
    async () => {
      directCaptureCount += 1
      return '快捷键复制结果'
    }
  )
  const anchor = { x: 360, y: 280 }

  const captured = await coordinator.captureDirect(anchor)

  assert.deepEqual(captured, { text: '快捷键复制结果', anchor })
  assert.equal(fullCaptureCount, 0)
  assert.equal(directCaptureCount, 1)
})

/**
 * 校验预取已完成但为空时不等待，直接判定未命中，由按钮专用取词兜底。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('预取已完成但为空时应直接判定未命中', async () => {
  const anchor = { x: 60, y: 60 }
  const coordinator = new SelectionCaptureCoordinator(
    async () => '完整管线取词',
    async () => ({ text: '', reason: 'empty' as const })
  )

  await coordinator.prepare(anchor)
  const consumption = await coordinator.consumePreparedBounded()

  assert.equal(consumption.status, 'empty')
  assert.equal(consumption.result, null)
})

/**
 * 校验复制兜底的最终状态判定：轮询命中优先，其次采用稳定期内晚到的内容。
 * @returns 无返回值。
 * @author zhenghq
 */
test('复制兜底应以轮询结果优先，并接受稳定期内晚到的文字或图片', () => {
  const sentinel = '__SENTINEL__'

  assert.deepEqual(
    resolveCapturedClipboardState(
      { text: '轮询取到的文字', hasImage: false },
      { text: '稳定期后的其他内容', hasImage: false },
      sentinel
    ),
    { text: '轮询取到的文字', hasImage: false, status: 'polled' }
  )

  assert.deepEqual(
    resolveCapturedClipboardState(
      { text: sentinel, hasImage: false },
      { text: '稳定期内晚到的文字', hasImage: false },
      sentinel
    ),
    { text: '稳定期内晚到的文字', hasImage: false, status: 'late' }
  )

  assert.deepEqual(
    resolveCapturedClipboardState(
      { text: sentinel, hasImage: false },
      { text: sentinel, hasImage: true },
      sentinel
    ),
    { text: '', hasImage: true, status: 'late' }
  )

  assert.deepEqual(
    resolveCapturedClipboardState(
      { text: sentinel, hasImage: false },
      { text: sentinel, hasImage: false },
      sentinel
    ),
    { text: '', hasImage: false, status: 'timeout' }
  )

  assert.deepEqual(
    resolveCapturedClipboardState(
      { text: '', hasImage: false },
      { text: '', hasImage: false },
      sentinel
    ),
    { text: '', hasImage: false, status: 'timeout' }
  )

  // 轮询阶段已捕获图片时，哨兵文本不得作为翻译内容返回。
  assert.deepEqual(
    resolveCapturedClipboardState(
      { text: sentinel, hasImage: true },
      { text: sentinel, hasImage: true },
      sentinel
    ),
    { text: '', hasImage: true, status: 'polled' }
  )
})

/**
 * 校验按钮入口先有界等待预取再回退复制兜底，且输出可区分的竞态诊断日志。
 * @returns 无返回值。
 * @author zhenghq
 */
test('按钮入口应有界等待预取并记录预取诊断日志', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const translateStart = source.indexOf('async function translateSelectionButton')
  const translateEnd = source.indexOf('/**\n * 处理取词结果', translateStart)
  const translateSource = source.slice(translateStart, translateEnd)

  assert.ok(translateStart >= 0)
  assert.ok(translateEnd > translateStart)
  assert.match(translateSource, /await selectionCapture\.consumePreparedBounded\(\)/u)
  // 有界等待必须在按钮专用取词之前，且不得重新引入无界等待。
  assert.doesNotMatch(translateSource, /consumePreparedOrWait/u)
  assert.match(
    translateSource,
    /consumePreparedBounded\(\)[\s\S]*?button-prefetch[\s\S]*?selectionCapture\.captureFromButton\(anchor\)/u
  )
  assert.match(translateSource, /status=\$\{consumption\.status\}/u)
  assert.match(translateSource, /waitedMs=\$\{consumption\.waitedMs\}/u)
  // 诊断日志不得输出选中文字内容。
  assert.doesNotMatch(translateSource, /textPreview|\$\{prepared\?\.text\}|\$\{result\.text\}/u)
})

/**
 * 校验 Windows 按钮入口立即非激活显示读取状态，同时保留源应用焦点供复制取词。
 * @returns 无返回值。
 * @author zhenghq
 */
test('点击“译”后应先显示读取中的翻译弹窗，再等待 Windows 剪贴板取词完成', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const popupSource = readFileSync('src/main/popup.ts', 'utf8')
  const translateStart = source.indexOf('async function translateSelectionButton')
  const translateEnd = source.indexOf('/**\n * 处理取词结果', translateStart)
  const translateSource = source.slice(translateStart, translateEnd)

  assert.ok(translateStart >= 0)
  assert.ok(translateEnd > translateStart)
  assert.match(
    translateSource,
    /hideSelectionButton\(\)[\s\S]*?showSelectionReadingPopup\(anchor\)[\s\S]*?consumePreparedBounded\(\)/u
  )
  const popupHelperStart = source.indexOf('function showSelectionReadingPopup')
  const popupHelperEnd = source.indexOf('/**\n * 捕获当前选中文字', popupHelperStart)
  const popupHelperSource = source.slice(popupHelperStart, popupHelperEnd)
  assert.ok(popupHelperStart >= 0)
  assert.ok(popupHelperEnd > popupHelperStart)
  assert.match(popupHelperSource, /loadingMessage:\s*'正在读取选中文字…'/u)
  assert.match(popupHelperSource, /anchor,\s*false\s*\)/u)
  assert.match(popupSource, /activate\s*\?\s*win\.show\(\)\s*:\s*win\.showInactive\(\)/u)
})

/**
 * 校验复制兜底在剪贴板稳定期后重新读取状态，并让晚到内容参与最终判定。
 * @returns 无返回值。
 * @author zhenghq
 */
test('复制兜底必须在稳定期后重新读取剪贴板并采用晚到结果', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const copyStart = source.indexOf('async function captureByCopy')
  const copyEnd = source.indexOf('/**\n * 捕获当前选中文字', copyStart)
  const copySource = source.slice(copyStart, copyEnd)

  assert.ok(copyStart >= 0)
  assert.ok(copyEnd > copyStart)
  // 稳定期结束后必须重新读取文本与图片状态，并把最终状态交给统一判定。
  assert.match(
    copySource,
    /await sleep\(CLIPBOARD_STABILITY_DELAY_MS\)[\s\S]*?clipboard\.readText\(\)[\s\S]*?clipboard\.readImage\(\)[\s\S]*?resolveCapturedClipboardState\(/u
  )
  assert.match(copySource, /text = resolved\.text/u)
  assert.match(copySource, /hasImage = resolved\.hasImage/u)
  // 复制完成日志必须能区分轮询命中、稳定期晚到与真实超时。
  assert.match(copySource, /copy-finish status=\$\{/u)
  assert.doesNotMatch(copySource, /textPreview|\$\{text\}/u)
})
