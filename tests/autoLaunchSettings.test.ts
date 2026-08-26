import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  normalizeSettings
} from '../src/shared/settingsDefaults.ts'
import {
  buildLinuxAutostartEntry,
  buildLoginItemSettings,
  resolveAutoLaunchStrategy,
  resolveLinuxAutostartEntryPath
} from '../src/main/autoLaunch.ts'

test('开机自启动设置默认关闭并能从旧配置安全迁移', () => {
  assert.equal(DEFAULT_SETTINGS.autoLaunch, false)
  assert.equal(normalizeSettings({ schemaVersion: 15 }).autoLaunch, false)
  assert.equal(normalizeSettings({ schemaVersion: 15, autoLaunch: true }).autoLaunch, true)
  assert.equal(normalizeSettings({ schemaVersion: 15, autoLaunch: 'true' as never }).autoLaunch, false)
  assert.equal(normalizeSettings({ schemaVersion: 15 }).schemaVersion, SETTINGS_SCHEMA_VERSION)
})

test('开机自启动落地方式应按平台与打包状态区分', () => {
  assert.equal(resolveAutoLaunchStrategy({ platform: 'darwin', packaged: true }), 'login-item')
  assert.equal(resolveAutoLaunchStrategy({ platform: 'win32', packaged: true }), 'login-item')
  assert.equal(resolveAutoLaunchStrategy({ platform: 'linux', packaged: true }), 'desktop-entry')
  assert.equal(resolveAutoLaunchStrategy({ platform: 'freebsd', packaged: true }), 'unsupported')
  assert.equal(resolveAutoLaunchStrategy({ platform: 'darwin', packaged: false }), 'skipped')
  assert.equal(resolveAutoLaunchStrategy({ platform: 'linux', packaged: false }), 'skipped')
})

test('登录项参数仅在 Windows 显式指定可执行文件路径', () => {
  assert.deepEqual(
    buildLoginItemSettings({ platform: 'win32', enabled: true, execPath: 'C:\\Apps\\划词翻译.exe' }),
    { openAtLogin: true, path: 'C:\\Apps\\划词翻译.exe', args: [] }
  )
  assert.deepEqual(
    buildLoginItemSettings({
      platform: 'darwin',
      enabled: false,
      execPath: '/Applications/划词翻译.app/Contents/MacOS/划词翻译'
    }),
    { openAtLogin: false }
  )
})

test('Linux 自启动应写入 XDG autostart 目录下的桌面入口', () => {
  assert.equal(
    resolveLinuxAutostartEntryPath('/home/test', 'com.selection.translator'),
    '/home/test/.config/autostart/com.selection.translator.desktop'
  )

  const entry = buildLinuxAutostartEntry({
    appName: '划词翻译',
    execPath: '/home/test/Apps/划词翻译.AppImage'
  })
  assert.match(entry, /^\[Desktop Entry\]$/mu)
  assert.match(entry, /^Type=Application$/mu)
  assert.match(entry, /^Name=划词翻译$/mu)
  assert.match(entry, /^Exec="\/home\/test\/Apps\/划词翻译\.AppImage"$/mu)
  assert.match(entry, /^Terminal=false$/mu)
  assert.match(entry, /^X-GNOME-Autostart-enabled=true$/mu)
})

test('设置页应提供开机自启动开关并通过普通设置接口保存', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')

  assert.match(html, /id="auto-launch"[^>]+type="checkbox"/u)
  assert.match(html, /for="auto-launch"/u)
  assert.match(html, /开机自启动/u)
  assert.match(source, /getElementById\('auto-launch'\)/u)
  assert.match(source, /autoLaunch\.checked\s*=\s*settings\.autoLaunch/u)
  assert.match(source, /autoLaunch\.addEventListener\('change', saveAutoLaunch\)/u)
  assert.match(source, /function saveAutoLaunch\(\): void[\s\S]*?autoLaunch\.checked/u)
  assert.match(source, /autoLaunch:\s*autoLaunch\.checked/u)
})

test('主进程应在启动和设置变更时同步开机自启动状态', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  assert.match(source, /function applyAutoLaunch\(enabled: boolean\): void/u)
  assert.match(source, /resolveAutoLaunchStrategy\(\{[\s\S]*?platform: process\.platform[\s\S]*?packaged: app\.isPackaged/u)
  assert.match(source, /app\.setLoginItemSettings\(\s*buildLoginItemSettings\(/u)
  assert.match(source, /resolveLinuxAutostartEntryPath\(/u)
  assert.match(source, /buildLinuxAutostartEntry\(/u)
  assert.match(source, /applyAutoLaunch\(getSettings\(\)\.autoLaunch\)/u)
  assert.match(source, /patch\.autoLaunch\s*!==\s*undefined[\s\S]*?applyAutoLaunch\(settings\.autoLaunch\)/u)
})
