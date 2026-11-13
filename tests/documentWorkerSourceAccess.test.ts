import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDocumentWorkerSourceAccess
} from '../src/main/documentWorkerSourceAccess.ts'

/**
 * 创建源文件访问测试依赖，并记录实际读取的路径。
 * @param files 路径到文件字节的映射。
 * @param approvedPaths 已获授权的路径集合。
 * @returns 源文件访问实例与读取记录。
 * @author zhenghq
 */
function sourceAccess(
  files: Record<string, Uint8Array>,
  approvedPaths = new Set(Object.keys(files))
) {
  const reads: string[] = []
  return {
    reads,
    access: createDocumentWorkerSourceAccess({
      isApprovedPath: (path) => approvedPaths.has(path),
      readFile: async (path) => {
        reads.push(path)
        const bytes = files[path]
        if (!bytes) throw new Error('not-found')
        return bytes
      }
    })
  }
}

test('应为已授权 PDF 返回当前快照记录的文件字节', async () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
  const { access, reads } = sourceAccess({ '/tmp/source.pdf': bytes })

  access.rememberSnapshot({
    source: { source: { path: '/tmp/source.pdf', format: 'pdf' } }
  } as never)

  assert.deepEqual(await access.getSourceBytes(), {
    ok: true,
    mimeType: 'application/pdf',
    bytes
  })
  assert.deepEqual(reads, ['/tmp/source.pdf'])
})

test('HTML 源文件应解码并返回脱敏后的 UTF-8 字节', async () => {
  const { access } = sourceAccess({
    '/tmp/source.html': new TextEncoder().encode(
      '<script>alert(1)</script><p>正文</p>'
    )
  })

  access.rememberSnapshot({
    source: { source: { path: '/tmp/source.html', format: 'html' } }
  } as never)

  const result = await access.getSourceBytes()
  assert.equal(result.ok, true)
  assert.equal(result.mimeType, 'text/html; charset=utf-8')
  const html = new TextDecoder().decode(result.bytes)
  assert.doesNotMatch(html, /script/i)
  assert.match(html, /正文/u)
})

test('未记录或未授权源文件时不得读取磁盘', async () => {
  const bytes = new Uint8Array([1])
  const { access, reads } = sourceAccess({ '/tmp/source.pdf': bytes }, new Set())

  assert.deepEqual(await access.getSourceBytes(), {
    ok: false,
    code: 'source-not-found'
  })

  access.rememberSnapshot({
    source: { source: { path: '/tmp/source.pdf', format: 'pdf' } }
  } as never)
  assert.deepEqual(await access.getSourceBytes(), {
    ok: false,
    code: 'source-not-found'
  })
  assert.deepEqual(reads, [])
})

test('源文件读取失败和非 PDF 格式应返回稳定错误分类', async () => {
  const { access } = sourceAccess({}, new Set(['/tmp/missing.pdf']))
  access.rememberSnapshot({
    source: { source: { path: '/tmp/missing.pdf', format: 'pdf' } }
  } as never)
  assert.deepEqual(await access.getSourceBytes(), {
    ok: false,
    code: 'source-unavailable'
  })

  const unsupported = sourceAccess({ '/tmp/source.docx': new Uint8Array([1]) })
  unsupported.access.rememberSnapshot({
    source: { source: { path: '/tmp/source.docx', format: 'docx' } }
  } as never)
  assert.deepEqual(await unsupported.access.getSourceBytes(), {
    ok: false,
    code: 'source-not-found'
  })
})
