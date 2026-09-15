import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { SelectionListenerController } from '../src/main/selectionListenerController.ts'

/**
 * 截取指定函数（从函数声明到下一个顶层注释块）的源码片段。
 * @param source 文件源码。
 * @param functionName 函数名。
 * @returns 函数源码片段；未找到时返回空字符串。
 * @author zhenghq
 */
function readFunctionSource(source: string, functionName: string): string {
  const start = source.indexOf(`function ${functionName}`)
  if (start < 0) return ''
  const end = source.indexOf('/**', start + 1)
  return source.slice(start, end < 0 ? source.length : end)
}

test('划词起点分类收敛：非 track 分类不再逐条写盘', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const downSource = readFunctionSource(source, 'handleSelectionPointerDown')

  assert.notEqual(downSource, '')
  // 外部应用的正常按下是绝对多数，pointerdown 分类日志已移除，
  // 避免每次点击都同步写盘；仅保留失活自有窗口矩形的抑制留痕。
  assert.doesNotMatch(downSource, /pointerdown 分类/u)
  assert.match(downSource, /if \(result === 'track'\)/u, '仅在 track 时检查是否需要留痕')
})

test('鼠标松开未触发划词时应记录静默原因', () => {
  const source = readFileSync('src/main/autoTrigger.ts', 'utf8')
  const upSource = readFunctionSource(source, 'onMouseUp')

  assert.notEqual(upSource, '')
  assert.match(upSource, /modifier-held/u)
  assert.match(upSource, /no-start/u)
  assert.match(upSource, /no-callback/u)
  // 阈值未达的高频日志已移除，只保留低频的静默原因。
  assert.doesNotMatch(upSource, /划词未达阈值/u)
})

test('选区手势被忽略时应记录 OCR、自有窗口、弹窗与按钮命中条件', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const handlerSource = readFunctionSource(source, 'handleSelectionGesture')

  assert.notEqual(handlerSource, '')
  assert.match(handlerSource, /console\.log\(/)
  assert.match(handlerSource, /ocr/u)
  assert.match(handlerSource, /focused/u)
  assert.match(handlerSource, /popup/u)
  assert.match(handlerSource, /button/u)
})

test('自有窗口命中日志应写明命中窗口、矩形与应用激活状态', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const diagnosticsStart = source.indexOf('function describeFocusedOwnWindowHit')
  assert.notEqual(diagnosticsStart, -1, '应存在自有窗口命中诊断函数')
  const diagnosticsSource = source.slice(
    diagnosticsStart,
    source.indexOf('/**', diagnosticsStart + 1)
  )

  // 只有矩形判定无法定位是哪个窗口吞掉了划词，日志必须带窗口名与边界。
  assert.match(diagnosticsSource, /hit\.name/u)
  assert.match(diagnosticsSource, /bounds=/u)
  assert.match(diagnosticsSource, /appActive=/u)

  // 窗口名由候选收集函数提供，需保证设置页与网页阅读器都能被区分。
  const candidatesStart = source.indexOf('function collectOwnWindowCandidates')
  assert.notEqual(candidatesStart, -1, '应存在自有窗口候选收集函数')
  const candidatesSource = source.slice(
    candidatesStart,
    source.indexOf('/**', candidatesStart + 1)
  )
  assert.match(candidatesSource, /name: 'settings'/u)
  assert.match(candidatesSource, /name: 'webReader'/u)
})

test('划词监听控制器应记录启停、重启与暂停原因快照', () => {
  const logs: string[] = []
  const controller = new SelectionListenerController({
    start: () => true,
    stop: () => undefined,
    log: (message) => logs.push(message)
  })

  controller.setMode('button')
  controller.pause('ocr')
  controller.resume('ocr')
  controller.restart()
  controller.stop()

  const text = logs.join('\n')
  assert.match(text, /\[selectionListener\]/u)
  assert.match(text, /mode=button/u)
  assert.match(text, /pauseReasons=\[ocr\]/u)
  assert.match(text, /pauseReasons=\[shutdown\]/u)
  assert.match(text, /重启/u)
  assert.match(text, /停止/u)
})
