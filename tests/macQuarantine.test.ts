import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MACOS_APPLICATION_PATH,
  removeMacOSApplicationQuarantine
} from '../src/main/macQuarantine.ts'

test('macOS 解除隔离属性应只执行固定路径的 xattr 命令', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const result = await removeMacOSApplicationQuarantine({
    platform: 'darwin',
    runCommand: async (command, args) => {
      calls.push({ command, args })
    }
  })

  assert.deepEqual(calls, [{
    command: '/usr/bin/xattr',
    args: ['-dr', 'com.apple.quarantine', MACOS_APPLICATION_PATH]
  }])
  assert.equal(result.ok, true)
})

test('非 macOS 环境不得执行 xattr', async () => {
  let called = false
  const result = await removeMacOSApplicationQuarantine({
    platform: 'win32',
    runCommand: async () => {
      called = true
    }
  })

  assert.equal(called, false)
  assert.equal(result.ok, false)
  assert.match(result.message, /仅 macOS/u)
})

test('不是固定应用路径时不得执行 xattr', async () => {
  let called = false
  const result = await removeMacOSApplicationQuarantine({
    platform: 'darwin',
    applicationPath: '/tmp/划词翻译.app',
    runCommand: async () => {
      called = true
    }
  })

  assert.equal(called, false)
  assert.equal(result.ok, false)
  assert.match(result.message, /只允许处理 \/Applications\/划词翻译\.app/u)
})

test('xattr 执行失败时应保留手动命令提示且不得调用 sudo', async () => {
  const result = await removeMacOSApplicationQuarantine({
    platform: 'darwin',
    runCommand: async () => {
      throw new Error('permission denied')
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /xattr -dr com\.apple\.quarantine/u)
  assert.doesNotMatch(result.message, /sudo/u)
})

test('应用本来没有隔离属性时应视为成功', async () => {
  const result = await removeMacOSApplicationQuarantine({
    platform: 'darwin',
    runCommand: async () => {
      throw new Error('xattr: No such xattr: com.apple.quarantine')
    }
  })

  assert.equal(result.ok, true)
  assert.match(result.message, /没有隔离属性/u)
})
