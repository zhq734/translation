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

test('应用已失活时同步与延迟 Dock 显示都不得重新激活应用', () => {
  const applySource = extractFunction(mainSource, 'async function applyMacOSDockVisibility(')
  const scheduleSource = extractFunction(
    mainSource,
    'function scheduleMacOSDockShowAfterSelectionGuard('
  )

  // app.dock.show() 会激活整个应用，后台设置页因此会随应用上屏。用户已经切到
  // IntelliJ/Chrome 等外部应用时，无论同步刷新还是保护期结束后的延迟重放，
  // 都不能再调用 dock.show()；Dock 呈现只能等真实显式入口重新应用。
  for (const [name, source] of [
    ['applyMacOSDockVisibility', applySource],
    ['scheduleMacOSDockShowAfterSelectionGuard', scheduleSource]
  ] as const) {
    const showIndex = source.indexOf('app.dock?.show()')
    const activeIndex = source.lastIndexOf('isMacAppActiveByEvents()', showIndex)
    assert.ok(showIndex >= 0, `${name} 应保留 Dock 显示调用`)
    assert.ok(activeIndex >= 0 && activeIndex < showIndex,
      `${name} 调用 dock.show() 前必须确认应用仍由用户激活`)
  }
})

test('失活时跳过的 Dock 显示不得被标记为已经应用', () => {
  const applySource = extractFunction(mainSource, 'async function applyMacOSDockVisibility(')
  const activeIndex = applySource.indexOf('isMacAppActiveByEvents()')
  const showIndex = applySource.indexOf('app.dock?.show()', activeIndex)
  const appliedIndex = applySource.indexOf('appliedMacOSDockPresentation = presentation', showIndex)

  assert.ok(activeIndex >= 0 && showIndex > activeIndex && appliedIndex > showIndex,
    '失活跳过 dock.show() 后不得写入 appliedMacOSDockPresentation')
})

test('应用失活时整个 Dock 呈现路径必须原子跳过', () => {
  const applySource = extractFunction(mainSource, 'async function applyMacOSDockVisibility(')
  const executableSource = applySource
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/[^\n]*/gu, '')
  const activeIndex = executableSource.indexOf('isMacAppActiveByEvents()')
  const policyIndex = executableSource.indexOf('app.setActivationPolicy(')
  const hideIndex = executableSource.indexOf('app.dock?.hide()')
  const showIndex = executableSource.indexOf('app.dock?.show()')
  const appliedIndex = executableSource.indexOf('appliedMacOSDockPresentation = presentation')

  // setActivationPolicy()/dock.hide() 与 dock.show() 一样会触发 macOS 应用级
  // 窗口重排。应用失活时只拦 dock.show() 仍会把后台设置页闪到最前，因此必须在
  // 解析并应用 presentation 之前整体短路，且不能登记为已应用状态。
  assert.ok(activeIndex >= 0, 'Dock 呈现入口必须检查应用激活状态')
  assert.ok(policyIndex > activeIndex, '失活门禁必须早于 setActivationPolicy()')
  assert.ok(hideIndex > activeIndex, '失活门禁必须早于 dock.hide()')
  assert.ok(showIndex > activeIndex, '失活门禁必须早于 dock.show()')
  assert.ok(appliedIndex > activeIndex, '失活门禁必须早于 appliedMacOSDockPresentation 写入')
  assert.match(
    executableSource,
    /isMacAppActiveByEvents\(\)\)\s*\{\s*logCandidateProbe\('dock-presentation-skipped-inactive'/u,
    '失活跳过整个 Dock 呈现时必须记录明确诊断'
  )
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
    'bringSettingsWindowToFrontSafely(settingsWin, {',
    reuseIndex
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

test('翻译弹窗隐藏必须输出固定原因枚举，所有调用点显式传因', () => {
  const hideSource = extractFunction(popupSource, 'export function hidePopup(')
  assert.match(hideSource, /\[popup\] hide reason=\$\{reason\}/u,
    '隐藏日志必须输出固定原因枚举')
  assert.match(popupSource, /export type PopupHideReason/u,
    '隐藏原因必须收敛为受控联合类型')

  for (const reason of [
    'external-pointer',
    'blur',
    'auto-hide',
    'capture-null',
    'renderer-ipc',
    'internal-window-switch',
    'stale-token',
    'unknown'
  ]) {
    assert.match(popupSource, new RegExp(`'${reason}'`, 'u'), `缺少隐藏原因 ${reason}`)
  }

  assert.doesNotMatch(popupSource, /hidePopup\(\s*\)/u,
    '所有真实调用点都必须显式传入关闭原因')
  assert.match(popupSource, /hidePopup\(true, 'blur'\)/u, 'blur 关闭必须显式传因')
  assert.match(popupSource, /hidePopup\(true, 'external-pointer'\)/u,
    '外部指针关闭必须显式传因')
  assert.match(popupSource, /hidePopup\(false, 'internal-window-switch'\)/u,
    '内部窗口切换必须显式传因')

  assert.match(mainSource, /hidePopup\(true, 'stale-token'\)/u,
    '异步结果过期关闭必须显式传因')
  assert.match(mainSource, /hidePopup\(true, 'capture-null'\)/u,
    '取词结果为空关闭必须显式传因')
  assert.match(mainSource, /hidePopup\(true, 'renderer-ipc'\)/u,
    'renderer 主动关闭必须显式传因')
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
