import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test, { beforeEach } from 'node:test'
import { setMainMessageTranslator, translateMain } from '../src/main/messages.ts'
import { createTranslator } from '../src/shared/i18n/index.ts'
import { initializePortableRuntime } from '../src/main/portableRuntime.ts'
import { buildLinuxAutostartEntry, buildLoginItemSettings, resolveAutoLaunchStrategy, resolveLinuxAutostartEntryPath } from '../src/main/autoLaunch.ts'
import type { PortableRuntimeInfo } from '../src/shared/portable.ts'

const ts = createRequire(`${process.cwd()}/package.json`)('typescript') as typeof import('typescript')
const main = readFileSync('src/main/index.ts', 'utf8')

/** 转译真实 TypeScript 代码供隔离执行；参数为源码，返回 CommonJS 代码。@author zhenghq */
function compile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

/**
 * 构造只替代 Electron 的启动环境，保留真实便携目录初始化。
 * @param t 测试上下文，用于回收目录。
 * @returns 启动上下文、调用事件和目录路径。
 * @author zhenghq
 */
function bootstrapFixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'portable-bootstrap-中文 空格-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'portable.json'), '{"version":1}')
  const events: string[] = []
  const paths: Record<string, string> = {}
  const electron = {
    app: {
      isPackaged: true,
      /** 记录 Electron 路径接管；参数为路径名和目录，无返回值。@author zhenghq */
      setPath(name: string, path: string) { paths[name] = path; events.push(`path:${name}`) },
      /** 记录退出请求但不终止测试进程；参数为退出码，无返回值。@author zhenghq */
      exit(code: number) { events.push(`exit:${code}`) }
    },
    dialog: {
      /** 记录启动失败提示；参数为标题和详情，无返回值。@author zhenghq */
      showErrorBox(title: string, message: string) {
        assert.match(title, /便携版启动失败/u)
        assert.match(message, /便携.*可写目录/u)
        events.push('dialog')
      }
    }
  }
  const context = {
    exports: {} as { portableRuntimeInfo?: PortableRuntimeInfo },
    process: { platform: 'win32', arch: 'x64', execPath: join(directory, '翻译.exe'), env: {} as Record<string, string | undefined> },
    /** 提供真实运行时和模拟 Electron；参数为模块名，返回受控依赖。@author zhenghq */
    require(id: string): unknown {
      if (id === './messages') return { translateMain }
      if (id === 'electron') return electron
      if (id === './portableRuntime') return { initializePortableRuntime }
      if (id === './platformCompatibility') return { isWindows7CompatibilityRuntime: () => false }
      throw new Error(`未批准的依赖：${id}`)
    }
  }
  return { directory, events, paths, context, electron }
}

test('便携 bootstrap 必须是主入口首个导入且初始化失败必须退出', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')
  assert.match(main, /^import \{ portableRuntimeInfo \} from '\.\/portableBootstrap'/u)
  const bootstrap = readFileSync('src/main/portableBootstrap.ts', 'utf8')
  assert.match(bootstrap, /initializePortableRuntime/u)
  assert.match(bootstrap, /showErrorBox/u)
  assert.match(bootstrap, /app\.exit\(1\)/u)
  assert.match(bootstrap, /throw error/u)
  assert.match(main, /ipcMain\.handle\('app:get-portable-info', \(\) => portableRuntimeInfo\)/u)
  assert.match(main, /portable: portableRuntimeInfo.enabled/u)
  assert.match(main, /else if \(portableRuntimeInfo.enabled\)/u)
  assert.match(main, /import\('\.\/portableUpdater'\)/u)
})

test('主入口实际导入必须先完成五个路径设置才加载业务依赖', (t) => {
  const f = bootstrapFixture(t)
  const stop = new Error('业务依赖边界')
  assert.throws(() => runInNewContext(compile(main), {
    exports: {},
    /** 执行首个 bootstrap 并在业务依赖边界停止；参数为模块名，返回模拟模块。@author zhenghq */
    require(id: string) {
      if (id === './portableBootstrap') {
        runInNewContext(compile(readFileSync('src/main/portableBootstrap.ts', 'utf8')), f.context)
        return f.context.exports
      }
      if (id === 'electron') return f.electron
      if (id.startsWith('node:')) return {}
      f.events.push('business-import')
      throw stop
    }
  }), (error) => error === stop)
  assert.deepEqual(f.events, ['path:userData', 'path:sessionData', 'path:logs', 'path:temp', 'path:crashDumps', 'business-import'])
  assert.deepEqual(f.context.exports.portableRuntimeInfo, { enabled: true, dataDirectory: join(f.directory, 'data') })
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(f.context.process.env[name], f.paths.temp)
})

test('损坏标识、探写路径冲突和 setPath 失败均提示并退出，异常后不能继续启动', (t) => {
  const f = bootstrapFixture(t)
  const code = compile(readFileSync('src/main/portableBootstrap.ts', 'utf8')) + '\ncontinued()'
  const cases = [
    () => writeFileSync(join(f.directory, 'portable.json'), '{'),
    () => {
      writeFileSync(join(f.directory, 'portable.json'), '{"version":1}')
      mkdirSync(join(f.directory, 'data'))
      writeFileSync(join(f.directory, 'data', 'session'), '文件占用')
    },
    () => {
      rmSync(join(f.directory, 'data', 'session'))
      f.electron.app.setPath = () => { throw new Error('setPath rejected') }
    }
  ]
  for (const prepare of cases) {
    f.events.length = 0
    prepare()
    assert.throws(() => runInNewContext(code, { ...f.context, continued: () => f.events.push('continued') }), /便携/u)
    assert.deepEqual(f.events, ['dialog', 'exit:1'])
    assert.equal(f.context.exports.portableRuntimeInfo, undefined)
  }
  f.events.length = 0
  f.electron.dialog.showErrorBox = () => { throw new Error('dialog failed') }
  assert.throws(() => runInNewContext(code, f.context), /dialog failed/u)
  assert.deepEqual(f.events, ['exit:1'])
})

test('便携 IPC 在日志、单实例锁和就绪回调前注册，并返回约定结构', () => {
  const parsed = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true)
  const statement = parsed.statements.find((node) => node.getText(parsed).startsWith("ipcMain.handle('app:get-portable-info'"))
  assert.ok(statement)
  for (const boundary of ['const appLogger =', 'app.requestSingleInstanceLock()', 'app.whenReady()']) {
    assert.ok(statement.getStart(parsed) < main.indexOf(boundary), boundary)
  }
  for (const portableRuntimeInfo of [{ enabled: true, dataDirectory: 'C:\\中文 空格\\data' }, { enabled: false, dataDirectory: null }]) {
    runInNewContext(compile(statement.getText(parsed)), {
      portableRuntimeInfo,
      ipcMain: {
        /** 校验真实 IPC 处理器返回值；参数为通道及处理器，无返回值。@author zhenghq */
        handle(channel: string, handler: () => PortableRuntimeInfo) {
          assert.equal(channel, 'app:get-portable-info')
          assert.deepEqual(handler(), portableRuntimeInfo)
        }
      }
    })
  }
})

test('真实更新分支只加载对应工厂，便携分支广播状态并打开初始化门禁', async () => {
  const parsed = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true)
  let branch = ''
  /** 查找含便携更新工厂的完整条件分支；参数为语法节点，无返回值。@author zhenghq */
  function visit(node: import('typescript').Node): void {
    if (ts.isIfStatement(node) && node.expression.getText(parsed) === 'isWindows7CompatibilityRuntime()' && node.getText(parsed).includes('createPortableUpdateManager')) {
      const siblings = (node.parent as import('typescript').Block).statements
      const at = siblings.indexOf(node)
      // 连同共享回调与成功门禁执行，保持三类驱动的真实行为验证。@author zhenghq
      branch = siblings.slice(at - 1, at + 3).map((statement) => statement.getText(parsed)).join('\n')
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(branch)
  for (const [win7, portable, expected] of [[false, true, 'portable'], [false, false, 'installed'], [true, false, 'win7'], [true, true, 'win7']] as const) {
    const calls: string[] = []
    const status = { state: 'idle' }
    const manager = {}
    const context = {
      updateManager: null,
      updateManagerInitialization: null,
      resolveUpdateManagerInitialization: () => calls.push('ready'),
      createUpdateManagerGate: () => calls.push('gate'),
      portableRuntimeInfo: { enabled: portable },
      isWindows7CompatibilityRuntime: () => win7,
      broadcast: (channel: string, value: unknown) => { assert.equal(channel, 'updater:status'); assert.equal(value, status); calls.push('broadcast') },
      app: { getVersion: () => '1.0.0', isPackaged: true },
      translationFetch: () => {}, appLogger: {},
      /** 模拟各更新模块并记录真实分支选择；参数为模块名，返回模块导出。@author zhenghq */
      require(id: string) {
        calls.push(id)
        /** 调用状态回调并返回更新管理器；参数为回调，返回模拟管理器。@author zhenghq */
        const factory = async (onStatusChanged: (value: unknown) => void) => { onStatusChanged(status); return manager }
        if (id === './portableUpdater') return { createPortableUpdateManager: factory }
        if (id === './updater') return { createApplicationUpdateManager: factory }
        if (id === './updateManager') return { UpdateManager: class {
          /** 接收 Win7 配置并广播状态；参数为配置，返回模拟管理器实例。@author zhenghq */
          constructor(options: { onStatusChanged: (value: unknown) => void; installMode: string }) { assert.equal(options.installMode, 'manual'); options.onStatusChanged(status) }
        } }
        if (id === './win7UpdateDriver') return { Win7UpdateDriver: class {} }
        throw new Error(`非预期更新依赖：${id}`)
      }
    }
    await runInNewContext(compile(`(async () => { ${branch} })()`), context)
    const imports = expected === 'win7' ? ['./updateManager', './win7UpdateDriver'] : [expected === 'portable' ? './portableUpdater' : './updater']
    assert.deepEqual(calls, [...imports, 'broadcast', 'gate', 'ready'])
    if (expected !== 'win7') assert.equal(context.updateManager, manager)
  }
})

/**
 * 隔离执行主入口的真实自启动函数，只记录系统写入与删除请求。
 * @param portable 是否处于便携模式。
 * @param enabled 保存的自启动开关值。
 * @param platform 模拟系统平台。
 * @param packaged 是否为打包应用。
 * @returns 实际产生的系统写入调用。
 * @author zhenghq
 */
function runAutoLaunch(portable: boolean, enabled: boolean, platform = 'win32', packaged = true): unknown[] {
  const ts = createRequire(`${process.cwd()}/package.json`)('typescript') as typeof import('typescript')
  const source = readFileSync('src/main/index.ts', 'utf8')
  const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
  const fn = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'applyAutoLaunch')
  assert.ok(fn)
  const calls: unknown[] = []
  const code = ts.transpileModule(`${fn.getText(parsed)}\napplyAutoLaunch(${enabled})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(code, {
    portableRuntimeInfo: { enabled: portable },
    process: { platform, execPath: 'C:\\中文 空格\\划词翻译.exe' },
    app: { isPackaged: packaged, getName: () => '划词翻译', setLoginItemSettings: (payload: unknown) => calls.push(payload) },
    resolveAutoLaunchStrategy, buildLoginItemSettings, resolveLinuxAutostartEntryPath, buildLinuxAutostartEntry,
    console: { log: () => {}, error: (message: string) => assert.fail(message) },
    homedir: () => '/home/test', APP_ID: 'com.selection.translator', dirname,
    rmSync: (path: string) => calls.push(['remove', path]),
    mkdirSync: (path: string) => calls.push(['mkdir', path]),
    writeFileSync: (path: string, content: string) => calls.push(['write', path, content])
  })
  return calls
}

test('便携 true/false 自启动配置均不写入或删除安装版系统登录项', () => {
  for (const enabled of [true, false]) {
    assert.deepEqual(runAutoLaunch(true, enabled), [])
    assert.deepEqual(runAutoLaunch(true, enabled, 'linux'), [])
    assert.deepEqual(runAutoLaunch(false, enabled, 'win32', false), [])
    assert.deepEqual(runAutoLaunch(false, enabled, 'freebsd'), [])
  }
})

test('安装版 true/false 仍更新登录项，Linux 仍按设置创建或删除入口', () => {
  for (const enabled of [true, false]) {
    assert.deepEqual(runAutoLaunch(false, enabled), [{ openAtLogin: enabled, path: 'C:\\中文 空格\\划词翻译.exe', args: [] }])
    assert.deepEqual(runAutoLaunch(false, enabled, 'darwin'), [{ openAtLogin: enabled }])
  }
  assert.deepEqual(runAutoLaunch(false, false, 'linux'), [['remove', '/home/test/.config/autostart/com.selection.translator.desktop']])
  assert.deepEqual(runAutoLaunch(false, true, 'linux'), [
    ['mkdir', '/home/test/.config/autostart'],
    ['write', '/home/test/.config/autostart/com.selection.translator.desktop', buildLinuxAutostartEntry({ appName: '划词翻译', execPath: 'C:\\中文 空格\\划词翻译.exe' })]
  ])
})

// 显式设置测试语言，生产启动前的共享翻译器仍默认英文。@author zhenghq
beforeEach(() => setMainMessageTranslator(createTranslator('zh-CN')))
