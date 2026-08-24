import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  clearDownloadResumeState,
  loadDownloadResumeState,
  saveDownloadResumeState,
  type DownloadResumeRecord
} from '../src/main/updateDownloadResume.ts'

/**
 * 创建临时下载目录及其中的目标文件路径。
 * @returns 目录、目标路径和清理函数。
 * @author zhenghq
 */
async function createWorkspace(): Promise<{
  directory: string
  destination: string
  cleanup: () => Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'selection-translator-resume-'))
  return {
    directory,
    destination: join(directory, 'update.dmg'),
    cleanup: async () => rm(directory, { recursive: true, force: true })
  }
}

test('续传记录在版本、总长度与校验值一致时应可复用', async () => {
  const { destination, cleanup } = await createWorkspace()
  const record: DownloadResumeRecord = {
    version: '1.0.4',
    total: 1000,
    sha512: 'abc',
    segments: [{ start: 0, end: 999, completed: 400 }]
  }

  try {
    await writeFile(`${destination}.part`, Buffer.alloc(400))
    await saveDownloadResumeState(destination, record)

    const loaded = await loadDownloadResumeState(destination, {
      version: '1.0.4',
      total: 1000,
      sha512: 'abc'
    })
    assert.ok(loaded)
    assert.deepEqual(loaded.segments, [{ start: 0, end: 999, completed: 400 }])
  } finally {
    await cleanup()
  }
})

test('续传记录在版本、总长度或校验值任一不一致时应丢弃', async () => {
  const { destination, cleanup } = await createWorkspace()
  const record: DownloadResumeRecord = {
    version: '1.0.4',
    total: 1000,
    sha512: 'abc',
    segments: [{ start: 0, end: 999, completed: 400 }]
  }

  try {
    await writeFile(`${destination}.part`, Buffer.alloc(400))
    await saveDownloadResumeState(destination, record)

    assert.equal(
      await loadDownloadResumeState(destination, { version: '1.0.5', total: 1000, sha512: 'abc' }),
      undefined
    )
    assert.equal(
      await loadDownloadResumeState(destination, { version: '1.0.4', total: 2000, sha512: 'abc' }),
      undefined
    )
    assert.equal(
      await loadDownloadResumeState(destination, { version: '1.0.4', total: 1000, sha512: 'xyz' }),
      undefined
    )
  } finally {
    await cleanup()
  }
})

test('续传记录损坏时应丢弃而不是抛出异常', async () => {
  const { destination, cleanup } = await createWorkspace()

  try {
    await writeFile(`${destination}.part`, Buffer.alloc(400))
    await writeFile(`${destination}.part.json`, '{ 这不是合法 JSON')

    assert.equal(
      await loadDownloadResumeState(destination, { version: '1.0.4', total: 1000, sha512: 'abc' }),
      undefined
    )
  } finally {
    await cleanup()
  }
})

test('临时文件缺失或短于记录进度时应丢弃续传记录', async () => {
  const { destination, cleanup } = await createWorkspace()
  const record: DownloadResumeRecord = {
    version: '1.0.4',
    total: 1000,
    sha512: 'abc',
    segments: [{ start: 0, end: 999, completed: 400 }]
  }

  try {
    await saveDownloadResumeState(destination, record)
    assert.equal(
      await loadDownloadResumeState(destination, { version: '1.0.4', total: 1000, sha512: 'abc' }),
      undefined,
      '缺少 .part 文件时不能复用进度'
    )

    await writeFile(`${destination}.part`, Buffer.alloc(100))
    assert.equal(
      await loadDownloadResumeState(destination, { version: '1.0.4', total: 1000, sha512: 'abc' }),
      undefined,
      '.part 实际长度小于记录进度时不能复用'
    )
  } finally {
    await cleanup()
  }
})

test('清理续传状态应同时删除临时文件与进度记录', async () => {
  const { destination, cleanup } = await createWorkspace()

  try {
    await writeFile(`${destination}.part`, Buffer.alloc(10))
    await saveDownloadResumeState(destination, {
      version: '1.0.4',
      total: 10,
      segments: [{ start: 0, end: 9, completed: 10 }]
    })

    await clearDownloadResumeState(destination)

    await assert.rejects(readFile(`${destination}.part`))
    await assert.rejects(readFile(`${destination}.part.json`))
  } finally {
    await cleanup()
  }
})

test('无校验值时续传记录仍应按版本与总长度判定复用', async () => {
  const { destination, cleanup } = await createWorkspace()

  try {
    await writeFile(`${destination}.part`, Buffer.alloc(256))
    await saveDownloadResumeState(destination, {
      version: '1.0.4',
      total: 1000,
      segments: [{ start: 0, end: 999, completed: 256 }]
    })

    const loaded = await loadDownloadResumeState(destination, { version: '1.0.4', total: 1000 })
    assert.ok(loaded)
    assert.equal(loaded.segments[0].completed, 256)

    assert.equal(
      await loadDownloadResumeState(destination, {
        version: '1.0.4',
        total: 1000,
        sha512: 'abc'
      }),
      undefined,
      '本次有校验值而记录没有时不能复用'
    )
  } finally {
    await cleanup()
  }
})
