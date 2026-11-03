import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const mainSource = readFileSync('src/main/index.ts', 'utf8')

/**
 * 从源码中截取指定函数的完整片段。
 * @param source 源码。
 * @param signature 函数签名起始片段。
 * @returns 从签名到函数结束的源码。
 * @author zhenghq
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end + 2)
}

/**
 * 去掉源码注释，避免注释文本干扰行为断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

test('新弹窗显示必须使上一轮关闭异步回调整体失效', () => {
  const showSource = stripComments(
    extractFunction(popupSource, 'export function showPopup(')
  )
  const hideSource = stripComments(
    extractFunction(popupSource, 'export function hidePopup(')
  )

  assert.match(popupSource, /let popupLifecycleToken = 0/u,
    '弹窗必须维护生命周期 token')
  assert.match(showSource, /popupLifecycleToken \+= 1/u,
    'showPopup 必须开启新的生命周期')
  assert.match(hideSource, /const closeToken = \+\+popupLifecycleToken/u,
    'hidePopup 入口必须取得独占关闭 token')
  assert.match(hideSource, /closeToken !== popupLifecycleToken/u,
    '关闭异步收尾必须先校验自己仍是当前关闭轮次')
})

test('旧关闭轮次不得隐藏新弹窗或清理新轮次状态', () => {
  const hideSource = stripComments(
    extractFunction(popupSource, 'export function hidePopup(')
  )
  const runStart = hideSource.indexOf('const run = (): void => {')
  const runEnd = hideSource.indexOf('\n  }', runStart)
  const runSource = hideSource.slice(runStart, runEnd)

  assert.ok(runStart >= 0 && runEnd > runStart, '关闭收尾函数应存在')
  assert.match(runSource, /if \(closeToken !== popupLifecycleToken\) return/u,
    '收尾入口必须拒绝旧关闭轮次')
  assert.ok(
    runSource.indexOf('closeToken !== popupLifecycleToken') < runSource.indexOf('win?.hide()'),
    'token 校验必须早于 win.hide()'
  )
  assert.ok(
    runSource.indexOf('closeToken !== popupLifecycleToken') <
      runSource.indexOf('popupCloseInFlight = false'),
    'token 校验必须早于清理关闭进行中状态'
  )
})

test('关闭生命周期回调必须携带轮次 token', () => {
  assert.match(popupSource, /onPopupCloseStart\?:\s*\(token:\s*number\)\s*=>\s*void/u)
  assert.match(popupSource, /onPopupCloseEnd\?:\s*\(token:\s*number\)\s*=>\s*void/u)
  assert.match(
    popupSource,
    /onPopupCloseEndBeforeHideRestore\?:\s*\(token:\s*number\)\s*=>\s*void/u
  )
  assert.match(
    popupSource,
    /onFrontRecheckComplete\?:\s*\(token:\s*number,\s*restored:\s*boolean\)\s*=>\s*void/u
  )
  assert.match(
    popupSource,
    /onPopupCloseCancelled\?:\s*\(token:\s*number\)\s*=>\s*void/u,
    '新一轮显示必须能通知上一轮关闭释放其租约'
  )
})

test('主进程焦点恢复槽必须按关闭 token 校验所有权', () => {
  const code = stripComments(mainSource)

  assert.match(code, /restoreSettingsWindowFocusAfterPopupFrontRecheck:\s*\{[\s\S]*?token:\s*number/u,
    '焦点恢复槽必须记录所属关闭轮次')
  assert.match(code, /onPopupCloseCancelled:\s*handlePopupCloseCancelled/u,
    '主进程必须接收关闭被新显示取消的通知')
})

test('关闭被新显示取消时必须释放旧轮次焦点恢复闭包', () => {
  const code = stripComments(
    extractFunction(mainSource, 'function handlePopupCloseCancelled(')
  )

  // 旧实现只把两个槽置空，没有调用恢复闭包；一旦此时没有别的租约持有者，
  // 设置页会永久保持不可聚焦。取消路径必须先释放旧轮次，再清理槽位。
  const restoreHideIndex = code.indexOf('restoreSettingsWindowFocusAfterPopupHide?.()')
  const clearHideIndex = code.indexOf('restoreSettingsWindowFocusAfterPopupHide = null')
  const clearSlotIndex = code.indexOf('restoreSettingsWindowFocusAfterPopupFrontRecheck = null')

  assert.ok(restoreHideIndex >= 0, '取消路径必须执行关闭开始阶段取得的恢复闭包')
  assert.ok(clearHideIndex > restoreHideIndex, '恢复闭包执行后才能清空关闭槽')
  assert.ok(clearSlotIndex > restoreHideIndex, '恢复闭包执行后才能清空复核槽')
  // 关闭开始时只建立一个底层租约，关闭槽与复核槽不能各自重复调用恢复闭包；
  // 否则引用计数会被提前减到零，等于把最后一个持有者也释放掉。
  assert.equal(
    code.match(/restoreSettingsWindowFocusAfterPopupHide\?\.\(\)/gu)?.length,
    1,
    '取消路径只能释放一次关闭阶段取得的租约'
  )
})

test('旧关闭轮次取消时不得越过仍在进行的划词交互释放共享租约', () => {
  const code = stripComments(
    extractFunction(mainSource, 'function handlePopupCloseCancelled(')
  )

  assert.doesNotMatch(code, /releaseSelectionFocusLeaseForPopupToken\(/u,
    '关闭轮次 token 不能直接决定划词生命周期租约的释放')
  assert.match(code, /releaseSelectionFocusLeaseIfIdle\(\)/u,
    '取消路径必须等划词交互、按钮与弹窗全部空闲后再释放共享租约')
})
