import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginManualTranslation,
  canSubmitManualTranslation,
  completeManualTranslation,
  createManualTranslationState,
  failManualTranslation,
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
  assert.doesNotMatch(settings, /manual(?:Source|Translation|Draft)/u)
})

test('翻译中禁止重复提交，失败后保留草稿并允许再次提交', () => {
  let state = beginManualTranslation(updateManualDraft(createManualTranslationState(), 'retry me'))
  assert.equal(canSubmitManualTranslation(state), false)
  state = failManualTranslation(state, state.requestId, '网络失败')
  assert.equal(state.draft, 'retry me')
  assert.equal(state.error, '网络失败')
  assert.equal(canSubmitManualTranslation(state), true)
})
