import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/** 读取主进程取词源码，用于约束复制兜底重试轮次行为。 @author zhenghq */
function readCaptureSource(): string {
  return readFileSync('src/main/capture.ts', 'utf8')
}

/**
 * 校验独立重试轮次在重写哨兵前必须补读剪贴板。
 *
 * 与 macOS AX 复制路径的约束一致：应用可能恰好在上一轮轮询最后一次读取
 * 与超时判定之间异步写入复制结果。盲重试前重写哨兵会直接覆盖这份晚到
 * 内容，导致注入的复制键不再有响应而取词超时。
 * @returns 无返回值。
 * @author zhenghq
 */
test('复制兜底重试轮次重写哨兵前必须补读剪贴板以保留晚到写入', () => {
  const source = readCaptureSource()
  const retryIndex = source.indexOf('[capture] copy-fallback-retry retry=')
  assert.ok(retryIndex >= 0, '应存在复制兜底重试轮次日志')
  const retryContext = source.slice(retryIndex, retryIndex + 2000)
  assert.match(
    retryContext,
    /hasClipboardCaptureCompleted\(/u,
    '重试轮次必须先补读并判断剪贴板是否已有晚到写入'
  )
  // 补读命中时不得重写哨兵：哨兵重写必须在未命中分支内。
  const lateReadIndex = retryContext.indexOf('hasClipboardCaptureCompleted(')
  const clearIndex = retryContext.indexOf('clipboard.clear()')
  assert.ok(clearIndex >= 0, '未命中时仍需重写哨兵')
  assert.ok(
    lateReadIndex < clearIndex,
    '补读判定必须先于哨兵重写执行'
  )
})
