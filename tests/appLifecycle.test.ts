import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  isMacOSDiskImageExecution,
  shouldOpenSettingsOnInitialLaunch
} from '../src/main/appLifecycle.ts'

test('macOS 磁盘镜像路径判断应只识别 Volumes 根目录下的可执行文件', () => {
  assert.equal(
    isMacOSDiskImageExecution('darwin', '/Volumes/划词翻译/划词翻译.app/Contents/MacOS/划词翻译'),
    true
  )
  assert.equal(
    isMacOSDiskImageExecution('darwin', '/Volumes/划词翻译 9/划词翻译.app/Contents/MacOS/划词翻译'),
    true
  )
  assert.equal(
    isMacOSDiskImageExecution('darwin', '/Applications/划词翻译.app/Contents/MacOS/划词翻译'),
    false
  )
  assert.equal(
    isMacOSDiskImageExecution('darwin', '/Users/test/Volumes/划词翻译.app/Contents/MacOS/划词翻译'),
    false
  )
  assert.equal(
    isMacOSDiskImageExecution('win32', '/Volumes/划词翻译/划词翻译.exe'),
    false
  )
})

test('首次启动设置窗口策略应仅在 Windows 和 Linux 打开设置', () => {
  assert.equal(shouldOpenSettingsOnInitialLaunch('darwin'), false)
  assert.equal(shouldOpenSettingsOnInitialLaunch('win32'), true)
  assert.equal(shouldOpenSettingsOnInitialLaunch('linux'), true)
})

test('主进程应在初始化全局监听前提示 DMG 启动风险，并由 macOS 第二实例弹出状态栏菜单', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const warningIndex = source.indexOf('await confirmMacOSInstalledApplicationLaunch()')
  const triggerIndex = source.indexOf('startAutoTrigger(')
  const initializationIndex = source.indexOf('const initialization = app.whenReady()')

  assert.match(source, /dialog\.showMessageBox/u)
  assert.match(source, /请先将“划词翻译”复制到“应用程序”文件夹/u)
  assert.ok(warningIndex >= 0 && warningIndex < triggerIndex)
  assert.ok(initializationIndex >= 0)
  assert.match(
    source,
    /app\.on\('second-instance',[\s\S]*?initialization\.then\([\s\S]*?if \(isMac\) \{[\s\S]*?showTrayMenu\(\)[\s\S]*?\} else \{[\s\S]*?openSettings\(\)[\s\S]*?\}/u
  )
})
