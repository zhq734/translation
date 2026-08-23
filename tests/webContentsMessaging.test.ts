import test from 'node:test'
import assert from 'node:assert/strict'
import { sendToAliveWebContents } from '../src/main/webContentsMessaging'

test('主进程消息只应发送给仍存活的 WebContents', () => {
  const messages: Array<{ channel: string, payload: unknown }> = []
  const sent = sendToAliveWebContents({
    isDestroyed: () => false,
    send: (channel, payload) => messages.push({ channel, payload })
  }, 'web-reader:state', { loading: false })

  assert.equal(sent, true)
  assert.deepEqual(messages, [{ channel: 'web-reader:state', payload: { loading: false } }])
})

test('WebContents 已销毁时应跳过主进程消息发送', () => {
  let sendCount = 0
  const sent = sendToAliveWebContents({
    isDestroyed: () => true,
    send: () => { sendCount += 1 }
  }, 'web-reader:state', { loading: false })

  assert.equal(sent, false)
  assert.equal(sendCount, 0)
})

test('检查后窗口恰好销毁时应吞掉 Electron 生命周期异常', () => {
  const sent = sendToAliveWebContents({
    isDestroyed: () => false,
    send: () => { throw new TypeError('Object has been destroyed') }
  }, 'web-reader:state', { loading: false })

  assert.equal(sent, false)
})

test('检查 WebContents 状态时发生销毁竞争也应安全跳过', () => {
  const sent = sendToAliveWebContents({
    isDestroyed: () => { throw new TypeError('Object has been destroyed') },
    send: () => { throw new Error('不应执行发送') }
  }, 'web-reader:state', { loading: false })

  assert.equal(sent, false)
})

test('非生命周期异常仍应向上抛出', () => {
  assert.throws(() => sendToAliveWebContents({
    isDestroyed: () => false,
    send: () => { throw new Error('IPC 序列化失败') }
  }, 'web-reader:state', { loading: false }), /IPC 序列化失败/u)
})
