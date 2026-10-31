import assert from 'node:assert/strict'
import test from 'node:test'
import { writeDocumentFileAtomically } from '../src/main/documentAtomicFile.ts'

test('原子写入在写入前取消时必须保留原目标文件且不创建临时文件', async () => {
  const writes: string[] = []
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    writeDocumentFileAtomically('/tmp/result.pdf', new Uint8Array([1]), {
      writeFile: async (path) => {
        writes.push(path)
      },
      rename: async () => undefined,
      unlink: async () => undefined
    }, controller.signal),
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
  assert.deepEqual(writes, [])
})

test('原子写入在替换前取消时必须清理临时文件并保留原目标文件', async () => {
  const controller = new AbortController()
  const writes: string[] = []
  const renames: string[] = []
  const unlinked: string[] = []

  await assert.rejects(
    writeDocumentFileAtomically('/tmp/result.pdf', new Uint8Array([1]), {
      writeFile: async (path) => {
        writes.push(path)
      },
      rename: async (source) => {
        renames.push(source)
      },
      unlink: async (path) => {
        unlinked.push(path)
      }
    }, controller.signal, {
      beforeRename: () => controller.abort()
    }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
  assert.equal(writes.length, 1)
  assert.deepEqual(renames, [])
  assert.deepEqual(unlinked, [writes[0]])
})
