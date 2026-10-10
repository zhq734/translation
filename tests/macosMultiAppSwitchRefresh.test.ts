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
 * 校验同步记录源应用入口必须整体删除。
 *
 * panel 落地后翻译弹窗与设置窗口不再占用应用级前台，划词路径不再需要
 * `rememberFrontmostAppIfInactive()` 记录交还目标；仅网页阅读器等仍会激活
 * 应用的路径保留可等待的异步入口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('划词同步记录源应用入口必须整体删除', () => {
  const code = stripComments(macForegroundSource)

  assert.doesNotMatch(
    code,
    /export function rememberFrontmostAppIfInactive\(/u,
    '不得再导出同步记录源应用入口'
  )
  assert.doesNotMatch(
    code,
    /refreshFrontmostAppForSelection/u,
    '不得再保留取词专用同步刷新入口'
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
  const asyncSrc = stripComments(
    extractFunction(
      macForegroundSource,
      'export async function rememberFrontmostAppIfInactiveAsync(): Promise<void> {'
    )
  )
  const forgetSrc = stripComments(
    extractFunction(macForegroundSource, 'export function forgetFrontmostApp(): void {')
  )

  assert.match(asyncSrc, /\+\+frontmostRecordRequestId/u, '可等待入口必须为每次刷新分配新序号')
  assert.match(
    asyncSrc,
    /requestId !== frontmostRecordRequestId/u,
    '可等待入口必须丢弃已被更新请求取代的读取结果'
  )
  assert.match(
    forgetSrc,
    /frontmostRecordRequestId \+= 1/u,
    '显式丢弃记录时必须使在途读取失效，避免旧记录复活'
  )
})

/**
 * 校验公共取词入口不得再做应用级前台交还或同步刷新。
 *
 * panel 下弹窗显示不激活应用，取词前的精确交还、同步刷新源应用都属于旧补偿
 * 机制；公共取词入口只需在 Windows 上按既有策略让弹窗退出前台。
 * @returns 无返回值。
 * @author zhenghq
 */
test('公共取词入口不得再同步刷新或交还应用级前台', () => {
  const indexSource = readFileSync('src/main/index.ts', 'utf8')
  const readingSrc = stripComments(
    extractFunction(indexSource, 'function showSelectionReadingPopup(')
  )

  assert.doesNotMatch(readingSrc, /refreshFrontmostAppForSelection/u, '不得再同步刷新源应用')
  assert.doesNotMatch(readingSrc, /restoreFrontmostAppForCapture/u, '不得再交还应用级前台')
  assert.doesNotMatch(readingSrc, /rememberFrontmostAppIfInactive\(/u, '不得再记录弹窗交还目标')
  assert.match(readingSrc, /showPopup\(/u, '公共取词入口仍需显示读取弹窗')
})
