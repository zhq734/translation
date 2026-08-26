import { basename } from 'node:path'

/** SHA256SUMS 校验结果。 */
export type ReleaseChecksumStatus = 'verified' | 'missing' | 'mismatch' | 'unreachable'

/** GitHub Release 中安装包资产的摘要信息。 */
export interface ReleaseAssetDigest {
  /** 资产文件名。 */
  name: string
  /** GitHub API 返回的 SHA-256 摘要。 */
  digest?: string
}

/** SHA256SUMS 校验结果及对应安装包信息。 */
export interface ReleaseChecksumValidation {
  /** 校验状态。 */
  status: ReleaseChecksumStatus
  /** 被校验的安装包文件名。 */
  assetName: string
  /** SHA256SUMS 中记录的摘要。 */
  expectedSha256?: string
}

/** 从 URL 或路径中取出安装包文件名。
 * @param value 文件 URL 或路径。
 * @returns 不含查询参数的文件名。
 * @author zhenghq
 */
function fileName(value: string): string {
  try {
    return basename(decodeURIComponent(new URL(value).pathname))
  } catch {
    return basename(value.split(/[?#]/u, 1)[0])
  }
}

/** 解析 GNU sha256sum 格式的 SHA256SUMS 文本。
 * @param content SHA256SUMS 文件内容。
 * @returns 文件名到小写 SHA-256 摘要的映射。
 * @author zhenghq
 */
export function parseSha256Sums(content: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^([a-f0-9]{64})\s+[* ]?(.+)$/iu)
    if (!match) continue
    result.set(fileName(match[2].trim()), match[1].toLowerCase())
  }
  return result
}

/** 比较 SHA256SUMS 与 GitHub Release 资产摘要。
 * @param options SHA256SUMS 地址、候选安装包、资产摘要和网络请求器。
 * @returns SHA-256 校验结果。
 * @author zhenghq
 */
export async function validateReleaseChecksums(options: {
  manifestUrl: string
  assetNames: string[]
  assets?: ReleaseAssetDigest[]
  fetch: (input: string) => Promise<Response>
}): Promise<ReleaseChecksumValidation> {
  const assetName = options.assetNames.map(fileName).find(Boolean) || '未知安装包'
  const baseResult = { assetName }
  if (options.assetNames.length === 0) return { ...baseResult, status: 'missing' }

  let response: Response
  try {
    response = await options.fetch(options.manifestUrl)
  } catch {
    return { ...baseResult, status: 'unreachable' }
  }
  if (!response.ok) return { ...baseResult, status: 'missing' }

  const sums = parseSha256Sums(await response.text())
  const candidateNames = options.assetNames.map(fileName)
  const matchingName = candidateNames.find((name) => sums.has(name))
  if (!matchingName) return { ...baseResult, status: 'missing' }
  const expectedSha256 = sums.get(matchingName)
  const asset = options.assets?.find((item) => fileName(item.name) === matchingName)
  if (!asset?.digest) return { assetName: matchingName, expectedSha256, status: 'missing' }
  const actualSha256 = asset.digest.replace(/^sha256:/iu, '').toLowerCase()
  if (expectedSha256 !== actualSha256) {
    return { assetName: matchingName, expectedSha256, status: 'mismatch' }
  }
  return { assetName: matchingName, expectedSha256, status: 'verified' }
}

/** 比较 SHA256SUMS 中单个安装包的摘要。
 * @param options SHA256SUMS 地址、安装包名称、摘要和网络请求器。
 * @returns SHA-256 校验结果。
 * @author zhenghq
 */
export async function validateReleaseChecksum(options: {
  manifestUrl: string
  assetName: string
  assetDigest?: string
  fetch: (input: string) => Promise<Response>
}): Promise<ReleaseChecksumValidation> {
  return validateReleaseChecksums({
    manifestUrl: options.manifestUrl,
    assetNames: [options.assetName],
    assets: options.assetDigest ? [{ name: options.assetName, digest: options.assetDigest }] : undefined,
    fetch: options.fetch
  })
}
