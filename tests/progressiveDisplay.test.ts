import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  appendProgressiveText,
  createProgressiveRevealState,
  nextRevealLength,
  settleProgressiveText,
  shouldPreservePartialReveal,
  resolveRevealStepMs
} from '../src/shared/progressiveReveal.ts'

test('渐进展示状态应累积流式片段并保留完整最终译文', () => {
  let state = createProgressiveRevealState()
  state = appendProgressiveText(state, '你好')
  state = appendProgressiveText(state, '，世界')
  assert.equal(state.fullText, '你好，世界')
  assert.equal(state.visibleLength, 0)
})

test('渐进展示应逐步揭示字符且不越过完整文本长度', () => {
  let state = createProgressiveRevealState()
  state = appendProgressiveText(state, '你好，世界')
  state = nextRevealLength(state, 2)
  assert.equal(state.visibleLength, 2)
  state = nextRevealLength(state, 100)
  assert.equal(state.visibleLength, 5)
  assert.equal(state.fullText.slice(0, state.visibleLength), '你好，世界')
})

test('缓存命中与长文本应使用更短的揭示步进间隔', () => {
  assert.ok(resolveRevealStepMs(10, true) < resolveRevealStepMs(10, false))
  assert.ok(resolveRevealStepMs(5000, false) <= resolveRevealStepMs(10, false))
  assert.ok(resolveRevealStepMs(0, false) > 0)
})

test('翻译结果应提供流式增量事件契约并接入主进程与 preload', () => {
  const types = readFileSync('src/shared/types.ts', 'utf8')
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  const popupMain = readFileSync('src/main/popup.ts', 'utf8')

  assert.match(types, /interface TranslateDeltaPayload/u)
  assert.match(types, /onTranslateDelta\(cb: \(p: TranslateDeltaPayload\) => void\)/u)
  assert.match(preload, /onTranslateDelta/u)
  assert.match(preload, /translate:delta/u)
  assert.match(popupMain, /translate:delta/u)
})

test('划词与手动翻译界面应订阅增量事件并使用打字机揭示', () => {
  const popup = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const css = readFileSync('src/renderer/src/style.css', 'utf8')

  assert.match(popup, /onTranslateDelta/u)
  assert.match(popup, /createProgressiveRevealState|appendProgressiveText/u)
  assert.match(popup, /requestAnimationFrame|setInterval|setTimeout/u)
  assert.match(popup, /stopProgressiveReveal|clearTimeout|clearInterval/u)
  assert.match(css, /streaming-cursor/u)
})

test('复制与朗读必须使用完整最终译文而不是动画中间态', () => {
  const popup = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const copyStart = popup.indexOf('function copyTranslation')
  const copyEnd = popup.indexOf('/**', copyStart + 10)
  const copySource = popup.slice(copyStart, copyEnd)
  assert.ok(copyStart >= 0)
  assert.match(copySource, /lastTranslation|manualState\.translation/u)
  assert.doesNotMatch(copySource, /visibleLength|streamText/u)
})

test('手动翻译最终结果到达后应继续揭示剩余流式文本而不是停在中间态', () => {
  const popup = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const manualSuccess = popup.slice(popup.indexOf("payload.origin === 'manual'"), popup.indexOf("payload.origin === 'selection'"))
  assert.doesNotMatch(
    manualSuccess.slice(manualSuccess.indexOf('} else {'), manualSuccess.indexOf('renderManualState()')),
    /stopProgressiveReveal\(\)/u
  )
})

test('失败时已收到的安全片段应保留并可立即完整揭示', () => {
  const empty = createProgressiveRevealState()
  assert.equal(shouldPreservePartialReveal(empty), false)

  let partial = appendProgressiveText(empty, '你好')
  partial = appendProgressiveText(partial, '，世界')
  assert.equal(shouldPreservePartialReveal(partial), true)

  const settled = settleProgressiveText(partial)
  assert.equal(settled.fullText, '你好，世界')
  assert.equal(settled.visibleLength, settled.fullText.length)
  assert.equal(settled.settled, true)
})

test('划词失败渲染应保留已展示片段并提示重试', () => {
  const popup = readFileSync('src/renderer/src/popup.ts', 'utf8')
  assert.match(popup, /shouldPreservePartialReveal\(selectionReveal\)/u)
  assert.match(popup, /settleProgressiveText\(selectionReveal\)/u)
  assert.match(popup, /renderRevealText\('selection'\)/u)
})

test('手动翻译失败渲染应保留已展示片段并提示重试', () => {
  const popup = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const errorBranch = popup.slice(popup.indexOf('} else if (manualState.error) {'))
  const branchEnd = errorBranch.indexOf('} else if (manualState.translation)')
  const branch = errorBranch.slice(0, branchEnd)
  assert.match(branch, /shouldPreservePartialReveal\(manualReveal\)/u)
  assert.match(branch, /settleProgressiveText\(manualReveal\)/u)
  assert.match(branch, /renderRevealText\('manual'\)/u)
})

test('手动翻译重新提交时应重置旧的渐进展示状态', () => {
  const popup = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const submitStart = popup.indexOf('async function submitManualTranslation(): Promise<void> {')
  const submitEnd = popup.indexOf('async function retranslateWithCurrentLanguages', submitStart)
  const submit = popup.slice(submitStart, submitEnd)
  assert.match(submit, /stopProgressiveReveal\(\)/u)
  assert.match(submit, /manualReveal = createProgressiveRevealState\(\)/u)
})

test('失败保留分支应按已展示片段所属请求序号校验', () => {
  const popup = readFileSync('src/renderer/src/popup.ts', 'utf8')
  assert.match(popup, /selectionRevealRequestId/u)
  const errorBranch = popup.slice(popup.indexOf("if (!payload.ok) {"))
  const branch = errorBranch.slice(0, errorBranch.indexOf("stopProgressiveReveal()"))
  assert.match(branch, /payload\.requestId === selectionRevealRequestId/u)
})

test('手动翻译失败与清空原文时应同步状态并停止旧动画', () => {
  const popup = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const manualBranch = popup.slice(popup.indexOf("if (payload.origin === 'manual') {"))
  const manualEnd = manualBranch.indexOf("if (payload.origin === 'selection'")
  const manual = manualBranch.slice(0, manualEnd)
  assert.match(manual, /manualStatus = t\('popup\.translationFailed'\)/u)

  const clearStart = popup.indexOf('manualClearBtn.addEventListener')
  const clear = popup.slice(clearStart, clearStart + 400)
  assert.match(clear, /stopProgressiveReveal\(\)/u)
  assert.match(clear, /manualReveal = createProgressiveRevealState\(\)/u)
})

test('切换模式与关闭窗口时应停止打字机动画', () => {
  const popup = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const enter = popup.slice(
    popup.indexOf('function enterManualMode(): void {'),
    popup.indexOf('function leaveManualMode(): void {')
  )
  assert.match(enter, /stopProgressiveReveal\(\)/u)

  const leaveStart = popup.indexOf('function leaveManualMode(): void {')
  const leave = popup.slice(leaveStart, popup.indexOf('function handleManualOpen', leaveStart))
  assert.match(leave, /stopProgressiveReveal\(\)/u)

  const closeStart = popup.indexOf('function closePopup(): void {')
  const close = popup.slice(closeStart, closeStart + 300)
  assert.match(close, /stopProgressiveReveal\(\)/u)
})

test('切换模式停止动画前应收束当前展示，避免切回后停在中间态', () => {
  const popup = readFileSync('src/renderer/src/popup.ts', 'utf8')
  assert.match(popup, /function settleActiveReveal\(\): void/u)
  const enter = popup.slice(
    popup.indexOf('function enterManualMode(): void {'),
    popup.indexOf('function leaveManualMode(): void {')
  )
  assert.match(enter, /settleActiveReveal\(\)[\s\S]*stopProgressiveReveal\(\)/u)
})
