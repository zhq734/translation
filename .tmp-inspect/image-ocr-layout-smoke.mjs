import { app, BrowserWindow, ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = '/Users/mac/E/github/translation'
const imagePath = '/private/tmp/translation-ocr-verify/source-scan-1.png'
const settings = {
  themePreset: 'sakura',
  themeMode: 'light',
  uiLocale: 'zh-CN',
  sourceLanguage: 'auto',
  targetLanguage: 'zh-CN',
  documentTranslationEnabled: true
}

ipcMain.on('i18n:get-current-locale', (event) => { event.returnValue = 'zh-CN' })
ipcMain.on('app:get-win7-compatibility', (event) => { event.returnValue = false })
ipcMain.handle('settings:get', () => settings)
ipcMain.handle('document:get-platform-capability', () => ({ supported: true }))
ipcMain.handle('window:is-maximized', () => false)
ipcMain.handle('document:get-source', () => ({
  ok: true,
  mimeType: 'image/png',
  bytes: new Uint8Array(readFileSync(imagePath))
}))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1800,
    height: 1000,
    show: false,
    webPreferences: {
      preload: join(root, 'out/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  await win.loadFile(join(root, 'out/renderer/document.html'))
  await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const deadline = Date.now() + 3000
    const wait = () => document.documentElement.hasAttribute('data-i18n-pending') && Date.now() < deadline
      ? setTimeout(wait, 25)
      : resolve(true)
    wait()
  })`)
  const result = await win.webContents.executeJavaScript(`(async () => {
    const approved = await window.api.approveDocumentFile(${JSON.stringify(imagePath)})
    return approved
  })()`)
  if (result.status !== 'selected') throw new Error(`approve failed: ${JSON.stringify(result)}`)
  await win.webContents.executeJavaScript(`(async () => {
    const input = document.getElementById('document-file-input')
    const dataTransfer = new DataTransfer()
    const file = new File([new Uint8Array([1])], 'source-scan-1.png', { type: 'image/png' })
    dataTransfer.items.add(file)
    Object.defineProperty(input, 'files', { value: dataTransfer.files, configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const resultInfo = await win.webContents.executeJavaScript(`(() => {
    const tabs = Array.from(document.querySelectorAll('.document-file-tab')).map((tab) => ({ id: tab.dataset.tabId, text: tab.textContent, status: tab.dataset.status }))
    const previews = Array.from(document.querySelectorAll('.document-preview-host')).map((host) => ({ format: host.dataset.documentFormat, kind: host.dataset.previewKind, html: host.innerHTML.slice(0, 300) }))
    return { tabs, previews, workbenchHidden: document.getElementById('document-workbench').hidden }
  })()`)
  console.log(JSON.stringify(resultInfo, null, 2))
  win.destroy()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
