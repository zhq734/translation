import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

type PackageJson = {
  scripts?: Record<string, string>
  build?: {
    mac?: {
      artifactName?: string
    }
    linux?: {
      target?: Array<string | { target: string; arch?: string[] }>
      artifactName?: string
    }
    win?: {
      target?: Array<string | { target: string; arch?: string[] }>
    }
  }
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson

/**
 * 读取仓库中的文本文件，供安装契约测试复用。
 * @param path 相对仓库根目录的文件路径。
 * @returns 文件的 UTF-8 文本内容。
 * @author zhenghq
 */
function readRepositoryFile(path: string): string {
  return readFileSync(path, 'utf8')
}

test('Linux 与 macOS 一键安装脚本应检测平台架构并校验 SHA-256', () => {
  const script = readRepositoryFile('scripts/install.sh')

  assert.match(script, /GreyGunG\/translation/u)
  assert.match(script, /SELECTION_TRANSLATOR_VERSION/u)
  assert.match(script, /uname -s/u)
  assert.match(script, /uname -m/u)
  assert.match(script, /SHA256SUMS/u)
  assert.match(script, /sha256sum|shasum/u)
  assert.match(script, /settings\.json/u)

  const syntaxCheck = spawnSync('sh', ['-n', 'scripts/install.sh'], { encoding: 'utf8' })
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr)
})

test('Windows 一键安装脚本应检测架构并校验 SHA-256', () => {
  const script = readRepositoryFile('scripts/install.ps1')

  assert.match(script, /GreyGunG\/translation/u)
  assert.match(script, /SELECTION_TRANSLATOR_VERSION/u)
  assert.match(script, /OSArchitecture/u)
  assert.match(script, /SHA256SUMS/u)
  assert.match(script, /Get-FileHash/u)
  assert.match(script, /settings\.json/u)
  assert.match(script, /Start-Process/u)
})

test('桌面发行配置应为一键安装脚本生成稳定的跨平台文件名', () => {
  assert.equal(
    packageJson.scripts?.['dist:linux'],
    'npm run build && electron-builder --linux AppImage --x64 --arm64'
  )
  assert.equal(
    packageJson.scripts?.['dist:win'],
    'npm run build && electron-builder --win nsis --x64 --arm64'
  )
  assert.equal(packageJson.scripts?.['release:checksums'], 'node scripts/generate-checksums.mjs')
  assert.equal(
    packageJson.build?.mac?.artifactName,
    'SelectionTranslator-${version}-mac-${arch}.${ext}'
  )
  assert.deepEqual(packageJson.build?.linux?.target, [{ target: 'AppImage', arch: ['x64', 'arm64'] }])
  assert.equal(
    packageJson.build?.linux?.artifactName,
    'SelectionTranslator-${version}-linux-${arch}.${ext}'
  )
  assert.deepEqual(packageJson.build?.win?.target, [{ target: 'nsis', arch: ['x64', 'arm64'] }])
})

test('校验和生成脚本应只为可发布安装包生成 SHA256SUMS', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'selection-translator-checksums-'))
  try {
    writeFileSync(join(temporaryDirectory, 'SelectionTranslator-0.2.0-linux-x64.AppImage'), 'linux')
    writeFileSync(join(temporaryDirectory, 'SelectionTranslator-0.2.0-mac-arm64.zip'), 'mac')
    writeFileSync(join(temporaryDirectory, 'SelectionTranslator-0.2.0-Setup-x64.exe'), 'windows')
    writeFileSync(join(temporaryDirectory, 'builder-debug.yml'), 'ignore')

    const outputPath = join(temporaryDirectory, 'SHA256SUMS')
    const result = spawnSync(
      process.execPath,
      ['scripts/generate-checksums.mjs', '--directory', temporaryDirectory, '--output', outputPath],
      { encoding: 'utf8' }
    )

    assert.equal(result.status, 0, result.stderr)
    const checksums = readFileSync(outputPath, 'utf8')
    assert.match(checksums, /  SelectionTranslator-0\.2\.0-linux-x64\.AppImage/u)
    assert.match(checksums, /  SelectionTranslator-0\.2\.0-mac-arm64\.zip/u)
    assert.match(checksums, /  SelectionTranslator-0\.2\.0-Setup-x64\.exe/u)
    assert.doesNotMatch(checksums, /builder-debug\.yml/u)
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('README 应提供一键安装命令和固定版本示例', () => {
  const readme = readRepositoryFile('README.md')

  assert.match(
    readme,
    /https:\/\/raw\.githubusercontent\.com\/GreyGunG\/translation\/main\/scripts\/install\.sh/u
  )
  assert.match(
    readme,
    /https:\/\/raw\.githubusercontent\.com\/GreyGunG\/translation\/main\/scripts\/install\.ps1/u
  )
  assert.match(readme, /SELECTION_TRANSLATOR_VERSION=v0\.2\.0/u)
  assert.match(readme, /SHA-256/u)
})
