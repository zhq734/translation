import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { readMainSource } from './helpers/mainSource.ts'

const mainSource = readMainSource()
const managerSource = readFileSync('src/main/documentWorkspaceWindow.ts', 'utf8')

/**
 * 截取源码中指定函数的完整片段。
 * @param source 待检索源码。
 * @param signature 函数签名起始片段。
 * @returns 从签名到函数结束的源码。
 * @author zhenghq
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end + 2)
}

/**
 * 去掉源码注释，避免注释中的说明文字干扰行为断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

test('外部划词快捷键和拖拽入口都必须隔离后台文档工作台', () => {
  const hotkeySource = stripComments(
    extractFunction(mainSource, 'function onHotkey(): void {')
  )
  const scheduleSource = stripComments(
    extractFunction(mainSource, 'function scheduleSelectionAction(')
  )

  assert.match(hotkeySource, /documentWorkspace\?\.suspendForExternalSelection\(process\.platform\)/u,
    '快捷键取词必须在弹窗显隐前隐藏后台文档工作台')
  assert.match(scheduleSource, /documentWorkspace\?\.suspendForExternalSelection\(process\.platform\)/u,
    '拖拽与双击划词必须在弹窗显隐前隐藏后台文档工作台')
})

test('文档工作台只隐藏失焦后台窗口，并在隔离期拦截迟到 show', () => {
  const suspendSource = stripComments(extractFunction(
    managerSource,
    'suspendForExternalSelection(platform: NodeJS.Platform): boolean {'
  ))
  const showListenerStart = managerSource.indexOf("window.on('show'")
  const showListenerEnd = managerSource.indexOf("window.on('move'", showListenerStart)

  assert.match(suspendSource, /platform\s*!==\s*'darwin'/u,
    '仅 macOS 需要隔离普通窗口，避免影响其它平台的划词行为')
  assert.match(suspendSource, /isVisible\(\)[\s\S]*?isFocused\(\)[\s\S]*?isMinimized\(\)/u,
    '隔离前必须复核窗口可见、未聚焦且未最小化')
  assert.match(suspendSource, /hiddenForSelection\s*=\s*true[\s\S]*?\.hide\(\)/u,
    '必须先登记隔离状态再隐藏文档窗口')
  assert.ok(showListenerStart >= 0 && showListenerEnd > showListenerStart,
    '文档窗口必须注册独立的 show 生命周期兜底')
  const showListener = stripComments(managerSource.slice(showListenerStart, showListenerEnd))
  assert.match(showListener, /hiddenForSelection/u,
    '迟到 show 必须检查文档工作台是否仍处于划词隔离期')
  assert.match(showListener, /\.hide\(\)/u,
    '隔离期内任何迟到 show 都必须立即重新隐藏文档窗口')
})

test('所有文档工作台显式入口都必须先解除划词隔离', () => {
  const popupEntry = stripComments(
    extractFunction(mainSource, 'function openDocumentWorkspaceFromPopup(): void {')
  )
  const shortcutEntry = stripComments(
    extractFunction(mainSource, 'function openDocumentWorkspaceFromShortcut(): void {')
  )
  const openSource = stripComments(
    extractFunction(managerSource, 'async open(options: { bringToFront?: boolean } = {}): Promise<void> {')
  )
  const focusSource = stripComments(
    extractFunction(managerSource, 'focusOrOpenExistingWindow(): boolean {')
  )

  assert.match(openSource, /resumeAfterExternalSelection\(\)[\s\S]*?ensureWindow\(\)/u,
    '文档工作台 open() 必须在创建或显示窗口前解除隔离')
  assert.match(focusSource, /resumeAfterExternalSelection\(\)[\s\S]*?\.show\(\)/u,
    '全局快捷键复用已有文档工作台前必须解除隔离')
  assert.match(popupEntry, /getDocumentWorkspace\(\)\.open/u,
    '弹窗、菜单和提示栏入口必须继续经过 open() 显式打开文档工作台')
  assert.match(shortcutEntry, /focusOrOpenExistingWindow\(\)/u,
    '全局快捷键必须继续经过能解除隔离的聚焦入口')
})

test('文档窗口销毁时必须复位划词隔离标记', () => {
  const closedStart = managerSource.indexOf("window.on('closed'")
  const closedEnd = managerSource.indexOf('/**', closedStart)
  assert.ok(closedStart >= 0 && closedEnd > closedStart, '必须存在文档窗口 closed 生命周期')
  const closedListener = stripComments(managerSource.slice(closedStart, closedEnd))

  assert.match(closedListener, /hiddenForSelection\s*=\s*false/u,
    '窗口销毁后必须清理隔离标记，避免新窗口继承旧状态')
})
