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

const mainSource = readFileSync('src/main/index.ts', 'utf8')

test('点击菜单栏“译”图标必须把已打开的设置页带到最前', () => {
  const createSource = extractFunction(mainSource, 'async function createSettingsWindow(')

  // 点击菜单栏图标不会像点击 Dock 图标那样激活应用，设置页已可见时会被其它应用遮挡；
  // 因此用户显式打开设置页时必须重新激活应用并显示、聚焦窗口。
  assert.match(
    createSource,
    /if \(settingsWin\.isVisible\(\)\) \{[\s\S]*?if \(!bringToFront\) return settingsWin[\s\S]*?if \(isMac\) app\.focus\(\{ steal: true \}\)[\s\S]*?settingsWin\.show\(\)[\s\S]*?settingsWin\.focus\(\)/u,
    '打开设置页必须激活应用并重新显示、聚焦窗口'
  )
  // 最小化窗口的 isVisible() 仍为 true，必须先恢复再聚焦。
  assert.match(
    createSource,
    /if \(settingsWin\.isMinimized\(\)\) \{[\s\S]*?settingsWin\.restore\(\)[\s\S]*?settingsWin\.focus\(\)/u,
    '最小化的设置页必须先恢复'
  )
  // 窗口可能在 await 期间被销毁，复用前必须校验，避免访问已销毁窗口。
  assert.match(
    createSource,
    /if \(settingsWin !== existingWindow \|\| existingWindow\.isDestroyed\(\)\) return existingWindow/u,
    '复用前必须校验窗口存活'
  )
})

test('托盘与第二实例等用户入口应请求置顶，内部 activate 复用不得置顶', () => {
  assert.match(mainSource, /tray\.on\('click', \(\) => void openSettings\(\)\)/u)
  assert.match(mainSource, /tray\.on\('double-click', \(\) => void openSettings\(\)\)/u)
  assert.match(
    mainSource,
    /label:\s*'设置',[\s\S]*?click:\s*\(\)\s*=>\s*void openSettings\(\)/u
  )
  assert.match(
    mainSource,
    /app\.on\('second-instance',[\s\S]*?if \(!initialized\) return[\s\S]*?openSettings\(\)/u
  )

  const activateSource = extractFunction(
    mainSource,
    'function activateExistingPageOrOpenSettings(): void {'
  )
  assert.match(
    activateSource,
    /openSettings\(\{ bringToFront: false \}\)/u,
    '内部 activate 复用已可见设置页时不得强制置顶'
  )
})
