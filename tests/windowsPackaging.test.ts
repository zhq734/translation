import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

type PackageJson = {
  scripts?: Record<string, string>
  overrides?: Record<string, string>
  build?: {
    electronDist?: string
    win?: {
      target?: Array<string | { target: string; arch?: string[] }>
      extraResources?: Array<{ from: string; to: string; filter?: string[] }>
    }
    nsis?: {
      oneClick?: boolean
      perMachine?: boolean
      allowToChangeInstallationDirectory?: boolean
      createDesktopShortcut?: boolean | string
      createStartMenuShortcut?: boolean
      runAfterFinish?: boolean
      artifactName?: string
      include?: string
    }
  }
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson

/**
 * 校验 Windows 打包脚本使用 electron-builder 的 NSIS 目标生成安装程序。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 打包脚本应生成 x64 与 arm64 NSIS 安装程序', () => {
  assert.equal(
    packageJson.scripts?.['dist:win'],
    'npm run build && node scripts/prepare-windows-ocr-runtime.mjs && electron-builder --win nsis --x64 --arm64 --publish never'
  )
})

/**
 * 校验 Windows 打包会预取并验证 x64/arm64 的 sharp 原生运行时，避免交叉打包
 * 把构建机的 darwin binding 带入安装包后导致 PaddleOCR 初始化失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 打包前应准备并校验目标架构 sharp 运行时', () => {
  const expectedScript = 'node scripts/prepare-windows-ocr-runtime.mjs'
  for (const command of ['dist:win']) {
    assert.match(packageJson.scripts?.[command] ?? '', new RegExp(expectedScript.replace(/[.]/gu, '\\.'), 'u'))
  }
  assert.equal(existsSync('scripts/prepare-windows-ocr-runtime.mjs'), true)
  assert.equal(packageJson.overrides?.sharp, '0.34.2')

  const prepareScript = readFileSync('scripts/prepare-windows-ocr-runtime.mjs', 'utf8')
  assert.match(prepareScript, /'x64', 'arm64'/u)
  assert.match(prepareScript, /sharp-win32-\$\{arch\}\.node/u)
  assert.match(prepareScript, /libvips-42\.dll/u)
})

/**
 * 校验 Windows 运行时准备脚本通过 npm_execpath 启动 npm，避免 Node.js 在 Windows
 * 直接 spawn npm.cmd 时返回 EINVAL，导致 CI 打包中断。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 运行时准备脚本应通过 npm_execpath 调用 npm', () => {
  const prepareScript = readFileSync('scripts/prepare-windows-ocr-runtime.mjs', 'utf8')
  assert.match(prepareScript, /process\.env\.npm_execpath/u)
  assert.match(prepareScript, /spawnSync\(\s*process\.execPath/u)
})

/**
 * 校验 Windows 打包配置包含可安装、可创建快捷方式的 NSIS 选项。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows NSIS 配置应支持自定义安装目录和快捷方式', () => {
  const winTarget = packageJson.build?.win?.target
  assert.deepEqual(winTarget, [{ target: 'nsis', arch: ['x64', 'arm64'] }])
  assert.equal(packageJson.build?.nsis?.oneClick, false)
  assert.equal(packageJson.build?.nsis?.perMachine, false)
  assert.equal(packageJson.build?.nsis?.allowToChangeInstallationDirectory, true)
  assert.equal(packageJson.build?.nsis?.createDesktopShortcut, true)
  assert.equal(packageJson.build?.nsis?.createStartMenuShortcut, true)
  assert.equal(packageJson.build?.nsis?.runAfterFinish, true)
  assert.equal(packageJson.build?.nsis?.artifactName, 'SelectionTranslator-${version}-Setup-${arch}.${ext}')
})

/**
 * 校验 Windows 快捷方式显式引用随应用安装的 ICO 文件，避免资源管理器显示空白图标。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 桌面与开始菜单快捷方式应显式使用安装后的应用图标', () => {
  assert.deepEqual(packageJson.build?.win?.extraResources, [
    { from: 'build/icon.ico', to: 'app-icon.ico' },
    { from: 'helpers/windows-uia-reader', to: '.', filter: ['windows-uia-reader.exe'] },
    { from: 'build/build-info.json', to: 'build-info.json' }
  ])
  assert.equal(packageJson.build?.nsis?.include, 'build/installer.nsh')
  assert.equal(existsSync('build/installer.nsh'), true)

  const installerScript = readFileSync('build/installer.nsh', 'utf8')
  assert.match(
    installerScript,
    /CreateShortCut "\$newDesktopLink" "\$appExe" "" "\$INSTDIR\\resources\\app-icon\.ico"/u
  )
  assert.match(
    installerScript,
    /CreateShortCut "\$newStartMenuLink" "\$appExe" "" "\$INSTDIR\\resources\\app-icon\.ico"/u
  )
  assert.match(installerScript, /Shell32::SHChangeNotify/u)
})

/**
 * 校验打包配置不固定使用当前操作系统的 Electron 发行目录，避免跨平台打包复用错误二进制。
 * @returns 无返回值。
 * @author zhenghq
 */
test('打包配置应允许 electron-builder 下载目标平台 Electron', () => {
  assert.equal(packageJson.build?.electronDist, undefined)
})

/**
 * 校验 Windows helper 资源条目使用通配写法，使仓库尚未提交预编译 exe 时
 * `dist:win` 不会因缺少文件而整包失败（electron-builder 对无匹配的 glob 不报错）。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows helper 资源条目应容忍预编译 exe 缺失', () => {
  const winResources = packageJson.build?.win?.extraResources ?? []
  const helperEntry = winResources.find((entry) => entry.to === '.')
  assert.ok(helperEntry, 'win extraResources 应包含 windows-uia-reader helper 条目')
  assert.equal(helperEntry?.from, 'helpers/windows-uia-reader')
  assert.deepEqual(helperEntry?.filter, ['windows-uia-reader.exe'])
})
