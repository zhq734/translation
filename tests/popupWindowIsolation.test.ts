import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import type { MacosWindowActivationDeps } from '../src/main/macosWindowActivation'

const ts = createRequire(`${process.cwd()}/package.json`)('typescript')

/**
 * 创建只在内存执行的窗口环境，加载真实弹窗与交还模块，禁止触及 Electron、配置与原生进程；无参数。
 * @returns 窗口、原生激活替身及可控异步时钟。
 * @author zhenghq
 */
function createHarness() {
  const windows: MockWindow[] = []
  const actions: string[] = []
  const timers: Array<() => void> = []
  const app = new EventEmitter() as EventEmitter & { hide(): void; show(): void }
  let focused: MockWindow | null = null
  /** 模拟默认激活成功；接收快照与可选依赖，返回激活结果。 @author zhenghq */
  let activation: (snapshot: unknown, deps?: MacosWindowActivationDeps) => Promise<unknown> = async () => {
    app.emit('did-resign-active')
    focused = null
    return { activated: true, confirmed: true, outcome: 'exact', windowMatched: true }
  }
  app.hide = () => { actions.push('app.hide'); windows.forEach((window) => window.hide()) }
  app.show = () => { actions.push('app.show'); windows.forEach((window) => window.show()) }

  class MockWindow extends EventEmitter {
    visible = true
    minimized = false
    destroyed = false
    focusable = true
    name: string
    webContents = Object.assign(new EventEmitter(), {
      send: (channel: string) => {
        assert.equal(this.destroyed, false, '不能向已销毁窗口发送 IPC')
        actions.push(`${this.name}:${channel}`)
      },
      isLoadingMainFrame: () => false,
      setAudioMuted: () => undefined,
      setWindowOpenHandler: () => undefined
    })
    /** 创建模拟窗口；参数为初始窗口选项，返回窗口实例。 @author zhenghq */
    constructor(options: { show?: boolean; name?: string } = {}) {
      super()
      this.name = options.name ?? 'popup'
      this.visible = options.show !== false
      windows.push(this)
    }
    /** 查询销毁状态；无参数，返回布尔值。 @author zhenghq */
    isDestroyed() { return this.destroyed }
    /** 查询显示状态；无参数，返回布尔值。 @author zhenghq */
    isVisible() { return this.visible }
    /** 查询最小化状态；无参数，返回布尔值。 @author zhenghq */
    isMinimized() { return this.minimized }
    /** 查询焦点状态；无参数，返回布尔值。 @author zhenghq */
    isFocused() { return focused === this }
    /** 设置可聚焦性；参数为开关，无返回值。 @author zhenghq */
    setFocusable(value: boolean) { this.focusable = value; actions.push(`${this.name}:focusable:${value}`) }
    /** 隐藏自身；无参数、无返回值。 @author zhenghq */
    hide() { assert.equal(this.destroyed, false); this.visible = false; if (focused === this) focused = null; actions.push(`${this.name}:hide`); this.emit('hide') }
    /** 显示自身；无参数、无返回值。 @author zhenghq */
    show() { this.visible = true; actions.push(`${this.name}:show`); this.emit('show') }
    /** 非激活显示；无参数、无返回值。 @author zhenghq */
    showInactive() { this.visible = true; actions.push(`${this.name}:showInactive`); this.emit('show') }
    /** 聚焦自身；无参数、无返回值。 @author zhenghq */
    focus() { focused = this; actions.push(`${this.name}:focus`) }
    /** 最小化自身；无参数、无返回值。 @author zhenghq */
    minimize() { this.minimized = true; actions.push(`${this.name}:minimize`) }
    /** 恢复最小化；无参数、无返回值。 @author zhenghq */
    restore() { this.minimized = false; actions.push(`${this.name}:restore`) }
    /** 关闭自身；无参数、无返回值。 @author zhenghq */
    close() { this.destroyed = true; this.visible = false; actions.push(`${this.name}:close`); this.emit('closed') }
    /** 返回模拟边界；无参数，返回矩形。 @author zhenghq */
    getBounds() { return { x: 0, y: 0, width: 520, height: 360 } }
    /** 返回模拟尺寸；无参数，返回宽高。 @author zhenghq */
    getSize() { return [520, 360] }
    /** 忽略位置写入；无参数、无返回值。 @author zhenghq */
    setPosition() {}
    /** 忽略层级写入；无参数、无返回值。 @author zhenghq */
    setAlwaysOnTop() {}
    /** 忽略工作区写入；无参数、无返回值。 @author zhenghq */
    setVisibleOnAllWorkspaces() {}
    /** 忽略渲染页面加载；无参数、无返回值。 @author zhenghq */
    loadFile() {}
    /** 查询当前焦点；无参数，返回窗口或空值。 @author zhenghq */
    static getFocusedWindow() { return focused }
    /** 查询所有窗口；无参数，返回实例列表。 @author zhenghq */
    static getAllWindows() { return windows }
  }
  const display = { workArea: { x: 0, y: 0, width: 1600, height: 1000 } }
  const electron = { app, BrowserWindow: MockWindow, screen: {
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => display,
    getAllDisplays: () => [display]
  } }
  const cache = new Map<string, any>()
  const stubs: Record<string, unknown> = {
    electron,
    'node:fs': {
      /** 禁止真实 helper 探测；无参数，始终返回不存在。 @author zhenghq */
      existsSync: () => false
    },
    'node:child_process': { execFile: () => { throw new Error('禁止真实进程') }, execFileSync: () => { throw new Error('禁止真实进程') } },
    './settings': { getSettings: () => ({ aiStreamEnabled: true }) },
    './capture': { warmChromiumAccessibility: () => undefined },
    './messages': { translateMain: (key: string) => key },
    './selectionButton': { restoreSelectionButtonIfPending: () => actions.push('button:restore') },
    './windowsForeground': { createWindowsForegroundTracker: () => ({ remember() {}, restore() {} }) },
    './platformCompatibility': { isWindows7CompatibilityRuntime: () => false },
    '../shared/activateDiagnostics': { logCandidateProbe: () => undefined },
    './macosWindowActivation': {
      /** 记录激活并透传快照、生产依赖；返回测试激活结果。 @author zhenghq */
      activateMacosWindowSnapshot: (snapshot: unknown, deps?: MacosWindowActivationDeps) => { actions.push('native:exact'); return activation(snapshot, deps) },
      isExactWindowActivationConfirmed: (result: any) => result.confirmed,
      activateMacosApplicationAndWaitForDeactivation: async () => { actions.push('native:process'); return false },
      activateMacosApplication: () => { throw new Error('禁止真实激活') }
    }
  }
  /**
   * 将真实 TypeScript 模块装入隔离上下文，仅允许白名单内存依赖。
   * @param path 相对项目路径。
   * @returns 模块导出对象。
   * @author zhenghq
   */
  function load(path: string): any {
    const file = resolve(path)
    if (cache.has(file)) return cache.get(file)
    const module = { exports: {} }
    cache.set(file, module.exports)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    runInNewContext(code, {
      module, exports: module.exports, __dirname: dirname(file), console: { log() {} },
      process: { platform: 'darwin', pid: 100, env: {}, kill() {} },
      setTimeout: (callback: () => void) => { timers.push(callback); return callback },
      clearTimeout: (callback: () => void) => { const index = timers.indexOf(callback); if (index >= 0) timers.splice(index, 1) },
      require: (id: string) => {
        if (id in stubs) return stubs[id]
        if (['node:path', 'node:util', 'node:crypto'].includes(id)) return createRequire(`${process.cwd()}/package.json`)(id)
        if (id.startsWith('.')) return load(resolve(dirname(file), `${id}.ts`))
        throw new Error(`未批准的测试依赖：${id}`)
      }
    }, { filename: file })
    return module.exports
  }
  const foreground = load('src/main/macForeground.ts')
  const popup = load('src/main/popup.ts')
  const guard = load('src/main/settingsWindowPopupHideGuard.ts')
  /**
   * 执行入口中的真实关闭回调与外部划词隐藏函数，不执行应用启动或配置读取。
   * @param target 被生命周期管理的模拟设置窗口。
   * @returns 主进程生命周期函数与只读租约状态。
   * @author zhenghq
   */
  function loadMainLifecycle(target: MockWindow) {
    const source = readFileSync('src/main/index.ts', 'utf8')
    const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
    const names = [
      'suspendSettingsWindowForExternalSelection', 'resumeSettingsWindowAfterExternalSelection',
      'handlePopupInternalWindowTransition', 'suspendSettingsWindowFocusForPopupClose',
      'finishPopupInternalWindowTransitionBeforeFocusRestore', 'releaseSettingsWindowFocusLeaseAfterFrontRecheck',
      'releaseSettingsWindowFocusAfterPopupHide', 'handlePopupCloseStart', 'handlePopupCloseEnd', 'handlePopupCloseCancelled'
    ]
    const functions = ast.statements.filter((node: any) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    assert.equal(functions.length, names.length)
    const code = ts.transpileModule(`
      let settingsWindowHiddenForSelection = false
      let settingsBringToFrontEpoch = 0
      let restoreSettingsWindowFocusAfterPopupHide = null
      let restoreSettingsWindowFocusAfterPopupFrontRecheck = null
      ${functions.map((node: any) => node.getText(ast)).join('\n')}
      globalThis.lifecycle = { ${names.join(',')},
        hasLease: () => restoreSettingsWindowFocusAfterPopupFrontRecheck !== null,
        hiddenForSelection: () => settingsWindowHiddenForSelection
      }
    `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const context: any = {
      isMac: true, process: { platform: 'darwin' }, settingsWin: target,
      isMacAppActiveByEvents: foreground.isMacAppActiveByEvents,
      suspendSettingsWindowFocusForPopupHide: guard.suspendSettingsWindowFocusForPopupHide,
      suppressSelectionActivationWindowGap: () => undefined,
      lowerSettingsPanelRaiseLevel: () => undefined,
      releaseSelectionFocusLeaseIfIdle: () => undefined,
      logCandidateProbe: () => undefined,
      isSettingsWindowVisibleForProbe: () => target.visible,
      console: { log() {} }
    }
    runInNewContext(code, context)
    return context.lifecycle
  }
  let settings: MockWindow | null = null
  const leases = new Map<number, () => void>()
  const closed: number[] = []
  const popupWindow = popup.createPopup({
    preloadPath: '',
    onPopupCloseStart: (token: number) => leases.set(token, guard.suspendSettingsWindowFocusForPopupHide('darwin', settings)),
    onFrontRecheckComplete: (token: number) => { leases.get(token)?.(); leases.delete(token) },
    onPopupCloseEnd: (token: number) => { closed.push(token); leases.get(token)?.(); leases.delete(token) },
    onPopupCloseCancelled: (token: number) => { leases.get(token)?.(); leases.delete(token) }
  }) as MockWindow
  popupWindow.visible = true
  focused = popupWindow
  app.emit('did-become-active')
  /** 设置虚拟外部源窗口记录；无参数、无返回值。 @author zhenghq */
  function remember() { foreground.rememberFrontmostApp({ bundleId: 'test.source', pid: 200, windowNumber: 1 }) }
  remember()
  actions.length = 0
  return {
    popup, popupWindow, foreground, app, actions, timers, closed, leases, MockWindow, load, loadMainLifecycle, remember,
    setSettings: (window: MockWindow) => { settings = window },
    setFocus: (window: MockWindow | null) => { focused = window },
    setActivation: (next: typeof activation) => { activation = next },
    /**
     * 执行真实窗口激活算法，只替换底层系统查询与动作；完整透传生产侧依赖门禁。
     * @param deps 内存系统依赖，缺少生产覆盖时作为真实算法的默认测试依赖。
     * @returns 无返回值。
     * @author zhenghq
     */
    useRealActivation(deps: MacosWindowActivationDeps) {
      const real = load('src/main/macosWindowActivation.ts')
      Object.assign(stubs['./macosWindowActivation'] as object, {
        enumerateMacosWindows: deps.enumerateWindows,
        readFrontmostMacosWindowNumber: deps.readFrontmostWindowNumber,
        readFocusedMacosWindowNumber: deps.readFocusedWindowNumber,
        raiseMacosWindow: deps.raiseWindow,
        isExactWindowActivationConfirmed: real.isExactWindowActivationConfirmed
      })
      /** 运行真实算法；参数为快照及生产依赖，返回原算法结果。 @author zhenghq */
      activation = (snapshot, guardedDeps) => real.activateMacosWindowSnapshot(snapshot, guardedDeps ?? deps)
    },
    /** 推进 Promise 与一次延迟复核；无参数，返回完成信号。 @author zhenghq */
    async flush() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); timers.splice(0).forEach((callback) => callback()); for (let index = 0; index < 12; index += 1) await Promise.resolve() }
  }
}

for (const page of ['翻译页面', '设置页面', '文件翻译']) {
  for (const state of ['visible', 'hidden', 'minimized', 'destroyed']) {
    test(`关闭弹窗保持${page}的${state}状态且不置前`, async () => {
      const h = createHarness()
      const other = new h.MockWindow({ name: page })
      other.visible = state !== 'hidden'
      other.minimized = state === 'minimized'
      other.destroyed = state === 'destroyed'
      if (page === '设置页面') h.setSettings(other)
      h.popup.hidePopup(true, 'renderer-ipc')
      await h.flush()
      assert.equal(h.popupWindow.visible, false)
      assert.equal(other.visible, state !== 'hidden')
      assert.equal(other.minimized, state === 'minimized')
      assert.equal(other.destroyed, state === 'destroyed')
      assert.equal(h.actions.some((action) => action.startsWith(`${page}:`) && !action.includes(':focusable:')), false)
      assert.equal(h.actions.some((action) => action.startsWith('app.')), false)
      assert.equal(h.leases.size, 0)
    })
  }
  test(`关闭非 key 弹窗不得把正在使用的${page}交还给外部应用`, async () => {
    const h = createHarness()
    const other = new h.MockWindow({ name: page })
    h.setFocus(other)
    h.popup.hidePopup(true, 'renderer-ipc')
    await h.flush()
    assert.equal(h.popupWindow.visible, false)
    assert.equal(other.isFocused(), true)
    assert.equal(h.actions.some((action) => action.startsWith('native:')), false)
  })
}

test('单弹窗仍交还源窗口，重复关闭不重复执行隐藏或租约', async () => {
  const h = createHarness()
  h.popup.hidePopup()
  h.popup.hidePopup()
  await h.flush()
  h.popup.hidePopup()
  await h.flush()
  assert.equal(h.actions.filter((action) => action === 'native:exact').length, 1)
  assert.equal(h.actions.filter((action) => action === 'popup:hide').length, 1)
  assert.equal(h.actions.filter((action) => action === 'popup:popup:hidden').length, 1)
  assert.equal(h.leases.size, 0)
})

test('内部显式页面切换仅隐藏弹窗，关闭完成回调只执行一次', async () => {
  const h = createHarness()
  const other = new h.MockWindow({ name: '文件翻译' })
  h.popup.hidePopupForInternalWindowSwitch()
  await h.flush()
  assert.equal(other.visible, true)
  assert.equal(h.actions.some((action) => action.startsWith('native:') || action.startsWith('app.')), false)
  assert.equal(h.closed.length, 1)
})

for (const manual of [false, true]) {
  test(`交还途中打开${manual ? '手动' : '新划词'}弹窗，旧失败不得继续激活或隐藏`, async () => {
    const h = createHarness()
    let finish!: (result: unknown) => void
    h.setActivation(() => new Promise((resolve) => { finish = resolve }))
    h.popup.hidePopup()
    if (manual) h.popup.showManualTranslationPopup()
    else h.popup.showPopup({ ok: true, origin: 'selection' }, 0)
    finish({ activated: false, confirmed: false, outcome: 'failed', windowMatched: false })
    await h.flush()
    assert.equal(h.popupWindow.visible, true)
    assert.equal(h.actions.includes('native:process'), false)
    assert.equal(h.actions.includes('popup:hide'), false)
    assert.equal(h.leases.size, 0)
  })
}

test('旧关闭的隐藏后复核不得抢走新弹窗的前台', async () => {
  const h = createHarness()
  h.popup.hidePopup()
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  assert.equal(h.popupWindow.visible, false)
  h.popup.showPopup({ ok: true, origin: 'selection' }, 0)
  h.app.emit('did-become-active')
  await h.flush()
  assert.equal(h.popupWindow.visible, true)
  assert.equal(h.actions.filter((action) => action === 'native:exact').length, 1)
})

test('交还途中销毁弹窗，收尾不得访问失效窗口且须释放租约', async () => {
  const h = createHarness()
  let finish!: (result: unknown) => void
  h.setActivation(() => new Promise((resolve) => { finish = resolve }))
  h.popup.hidePopup()
  h.popupWindow.destroyed = true
  finish({ activated: true, confirmed: true, outcome: 'exact', windowMatched: true })
  await h.flush()
  assert.equal(h.leases.size, 0)
  assert.equal(h.actions.includes('popup:hide'), false)
})

test('文档外部划词隔离只由显式入口解除，关闭弹窗不恢复被主动隐藏的页面', async () => {
  const h = createHarness()
  const { DocumentWorkspaceManager } = h.load('src/main/documentWorkspaceWindow.ts')
  const manager = new DocumentWorkspaceManager({ preloadPath: '', loadRenderer() {} })
  await manager.ensureWindow()
  const window = manager.getWindow()
  window.name = '文档'
  assert.equal(manager.suspendForExternalSelection('darwin'), true)
  h.actions.length = 0
  h.popup.hidePopup()
  await h.flush()
  assert.equal(window.visible, false)
  window.show()
  assert.equal(window.visible, false, '外部划词主动隐藏仍拦截迟到 show')
  manager.resumeAfterExternalSelection()
  window.show()
  assert.equal(window.visible, true, '显式入口须解除旧隐藏标记')
  h.popup.showPopup({ ok: true, origin: 'selection' }, 0)
  h.popup.hidePopupForInternalWindowSwitch()
  assert.equal(window.visible, true, '重新显式打开的页面不被旧划词隐藏标记影响')
})

test('弹窗已隐藏但仍待复核时显式切换内部页面，旧复核不得再抢焦点', async () => {
  const h = createHarness()
  h.popup.hidePopup()
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  assert.equal(h.popupWindow.visible, false)
  h.popup.hidePopupForInternalWindowSwitch()
  const other = new h.MockWindow({ name: '设置页' })
  h.setFocus(other)
  h.app.emit('did-become-active')
  await h.flush()
  assert.equal(other.isFocused(), true)
  assert.equal(h.actions.filter((action) => action === 'native:exact').length, 1)
  assert.equal(h.leases.size, 0)
})

test('销毁后重建弹窗实例，旧关闭只能释放旧租约而不能隐藏新实例', async () => {
  const h = createHarness()
  let finish!: (result: unknown) => void
  h.setActivation(() => new Promise((resolve) => { finish = resolve }))
  h.popup.hidePopup()
  h.popupWindow.destroyed = true
  const replacement = h.popup.createPopup({ preloadPath: '' })
  replacement.visible = true
  finish({ activated: true, confirmed: true, outcome: 'exact', windowMatched: true })
  await h.flush()
  assert.equal(replacement.visible, true)
  assert.equal(h.leases.size, 0)
})

for (const failure of ['missing', 'failed', 'exception']) {
  test(`源应用交还${failure}时只关弹窗、不隐藏或显示其它页面`, async () => {
    const h = createHarness()
    const other = new h.MockWindow({ name: '页面' })
    if (failure === 'missing') h.foreground.forgetFrontmostApp()
    else h.setActivation(async () => {
      if (failure === 'exception') throw new Error('模拟原生失败')
      return { activated: false, confirmed: false, outcome: 'failed', windowMatched: false }
    })
    h.popup.hidePopup()
    await h.flush()
    assert.equal(h.popupWindow.visible, false)
    assert.equal(other.visible, true)
    assert.equal(h.actions.some((action) => action.startsWith('页面:') || action.startsWith('app.')), false)
    assert.equal(h.leases.size, 0)
  })
}

test('隐藏后系统重选后台页面仍须交还源应用，不能把自动重选当成显式切换', async () => {
  const h = createHarness()
  const other = new h.MockWindow({ name: '后台页面' })
  h.popup.hidePopup()
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  h.app.emit('did-become-active')
  h.setFocus(other)
  await h.flush()
  assert.equal(h.actions.filter((action) => action === 'native:exact').length, 2)
  assert.equal(other.visible, true)
  assert.equal(other.isFocused(), false)
})

test('应用已失活且无自有焦点时关闭不激活任何应用', async () => {
  const h = createHarness()
  h.app.emit('did-resign-active')
  h.setFocus(null)
  h.popup.hidePopup()
  await h.flush()
  assert.equal(h.popupWindow.visible, false)
  assert.equal(h.actions.some((action) => action.startsWith('native:') || action.startsWith('app.')), false)
})

test('开始关闭时弹窗已销毁，不发送 IPC、不重复申请保护', () => {
  const h = createHarness()
  h.popupWindow.destroyed = true
  h.popup.hidePopup()
  assert.equal(h.actions.length, 0)
  assert.equal(h.leases.size, 0)
})

for (const suspended of [false, true]) {
  test(`真实主进程关闭回调保持${suspended ? '外部划词主动隐藏' : '关闭前可见'}的设置窗口状态`, async () => {
    const h = createHarness()
    const settings = new h.MockWindow({ name: '设置' })
    const lifecycle = h.loadMainLifecycle(settings)
    if (suspended) lifecycle.suspendSettingsWindowForExternalSelection()
    const popup = h.popup.createPopup({
      preloadPath: '',
      onPopupCloseStart: lifecycle.handlePopupCloseStart,
      onPopupCloseEndBeforeHideRestore: lifecycle.finishPopupInternalWindowTransitionBeforeFocusRestore,
      onFrontRecheckComplete: lifecycle.releaseSettingsWindowFocusLeaseAfterFrontRecheck,
      onPopupCloseEnd: lifecycle.handlePopupCloseEnd,
      onPopupCloseCancelled: lifecycle.handlePopupCloseCancelled
    })
    popup.visible = true
    h.setFocus(popup)
    h.actions.length = 0
    h.popup.hidePopup()
    await h.flush()
    assert.equal(settings.visible, !suspended)
    assert.equal(lifecycle.hiddenForSelection(), suspended)
    assert.equal(lifecycle.hasLease(), false)
    assert.equal(h.actions.some((action) => /^设置:(hide|show|showInactive|close|restore|focus|minimize)$/u.test(action)), false)
    if (suspended) {
      lifecycle.resumeSettingsWindowAfterExternalSelection()
      assert.equal(lifecycle.hiddenForSelection(), false)
      assert.equal(settings.visible, false, '解除隔离也不能在显式置前流程前擅自 show')
    }
  })
}

test('旧轮次完成不得释放新关闭租约，新轮次仍能正常隐藏', async () => {
  const h = createHarness()
  const completions: Array<(result: unknown) => void> = []
  h.setActivation(() => new Promise((resolve) => completions.push(resolve)))
  h.popup.hidePopup()
  h.popup.showPopup({ ok: true, origin: 'selection' }, 0)
  h.remember()
  h.popup.hidePopup()
  assert.equal(h.leases.size, 1)
  completions[0]({ activated: true, confirmed: true, outcome: 'exact', windowMatched: true })
  await h.flush()
  assert.equal(h.popupWindow.visible, true)
  assert.equal(h.leases.size, 1)
  h.app.emit('did-resign-active')
  h.setFocus(null)
  completions[1]({ activated: true, confirmed: true, outcome: 'exact', windowMatched: true })
  await h.flush()
  assert.equal(h.popupWindow.visible, false)
  assert.equal(h.leases.size, 0)
  assert.equal(h.actions.filter((action) => action === 'popup:hide').length, 1)
})

for (const state of ['hidden', 'minimized', 'destroyed']) {
  test(`失效内部窗口的${state}残留焦点不能阻止单弹窗交还`, async () => {
    const h = createHarness()
    const other = new h.MockWindow({ name: '非活动页面' })
    other.visible = state !== 'hidden'
    other.minimized = state === 'minimized'
    other.destroyed = state === 'destroyed'
    h.setFocus(other)
    h.popup.hidePopup()
    await h.flush()
    assert.equal(h.popupWindow.visible, false)
    assert.equal(h.actions.filter((action) => action === 'native:exact').length, 1)
    assert.equal(h.actions.some((action) => action.startsWith('非活动页面:')), false)
  })
}

test('非激活弹窗无 key window 但应用仍最前时必须继续交还', async () => {
  const h = createHarness()
  h.setFocus(null)
  h.popup.hidePopup()
  await h.flush()
  assert.equal(h.popupWindow.visible, false)
  assert.equal(h.actions.filter((action) => action === 'native:exact').length, 1)
})

test('交还途中显式打开内部页面应立即关闭旧弹窗并取消外部恢复兜底', async () => {
  const h = createHarness()
  let finish!: (result: unknown) => void
  h.setActivation(() => new Promise((resolve) => { finish = resolve }))
  h.popup.hidePopup()
  const page = new h.MockWindow({ name: '文档页' })
  h.popup.hidePopupForInternalWindowSwitch()
  h.setFocus(page)
  assert.equal(h.popupWindow.visible, false)
  finish({ activated: false, confirmed: false, outcome: 'failed', windowMatched: false })
  await h.flush()
  assert.equal(page.visible, true)
  assert.equal(page.isFocused(), true)
  assert.equal(h.actions.includes('native:process'), false)
  assert.equal(h.actions.filter((action) => action === 'popup:hide').length, 1)
  assert.equal(h.leases.size, 0)
})

/**
 * 在真实激活算法的查询边界挂起，让关闭取消发生在尚未发出原生置前请求时。
 * @param boundary 要挂起的窗口枚举、全局前台查询或 AX 焦点查询。
 * @returns 内存窗口环境、查询开始信号、释放查询方法与置前计数。
 * @author zhenghq
 */
function createNativeBoundaryHarness(boundary: 'enumerate' | 'frontmost' | 'focused') {
  const h = createHarness()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let markEntered!: () => void
  const entered = new Promise<void>((resolve) => { markEntered = resolve })
  let raised = 0
  let now = 0
  /** 等待指定查询边界；参数为当前查询类型，返回查询继续执行信号。 @author zhenghq */
  async function waitAt(query: typeof boundary): Promise<void> {
    if (boundary === query) { markEntered(); await pending }
  }
  h.useRealActivation({
    /** 枚举虚拟源窗口；参数为源进程号，返回窗口列表。 @author zhenghq */
    async enumerateWindows(pid) {
      await waitAt('enumerate')
      return {
        windows: [{ pid, windowNumber: 1, layer: 0, bounds: { x: 0, y: 0, width: 800, height: 600 } }],
        // 省略窗口编号以确保真实算法进入 readFrontmostWindowNumber 异步分支。
        frontmostPid: pid
      }
    },
    /** 查询全局前台；无参数，返回源窗口或其它窗口编号。 @author zhenghq */
    async readFrontmostWindowNumber() { await waitAt('frontmost'); return raised ? 1 : 2 },
    /** 查询 AX 焦点；参数为源进程号，返回源窗口编号或空值。 @author zhenghq */
    async readFocusedWindowNumber(_pid) { await waitAt('focused'); return raised ? 1 : null },
    /** 模拟原生置前并转移焦点；参数为源进程与窗口号，返回成功标记。 @author zhenghq */
    async raiseWindow(pid, windowNumber) {
      assert.equal(pid, 200)
      assert.equal(windowNumber, 1)
      raised += 1
      h.actions.push('native:raise')
      h.app.emit('did-resign-active')
      h.setFocus(null)
      return true
    },
    /** 拒绝测试中的应用级错误退化；参数为应用标识，不返回。 @author zhenghq */
    openApplication(_bundleId) { throw new Error('带窗口定位信息不得 openApplication') },
    /** 模拟源进程存活；参数为进程号，返回存活标记。 @author zhenghq */
    isProcessAlive(_pid) { return true },
    /** 读取虚拟时钟；无参数，返回毫秒数。 @author zhenghq */
    now() { return now },
    /** 推进虚拟时钟；参数为毫秒数，返回完成信号。 @author zhenghq */
    async sleep(ms) { now += ms }
  })
  return { h, entered, release,
    /** 查询已发出请求数；无参数，返回累计置前次数。 @author zhenghq */
    raised: () => raised
  }
}

for (const boundary of ['enumerate', 'frontmost', 'focused'] as const) {
  for (const takeover of ['manual', 'selection', 'internal-switch', 'internal-focus'] as const) {
    test(`真实激活算法在${boundary}等待后遇到${takeover}接管，不得继续发出 raise`, async () => {
      const { h, entered, release, raised } = createNativeBoundaryHarness(boundary)
      h.popup.hidePopup()
      await entered
      assert.equal(raised(), 0, '取消发生前尚未发出原生请求')
      let owner = h.popupWindow
      if (takeover === 'manual') h.popup.showManualTranslationPopup()
      else if (takeover === 'selection') {
        h.popup.showPopup({ ok: true, origin: 'selection' }, 0)
        h.setFocus(owner)
      } else {
        owner = new h.MockWindow({ name: '文档页面' })
        if (takeover === 'internal-switch') h.popup.hidePopupForInternalWindowSwitch()
        h.setFocus(owner)
      }
      assert.equal(owner.isFocused(), true)
      release()
      await h.flush()
      await h.flush()
      assert.equal(raised(), 0, '每个查询等待后必须在发出置前动作前复核取消状态')
      assert.equal(owner.isFocused(), true, '新弹窗或内部页面的焦点不得被旧关闭抢走')
      assert.equal(owner.visible, true)
      assert.equal(h.actions.includes('native:process'), false, '取消不能退化成进程级激活')
      assert.equal(h.actions.some((action) => action.startsWith('app.')), false)
      assert.equal(h.leases.size, 0)
    })
  }
  test(`真实激活算法在${boundary}等待后轮次有效，仍精确置前源窗口并关闭弹窗`, async () => {
    const { h, entered, release, raised } = createNativeBoundaryHarness(boundary)
    h.popup.hidePopup()
    await entered
    release()
    await h.flush()
    await h.flush()
    assert.equal(raised(), 1)
    assert.equal(h.popupWindow.visible, false)
    assert.equal(h.actions.includes('native:process'), false)
    assert.equal(h.leases.size, 0)
  })
}
