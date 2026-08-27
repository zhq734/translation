import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  applyCacheBustingQuery,
  fetchRemoteBuildMetadata,
  selectBuildMetadataAsset,
  type ReleaseBuildMetadataAsset
} from '../src/main/remoteBuildMetadata.ts'
import { createBuildMetadata, serializeBuildMetadata } from '../src/shared/buildMetadata.ts'
import { decideUpdateAvailability } from '../src/shared/updateAvailability.ts'

const metadata = createBuildMetadata({
  version: '1.1.2',
  sourceCommit: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e',
  workflowRunId: '222',
  workflowRunAttempt: '1'
})
const metadataText = serializeBuildMetadata(metadata)
const metadataDigest = createHash('sha256').update(metadataText).digest('hex')

/**
 * 构造 GitHub Release 中的 build-info 资产描述。
 * @param overrides 需要覆盖的字段。
 * @returns Release 资产描述。
 * @author zhenghq
 */
function createAsset(
  overrides: Partial<ReleaseBuildMetadataAsset> = {}
): ReleaseBuildMetadataAsset {
  return {
    name: 'build-info.json',
    browser_download_url: 'https://github.com/zhq734/translation/releases/download/V1.1.2/build-info.json',
    digest: `sha256:${metadataDigest}`,
    ...overrides
  }
}

/**
 * 构造返回固定文本的 fetch 替身。
 * @param body 响应文本。
 * @param ok 响应是否成功。
 * @returns fetch 替身与请求地址记录。
 * @author zhenghq
 */
function createFetch(body: string, ok = true): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  urls: string[]
  inits: Array<RequestInit | undefined>
} {
  const urls: string[] = []
  const inits: Array<RequestInit | undefined> = []
  return {
    urls,
    inits,
    fetch: async (url, init) => {
      urls.push(url)
      inits.push(init)
      return {
        ok,
        status: ok ? 200 : 404,
        text: async () => body
      } as Response
    }
  }
}

test('应从 Release 资产列表中定位 build-info.json', () => {
  const asset = selectBuildMetadataAsset([
    { name: 'SelectionTranslator-1.1.2-mac-arm64.dmg' },
    createAsset(),
    { name: 'SHA256SUMS' }
  ])

  assert.equal(asset?.name, 'build-info.json')
})

test('应容忍资产名称带 URL 编码或路径前缀', () => {
  const asset = selectBuildMetadataAsset([
    { name: 'build%2Dinfo.json', digest: 'sha256:abc' }
  ])

  assert.equal(asset?.digest, 'sha256:abc')
})

test('资产缺失、重复或列表异常时不得返回可用资产', () => {
  assert.equal(selectBuildMetadataAsset([{ name: 'SHA256SUMS' }]), undefined)
  assert.equal(selectBuildMetadataAsset([]), undefined)
  assert.equal(selectBuildMetadataAsset(undefined), undefined)
  assert.equal(selectBuildMetadataAsset([createAsset(), createAsset({ digest: 'sha256:other' })]), undefined)
})

test('远程元数据请求应附带缓存规避参数与请求头', async () => {
  const url = applyCacheBustingQuery('https://example.com/build-info.json', 'token-1')

  assert.match(url, /[?&]cacheBust=token-1$/u)
  assert.equal(
    applyCacheBustingQuery('https://example.com/build-info.json?x=1', 'token-2'),
    'https://example.com/build-info.json?x=1&cacheBust=token-2'
  )
})

test('摘要、格式与版本全部通过时应返回可信远程构建身份', async () => {
  const { fetch, urls, inits } = createFetch(metadataText)
  const result = await fetchRemoteBuildMetadata({
    assets: [createAsset()],
    expectedVersion: '1.1.2',
    fetch
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.ok ? result.metadata : null, metadata)
  assert.match(urls[0], /cacheBust=/u)
  assert.match(
    String((inits[0]?.headers as Record<string, string> | undefined)?.['cache-control'] ?? ''),
    /no-cache|no-store/u
  )
})

test('API 摘要支持不带 sha256 前缀的写法', async () => {
  const { fetch } = createFetch(metadataText)
  const result = await fetchRemoteBuildMetadata({
    assets: [createAsset({ digest: metadataDigest.toUpperCase() })],
    expectedVersion: '1.1.2',
    fetch
  })

  assert.equal(result.ok, true)
})

test('API 摘要缺失时远程构建元数据应不可用', async () => {
  const { fetch } = createFetch(metadataText)
  const result = await fetchRemoteBuildMetadata({
    assets: [createAsset({ digest: undefined })],
    expectedVersion: '1.1.2',
    fetch
  })

  assert.equal(result.ok, false)
  assert.equal(result.ok ? null : result.reason, 'digest-missing')
})

test('CDN 返回陈旧内容导致摘要不一致时应不可用', async () => {
  const staleMetadata = serializeBuildMetadata(createBuildMetadata({
    version: '1.1.2',
    sourceCommit: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e',
    workflowRunId: '111',
    workflowRunAttempt: '1'
  }))
  const { fetch } = createFetch(staleMetadata)
  const result = await fetchRemoteBuildMetadata({
    assets: [createAsset()],
    expectedVersion: '1.1.2',
    fetch
  })

  assert.equal(result.ok, false)
  assert.equal(result.ok ? null : result.reason, 'digest-mismatch')
})

test('资产下载失败或响应异常时应不可用', async () => {
  const failing = await fetchRemoteBuildMetadata({
    assets: [createAsset()],
    expectedVersion: '1.1.2',
    fetch: async () => {
      throw new Error('network down')
    }
  })
  assert.equal(failing.ok, false)
  assert.equal(failing.ok ? null : failing.reason, 'download-failed')

  const { fetch } = createFetch(metadataText, false)
  const notFound = await fetchRemoteBuildMetadata({
    assets: [createAsset()],
    expectedVersion: '1.1.2',
    fetch
  })
  assert.equal(notFound.ok, false)
  assert.equal(notFound.ok ? null : notFound.reason, 'download-failed')
})

test('缺少 build-info 资产时应返回资产缺失', async () => {
  const result = await fetchRemoteBuildMetadata({
    assets: [{ name: 'SHA256SUMS' }],
    expectedVersion: '1.1.2',
    fetch: async () => {
      throw new Error('不应发起请求')
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.ok ? null : result.reason, 'asset-missing')
})

test('schemaVersion 不支持、JSON 损坏或版本不一致时应不可用', async () => {
  const unsupportedText = serializeBuildMetadata({ ...metadata, schemaVersion: 2 })
  const unsupported = await fetchRemoteBuildMetadata({
    assets: [createAsset({
      digest: `sha256:${createHash('sha256').update(unsupportedText).digest('hex')}`
    })],
    expectedVersion: '1.1.2',
    fetch: createFetch(unsupportedText).fetch
  })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.ok ? null : unsupported.reason, 'unsupported-schema')

  const brokenText = '{ "schemaVersion": 1,'
  const broken = await fetchRemoteBuildMetadata({
    assets: [createAsset({
      digest: `sha256:${createHash('sha256').update(brokenText).digest('hex')}`
    })],
    expectedVersion: '1.1.2',
    fetch: createFetch(brokenText).fetch
  })
  assert.equal(broken.ok, false)
  assert.equal(broken.ok ? null : broken.reason, 'invalid-json')

  const mismatched = await fetchRemoteBuildMetadata({
    assets: [createAsset()],
    expectedVersion: '1.1.3',
    fetch: createFetch(metadataText).fetch
  })
  assert.equal(mismatched.ok, false)
  assert.equal(mismatched.ok ? null : mismatched.reason, 'version-mismatch')
})

test('远程元数据不可用时更高版本仍报告可用且同版本不误报', () => {
  const localBuild = createBuildMetadata({
    version: '1.1.2',
    sourceCommit: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e',
    workflowRunId: '111',
    workflowRunAttempt: '1'
  })

  assert.equal(decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.3',
    localBuild
  }).outcome, 'higher-version')
  assert.equal(decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.2',
    localBuild
  }).outcome, 'metadata-unavailable')
})
