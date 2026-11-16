import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import test, { beforeEach } from 'node:test'
import { setMainMessageTranslator, translateMain } from '../src/main/messages.ts'
import { createTranslator } from '../src/shared/i18n/index.ts'
import { initializePortableRuntime } from '../src/main/portableRuntime.ts'
import { resolveAutoLaunchStrategy } from '../src/main/autoLaunch.ts'

const requireFromProject = createRequire(`${process.cwd()}/package.json`)
const ts = requireFromProject('typescript') as typeof import('typescript')

/**
 * 加载真实运行时并仅替换文件写入，以模拟磁盘不足时的短写。
 * @param bytesWritten 本次写入允许完成的字节数。
 * @returns 使用真实目录操作的运行时初始化函数。
 * @author zhenghq
 */
function runtimeWithShortWrite(bytesWritten: number): typeof initializePortableRuntime {
  const code = ts.transpileModule(readFileSync('src/main/portableRuntime.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports: Record<string, unknown> = {}
  runInNewContext(code, {
    exports,
    require: (id: string) => {
      if (id === './messages') return { translateMain }
      const dependency = requireFromProject(id)
      if (id !== 'node:fs') return dependency
      return {
        ...dependency,
        /** 模拟短写；参数为文件描述符和内容，返回实际写入字节数。@author zhenghq */
        writeSync(fd: number, content: string): number {
          return dependency.writeSync(fd, content.slice(0, bytesWritten))
        }
      }
    }
  })
  return exports.initializePortableRuntime as typeof initializePortableRuntime
}

/** 创建独立便携夹具；参数为测试上下文，返回目录和可注入路径适配器。@author zhenghq */
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'portable-中文 空格-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, '程序')
  mkdirSync(directory)
  writeFileSync(join(directory, 'portable.json'), '{"version":1}')
  const paths: Record<string, string> = {}
  const env: Record<string, string | undefined> = { TEMP: 'original' }
  return { root, directory, paths, env, options: {
    platform: 'win32', packaged: true, win7: false, arch: 'x64',
    execPath: join(directory, '划词翻译.exe'), env,
    setPath: (name: string, path: string) => { paths[name] = path }
  } }
}

test('便携版为两个架构创建完整隔离路径并同步 Node 临时环境', (t) => {
  const f = fixture(t)
  for (const arch of ['x64', 'arm64']) {
    const info = initializePortableRuntime({ ...f.options, arch })
    assert.deepEqual(info, { enabled: true, dataDirectory: join(f.directory, 'data') })
    assert.deepEqual(f.paths, Object.fromEntries(Object.entries({ userData: 'user-data', sessionData: 'session', logs: 'logs', temp: 'temp', crashDumps: 'crash-dumps' }).map(([key, value]) => [key, join(info.dataDirectory!, value)])))
    for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(f.env[key], f.paths.temp)
  }
})

test('普通安装、开发、Win7和非Windows不更改路径或环境', (t) => {
  const f = fixture(t)
  for (const override of [{ packaged: false }, { win7: true }, { platform: 'darwin' }, { platform: 'linux' }]) {
    assert.equal(initializePortableRuntime({ ...f.options, ...override }).enabled, false)
    assert.deepEqual(f.paths, {})
    assert.deepEqual(f.env, { TEMP: 'original' })
    assert.deepEqual(readdirSync(f.directory), ['portable.json'])
  }
  rmSync(join(f.directory, 'portable.json'))
  assert.deepEqual(initializePortableRuntime(f.options), { enabled: false, dataDirectory: null })
  assert.deepEqual(readdirSync(f.directory), [])
})

test('标识损坏、未知版本或架构不得静默回退到安装模式', (t) => {
  const f = fixture(t)
  for (const value of ['{', 'null', '{}', '[]', 'true', '{"version":2}', '{"version":"1"}']) {
    writeFileSync(join(f.directory, 'portable.json'), value)
    assert.throws(() => initializePortableRuntime(f.options), /portable|便携/u)
    assert.deepEqual(f.paths, {})
  }
  writeFileSync(join(f.directory, 'portable.json'), '{"version":1}')
  assert.throws(() => initializePortableRuntime({ ...f.options, arch: 'ia32' }), /便携/u)
})

test('真实 Node tmpdir 与 Electron temp 同步，现有临时环境不会泄漏到安装目录', (t) => {
  const f = fixture(t)
  const names = ['TEMP', 'TMP', 'TMPDIR']
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name]
      else process.env[name] = original[name]
    }
  })
  initializePortableRuntime({ ...f.options, env: process.env })
  assert.equal(tmpdir(), f.paths.temp)
  for (const name of names) assert.equal(process.env[name], f.paths.temp)
})

test('每一级目录探写失败都不设置 Electron 路径或修改临时环境', (t) => {
  const f = fixture(t)
  for (let failedIndex = 0; failedIndex < 6; failedIndex++) {
    let visited = 0
    assert.throws(() => initializePortableRuntime({
      ...f.options,
      /** 模拟指定目录无写权限；参数为目录，返回空或抛出权限异常。@author zhenghq */
      probeDirectory(directory) {
        if (visited++ === failedIndex) throw new Error(`EACCES ${directory}`)
      }
    }), /EACCES/u)
    assert.equal(visited, failedIndex + 1)
    assert.deepEqual(f.paths, {})
    assert.deepEqual(f.env, { TEMP: 'original' })
  }
})

test('Electron 路径接管异常必须上抛，不能返回安装模式或继续接管', (t) => {
  const f = fixture(t)
  const calls: string[] = []
  assert.throws(() => initializePortableRuntime({
    ...f.options,
    /** 模拟会话路径设置失败；参数为路径名，返回空或抛出路径错误。@author zhenghq */
    setPath(name) {
      calls.push(name)
      if (name === 'sessionData') throw new Error('session path rejected')
    }
  }), /便携.*session path rejected/u)
  assert.deepEqual(calls, ['userData', 'sessionData'])
  assert.deepEqual(f.env, { TEMP: 'original' })
})

test('数据路径冲突或写权限失败必须在 setPath 和修改环境前失败', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.directory, 'data'))
  writeFileSync(join(f.directory, 'data', 'logs'), '占用')
  assert.throws(() => initializePortableRuntime(f.options), /便携/u)
  assert.deepEqual(f.paths, {})
  assert.deepEqual(f.env, { TEMP: 'original' })
  rmSync(join(f.directory, 'data', 'logs'))
  assert.throws(() => initializePortableRuntime({ ...f.options, probeDirectory: () => { throw new Error('EACCES') } }), /EACCES/u)
  assert.deepEqual(f.paths, {})
})

test('探写未完整写入时必须清理探针并失败，不得设置路径或回退', (t) => {
  const f = fixture(t)
  for (const bytesWritten of [0, 3]) {
    assert.throws(() => runtimeWithShortWrite(bytesWritten)(f.options), /便携.*探写/u)
    assert.deepEqual(f.paths, {})
    assert.deepEqual(f.env, { TEMP: 'original' })
    assert.deepEqual(readdirSync(join(f.directory, 'data')), [])
  }
})

test('数据目录符号链接不能将便携写入转移到外部目录', (t) => {
  const f = fixture(t)
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(f.directory, 'data'), 'junction')
  assert.throws(() => initializePortableRuntime(f.options), /便携/u)
  assert.deepEqual(f.paths, {})
})

test('符号链接标识和数据子目录都不得把便携写入导向外部', (t) => {
  const f = fixture(t)
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  rmSync(join(f.directory, 'portable.json'))
  symlinkSync(outside, join(f.directory, 'portable.json'), 'junction')
  assert.throws(() => initializePortableRuntime(f.options), /便携/u)
  rmSync(join(f.directory, 'portable.json'))
  writeFileSync(join(f.directory, 'portable.json'), '{"version":1}')
  mkdirSync(join(f.directory, 'data'))
  symlinkSync(outside, join(f.directory, 'data', 'user-data'), 'junction')
  assert.throws(() => initializePortableRuntime(f.options), /便携/u)
  assert.deepEqual(readdirSync(outside), [])
  assert.deepEqual(f.paths, {})
  assert.deepEqual(f.env, { TEMP: 'original' })
})

test('关闭程序后搬迁目录可以从新路径读取原设置与历史', (t) => {
  const f = fixture(t)
  initializePortableRuntime(f.options)
  writeFileSync(join(f.paths.userData, 'settings.json'), '{"targetLang":"zh-CN"}')
  writeFileSync(join(f.paths.userData, 'history.json'), '["保留"]')
  const moved = join(f.root, '移动后的 程序')
  renameSync(f.directory, moved)
  initializePortableRuntime({ ...f.options, execPath: join(moved, '划词翻译.exe') })
  assert.equal(f.paths.userData, join(moved, 'data', 'user-data'))
  assert.equal(readFileSync(join(f.paths.userData, 'settings.json'), 'utf8'), '{"targetLang":"zh-CN"}')
  assert.equal(readFileSync(join(f.paths.userData, 'history.json'), 'utf8'), '["保留"]')
})

test('便携模式跳过自启动策略但安装版策略保持不变', () => {
  assert.equal(resolveAutoLaunchStrategy({ platform: 'win32', packaged: true, portable: true }), 'skipped')
  assert.equal(resolveAutoLaunchStrategy({ platform: 'win32', packaged: true }), 'login-item')
})

// 启动前沿用共享翻译器的英文默认值；已有中文断言显式指定语言。@author zhenghq
beforeEach(() => setMainMessageTranslator(createTranslator('zh-CN')))

test('启动错误使用纯内存词条，双语均提示可写目录且不写入默认路径', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.directory, 'portable.json'), '{')
  for (const locale of ['en-US', 'zh-CN'] as const) {
    setMainMessageTranslator(createTranslator(locale))
    assert.throws(() => initializePortableRuntime(f.options), (error: Error) => {
      assert.ok(error.message.includes(f.directory))
      assert.match(error.message, locale === 'zh-CN' ? /可写目录/u : /writable directory/u)
      return true
    })
    assert.deepEqual(f.paths, {})
    assert.equal(f.env.TEMP, 'original')
  }
})
