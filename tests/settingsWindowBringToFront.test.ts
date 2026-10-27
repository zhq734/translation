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
  // 因此用户显式打开设置页时必须把目标窗口自身置前并聚焦。
  // panel 落地后禁止 app.focus()：窗口级置前只允许影响设置窗口，不得把同应用
  // 其它可见窗口（翻译弹窗）一起带到最前。
  assert.match(
    createSource,
    /if \(settingsWin\.isVisible\(\)\) \{[\s\S]*?if \(!bringToFront\) return settingsWin[\s\S]*?showOwnWindowForInteraction\(settingsWin,\s*\{\s*raiseLevel:\s*true\s*\}\)/u,
    '打开设置页必须走统一窗口级置前入口显示、聚焦窗口'
  )
  assert.doesNotMatch(createSource, /app\.focus\(/u, '窗口级置前不得激活整个应用')
  // 最小化窗口的 isVisible() 仍为 true，必须先恢复再聚焦。
  assert.match(
    createSource,
    /if \(settingsWin\.isMinimized\(\)\) \{[\s\S]*?showOwnWindowForInteraction\(settingsWin,\s*\{\s*raiseLevel:\s*bringToFront\s*\}\)/u,
    '最小化的设置页必须先恢复再聚焦'
  )
  // 窗口可能在 await 期间被销毁，复用前必须校验，避免访问已销毁窗口。
  assert.match(
    createSource,
    /if \(settingsWin !== existingWindow \|\| existingWindow\.isDestroyed\(\)\) return existingWindow/u,
    '复用前必须校验窗口存活'
  )
})

test('托盘、第二实例与 Dock activate 等用户入口都应请求置顶', () => {
  assert.match(mainSource, /tray\.on\('click', \(\) => void openSettings\(\)\)/u)
  assert.match(mainSource, /tray\.on\('double-click', \(\) => void openSettings\(\)\)/u)
  assert.match(
    mainSource,
    /label:\s*t\.t\('menu\.settings'\),[\s\S]*?click:\s*\(\)\s*=>\s*void openSettings\(\)/u
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
    /openSettings\(\{ bringToFront: true \}\)/u,
    'Dock activate 复用已可见设置页时必须置顶'
  )
})

test('新建设置窗口必须消费 bringToFront，非显式入口不得强行置前', () => {
  const createSource = extractFunction(mainSource, 'async function createSettingsWindow(')

  // 启动首开传入 true 时必须置前；非显式后台建窗传入 false 时只能让窗口存在，
  // 不能把新建的设置页越过用户当前正在使用的应用。
  assert.match(
    createSource,
    /showOwnWindowForInteraction\(settingsWin,\s*\{\s*focus:\s*bringToFront,\s*moveTop:\s*bringToFront,\s*raiseLevel:\s*bringToFront\s*\}\)/u,
    '新建设置窗口必须按 bringToFront 决定是否聚焦与置前'
  )
})

test('Dock 激活是显式用户入口，复用设置窗口时必须置前', () => {
  const activateSource = extractFunction(
    mainSource,
    'function activateExistingPageOrOpenSettings(): void {'
  )

  // Dock 点击会先触发 activate，再走到这里；它和托盘/第二实例一样是用户显式入口，
  // 必须把已打开的设置页提到最前。否则日志虽然显示“按 Dock 启动处理”，窗口却毫无反应。
  assert.match(
    activateSource,
    /openSettings\(\{ bringToFront: true \}\)/u,
    'Dock 激活复用设置窗口时必须显式置前'
  )
})

test('显式置前时临时提升的浮层必须在设置页失焦后归还普通层级', () => {
  const createSource = extractFunction(mainSource, 'async function createSettingsWindow(')

  // panel 不激活应用，显式入口必须临时提升到 floating 才能越过当前前台应用；
  // 但它只服务于本次置前，窗口失焦后必须归还普通层级，避免长期悬浮。
  // 具体降级逻辑收敛在统一函数中，blur 只负责触发，不直接操作窗口层级。
  assert.match(
    createSource,
    /settingsWin\.on\('blur'[\s\S]*?lowerSettingsPanelRaiseLevel\(\)/u,
    '设置页失焦后必须归还普通窗口层级'
  )
})
