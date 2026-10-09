import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const macForegroundSource = readFileSync('src/main/macForeground.ts', 'utf8')

/**
 * 从源码中截取指定函数的函数体。
 * @param source 源码。
 * @param signature 函数签名起始片段。
 * @returns 从签名到函数结束的源码片段。
 * @author zhenghq
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end)
}

/**
 * 去掉源码中的块注释与行注释，避免注释文本干扰行为断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

/**
 * 校验异步记录源应用必须允许覆盖上一轮残留记录。
 *
 * 用户可能在应用 A 划词但未点击“译”，随后切到应用 B 再划词：此时待交还记录
 * 仍是 A，点击“译”会执行 `open -b A`，表现为「回到之前的应用页面取词」。
 * 划词 / 取词入口会调用本函数，因此它必须在本应用非最前时用当前系统最前应用
 * 覆盖旧记录；本应用仍是最前时 `readFrontmostAppSnapshot()` 会返回 null，
 * 天然不会覆盖正确记录。
 * @returns 无返回值。
 * @author zhenghq
 */
test('异步记录源应用必须允许覆盖上一轮残留记录', () => {
  const src = stripComments(
    extractFunction(
      macForegroundSource,
      'export function rememberFrontmostAppIfInactive(): void {'
    )
  )

  assert.doesNotMatch(
    src,
    /if \(pendingReturnApp\) return/u,
    '不得因已有旧记录而短路，否则多应用切换后仍会交还给旧应用'
  )
  assert.match(src, /readFrontmostAppSnapshot\(\)/u, '必须重新读取系统当前最前应用')
  assert.match(
    src,
    /rememberFrontmostApp\(snapshot\)|pendingReturnApp = snapshot/u,
    '必须用当前最前应用覆盖旧的待交还记录'
  )
})

/**
 * 校验可等待的异步记录入口同样必须允许覆盖旧记录。
 *
 * 网页阅读器、手动翻译、剪贴板图片翻译等入口都使用本函数；保留「已有记录不覆盖」
 * 会让跨应用操作后仍把前台交还给上一次的源应用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('可等待的异步记录源应用同样必须允许覆盖旧记录', () => {
  const src = stripComments(
    extractFunction(
      macForegroundSource,
      'export async function rememberFrontmostAppIfInactiveAsync(): Promise<void> {'
    )
  )

  assert.doesNotMatch(
    src,
    /if \(pendingReturnApp\) return/u,
    '不得因已有旧记录而短路'
  )
  assert.match(src, /readFrontmostAppSnapshot\(\)/u, '必须重新读取系统当前最前应用')
  assert.match(
    src,
    /rememberFrontmostApp\(snapshot\)|pendingReturnApp = snapshot/u,
    '必须用当前最前应用覆盖旧的待交还记录'
  )
})

/**
 * 校验异步刷新必须按请求序号丢弃过期读取结果。
 *
 * 允许覆盖后若两次读取并发，先发起的读取可能后返回并用旧应用覆盖新记录。
 * 每个刷新请求必须持有单调递增序号，返回时只有仍是最新请求才允许写入；
 * 显式丢弃记录的 `forgetFrontmostApp()` 也必须使在途读取失效，避免旧记录复活。
 * @returns 无返回值。
 * @author zhenghq
 */
test('异步刷新待交还记录必须丢弃过期读取结果', () => {
  const syncSrc = stripComments(
    extractFunction(
      macForegroundSource,
      'export function rememberFrontmostAppIfInactive(): void {'
    )
  )
  const asyncSrc = stripComments(
    extractFunction(
      macForegroundSource,
      'export async function rememberFrontmostAppIfInactiveAsync(): Promise<void> {'
    )
  )
  const forgetSrc = stripComments(
    extractFunction(macForegroundSource, 'export function forgetFrontmostApp(): void {')
  )

  for (const [name, src] of [['同步', syncSrc], ['可等待', asyncSrc]] as const) {
    assert.match(src, /\+\+frontmostRecordRequestId/u, `${name}入口必须为每次刷新分配新序号`)
    assert.match(
      src,
      /requestId !== frontmostRecordRequestId/u,
      `${name}入口必须丢弃已被更新请求取代的读取结果`
    )
  }
  assert.match(
    forgetSrc,
    /frontmostRecordRequestId \+= 1/u,
    '显式丢弃记录时必须使在途读取失效，避免旧记录复活'
  )
})

/**
 * 校验公共取词入口必须在交还前台之前同步刷新源应用，消除异步竞态。
 *
 * 仅靠异步刷新时，用户划词后立刻点击“译”，子进程快照可能尚未返回，
 * `restoreFrontmostAppForCapture()` 会读到上一轮应用并执行 `open -b 旧应用`。
 * `showSelectionReadingPopup` 是按钮取词与快捷键取词的公共入口，必须在此
 * 同步读取当前系统最前应用并覆盖旧记录，且早于 `deactivatePopupForCapture()`
 * 交还前台；本应用已是最前时同步读取返回 null，不会覆盖已有的正确记录。
 * 只在公共入口刷新一次，避免在多个热路径重复 spawn `lsappinfo` 拖慢取词。
 * @returns 无返回值。
 * @author zhenghq
 */
test('公共取词入口必须同步刷新源应用以消除异步竞态', () => {
  const indexSource = readFileSync('src/main/index.ts', 'utf8')
  const readingSrc = stripComments(
    extractFunction(indexSource, 'function showSelectionReadingPopup(')
  )

  assert.match(
    macForegroundSource,
    /export function refreshFrontmostAppForSelection\(\): void/u,
    '必须提供同步刷新入口'
  )
  assert.match(
    readingSrc,
    /refreshFrontmostAppForSelection\(\)/u,
    '公共取词入口必须同步刷新源应用'
  )
  assert.ok(
    readingSrc.indexOf('refreshFrontmostAppForSelection()') <
      readingSrc.indexOf('deactivatePopupForCapture()'),
    '同步刷新必须发生在交还前台之前'
  )
  assert.ok(
    readingSrc.indexOf('refreshFrontmostAppForSelection()') <
      readingSrc.indexOf('showPopup('),
    '同步刷新必须发生在显示读取弹窗（可能激活本应用）之前'
  )
})
