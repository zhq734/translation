import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import {
  BUILD_METADATA_FILE_NAME,
  parseBuildMetadata,
  type BuildMetadata,
  type BuildMetadataFailureReason
} from '../shared/buildMetadata'

/** GitHub Release 中构建元数据资产的最小描述。 */
export interface ReleaseBuildMetadataAsset {
  /** 资产文件名。 */
  name: string
  /** 资产下载地址。 */
  browser_download_url?: string
  /** GitHub API 返回的 SHA-256 摘要，可能带 `sha256:` 前缀。 */
  digest?: string
}

/** 远程构建元数据不可用的原因。 */
export type RemoteBuildMetadataFailureReason =
  | 'asset-missing'
  | 'digest-missing'
  | 'digest-mismatch'
  | 'download-failed'
  | BuildMetadataFailureReason

/** 远程构建元数据获取结果。 */
export type RemoteBuildMetadataResult =
  | { ok: true; metadata: BuildMetadata }
  | { ok: false; reason: RemoteBuildMetadataFailureReason }

/** 获取远程构建元数据所需的依赖与校验条件。 */
export interface RemoteBuildMetadataOptions {
  /** GitHub Release API 返回的资产快照。 */
  assets?: ReleaseBuildMetadataAsset[]
  /** 期望的 Release 版本，用于交叉校验。 */
  expectedVersion?: string
  /** 缺少资产直链时使用的下载地址基址。 */
  fallbackDownloadBaseUrl?: string
  /**
   * 网络请求函数，必须由调用方注入统一代理会话的 fetch。
   * @param url 请求地址。
   * @param init 请求选项。
   * @returns 响应对象。
   * @author zhenghq
   */
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}

/**
 * 从 URL 或路径中取出资产文件名并解码。
 * @param value 资产名称或地址。
 * @returns 解码后的文件名。
 * @author zhenghq
 */
function assetFileName(value: string): string {
  const withoutQuery = value.split(/[?#]/u, 1)[0]
  try {
    return basename(decodeURIComponent(withoutQuery))
  } catch {
    return basename(withoutQuery)
  }
}

/**
 * 在 Release 资产快照中定位唯一的构建元数据资产。
 * @param assets GitHub Release API 返回的资产列表。
 * @returns 唯一匹配的构建元数据资产；缺失、重复或列表异常时返回 undefined。
 * @author zhenghq
 */
export function selectBuildMetadataAsset(
  assets: ReleaseBuildMetadataAsset[] | undefined
): ReleaseBuildMetadataAsset | undefined {
  if (!Array.isArray(assets)) return undefined
  const matches = assets.filter((asset) =>
    typeof asset?.name === 'string' && assetFileName(asset.name) === BUILD_METADATA_FILE_NAME
  )
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * 为资产地址追加缓存规避查询参数，避免读取 CDN 缓存的旧内容。
 * @param url 资产下载地址。
 * @param cacheKey 本次请求使用的缓存规避标记，取自资产摘要而非任何凭据。
 * @returns 带缓存规避参数的地址。
 * @author zhenghq
 */
export function applyCacheBustingQuery(url: string, cacheKey: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}cacheBust=${encodeURIComponent(cacheKey)}`
}

/**
 * 下载并校验 GitHub Release 中的构建元数据。
 * 仅当 API 摘要存在、内容 SHA-256 一致、JSON 合法、schemaVersion 受支持且版本一致时才返回可信身份。
 * @param options Release 资产快照、期望版本与网络请求函数。
 * @returns 可信远程构建元数据或不可用原因。
 * @author zhenghq
 */
export async function fetchRemoteBuildMetadata(
  options: RemoteBuildMetadataOptions
): Promise<RemoteBuildMetadataResult> {
  const asset = selectBuildMetadataAsset(options.assets)
  if (!asset) return { ok: false, reason: 'asset-missing' }
  const expectedDigest = typeof asset.digest === 'string'
    ? asset.digest.replace(/^sha256:/iu, '').trim().toLowerCase()
    : ''
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) return { ok: false, reason: 'digest-missing' }

  const downloadUrl = asset.browser_download_url ||
    (options.fallbackDownloadBaseUrl
      ? `${options.fallbackDownloadBaseUrl}${BUILD_METADATA_FILE_NAME}`
      : '')
  if (!downloadUrl) return { ok: false, reason: 'asset-missing' }

  let content: string
  try {
    const response = await options.fetch(
      applyCacheBustingQuery(downloadUrl, expectedDigest.slice(0, 16)),
      { headers: { 'cache-control': 'no-cache', pragma: 'no-cache' } }
    )
    if (!response.ok) return { ok: false, reason: 'download-failed' }
    content = await response.text()
  } catch {
    return { ok: false, reason: 'download-failed' }
  }

  const actualDigest = createHash('sha256').update(content).digest('hex')
  if (actualDigest !== expectedDigest) return { ok: false, reason: 'digest-mismatch' }

  const parsed = parseBuildMetadata(
    content,
    options.expectedVersion === undefined ? {} : { expectedVersion: options.expectedVersion }
  )
  return parsed.ok ? { ok: true, metadata: parsed.metadata } : { ok: false, reason: parsed.reason }
}
