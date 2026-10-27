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
  // 读取弹窗以 showInactive 显示后 BrowserWindow.getFocusedWindow() 可能返回 null；
  // 此时必须依据应用激活事件判断本应用是否仍占用前台，而不能依据源应用记录。
  assert.match(ownSource, /isMacAppActiveByEvents\(\)/u,
    '焦点窗口为空但应用仍最前时也必须判定需要交还')
  assert.doesNotMatch(ownSource, /pendingReturnApp/u,
    '源应用记录不能作为再次激活源应用的依据')
})

/**
 * 校验存在源窗口记录本身不会触发取词前的重复激活。
 * 微信仍在前台时，记录只用于结果弹窗收尾；此时再次 open -b 会切换微信窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('源应用仍在最前时不得仅因存在交还记录而重复激活', () => {
  const ownSource = stripComments(
    extractFunction(macForegroundSource, 'export function isOwnWindowHoldingKeyWindow(')
  )
  assert.doesNotMatch(ownSource, /return ownWindowFocused \|\| Boolean\(pendingReturnApp\)/u,
    '应用激活事件表明源应用仍在最前时，不能把 pendingReturnApp 当作自有窗口持焦')
  assert.match(ownSource, /isMacAppActiveByEvents\(\)/u,
    '是否真的需要交还必须结合应用激活事件判断')
})

/**
 * 校验一次取词只允许入口层完成一次源窗口激活。
 * @returns 无返回值。
 * @author zhenghq
 */
test('按钮取词不得在入口交还后由复制链路再次激活源窗口', () => {
  const buttonSource = stripComments(
    extractFunction(indexSource, 'async function translateSelectionButton(): Promise<void> {')
  )
  assert.doesNotMatch(buttonSource, /captureByCopy|activateWindowBeforeCopy/u,
    '按钮入口负责激活时，复制链路不得再次激活')
})

test('取词前交还必须覆盖任意自有窗口，并在无记录时退化为 blur', () => {
  const handBackSource = stripComments(
    extractFunction(macForegroundSource, 'export async function handBackKeyWindowToFrontmostApp(')
  )
  // 有源应用记录时优先通过统一入口精确激活源窗口；没有记录时只能 blur，
  // 避免复制键继续打在自有窗口。统一入口会拒绝把窗口定位失败误退化为
  // 应用级 open -b，从而避免同进程的另一个窗口被切到最前。
  assert.match(handBackSource, /activateFrontmostSnapshot\(/u,
    '有源应用记录时必须通过统一入口精确激活源窗口')
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
