import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

type PackageJson = {
  scripts?: Record<string, string>
  build?: {
    electronDist?: string
    win?: {
      target?: Array<string | { target: string; arch?: string[] }>
    }
    nsis?: {
      oneClick?: boolean
      perMachine?: boolean
      allowToChangeInstallationDirectory?: boolean
      createDesktopShortcut?: boolean | string
      createStartMenuShortcut?: boolean
      runAfterFinish?: boolean
      artifactName?: string
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
    'npm run build && electron-builder --win nsis --x64 --arm64'
  )
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
 * 校验打包配置不固定使用当前操作系统的 Electron 发行目录，避免跨平台打包复用错误二进制。
 * @returns 无返回值。
 * @author zhenghq
 */
test('打包配置应允许 electron-builder 下载目标平台 Electron', () => {
  assert.equal(packageJson.build?.electronDist, undefined)
})
