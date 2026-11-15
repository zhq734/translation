import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import test from 'node:test'
import * as manualBehavior from '../src/shared/manualTranslationBehavior'
import * as progressiveReveal from '../src/shared/progressiveReveal'

const require = createRequire(`${process.cwd()}/package.json`)
const ts = require('typescript') as typeof import('typescript')
const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')

/** 创建可控异步关卡；无参数，返回 Promise 与完成/失败入口。@author zhenghq */
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** 清空测试中的异步任务；无参数，返回等待微任务完成的 Promise。@author zhenghq */
async function flush() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve()
}

/** 创建简化下拉控件；参数为初始值，返回真实事件注册/派发容器。@author zhenghq */
function control(value = '') {
  const listeners = new Map<string, () => void>()
  return {
    value, disabled: false,
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    dispatch: (name: string) => { assert.ok(listeners.has(name)); listeners.get(name)!() }
  }
}

/** 执行真实弹窗提交、切换、广播及结果处理代码；参数为来源和原文，返回可控 IPC 测试环境。@author zhenghq */
function harness(origin: 'manual' | 'selection' | 'ocr' = 'manual', text = 'hello') {
  const requests: Array<{ origin: string; text: string; sourceLang: string; targetLang: string; provider: string; id: number; gate: ReturnType<typeof deferred> }> = []
  const saves: Array<{ patch: Record<string, string>; gate: ReturnType<typeof deferred> }> = []
  const protections: Array<[boolean, string]> = []
  const selectionResults: any[] = []
  const copies: string[] = []
  let resultHandler!: (payload: any) => void
  let settings = { sourceLang: 'auto', targetLang: 'en', preferredTranslationProvider: 'auto', speechProvider: 'system' }
  let nextId = 100
  let holdSaves = false
  let broadcastBeforeReply = true
  const sourceLangEl = control('auto')
  const targetLangEl = control('en')
  const translationProviderEl = control('auto')
  const manualSourceEl = control(text)
  const context = createContext({
    ...manualBehavior, ...progressiveReveal,
    mode: origin === 'manual' ? 'manual' : 'selection',
    currentSelectionOrigin: origin === 'manual' ? 'selection' : origin,
    currentSettings: { ...settings },
    manualState: { ...manualBehavior.createManualTranslationState(), draft: text },
    manualReveal: progressiveReveal.createProgressiveRevealState(),
    selectionReveal: progressiveReveal.createProgressiveRevealState(),
    manualSpeechLanguage: '', selectionSpeechLanguage: '',
    manualProvider: undefined, manualSourceLangCode: null, manualTargetLangCode: '', manualStatus: '',
    lastOriginal: origin === 'selection' ? text : '', lastOcrText: origin === 'ocr' ? text : '',
    lastTranslation: '', latestSelectionRequestId: 0, selectionRevealRequestId: 0,
    revealTarget: null, revealSequence: 0,
    sourceLangEl, targetLangEl, translationProviderEl, manualSourceEl,
    localeRuntime: { locale: 'zh-CN', translator: { t: (key: string) => key } },
    t: (key: string) => key, langLabel: (code: string) => code,
    translationProviderLabel: (code: string) => code,
    renderManualState: () => {}, renderMode: () => {}, stopSpeech: () => {},
    stopProgressiveReveal: () => {}, renderTranslationProviderResult: () => {},
    syncSpeechButton: () => {}, requestAutoResize: () => {},
    flashStatus: () => {}, scheduleStreamingReveal: () => {},
    statusEl: { textContent: '' }, copyBtn: { hidden: false },
    resultEl: { classList: { remove: () => {} } },
    renderSelection: (payload: any) => { selectionResults.push(payload); context.latestSelectionRequestId = payload.requestId },
    renderTranslationProviderOptions: (value: typeof settings) => { translationProviderEl.value = value.preferredTranslationProvider },
    window: { api: {
      setSettings: async (patch: Record<string, string>) => {
        const gate = deferred()
        saves.push({ patch, gate })
        if (holdSaves) await gate.promise
        settings = { ...settings, ...patch }
        if (broadcastBeforeReply) context.syncSettings({ ...settings })
        return { ...settings }
      },
      translateManual: (request: any) => start('manual', request.text, request.sourceLang, request.targetLang),
      retranslate: (source: string, target: string, from: string) => {
        settings = { ...settings, sourceLang: source, targetLang: target }
        if (broadcastBeforeReply) context.syncSettings({ ...settings })
        return start(from, from === 'ocr' ? context.lastOcrText : context.lastOriginal, source, target)
      },
      setPopupLanguageInteraction: (active: boolean, scope: string) => protections.push([active, scope]),
      onResult: (callback: typeof resultHandler) => { resultHandler = callback },
      copy: (text: string) => copies.push(text)
    } }
  })
  /** 记录翻译调用并模拟主进程加载通知；参数为来源、原文和语言，返回可控请求 Promise。@author zhenghq */
  function start(from: string, value: string, source: string, target: string) {
    const request = { origin: from, text: value, sourceLang: source, targetLang: target, provider: settings.preferredTranslationProvider, id: ++nextId, gate: deferred() }
    requests.push(request)
    resultHandler({ origin: from, original: value, loading: true, ok: true, requestId: request.id, sourcePreference: source, targetPreference: target })
    return request.gate.promise
  }
  const ast = ts.createSourceFile('popup.ts', renderer, ts.ScriptTarget.Latest, true)
  const hiddenIndex = renderer.indexOf('function handlePopupHidden()')
  const startIndex = renderer.indexOf('\n}', hiddenIndex) + 2
  const endIndex = renderer.indexOf('/**\n * 界面语言切换后')
  assert.ok(startIndex >= 0 && endIndex > startIndex)
  const extra = ast.statements.filter((statement) => {
    if (ts.isFunctionDeclaration(statement)) return ['handleTranslateDelta', 'copyTranslation'].includes(statement.name?.text ?? '')
    const text = statement.getText(ast)
    return text.startsWith('window.api.onResult(')
      || /^(sourceLangEl|targetLangEl|translationProviderEl|manualSourceEl)\.addEventListener\('(change|input|pointerdown|focusin|focusout)'/u.test(text)
  }).map((statement) => statement.getText(ast)).join('\n')
  const code = ts.transpileModule(renderer.slice(startIndex, endIndex) + '\n' + extra, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  runInContext(code, context)
  return {
    context, requests, saves, protections, selectionResults, copies,
    sourceLangEl, targetLangEl, translationProviderEl, manualSourceEl,
    result: (payload: any) => resultHandler(payload),
    broadcast: (patch = {}) => { settings = { ...settings, ...patch }; context.syncSettings({ ...settings }) },
    holdSaves: () => { holdSaves = true },
    lateBroadcast: () => { broadcastBeforeReply = false },
    finish: (index: number, translation = '译文') => {
      const request = requests[index]
      assert.ok(request, `缺少第 ${index + 1} 次翻译`)
      resultHandler({ origin: request.origin, original: request.text, ok: true, requestId: request.id, translation, targetLang: request.targetLang, progressive: false })
      request.gate.resolve()
    }
  }
}

/** 验证有效草稿的三种设置切换；无参数、无返回值。@author zhenghq */
for (const [selector, value] of [['sourceLangEl', 'ja'], ['targetLangEl', 'zh-CN'], ['translationProviderEl', 'google']] as const) {
  test(`手动 ${selector} 切换自动翻译未提交的有效草稿`, async () => {
    const h = harness()
    h[selector].value = value
    h[selector].dispatch('change')
    await flush()
    assert.equal(h.requests.length, 1)
    assert.equal(h.requests[0].text, 'hello')
    assert.equal(h.requests[0][selector === 'sourceLangEl' ? 'sourceLang' : selector === 'targetLangEl' ? 'targetLang' : 'provider'], value)
    h.finish(0)
    await flush()
    assert.equal(h.context.manualState.stale, false)
    assert.equal(h.context.manualState.loading, false)
    assert.equal(h.context.manualState.draft, 'hello')
  })
}

/** 验证空白及单纯输入不会触发请求；无参数、无返回值。@author zhenghq */
test('空白切换不请求；逐字输入只更新草稿', async () => {
  const h = harness('manual', ' \n ')
  for (const selector of [h.sourceLangEl, h.targetLangEl, h.translationProviderEl]) {
    selector.dispatch('change')
    await flush()
  }
  h.manualSourceEl.value = '只编辑不提交'
  h.manualSourceEl.dispatch('input')
  await flush()
  assert.equal(h.requests.length, 0)
  assert.equal(h.context.manualState.draft, '只编辑不提交')
  assert.equal(h.context.manualState.error, '')
})

/** 验证加载期间合并切换及过期片段隔离；无参数、无返回值。@author zhenghq */
test('手动加载中连续切换语言/API，旧成功/失败/增量无效且最终采用最新设置', async () => {
  const h = harness()
  void h.context.submitManualTranslation()
  h.targetLangEl.value = 'ja'
  h.targetLangEl.dispatch('change')
  h.translationProviderEl.value = 'google'
  h.translationProviderEl.dispatch('change')
  h.sourceLangEl.value = 'en'
  h.targetLangEl.value = 'de'
  h.targetLangEl.dispatch('change')
  await flush()
  h.context.handleTranslateDelta({ origin: 'manual', requestId: h.requests[0].id, delta: '旧增量' })
  assert.equal(h.context.manualReveal.fullText, '')
  h.finish(0, '旧译文')
  await flush()
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].sourceLang, 'en')
  assert.equal(h.requests[1].targetLang, 'de')
  assert.equal(h.requests[1].provider, 'google')
  assert.notEqual(h.context.manualState.translation, '旧译文')
  h.result({ origin: 'manual', original: 'hello', requestId: h.requests[0].id, ok: false, error: '迟到错误' })
  assert.equal(h.context.manualState.error, '')
  h.context.handleTranslateDelta({ origin: 'manual', requestId: h.requests[1].id, delta: '新增量' })
  assert.equal(h.context.manualReveal.fullText, '新增量')
  h.finish(1, '最新译文')
  await flush()
  h.context.copyTranslation()
  assert.deepEqual(h.copies, ['最新译文'])
  assert.equal(h.context.manualSpeechLanguage, 'de')
  assert.equal(h.context.manualState.stale, false)
})

/** 验证保存设置广播的两种时序均不重复提交；无参数、无返回值。@author zhenghq */
for (const late of [false, true]) {
  test(`设置广播${late ? '晚于' : '早于'}保存响应不重复请求、不标记新结果过期`, async () => {
    const h = harness()
    if (late) h.lateBroadcast()
    h.translationProviderEl.value = 'google'
    h.translationProviderEl.dispatch('change')
    await flush()
    assert.equal(h.requests.length, 1)
    h.finish(0)
    await flush()
    h.broadcast()
    await flush()
    assert.equal(h.requests.length, 1)
    assert.equal(h.context.manualState.stale, false)
  })
}

/** 验证设置保存中继续切换且模式变化不会串用草稿；无参数、无返回值。@author zhenghq */
test('保存中切换模式不得把手动重译变成划词请求', async () => {
  const h = harness()
  h.holdSaves()
  h.translationProviderEl.value = 'google'
  h.translationProviderEl.dispatch('change')
  await flush()
  h.context.mode = 'selection'
  h.context.lastOriginal = '另外的划词'
  h.saves[0].gate.resolve()
  await flush()
  assert.equal(h.requests.some((request) => request.origin === 'selection'), false)
  assert.equal(h.context.manualState.draft, 'hello')
  if (h.requests.length) h.finish(0)
  await flush()
})

/** 验证划词/OCR 来源与下拉保护；无参数、无返回值。@author zhenghq */
for (const origin of ['selection', 'ocr'] as const) {
  test(`${origin} 切换 API 重译自身原文并保留 selector/retranslation 独立保护`, async () => {
    const h = harness(origin, '本来源原文')
    h.context.manualState.draft = '手动草稿保留'
    h.translationProviderEl.dispatch('pointerdown')
    h.translationProviderEl.value = 'google'
    h.translationProviderEl.dispatch('change')
    h.translationProviderEl.dispatch('focusout')
    await flush()
    assert.equal(h.requests.length, 1)
    assert.equal(h.requests[0].origin, origin)
    assert.equal(h.requests[0].text, '本来源原文')
    assert.equal(h.protections.filter(([active, scope]) => !active && scope === 'retranslation').length, 0)
    h.finish(0)
    await flush()
    assert.deepEqual(h.protections.at(-1), [false, 'retranslation'])
    assert.equal(h.context.manualState.draft, '手动草稿保留')
  })
}

/** 验证空白后仍能显式提交；无参数、无返回值。@author zhenghq */
test('空白草稿切换设置后，后续编辑仍可显式提交', async () => {
  const h = harness('manual', ' ')
  h.targetLangEl.value = 'ja'
  h.targetLangEl.dispatch('change')
  await flush()
  h.manualSourceEl.value = '新草稿'
  h.manualSourceEl.dispatch('input')
  void h.context.submitManualTranslation()
  await flush()
  assert.equal(h.requests.length, 1)
  h.finish(0)
  await flush()
})

/** 验证旧错误不会吞掉重译且广播真正变化时继续跟进；无参数、无返回值。@author zhenghq */
test('旧请求拒绝后继续最新重译，加载中外部新设置不能丢失', async () => {
  const h = harness()
  void h.context.submitManualTranslation()
  h.targetLangEl.value = 'ja'
  h.targetLangEl.dispatch('change')
  await flush()
  h.requests[0].gate.reject(new Error('旧请求失败'))
  await flush()
  assert.equal(h.requests.length, 2)
  h.broadcast({ targetLang: 'fr' })
  await flush()
  h.finish(1, '过期日文')
  await flush()
  assert.equal(h.requests.length, 3)
  assert.equal(h.requests[2].targetLang, 'fr')
  h.finish(2, '新法文')
  await flush()
})

/** 验证无有效原文不调用后台旧缓存；无参数、无返回值。@author zhenghq */
for (const origin of ['selection', 'ocr'] as const) {
  test(`${origin} 空白只保存设置，随后新来源请求仍可正常显示`, async () => {
    const h = harness(origin, ' \n ')
    h.targetLangEl.value = 'ja'
    h.targetLangEl.dispatch('change')
    await flush()
    assert.equal(h.requests.length, 0)
    assert.equal(h.saves.at(-1)?.patch.targetLang, 'ja')
    h.result({ origin, requestId: 200, loading: true, ok: true, original: '新原文' })
    assert.equal(h.selectionResults.length, 1)
  })
  test(`${origin} 加载中连续切换合并最新设置，忽略旧结果与增量`, async () => {
    const h = harness(origin)
    h.targetLangEl.value = 'ja'
    h.targetLangEl.dispatch('change')
    await flush()
    h.targetLangEl.value = 'de'
    h.targetLangEl.dispatch('change')
    h.translationProviderEl.value = 'google'
    h.translationProviderEl.dispatch('change')
    await flush()
    h.context.handleTranslateDelta({ origin, requestId: h.requests[0].id, delta: '旧增量' })
    assert.equal(h.context.selectionReveal.fullText, '')
    h.finish(0, '旧结果')
    await flush()
    assert.equal(h.requests.length, 2)
    assert.equal(h.requests[1].targetLang, 'de')
    assert.equal(h.requests[1].provider, 'google')
    h.result({ origin, requestId: h.requests[0].id, ok: true, translation: '迟到旧结果' })
    assert.equal(h.selectionResults.some((payload) => payload.translation === '旧结果' || payload.translation === '迟到旧结果'), false)
    h.finish(1, '新结果')
    await flush()
    assert.equal(h.selectionResults.at(-1)?.translation, '新结果')
  })
}

/** 验证更早请求在新请求加载通知之前到达也不会被误采纳；无参数、无返回值。@author zhenghq */
test('新请求尚未收到加载通知时，迟到旧错误仍不得污染最新请求', async () => {
  const h = harness()
  void h.context.submitManualTranslation()
  h.finish(0)
  await flush()
  const delayed = deferred()
  h.context.window.api.translateManual = () => delayed.promise
  h.targetLangEl.value = 'ja'
  h.targetLangEl.dispatch('change')
  await flush()
  h.result({ origin: 'manual', original: 'hello', requestId: h.requests[0].id, ok: false, error: '旧错误' })
  assert.equal(h.context.manualState.error, '')
  delayed.resolve()
  await flush()
})

/** 验证请求中编辑保持草稿但不会引发逐字重译；无参数、无返回值。@author zhenghq */
test('新设置翻译中编辑草稿，结果保持过期且复制/朗读无效，不自动提交编辑', async () => {
  const h = harness()
  h.targetLangEl.value = 'ja'
  h.targetLangEl.dispatch('change')
  await flush()
  h.manualSourceEl.value = '请求后编辑'
  h.manualSourceEl.dispatch('input')
  h.finish(0)
  await flush()
  assert.equal(h.requests.length, 1)
  assert.equal(h.context.manualState.draft, '请求后编辑')
  assert.equal(h.context.manualState.stale, true)
  h.context.copyTranslation()
  assert.equal(h.copies.length, 0)
})

/** 验证重译 IPC 保存语言的间隙不会复活旧划词结果；无参数、无返回值。@author zhenghq */
test('划词新请求加载通知之前到达的旧成功结果无效', async () => {
  const h = harness('selection')
  h.result({ origin: 'selection', requestId: 99, ok: true, translation: '已有译文' })
  const delayed = deferred()
  h.context.window.api.retranslate = () => delayed.promise
  h.targetLangEl.value = 'ja'
  h.targetLangEl.dispatch('change')
  await flush()
  h.result({ origin: 'selection', requestId: 99, ok: true, translation: '迟到旧结果' })
  assert.equal(h.selectionResults.some((payload) => payload.translation === '迟到旧结果'), false)
  delayed.resolve()
  await flush()
})

/** 验证同一设置两次广播均被识别为本地回声；无参数、无返回值。@author zhenghq */
test('划词设置保存与重译各自的迟到广播，不得回滚连续切换的最新选择', async () => {
  const h = harness('selection')
  h.lateBroadcast()
  h.targetLangEl.value = 'ja'
  h.targetLangEl.dispatch('change')
  await flush()
  h.targetLangEl.value = 'de'
  h.targetLangEl.dispatch('change')
  await flush()
  h.broadcast({ targetLang: 'ja' })
  h.broadcast({ targetLang: 'ja' })
  await flush()
  assert.equal(h.targetLangEl.value, 'de')
  h.finish(0)
  await flush()
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].targetLang, 'de')
  h.finish(1)
  await flush()
})

/** 验证设置写入失败不会锁死控件或后续提交；无参数、无返回值。@author zhenghq */
test('保存失败释放重译保护，后续切换可以重试且不丢草稿', async () => {
  const h = harness()
  h.holdSaves()
  h.targetLangEl.value = 'ja'
  h.targetLangEl.dispatch('change')
  await flush()
  h.saves[0].gate.reject(new Error('保存失败'))
  await flush()
  assert.equal(h.requests.length, 0)
  assert.deepEqual(h.protections.at(-1), [false, 'retranslation'])
  assert.equal(h.context.manualState.draft, 'hello')
  h.targetLangEl.value = 'de'
  h.targetLangEl.dispatch('change')
  await flush()
  h.saves[1].gate.resolve()
  await flush()
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].targetLang, 'de')
  h.finish(0)
  await flush()
})
