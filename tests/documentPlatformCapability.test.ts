import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detectDocumentPlatformCapability,
  getDocumentPlatformCapability,
  type DocumentPlatformInput
} from '../src/shared/documentPlatformCapability.ts'

/**
 * 构造平台能力探测输入。
 * @param overrides 需要覆盖的默认字段。
 * @returns 完整的平台能力探测输入。
 * @author zhenghq
 */
function input(overrides: Partial<DocumentPlatformInput> = {}): DocumentPlatformInput {
  return {
    platform: 'darwin',
    release: '23.6.0',
    arch: 'arm64',
    env: {},
    ...overrides
  }
}

test('现代 macOS、Windows 与 Linux 应支持文档翻译', () => {
  assert.deepEqual(detectDocumentPlatformCapability(input()), {
    supported: true,
    reason: null
  })
  assert.deepEqual(detectDocumentPlatformCapability(input({
    platform: 'win32',
    release: '10.0.22631',
    arch: 'x64'
  })), {
    supported: true,
    reason: null
  })
  assert.deepEqual(detectDocumentPlatformCapability(input({
    platform: 'linux',
    release: '6.8.0',
    arch: 'x64'
  })), {
    supported: true,
    reason: null
  })
})

test('Windows 7 必须禁用文档翻译并返回明确原因', () => {
  assert.deepEqual(detectDocumentPlatformCapability(input({
    platform: 'win32',
    release: '6.1.7601',
    arch: 'x64'
  })), {
    supported: false,
    reason: 'windows-7-unsupported'
  })
})

test('Win7 专用构建标记必须在任意平台禁用文档翻译', () => {
  assert.deepEqual(detectDocumentPlatformCapability(input({
    env: { WIN7_BUILD: '1' }
  })), {
    supported: false,
    reason: 'windows-7-unsupported'
  })
})

test('未知平台与未知架构应保守禁用文档翻译', () => {
  assert.deepEqual(detectDocumentPlatformCapability(input({
    platform: 'freebsd' as NodeJS.Platform
  })), {
    supported: false,
    reason: 'unsupported-platform'
  })
  assert.deepEqual(detectDocumentPlatformCapability(input({
    arch: 'ia32' as NodeJS.Architecture
  })), {
    supported: false,
    reason: 'unsupported-architecture'
  })
})

test('当前运行时能力探测应复用纯函数并允许注入环境', () => {
  const capability = getDocumentPlatformCapability({
    platform: 'win32',
    release: '6.1.7601',
    arch: 'x64',
    env: {}
  })
  assert.equal(capability.supported, false)
  assert.equal(capability.reason, 'windows-7-unsupported')
})

