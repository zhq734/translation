/** 构建元数据当前支持的协议版本。 */
export const BUILD_METADATA_SCHEMA_VERSION = 1

/** 安装包资源与 GitHub Release 中构建元数据的固定文件名。 */
export const BUILD_METADATA_FILE_NAME = 'build-info.json'

/** 正式构建的公开身份信息。 */
export interface BuildMetadata {
  /** 构建元数据协议版本。 */
  schemaVersion: number
  /** 规范化 SemVer 版本号。 */
  version: string
  /** 每次正式构建不可复用的构建标识。 */
  buildId: string
  /** 生成该构建的源码提交哈希，仅用于追溯。 */
  sourceCommit: string
  /** GitHub Actions 工作流运行 ID。 */
  workflowRunId: string
  /** GitHub Actions 工作流运行尝试次数。 */
  workflowRunAttempt: string
}

/** 生成构建元数据所需的原始输入。 */
export interface BuildMetadataInput {
  /** 待规范化的版本号，允许带 `v`/`V` 前缀。 */
  version: string
  /** 源码提交哈希。 */
  sourceCommit: string
  /** 工作流运行 ID。 */
  workflowRunId: string
  /** 工作流运行尝试次数。 */
  workflowRunAttempt: string
}

/** 构建元数据解析失败的原因。 */
export type BuildMetadataFailureReason =
  | 'invalid-json'
  | 'not-an-object'
  | 'unsupported-schema'
  | 'missing-field'
  | 'invalid-version'
  | 'version-mismatch'

/** 构建元数据解析或校验结果。 */
export type BuildMetadataResult =
  | { ok: true; metadata: BuildMetadata }
  | { ok: false; reason: BuildMetadataFailureReason }

/** 解析构建元数据时的可选交叉校验条件。 */
export interface BuildMetadataParseOptions {
  /** 期望的版本号，用于与 Release/更新清单交叉校验。 */
  expectedVersion?: string
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/u

/**
 * 将版本号规范化为纯 SemVer 主次修订格式。
 * @param value 原始版本号，允许带 `v`/`V` 前缀和空白。
 * @returns 规范化后的 SemVer 字符串；不符合格式时返回 null。
 * @author zhenghq
 */
export function normalizeSemanticVersion(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/^[vV]/u, '')
  return SEMVER_PATTERN.test(normalized) ? normalized : null
}

/**
 * 读取并校验必填的非空字符串字段。
 * @param value 待校验的字段值。
 * @param field 字段名称，用于错误提示。
 * @returns 去除首尾空白后的字段值。
 * @author zhenghq
 */
function requireNonEmpty(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`构建元数据字段 ${field} 不能为空`)
  return normalized
}

/**
 * 依据工作流运行标识生成不可复用的构建标识。
 * @param input 工作流运行 ID 与运行尝试次数。
 * @returns 形如 `github-run-<id>-attempt-<attempt>` 的构建标识。
 * @author zhenghq
 */
export function createBuildIdentity(input: {
  workflowRunId: string
  workflowRunAttempt: string
}): string {
  const runId = requireNonEmpty(input.workflowRunId, 'workflowRunId')
  const attempt = requireNonEmpty(input.workflowRunAttempt, 'workflowRunAttempt')
  return `github-run-${runId}-attempt-${attempt}`
}

/**
 * 生成本次正式构建的完整构建元数据。
 * @param input 版本号、源码提交与工作流运行信息。
 * @returns 字段完整且已规范化的构建元数据。
 * @author zhenghq
 */
export function createBuildMetadata(input: BuildMetadataInput): BuildMetadata {
  const version = normalizeSemanticVersion(input.version)
  if (!version) throw new Error(`构建元数据字段 version 必须是规范化 SemVer：${input.version}`)
  const sourceCommit = requireNonEmpty(input.sourceCommit, 'sourceCommit')
  const workflowRunId = requireNonEmpty(input.workflowRunId, 'workflowRunId')
  const workflowRunAttempt = requireNonEmpty(input.workflowRunAttempt, 'workflowRunAttempt')
  return {
    schemaVersion: BUILD_METADATA_SCHEMA_VERSION,
    version,
    buildId: createBuildIdentity({ workflowRunId, workflowRunAttempt }),
    sourceCommit,
    workflowRunId,
    workflowRunAttempt
  }
}

/**
 * 以固定字段顺序稳定序列化构建元数据。
 * @param metadata 构建元数据。
 * @returns 以换行结尾的规范化 JSON 文本。
 * @author zhenghq
 */
export function serializeBuildMetadata(metadata: BuildMetadata): string {
  const ordered = {
    schemaVersion: metadata.schemaVersion,
    version: metadata.version,
    buildId: metadata.buildId,
    sourceCommit: metadata.sourceCommit,
    workflowRunId: metadata.workflowRunId,
    workflowRunAttempt: metadata.workflowRunAttempt
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/**
 * 校验任意值是否为受支持的构建元数据，容忍未知字段。
 * @param value 待校验的对象。
 * @param options 版本交叉校验条件。
 * @returns 校验成功时返回规范化元数据，失败时返回失败原因。
 * @author zhenghq
 */
export function validateBuildMetadata(
  value: unknown,
  options: BuildMetadataParseOptions = {}
): BuildMetadataResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not-an-object' }
  }
  const record = value as Record<string, unknown>
  if (record['schemaVersion'] !== BUILD_METADATA_SCHEMA_VERSION) {
    return { ok: false, reason: 'unsupported-schema' }
  }
  const requiredFields = ['version', 'buildId', 'sourceCommit', 'workflowRunId', 'workflowRunAttempt']
  for (const field of requiredFields) {
    const fieldValue = record[field]
    if (typeof fieldValue !== 'string' || !fieldValue.trim()) {
      return { ok: false, reason: 'missing-field' }
    }
  }
  const version = record['version'] as string
  if (normalizeSemanticVersion(version) !== version) {
    return { ok: false, reason: 'invalid-version' }
  }
  const expectedVersion = normalizeSemanticVersion(options.expectedVersion)
  if (options.expectedVersion !== undefined && (!expectedVersion || expectedVersion !== version)) {
    return { ok: false, reason: 'version-mismatch' }
  }
  return {
    ok: true,
    metadata: {
      schemaVersion: BUILD_METADATA_SCHEMA_VERSION,
      version,
      buildId: (record['buildId'] as string).trim(),
      sourceCommit: (record['sourceCommit'] as string).trim(),
      workflowRunId: (record['workflowRunId'] as string).trim(),
      workflowRunAttempt: (record['workflowRunAttempt'] as string).trim()
    }
  }
}

/**
 * 解析构建元数据 JSON 文本。
 * @param content build-info.json 的文本内容。
 * @param options 版本交叉校验条件。
 * @returns 解析成功时返回规范化元数据，失败时返回失败原因。
 * @author zhenghq
 */
export function parseBuildMetadata(
  content: string,
  options: BuildMetadataParseOptions = {}
): BuildMetadataResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  return validateBuildMetadata(parsed, options)
}

/**
 * 将构建标识转换为界面可展示的简短脱敏文本。
 * @param buildId 构建标识；可为空。
 * @returns 适合展示的短标签；无法识别时返回截断值。
 * @author zhenghq
 */
export function formatBuildIdLabel(buildId: string | undefined | null): string {
  const normalized = typeof buildId === 'string' ? buildId.trim() : ''
  if (!normalized) return ''
  const match = normalized.match(/^github-run-(\d+)-attempt-(\d+)$/u)
  if (match) return `#${match[1]}.${match[2]}`
  if (normalized.length <= 24) return normalized
  return `${normalized.slice(0, 8)}…`
}
