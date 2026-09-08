import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 校验主进程注册诊断摘要与导出 IPC。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主进程应注册 capture-diagnostics IPC', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /ipcMain\.handle\('capture-diagnostics:get-summary'/u)
  assert.match(source, /ipcMain\.handle\('capture-diagnostics:export'/u)
})

/**
 * 校验 preload 暴露诊断摘要与导出方法。
 * @returns 无返回值。
 * @author zhenghq
 */
test('preload 应暴露 getCaptureDiagnosticsSummary 与 exportCaptureDiagnostics', () => {
  const source = readFileSync('src/preload/index.ts', 'utf8')
  assert.match(source, /getCaptureDiagnosticsSummary/)
  assert.match(source, /exportCaptureDiagnostics/)
  assert.match(source, /ipcRenderer\.invoke\('capture-diagnostics:get-summary'\)/u)
  assert.match(source, /ipcRenderer\.invoke\('capture-diagnostics:export'\)/u)
})

/**
 * 校验导出使用系统保存对话框且写入 JSON 文件。
 * @returns 无返回值。
 * @author zhenghq
 */
test('诊断导出应使用保存对话框并写入 JSON', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /dialog\.showSaveDialog/u)
  assert.match(source, /capture-diagnostics-.*\.json/u)
  assert.match(source, /await writeFile\(filePath, JSON\.stringify/u)
})

/**
 * 校验设置页包含取词诊断卡片与导出按钮。
 * @returns 无返回值。
 * @author zhenghq
 */
test('设置页应包含取词诊断卡片与导出按钮', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  assert.match(html, /id="diagnostics-summary"/u)
  assert.match(html, /id="diagnostics-export"/u)
  assert.match(html, /取词诊断/u)
})

/**
 * 校验共享诊断模型包含字段白名单，且白名单不含文本内容字段。
 * @returns 无返回值。
 * @author zhenghq
 */
test('诊断字段白名单不应包含文本内容字段', () => {
  const source = readFileSync('src/shared/captureDiagnostics.ts', 'utf8')
  assert.match(source, /CAPTURE_DIAGNOSTIC_WHITELIST/u)
  assert.doesNotMatch(source, /text|content|selectedText|clipboardData/iu)
})

/**
 * 校验取词诊断面板提供收起/展开入口，且切换状态可被持久化。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取词诊断面板应支持收起与展开', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  assert.match(html, /id="diagnostics-section"/u)
  assert.match(html, /id="diagnostics-toggle"/u)
  assert.match(html, /aria-controls="diagnostics-body"/u)
  assert.match(html, /aria-expanded="true"/u)
  assert.match(html, /id="diagnostics-body"/u)

  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  assert.match(source, /diagnostics-toggle/u)
  assert.match(source, /diagnostics-collapsed/u)
  assert.match(source, /aria-expanded/u)
  assert.match(source, /localStorage/u)
  assert.match(source, /收起/u)
  assert.match(source, /展开/u)

  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  assert.match(css, /\.diagnostics-header\s*\{[\s\S]*display:\s*flex/u)
  assert.match(css, /\.diagnostics-collapsed[\s\S]*display:\s*none/u)
  assert.doesNotMatch(css, /\.diagnostics-collapsed[\s\S]*#[0-9a-fA-F]{3,8}\b/u)
})
