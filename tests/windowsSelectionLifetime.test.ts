import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import type * as TypeScript from 'typescript'
import { EventEmitter } from 'node:events'
import { NativeReaderHost } from '../src/main/nativeReaderHost.ts'
import { SelectionCaptureCoordinator } from '../src/shared/selectionCaptureCoordinator.ts'

const ts = createRequire(`${process.cwd()}/package.json`)('typescript') as typeof TypeScript
const source = readFileSync('src/main/capture.ts', 'utf8')

/**
 * 执行实际取词函数源码，以依赖桩替代 Electron 和 Windows 系统 API。
 * @param name 待执行函数名。
 * @param dependencies 需要注入的外部依赖。
 * @returns 可执行的原函数。
 * @author zhenghq
 */
function loadFunction(name: string, dependencies: Record<string, unknown>): (...args: any[]) => Promise<any> {
  const ast = ts.createSourceFile('capture.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  assert.ok(declaration, `缺少 ${name}`)
  const text = declaration.getText(ast).replace(/^export\s+/u, '')
  const javascript = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  return new Function(...Object.keys(dependencies), `${javascript}\nreturn ${name}`)(...Object.values(dependencies))
}

/**
 * 校验热键和后台预取实际向宿主传递取消信号及短预算。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows helper 直读必须实际传递 300ms 预算和取消信号', async () => {
  const signal = new AbortController().signal
  let args: unknown[] = []
  const read = loadFunction('readSelectionViaWindowsHelper', {
    getWindowsReaderHost: () => ({ readSelection: async (...input: unknown[]) => {
      args = input
      return { status: 'present', text: 'selected' }
    } }),
    convertHelperResult: (result: unknown) => result,
    NATIVE_DIRECT_READ_TIMEOUT_MS: 300,
    console: { log: () => {}, warn: () => {} }
  })
  assert.equal((await read(signal)).text, 'selected')
  assert.deepEqual(args, [signal, 300])
})

/**
 * 校验 UIA 超时不得紧接着再次用 PowerShell 调用同一阻塞 API。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows helper 超时应返回 unknown 直接复制，不触发重复 UIA 脚本', async () => {
  const logs: string[] = []
  const read = loadFunction('readSelectionViaWindowsHelper', {
    getWindowsReaderHost: () => ({ readSelection: async () => { throw new Error('request timeout') } }),
    convertHelperResult: (result: unknown) => result,
    NATIVE_DIRECT_READ_TIMEOUT_MS: 300,
    console: { log: (line: string) => logs.push(line), warn: (line: string) => logs.push(line) }
  })
  assert.deepEqual(await read(), { status: 'unknown', text: '', reason: 'helper-timeout' })
  assert.ok(logs.some((line) => line.includes('helper-timeout')), '需要固定失败分类而非吞掉异常')
})

/**
 * 校验未安装或会话禁用的 helper 仍允许兼容脚本降级。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows helper 未安装或禁用应保留脚本兼容降级', async () => {
  for (const host of [null, { readSelection: async () => ({ status: 'unknown', reason: 'helper-disabled' }) }]) {
    const read = loadFunction('readSelectionViaWindowsHelper', {
      getWindowsReaderHost: () => host,
      convertHelperResult: (result: unknown) => result,
      NATIVE_DIRECT_READ_TIMEOUT_MS: 300,
      console: { log: () => {}, warn: () => {} }
    })
    assert.equal(await read(), null)
  }
})

/**
 * 校验 helper 原生直读不能调用复制或剪贴板 API，即使目标没有 TextPattern。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows UIA helper 必须是纯只读，不能在预取阶段清空或恢复剪贴板', () => {
  const helper = readFileSync('helpers/windows-uia-reader/Program.cs', 'utf8')
  assert.doesNotMatch(helper, /Clipboard\.(?:Clear|GetText|SetText|ContainsText)|TryWmCopy\(focusedElement\)/u)
  assert.match(helper, /GetSelection\(\)/u)
  assert.match(helper, /"no-text-pattern"/u)
})

/**
 * 校验复制中间层不再重复依赖可能挂起的 UIA，且使用真实 Win32 焦点控件。
 * @returns 无返回值。
 * @author zhenghq
 */
test('WM_COPY 必须用 Win32 读取前台线程焦点，不得调用 UI Automation', async () => {
  let script = ''
  const run = loadFunction('tryWmCopyPoll', {
    process: { platform: 'win32' },
    execFileP: async (_file: string, args: string[]) => { script = args[args.length - 1] },
    WM_COPY_SCRIPT_TIMEOUT_MS: 2000,
    clipboard: { readText: () => 'selected' },
    sleep: async () => {},
    console: { log: () => {}, warn: () => {} }
  })
  assert.equal(await run(undefined, 500, 'sentinel'), 'selected')
  assert.doesNotMatch(script, /UIAutomationClient|AutomationElement/u)
  assert.match(script, /GetGUIThreadInfo/u)
  assert.match(script, /GetWindowThreadProcessId/u)
  assert.match(script, /hwndFocus/u)
  assert.match(script, /\[User32\.User32\]::SendMessageTimeout/u)
  assert.match(script, /-MemberDefinition\s+'\[DllImport\("user32\.dll"/u,
    '必须以 PowerShell 单引号包裹 C# 定义，不能用反斜杠转义嵌套双引号')
  assert.match(script, /\$ErrorActionPreference\s*=\s*['"]Stop['"]/u)
})

/**
 * 校验中止后的 WM_COPY 不能继续启动脚本发送过期复制。
 * @returns 无返回值。
 * @author zhenghq
 */
test('已中止的 WM_COPY 不得启动 PowerShell', async () => {
  let calls = 0
  const run = loadFunction('tryWmCopyPoll', {
    process: { platform: 'win32' },
    execFileP: async () => { calls++ },
    WM_COPY_SCRIPT_TIMEOUT_MS: 2000,
    clipboard: { readText: () => '' },
    sleep: async () => {},
    console: { log: () => {}, warn: () => {} }
  })
  const controller = new AbortController()
  controller.abort()
  assert.equal(await run(controller.signal, 500, 'sentinel'), null)
  assert.equal(calls, 0)
})

/**
 * 用实际协调器与宿主反复模拟后台 UIA 阻塞、立即点译、旧进程迟到退出。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续 30 轮取消阻塞 UIA 后按钮复制不得被旧进程退出拖慢', async () => {
  const children: (EventEmitter & { stdout: EventEmitter; stdin: { write: (line: string) => void }; kill: () => void })[] = []
  let started: (() => void) | undefined
  let copied = 0
  const host = new NativeReaderHost({
    requestTimeoutMs: 200,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stdin: { write: () => { started?.() } },
        kill: () => { queueMicrotask(() => child.emit('exit', 0)) }
      })
      children.push(child)
      return child as never
    }
  })
  const coordinator = new SelectionCaptureCoordinator(
    async () => '',
    async (signal) => {
      try { return (await host.readSelection(signal)).text ?? '' } catch { return '' }
    },
    async (signal) => {
      assert.equal(signal.aborted, false)
      copied++
      return `copy-${copied}`
    }
  )
  try {
    for (let round = 1; round <= 30; round++) {
      const ready = new Promise<void>((resolve) => { started = resolve })
      const preparation = coordinator.prepare()
      await ready
      const captured = await Promise.race([
        coordinator.captureFromButton(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))
      ])
      assert.equal(captured?.text, `copy-${round}`, '取消预取不能继续占用串行取词队列')
      assert.equal(await preparation, null, '过期预取必须丢弃')
    }
    assert.equal(children.length, 30, '每轮只需重启一次，旧 exit 不得禁用新 helper')
  } finally {
    coordinator.invalidate()
    host.dispose()
  }
})
