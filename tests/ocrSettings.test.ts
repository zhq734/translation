import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/shared/settingsDefaults.ts'
import { isOcrEnginePreference, normalizeOcrScale } from '../src/shared/types.ts'

/**
 * 校验默认设置包含 OCR 分组的全部字段及合理默认值。
 * @returns 无返回值。
 * @author zhenghq
 */
test('默认设置应包含 OCR 分组字段', () => {
  assert.equal(DEFAULT_SETTINGS.ocrEnginePreference, 'auto')
  assert.equal(DEFAULT_SETTINGS.ocrHotkey, 'Alt+O')
  assert.equal(DEFAULT_SETTINGS.ocrLang, 'auto')
  assert.equal(DEFAULT_SETTINGS.ocrScale, 1.25)
  assert.equal(DEFAULT_SETTINGS.ocrTesseractEnabled, true)
})

/**
 * 校验非法 OCR 引擎偏好回退到 auto，合法值原样保留。
 * @returns 无返回值。
 * @author zhenghq
 */
test('非法 OCR 引擎偏好应回退到 auto', () => {
  assert.equal(normalizeSettings({ ocrEnginePreference: 'magic' as never }).ocrEnginePreference, 'auto')
  assert.equal(normalizeSettings({ ocrEnginePreference: 'system' }).ocrEnginePreference, 'system')
  assert.equal(normalizeSettings({ ocrEnginePreference: 'paddle' }).ocrEnginePreference, 'paddle')
  assert.equal(normalizeSettings({ ocrEnginePreference: 'tesseract' }).ocrEnginePreference, 'tesseract')
})

/**
 * 校验 OCR 放大倍率被限制在 1~3 之间，非法数值回退默认倍率。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 放大倍率应被限制在 1~3 之间', () => {
  assert.equal(normalizeSettings({ ocrScale: 9.9 }).ocrScale, 3)
  assert.equal(normalizeSettings({ ocrScale: 0.2 }).ocrScale, 1)
  assert.equal(normalizeSettings({ ocrScale: 'xx' as never }).ocrScale, 1.25)
  assert.equal(normalizeOcrScale(2), 2)
  assert.equal(normalizeOcrScale(NaN), 1.25)
})

/**
 * 校验旧版设置缺失 OCR 字段时自动补齐默认值，不因缺字段阻塞。
 * @returns 无返回值。
 * @author zhenghq
 */
test('旧版设置缺失 OCR 字段时应补齐默认值', () => {
  const legacy = normalizeSettings({ schemaVersion: 11 } as never)
  assert.equal(legacy.ocrEnginePreference, 'auto')
  assert.equal(legacy.ocrHotkey, 'Alt+O')
  assert.equal(legacy.ocrLang, 'auto')
  assert.equal(legacy.ocrScale, 1.25)
  assert.equal(legacy.ocrTesseractEnabled, true)
})

/**
 * 校验 OCR 快捷键与语言按字符串规范化并去除首尾空白。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 快捷键与语言应去除首尾空白', () => {
  const settings = normalizeSettings({ ocrHotkey: '  Alt+O ', ocrLang: ' zh-CN ' })
  assert.equal(settings.ocrHotkey, 'Alt+O')
  assert.equal(settings.ocrLang, 'zh-CN')
  assert.equal(normalizeSettings({ ocrHotkey: '' }).ocrHotkey, '')
})

/**
 * 校验 Tesseract 兜底开关只接受布尔语义，其它值回退启用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Tesseract 兜底开关非法值应回退为启用', () => {
  assert.equal(normalizeSettings({ ocrTesseractEnabled: false }).ocrTesseractEnabled, false)
  assert.equal(normalizeSettings({ ocrTesseractEnabled: 'yes' as never }).ocrTesseractEnabled, true)
})

/**
 * 校验 isOcrEnginePreference 仅接受四个合法值。
 * @returns 无返回值。
 * @author zhenghq
 */
test('isOcrEnginePreference 仅接受四个合法值', () => {
  assert.ok(isOcrEnginePreference('auto'))
  assert.ok(isOcrEnginePreference('system'))
  assert.ok(isOcrEnginePreference('paddle'))
  assert.ok(isOcrEnginePreference('tesseract'))
  assert.ok(!isOcrEnginePreference('magic'))
  assert.ok(!isOcrEnginePreference(''))
  assert.ok(!isOcrEnginePreference(undefined))
})
