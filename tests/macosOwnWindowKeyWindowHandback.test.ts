import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const indexSource = readFileSync('src/main/index.ts', 'utf8')
const macForegroundSource = readFileSync('src/main/macForeground.ts', 'utf8')

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
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end)
}

/**
 * 去掉源码注释，避免注释文本干扰接线断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

test('macForeground 必须提供「任意自有窗口是否持有 key window」判定', () => {
  // 真机日志（2026-10-13）：取词前只检查弹窗是否持有 key window，漏掉了设置页
  // 等自有普通窗口持有 key window 的场景。此时注入的 Command+C 会打给设置页而
  // 不是源应用，剪贴板哨兵不变，最终报「取词超时」。
  const ownSource = stripComments(
    extractFunction(macForegroundSource, 'export function isOwnWindowHoldingKeyWindow(')
  )
  assert.match(ownSource, /BrowserWindow\.getFocusedWindow\(\)/u,
    '必须读取真实 key window 归属，不能只看弹窗')
  assert.doesNotMatch(ownSource, /isPopupHoldingKeyWindow/u,
    '判定不得退化为仅检查弹窗')
})

test('macForeground 必须覆盖「焦点窗口为空但应用仍最前」的取词交还假阴性', () => {
  const ownSource = stripComments(
    extractFunction(macForegroundSource, 'export function isOwnWindowHoldingKeyWindow(')
  )
  // 真机日志（2026-10-13）：读取弹窗以 showInactive 显示后
  // BrowserWindow.getFocusedWindow() 可能返回 null，此时仍可能已有源应用记录。
  // 判定必须把「存在待交还源应用记录」纳入条件，不能只依赖 focused window，
  // 否则取词前会静默跳过交还，Cmd+C 被应用内 panel 吞掉而超时。
  assert.match(ownSource, /pendingReturnApp/u,
    '焦点窗口为空但存在源应用记录时也必须判定需要交还')
})

test('取词前交还必须覆盖任意自有窗口，并在无记录时退化为 blur', () => {
  const handBackSource = stripComments(
    extractFunction(macForegroundSource, 'export async function handBackKeyWindowToFrontmostApp(')
  )
  // 有源应用记录时优先精确激活源应用；没有记录时只能 blur，避免复制键继续打在自有窗口。
  assert.match(handBackSource, /activateFrontmostApp\(/u,
    '有源应用记录时必须精确激活源应用')
  assert.match(handBackSource, /\.blur\(\)/u,
    '无源应用记录或激活失败时必须退化为 blur 自有窗口')
  assert.match(handBackSource, /BrowserWindow\.getFocusedWindow\(\)/u,
    '交还前后必须按真实 key window 归属判定与复核')
})

test('按钮取词入口必须交还任意自有窗口持有的 key window', () => {
  const buttonSource = stripComments(
    extractFunction(indexSource, 'async function translateSelectionButton(): Promise<void> {')
  )
  assert.match(buttonSource, /isOwnWindowHoldingKeyWindow\(\)/u,
    '按钮取词必须检查任意自有窗口的 key window 归属')
  assert.match(buttonSource, /handBackKeyWindowToFrontmostApp\(\)/u,
    '按钮取词必须在注入复制键前完成 key window 交还')
})

test('自动模式与快捷键共用取词入口必须交还任意自有窗口持有的 key window', () => {
  const queueSource = stripComments(
    extractFunction(indexSource, 'async function queueSelectionTranslation(')
  )
  assert.match(queueSource, /isOwnWindowHoldingKeyWindow\(\)/u,
    '自动模式取词必须检查任意自有窗口的 key window 归属')
  assert.match(queueSource, /handBackKeyWindowToFrontmostApp\(\)/u,
    '自动模式取词必须在注入复制键前完成 key window 交还')
})
