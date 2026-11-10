import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { readMainSource } from './helpers/mainSource.ts'
import { PopupLanguageInteractionGuard } from '../src/main/popupLanguageInteractionGuard'

const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const mainSource = readMainSource()
const preloadSource = readFileSync('src/preload/index.ts', 'utf8')
const sharedTypesSource = readFileSync('src/shared/types.ts', 'utf8')
const rendererSource = readFileSync('src/renderer/src/popup.ts', 'utf8')

/**
 * 截取源码中指定顶层函数的完整片段。
 * @param source 待检索的源码。
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

/**
 * 去掉源码注释，避免注释中的说明干扰行为断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

test('语言选择器交互期间必须保护弹窗不被失焦或全局按下误关闭', () => {
  assert.match(
    popupSource,
    /export function setPopupLanguageInteraction\(/u,
    '主进程必须提供语言选择器交互保护入口'
  )
  assert.match(
    popupSource,
    /export function isPopupLanguageInteractionActive\(/u,
    '主进程必须提供语言选择器保护状态查询入口'
  )

  const blurSource = stripComments(extractFunction(popupSource, 'function handlePopupBlur()'))
  const blurGuardIndex = blurSource.indexOf('languageInteractionGuard.isActive()')
  const blurHideIndex = blurSource.indexOf('hidePopup(')
  assert.ok(blurGuardIndex >= 0, '失焦处理必须识别语言选择器交互保护状态')
  assert.ok(
    blurGuardIndex < blurHideIndex,
    '语言选择器保护必须早于失焦关闭判断'
  )

  const dismissSource = stripComments(
    extractFunction(popupSource, 'export function dismissPopupOnExternalPointerDown(')
  )
  const dismissGuardIndex = dismissSource.indexOf('isPopupLanguageInteractionActive()')
  const dismissHideIndex = dismissSource.indexOf("hidePopup(true, 'external-pointer')")
  assert.ok(dismissGuardIndex >= 0, '全局按下兜底必须识别语言选择器交互保护状态')
  assert.ok(
    dismissGuardIndex < dismissHideIndex,
    '语言选择器保护必须早于全局按下关闭'
  )
  assert.doesNotMatch(
    dismissSource,
    /isPopupLanguageInteractionActive\(\)[\s\S]*?isPointInsidePopup/u,
    '原生下拉选项可能超出窗口矩形，保护判断不得依赖矩形命中'
  )
})

test('下拉交互与异步重译必须使用独立保护域，避免 focusout 提前解除重译保护', () => {
  const guard = new PopupLanguageInteractionGuard()
  guard.set(true, 'selector')
  guard.set(true, 'retranslation')
  guard.set(false, 'selector')
  assert.equal(guard.isActive(), true, '下拉失焦后仍应保留重译保护')
  guard.set(false, 'retranslation')
  assert.equal(guard.isActive(), false, '重译结束后必须恢复外部点击关闭语义')
  guard.set(false, 'selector')
  assert.equal(guard.isActive(), false, '重复解除不得产生负向状态')
})

test('弹窗创建与真实隐藏时必须重置语言选择器保护，避免状态粘滞', () => {
  const createSource = stripComments(
    extractFunction(popupSource, 'export function createPopup(')
  )
  const hideSource = stripComments(extractFunction(popupSource, 'export function hidePopup('))

  assert.match(createSource, /resetPopupLanguageInteraction\(\)/u,
    '创建弹窗时必须重置语言选择器保护')
  assert.match(hideSource, /resetPopupLanguageInteraction\(\)/u,
    '关闭弹窗时必须重置语言选择器保护')
})

test('语言选择器操作必须从 Renderer 开启保护，并在重译完成后解除', () => {
  for (const selector of ['sourceLangEl', 'targetLangEl']) {
    assert.match(
      rendererSource,
      new RegExp(`${selector}\\.addEventListener\\('pointerdown', beginLanguageInteraction\\)`, 'u'),
      `${selector} 指针按下时必须立即开启保护`
    )
    assert.match(
      rendererSource,
      new RegExp(`${selector}\\.addEventListener\\('focusin', beginLanguageInteraction\\)`, 'u'),
      `${selector} 获得焦点时必须开启保护，覆盖键盘操作`
    )
    assert.match(
      rendererSource,
      new RegExp(`${selector}\\.addEventListener\\('change', handleLanguageChange\\)`, 'u'),
      `${selector} 切换语言时必须先结束下拉保护并继续重译`
    )
  }

  const changeSource = stripComments(extractFunction(rendererSource, 'function handleLanguageChange()'))
  const endSelectorIndex = changeSource.indexOf('endLanguageInteraction()')
  const retranslateIndex = changeSource.indexOf('retranslateWithCurrentLanguages()')
  assert.ok(endSelectorIndex >= 0, '语言变化后必须结束下拉控件保护')
  assert.ok(endSelectorIndex < retranslateIndex, '必须先结束下拉保护，再进入独立重译保护')

  const retranslateSource = stripComments(
    extractFunction(rendererSource, 'async function retranslateWithCurrentLanguages()')
  )
  assert.match(retranslateSource, /beginLanguageRetranslation\(\)/u,
    '语言重译开始前必须延长保护')
  assert.match(retranslateSource, /finally[\s\S]*?endLanguageRetranslation\(\)/u,
    '语言重译结束或失败后必须解除保护')
})

test('语言选择器保护信号必须通过受信任的弹窗 IPC 送达主进程', () => {
  assert.match(
    sharedTypesSource,
    /setPopupLanguageInteraction\(active: boolean, scope\?: PopupLanguageInteractionScope\): void/u,
    'preload API 类型必须暴露语言选择器交互通知'
  )
  assert.match(
    preloadSource,
    /setPopupLanguageInteraction\(active: boolean, scope: PopupLanguageInteractionScope = 'selector'\): void \{[\s\S]*?ipcRenderer\.send\('popup:language-interaction', active, scope\)/u,
    'preload 必须把语言选择器交互状态及保护域发送到主进程'
  )

  const handlerIndex = mainSource.indexOf("ipcMain.on('popup:language-interaction'")
  assert.ok(handlerIndex >= 0, '主进程必须注册语言选择器交互 IPC')
  const handlerSource = mainSource.slice(handlerIndex, mainSource.indexOf('\n  })', handlerIndex) + 5)
  assert.match(handlerSource, /isPopupWebContents\(event\.sender\)/u,
    '语言选择器交互 IPC 只能接受翻译弹窗自身的消息')
  assert.match(handlerSource, /setPopupLanguageInteraction\(active === true, normalizedScope\)/u,
    '主进程必须按保护域转换语言选择器交互状态')
})
