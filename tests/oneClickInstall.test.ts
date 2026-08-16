import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  assert.match(script, /zhq734\/translation/u)
  assert.match(script, /SELECTION_TRANSLATOR_VERSION/u)
  assert.match(script, /GROKBUILD_VERSION/u)
  assert.match(script, /uname -s/u)
  assert.match(script, /uname -m/u)
  assert.match(script, /SHA256SUMS/u)
  assert.match(script, /sha256sum|shasum/u)
  assert.match(script, /settings\.json/u)

  const syntaxCheck = spawnSync('sh', ['-n', 'scripts/install.sh'], { encoding: 'utf8' })
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr)
})


test('Linux 一键安装脚本应完成下载校验、用户目录安装和默认配置生成', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'selection-translator-installer-'))
  try {
    const fakeBinaryDirectory = join(temporaryDirectory, 'fake-bin')
    const homeDirectory = join(temporaryDirectory, 'home')
    const temporaryDownloadDirectory = join(temporaryDirectory, 'downloads')
    mkdirSync(fakeBinaryDirectory, { recursive: true })
    mkdirSync(homeDirectory, { recursive: true })
    mkdirSync(temporaryDownloadDirectory, { recursive: true })

    const assetName = 'SelectionTranslator-0.2.0-linux-x64.AppImage'
    const assetContent = 'fake-app-image'
    const assetHash = createHash('sha256').update(assetContent).digest('hex')
    const fakeUnamePath = join(fakeBinaryDirectory, 'uname')
    const fakeCurlPath = join(fakeBinaryDirectory, 'curl')
    writeFileSync(fakeUnamePath, `#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n`)
    writeFileSync(fakeCurlPath, `#!/bin/sh
output=''
url=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then
    output="$2"
    shift 2
    continue
  fi
  case "$1" in
    http*) url="$1" ;;
  esac
  shift
done
case "$url" in
  *SHA256SUMS) printf '%s  %s\\n' '${assetHash}' '${assetName}' > "$output" ;;
  *) printf '%s' '${assetContent}' > "$output" ;;
esac
`)
    chmodSync(fakeUnamePath, 0o755)
    chmodSync(fakeCurlPath, 0o755)

    const result = spawnSync('sh', ['scripts/install.sh'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBinaryDirectory}:${process.env.PATH ?? ''}`,
        HOME: homeDirectory,
        TMPDIR: temporaryDownloadDirectory,
        XDG_BIN_HOME: join(homeDirectory, '.local/bin'),
        XDG_DATA_HOME: join(homeDirectory, '.local/share'),
        XDG_CONFIG_HOME: join(homeDirectory, '.config'),
        SELECTION_TRANSLATOR_VERSION: 'v0.2.0',
        SELECTION_TRANSLATOR_REPOSITORY: 'example/translation'
      }
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(`${result.stdout}\n${result.stderr}`, /SHA-256 校验通过/u)
    assert.equal(
      readFileSync(join(homeDirectory, '.local/bin/selection-translator'), 'utf8'),
      assetContent
    )
    assert.equal(
      existsSync(join(homeDirectory, '.local/share/applications/selection-translator.desktop')),
      true
    )
    assert.equal(existsSync(join(homeDirectory, '.config/划词翻译/settings.json')), true)
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('Windows 一键安装脚本应检测架构并校验 SHA-256', () => {
  const script = readRepositoryFile('scripts/install.ps1')

  assert.match(script, /zhq734\/translation/u)
  assert.match(script, /SELECTION_TRANSLATOR_VERSION/u)
  assert.match(script, /GROKBUILD_VERSION/u)
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

test('README 应默认使用英文并提供独立的简体中文文档', () => {
  const englishReadme = readRepositoryFile('README.md')
  const chineseReadme = readRepositoryFile('README.zh-CN.md')

  assert.match(englishReadme, /^# Selection Translator$/mu)
  assert.match(englishReadme, /\[简体中文\]\(\.\/README\.zh-CN\.md\)/u)
  assert.doesNotMatch(englishReadme, /^## 中文文档$/mu)
  assert.match(chineseReadme, /^# 划词翻译 · Selection Translator$/mu)
  assert.match(chineseReadme, /\[English\]\(\.\/README\.md\)/u)
  assert.doesNotMatch(chineseReadme, /^## English Documentation$/mu)
})

test('中英文 README 都应提供一键安装命令和固定版本示例', () => {
  const readmes = [readRepositoryFile('README.md'), readRepositoryFile('README.zh-CN.md')]

  for (const readme of readmes) {
    assert.match(
      readme,
      /https:\/\/raw\.githubusercontent\.com\/zhq734\/translation\/master\/scripts\/install\.sh/u
    )
    assert.match(
      readme,
      /https:\/\/raw\.githubusercontent\.com\/zhq734\/translation\/master\/scripts\/install\.ps1/u
    )
    assert.match(readme, /SELECTION_TRANSLATOR_VERSION=v0\.2\.0/u)
    assert.match(readme, /GROKBUILD_VERSION=v0\.2\.0/u)
    assert.match(readme, /SHA-256/u)
  }
})
