import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import type { WebReaderState } from '../src/shared/types.ts'

const ts = createRequire(`${process.cwd()}/package.json`)('typescript')
const renderer = ts.transpileModule(readFileSync('src/renderer/src/webReader.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

/** 替代不参与断言的浏览器生命周期方法；无参数、无返回值。@author zhenghq */
function noop(): void {}

/** 模拟原生控件并保留实际事件绑定，供控制器行为测试使用。@author zhenghq */
class Control {
  value = ''
  disabled = false
  hidden = false
  textContent = ''
  innerHTML = ''
  dataset: Record<string, string> = {}
  listeners = new Map<string, (event: any) => void>()
  /** 保存事件处理器；参数为事件名和回调，无返回值。@author zhenghq */
  addEventListener(event: string, callback: (event: any) => void): void { this.listeners.set(event, callback) }
  /** 触发已注册事件；参数为事件名，无返回值。@author zhenghq */
  dispatch(event: string): void { this.listeners.get(event)?.({ preventDefault: noop, target: this }) }
  /** 清空选项；无参数、无返回值。@author zhenghq */
  replaceChildren(): void { this.value = '' }
  /** 接受选项；参数为选项，无返回值。@author zhenghq */
  add(_option: unknown): void {}
  /** 接受无障碍属性；参数为属性名和值，无返回值。@author zhenghq */
  setAttribute(_name: string, _value: string): void {}
  /** 返回占位边界；无参数，返回矩形。@author zhenghq */
  getBoundingClientRect() { return { x: 0, y: 140, width: 1080, height: 600 } }
}

/** 等待当前事件中的 Promise 链完成；无参数，返回等待完成的 Promise。@author zhenghq */
async function settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)) }

/** 构造可完成或失败的异步请求；无参数，返回 Promise 及其控制方法。@author zhenghq */
function deferred() {
  let resolve!: (value: any) => void
  let reject!: (error: Error) => void
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** 执行完整阅读器模块；参数为可选 API 覆盖，返回控件、状态入口和调用记录。@author zhenghq */
async function setup(overrides: Record<string, (...args: any[]) => any> = {}) {
  const controls = new Map<string, Control>()
  /** 按 ID 返回唯一控件；参数为控件 ID，返回模拟控件。@author zhenghq */
  const control = (id: string): Control => {
    if (!controls.has(id)) controls.set(id, new Control())
    return controls.get(id)!
  }
  const calls: { name: string; args: any[] }[] = []
  let stateListener!: (state: WebReaderState) => void
  let state: WebReaderState = {
    readerId: 'reader', pageRevision: 0, url: '', title: '', loading: false,
    canGoBack: false, canGoForward: false
  }
  const result = { progress: { inputClosed: true, done: 1, total: 1, failed: 0 }, apply: { mismatched: 0 } }
  const api = new Proxy({}, {
    /** 记录实际 IPC 调用并提供响应；参数为目标和 API 名称，返回模拟方法。@author zhenghq */
    get(_target, key: string) {
      return (...args: any[]) => {
        calls.push({ name: key, args })
        if (overrides[key]) return overrides[key](...args)
        if (key === 'onWebReaderState') { stateListener = args[0]; return }
        if (key === 'getSettings') return Promise.resolve({ sourceLang: 'auto', targetLang: 'ZH', webTranslationDefaultMode: 'target' })
        if (key === 'webTranslateExtract') return Promise.resolve({ pageRevision: state.pageRevision })
        if (key === 'webTranslateRun') return Promise.resolve(result)
        if (key === 'webTranslateSetMode') return Promise.resolve({ mismatched: 0 })
        if (key === 'exportWebPagePdf') return Promise.resolve({ status: 'saved' })
        return Promise.resolve(false)
      }
    }
  })
  const locale = { locale: 'zh-CN', translator: { t: (key: string) => key }, onLocaleChanged: noop }
  runInNewContext(renderer, {
    exports: {},
    /** 仅替换模块边界，保留完整生产控制器；参数为依赖名，返回依赖桩。@author zhenghq */
    require(id: string) {
      if (id.endsWith('/langs')) return { LANGUAGES: [{ code: 'ZH' }, { code: 'EN' }, { code: 'JA' }], langLabel: (code: string) => code }
      if (id.endsWith('/webTranslationErrors')) return { normalizeWebTranslationError: (error: Error) => error.message }
      if (id === './theme') return { startThemeRuntime: noop }
      if (id === './locale') return { startLocaleRuntime: () => locale }
      throw new Error(`未预期的依赖：${id}`)
    },
    window: { api, addEventListener: noop },
    document: { getElementById: control, documentElement: { dataset: {} }, activeElement: null },
    Option: class {},
    ResizeObserver: class { observe = noop; disconnect = noop },
    requestAnimationFrame: noop
  })
  await settle()
  calls.length = 0
  return {
    control, calls, result,
    /** 模拟主进程发布页面状态；参数为状态补丁，无返回值。@author zhenghq */
    publish(patch: Partial<WebReaderState>) { state = { ...state, ...patch }; stateListener(state) },
    /** 读取指定 API 的调用记录；参数为名称，返回记录。@author zhenghq */
    requests(name: string) { return calls.filter(call => call.name === name) }
  }
}

test('未导航、空白占位或错误页切换语言及手动翻译均不发起请求', async () => {
  for (const page of [null, { url: '' }, { url: 'about:blank' }, { url: 'about:blank#empty' }, { url: 'chrome-error://chromewebdata/' }, { url: 'https://example.com', error: '加载失败' }]) {
    const reader = await setup()
    if (page) reader.publish(page)
    reader.control('web-source-lang').dispatch('change')
    reader.control('web-target-lang').dispatch('change')
    reader.control('web-translate').dispatch('click')
    await settle()
    assert.deepEqual(reader.calls.filter(call => call.name.startsWith('webTranslate')), [], JSON.stringify(page))
  }
})

test('有网页时源语言和目标语言变更自动重译并复用原文快照', async () => {
  const reader = await setup()
  reader.publish({ url: 'https://example.com/article', pageRevision: 1 })
  reader.control('web-source-lang').value = 'EN'
  reader.control('web-source-lang').dispatch('change')
  await settle()
  reader.control('web-target-lang').value = 'JA'
  reader.control('web-target-lang').dispatch('change')
  await settle()
  assert.equal(reader.requests('webTranslateExtract').length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(reader.requests('webTranslateRun').map(call => call.args[0]))), [
    { sourceLang: 'EN', targetLang: 'ZH' }, { sourceLang: 'EN', targetLang: 'JA' }
  ])
  assert.equal(reader.requests('webTranslateCancel').length, 2)
  assert.equal(reader.control('web-translate').disabled, false)
  assert.equal(reader.control('web-cancel').disabled, true)
})

test('显示模式切换只调用展示接口，不重新提取或请求翻译', async () => {
  const reader = await setup()
  reader.publish({ url: 'https://example.com', pageRevision: 1 })
  reader.control('web-translate').dispatch('click')
  await settle()
  reader.publish({ translationDone: 1 })
  reader.calls.length = 0
  for (const mode of ['source', 'bilingual', 'target']) {
    reader.control('web-mode').value = mode
    reader.control('web-mode').dispatch('change')
    await settle()
  }
  assert.deepEqual(reader.calls.map(call => [call.name, ...call.args]), [
    ['webTranslateSetMode', 'source'], ['webTranslateSetMode', 'bilingual'], ['webTranslateSetMode', 'target']
  ])
})

test('同地址刷新使旧快照失效，下一次语言变更必须重新提取', async () => {
  const reader = await setup()
  reader.publish({ url: 'https://example.com', pageRevision: 1 })
  reader.control('web-target-lang').dispatch('change')
  await settle()
  reader.publish({ pageRevision: 2, loading: true, translationWindowActive: false })
  reader.publish({ loading: false })
  reader.control('web-target-lang').value = 'EN'
  reader.control('web-target-lang').dispatch('change')
  await settle()
  assert.equal(reader.requests('webTranslateExtract').length, 2)
})

test('同地址刷新后迟到的提取结果不能启动旧翻译', async () => {
  const extraction = deferred()
  const reader = await setup({ webTranslateExtract: () => extraction.promise })
  reader.publish({ url: 'https://example.com', pageRevision: 1 })
  reader.control('web-target-lang').dispatch('change')
  reader.publish({ pageRevision: 2, loading: true, translationWindowActive: false })
  extraction.resolve({ pageRevision: 1 })
  await settle()
  assert.equal(reader.requests('webTranslateRun').length, 0)
  assert.equal(reader.control('web-cancel').disabled, true)
})

test('正常提取发布新代次不会被误认为同地址刷新而取消翻译', async () => {
  const extraction = deferred()
  const reader = await setup({ webTranslateExtract: () => extraction.promise })
  reader.publish({ url: 'https://example.com', pageRevision: 1 })
  reader.control('web-target-lang').dispatch('change')
  reader.publish({ pageRevision: 2, translationWindowActive: true })
  extraction.resolve({ pageRevision: 2 })
  await settle()
  assert.equal(reader.requests('webTranslateRun').length, 1)
})

test('快速切换语言取消旧任务，旧结果和错误不覆盖最新任务状态', async () => {
  const first = deferred(), second = deferred()
  let count = 0
  const reader = await setup({ webTranslateRun: () => ++count === 1 ? first.promise : second.promise })
  reader.publish({ url: 'https://example.com', pageRevision: 1 })
  reader.control('web-source-lang').dispatch('change')
  await settle()
  reader.control('web-target-lang').value = 'JA'
  reader.control('web-target-lang').dispatch('change')
  await settle()
  first.reject(new Error('旧任务错误'))
  await settle()
  assert.equal(reader.control('web-translate').disabled, true)
  assert.equal(reader.control('web-cancel').disabled, false)
  assert.notEqual(reader.control('web-status').textContent, '旧任务错误')
  second.resolve(reader.result)
  await settle()
  assert.equal(reader.control('web-translate').disabled, false)
})

test('取消后迟到结果不改写状态；导航和导出仍由原控件触发', async () => {
  const pending = deferred()
  const reader = await setup({ webTranslateRun: () => pending.promise })
  reader.publish({ url: 'https://example.com', pageRevision: 1, canGoBack: true, canGoForward: true })
  reader.control('web-translate').dispatch('click')
  await settle()
  reader.control('web-cancel').dispatch('click')
  pending.resolve(reader.result)
  await settle()
  assert.equal(reader.control('web-status').textContent, 'webReader.cancelled')
  assert.equal(reader.control('web-cancel').disabled, true)
  assert.equal(reader.control('web-translate').disabled, false)
  reader.publish({ translationDone: 1 })
  assert.equal(reader.control('web-export-pdf').disabled, false)
  reader.control('web-export-pdf').dispatch('click')
  await settle()
  assert.equal(reader.requests('exportWebPagePdf').length, 1)
  assert.equal(reader.control('web-status').textContent, 'webReader.pdfExported')
  for (const id of ['web-back', 'web-forward', 'web-reload']) reader.control(id).dispatch('click')
  reader.control('web-address').value = 'https://example.org'
  reader.control('web-address-form').dispatch('submit')
  await settle()
  assert.equal(reader.requests('webViewBack').length, 1)
  assert.equal(reader.requests('webViewForward').length, 1)
  assert.equal(reader.requests('webViewReload').length, 1)
  assert.deepEqual(reader.requests('navigateWebReader')[0].args, ['https://example.org'])
})
