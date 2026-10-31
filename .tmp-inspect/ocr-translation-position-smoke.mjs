import { app, BrowserWindow, ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = '/Users/mac/E/github/translation'
const imagePath = '/private/tmp/translation-ocr-verify/screenshot-1.png'
const imageBytes = readFileSync(imagePath)
const settings = {
  themePreset: 'sakura',
  themeMode: 'light',
  uiLocale: 'zh-CN',
  sourceLanguage: 'auto',
  targetLanguage: 'zh-CN',
  documentTranslationEnabled: true
}

/**
 * 构造只包含一张图片的文档模型，供 OCR 覆盖层真实渲染验证。
 * @param translated 是否为译文侧模型。
 * @returns 文档模型。
 * @author zhenghq
 */
function createModel(translated) {
  const regions = [
    ['nav-report', 0.024, 0.135, 0.078, 0.02, 'Reports', '报表'],
    ['nav-account', 0.024, 0.185, 0.082, 0.02, 'Accounts', '账号'],
    ['nav-checkin', 0.024, 0.225, 0.088, 0.02, 'Check-in Center', '签到中心'],
    ['nav-model', 0.024, 0.305, 0.09, 0.02, 'Model Management', '模型管理'],
    ['nav-network', 0.024, 0.405, 0.085, 0.02, 'Network Proxy', '网络代理'],
    ['nav-key', 0.024, 0.445, 0.075, 0.02, 'Gateway Key', '网关 Key'],
    ['nav-logs', 0.024, 0.555, 0.075, 0.02, 'Request Logs', '请求日志'],
    ['nav-jobs', 0.024, 0.63, 0.08, 0.02, 'Scheduled Tasks', '定时任务'],
    ['nav-settings', 0.024, 0.705, 0.06, 0.02, 'Settings', '设置']
  ].map(([regionId, x, y, width, height, text, translatedText]) => ({
    regionId,
    pageId: 'page-1',
    blockId: 'image-1',
    assetId: 'image-1',
    bbox: { x, y, width, height },
    text,
    translatedText: translated ? translatedText : undefined,
    confidence: 0.99,
    status: 'recognized'
  }))
  return {
    schemaVersion: 1,
    documentId: 'ocr-position-smoke',
    source: {
      path: imagePath,
      fileName: 'screenshot-1.png',
      format: 'image',
      sha256: 'smoke',
      size: imageBytes.byteLength
    },
    metadata: { direction: 'ltr' },
    pages: [{
      pageId: 'page-1',
      index: 0,
      width: 1750,
      height: 980,
      blocks: [{
        blockId: 'image-1',
        kind: 'image',
        readingOrder: 0,
        translatable: false,
        bbox: { x: 0, y: 0, width: 1750, height: 980 },
        assetId: 'image-1',
        ocrRegions: regions
      }]
    }],
    assets: [{
      assetId: 'image-1',
      kind: 'image',
      mimeType: 'image/png',
      sha256: 'smoke',
      byteLength: imageBytes.byteLength,
      width: 1750,
      height: 980
    }],
    warnings: []
  }
}

ipcMain.on('i18n:get-current-locale', (event) => { event.returnValue = 'zh-CN' })
ipcMain.on('app:get-win7-compatibility', (event) => { event.returnValue = false })
ipcMain.handle('settings:get', () => settings)
ipcMain.handle('document:get-platform-capability', () => ({ supported: true }))
ipcMain.handle('window:is-maximized', () => false)
ipcMain.handle('document:list-history', () => [])
ipcMain.handle('document:select-files', () => [{
  status: 'selected',
  path: imagePath,
  fileName: 'screenshot-1.png',
  size: imageBytes.byteLength,
  format: 'image',
  sha256: 'smoke'
}])
ipcMain.handle('document:run', (_event, request) => ({
  accepted: true,
  jobId: 'ocr-position-smoke'
}))
ipcMain.handle('document:cancel', () => true)
ipcMain.handle('document:release', () => true)
ipcMain.handle('document:get-asset', () => ({
  ok: true,
  mimeType: 'image/png',
  bytes: new Uint8Array(imageBytes)
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
  // 工作台初始化包含多个异步 IPC；上传监听挂载晚于 aria-disabled 更新，因此轮询点击直到 Tab 真正创建。
  const tabCreated = await win.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const dropZone = document.getElementById('document-drop-zone')
      if (dropZone?.getAttribute('aria-disabled') === 'false') dropZone.click()
      for (let index = 0; index < 24; index += 1) {
        if (document.querySelector('.document-file-tab')) return true
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    return false
  })()`)
  if (!tabCreated) throw new Error('文档 Tab 未创建，上传初始化仍未完成')
  const generation = Number(await win.webContents.executeJavaScript(
    `sessionStorage.getItem('selection-translator.document-generation') ?? '0'`
  ))
  const source = createModel(false)
  const translation = createModel(true)
  const snapshot = {
    jobId: 'ocr-position-smoke',
    generation,
    task: {
      jobId: 'ocr-position-smoke',
      generation,
      status: 'completed',
      phase: 'layout',
      phaseCompleted: true,
      progress: { completed: 9, total: 9 },
      cancellationRequested: false,
      failedBlocks: 0,
      warningCount: 0
    },
    percent: 100,
    source,
    translation
  }
  win.webContents.send('document:progress', snapshot)
  const rendered = await win.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (document.querySelector('#document-translation-content .document-ocr-region')) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  })()`)
  if (!rendered) throw new Error('OCR 译文覆盖层未渲染')
  await new Promise((resolve) => setTimeout(resolve, 300))
  const result = await win.webContents.executeJavaScript(`(() => {
    const imageBlock = document.querySelector('#document-translation-content .document-image-block')
    const layer = imageBlock?.querySelector('.document-ocr-translation-layer')
    const imageRect = imageBlock?.getBoundingClientRect()
    const layerRect = layer?.getBoundingClientRect()
    const regions = Array.from(layer?.querySelectorAll('.document-ocr-region') ?? []).map((region) => {
      const rect = region.getBoundingClientRect()
      const sourceWidthRatio = Number.parseFloat(
        getComputedStyle(region).getPropertyValue('--document-ocr-source-width')
      ) / 100
      const background = getComputedStyle(region).backgroundImage
      return {
        id: region.dataset.regionId,
        text: region.textContent,
        left: region.style.left,
        width: region.style.width,
        top: region.style.top,
        sourceWidthRatio,
        sourceBackgroundWidth: rect.width * sourceWidthRatio,
        renderedWidth: rect.width,
        rect: rect.toJSON(),
        background
      }
    })
    return {
      tabs: Array.from(document.querySelectorAll('.document-file-tab')).map((tab) => ({
        text: tab.textContent,
        status: tab.dataset.status
      })),
      workbenchHidden: document.getElementById('document-workbench').hidden,
      uploadStatus: document.getElementById('document-upload-status').textContent,
      image: imageRect?.toJSON(),
      layer: layerRect?.toJSON(),
      regions
    }
  })()`)
  console.log(JSON.stringify(result, null, 2))
  const expandedRegions = result.regions.filter((region) => region.sourceWidthRatio < 1)
  if (expandedRegions.length === 0) {
    throw new Error('OCR 冒烟未产生横向扩宽区域，无法验证白底遮挡修复')
  }
  for (const region of expandedRegions) {
    if (!(region.sourceWidthRatio > 0 && region.sourceWidthRatio < 1)) {
      throw new Error(`OCR 区域 ${region.id} 的白底比例非法：${region.sourceWidthRatio}`)
    }
    if (!region.background.includes('linear-gradient')) {
      throw new Error(`OCR 区域 ${region.id} 未使用按原框宽度绘制的渐变白底`)
    }
  }
  const image = await win.webContents.capturePage()
  writeFileSync('/private/tmp/translation-ocr-verify/fixed-layout-smoke.png', image.toPNG())
  win.destroy()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
