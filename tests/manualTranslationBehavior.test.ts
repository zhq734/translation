import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginManualTranslation,
  canSubmitManualTranslation,
  completeManualTranslation,
  createManualTranslationState,
  failManualTranslation,
  insertManualClipboardText,
  updateManualDraft,
  validateManualTranslationText
} from '../src/shared/manualTranslationBehavior.ts'
import { readFileSync } from 'node:fs'

test('手动翻译状态应支持输入、成功结果和过期标记', () => {
  let state = createManualTranslationState()
  state = updateManualDraft(state, 'hello')
  assert.equal(canSubmitManualTranslation(state), true)
  state = beginManualTranslation(state)
  assert.equal(state.loading, true)
  state = completeManualTranslation(state, state.requestId, '你好')
  assert.equal(state.translation, '你好')
  state = updateManualDraft(state, 'hello world')
  assert.equal(state.stale, true)
})

test('手动翻译应拒绝空白和超过 5000 字符的原文，并保留换行', () => {
  assert.equal(validateManualTranslationText(' \n\t'), '请输入要翻译的原文')
  assert.match(validateManualTranslationText('a'.repeat(5001)) ?? '', /5000/u)
  assert.equal(validateManualTranslationText('第一行\n第二行'), null)
})

test('旧请求结果不能覆盖新请求结果', () => {
  let state = beginManualTranslation(updateManualDraft(createManualTranslationState(), 'old'))
  const oldRequestId = state.requestId
  state = beginManualTranslation(updateManualDraft(state, 'new'))
  assert.equal(completeManualTranslation(state, oldRequestId, '旧结果').translation, '')
  assert.equal(failManualTranslation(state, oldRequestId, '旧错误').loading, true)
})

test('手动草稿只能保存在 Renderer 会话内且不得写入持久化存储', () => {
  const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const settings = readFileSync('src/shared/settingsDefaults.ts', 'utf8')
  assert.doesNotMatch(renderer, /localStorage|sessionStorage/u)
  assert.doesNotMatch(settings, /manual(?:Source|Draft)|manualTranslation(?:Result|Draft|Source)/u)
})

test('翻译中禁止重复提交，失败后保留草稿并允许再次提交', () => {
  let state = beginManualTranslation(updateManualDraft(createManualTranslationState(), 'retry me'))
  assert.equal(canSubmitManualTranslation(state), false)
  state = failManualTranslation(state, state.requestId, '网络失败')
  assert.equal(state.draft, 'retry me')
  assert.equal(state.error, '网络失败')
  assert.equal(canSubmitManualTranslation(state), true)
})

test('右键粘贴文本应替换当前选区并把光标放到插入内容之后', () => {
  assert.deepEqual(insertManualClipboardText('hello world', '翻译', 6, 11), {
    value: 'hello 翻译',
    cursor: 8,
    changed: true
  })
  assert.deepEqual(insertManualClipboardText('前后', '中间', 1, 1), {
    value: '前中间后',
    cursor: 3,
    changed: true
  })
})

test('右键粘贴应忽略空剪贴板并把总长度截断到 5000 字符', () => {
  assert.deepEqual(insertManualClipboardText('原文', '  ', 1, 1), {
    value: '原文',
    cursor: 1,
    changed: false
  })
  const result = insertManualClipboardText('a'.repeat(4998), 'bcdef', 4998, 4998)
  assert.equal(result.value.length, 5000)
  assert.equal(result.value, `${'a'.repeat(4998)}bc`)
  assert.equal(result.cursor, 5000)
  assert.equal(result.changed, true)
})
