import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const require = createRequire(resolve('package.json'))
const { minimatch } = require('minimatch')
const version = '3.2.1'

/**
 * 在隔离项目中模拟 npm ci 只安装了宿主 x64 Koffi，提供完整的平台包夹具。
 * @param root 临时项目根目录。
 * @param arch 目标架构。
 * @param packageVersion 平台包版本，默认与 Koffi 一致。
 * @returns 平台包根目录。
 * @author zhenghq
 */
function writePlatformPackage(root: string, arch: string, packageVersion = version): string {
  const target = join(root, 'node_modules', '@koromix', `koffi-win32-${arch}`)
  mkdirSync(join(target, `win32_${arch}`), { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: `@koromix/koffi-win32-${arch}`, version: packageVersion }))
  writeFileSync(join(target, 'index.js'), `module.exports = require('./win32_${arch}/koffi.node')`)
  writeFileSync(join(target, `win32_${arch}`, 'koffi.node'), 'fixture-native-library')
  return target
}

/**
 * 执行真实准备函数并使用本地 tar 包替代 npm 网络下载，证明跨架构安装、复用和失败处理。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 准备流程应补齐 arm64 Koffi、复用完整包并拒绝下载失败或损坏包', async () => {
  const { prepareWindowsKoffi } = await import(pathToFileURL(resolve('scripts/prepare-windows-ocr-runtime.mjs')).href)
  const root = mkdtempSync(join(tmpdir(), 'windows-koffi-'))
  const calls: string[] = []
  let mode = 'good'
  try {
    const manifest = join(root, 'node_modules', 'koffi', 'package.json')
    mkdirSync(dirname(manifest), { recursive: true })
    writeFileSync(manifest, JSON.stringify({ version, optionalDependencies: {
      '@koromix/koffi-win32-x64': version, '@koromix/koffi-win32-arm64': version
    } }))
    const x64 = writePlatformPackage(root, 'x64')
    /**
     * 按 npm pack 参数生成本地平台 tar 包或模拟下载错误，不访问网络。
     * @param args npm pack 参数。
     * @param cwd npm 工作目录。
     * @returns 模拟的 npm 执行结果。
     * @author zhenghq
     */
    function pack(args: string[], cwd: string) {
      assert.equal(args[0], 'pack')
      assert.equal(args[2], '--pack-destination')
      assert.equal(args[3], cwd)
      assert.equal(args[4], '--silent')
      calls.push(args[1])
      if (mode === 'failed') return { status: 1, stdout: '' }
      const arch = args[1].includes('arm64') ? 'arm64' : 'x64'
      const source = writePlatformPackage(join(cwd, 'source'), arch, mode === 'wrong-version' ? '0.0.0' : version)
      if (mode === 'empty') writeFileSync(join(source, `win32_${arch}`, 'koffi.node'), '')
      if (mode === 'missing') rmSync(join(source, `win32_${arch}`, 'koffi.node'))
      if (mode === 'wrong-arch') {
        rmSync(join(source, `win32_${arch}`), { recursive: true })
        mkdirSync(join(source, 'win32_ia32'))
        writeFileSync(join(source, 'win32_ia32', 'koffi.node'), 'wrong-arch')
      }
      const staging = join(cwd, 'staging')
      mkdirSync(staging)
      cpSync(source, join(staging, 'package'), { recursive: true })
      assert.equal(spawnSync('tar', ['-czf', join(cwd, 'fixture.tgz'), '-C', staging, 'package']).status, 0)
      return { status: 0, stdout: 'fixture.tgz\n' }
    }
    prepareWindowsKoffi({ root, pack })
    assert.deepEqual(calls, [`@koromix/koffi-win32-arm64@${version}`])
    assert.equal(readFileSync(join(x64, 'win32_x64', 'koffi.node'), 'utf8'), 'fixture-native-library')
    prepareWindowsKoffi({ root, pack })
    assert.equal(calls.length, 1, '完整双架构包不应重复下载')
    for (const arch of ['x64', 'arm64']) {
      const target = join(root, 'node_modules', '@koromix', `koffi-win32-${arch}`)
      for (mode of ['failed', 'empty', 'missing', 'wrong-arch', 'wrong-version', 'good']) {
        rmSync(target, { recursive: true, force: true })
        if (mode === 'good') prepareWindowsKoffi({ root, pack })
        else assert.throws(() => prepareWindowsKoffi({ root, pack }), /Koffi|koffi/u)
      }
      writeFileSync(join(target, 'package.json'), '{bad-json')
      prepareWindowsKoffi({ root, pack })
      assert.equal(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version, version)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 校验共享 Windows 准备入口及打包规则，确保安装版和便携版都收集并解包 Koffi 双架构库。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 共享准备流程及打包规则应包含 Koffi 双架构平台包', () => {
  const script = readFileSync('scripts/prepare-windows-ocr-runtime.mjs', 'utf8')
  assert.match(script, /function main\(\)[\s\S]*?prepareWindowsKoffi\(\)/u)
  const { build } = JSON.parse(readFileSync('package.json', 'utf8'))
  for (const arch of ['x64', 'arm64']) {
    const binding = `node_modules/@koromix/koffi-win32-${arch}/win32_${arch}/koffi.node`
    assert.ok(build.win.files.some((pattern: string) => !pattern.startsWith('!') && minimatch(binding, pattern)), binding)
    assert.ok(build.asarUnpack.some((pattern: string) => minimatch(binding, pattern)), binding)
  }
})
