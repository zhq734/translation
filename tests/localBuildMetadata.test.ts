import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveLocalBuildMetadataPath,
  readLocalBuildMetadata
} from '../src/main/localBuildMetadata.ts'
import { createBuildMetadata, serializeBuildMetadata } from '../src/shared/buildMetadata.ts'

const metadata = createBuildMetadata({
  version: '1.1.2',
  sourceCommit: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e',
  workflowRunId: '123456789',
  workflowRunAttempt: '1'
})

test('本地构建元数据应位于应用资源目录的固定文件名下', () => {
  assert.equal(
    resolveLocalBuildMetadataPath('/Applications/划词翻译.app/Contents/Resources'),
    '/Applications/划词翻译.app/Contents/Resources/build-info.json'
  )
})

test('正式安装包应能读取内嵌的构建元数据', async () => {
  const result = await readLocalBuildMetadata({
    packaged: true,
    resourcesPath: '/Resources',
    readFile: async (path) => {
      assert.equal(path, '/Resources/build-info.json')
      return serializeBuildMetadata(metadata)
    }
  })

  assert.deepEqual(result, metadata)
})

test('开发环境不应读取构建元数据', async () => {
  let readCount = 0
  const result = await readLocalBuildMetadata({
    packaged: false,
    resourcesPath: '/Resources',
    readFile: async () => {
      readCount += 1
      return serializeBuildMetadata(metadata)
    }
  })

  assert.equal(result, undefined)
  assert.equal(readCount, 0)
})

test('旧安装包缺少构建元数据文件时应返回不可用而不抛出异常', async () => {
  const result = await readLocalBuildMetadata({
    packaged: true,
    resourcesPath: '/Resources',
    readFile: async () => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    }
  })

  assert.equal(result, undefined)
})

test('构建元数据内容损坏或协议不支持时应返回不可用', async () => {
  assert.equal(
    await readLocalBuildMetadata({
      packaged: true,
      resourcesPath: '/Resources',
      readFile: async () => '{ "schemaVersion": 1, '
    }),
    undefined
  )
  assert.equal(
    await readLocalBuildMetadata({
      packaged: true,
      resourcesPath: '/Resources',
      readFile: async () => serializeBuildMetadata({ ...metadata, schemaVersion: 99 })
    }),
    undefined
  )
  assert.equal(
    await readLocalBuildMetadata({
      packaged: true,
      resourcesPath: '/Resources',
      readFile: async () => serializeBuildMetadata({ ...metadata, buildId: '  ' })
    }),
    undefined
  )
})

test('资源目录缺失时应返回不可用', async () => {
  const result = await readLocalBuildMetadata({
    packaged: true,
    resourcesPath: '',
    readFile: async () => serializeBuildMetadata(metadata)
  })

  assert.equal(result, undefined)
})

test('本地构建元数据版本应与当前应用版本交叉校验', async () => {
  assert.equal(
    await readLocalBuildMetadata({
      packaged: true,
      resourcesPath: '/Resources',
      expectedVersion: '1.1.3',
      readFile: async () => serializeBuildMetadata(metadata)
    }),
    undefined
  )
  assert.deepEqual(
    await readLocalBuildMetadata({
      packaged: true,
      resourcesPath: '/Resources',
      expectedVersion: '1.1.2',
      readFile: async () => serializeBuildMetadata(metadata)
    }),
    metadata
  )
})
