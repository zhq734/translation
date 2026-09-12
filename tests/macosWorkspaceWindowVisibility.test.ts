import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { ALL_WORKSPACES_VISIBILITY_OPTIONS } from '../src/main/windowWorkspaceVisibility.ts'

/**
 * 列出主进程源码文件，用于扫描所有跨工作区窗口的创建点。
 * @returns 主进程源码文件的相对路径列表。
 * @author zhenghq
 */
function listMainSourceFiles(): string[] {
  return readdirSync('src/main')
    .filter((file) => file.endsWith('.ts'))
    .map((file) => join('src/main', file))
}

/**
 * 统计源码中指定片段的出现次数。
 * @param source 源码内容。
 * @param fragment 待统计的片段。
 * @returns 片段出现次数。
 * @author zhenghq
 */
function countOccurrences(source: string, fragment: string): number {
  return source.split(fragment).length - 1
}

/**
 * 校验跨工作区窗口选项必须跳过进程类型转换。
 * Electron 默认的 UIElementApplication/ForegroundApplication 转换会隐藏窗口与 Dock 图标，
 * 导致设置窗口打开期间创建「译」按钮、弹窗、OCR 覆盖窗口或截图提示窗口时，
 * 设置窗口与 Dock 图标一起消失。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 跨工作区窗口必须跳过会隐藏窗口与 Dock 图标的进程类型转换', () => {
  assert.deepEqual(ALL_WORKSPACES_VISIBILITY_OPTIONS, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  })

  const optionSource = readFileSync('src/main/windowWorkspaceVisibility.ts', 'utf8')
  assert.doesNotMatch(optionSource, /from 'electron'/u)
  assert.match(optionSource, /skipTransformProcessType:\s*true/u)
})

/**
 * 校验所有调用点复用统一选项，不再出现内联的默认选项写法。
 * @returns 无返回值。
 * @author zhenghq
 */
test('所有 setVisibleOnAllWorkspaces 调用都应复用统一选项', () => {
  const expectedCallSites = 4
  let callSites = 0

  for (const file of listMainSourceFiles()) {
    const source = readFileSync(file, 'utf8')
    const calls = countOccurrences(source, 'setVisibleOnAllWorkspaces(')
    if (calls === 0) continue

    callSites += calls
    assert.equal(
      countOccurrences(source, 'setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS)'),
      calls,
      `${file} 的每个 setVisibleOnAllWorkspaces 调用都应传入 ALL_WORKSPACES_VISIBILITY_OPTIONS`
    )
    assert.match(
      source,
      /import \{ ALL_WORKSPACES_VISIBILITY_OPTIONS \} from '\.\/windowWorkspaceVisibility'/u,
      `${file} 应显式导入统一选项`
    )
    assert.doesNotMatch(
      source,
      /setVisibleOnAllWorkspaces\(true,\s*\{\s*visibleOnFullScreen/u,
      `${file} 不得再内联默认选项，否则会隐藏窗口与 Dock 图标`
    )
  }

  assert.equal(callSites, expectedCallSites, '跨工作区窗口调用点数量发生变化，请同步校验新窗口')
})

/**
 * 校验设置窗口打开期间可能被创建的窗口都使用统一选项。
 * @returns 无返回值。
 * @author zhenghq
 */
test('「译」按钮、翻译弹窗、OCR 覆盖窗口与截图提示窗口都应跳过进程类型转换', () => {
  const expectations: Array<{ file: string; anchor: string }> = [
    { file: 'src/main/selectionButton.ts', anchor: "'pop-up-menu'" },
    { file: 'src/main/popup.ts', anchor: "'floating'" },
    { file: 'src/main/index.ts', anchor: 'ocrSelectionWin.setAlwaysOnTop' },
    { file: 'src/main/index.ts', anchor: 'screenshotToastWin.setAlwaysOnTop' }
  ]

  for (const { file, anchor } of expectations) {
    const source = readFileSync(file, 'utf8')
    const anchorIndex = source.indexOf(anchor)
    assert.ok(anchorIndex >= 0, `${file} 应包含 ${anchor}`)
    const callIndex = source.indexOf('setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS)', anchorIndex)
    assert.ok(callIndex > anchorIndex, `${file} 的 ${anchor} 之后应紧跟使用统一选项的跨工作区设置`)
  }
})
