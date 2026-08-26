import assert from 'node:assert/strict'
import test from 'node:test'
import { SelectionListenerController } from '../src/main/selectionListenerController.ts'

interface ListenerHarness {
  controller: SelectionListenerController
  starts: () => number
  stops: () => number
  setStartResults: (results: boolean[]) => void
}

/**
 * 创建可观测的监听控制器测试夹具。
 * @returns 控制器、启停次数读取器和启动结果配置器。
 * @author zhenghq
 */
function createListenerHarness(): ListenerHarness {
  let startCount = 0
  let stopCount = 0
  let startResults = [true]
  const controller = new SelectionListenerController({
    start: () => {
      startCount += 1
      return startResults.shift() ?? true
    },
    stop: () => {
      stopCount += 1
    },
    log: () => undefined
  })
  return {
    controller,
    starts: () => startCount,
    stops: () => stopCount,
    setStartResults: (results) => {
      startResults = [...results]
    }
  }
}

test('按钮和自动模式需要鼠标监听，快捷键模式不得启动监听', () => {
  const harness = createListenerHarness()

  harness.controller.setMode('button')
  assert.equal(harness.starts(), 1)
  assert.equal(harness.controller.isRunning(), true)
  harness.controller.setMode('button')
  harness.controller.setMode('auto')
  assert.equal(harness.starts(), 1)

  harness.controller.setMode('hotkey')
  assert.equal(harness.stops(), 1)
  assert.equal(harness.controller.isRunning(), false)

  harness.controller.setMode('auto')
  assert.equal(harness.starts(), 2)
})

test('OCR 暂停与重复恢复应幂等，并按当前模式恢复目标状态', () => {
  const harness = createListenerHarness()
  harness.controller.setMode('button')

  harness.controller.pause('ocr')
  assert.equal(harness.stops(), 1)
  harness.controller.pause('ocr')
  assert.equal(harness.stops(), 1)

  harness.controller.resume('ocr')
  assert.equal(harness.starts(), 2)
  harness.controller.resume('ocr')
  assert.equal(harness.starts(), 2)

  harness.controller.pause('ocr')
  harness.controller.setMode('hotkey')
  harness.controller.resume('ocr')
  assert.equal(harness.starts(), 2)
  assert.equal(harness.controller.isRunning(), false)
})

test('启动失败后实际状态保持未运行，重新应用设置可以再次启动', () => {
  const harness = createListenerHarness()
  harness.setStartResults([false, true])

  harness.controller.setMode('button')
  assert.equal(harness.starts(), 1)
  assert.equal(harness.controller.isRunning(), false)

  harness.controller.refresh()
  assert.equal(harness.starts(), 2)
  assert.equal(harness.controller.isRunning(), true)
})
