import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('共享类型和预加载层应只暴露受限的自动更新接口', () => {
  const typesSource = readFileSync('src/shared/types.ts', 'utf8')
  const preloadSource = readFileSync('src/preload/index.ts', 'utf8')

  assert.match(typesSource, /export type UpdatePhase/u)
  assert.match(typesSource, /export interface UpdateStatus/u)
  assert.match(typesSource, /'manual-downloaded'/u)
  assert.match(typesSource, /manualDownloadAvailable\?: boolean/u)
  assert.match(typesSource, /getUpdateStatus\(\): Promise<UpdateStatus>/u)
  assert.match(typesSource, /checkForUpdates\(\): Promise<UpdateStatus>/u)
  assert.match(typesSource, /downloadUpdate\(\): Promise<UpdateStatus>/u)
  assert.match(typesSource, /installUpdate\(\): void/u)
  assert.match(typesSource, /openUpdatePage\(\): Promise<void>/u)
  assert.match(typesSource, /removeMacOSQuarantine\(\): Promise<MacOSQuarantineResult>/u)
  assert.match(typesSource, /onUpdateStatusChanged/u)

  assert.match(preloadSource, /ipcRenderer\.invoke\('updater:get-status'\)/u)
  assert.match(preloadSource, /ipcRenderer\.invoke\('updater:check'\)/u)
  assert.match(preloadSource, /ipcRenderer\.invoke\('updater:download'\)/u)
  assert.match(preloadSource, /ipcRenderer\.send\('updater:install'\)/u)
  assert.match(preloadSource, /ipcRenderer\.invoke\('updater:open-release'\)/u)
  assert.match(preloadSource, /ipcRenderer\.invoke\('updater:remove-quarantine'\)/u)
  assert.match(preloadSource, /ipcRenderer\.on\('updater:status'/u)
})

test('主进程应初始化自动更新、静默检查并注册完整 IPC', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const updaterSource = readFileSync('src/main/updater.ts', 'utf8')

  assert.match(mainSource, /createApplicationUpdateManager/u)
  assert.match(mainSource, /broadcast\('updater:status', status\)/u)
  assert.match(mainSource, /setTimeout\(\(\) => void checkForApplicationUpdates\(\),/u)
  assert.match(mainSource, /ipcMain\.handle\('updater:get-status'/u)
  assert.match(mainSource, /ipcMain\.handle\('updater:check'/u)
  assert.match(mainSource, /ipcMain\.handle\('updater:download'/u)
  assert.match(mainSource, /ipcMain\.on\('updater:install'/u)
  assert.match(mainSource, /ipcMain\.handle\('updater:open-release'/u)
  assert.match(mainSource, /ipcMain\.handle\('updater:remove-quarantine'/u)
  assert.match(updaterSource, /createManualMacUpdateService/u)
  assert.match(updaterSource, /const RELEASE_DOWNLOAD_BASE_URL = `\$\{RELEASE_URL\}\/download\/`/u)
  assert.match(
    updaterSource,
    /resolveManualMacDmgUrl\(info\.files, process\.arch, RELEASE_DOWNLOAD_BASE_URL\)/u
  )
  assert.match(updaterSource, /downloadsDirectory:\s*app\.getPath\('downloads'\)/u)
  assert.match(updaterSource, /openPath:\s*\(path\) => shell\.openPath\(path\)/u)
  assert.match(
    mainSource,
    /async function removeApplicationQuarantine\(\)[\s\S]*?dialog\.showMessageBox\([\s\S]*?result\.response !== 1[\s\S]*?removeMacOSApplicationQuarantine\(\)/u
  )
})

test('设置页应提供自适应且支持主题的版本检查、进度和安装操作', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')

  assert.match(html, /id="settings-tab-about"/u)
  assert.match(html, /id="settings-panel-about"/u)
  assert.match(html, /<h2>版本与更新<\/h2>/u)
  assert.match(html, /id="current-version"/u)
  assert.match(html, /id="latest-version"/u)
  assert.match(html, /id="update-progress"/u)
  assert.match(html, /id="check-update"/u)
  assert.match(html, /id="update-action"/u)
  assert.match(html, /id="open-release"/u)
  assert.match(html, /id="remove-quarantine"/u)

  assert.match(source, /function renderUpdateStatus\(status: UpdateStatus\)/u)
  assert.match(source, /window\.api\.getUpdateStatus\(\)/u)
  assert.match(source, /window\.api\.onUpdateStatusChanged\(renderUpdateStatus\)/u)
  assert.match(source, /window\.api\.checkForUpdates\(\)/u)
  assert.match(source, /window\.api\.downloadUpdate\(\)/u)
  assert.match(source, /window\.api\.installUpdate\(\)/u)
  assert.match(source, /window\.api\.removeMacOSQuarantine\(\)/u)
  assert.match(source, /status\.phase === 'manual-downloaded'/u)
  assert.match(source, /status\.manualDownloadAvailable === true/u)
  assert.match(source, /const manualDownloadActionAvailable = hasManualDownload/u)
  assert.doesNotMatch(source, /status\.installMode === 'manual'\) await removeMacOSQuarantine\(\)/u)
  assert.match(source, /已下载到“下载”文件夹/u)

  assert.match(css, /\.update-actions\s*\{[\s\S]*display:\s*flex/u)
  assert.match(css, /\.update-progress/u)
  assert.match(css, /var\(--status-success\)/u)
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}/u)
})
