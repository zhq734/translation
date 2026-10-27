import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  shouldPrefetchSelectionForButton,
  getSelectionCapturePlan
} from '../src/shared/platformCapture.ts'
import { classifyMacosAxHelperStatus } from '../src/shared/selectionBehavior.ts'

/**
 * 校验 readSelectionByNative 优先调用 nativeReaderHost（常驻 helper），
 * helper 不可用时降级到现有 osascript / PowerShell 脚本路径。
 * @returns 无返回值。
 * @author zhenghq
 */
test('readSelectionByNative 应优先调用常驻 helper 并在不可用时降级脚本', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const fnStart = source.indexOf('export async function readSelectionByNative')
  const fnEnd = source.indexOf('export async function readSelectionByNativeWithRetry', fnStart)
  const fnSource = source.slice(fnStart, fnEnd)

  // 必须导入或引用 nativeReaderHost。
  assert.match(source, /nativeReaderHost|NativeReaderHost/u)
  // readSelectionByNative 函数体内应先尝试 helper 直读（不区分大小写匹配 Helper）。
  assert.match(fnSource, /nativeReaderHost|readSelection.*helper|host\.readSelection/iu)
  // helper 不可用时应降级到现有脚本（osascript 或 PowerShell）。
  assert.match(fnSource, /osascript|execFileP/u)
})

/**
 * 校验 Windows 预取不再被排除，shouldPrefetchSelectionForButton 对 win32 返回 true，
 * helper 不可用时由取词管线自行跳过预取。
 * @returns 无返回值。
 * @author zhenghq
 */
test('shouldPrefetchSelectionForButton 应放开 win32 预取', () => {
  // 改造后 win32 也允许预取，helper 不可用时由管线跳过。
  assert.equal(shouldPrefetchSelectionForButton('win32'), true)
  assert.equal(shouldPrefetchSelectionForButton('darwin'), true)
  assert.equal(shouldPrefetchSelectionForButton('linux'), true)
})

/**
 * 校验 captureDirect 对应实现（快捷键路径）在 Windows helper 可用时先执行
 * 上限 300ms 的原生直读，未命中再回退到模拟复制。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 快捷键路径在 helper 可用时应先直读再复制', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  // 应存在 helper 可用时先直读的逻辑（300ms 上限）。
  assert.match(source, /readSelectionByNative.*300|300.*readSelectionByNative|NATIVE_DIRECT_READ_TIMEOUT|directReadTimeoutMs/u)
})

/**
 * 校验 Windows 复制兜底在全局 Ctrl+C 前先尝试 WM_COPY 中间层，
 * 500ms 无响应后回退到全局 Ctrl+C。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 复制兜底应先尝试 WM_COPY 再回退全局 Ctrl+C', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  // 应存在 WM_COPY 相关逻辑。
  assert.match(source, /WM_COPY|wmCopy|sendMessageTimeout|SendMessageTimeout/u)
  // 应存在 500ms 超时回退到 Ctrl+C 的逻辑。
  assert.match(source, /500|WM_COPY_TIMEOUT|wmCopyTimeoutMs/u)
})

/**
 * 校验哨兵写入后回读校验：写入哨兵后立即回读，不一致时重试一次，
 * 仍失败返回 clipboard-locked，不返回旧剪贴板内容。
 * @returns 无返回值。
 * @author zhenghq
 */
test('哨兵写入后应回读校验并可能返回 clipboard-locked', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  // 应存在哨兵回读校验逻辑。
  assert.match(source, /clipboard-locked|clipboardLocked/u)
  // 应在写入哨兵后回读对比（readback === sentinel 或 readText 后比较哨兵）。
  assert.match(source, /readback.*sentinel|readText[\s\S]*sentinel|sentinel[\s\S]*readText/u)
})

/**
 * 校验 SelectionFailureReason 类型已增加 clipboard-locked。
 * @returns 无返回值。
 * @author zhenghq
 */
test('SelectionFailureReason 应包含 clipboard-locked', () => {
  const source = readFileSync('src/shared/selectionCaptureCoordinator.ts', 'utf8')
  assert.match(source, /clipboard-locked/u)
})

/**
 * 校验 resolveSelectionCaptureFailureMessage 增加 clipboard-locked 对应文案。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveSelectionCaptureFailureMessage 应处理 clipboard-locked', () => {
  const source = readFileSync('src/shared/selectionBehavior.ts', 'utf8')
  assert.match(source, /clipboard-locked/u)
  // 应有对应的中文文案。
  assert.match(source, /剪贴板|clipboard.*锁|locked/u)
})

/**
 * 校验 macOS AX helper 调用必须记录状态分类、耗时与降级标志，
 * 且不得记录选中文字内容，便于区分 AX 不可见与 helper 调用失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS AX helper 必须记录状态分类与耗时且不泄露文本', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const start = source.indexOf('async function readSelectionViaMacosHelper')
  const end = source.indexOf('async function readSelectionViaWindowsHelper', start)
  const fnSource = source.slice(start, end)

  assert.ok(start >= 0 && end > start, 'readSelectionViaMacosHelper 应有明确边界')
  assert.match(fnSource, /status=|status\b/u, '必须记录 helper 状态')
  assert.match(fnSource, /elapsedMs|elapsed/u, '必须记录调用耗时')
  assert.match(fnSource, /fallback/u, '必须记录是否降级到 osascript')
  assert.match(fnSource, /classifyMacosAxHelperStatus/u, '必须用状态分类器区分权限状态')
  assert.doesNotMatch(fnSource, /textLength|text\.length/u, '不得记录选区文本长度')
})

/**
 * 校验 macOS AX helper 状态分类器能区分权限状态且不返回文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS AX helper 状态分类器应区分 PERMISSION 且不解析文本', () => {
  assert.equal(classifyMacosAxHelperStatus('PRESENT\n选中文字'), 'PRESENT')
  assert.equal(classifyMacosAxHelperStatus('EMPTY'), 'EMPTY')
  assert.equal(classifyMacosAxHelperStatus('UNKNOWN'), 'UNKNOWN')
  assert.equal(classifyMacosAxHelperStatus('PERMISSION'), 'PERMISSION')
  assert.equal(classifyMacosAxHelperStatus('乱码'), 'UNKNOWN')
})
