import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('主进程应注册 logs:get-history 和 logs:export IPC', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /ipcMain\.handle\('logs:get-history', \(\) => appLogger\.getHistory\(\)\)/u)
  assert.match(source, /ipcMain\.handle\('logs:export'/u)
})

test('主进程应在启动早期初始化日志层并订阅推送', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /createAppLogger\(\{ logDir: app\.getPath\('logs'\) \}\)/u)
  assert.match(source, /appLogger\.subscribe\(pushLogEntries\)/u)
  // 日志层初始化必须先于单实例锁与 ready 流程
  const loggerIndex = source.indexOf("createAppLogger({ logDir: app.getPath('logs') })")
  const lockIndex = source.indexOf('app.requestSingleInstanceLock()')
  assert.ok(loggerIndex > -1 && lockIndex > -1 && loggerIndex < lockIndex)
})

test('日志推送仅在设置窗口存活时发送 logs:entry', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /if \(!settingsWin \|\| settingsWin\.isDestroyed\(\)\) return/u)
  assert.match(source, /settingsWin\.webContents\.send\('logs:entry', entries\)/u)
})

test('日志导出应将当日日志文件复制到用户选定路径', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /dialog\.showSaveDialog/u)
  assert.match(source, /await copyFile\(source, filePath\)/u)
  assert.match(source, /if \(canceled \|\| !filePath\) return null/u)
})

test('preload 应暴露 getLogHistory、onLogEntry 和 exportLogs 方法', () => {
  const source = readFileSync('src/preload/index.ts', 'utf8')
  assert.match(source, /getLogHistory: \(\): Promise<LogEntry\[\]> => ipcRenderer\.invoke\('logs:get-history'\)/u)
  assert.match(source, /onLogEntry\(callback: \(entries: LogEntry\[\]\) => void\)/u)
  assert.match(source, /ipcRenderer\.on\('logs:entry', listener\)/u)
  assert.match(source, /exportLogs: \(\): Promise<string \| null> => ipcRenderer\.invoke\('logs:export'\)/u)
})
