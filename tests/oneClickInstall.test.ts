import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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

type MacOSInstallerMode = 'none' | 'graceful' | 'force'

type MacOSInstallerScenarioResult = {
  status: number | null
  output: string
  actions: string[]
  openedPath: string
  installedExecutableExists: boolean
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

/**
 * 启动脱离测试进程的休眠任务，用于模拟仍在运行的 Electron 主进程或子进程。
 * @returns 休眠任务的进程 PID。
 * @author zhenghq
 */
function startDetachedSleeper(): number {
  const result = spawnSync('sh', ['-c', 'sleep 120 >/dev/null 2>&1 & printf \'%s\' "$!"'], {
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  const processId = Number(result.stdout)
  assert.equal(Number.isInteger(processId) && processId > 0, true)
  return processId
}

/**
 * 清理安装流程测试创建的休眠任务。
 * @param processId 待清理的进程 PID，未创建任务时传入 0。
 * @returns 无返回值。
 * @author zhenghq
 */
function stopDetachedSleeper(processId: number): void {
  if (processId <= 0) return
  try {
    process.kill(processId, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/**
 * 使用隔离命令替身运行一次 macOS 安装流程，避免下载、打开 GUI 或操作真实应用。
 * @param mode 旧实例行为模式：无实例、正常退出或必须强制退出。
 * @param stopTimeoutSeconds 优雅退出等待秒数。
 * @param forceStopTimeoutSeconds 强制退出后的等待秒数。
 * @returns 安装进程结果、应用操作记录和目标路径安装结果。
 * @author zhenghq
 */
function runMacOSInstallerScenario(
  mode: MacOSInstallerMode,
  stopTimeoutSeconds = '2',
  forceStopTimeoutSeconds = '2'
): MacOSInstallerScenarioResult {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'selection-translator-macos-installer-'))
  let applicationProcessId = 0
  let helperProcessId = 0

  try {
    const fakeBinaryDirectory = join(temporaryDirectory, 'fake-bin')
    const homeDirectory = join(temporaryDirectory, 'home')
    const temporaryDownloadDirectory = join(temporaryDirectory, 'downloads')
    const installDirectory = join(homeDirectory, 'Custom Applications')
    const actionLogPath = join(temporaryDirectory, 'application-actions.log')
    const openLogPath = join(temporaryDirectory, 'open.log')
    mkdirSync(fakeBinaryDirectory, { recursive: true })
    mkdirSync(homeDirectory, { recursive: true })
    mkdirSync(temporaryDownloadDirectory, { recursive: true })

    if (mode !== 'none') {
      applicationProcessId = startDetachedSleeper()
      helperProcessId = startDetachedSleeper()
    }

    const assetName = 'SelectionTranslator-0.2.0-mac-x64.zip'
    const assetContent = 'fake-macos-zip'
    const assetHash = createHash('sha256').update(assetContent).digest('hex')
    const fakeCommands: Record<string, string> = {
      uname: `#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo x86_64; fi\n`,
      curl: `#!/bin/sh
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
`,
      unzip: `#!/bin/sh
destination=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-d' ]; then
    destination="$2"
    break
  fi
  shift
done
mkdir -p "$destination/划词翻译.app/Contents/MacOS"
printf 'fake executable' > "$destination/划词翻译.app/Contents/MacOS/划词翻译"
`,
      osascript: `#!/bin/sh
cat >/dev/null
action="$4"
printf '%s\\n' "$action" >> "$MACOS_TEST_ACTION_LOG"
case "$action" in
  list)
    if [ -n "\${MACOS_TEST_APPLICATION_PID:-}" ] && kill -0 "$MACOS_TEST_APPLICATION_PID" 2>/dev/null; then
      printf '%s\\n' "$MACOS_TEST_APPLICATION_PID"
    fi
    ;;
  terminate)
    if [ "$MACOS_TEST_MODE" = 'graceful' ]; then
      kill "$MACOS_TEST_APPLICATION_PID" "$MACOS_TEST_HELPER_PID" 2>/dev/null || true
    fi
    ;;
  forceTerminate) ;;
esac
exit 0
`,
      pgrep: `#!/bin/sh
if [ "$1" = '-P' ] && [ "$2" = "$MACOS_TEST_APPLICATION_PID" ]; then
  printf '%s\\n' "$MACOS_TEST_HELPER_PID"
fi
`,
      open: `#!/bin/sh\nprintf '%s\\n' "$1" > "$MACOS_TEST_OPEN_LOG"\n`
    }

    for (const [commandName, source] of Object.entries(fakeCommands)) {
      const commandPath = join(fakeBinaryDirectory, commandName)
      writeFileSync(commandPath, source)
      chmodSync(commandPath, 0o755)
    }

    const result = spawnSync('sh', ['scripts/install.sh'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${fakeBinaryDirectory}:${process.env.PATH ?? ''}`,
        HOME: homeDirectory,
        TMPDIR: temporaryDownloadDirectory,
        SELECTION_TRANSLATOR_VERSION: 'v0.2.0',
        SELECTION_TRANSLATOR_REPOSITORY: 'example/translation',
        SELECTION_TRANSLATOR_INSTALL_DIR: installDirectory,
        SELECTION_TRANSLATOR_STOP_TIMEOUT_SECONDS: stopTimeoutSeconds,
        SELECTION_TRANSLATOR_FORCE_STOP_TIMEOUT_SECONDS: forceStopTimeoutSeconds,
        MACOS_TEST_MODE: mode,
        MACOS_TEST_APPLICATION_PID: applicationProcessId > 0 ? String(applicationProcessId) : '',
        MACOS_TEST_HELPER_PID: helperProcessId > 0 ? String(helperProcessId) : '',
        MACOS_TEST_ACTION_LOG: actionLogPath,
        MACOS_TEST_OPEN_LOG: openLogPath
      }
    })
    const destination = join(installDirectory, '划词翻译.app')

    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
      actions: existsSync(actionLogPath)
        ? readFileSync(actionLogPath, 'utf8').trim().split(/\s+/u)
        : [],
      openedPath: existsSync(openLogPath) ? readFileSync(openLogPath, 'utf8').trim() : '',
      installedExecutableExists: existsSync(join(destination, 'Contents/MacOS/划词翻译'))
    }
  } finally {
    stopDetachedSleeper(applicationProcessId)
    stopDetachedSleeper(helperProcessId)
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
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

    const assetName = 'SelectionTranslator-0.2.0-linux-x86_64.AppImage'
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
  assert.match(script, /PROCESSOR_ARCHITEW6432/u)
  assert.match(script, /PROCESSOR_ARCHITECTURE/u)
  assert.match(script, /Windows_NT/u)
  assert.match(script, /SecurityProtocol[\s\S]*?Tls12/u)
  assert.match(script, /SHA256SUMS/u)
  assert.match(script, /Get-FileHash/u)
  assert.match(script, /settings\.json/u)
  assert.match(script, /Start-Process/u)
})

test('Windows 一键安装脚本应兼容当前 Release 使用的大写 V 标签', () => {
  const script = readRepositoryFile('scripts/install.ps1')

  assert.match(script, /\$Version -notmatch '\^\[vV\]'/u)
  assert.match(script, /\$Version = "V\$Version"/u)
  assert.equal(
    script.includes("if ($Version -notmatch '^[vV][0-9A-Za-z][0-9A-Za-z._-]*$')"),
    true
  )
})

/**
 * 校验用户传入小写 v 版本时会转换成实际 Release 使用的大写 V 标签。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 一键安装脚本应把用户输入的小写 v 版本规范化为 Release 的大写 V 标签', () => {
  const script = readRepositoryFile('scripts/install.ps1')

  assert.match(script, /\$Version = "V\$\(\$Version\.Substring\(1\)\)"/u)
  assert.match(script, /Release 标签统一使用大写 V/u)
})

test('桌面发行配置应为一键安装脚本生成稳定的跨平台文件名', () => {
  assert.equal(
    packageJson.scripts?.['dist:mac'],
    'npm run build && electron-builder --mac --x64 --arm64 --publish never'
  )
  assert.equal(
    packageJson.scripts?.['dist:dmg'],
    'npm run build && electron-builder --mac dmg --x64 --arm64 --publish never'
  )
  assert.equal(
    packageJson.scripts?.['dist:linux'],
    'npm run build && electron-builder --linux AppImage --x64 --arm64 --publish never'
  )
  assert.equal(
    packageJson.scripts?.['dist:win'],
    'npm run build && electron-builder --win nsis --x64 --arm64 --publish never'
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
    writeFileSync(join(temporaryDirectory, 'SelectionTranslator-0.2.0-linux-x86_64.AppImage'), 'linux')
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
    assert.match(checksums, /  SelectionTranslator-0\.2\.0-linux-x86_64\.AppImage/u)
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

test('README 应明确 Windows Terminal 必须使用 PowerShell，并提供 CMD 启动命令', () => {
  const englishReadme = readRepositoryFile('README.md')
  const chineseReadme = readRepositoryFile('README.zh-CN.md')

  assert.match(chineseReadme, /Windows Terminal[\s\S]*?PowerShell[\s\S]*?CMD、Git Bash 或 WSL/u)
  assert.match(chineseReadme, /powershell\.exe -NoProfile -ExecutionPolicy Bypass -Command/u)
  assert.match(englishReadme, /Windows Terminal[\s\S]*?PowerShell[\s\S]*?Command Prompt, Git Bash, or WSL/u)
  assert.match(englishReadme, /powershell\.exe -NoProfile -ExecutionPolicy Bypass -Command/u)
})

test('macOS 一键安装应按 Bundle ID 停止旧实例并从目标路径启动新应用', () => {
  const script = readRepositoryFile('scripts/install.sh')

  assert.match(script, /MACOS_BUNDLE_ID="com\.selection\.translator"/u)
  assert.match(script, /NSRunningApplication/u)
  assert.match(script, /runningApplicationsWithBundleIdentifier/u)
  assert.match(script, /\.terminate/u)
  assert.match(script, /\.forceTerminate/u)
  assert.match(script, /SELECTION_TRANSLATOR_STOP_TIMEOUT_SECONDS/u)
  assert.match(script, /wait_for_macos_application_exit/u)
  assert.match(script, /open "\$destination"/u)

  const stopIndex = script.lastIndexOf('stop_macos_application_instances')
  const removeIndex = script.indexOf('rm -rf "$destination"')
  const copyIndex = script.indexOf('cp -R "$application_path" "$destination"')
  const launchIndex = script.indexOf('open "$destination"')
  assert.ok(stopIndex >= 0 && stopIndex < removeIndex)
  assert.ok(removeIndex < copyIndex && copyIndex < launchIndex)
  assert.match(script, /已停止安装以避免覆盖正在使用的应用文件/u)
})

test('macOS 一键安装应等待旧实例进程树退出并启动自定义目录中的应用', () => {
  const result = runMacOSInstallerScenario('graceful')

  assert.equal(result.status, 0, result.output)
  assert.deepEqual(result.actions.slice(0, 2), ['list', 'terminate'])
  assert.equal(result.actions.filter((action) => action === 'list').length >= 2, true)
  assert.equal(result.actions.includes('forceTerminate'), false)
  assert.match(result.output, /旧实例及其子进程已退出/u)
  assert.equal(result.installedExecutableExists, true)
  assert.match(result.openedPath, /Custom Applications\/划词翻译\.app$/u)
})

test('macOS 一键安装应在优雅退出超时后强制终止旧实例进程树', () => {
  const result = runMacOSInstallerScenario('force', '0', '2')

  assert.equal(result.status, 0, result.output)
  assert.deepEqual(result.actions.slice(0, 2), ['list', 'terminate'])
  assert.equal(result.actions.filter((action) => action === 'list').length >= 2, true)
  assert.equal(result.actions.includes('forceTerminate'), true)
  assert.match(result.output, /旧实例未在 0 秒内退出，正在强制终止/u)
  assert.match(result.output, /旧实例及其子进程已强制终止/u)
  assert.equal(result.installedExecutableExists, true)
})

test('macOS 一键安装应拒绝包含分隔符的退出等待时间', () => {
  const result = runMacOSInstallerScenario('none', '1:2', '3')

  assert.notEqual(result.status, 0, result.output)
  assert.match(result.output, /macOS 应用退出等待时间必须是非负整数/u)
  assert.equal(result.installedExecutableExists, false)
})
