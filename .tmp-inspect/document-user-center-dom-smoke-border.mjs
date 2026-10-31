import { app, BrowserWindow, ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = '/Users/mac/E/github/translation'
const model = JSON.parse(readFileSync('/tmp/user-center-model.json', 'utf8'))
const samplePdf = readFileSync(join(root, 'tests/fixtures/document/sample.pdf'))
const settings = { themePreset: 'sakura', themeMode: 'light', uiLocale: 'zh-CN', sourceLanguage: 'auto', targetLanguage: 'zh-CN' }
ipcMain.on('i18n:get-current-locale', (event) => { event.returnValue = 'zh-CN' })
ipcMain.on('app:get-win7-compatibility', (event) => { event.returnValue = false })
ipcMain.handle('settings:get', () => settings)
ipcMain.handle('document:get-platform-capability', () => ({ supported: true }))
ipcMain.handle('window:is-maximized', () => false)
ipcMain.handle('document:get-source', () => ({ ok: true, mimeType: 'application/pdf', bytes: new Uint8Array(samplePdf) }))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1800, height: 1000, show: false, webPreferences: { preload: join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  await win.loadFile(join(root, 'out/renderer/document.html'))
  await win.webContents.executeJavaScript(`new Promise((resolve) => { const deadline=Date.now()+3000; const wait=()=>document.documentElement.hasAttribute('data-i18n-pending')&&Date.now()<deadline?setTimeout(wait,25):resolve(true); wait() })`)
  await win.webContents.executeJavaScript(`(() => { document.getElementById('document-workbench').hidden=false; document.getElementById('document-upload-panel').hidden=true; return true })()`)
  const generation = Number(await win.webContents.executeJavaScript(`sessionStorage.getItem('selection-translator.document-generation') ?? '0'`))
  const snapshot = {
    jobId: 'user-center-smoke', generation,
    task: { jobId: 'user-center-smoke', generation, status: 'completed', phase: 'layout', phaseCompleted: true, progress: { completed: 1, total: 1 }, cancellationRequested: false, failedBlocks: 0, warningCount: 0 },
    percent: 100, source: model, translation: model
  }
  win.webContents.send('document:progress', snapshot)
  await new Promise((resolve) => setTimeout(resolve, 1800))
  const result = await win.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('#document-translation-content .document-page')
    const wrappers = Array.from(page?.querySelectorAll('.document-table-block') ?? [])
    const wrapper = wrappers.find((item) => item.querySelectorAll('tbody tr').length === 8) ?? wrappers[1]
    const table = wrapper?.querySelector('table')
    const rows = Array.from(table?.querySelectorAll('tbody tr') ?? [])
    const lastRow = rows.at(-1)
    const cells = Array.from(lastRow?.querySelectorAll('td') ?? [])
    const pageRect = page?.getBoundingClientRect()
    const wrapperRect = wrapper?.getBoundingClientRect()
    const tableRect = table?.getBoundingClientRect()
    const rowRect = lastRow?.getBoundingClientRect()
    const cellInfo = cells.map((cell) => { const s=getComputedStyle(cell); const r=cell.getBoundingClientRect(); return { text:cell.textContent, rect:{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}, borderTop:s.borderTop, borderBottom:s.borderBottom, borderBottomColor:s.borderBottomColor, overflow:s.overflow, position:s.position } })
    const verticalShapes = Array.from(page?.querySelectorAll('.document-shape-block[data-line-orientation="vertical"]') ?? []).map((el) => ({ id:el.dataset.blockId, rect:el.getBoundingClientRect().toJSON(), top:getComputedStyle(el).top, left:getComputedStyle(el).left, height:getComputedStyle(el).height }))
    return {
      devicePixelRatio,
      page: pageRect?.toJSON(), wrapper: wrapperRect?.toJSON(), table: tableRect?.toJSON(), lastRow: rowRect?.toJSON(),
      wrapperClientHeight: wrapper?.clientHeight, wrapperScrollHeight: wrapper?.scrollHeight, wrapperClientWidth: wrapper?.clientWidth, wrapperScrollWidth: wrapper?.scrollWidth,
      wrapperOverflowX: wrapper ? getComputedStyle(wrapper).overflowX : null, wrapperOverflowY: wrapper ? getComputedStyle(wrapper).overflowY : null,
      tableBorder: table ? getComputedStyle(table).border : null, tableBorderCollapse: table ? getComputedStyle(table).borderCollapse : null,
      cellCount: cells.length, cells: cellInfo, verticalShapes,
      followingBlocks: Array.from(page?.children ?? []).slice(-6).map((el) => ({ className: el.className, id: el.dataset.blockId, rect: el.getBoundingClientRect().toJSON() }))
    }
  })()`)
  console.log(JSON.stringify(result, null, 2))
  const image = await win.webContents.capturePage()
  writeFileSync('/tmp/user-center-dom-smoke.png', image.toPNG())
  win.destroy(); app.quit()
}).catch((error) => { console.error(error); app.exit(1) })
