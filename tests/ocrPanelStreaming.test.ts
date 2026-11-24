import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const ts = createRequire(`${process.cwd()}/package.json`)('typescript')

/** 提取真实函数并在隔离上下文执行；参数为源码路径、函数名与上下文，返回函数。@author zhenghq */
function loadFunction(path: string, name: string, context: Record<string, any>) {
  const source = readFileSync(path, 'utf8')
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true)
  const fn = parsed.statements.find((node: any) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(fn, `缺少函数 ${name}`)
  const code = ts.transpileModule(`${fn.getText(parsed)}\nglobalThis.loaded = ${name}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  runInNewContext(code, context)
  return context.loaded
}

/** 模拟可延迟完成的翻译；返回结果控制器与增量回调。@author zhenghq */
function deferredTranslation() {
  let resolve!: (text: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject, onDelta: (_delta: string) => {} }
}

/** 构造截图面板真实翻译函数环境；返回 DOM 状态与函数。@author zhenghq */
function selectionHarness() {
  const request = deferredTranslation()
  const context: Record<string, any> = {
    ocrPanelTranslationPending: false, ocrPanelShowingTranslation: false,
    ocrPanelTranslationVersion: 0, currentOcrSessionId: 1,
    ocrPanelText: { value: '原文', hidden: false },
    ocrPanelTranslation: { value: '旧译文', hidden: true },
    ocrPanelTranslateButton: { disabled: false }, ocrPanelPinButton: { disabled: false },
    ocrPanelStatus: { textContent: '' }, layoutOcrPanel: () => {}, t: (key: string) => key,
    window: { api: { translateOcrPanelText: (_text: string, _session: number, onDelta: (delta: string) => void) => {
      request.onDelta = onDelta
      return request.promise
    } } }
  }
  return { context, request, translate: loadFunction('src/renderer/src/selection.ts', 'translateOcrPanelText', context) }
}

test('截图 OCR 面板在请求完成前逐段显示译文，完成后使用最终结果', async () => {
  const { context, request, translate } = selectionHarness()
  const pending = translate()
  assert.equal(context.ocrPanelTranslation.value, '')
  assert.equal(context.ocrPanelTranslateButton.disabled, true)
  request.onDelta('你')
  assert.equal(context.ocrPanelTranslation.value, '你')
  assert.equal(context.ocrPanelTranslation.hidden, false)
  request.onDelta('好')
  assert.equal(context.ocrPanelTranslation.value, '你好')
  request.resolve('你好！')
  await pending
  assert.equal(context.ocrPanelTranslation.value, '你好！')
  assert.equal(context.ocrPanelTranslateButton.disabled, false)
  assert.equal(context.ocrPanelPinButton.disabled, false)
})

test('截图 OCR 面板兼容没有增量的缓存与非流式结果', async () => {
  const { context, request, translate } = selectionHarness()
  const pending = translate()
  request.resolve('完整译文')
  await pending
  assert.equal(context.ocrPanelTranslation.value, '完整译文')
  assert.equal(context.ocrPanelTranslation.hidden, false)
})

test('截图面板重置后丢弃旧翻译增量、最终结果及状态更新', async () => {
  const { context, request, translate } = selectionHarness()
  const pending = translate()
  context.ocrPanelTranslationVersion += 1
  context.ocrPanelTranslation.value = '新面板'
  context.ocrPanelStatus.textContent = '新状态'
  request.onDelta('过期增量')
  request.resolve('过期结果')
  await pending
  assert.equal(context.ocrPanelTranslation.value, '新面板')
  assert.equal(context.ocrPanelStatus.textContent, '新状态')
  assert.equal(context.ocrPanelTranslateButton.disabled, true, '旧请求不能改变新请求按钮状态')
})

test('独立 OCR 结果窗口逐段显示并在失败后允许重试', async () => {
  const request = deferredTranslation()
  const context: Record<string, any> = {
    translationPending: false, ocrPanelText: { value: '原文' },
    translationText: { value: '', hidden: true }, translateButton: { disabled: false },
    status: { textContent: '' }, localeRuntime: { translator: { t: (key: string) => key } },
    window: { api: { translatePinnedOcrText: (_text: string, onDelta: (delta: string) => void) => {
      request.onDelta = onDelta
      return request.promise
    } } }
  }
  const translate = loadFunction('src/renderer/src/ocr-result.ts', 'translateText', context)
  const pending = translate()
  request.onDelta('部分')
  assert.equal(context.translationText.value, '部分')
  assert.equal(context.translationText.hidden, false)
  request.reject(new Error('翻译失败'))
  await pending
  assert.equal(context.translateButton.disabled, false)
  assert.equal(context.translationPending, false)
  assert.equal(context.translationText.value, '', '失败的部分译文不能被当成完整缓存')
})

test('预加载桥按请求隔离增量并在成功或失败后释放监听', async () => {
  const listeners = new Set<(event: unknown, payload: any) => void>()
  const requests: any[] = []
  const context: Record<string, any> = {
    ocrPanelTranslationSequence: 0,
    ipcRenderer: {
      on: (_channel: string, listener: any) => listeners.add(listener),
      removeListener: (_channel: string, listener: any) => listeners.delete(listener),
      invoke: (_channel: string, payload: any) => {
        const request = deferredTranslation()
        requests.push({ ...request, payload })
        return request.promise
      }
    }
  }
  const invoke = loadFunction('src/preload/index.ts', 'invokeOcrPanelTranslation', context)
  const first: string[] = []
  const second: string[] = []
  const a = invoke('ocr-selection:panel-translate', { text: 'A', sessionId: 1 }, (delta: string) => first.push(delta))
  const b = invoke('ocr-result:translate', { text: 'B' }, (delta: string) => second.push(delta))
  assert.equal(listeners.size, 2)
  for (const listener of listeners) listener({}, { requestId: requests[0].payload.requestId, delta: '甲' })
  assert.deepEqual(first, ['甲'])
  assert.deepEqual(second, [])
  requests[0].resolve('甲')
  assert.equal(await a, '甲')
  assert.equal(listeners.size, 1)
  requests[1].reject(new Error('失败'))
  await assert.rejects(b, /失败/u)
  assert.equal(listeners.size, 0)
})

test('面板重置应释放翻译处理中状态并使旧请求失效', () => {
  const { context } = selectionHarness()
  context.ocrPanelTranslationPending = true
  context.ocrPanelTranslationVersion = 5
  context.ocrPanel = { hidden: false }
  context.ocrPanelCopyButton = { disabled: false }
  const render = loadFunction('src/renderer/src/selection.ts', 'renderOcrPanel', context)
  render('hidden')
  assert.equal(context.ocrPanelTranslationVersion, 6)
  assert.equal(context.ocrPanelTranslationPending, false)
  assert.equal(context.ocrPanelTranslation.value, '')
  render('ready', '新原文', '已识别')
  assert.equal(context.ocrPanelTranslateButton.disabled, false)
})

test('OCR 流式 IPC 只投递到请求窗口，拒绝伪造请求并跳过过期或销毁窗口', async () => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const pending: Array<ReturnType<typeof deferredTranslation>> = []
  let sessionId = 1
  let ownsPinned = true
  /** 构造窗口消息接收器；返回消息记录、存活状态与 IPC 方法。@author zhenghq */
  const sender = () => ({
    destroyed: false, sent: [] as any[],
    /** 返回是否已销毁。@returns 销毁状态。@author zhenghq */
    isDestroyed() { return this.destroyed },
    /** 记录增量消息。@param channel 通道。@param payload 增量负载。@returns 无返回值。@author zhenghq */
    send(channel: string, payload: any) { this.sent.push({ channel, ...payload }) }
  })
  const overlay = sender()
  const pinned = sender()
  const pinnedWindow = {}
  const module = { exports: {} as any }
  const code = ts.transpileModule(readFileSync('src/main/ipc/ocrIpc.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  runInNewContext(code, {
    module, exports: module.exports,
    require: (id: string) => {
      if (id === 'electron') return {
        app: { once: () => {} }, BrowserWindow: { fromWebContents: (value: unknown) => value === pinned ? pinnedWindow : null },
        ipcMain: {
          handle: (name: string, fn: any) => handlers.set(name, fn),
          on: (name: string, fn: any) => handlers.set(name, fn)
        }
      }
      if (id === '../ocrResultWindow') return { createOcrResultWindowManager: () => ({ ownsWindow: () => ownsPinned }) }
      if (id === '../screenshotExportPayload') return {}
      throw new Error(`未批准依赖：${id}`)
    }
  })
  module.exports.registerOcrIpc({
    isOcrSelectionSender: (event: any) => event.sender === overlay,
    getOcrSelectionSessionId: () => sessionId,
    translateOcrPanelText: (_text: string, onDelta: (delta: string) => void) => {
      const request = deferredTranslation()
      request.onDelta = onDelta
      pending.push(request)
      return request.promise
    }
  })
  const translate = handlers.get('ocr-selection:panel-translate')!
  const translatePinned = handlers.get('ocr-result:translate')!
  const payload = { text: '原文', sessionId: 1, requestId: 'overlay-1' }
  assert.throws(() => translate({ sender: pinned }, payload), /invalid-sender/u)
  assert.throws(() => translate({ sender: overlay }, { ...payload, sessionId: 2 }), /invalid-request/u)
  assert.throws(() => translate({ sender: overlay }, { ...payload, requestId: '' }), /invalid-request/u)
  assert.throws(() => translatePinned({ sender: overlay }, payload), /invalid-sender/u)
  assert.throws(() => translatePinned({ sender: pinned }, { text: '原文' }), /invalid-request/u)
  const a = translate({ sender: overlay }, payload)
  const b = translatePinned({ sender: pinned }, { text: '原文', requestId: 'pinned-1' })
  pending[0].onDelta('截图增量')
  pending[1].onDelta('独立增量')
  assert.deepEqual(overlay.sent, [{ channel: 'ocr-panel:translation-delta', requestId: 'overlay-1', delta: '截图增量' }])
  assert.deepEqual(pinned.sent, [{ channel: 'ocr-panel:translation-delta', requestId: 'pinned-1', delta: '独立增量' }])
  sessionId += 1
  pending[0].onDelta('旧会话增量')
  assert.equal(overlay.sent.length, 1)
  ownsPinned = false
  pending[1].onDelta('已关闭增量')
  ownsPinned = true
  pinned.destroyed = true
  pending[1].onDelta('已销毁增量')
  assert.equal(pinned.sent.length, 1)
  pending[0].resolve('截图结果')
  pending[1].resolve('独立结果')
  assert.deepEqual(await Promise.all([a, b]), ['截图结果', '独立结果'])
})
