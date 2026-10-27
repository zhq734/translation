import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ALL_WORKSPACES_VISIBILITY_OPTIONS } from '../src/main/windowWorkspaceVisibility.ts'

test('浮层窗口仍需跨全屏可见，普通窗口不得依赖跨工作区归一化', () => {
  assert.equal(ALL_WORKSPACES_VISIBILITY_OPTIONS.visibleOnFullScreen, true)

  // 设置页与网页阅读器都属于普通窗口语义，必须使用普通 BrowserWindow，
  // 不得保留 setVisibleOnAllWorkspaces(false) 之类无法清除 panel 副作用的调用。
  const source = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  assert.doesNotMatch(source, /type:\s*'panel'|setVisibleOnAllWorkspaces\(/u)

  // 设置窗口已改回普通窗口，不再创建 panel，也不应保留无效的跨工作区归一化调用。
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const settingsWindowBlock = mainSource.slice(
    mainSource.indexOf('async function createSettingsWindow('),
    mainSource.indexOf('/**\n * 打开设置窗口。')
  )
  assert.doesNotMatch(settingsWindowBlock, /setVisibleOnAllWorkspaces\(/u)
})
