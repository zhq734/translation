import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 惰性加载待实现的协议模块，不存在时给出明确失败而非模块解析错误。
 * @returns 协议模块导出。
 * @author zhenghq
 */
async function loadProtocol(): Promise<typeof import('../src/shared/nativeReaderProtocol')> {
  const module = await import('../src/shared/nativeReaderProtocol.ts')
  assert.ok(module, '缺少协议模块: src/shared/nativeReaderProtocol.ts')
  return module
}

/**
 * 校验协议消息的行分隔 JSON 编码/解码与请求响应配对。
 * @returns 无返回值。
 * @author zhenghq
 */
test('协议应使用行分隔 JSON 编码请求并按 id 配对响应', async () => {
  const { encodeNativeReaderRequest, parseNativeReaderResponseLine } = await loadProtocol()

  const encoded = encodeNativeReaderRequest({ id: 7, method: 'readSelection' })
  assert.ok(encoded.endsWith('\n'), '请求必须以换行结尾')
  assert.deepEqual(JSON.parse(encoded), { id: 7, method: 'readSelection' })

  const ok = parseNativeReaderResponseLine('{"id":7,"status":"present","text":"hello"}')
  assert.deepEqual(ok, { id: 7, status: 'present', text: 'hello' })

  // 空行与不合法 JSON 不得崩溃，返回 null 由宿主忽略。
  assert.equal(parseNativeReaderResponseLine(''), null)
  assert.equal(parseNativeReaderResponseLine('not json'), null)
})

/**
 * 校验响应 id 乱序时仍能正确配对待定请求。
 * @returns 无返回值。
 * @author zhenghq
 */
test('协议应支持乱序响应按 id 配对', async () => {
  const { NativeReaderRequestMatcher } = await loadProtocol()
  const matcher = new NativeReaderRequestMatcher()

  const first = matcher.track(1)
  const second = matcher.track(2)

  // 后发的请求先响应，先发的后响应，均应按 id 正确配对。
  matcher.resolve({ id: 2, status: 'present', text: 'second' })
  assert.deepEqual(await second, { status: 'present', text: 'second' })
  assert.equal(matcher.pendingCount, 1)

  matcher.resolve({ id: 1, status: 'empty', text: '' })
  assert.deepEqual(await first, { status: 'empty', text: '' })
  assert.equal(matcher.pendingCount, 0)
})

/**
 * 校验待定请求的超时判定。
 * @returns 无返回值。
 * @author zhenghq
 */
test('协议应在超时后拒绝待定请求', async () => {
  const { NativeReaderRequestMatcher } = await loadProtocol()
  const matcher = new NativeReaderRequestMatcher()

  const pending = matcher.track(1, 30)
  await assert.rejects(pending, /timeout/i)
  assert.equal(matcher.pendingCount, 0)
})

/**
 * 校验 helper 崩溃时全部待定请求被拒绝且宿主可感知。
 * @returns 无返回值。
 * @author zhenghq
 */
test('崩溃检测应拒绝全部待定请求', async () => {
  const { NativeReaderRequestMatcher } = await loadProtocol()
  const matcher = new NativeReaderRequestMatcher()

  const first = matcher.track(1)
  const second = matcher.track(2)
  matcher.rejectAll(new Error('helper exited'))

  await assert.rejects(first, /helper exited/)
  await assert.rejects(second, /helper exited/)
  assert.equal(matcher.pendingCount, 0)
})
