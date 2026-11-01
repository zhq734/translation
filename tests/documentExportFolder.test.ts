import assert from 'node:assert/strict'
import test from 'node:test'
import { openDocumentExportFolder } from '../src/main/documentExportFolder.ts'

test('打开导出目录时直接使用系统文件管理器定位文件', async () => {
  const revealed: string[] = []
  let openPathCalls = 0
  const result = await openDocumentExportFolder('/tmp/translated.pdf', {
    showItemInFolder: (path) => {
      revealed.push(path)
    },
    openPath: async (path) => {
      openPathCalls += 1
      return ''
    }
  })

  assert.equal(result, true)
  assert.deepEqual(revealed, ['/tmp/translated.pdf'])
  assert.equal(openPathCalls, 0)
})

test('无法预先确认导出文件是否存在时仍交由系统文件管理器定位', async () => {
  const revealed: string[] = []
  const result = await openDocumentExportFolder('/tmp/missing.pdf', {
    showItemInFolder: (path) => {
      revealed.push(path)
    },
    openPath: async () => {
      return ''
    }
  })

  assert.equal(result, true)
  assert.deepEqual(revealed, ['/tmp/missing.pdf'])
})

test('文件管理器定位异常时回退到打开父目录', async () => {
  const opened: string[] = []
  const result = await openDocumentExportFolder('/tmp/translated.pdf', {
    showItemInFolder: () => {
      throw new Error('reveal-failed')
    },
    openPath: async (path) => {
      opened.push(path)
      return ''
    }
  })

  assert.equal(result, true)
  assert.deepEqual(opened, ['/tmp'])
})

test('定位和回退打开目录都失败时必须向上报告失败', async () => {
  const result = await openDocumentExportFolder('/tmp/translated.pdf', {
    showItemInFolder: () => {
      throw new Error('reveal-failed')
    },
    openPath: async () => '无法打开目录'
  })

  assert.equal(result, false)
})
