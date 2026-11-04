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
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end)
}

const captureSource = readFileSync('src/main/capture.ts', 'utf8')
const mainSource = readFileSync('src/main/index.ts', 'utf8')

test('辅助功能权限检查必须支持无提示轮询', () => {
  const checkSource = extractFunction(
    captureSource,
    'export async function checkAccessibilityPermission('
  )

  assert.match(
    checkSource,
    /checkAccessibilityPermission\(\s*prompt\s*=\s*true\s*\)/u,
    '权限检查应默认保留现有提示行为，并允许调用方关闭提示'
  )
  assert.match(
    checkSource,
    /isTrustedAccessibilityClient\(prompt\)/u,
    '系统权限检查必须使用调用方传入的提示参数'
  )
})

test('非快捷键模式启动监听时必须登记授权完成后的恢复流程', () => {
  const applySource = extractFunction(mainSource, 'function applySelectionListener(): void {')

  assert.match(
    applySource,
    /if \(triggerMode === 'hotkey'\)[\s\S]*?cancelAccessibilityAuthorizationRecovery\(\)[\s\S]*?else[\s\S]*?beginAccessibilityAuthorizationRecovery\(\)/u,
    '快捷键模式应取消恢复，按钮与自动模式应登记授权恢复'
  )
})

test('授权恢复只能存在一个轮询且必须使用无提示权限检查', () => {
  const beginSource = extractFunction(
    mainSource,
    'async function beginAccessibilityAuthorizationRecovery(): Promise<void> {'
  )
  const pollSource = extractFunction(
    mainSource,
    'async function pollAccessibilityAuthorizationRecovery('
  )

  assert.match(beginSource, /if \(!isMac\)/u, '恢复流程只适用于 macOS')
  assert.match(
    beginSource,
    /getSettings\(\)\.triggerMode === 'hotkey'/u,
    '快捷键模式不需要辅助功能监听，不应登记恢复'
  )
  assert.match(
    beginSource,
    /if \(accessibilityAuthorizationRecovery\) return/u,
    '重复启动监听不得创建多个恢复轮询'
  )
  assert.match(
    beginSource,
    /checkAccessibilityPermission\(false\)/u,
    '登记恢复时必须先做一次无提示权限检查'
  )
  assert.match(
    beginSource,
    /try \{[\s\S]*?checkAccessibilityPermission\(false\)[\s\S]*?\} catch[\s\S]*?cancelAccessibilityAuthorizationRecovery\(\)/u,
    '首次权限检查异常时必须清理恢复状态，避免残留登记阻断后续重试'
  )
  assert.match(
    pollSource,
    /checkAccessibilityPermission\(false\)/u,
    '轮询不得反复触发系统授权弹窗'
  )
})

test('检测到授权完成后必须重启全局监听并显式恢复设置页', () => {
  const completeSource = extractFunction(
    mainSource,
    'function completeAccessibilityAuthorizationRecovery(): void {'
  )
  const restartIndex = completeSource.indexOf('selectionListenerController.restart()')
  const openSettingsIndex = completeSource.indexOf('openSettingsFromPopup()')

  assert.ok(restartIndex >= 0, '授权完成后必须重建全局划词监听')
  assert.ok(openSettingsIndex > restartIndex, '监听恢复后必须通过显式入口恢复设置页')
})

test('授权恢复必须有超时兜底并在退出时清理', () => {
  const cancelSource = extractFunction(
    mainSource,
    'function cancelAccessibilityAuthorizationRecovery(): void {'
  )
  const cleanupSource = extractFunction(mainSource, 'function cleanupBeforeQuit(): void {')

  assert.match(
    mainSource,
    /ACCESSIBILITY_AUTHORIZATION_RECOVERY_TIMEOUT_MS\s*=\s*5\s*\*\s*60_000/u,
    '授权恢复必须设置五分钟超时'
  )
  assert.match(cancelSource, /clearTimeout\(recovery\.timer\)/u, '取消恢复时必须清理定时器')
  assert.match(
    cleanupSource,
    /cancelAccessibilityAuthorizationRecovery\(\)/u,
    '应用退出前必须清理授权恢复定时器'
  )
})

test('自动模式未授权提示也必须接入同一恢复流程', () => {
  const warnSource = extractFunction(mainSource, 'async function warnIfNoAccessibility(): Promise<void> {')

  assert.match(
    warnSource,
    /if \(!ok\) \{[\s\S]*?beginAccessibilityAuthorizationRecovery\(\)/u,
    '自动模式权限提示后应等待授权完成并恢复界面'
  )
})
