import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  normalizeDocumentManualEditText,
  resolveDocumentManualEditAvailability
} from '../src/renderer/src/documentManualEditController.ts'

test('正文手改只允许在已完成、部分完成或只读回放文档中进行', () => {
  assert.equal(resolveDocumentManualEditAvailability('completed', false), true)
  assert.equal(resolveDocumentManualEditAvailability('partial', false), true)
  assert.equal(resolveDocumentManualEditAvailability('completed', true), true)
  assert.equal(resolveDocumentManualEditAvailability('running', false), false)
  assert.equal(resolveDocumentManualEditAvailability('failed', false), false)
  assert.equal(resolveDocumentManualEditAvailability('cancelled', false), false)
})

test('OCR 原文模式不得把识别源文本写入手动译文模型', () => {
  assert.equal(resolveDocumentManualEditAvailability('completed', false, 'translation', 'translation'), true)
  assert.equal(resolveDocumentManualEditAvailability('partial', false, 'translation', 'translation'), true)
  assert.equal(resolveDocumentManualEditAvailability('completed', false, 'ocr', 'ocr-text'), false)
  assert.equal(resolveDocumentManualEditAvailability('completed', false, 'translation', 'ocr-text'), false)
  assert.equal(resolveDocumentManualEditAvailability('completed', false, 'ocr', 'translation'), false)
})

test('正文手改必须保留换行并统一不同平台的换行符', () => {
  assert.equal(normalizeDocumentManualEditText('第一行\r\n第二行\r第三行'), '第一行\n第二行\n第三行')
  assert.equal(normalizeDocumentManualEditText('  空格保留  '), '  空格保留  ')
})

test('正文手改控制器必须安全提交文本、取消编辑并避免 HTML 注入', () => {
  const source = readFileSync('src/renderer/src/documentManualEditController.ts', 'utf8')

  assert.match(source, /setDocumentManualTranslationText/u)
  assert.match(source, /contenteditable/u)
  assert.match(source, /event\.key === 'Escape'[\s\S]*?cancel/u)
  assert.match(source, /event\.key === 'Enter'[\s\S]*?shiftKey/u)
  assert.match(source, /textContent/u)
  assert.doesNotMatch(source, /innerHTML\s*=/u)
  assert.match(source, /data-document-editing/u)
  assert.match(source, /manuallyEdited/u)
})

test('正文手改只允许带可编辑标记的译文目标，并支持目录标题原子编辑', () => {
  const source = readFileSync('src/renderer/src/documentManualEditController.ts', 'utf8')

  assert.match(source, /data-manually-editable="true"/u)
  assert.match(source, /dataset\.manuallyEditable/u)
  assert.match(source, /\.document-toc-title/u)
  assert.match(source, /applyDocumentManualTranslationEdits/u)
  assert.match(source, /createDocumentManualTocEdits/u)
  assert.match(source, /kind: 'toc'/u)
  assert.match(source, /kind: 'block'/u)
  assert.match(source, /createDocumentManualTextBlockEdits/u)
  assert.match(source, /refresh\(\): void/u)
  assert.match(source, /isConnected[\s\S]*?data-manually-edited/u)
})

test('正文手改刷新必须依据模型中的 manuallyEdited 标记恢复手改样式', () => {
  const source = readFileSync('src/renderer/src/documentManualEditController.ts', 'utf8')

  assert.match(source, /const edited = target\.kind === 'run'[\s\S]*?run\?\.manuallyEdited === true/u)
  assert.match(source, /findOcrRegion\([^)]*\)\?\.manuallyEdited === true/u)
  assert.match(source, /findTocBlock\([^)]*\)\?\.runs\.some\(\(run\) =>[\s\S]*?run\.manuallyEdited === true/u)
})

test('译文块操作菜单必须能通过公共入口进入手改编辑态', () => {
  const source = readFileSync('src/renderer/src/documentManualEditController.ts', 'utf8')
  const workspace = readFileSync('src/renderer/src/document.ts', 'utf8')

  assert.match(source, /startEdit\(element: HTMLElement\): void/u)
  assert.match(source, /startEdit,/u)
  assert.match(workspace, /documentManualEdit\.startEdit\(/u)
})

test('手改进入后光标必须落在文本末尾，不能默认全选整段译文', () => {
  const source = readFileSync('src/renderer/src/documentManualEditController.ts', 'utf8')

  assert.match(source, /range\.selectNodeContents\(element\)\s*range\.collapse\(false\)/u)
})

test('编辑失焦必须延迟提交，并把块操作菜单内的焦点切换视为继续编辑', () => {
  const source = readFileSync('src/renderer/src/documentManualEditController.ts', 'utf8')

  assert.match(source, /const handleFocusOut[\s\S]*?window\.setTimeout[\s\S]*?document\.activeElement[\s\S]*?document-block-action-menu[\s\S]*?commitActiveEdit/u)
  assert.match(source, /clearPendingFocusOutCommit[\s\S]*?cancelActiveEdit/u)
})

test('编辑期间悬停不得启动块菜单，菜单打开也不得抢走编辑焦点', () => {
  const source = readFileSync('src/renderer/src/documentBlockActionController.ts', 'utf8')

  assert.match(source, /translationContent\.addEventListener\('pointerover'[\s\S]*?if \(isEditing\(\)\) return/u)
  assert.match(source, /if \(!isEditing\(\)\)[\s\S]*?querySelector<HTMLButtonElement>\('button'\)\?\.focus/u)
})

test('清空后的译文元素必须保留可点击的最小编辑区域', () => {
  const css = readFileSync('src/renderer/src/document.css', 'utf8')

  assert.match(css, /\[data-manually-editable='true'\]:empty[\s\S]*?display: inline-block;[\s\S]*?min-width: 1ch;[\s\S]*?min-height: 1\.45em;/u)
  assert.match(css, /\.document-text-block\[data-manually-editable='true'\]:empty[\s\S]*?display: block;[\s\S]*?min-height:/u)
  // 块内即使保留空 run，外层也不能塌掉；否则清空后无法再次双击输入。
  assert.match(css, /\.document-text-block\[data-manually-editable='true'\]\s*\{[\s\S]*?min-height:\s*1\.45em;/u)
  // Chromium 清空 contenteditable 后可能保留 <br>，不能只依赖 :empty；编辑态本身必须撑出命中区域。
  assert.match(css, /\.document-text-run\.document-manual-edit-active,[\s\S]*?display: inline-block;[\s\S]*?min-width: 1ch;[\s\S]*?min-height: 1\.45em;/u)
  assert.match(css, /\.document-text-block\.document-manual-edit-active[\s\S]*?display: block;[\s\S]*?min-height:/u)
})

test('块级手改提交和取消必须保留 run 子节点并逐个同步文本', () => {
  const source = readFileSync('src/renderer/src/documentManualEditController.ts', 'utf8')

  assert.match(source, /captureManualEditBlockRuns/u)
  assert.match(source, /restoreManualEditBlockRuns/u)
  assert.match(source, /syncManualEditBlockRuns/u)
  // 提交同步通过 helper 逐个替换 run 节点，不能把整块 textContent 覆盖掉。
  assert.match(source, /function syncManualEditBlockRuns[\s\S]*?element\.replaceChildren/u)
  assert.match(source, /syncManualEditBlockRuns\(element, updatedBlock, originalBlockRuns\)/u)
  assert.doesNotMatch(source, /if \(target\.kind === 'block'\)\s*element\.textContent\s*=\s*text/u)
  assert.doesNotMatch(source, /if \(target\.kind === 'block'\)\s*element\.textContent\s*=\s*originalText/u)
})

test('手改必须支持回退与前进，并按 Tab 隔离历史栈', () => {
  const source = readFileSync('src/renderer/src/documentManualEditController.ts', 'utf8')

  assert.match(source, /manualEditUndoStacks/u)
  assert.match(source, /manualEditRedoStacks/u)
  assert.match(source, /undo\(\): boolean/u)
  assert.match(source, /redo\(\): boolean/u)
  assert.match(source, /canUndo\(\): boolean/u)
  assert.match(source, /canRedo\(\): boolean/u)
  // 提交前记录旧模型与旧状态，回退时按其恢复。
  assert.match(source, /pushManualEditHistory\(tab, \{ translation: model, status: previousStatus \}\)/u)
  // 新的手改必须清空前进栈，避免分叉历史。
  assert.match(source, /manualEditRedoStacks\.set\(tab\.id, \[\]\)/u)
})

test('文档工作台必须为手改回退与前进提供按钮和快捷键', () => {
  const source = readFileSync('src/renderer/src/document.ts', 'utf8')
  const interactionSource = readFileSync('src/renderer/src/documentBlockActionController.ts', 'utf8')
  const html = readFileSync('src/renderer/document.html', 'utf8')
  const zh = readFileSync('src/shared/i18n/catalog.zh-CN.document.ts', 'utf8')
  const en = readFileSync('src/shared/i18n/catalog.en-US.document.ts', 'utf8')

  assert.match(html, /id="document-edit-undo-button"/u)
  assert.match(html, /id="document-edit-redo-button"/u)
  assert.match(source, /documentManualEdit\.undo\(\)/u)
  assert.match(source, /documentManualEdit\.redo\(\)/u)
  assert.match(interactionSource, /event\.metaKey[\s\S]*?event\.ctrlKey/u)
  // 编辑期间保留 contenteditable 原生撤销，不抢占输入框内的快捷键。
  assert.match(interactionSource, /if \(isEditing\(\)\) return/u)
  assert.match(source, /refreshDocumentEditHistoryButtons/u)
  assert.match(zh, /'document\.edit\.undo'/u)
  assert.match(zh, /'document\.edit\.redo'/u)
  assert.match(en, /'document\.edit\.undo'/u)
  assert.match(en, /'document\.edit\.redo'/u)
})

test('手改回退与前进必须移入下方菜单栏并以图标展示', () => {
  const html = readFileSync('src/renderer/document.html', 'utf8')
  const css = readFileSync('src/renderer/src/document.css', 'utf8')
  const toolbarActions = /<div class="document-toolbar-actions">([\s\S]*?)<\/div>/u.exec(html)?.[1] ?? ''
  const menuBar = /<div class="document-toolbar-menu-bar"[^>]*>([\s\S]*?)<details class="document-toolbar-menu"/u.exec(html)?.[1] ?? ''

  assert.doesNotMatch(toolbarActions, /id="document-edit-(?:undo|redo)-button"/u)
  assert.match(menuBar, /id="document-edit-undo-button"[\s\S]*?<svg[\s\S]*?<\/svg>[\s\S]*?id="document-edit-redo-button"[\s\S]*?<svg[\s\S]*?<\/svg>/u)
  assert.match(menuBar, /id="document-edit-undo-button"[^>]*data-i18n-attr="aria-label:document\.edit\.undo;title:document\.edit\.undo"/u)
  assert.match(menuBar, /id="document-edit-redo-button"[^>]*data-i18n-attr="aria-label:document\.edit\.redo;title:document\.edit\.redo"/u)
  assert.doesNotMatch(menuBar, /id="document-edit-(?:undo|redo)-button"[^>]*data-i18n="document\.edit\.(?:undo|redo)"/u)
  assert.match(css, /\.document-edit-history-button\s*\{[^}]*display:\s*inline-grid[^}]*place-items:\s*center[^}]*width:\s*var\(--control-height\)/su)
  assert.match(css, /\.document-edit-history-button svg\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/su)
})
