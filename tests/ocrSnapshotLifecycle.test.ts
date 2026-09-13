import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  handleOcrSelectionWindowClosed,
  handleOcrSelectionWindowHide
} from '../src/main/ocrSelectionWindowEvents.ts'

const main = readFileSync('src/main/index.ts', 'utf8')

/**
 * 截取源码中指定函数的函数体文本。
 * @param source 源码文本。
 * @param signature 函数签名前缀。
 * @returns 函数体文本。
 * @author zhenghq
 */
function sliceFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.notStrictEqual(start, -1, `未找到函数 ${signature}`)
  const end = source.indexOf('\n}\n', start)
  assert.notStrictEqual(end, -1, `未找到函数 ${signature} 的结尾`)
  return source.slice(start, end)
}

/** 覆盖窗口事件收尾的可观测记录。 */
interface WindowEventRecorder {
  /** 结束 Renderer 会话清理等待时收到的 ready 值。 */
  readyValues: boolean[]
  /** 清空活动请求的次数。 */
  clearRequests: number
  /** 释放快照的次数。 */
  releaseSnapshot: number
  /** 恢复划词监听的次数。 */
  restoreListener: number
}

/**
 * 构造覆盖窗口事件收尾的可观测依赖。
 * @returns 记录器与依赖集合。
 * @author zhenghq
 */
function createEventHarness(): {
  recorder: WindowEventRecorder
  hideDeps: Parameters<typeof handleOcrSelectionWindowHide>[0]
  closedDeps: Parameters<typeof handleOcrSelectionWindowClosed>[0]
} {
  const recorder: WindowEventRecorder = {
    readyValues: [],
    clearRequests: 0,
    releaseSnapshot: 0,
    restoreListener: 0
  }
  const base = {
    resolveReady: (ready: boolean) => recorder.readyValues.push(ready),
    clearActiveRequests: () => { recorder.clearRequests += 1 },
    restoreSelectionListener: () => { recorder.restoreListener += 1 }
  }
  return {
    recorder,
    hideDeps: { ...base },
    closedDeps: {
      ...base,
      releaseSnapshot: () => { recorder.releaseSnapshot += 1 }
    }
  }
}

/**
 * 校验覆盖窗口隐藏只做收尾，不释放当前会话快照。
 *
 * 这是 Windows「截图 → 文字识别 → 翻译」报「截图已失效，请重新截图」的直接回归边界：
 * 翻译流程先隐藏覆盖窗口再裁剪快照，Windows 上 hide 事件同步派发，
 * 一旦在 hide 中释放快照，紧随其后的裁剪就会取不到图。
 * @returns 无返回值。
 * @author zhenghq
 */
test('覆盖窗口 hide 不得释放当前会话快照', () => {
  const { recorder, hideDeps } = createEventHarness()

  handleOcrSelectionWindowHide(hideDeps)

  assert.equal(recorder.releaseSnapshot, 0, 'hide 不得释放快照，否则翻译会在裁剪前丢失截图')
  assert.deepEqual(recorder.readyValues, [false], 'hide 应结束会话清理等待')
  assert.equal(recorder.clearRequests, 1, 'hide 应清空进行中的截图动作请求')
  assert.equal(recorder.restoreListener, 1, 'hide 应恢复普通划词监听')
})

/**
 * 校验 hide 的依赖面在结构上就不具备释放快照的能力。
 *
 * 仅靠「hide 没有调用 release」不足以防止回归：只要 hide 的依赖里能拿到释放能力，
 * 后续改动就可能再次把窗口隐藏当成会话结束。这里断言 hide 依赖接口不含快照释放字段，
 * 而 closed 依赖在继承 hide 收尾的基础上显式声明释放能力。
 * @returns 无返回值。
 * @author zhenghq
 */
test('hide 依赖面不得具备释放快照的能力', () => {
  const moduleSource = readFileSync('src/main/ocrSelectionWindowEvents.ts', 'utf8')

  const hideInterfaceStart = moduleSource.indexOf('export interface OcrSelectionWindowHideDeps')
  const hideInterfaceEnd = moduleSource.indexOf('}', hideInterfaceStart)
  assert.notStrictEqual(hideInterfaceStart, -1, '应导出 hide 依赖接口')
  const hideInterfaceSource = moduleSource.slice(hideInterfaceStart, hideInterfaceEnd)

  assert.doesNotMatch(
    hideInterfaceSource,
    /releaseSnapshot/u,
    'hide 依赖接口不得包含快照释放能力，否则窗口隐藏可能再次被当成会话结束'
  )

  const closedInterfaceStart = moduleSource.indexOf('export interface OcrSelectionWindowClosedDeps')
  const closedInterfaceEnd = moduleSource.indexOf('}', closedInterfaceStart)
  const closedInterfaceSource = moduleSource.slice(closedInterfaceStart, closedInterfaceEnd)
  assert.match(
    closedInterfaceSource,
    /extends OcrSelectionWindowHideDeps/u,
    'closed 依赖应复用 hide 的收尾契约'
  )
  assert.match(
    closedInterfaceSource,
    /releaseSnapshot/u,
    'closed 依赖必须显式声明快照释放能力'
  )
})

/**
 * 校验覆盖窗口关闭释放当前会话快照。
 * @returns 无返回值。
 * @author zhenghq
 */
test('覆盖窗口 closed 应释放当前会话快照', () => {
  const { recorder, closedDeps } = createEventHarness()

  handleOcrSelectionWindowClosed(closedDeps)

  assert.equal(recorder.releaseSnapshot, 1, 'closed 意味着会话终止，应释放快照')
  assert.deepEqual(recorder.readyValues, [false], 'closed 应结束会话清理等待')
  assert.equal(recorder.clearRequests, 1, 'closed 应清空进行中的截图动作请求')
  assert.equal(recorder.restoreListener, 1, 'closed 应恢复普通划词监听')
})

/**
 * 校验主进程 hide 事件处理器不释放快照，closed 事件处理器释放快照。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主进程 hide 事件处理器不得写入 latestOcrSnapshot', () => {
  const windowStart = main.indexOf('function getOcrSelectionWindow(): BrowserWindow')
  const windowEnd = main.indexOf('\n}\n', windowStart)
  const windowSource = main.slice(windowStart, windowEnd)
  assert.notStrictEqual(windowStart, -1, '应存在 OCR 覆盖窗口创建函数')

  const hideStart = windowSource.indexOf("on('hide'")
  const hideEnd = windowSource.indexOf("on('closed'")
  assert.notStrictEqual(hideStart, -1, '应注册 hide 事件')
  assert.notStrictEqual(hideEnd, -1, '应注册 closed 事件')
  const hideSource = windowSource.slice(hideStart, hideEnd)

  assert.doesNotMatch(
    hideSource,
    /latestOcrSnapshot\s*=\s*null/u,
    'hide 只是窗口不可见，不得释放当前会话快照'
  )
  assert.match(hideSource, /handleOcrSelectionWindowHide/u, 'hide 应收敛到共享事件处理器')
  assert.match(hideSource, /restoreSelectionListenerAfterOcr/u, 'hide 仍需兜底恢复划词监听')
})

/**
 * 校验主进程 closed 事件处理器仍释放快照并复用共享事件处理器。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主进程 closed 事件处理器应释放快照', () => {
  const windowStart = main.indexOf('function getOcrSelectionWindow(): BrowserWindow')
  const windowEnd = main.indexOf('\n}\n', windowStart)
  const windowSource = main.slice(windowStart, windowEnd)

  const closedStart = windowSource.indexOf("on('closed'")
  assert.notStrictEqual(closedStart, -1, '应注册 closed 事件')
  const closedSource = windowSource.slice(closedStart)

  assert.match(closedSource, /handleOcrSelectionWindowClosed/u, 'closed 应收敛到共享事件处理器')
  assert.match(closedSource, /latestOcrSnapshot\s*=\s*null/u, 'closed 意味着会话终止，应释放快照')
})

/**
 * 校验快照释放点语义：翻译裁剪消费快照，识别与复制保存路径只读不消费。
 * @returns 无返回值。
 * @author zhenghq
 */
test('快照释放点应区分消费与只读', () => {
  const cropSource = sliceFunction(main, 'async function cropOcrSnapshotSelection')
  assert.match(cropSource, /latestOcrSnapshot\s*=\s*null/u, '翻译裁剪成功后应消费快照')

  const readOnlySource = sliceFunction(main, 'function cropCurrentOcrSelectionPng(')
  assert.doesNotMatch(
    readOnlySource,
    /latestOcrSnapshot\s*=\s*null/u,
    '识别/复制/保存共用的裁剪入口只读不消费，保证同会话多次可用'
  )

  const fastSource = sliceFunction(main, 'function cropCurrentOcrSelectionPngFast')
  assert.doesNotMatch(
    fastSource,
    /latestOcrSnapshot\s*=\s*null/u,
    '快速裁剪入口只读不消费'
  )
})

/**
 * 校验会话终止点仍显式释放快照，避免移除 hide 释放后出现内存残留。
 * @returns 无返回值。
 * @author zhenghq
 */
test('会话终止点应显式释放快照', () => {
  for (const signature of [
    'function cancelOcrSelection',
    'function finishScreenshotSession'
  ]) {
    const source = sliceFunction(main, signature)
    assert.match(source, /latestOcrSnapshot\s*=\s*null/u, `${signature} 应在会话终止时释放快照`)
  }

  const openSource = sliceFunction(main, 'async function openOcrSelection')
  assert.match(openSource, /latestOcrSnapshot\s*=\s*null/u, '开始新会话应作废上一轮快照')

  const failSource = sliceFunction(main, 'function failOcrSelectionCapture')
  assert.match(failSource, /latestOcrSnapshot\s*=\s*null/u, '采集失败应释放快照')
})

/**
 * 校验未引入按平台分支的快照释放逻辑。
 * @returns 无返回值。
 * @author zhenghq
 */
test('快照释放不得引入平台分支', () => {
  const windowStart = main.indexOf('function getOcrSelectionWindow(): BrowserWindow')
  const windowEnd = main.indexOf('\n}\n', windowStart)
  const windowSource = main.slice(windowStart, windowEnd)
  const hideStart = windowSource.indexOf("on('hide'")
  const hideEnd = windowSource.indexOf("on('closed'")
  const hideSource = windowSource.slice(hideStart, hideEnd)

  assert.doesNotMatch(hideSource, /process\.platform/u, '快照释放不应按平台分支处理')
})
