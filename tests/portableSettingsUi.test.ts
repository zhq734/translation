import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createContext, runInContext, runInNewContext } from 'node:vm'
import type { Api } from '../src/shared/types.ts'
import type { PortableRuntimeInfo } from '../src/shared/portable.ts'
import { tForTest } from './helpers/i18n.ts'

const require = createRequire(`${process.cwd()}/package.json`)
const ts: typeof import('typescript') = require('typescript')
const ui = readFileSync('src/renderer/src/settings.ts', 'utf8')
const parsedUi = ts.createSourceFile('settings.ts', ui, ts.ScriptTarget.Latest, true)

/** 读取真实设置函数的 AST，参数为函数名称，返回函数声明，避免按花括号截断代码。@author zhenghq */
function uiFunction(name: string) {
  const declaration = parsedUi.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(declaration && ts.isFunctionDeclaration(declaration) && declaration.body)
  return declaration
}

/** 编译待隔离执行的源码；参数为 TypeScript 源码，返回 JavaScript。@author zhenghq */
function compile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

/** 创建可手动完成的请求；无参数，返回 Promise 及成功、失败控制器。@author zhenghq */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

/** 在真实初始化和设置广播路径中复现请求交错；无参数，返回控件、请求及保存记录。@author zhenghq */
function initializationRaceFixture() {
  const portable = deferred<PortableRuntimeInfo>()
  const ocr = deferred<object>()
  const patches: unknown[] = []
  const autoLaunch = { checked: false, disabled: true }
  const portableNotice = { hidden: true }
  const portableDataDirectory = { textContent: '' }
  let broadcast!: (settings: { autoLaunch: boolean; shortcutGuideSeen: boolean }) => void
  const context = createContext({
    autoLaunch, portableNotice, portableDataDirectory,
    latestSettings: null, latestUpdateStatus: null,
    populateLanguageSelects: () => undefined,
    window: { api: {
      getSettings: async () => ({ autoLaunch: true, shortcutGuideSeen: true }),
      getShortcutRegistrationStates: async () => [], getOcrStatus: () => ocr.promise,
      getDockerCommand: async () => 'docker', getUpdateStatus: async () => ({}),
      getPortableInfo: () => portable.promise,
      onSettingsChanged: (callback: typeof broadcast) => { broadcast = callback }
    } },
    save: (patch: unknown) => { patches.push(patch) },
    renderShortcutRegistrationStates: () => undefined, renderOcrStatus: () => undefined,
    renderUpdateStatus: () => undefined, dockerCmd: { value: '' }
  })
  const declaration = parsedUi.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((entry) => entry.name.getText(parsedUi) === 'portableInfo'))
  const registration = parsedUi.statements.find((node) => ts.isExpressionStatement(node)
    && node.getText(parsedUi).startsWith('window.api.onSettingsChanged(')
    && node.getText(parsedUi).includes('renderSettings(settings)'))
  assert.ok(declaration)
  assert.ok(registration)
  const render = uiFunction('renderSettings').body!.statements.filter((statement) =>
    /^(?:latestSettings =|autoLaunch\.|renderPortableInfo\()/u.test(statement.getText(parsedUi)))
  runInContext(compile([
    declaration.getText(parsedUi),
    uiFunction('renderPortableInfo').getText(parsedUi),
    `function renderSettings(settings) { ${render.map((node) => node.getText(parsedUi)).join('\n')} }`,
    uiFunction('initialize').getText(parsedUi), uiFunction('saveAutoLaunch').getText(parsedUi),
    registration.getText(parsedUi)
  ].join('\n')), context)
  const pending: Promise<void> = runInContext('initialize()', context)
  return {
    portable, ocr, patches, autoLaunch, portableNotice, portableDataDirectory, pending,
    broadcast: () => broadcast({ autoLaunch: true, shortcutGuideSeen: true }),
    save: () => runInContext('saveAutoLaunch()', context)
  }
}

test('便携状态未知时设置广播不得启用自启动或允许保存', async () => {
  const f = initializationRaceFixture()
  try {
    f.broadcast()
    assert.equal(f.autoLaunch.disabled, true)
    assert.equal(f.autoLaunch.checked, false)
    f.autoLaunch.checked = true
    f.save()
    assert.deepEqual(f.patches, [])
  } finally {
    f.portable.resolve({ enabled: true, dataDirectory: 'D:\\app\\data' })
    f.ocr.resolve({})
    await f.pending
  }
})

test('便携状态就绪不等待 OCR，初始化完成前的设置广播仍保留禁用与目录提示', async () => {
  const f = initializationRaceFixture()
  try {
    f.portable.resolve({ enabled: true, dataDirectory: 'D:\\app\\data' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(f.portableNotice.hidden, false)
    assert.equal(f.portableDataDirectory.textContent, 'D:\\app\\data')
    f.broadcast()
    assert.equal(f.autoLaunch.disabled, true)
    assert.equal(f.autoLaunch.checked, false)
    assert.equal(f.portableNotice.hidden, false)
    assert.equal(f.portableDataDirectory.textContent, 'D:\\app\\data')
    f.autoLaunch.checked = true
    f.save()
    assert.deepEqual(f.patches, [])
  } finally {
    f.ocr.resolve({})
    await f.pending
  }
})

test('确认安装模式后即使 OCR 未完成也恢复广播设置和自启动保存', async () => {
  const f = initializationRaceFixture()
  try {
    f.broadcast()
    f.portable.resolve({ enabled: false, dataDirectory: null })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(f.autoLaunch.disabled, false)
    assert.equal(f.autoLaunch.checked, true)
    assert.equal(f.portableNotice.hidden, true)
    f.broadcast()
    f.save()
    assert.deepEqual(JSON.parse(JSON.stringify(f.patches)), [{ autoLaunch: true }])
  } finally {
    f.portable.resolve({ enabled: false, dataDirectory: null })
    f.ocr.resolve({})
    await f.pending
  }
})

test('便携 IPC 失败后设置广播仍按未知状态禁用自启动', async () => {
  const f = initializationRaceFixture()
  const rejected = assert.rejects(f.pending, /IPC unavailable/u)
  f.portable.reject(new Error('IPC unavailable'))
  await rejected
  f.broadcast()
  assert.equal(f.autoLaunch.disabled, true)
  assert.equal(f.autoLaunch.checked, false)
  f.autoLaunch.checked = true
  f.save()
  assert.deepEqual(f.patches, [])
  f.ocr.resolve({})
})

test('设置便携状态通过只读 IPC 暴露且自启动界面和保存处理均受保护', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  const types = readFileSync('src/shared/types.ts', 'utf8')
  assert.match(preload, /getPortableInfo: \(\) => ipcRenderer.invoke\('app:get-portable-info'\)/u)
  assert.match(types, /getPortableInfo\(\): Promise<PortableRuntimeInfo>/u)
  assert.match(ui, /window.api.getPortableInfo\(\)/u)
  assert.match(ui, /autoLaunch.disabled = portableInfo\?\.enabled !== false/u)
  assert.match(ui, /function saveAutoLaunch\(\): void \{\s*if \(portableInfo\?\.enabled !== false\) return/u)
  assert.match(ui, /portableDataDirectory.textContent/u)
  assert.match(ui, /portableNotice.hidden = !portableInfo\?\.enabled/u)
})

test('真实 preload 方法通过约定 IPC 返回便携结构，不传额外数据', async () => {
  const source = readFileSync('src/preload/index.ts', 'utf8')
  const parsed = ts.createSourceFile('preload.ts', source, ts.ScriptTarget.Latest, true)
  let method: import('typescript').PropertyAssignment | undefined
  /** 定位 API 属性；参数为 AST 节点，返回空值并保存目标属性。@author zhenghq */
  function visit(node: import('typescript').Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === 'getPortableInfo') method = node
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(method)
  const expected: PortableRuntimeInfo = { enabled: true, dataDirectory: 'D:\\翻译工具\\data' }
  const calls: unknown[][] = []
  const api: Pick<Api, 'getPortableInfo'> = runInNewContext(compile(`({ ${method.getText(parsed)} })`), {
    ipcRenderer: { invoke: async (...args: unknown[]) => { calls.push(args); return expected } }
  })
  assert.equal(await api.getPortableInfo(), expected)
  assert.deepEqual(calls, [['app:get-portable-info']])
})

test('主进程已注册约定只读通道并返回完整便携状态', async () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
  const registration = parsed.statements.find((node) => ts.isExpressionStatement(node)
    && node.getText(parsed).startsWith("ipcMain.handle('app:get-portable-info'"))
  assert.ok(registration)
  const expected: PortableRuntimeInfo = { enabled: true, dataDirectory: 'D:\\便携\\data' }
  let handler: (() => PortableRuntimeInfo) | undefined
  runInNewContext(compile(registration.getText(parsed)), {
    portableRuntimeInfo: expected,
    ipcMain: { handle: (channel: string, callback: () => PortableRuntimeInfo) => {
      assert.equal(channel, 'app:get-portable-info')
      handler = callback
    } }
  })
  assert.ok(handler)
  assert.equal(await handler(), expected)
})

for (const enabled of [true, false]) {
  for (const preference of [true, false]) {
    test(`便携=${enabled}、原自启动=${preference} 时只限制便携版，安装版继续按用户设置保存`, () => {
      const statements = uiFunction('renderSettings').body!.statements.filter((statement) =>
        /^(?:latestSettings =|autoLaunch\.|renderPortableInfo\()/u.test(statement.getText(parsedUi)))
      assert.equal(statements.length, 3)
      const autoLaunch = { checked: !preference, disabled: true }
      const portableNotice = { hidden: false }
      const portableDataDirectory = { textContent: '旧路径' }
      const dataDirectory = enabled ? 'D:\\<便携目录>\\data' : null
      const patches: unknown[] = []
      const context = {
        settings: { autoLaunch: preference }, portableInfo: { enabled, dataDirectory },
        latestSettings: null,
        autoLaunch, portableNotice, portableDataDirectory,
        save: (patch: unknown) => { patches.push(patch) }
      }
      runInNewContext(compile([
        uiFunction('renderPortableInfo').getText(parsedUi),
        ...statements.map((statement) => statement.getText(parsedUi))
      ].join('\n')), context)
      assert.equal(autoLaunch.disabled, enabled)
      assert.equal(autoLaunch.checked, enabled ? false : preference)
      assert.equal(portableNotice.hidden, !enabled)
      assert.equal(portableDataDirectory.textContent, dataDirectory ?? '')
      assert.equal(context.settings.autoLaunch, preference)
      autoLaunch.checked = true
      runInNewContext(compile(`${uiFunction('saveAutoLaunch').getText(parsedUi)}\nsaveAutoLaunch()`), context)
      assert.deepEqual(JSON.parse(JSON.stringify(patches)), enabled ? [] : [{ autoLaunch: true }])
    })
  }
}

test('初始化等待只读便携信息后再渲染，防止设置加载时短暂启用自启动', async () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  assert.match(html, /<input\b[^>]*id="auto-launch"[^>]*\bdisabled\b/u)
  let resolveInfo!: (value: PortableRuntimeInfo) => void
  let reads = 0
  const rendered: unknown[] = []
  const expected: PortableRuntimeInfo = { enabled: true, dataDirectory: 'D:\\app\\data' }
  const context = {
    portableInfo: null as PortableRuntimeInfo | null,
    latestSettings: null,
    autoLaunch: { checked: false, disabled: true }, portableNotice: { hidden: true },
    portableDataDirectory: { textContent: '' },
    populateLanguageSelects: () => undefined,
    window: { api: {
      getSettings: async () => ({ autoLaunch: true, shortcutGuideSeen: true }),
      getShortcutRegistrationStates: async () => [], getOcrStatus: async () => ({}),
      getDockerCommand: async () => 'docker', getUpdateStatus: async () => ({}),
      getPortableInfo: () => { reads += 1; return new Promise<PortableRuntimeInfo>((resolve) => { resolveInfo = resolve }) }
    } },
    renderSettings: (settings: unknown) => { rendered.push(settings); assert.equal(context.portableInfo, expected) },
    renderShortcutRegistrationStates: () => undefined, renderOcrStatus: () => undefined,
    renderUpdateStatus: () => undefined, dockerCmd: { value: '' }
  }
  const pending = runInNewContext(compile([
    uiFunction('renderPortableInfo').getText(parsedUi),
    uiFunction('initialize').getText(parsedUi), 'initialize()'
  ].join('\n')), context)
  await Promise.resolve()
  assert.equal(reads, 1)
  assert.equal(rendered.length, 0)
  resolveInfo(expected)
  await pending
  assert.equal(rendered.length, 1)
})

test('便携提示提供双语说明，标记默认隐藏、沿用主题且数据目录自动换行', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  assert.match(html, /id="portable-notice"[^>]*hidden/u)
  assert.match(html, /id="portable-data-directory"[^>]*overflow-wrap:\s*anywhere/u)
  const notice = html.match(/<div id="portable-notice"[\s\S]*?<\/div>/u)?.[0]
  assert.ok(notice)
  assert.doesNotMatch(notice, /#[\da-f]{3,8}\b|rgba?\(|background(?:-color)?\s*:/iu)
  assert.match(notice, /class="field-hint"/u)
  for (const locale of ['en-US', 'zh-CN'] as const) {
    for (const key of [
      'settings.portable.title', 'settings.portable.restrictions', 'settings.portable.dataDirectory',
      'portable.update.invalid', 'portable.update.http', 'portable.update.missingAsset', 'portable.update.manualOnly'
    ]) {
      assert.notEqual(tForTest(locale, key), key)
    }
    assert.match(tForTest(locale, 'portable.update.http', { status: 403 }), /HTTP 403/u)
    assert.match(tForTest(locale, 'portable.update.missingAsset', { asset: 'target.zip' }), /target\.zip/u)
  }
  assert.match(tForTest('zh-CN', 'settings.portable.restrictions'), /禁用.*自启动.*换电脑.*重新填写.*退出.*ZIP.*data.*备份/u)
  assert.match(tForTest('en-US', 'settings.portable.restrictions'), /Launch at login is disabled.*keys.*another computer.*quit.*ZIP.*data.*backup/u)
  const factory = readFileSync('src/main/portableUpdater.ts', 'utf8')
  assert.match(factory, /installMode: 'manual'/u)
  assert.doesNotMatch(factory, /from ['"]electron-updater/u)
})
