import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 从源码中截取指定函数的函数体。
 * @param source 源码。
 * @param signature 函数签名起始片段。
 * @returns 从签名到函数结束的源码片段。
 * @author zhenghq
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end)
}

const webReaderSource = readFileSync('src/main/webReaderWindow.ts', 'utf8')
const mainSource = readFileSync('src/main/index.ts', 'utf8')
const windowControlsSource = readFileSync('src/main/windowControls.ts', 'utf8')
const macForegroundSource = readFileSync('src/main/macForeground.ts', 'utf8')

test('网页翻译关闭前先把 macOS 前台交还给原应用', () => {
  const closeSource = extractFunction(webReaderSource, 'close(): void {')

  assert.match(closeSource, /handBackFrontmostThen\(window, \(\) => \{/u, '关闭阅读器必须复用共享交还逻辑')
  assert.ok(
    closeSource.indexOf('handBackFrontmostThen(') < closeSource.indexOf('window.close()'),
    '必须先交还前台再关闭阅读器窗口'
  )
  assert.match(closeSource, /this\.closingWindow\) return/u, '交还进行中必须短路重复关闭')
})

test('网页翻译窗口关闭事件统一走交还前台逻辑', () => {
  const ensureWindowSource = extractFunction(webReaderSource, 'private async ensureWindow(): Promise<void> {')

  assert.match(
    ensureWindowSource,
    /window\.on\('close',[\s\S]*?if \(this\.allowWindowClose\) return[\s\S]*?event\.preventDefault\(\)[\s\S]*?this\.close\(\)/u,
    '系统或程序化关闭都必须先经过统一关闭入口'
  )
  assert.match(ensureWindowSource, /this\.allowWindowClose = false/u, '创建新窗口时必须复位关闭许可')
})

test('应用退出时直接销毁阅读器，不等待前台交还', () => {
  const disposeSource = extractFunction(webReaderSource, 'dispose(): void {')

  assert.match(disposeSource, /this\.allowWindowClose = true/u, '退出路径必须跳过关闭拦截')
  assert.match(mainSource, /webReader\?\.dispose\(\)/u, 'before-quit 必须使用退出专用清理入口')
})

test('网页翻译标题栏关闭不得绕过阅读器关闭逻辑', () => {
  assert.match(
    windowControlsSource,
    /closeWindow\?\(window: BrowserWindow\): void/u,
    '通用窗口控制必须允许注入自定义关闭处理'
  )
  assert.match(windowControlsSource, /closeWindow\(window\)/u, '标题栏关闭必须调用注入的关闭处理')

  const registration = mainSource.slice(
    mainSource.indexOf('registerWindowControls({'),
    mainSource.indexOf("ipcMain.on('popup:copy'")
  )
  assert.match(registration, /webReader\?\.ownsWindow\(window\)/u, '必须识别阅读器窗口')
  assert.match(registration, /webReader\.close\(\)/u, '阅读器窗口必须走统一关闭逻辑')
})

test('打开网页翻译前记录源应用，供关闭时交还前台', () => {
  const openSource = extractFunction(webReaderSource, 'async open(url?: string): Promise<void> {')

  assert.match(openSource, /await rememberFrontmostAppIfInactiveAsync\(\)/u, '必须等待源应用快照后再显示阅读器')
  assert.ok(
    openSource.indexOf('rememberFrontmostAppIfInactiveAsync()') < openSource.indexOf('ensureWindow()'),
    '记录源应用必须早于阅读器窗口显示'
  )
  assert.match(
    macForegroundSource,
    /export async function rememberFrontmostAppIfInactiveAsync\(\): Promise<void>/u,
    '共享前台模块必须提供可等待的源应用记录入口'
  )
})

test('阅读器关闭刷新 Dock 可见性时不得重复切换激活策略', () => {
  const applyStart = mainSource.indexOf('async function applyMacOSDockVisibility')
  const applyEnd = mainSource.indexOf('\nfunction applyAutoLaunch', applyStart)
  const applyBlock = mainSource.slice(applyStart, applyEnd)

  // 关闭阅读器会触发一次 Dock 刷新；若此时激活策略没有变化却仍重复
  // setActivationPolicy/dock.hide()，系统会再次隐藏窗口，下面的保留逻辑
  // 就会把后台的设置页 show()+focus() 到最前，表现为设置页无缘无故弹出。
  const guardIndex = applyBlock.indexOf('appliedMacOSDockPresentation')
  const applyIndex = applyBlock.indexOf('app.setActivationPolicy(')
  assert.ok(guardIndex >= 0 && guardIndex < applyIndex, '必须在切换激活策略前跳过未变化的呈现方式')
  assert.match(
    applyBlock,
    /appliedMacOSDockPresentation\?\.policy === presentation\.policy[\s\S]*?appliedMacOSDockPresentation\.dockVisible === presentation\.dockVisible[\s\S]*?return/u,
    '呈现方式未变化时必须直接返回'
  )
})

test('网页翻译窗口销毁回调保留资源清理，且隐藏事件不触发前台交还', () => {
  const disposeSource = extractFunction(webReaderSource, 'private disposeWindow(window: BrowserWindow, view: WebContentsView): void {')

  assert.doesNotMatch(disposeSource, /handBackFrontmostThen/u, 'closed 回调只做资源清理，前台交还必须在关闭前完成')
  assert.doesNotMatch(webReaderSource, /window\.on\('hide'/u, '最小化或隐藏阅读器不得触发前台交还')
})

test('其它会激活本应用的托盘入口也要记录源应用，避免设置页被顶到最前', () => {
  const manualSource = extractFunction(mainSource, 'async function openManualTranslation(): Promise<void> {')
  const clipboardSource = extractFunction(mainSource, 'async function translateClipboardImage(): Promise<void> {')

  // 托盘点击时本应用未必已在前台：弹窗 show() 会激活应用，
  // 关闭弹窗时若没有源应用记录，系统会把设置页提升为 key window 顶到最前。
  assert.match(manualSource, /await rememberFrontmostAppIfInactiveAsync\(\)/u, '手动翻译弹窗显示前必须记录源应用')
  assert.ok(
    manualSource.indexOf('rememberFrontmostAppIfInactiveAsync()') < manualSource.indexOf('showManualTranslationPopup()'),
    '记录源应用必须早于手动翻译弹窗显示'
  )
  assert.match(clipboardSource, /await rememberFrontmostAppIfInactiveAsync\(\)/u, '剪贴板图片翻译弹窗显示前必须记录源应用')
  assert.ok(
    clipboardSource.indexOf('rememberFrontmostAppIfInactiveAsync()') < clipboardSource.indexOf('showPopup('),
    '记录源应用必须早于剪贴板图片翻译弹窗显示'
  )
})
