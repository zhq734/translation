import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

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

const mainSource = readFileSync('src/main/index.ts', 'utf8')
const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const selectionButtonSource = readFileSync('src/main/selectionButton.ts', 'utf8')

test('app.dock.show 同步路径应在调用前后各打一条候选点', () => {
  const applySource = extractFunction(mainSource, 'async function applyMacOSDockVisibility(')

  // 前后各一条才能区分“调用前就激活”与“调用本身激活”，且打点不得改变 await 顺序。
  const beforeIndex = applySource.indexOf("'dock-show-sync-before'")
  const showIndex = applySource.indexOf('await app.dock?.show()')
  const afterIndex = applySource.indexOf("'dock-show-sync-after'")

  assert.ok(beforeIndex >= 0, 'dock.show 同步路径必须记录调用前打点')
  assert.ok(showIndex >= 0, 'dock.show 同步路径必须保留原调用')
  assert.ok(afterIndex >= 0, 'dock.show 同步路径必须记录调用后打点')
  assert.ok(beforeIndex < showIndex, '调用前打点必须位于 dock.show 之前')
  assert.ok(showIndex < afterIndex, '调用后打点必须位于 dock.show 之后')
  assert.match(applySource, /await app\.dock\?\.show\(\)/u, 'dock.show 必须保持 await 语义')
})

test('app.dock.show 延迟重放路径应记录 dock-show-delayed 且保留保护期判断', () => {
  const scheduleSource = extractFunction(
    mainSource,
    'function scheduleMacOSDockShowAfterSelectionGuard('
  )

  const delayedIndex = scheduleSource.indexOf("'dock-show-delayed'")
  const showIndex = scheduleSource.indexOf('app.dock?.show()')

  assert.ok(delayedIndex >= 0, '延迟重放必须记录 dock-show-delayed')
  assert.ok(showIndex >= 0, '延迟重放必须保留 app.dock.show 调用')
  assert.ok(delayedIndex < showIndex, '延迟重放打点必须位于 dock.show 之前')
  assert.match(scheduleSource, /isSelectionWindowRaiseGuardActive\(\)/u,
    '延迟重放必须保留保护期判断')
  assert.match(scheduleSource, /selectionInteraction\.snapshot\(\)\.state/u,
    '延迟重放必须保留交互状态判断')
})

test('设置页显式入口与复用已可见分支置前都必须打点', () => {
  const activateSource = extractFunction(
    mainSource,
    'function activateExistingPageOrOpenSettings('
  )
  assert.match(activateSource, /'settings-activate-entry'/u,
    '设置页显式入口必须记录 settings-activate-entry')

  const createSource = extractFunction(mainSource, 'async function createSettingsWindow(')
  const reuseIndex = createSource.indexOf("'settings-reuse-raise'")
  const raiseIndex = createSource.indexOf(
    'showOwnWindowForInteraction(settingsWin, { raiseLevel: true })'
  )
  assert.ok(reuseIndex >= 0, '设置窗口复用已可见分支必须记录 settings-reuse-raise')
  assert.ok(raiseIndex >= 0, '设置窗口复用分支必须保留置前调用')
  assert.ok(reuseIndex < raiseIndex, '复用分支打点必须位于置前调用之前')
  assert.match(createSource, /settingsWin\.isVisible\(\)/u, '复用分支必须保留可见性判断')
})

test('翻译弹窗显隐真实调用点都必须打点且不插入 await', () => {
  const showSource = extractFunction(popupSource, 'export function showPopup(')
  const hideSource = extractFunction(popupSource, 'export function hidePopup(')

  assert.match(showSource, /'popup-show'/u, '弹窗激活显示必须打点 popup-show')
  assert.match(showSource, /'popup-show-inactive'/u, '弹窗非激活显示必须打点 popup-show-inactive')
  assert.match(hideSource, /'popup-hide'/u, '弹窗隐藏必须打点 popup-hide')
  assert.doesNotMatch(showSource, /await /u, '弹窗显示打点不得插入 await')
  assert.doesNotMatch(hideSource, /await /u, '弹窗隐藏打点不得插入 await')
  assert.match(showSource, /win\.isVisible\(\)/u, '弹窗显示必须记录可见性布尔值')
})

test('选区按钮显隐真实调用点都必须打点且不插入 await', () => {
  const showSource = extractFunction(selectionButtonSource, 'function showReadySelectionButton(')
  const hideSource = extractFunction(selectionButtonSource, 'export function hideSelectionButton(')

  assert.match(showSource, /'selection-button-show-inactive'/u,
    '按钮显示必须打点 selection-button-show-inactive')
  assert.match(hideSource, /'selection-button-hide'/u,
    '按钮隐藏必须打点 selection-button-hide')
  assert.doesNotMatch(showSource, /await /u, '按钮显示打点不得插入 await')
  assert.doesNotMatch(hideSource, /await /u, '按钮隐藏打点不得插入 await')
  assert.match(showSource, /win\.isVisible\(\)/u, '按钮显示必须记录可见性布尔值')
})
