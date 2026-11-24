import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const ts = createRequire(`${process.cwd()}/package.json`)('typescript')

/** 装载真实窗口管理器并用内存窗口验证生命周期；返回管理器与窗口记录。@author zhenghq */
function harness(autoReady = true) {
  const windows: any[] = []
  class Window {
    destroyed = false
    pinned = true
    level = ''
    relativeLevel = 0
    shown = false
    visible = true
    raised = 0
    pinChanges = 0
    listeners = new Map<string, () => void>()
    webContents = { setWindowOpenHandler() {} }
    /** 记录原生窗口配置；参数为窗口选项。@author zhenghq */
    constructor(public options: any) { windows.push(this) }
    /** 登记窗口事件；参数为事件名和回调。@author zhenghq */
    on(name: string, cb: () => void) { this.listeners.set(name, cb) }
    /** 登记一次性窗口事件；参数为事件名和回调。@author zhenghq */
    once(name: string, cb: () => void) { this.on(name, cb) }
    /** 返回窗口是否已销毁。@author zhenghq */
    isDestroyed() { return this.destroyed }
    /** 返回原生置顶状态。@returns 是否置顶。@author zhenghq */
    isAlwaysOnTop() { return this.pinned }
    /** 返回遮罩是否可见。@returns 当前可见状态。@author zhenghq */
    isVisible() { return this.visible }
    /** 移动当前窗口到所在层级前方。@returns 无返回值。@author zhenghq */
    moveTop() { this.raised += 1 }
    /** 移除窗口事件订阅。@param name 事件名。@param cb 原回调。@returns 无返回值。@author zhenghq */
    removeListener(name: string, cb: () => void) {
      if (this.listeners.get(name) === cb) this.listeners.delete(name)
    }
    /** 设置置顶状态；参数为状态。@author zhenghq */
    setAlwaysOnTop(value: boolean, level: string, relativeLevel = 0) {
      this.pinned = value; this.level = level; this.relativeLevel = relativeLevel; this.pinChanges += 1
    }
    /** 读取当前窗口边界；返回包含移动后位置的边界。@author zhenghq */
    getBounds() { return { x: this.options.x, y: this.options.y, width: this.options.width, height: this.options.height } }
    /** 模拟移动和缩放；参数为新边界，无返回值。@author zhenghq */
    setBounds(bounds: any) { Object.assign(this.options, bounds) }
    /** 模拟全工作区可见设置。@author zhenghq */
    setVisibleOnAllWorkspaces() {}
    /** 显示窗口但不抢焦点。@author zhenghq */
    showInactive() { this.shown = true }
    /** 销毁窗口并通知管理器。@author zhenghq */
    close() { this.destroyed = true; this.listeners.get('closed')?.() }
  }
  const module = { exports: {} as any }
  const code = ts.transpileModule(readFileSync('src/main/ocrResultWindow.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(code, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require: (id: string) => {
      if (id === 'electron') return {
        BrowserWindow: Window,
        screen: { getDisplayMatching: () => ({ workArea: { x: -1440, y: 0, width: 1440, height: 900 } }) }
      }
      if (id === './windowWorkspaceVisibility') return { ALL_WORKSPACES_VISIBILITY_OPTIONS: {} }
      throw new Error(`未批准依赖：${id}`)
    }
  })
  const manager = module.exports.createOcrResultWindowManager({
    preloadPath: '/preload',
    /** 模拟原生首帧与结果内容分别就绪。@param win 结果窗口。@returns 无返回值。@author zhenghq */
    loadPage(win: Window) {
      if (autoReady) queueMicrotask(() => {
        win.listeners.get('ready-to-show')?.()
        manager.rendererReady(win)
      })
    }
  })
  return { windows, manager }
}

test('钉住 OCR 应创建无父窗口的独立置顶窗口并保留原文、译文和当前位置', async () => {
  const { manager, windows } = harness()
  const payload = { text: '识别原文\n第二行', translation: 'Translation', status: '完成',
    bounds: { x: -1200, y: 200, width: 440, height: 300 } }
  await manager.create(payload)
  const win = windows[0]
  win.listeners.get('ready-to-show')()
  assert.equal(win.options.parent, undefined)
  assert.equal(win.options.alwaysOnTop, true)
  assert.equal(win.level, 'screen-saver', '独立结果不应被仍然打开的截图层遮挡')
  assert.equal(win.options.resizable, true)
  assert.equal(win.options.x, -1200)
  assert.equal(win.options.y, 200)
  assert.equal(win.shown, true)
  assert.equal(manager.getPayload(win).text, payload.text)
  assert.equal(manager.getPayload(win).translation, payload.translation)
  // 截图覆盖窗口关闭与管理器无关，数据不依赖截图会话。@author zhenghq
  assert.equal(manager.ownsWindow(win), true)
  assert.equal(win.destroyed, false)
  manager.setPinned(win, false)
  assert.equal(win.pinned, false)
  assert.equal(win.destroyed, false)
  manager.close(win)
  assert.equal(manager.ownsWindow(win), false)
})

test('独立 OCR 窗口拒绝其它窗口操作并在应用退出时释放', async () => {
  const { manager, windows } = harness()
  await manager.create({ text: '原文', translation: '', status: '', bounds: { x: -1200, y: 100, width: 400, height: 240 } })
  assert.equal(manager.getPayload({}), null)
  manager.close({})
  assert.equal(windows[0].destroyed, false)
  manager.dispose()
  assert.equal(windows[0].destroyed, true)
  assert.equal(manager.ownsWindow(windows[0]), false)
})

test('独立 OCR 窗口拒绝无效文本及非法尺寸且不创建空窗口', () => {
  const { manager, windows } = harness()
  const payload = { text: '原文', translation: '', status: '', bounds: { x: 0, y: 0, width: 400, height: 240 } }
  for (const invalid of [null, { ...payload, text: '' }, { ...payload, bounds: { ...payload.bounds, x: NaN } }]) {
    assert.throws(() => manager.create(invalid), /invalid-request/u)
  }
  assert.equal(windows.length, 0)
})

test('钉住 IPC 校验截图会话，独立结果在关闭截图和开启新会话后仍能翻译', async () => {
  const { manager, windows } = harness(false)
  const handlers = new Map<string, (...args: any[]) => any>()
  let quit: () => void = () => {}
  let sessionId = 1
  const overlaySender = {}
  const module = { exports: {} as any }
  const code = ts.transpileModule(readFileSync('src/main/ipc/ocrIpc.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(code, {
    module, exports: module.exports,
    require: (id: string) => {
      if (id === 'electron') return {
        app: { once: (_event: string, cb: () => void) => { quit = cb } },
        BrowserWindow: { fromWebContents: (sender: unknown) => windows.find((win) => win.webContents === sender) ?? null },
        ipcMain: {
          handle: (name: string, cb: (...args: any[]) => any) => handlers.set(name, cb),
          on: (name: string, cb: (...args: any[]) => any) => handlers.set(name, cb)
        }
      }
      if (id === '../ocrResultWindow') return { createOcrResultWindowManager: () => manager }
      if (id === '../screenshotExportPayload') return {}
      throw new Error(`未批准依赖：${id}`)
    }
  })
  module.exports.registerOcrIpc({
    isOcrSelectionSender: (event: any) => event.sender === overlaySender,
    getOcrSelectionSessionId: () => sessionId,
    cancelOcrSelection: () => { sessionId += 1 },
    translateOcrPanelText: async (text: string) => `译文：${text}`
  })
  const payload = { text: '原文', translation: '', status: '', sessionId, bounds: { x: -1000, y: 100, width: 400, height: 240 } }
  const pin = handlers.get('ocr-selection:panel-pin')!
  assert.throws(() => pin({ sender: {} }, payload), /invalid-sender/u)
  assert.throws(() => pin({ sender: overlaySender }, { ...payload, sessionId: 0 }), /invalid-request/u)
  let handoff = false
  const pending = pin({ sender: overlaySender }, payload).then(() => { handoff = true })
  windows[0].listeners.get('ready-to-show')()
  handlers.get('ocr-result:ready')!({ sender: overlaySender })
  await Promise.resolve()
  assert.equal(handoff, false, '截图页面不得冒充独立结果页完成交接')
  handlers.get('ocr-result:ready')!({ sender: windows[0].webContents })
  await pending
  handlers.get('ocr-selection:cancel')!()
  const event = { sender: windows[0].webContents }
  assert.equal(windows[0].destroyed, false)
  assert.equal(handlers.get('ocr-result:init')!(event).text, '原文')
  handlers.get('ocr-result:resize')!(event, { width: 480, height: 280 })
  assert.equal(windows[0].getBounds().width, 480)
  handlers.get('ocr-result:resize')!({ sender: overlaySender }, { width: 900, height: 700 })
  assert.equal(windows[0].getBounds().width, 480, '截图页不能缩放独立结果窗口')
  assert.equal(await handlers.get('ocr-result:translate')!(event, { text: '原文', requestId: 'pinned-1' }), '译文：原文')
  assert.throws(() => handlers.get('ocr-result:translate')!({ sender: overlaySender }, '原文'), /invalid-sender/u)
  quit()
  assert.equal(windows[0].destroyed, true)
})

test('OCR 面板翻译应等待服务就绪并沿用语言和凭证配置', async () => {
  const module = { exports: {} as any }
  const calls: any[] = []
  const code = ts.transpileModule(readFileSync('src/main/ocrPanelTranslation.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(code, {
    module, exports: module.exports,
    require: (id: string) => {
      if (id === './messages') return { translateMain: () => '无可翻译文本' }
      if (id === '../shared/selectionBehavior') return { resolveLanguagePair: () => ({ sourceLang: 'auto', targetLang: 'EN' }) }
      if (id === './translate') return { translateStream: async (...args: any[]) => {
        calls.push(args)
        args[4].onDelta('Trans')
        args[4].onDelta('lation')
        return { translation: 'Translation' }
      } }
      throw new Error(`未批准依赖：${id}`)
    }
  })
  let ready = false
  const whenReady = async (action: () => unknown) => { ready = true; return action() }
  const settings = () => { assert.equal(ready, true); return { sourceLang: 'auto', targetLang: 'auto', aiEnabled: true, dingTalkEnabled: true } }
  const dingTalk = () => ({ getCredentialsSnapshot: () => ({ appKey: 'key' }) })
  const ai = () => ({ getApiKey: () => 'ai-key' })
  const translate = module.exports.translateOcrPanelText
  const deltas: string[] = []
  assert.equal(await translate('  识别原文  ', whenReady, settings, dingTalk, ai, (delta: string) => deltas.push(delta)), 'Translation')
  assert.deepEqual(deltas, ['Trans', 'lation'], '翻译完成之前必须转发流式增量')
  assert.equal(calls[0][0], '识别原文')
  assert.equal(calls[0][1].targetLang, 'EN')
  assert.equal(calls[0][2].appKey, 'key')
  assert.equal(calls[0][3], 'ai-key')
  await assert.rejects(() => translate('', whenReady, settings, dingTalk, ai), /无可翻译文本/u)
  await assert.rejects(() => translate('a'.repeat(5001), whenReady, settings, dingTalk, ai), /无可翻译文本/u)
})

test('OCR 结果复制入口始终复制原文，钉住通过独立窗口 IPC 脱离截图', () => {
  const selection = readFileSync('src/renderer/src/selection.ts', 'utf8')
  const html = readFileSync('src/renderer/selection.html', 'utf8')
  assert.match(html, /id="ocr-panel-copy"/u)
  const parsed = ts.createSourceFile('selection.ts', selection, ts.ScriptTarget.ES2022, true)
  const fn = parsed.statements.find((node: any) => node.name?.text === 'copyOcrPanelText')
  assert.ok(fn, '需要 OCR 原文复制方法')
  const copied: string[] = []
  const status = { textContent: '' }
  runInNewContext(ts.transpileModule(`${fn.getText(parsed)}\ncopyOcrPanelText()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    ocrPanelText: { value: '原文\n  保留空格' }, ocrPanelStatus: status,
    window: { api: { copy: (text: string) => copied.push(text) } }, t: (key: string) => key
  })
  assert.deepEqual(copied, ['原文\n  保留空格'])
  assert.match(selection, /window\.api\.pinOcrPanel\(/u)
  const ipc = readFileSync('src/main/ipc/ocrIpc.ts', 'utf8')
  assert.match(ipc, /ocr-result:translate/u)
  assert.match(ipc, /ocrResultWindows\.ownsWindow/u)
  assert.match(ipc, /before-quit/u)
  const renderer = readFileSync('src/renderer/src/ocr-result.ts', 'utf8')
  assert.match(renderer, /window\.api\.copy\(ocrPanelText\.value\)/u)
  assert.match(renderer, /translatePinnedOcrText/u)
})

for (const rendererFirst of [false, true]) {
  test(`钉住交接必须等待原生首帧和 OCR 内容就绪（内容先就绪：${rendererFirst}）`, async () => {
    const { manager, windows } = harness(false)
    let completed = false
    const pending = manager.create({ text: '原文', translation: '', status: '',
      bounds: { x: -1200, y: 100, width: 400, height: 240 } }).then(() => { completed = true })
    const win = windows[0]
    if (rendererFirst) manager.rendererReady(win)
    else win.listeners.get('ready-to-show')()
    await Promise.resolve()
    assert.equal(completed, false, '新结果未绘制完成时不得通知旧面板隐藏')
    assert.equal(win.shown, false, '不得显示空结果窗口')
    if (rendererFirst) win.listeners.get('ready-to-show')()
    else manager.rendererReady(win)
    await pending
    assert.equal(win.shown, true)
    assert.equal(completed, true)
    manager.close(win)
  })
}

test('截图仍可见时取消钉住不得被遮罩盖住，截图隐藏后恢复普通层级且仍可再次钉住', async () => {
  const { manager, windows } = harness()
  const listeners = new Map<string, () => void>()
  const overlay = {
    visible: true,
    isDestroyed: () => false,
    /** 返回截图遮罩可见状态。@returns 是否可见。@author zhenghq */
    isVisible() { return this.visible },
    /** 订阅截图生命周期。@param name 事件。@param cb 回调。@returns 无返回值。@author zhenghq */
    on(name: string, cb: () => void) { listeners.set(name, cb) },
    /** 清理订阅。@param name 事件。@returns 无返回值。@author zhenghq */
    removeListener(name: string) { listeners.delete(name) }
  }
  await manager.create({ text: '原文', translation: '', status: '',
    bounds: { x: -1200, y: 100, width: 400, height: 240 } }, overlay)
  const win = windows[0]
  const initialPinChanges = win.pinChanges
  assert.equal(win.relativeLevel, 1, '独立结果应高于截图遮罩，而非仅与其同层级')
  const initialRaised = win.raised
  listeners.get('focus')?.()
  assert.equal(win.raised, initialRaised + 1, '点击截图空白处使遮罩聚焦后，应保持结果在前方')
  assert.equal(win.pinChanges, initialPinChanges, '重新置前不能反复写入原生层级')
  manager.setPinned(win, false)
  assert.equal(win.pinned, true, '截图遮罩仍在时应暂缓降级，避免结果消失')
  assert.equal(win.shown, true)
  assert.equal(win.destroyed, false)
  assert.equal(win.pinChanges, initialPinChanges, '截图未退出时不要重复设置相同层级引发闪烁')
  const raisedAfterUnpin = win.raised
  listeners.get('focus')?.()
  assert.equal(win.raised, raisedAfterUnpin + 1, '取消钉住但截图仍在时也要避免被遮罩盖住')
  assert.equal(win.pinChanges, initialPinChanges)
  overlay.visible = false
  listeners.get('hide')?.()
  assert.equal(win.pinned, false, '截图退出后应兑现取消置顶')
  assert.equal(listeners.has('focus'), false, '截图退出后移除焦点保护，不再强制未钉窗口置前')
  manager.setPinned(win, true)
  assert.equal(win.pinned, true)
  assert.equal(win.relativeLevel, 0, '截图退出后应归还临时抬高的层级')
  manager.setPinned(win, false)
  assert.equal(win.pinned, false)
  assert.equal(win.destroyed, false)
  manager.close(win)
  assert.equal(listeners.size, 0, '结果关闭应清理截图事件订阅')
})

test('钉住窗口沿用原面板的透明圆角外观和右下角缩放三角标', async () => {
  const { manager, windows } = harness()
  await manager.create({ text: '原文', translation: '', status: '',
    bounds: { x: -1200, y: 100, width: 400, height: 240 } })
  assert.equal(windows[0].options.transparent, true, '避免钉住后出现不透明的矩形底色')
  assert.equal(windows[0].options.backgroundColor, '#00000000')
  assert.equal(windows[0].options.hasShadow, false, '不叠加与原面板不同的原生阴影')
  const html = readFileSync('src/renderer/ocr-result.html', 'utf8')
  assert.match(html, /src\/selection\.css/u, '沿用截图面板的主题样式')
  assert.match(html, /<body class="ocr-result-window">/u, '独立窗口应使用专属样式作用域')
  assert.match(html, /id="ocr-panel-resize"[^>]*class="ocr-panel-resize"/u)
  const css = readFileSync('src/renderer/src/ocr-result.css', 'utf8')
  assert.match(css, /\.ocr-result-window \.ocr-panel\s*\{[^}]*position:\s*relative;[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*max-width:\s*none;[^}]*max-height:\s*none;/su,
    '独立窗口规则的优先级必须高于选区页面的通用面板规则，避免打包后尺寸规则被覆盖')
  assert.match(css, /\.ocr-panel-resize\s*\{[^}]*-webkit-app-region:\s*no-drag/u)
  manager.close(windows[0])
})

test('独立 OCR 手柄缩放始终保留当前屏幕位置并校验尺寸及窗口归属', async () => {
  const { manager, windows } = harness()
  await manager.create({ text: '原文', translation: '', status: '',
    bounds: { x: -1200, y: 100, width: 400, height: 240 } })
  const win = windows[0]
  win.setBounds({ x: -900, y: 300, width: 400, height: 240 })
  manager.resize(win, { width: 520, height: 360 })
  assert.deepEqual(win.getBounds(), { x: -900, y: 300, width: 520, height: 360 })
  win.setBounds({ x: -800, y: 200 })
  manager.resize(win, { width: 540, height: 320 })
  assert.deepEqual(win.getBounds(), { x: -800, y: 200, width: 540, height: 320 })
  for (const invalid of [null, {}, { width: NaN, height: 200 }, { width: 200, height: Infinity },
    { width: '520', height: 200 }, { width: -1, height: 200 }]) manager.resize(win, invalid)
  assert.deepEqual(win.getBounds(), { x: -800, y: 200, width: 540, height: 320 })
  manager.resize(win, { width: 1, height: 1 })
  assert.deepEqual(win.getBounds(), { x: -800, y: 200, width: 320, height: 160 })
  manager.resize(win, { width: 99999, height: 99999 })
  assert.deepEqual(win.getBounds(), { x: -1440, y: 0, width: 1440, height: 900 }, '尺寸受工作区限制，并在需要时向左上移动')
  manager.resize({ isDestroyed: () => false }, { width: 400, height: 240 })
  manager.close(win)
  manager.resize(win, { width: 400, height: 240 })
})

test('独立 OCR 三角手柄支持屏幕坐标拖拽、连续缩放及指针释放', () => {
  const source = readFileSync('src/renderer/src/ocr-result.ts', 'utf8')
  const parsed = ts.createSourceFile('ocr-result.ts', source, ts.ScriptTarget.ES2022, true)
  const names = ['startResize', 'moveResize', 'stopResize']
  const functions = names.map((name) => {
    const fn = parsed.statements.find((node: any) => node.name?.text === name)
    assert.ok(fn, `需要缩放处理方法 ${name}`)
    return fn.getText(parsed)
  })
  for (const [event, fn] of [['pointerdown', 'startResize'], ['pointermove', 'moveResize'],
    ['pointerup', 'stopResize'], ['pointercancel', 'stopResize'], ['lostpointercapture', 'stopResize']]) {
    assert.ok(source.includes(`resizeHandle.addEventListener('${event}', ${fn})`))
  }
  const captures = new Set<number>()
  const sizes: any[] = []
  const api = { resizePinnedOcrPanel: (size: any) => sizes.push({ ...size }) }
  const window = { innerWidth: 400, innerHeight: 240, api }
  const resizeHandle = {
    setPointerCapture: (id: number) => captures.add(id), hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => captures.delete(id)
  }
  const context: any = { window, resizeHandle }
  runInNewContext(ts.transpileModule(`let resizeDrag = null;\n${functions.join('\n')}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context)
  const event = (extra: any = {}) => ({ button: 0, pointerId: 1, screenX: 500, screenY: 400,
    preventDefault() {}, stopPropagation() {}, ...extra })
  context.startResize(event({ button: 2 }))
  context.moveResize(event({ screenX: 530 }))
  assert.equal(sizes.length, 0, '非左键不得开始缩放')
  context.startResize(event())
  context.moveResize(event({ pointerId: 2, screenX: 700 }))
  assert.equal(sizes.length, 0, '忽略其它指针')
  context.moveResize(event({ screenX: 580, screenY: 430 }))
  assert.deepEqual(sizes.pop(), { width: 480, height: 270 })
  context.moveResize(event())
  assert.deepEqual(sizes.pop(), { width: 400, height: 240 }, '拖回起点必须能恢复开始拖动时的尺寸')
  context.stopResize(event())
  assert.equal(captures.size, 0)
  window.innerWidth = 480; window.innerHeight = 270
  context.startResize(event({ screenX: 800, screenY: 600 }))
  context.moveResize(event({ screenX: 820, screenY: 640 }))
  assert.deepEqual(sizes.pop(), { width: 500, height: 310 }, '再次拖动应使用当前尺寸而非初始尺寸')
  context.stopResize(event())
  context.moveResize(event({ screenX: 1000 }))
  assert.equal(sizes.length, 0)
  for (const path of ['src/preload/index.ts', 'src/shared/types.ts']) {
    assert.match(readFileSync(path, 'utf8'), /resizePinnedOcrPanel/u)
  }
})

test('结果未就绪就关闭时应拒绝交接并释放窗口，允许截图旧面板保留', async () => {
  const { manager, windows } = harness(false)
  const pending = manager.create({ text: '原文', translation: '', status: '',
    bounds: { x: -1200, y: 100, width: 400, height: 240 } })
  const rejected = assert.rejects(pending, /ocr-window-not-ready/u)
  manager.close(windows[0])
  await rejected
  assert.equal(manager.ownsWindow(windows[0]), false)
  manager.rendererReady(windows[0])
  assert.equal(windows[0].shown, false)
})

test('结果渲染器必须等待原文、主题、语言及绘制帧完成后才通知交接', async () => {
  const elements = new Map<string, any>()
  const frames: Array<() => void> = []
  let resolveSettings!: (value: unknown) => void
  let resolvePayload!: (value: unknown) => void
  let notifications = 0
  const settings = new Promise((resolve) => { resolveSettings = resolve })
  const payload = new Promise((resolve) => { resolvePayload = resolve })
  const api = {
    getSettings: () => settings, onSettingsChanged: () => () => {},
    getPinnedOcrPanel: () => payload, notifyPinnedOcrPanelReady: () => { notifications += 1 }
  }
  const code = ts.transpileModule(readFileSync('src/renderer/src/ocr-result.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(code, {
    exports: {}, window: { api },
    document: {
      /** 提供最小结果控件。@param id 元素标识。@returns 内存元素。@author zhenghq */
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, { value: '', addEventListener() {}, setAttribute() {} })
        return elements.get(id)
      }
    },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    require: (id: string) => {
      if (id === './runtimeCompatibility') return { applyWin7CompatibilityAttribute() {} }
      if (id === './theme') return { startThemeRuntime() {} }
      if (id === './locale') return { startLocaleRuntime: () => ({ translator: { t: (key: string) => key }, onLocaleChanged() {} }) }
      throw new Error(`未批准依赖：${id}`)
    }
  })
  resolvePayload({ text: '识别内容', translation: '译文', status: '完成' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(frames.length, 0, '主题语言未确认时不能通知显示')
  resolveSettings({})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(elements.get('ocr-panel-text').value, '识别内容')
  assert.equal(elements.get('ocr-panel-translation').value, '译文')
  assert.equal(notifications, 0)
  frames.shift()!()
  assert.equal(notifications, 0, '首次布局完成前不能交接')
  frames.shift()!()
  assert.equal(notifications, 1)
})
