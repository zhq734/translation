import assert from 'node:assert/strict'
import test from 'node:test'
import { DeepLxCheckService } from '../src/main/deepLxCheck.ts'

/**
 * 构造 DeepLX 检测响应。
 * @param body 响应对象。
 * @param status HTTP 状态码。
 * @returns Fetch 兼容响应。
 * @author zhenghq
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('多地址检测应逐个请求，部分地址 404 时只要存在可用地址就判定在线', async () => {
  const calls: string[] = []
  const service = new DeepLxCheckService({
    fetch: async (url) => {
      calls.push(String(url))
      if (String(url).includes('first.example')) return jsonResponse({}, 404)
      return jsonResponse({ code: 200, data: '测试' })
    }
  })

  const result = await service.check('https://first.example/translate, https://second.example/translate')

  assert.equal(result.online, true)
  assert.equal(result.message, '1/2 个服务在线')
  assert.equal(result.url, '')
  assert.deepEqual(calls, [
    'https://first.example/translate',
    'https://second.example/translate'
  ])
})

test('全部地址可用时应返回汇总状态且不泄露地址', async () => {
  const service = new DeepLxCheckService({
    fetch: async () => jsonResponse({ code: 200, data: '测试' })
  })

  const result = await service.check('https://a.example/translate，https://b.example/translate')
  assert.deepEqual(result, { url: '', online: true, message: '2/2 个服务在线' })
  assert.equal(JSON.stringify(result).includes('a.example'), false)
})

test('未配置、全部失败和超时应返回脱敏状态', async () => {
  const service = new DeepLxCheckService({
    fetch: async (url) => {
      if (String(url).includes('timeout')) throw new DOMException('aborted', 'TimeoutError')
      throw new TypeError(`failed for ${String(url)}`)
    }
  })

  assert.deepEqual(await service.check(''), {
    url: '',
    online: false,
    message: '未配置地址'
  })
  assert.deepEqual(await service.check('https://timeout.example/translate'), {
    url: '',
    online: false,
    message: '0/1 个服务在线：连接超时'
  })
  const failed = await service.check('https://private.example/translate')
  assert.equal(failed.online, false)
  assert.equal(failed.message, '0/1 个服务在线：网络连接失败')
  assert.equal(JSON.stringify(failed).includes('private.example'), false)
})
