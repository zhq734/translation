import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const indexSource = readFileSync('src/main/index.ts', 'utf8')
const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const selectionButtonSource = readFileSync('src/main/selectionButton.ts', 'utf8')
const macForegroundSource = readFileSync('src/main/macForeground.ts', 'utf8')

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

/**
 * 去掉源码中的块注释与行注释，避免注释文本干扰行为断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

/**
 * 校验 macOS 点击“译”按钮后必须先交还前台再注入复制键。
 * 点击按钮会让本应用成为最前应用，若不交还，注入的 Command+C 会打在
 * 翻译弹窗上而不是 Chrome，剪贴板哨兵不变，最终报取词超时。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 按钮取词必须先交还前台再取词', () => {
  const src = extractFunction(
    indexSource,
    'async function translateSelectionButton(): Promise<void> {'
  )

  assert.match(src, /restoreFrontmostAppForCapture\(\)/u, '按钮取词必须尝试精确交还前台')
  assert.match(src, /waitForFrontmostAppReturn\(\)/u, '交还后必须等待前台真正切换完成')
  assert.ok(
    src.indexOf('restoreFrontmostAppForCapture()') < src.indexOf('consumePreparedBounded()'),
    '交还必须发生在消费预取与复制取词之前'
  )
  assert.ok(
    src.indexOf('waitForFrontmostAppReturn()') < src.indexOf('consumePreparedBounded()'),
    '等待前台交还必须发生在消费预取与复制取词之前'
  )
})

/**
 * 校验划词阶段就记录源应用，避免用户点击“译”按钮后本应用已成最前应用，
 * 此时再读取快照只会读到自身，导致没有可交还目标、复制取词超时。
 * @returns 无返回值。
 * @author zhenghq
 */
test('划词显示按钮前必须记录源应用', () => {
  const src = extractFunction(indexSource, 'function scheduleSelectionAction(')

  assert.match(src, /rememberFrontmostAppIfInactive\(\)/u, '划词阶段必须记录源应用')
  assert.ok(
    src.indexOf('rememberFrontmostAppIfInactive()') < src.indexOf('showSelectionButton('),
    '记录源应用必须发生在显示“译”按钮之前'
  )
})

/**
 * 校验“译”按钮窗口支持在整应用隐藏后按待处理锚点恢复显示。
 * app.hide() 会连同按钮窗口一起隐藏，若此时 showInactive 被吞掉且清空
 * pendingAnchor，按钮将永远不再出现，用户表现为划词后“译”按钮消失。
 * @returns 无返回值。
 * @author zhenghq
 */
test('“译”按钮必须支持按待处理锚点恢复显示', () => {
  assert.match(
    selectionButtonSource,
    /export function restoreSelectionButtonIfPending\(/u,
    '必须导出按钮恢复入口供整应用隐藏后调用'
  )

  const showReady = stripComments(
    extractFunction(selectionButtonSource, 'function showReadySelectionButton(')
  )
  assert.doesNotMatch(
    showReady,
    /pendingAnchor = null/u,
    '显示按钮时不得直接清空待处理锚点，否则 app.hide 期间会被永久丢失'
  )
})

/**
 * 校验安全让出前台后必须恢复被 app.hide() 隐藏的“译”按钮。
 * @returns 无返回值。
 * @author zhenghq
 */
test('安全让出前台恢复应用后必须重放待显示的“译”按钮', () => {
  const src = extractFunction(
    macForegroundSource,
    'export function yieldFrontmostAppThen('
  )

  assert.match(src, /restoreSelectionButtonIfPending\(\)/u, 'app.show() 后必须恢复待显示的按钮')
  assert.ok(
    src.indexOf('app.show()') < src.indexOf('restoreSelectionButtonIfPending()'),
    '恢复按钮必须发生在 app.show() 之后'
  )
})

/**
 * 校验 macOS 按钮取词主动交还前台期间必须抑制弹窗失焦自动关闭。
 * 点击“译”按钮会让本应用成为最前应用，随后 open -b 源应用会让刚显示的
 * 读取弹窗收到 blur；若不标记为内部动作，handlePopupBlur 会误判为用户
 * 点击外部并调用 hidePopup，表现为弹窗一闪即关。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 按钮取词交还前台期间必须抑制弹窗失焦关闭', () => {
  assert.match(
    popupSource,
    /export function beginPopupForegroundRestoreForCapture\(/u,
    '必须提供进入交还失焦抑制的入口'
  )
  assert.match(
    popupSource,
    /export function endPopupForegroundRestoreForCapture\(/u,
    '必须提供解除交还失焦抑制的入口'
  )

  const src = extractFunction(
    indexSource,
    'async function translateSelectionButton(): Promise<void> {'
  )
  const beginIndex = src.indexOf('beginPopupForegroundRestoreForCapture()')
  const popupIndex = src.indexOf('showSelectionReadingPopup(anchor)')
  const restoreIndex = src.indexOf('restoreFrontmostAppForCapture()')
  const endIndex = src.indexOf('endPopupForegroundRestoreForCapture()')
  assert.ok(beginIndex >= 0 && beginIndex < popupIndex,
    '必须在显示读取弹窗前进入失焦抑制，避免显示瞬间的 blur 漏抑制')
  assert.ok(popupIndex < restoreIndex,
    '必须先显示读取弹窗再交还前台')
  assert.ok(endIndex > restoreIndex,
    '取词流程结束后必须解除失焦抑制，避免后续点击外部无法关闭弹窗')

  const guardSource = extractFunction(
    popupSource,
    'function isRestoringForeground(): boolean {'
  )
  assert.match(
    guardSource,
    /captureForegroundRestoreActive/u,
    '失焦抑制判定必须覆盖按钮取词的整个交还窗口'
  )
})

/**
 * 校验选区取词进入翻译阶段时加载弹窗仍保持非激活。
 * 取词成功后 translateText 若立刻调用 win.show()，会与尚未完成的 open -b 交还前台
 * 竞争：随后到达的 blur 在取词抑制解除后触发，弹窗会被误判为点击外部而关闭。
 * 加载态保持非激活，等最终翻译结果到达后再激活即可避开这段竞态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('选区取词加载弹窗不得在交还前台完成前重新激活', () => {
  const src = extractFunction(indexSource, 'async function translateText(')
  const loadingCallIndex = src.indexOf('showPopup(')
  const loadingCallEnd = src.indexOf('try {', loadingCallIndex)
  assert.ok(loadingCallIndex >= 0 && loadingCallEnd > loadingCallIndex,
    'translateText 应包含首次加载态 showPopup 调用')

  const loadingCall = src.slice(loadingCallIndex, loadingCallEnd)
  assert.match(
    loadingCall,
    /origin !== 'selection'/u,
    '选区取词的加载态必须以非激活方式显示，避免与前台交还竞争'
  )
})
