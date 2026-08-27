import { normalizeSemanticVersion, type BuildMetadata } from './buildMetadata'

/** 更新判断的领域结果。 */
export type UpdateAvailabilityOutcome =
  | 'higher-version'
  | 'same-version-new-build'
  | 'up-to-date'
  | 'metadata-unavailable'

/** 更新判断输入。 */
export interface UpdateAvailabilityInput {
  /** 当前安装版本。 */
  currentVersion: string
  /** electron-updater 报告的远程版本。 */
  remoteVersion: string
  /** 当前安装包内的本地构建元数据。 */
  localBuild?: BuildMetadata
  /** 已通过摘要与格式校验的远程构建元数据。 */
  remoteBuild?: BuildMetadata
}

/** 更新判断结果。 */
export interface UpdateAvailabilityDecision {
  /** 判断得到的领域结果。 */
  outcome: UpdateAvailabilityOutcome
  /** 规范化后的远程版本；无法解析时为 undefined。 */
  remoteVersion?: string
  /** 本地构建标识；仅在参与比较时存在。 */
  localBuildId?: string
  /** 远程构建标识；仅在参与比较时存在。 */
  remoteBuildId?: string
}

/**
 * 比较两个 SemVer 版本号的大小。
 * @param left 左侧版本号。
 * @param right 右侧版本号。
 * @returns 左大于右返回 1，小于返回 -1，相等返回 0；任一版本无法解析时返回 null。
 * @author zhenghq
 */
export function compareSemanticVersions(left: string, right: string): number | null {
  const normalizedLeft = normalizeSemanticVersion(left)
  const normalizedRight = normalizeSemanticVersion(right)
  if (!normalizedLeft || !normalizedRight) return null
  const leftParts = normalizedLeft.split('.').map(Number)
  const rightParts = normalizedRight.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1
    if (leftParts[index] < rightParts[index]) return -1
  }
  return 0
}

/**
 * 读取构建元数据中与指定版本一致的有效构建标识。
 * @param metadata 构建元数据；可为空。
 * @param expectedVersion 期望匹配的规范化版本号。
 * @returns 有效构建标识；元数据缺失、标识为空或版本不一致时返回 undefined。
 * @author zhenghq
 */
function resolveBuildId(
  metadata: BuildMetadata | undefined,
  expectedVersion: string
): string | undefined {
  if (!metadata) return undefined
  const buildId = typeof metadata.buildId === 'string' ? metadata.buildId.trim() : ''
  if (!buildId) return undefined
  if (normalizeSemanticVersion(metadata.version) !== expectedVersion) return undefined
  return buildId
}

/**
 * 依据版本号和构建身份统一判断更新可用性。
 * SemVer 更高版本始终优先，只有同版本且两端构建标识均有效且不同才判定为同版本新构建。
 * @param input 当前版本、远程版本与本地/远程构建元数据。
 * @returns 更新判断结果，包含参与比较的构建标识。
 * @author zhenghq
 */
export function decideUpdateAvailability(
  input: UpdateAvailabilityInput
): UpdateAvailabilityDecision {
  const currentVersion = normalizeSemanticVersion(input.currentVersion)
  const remoteVersion = normalizeSemanticVersion(input.remoteVersion)
  if (!currentVersion || !remoteVersion) return { outcome: 'metadata-unavailable' }

  const comparison = compareSemanticVersions(remoteVersion, currentVersion)
  if (comparison === null) return { outcome: 'metadata-unavailable' }
  if (comparison > 0) return { outcome: 'higher-version', remoteVersion }
  if (comparison < 0) return { outcome: 'up-to-date', remoteVersion }

  const localBuildId = resolveBuildId(input.localBuild, currentVersion)
  const remoteBuildId = resolveBuildId(input.remoteBuild, remoteVersion)
  if (!localBuildId || !remoteBuildId) {
    return { outcome: 'metadata-unavailable', remoteVersion }
  }
  if (localBuildId === remoteBuildId) {
    return { outcome: 'up-to-date', remoteVersion, localBuildId, remoteBuildId }
  }
  return { outcome: 'same-version-new-build', remoteVersion, localBuildId, remoteBuildId }
}
