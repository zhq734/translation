import assert from 'node:assert/strict'
import test from 'node:test'
import { TranslationRuntime } from '../src/main/translate.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'
import { tForTest } from './helpers/i18n.ts'

test('翻译运行时对超过全局上限的输入明确报错且不发请求', async () => {
  let calls = 0
  const runtime = new TranslationRuntime({ fetch: async () => { calls += 1; throw new Error('不应请求') } })
  const expected = tForTest('en-US', 'translate.error.tooLong', { max: 5000 })
  await assert.rejects(
    runtime.translate('x'.repeat(5001), normalizeSettings({ schemaVersion: 12 })),
    (error: unknown) => error instanceof Error && error.message === expected
  )
  assert.equal(calls, 0)
})

test('降级通道长度不足时应跳过而不是截断请求', async () => {
  const urls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      urls.push(String(url))
      throw new Error('模拟失败')
    }
  })
  await assert.rejects(runtime.translate('长'.repeat(2100), normalizeSettings({ schemaVersion: 12 })))
  assert.equal(urls.some((url) => url.includes('translate.googleapis.com')), false)
  assert.equal(urls.some((url) => url.includes('mymemory.translated.net')), false)
})
