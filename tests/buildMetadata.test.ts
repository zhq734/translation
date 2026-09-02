import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILD_METADATA_FILE_NAME,
  BUILD_METADATA_SCHEMA_VERSION,
  createBuildIdentity,
  createBuildMetadata,
  formatBuildIdLabel,
  normalizeSemanticVersion,
  parseBuildMetadata,
  serializeBuildMetadata,
  validateBuildMetadata
} from '../src/shared/buildMetadata.ts'

/**
 * 构造一份字段完整的合法构建元数据输入。
 * @param overrides 需要覆盖的字段。
 * @returns 构建元数据生成输入。
 * @author zhenghq
 */
function createInput(overrides: Record<string, string> = {}): {
  version: string
  sourceCommit: string
  workflowRunId: string
  workflowRunAttempt: string
} {
  return {
    version: '1.1.2',
    sourceCommit: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e',
    workflowRunId: '123456789',
    workflowRunAttempt: '2',
    ...overrides
  }
}

test('构建元数据协议应固定 schemaVersion 与资产文件名', () => {
  assert.equal(BUILD_METADATA_SCHEMA_VERSION, 1)
  assert.equal(BUILD_METADATA_FILE_NAME, 'build-info.json')
})

test('合法构建元数据应包含全部必填字段', () => {
  const metadata = createBuildMetadata(createInput())

  assert.equal(metadata.schemaVersion, 1)
  assert.equal(metadata.version, '1.1.2')
  assert.equal(metadata.buildId, 'github-run-123456789-attempt-2')
  assert.equal(metadata.sourceCommit, 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e')
  assert.equal(metadata.workflowRunId, '123456789')
  assert.equal(metadata.workflowRunAttempt, '2')
})

test('必填字段缺失或为空时不得生成构建元数据', () => {
  assert.throws(() => createBuildMetadata(createInput({ sourceCommit: '' })), /sourceCommit/u)
  assert.throws(() => createBuildMetadata(createInput({ workflowRunId: '   ' })), /workflowRunId/u)
  assert.throws(() => createBuildMetadata(createInput({ workflowRunAttempt: '' })), /workflowRunAttempt/u)
  assert.throws(() => createBuildMetadata(createInput({ version: 'V1.1.2-beta' })), /version/u)
  assert.throws(() => createBuildMetadata(createInput({ version: '1.1' })), /version/u)
})

test('版本号应规范化为纯 SemVer', () => {
  assert.equal(normalizeSemanticVersion('V1.1.2'), '1.1.2')
  assert.equal(normalizeSemanticVersion(' v1.1.2 '), '1.1.2')
  assert.equal(normalizeSemanticVersion('1.1'), null)
  assert.equal(normalizeSemanticVersion('latest'), null)
})

test('构建身份应由工作流运行标识决定而不是提交哈希', () => {
  const firstRun = createBuildIdentity({ workflowRunId: '111', workflowRunAttempt: '1' })
  const secondRun = createBuildIdentity({ workflowRunId: '222', workflowRunAttempt: '1' })
  const retriedRun = createBuildIdentity({ workflowRunId: '111', workflowRunAttempt: '2' })

  assert.notEqual(firstRun, secondRun)
  assert.notEqual(firstRun, retriedRun)
  assert.equal(firstRun, createBuildIdentity({ workflowRunId: '111', workflowRunAttempt: '1' }))
  assert.throws(() => createBuildIdentity({ workflowRunId: '', workflowRunAttempt: '1' }), /workflowRunId/u)
  assert.throws(() => createBuildIdentity({ workflowRunId: '111', workflowRunAttempt: '' }), /workflowRunAttempt/u)
})

test('同一提交的不同工作流运行应生成不同 buildId 且保留相同提交', () => {
  const commit = 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e'
  const first = createBuildMetadata(createInput({ sourceCommit: commit, workflowRunId: '111' }))
  const second = createBuildMetadata(createInput({ sourceCommit: commit, workflowRunId: '222' }))
  const retried = createBuildMetadata(
    createInput({ sourceCommit: commit, workflowRunId: '111', workflowRunAttempt: '3' })
  )

  assert.notEqual(first.buildId, second.buildId)
  assert.notEqual(first.buildId, retried.buildId)
  assert.equal(first.sourceCommit, second.sourceCommit)
  assert.equal(first.sourceCommit, retried.sourceCommit)
  assert.doesNotMatch(first.buildId, new RegExp(commit, 'u'))
})

test('构建元数据序列化应稳定且可回读', () => {
  const metadata = createBuildMetadata(createInput())
  const serialized = serializeBuildMetadata(metadata)

  assert.equal(serialized, serializeBuildMetadata(createBuildMetadata(createInput())))
  assert.match(serialized, /\n$/u)
  assert.deepEqual(Object.keys(JSON.parse(serialized) as Record<string, unknown>), [
    'schemaVersion',
    'version',
    'buildId',
    'sourceCommit',
    'workflowRunId',
    'workflowRunAttempt'
  ])
  const parsed = parseBuildMetadata(serialized)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.ok ? parsed.metadata : null, metadata)
})

test('解析构建元数据应识别非法 JSON、缺失字段和不支持的 schemaVersion', () => {
  const invalidJson = parseBuildMetadata('{ "schemaVersion": 1, ')
  assert.equal(invalidJson.ok, false)
  assert.equal(invalidJson.ok ? null : invalidJson.reason, 'invalid-json')

  const missingField = parseBuildMetadata(JSON.stringify({
    schemaVersion: 1,
    version: '1.1.2',
    buildId: 'github-run-1-attempt-1',
    sourceCommit: 'abc',
    workflowRunId: '1'
  }))
  assert.equal(missingField.ok, false)
  assert.equal(missingField.ok ? null : missingField.reason, 'missing-field')

  const unsupportedSchema = parseBuildMetadata(serializeBuildMetadata({
    ...createBuildMetadata(createInput()),
    schemaVersion: 2
  }))
  assert.equal(unsupportedSchema.ok, false)
  assert.equal(unsupportedSchema.ok ? null : unsupportedSchema.reason, 'unsupported-schema')

  const invalidVersion = parseBuildMetadata(JSON.stringify({
    ...createBuildMetadata(createInput()),
    version: 'v1.1.2'
  }))
  assert.equal(invalidVersion.ok, false)
  assert.equal(invalidVersion.ok ? null : invalidVersion.reason, 'invalid-version')
})

test('解析构建元数据应容忍未知字段但拒绝版本不一致', () => {
  const withUnknownField = parseBuildMetadata(JSON.stringify({
    ...createBuildMetadata(createInput()),
    releaseChannel: 'stable'
  }))
  assert.equal(withUnknownField.ok, true)
  assert.equal(withUnknownField.ok ? withUnknownField.metadata.buildId : null, 'github-run-123456789-attempt-2')

  const mismatched = parseBuildMetadata(serializeBuildMetadata(createBuildMetadata(createInput())), {
    expectedVersion: '1.1.3'
  })
  assert.equal(mismatched.ok, false)
  assert.equal(mismatched.ok ? null : mismatched.reason, 'version-mismatch')

  const matched = parseBuildMetadata(serializeBuildMetadata(createBuildMetadata(createInput())), {
    expectedVersion: 'V1.1.2'
  })
  assert.equal(matched.ok, true)
})

test('校验构建元数据应拒绝非对象输入', () => {
  assert.equal(validateBuildMetadata(null).ok, false)
  assert.equal(validateBuildMetadata('build-info').ok, false)
  assert.equal(validateBuildMetadata([]).ok, false)
  assert.equal(validateBuildMetadata(createBuildMetadata(createInput())).ok, true)
})

test('构建标识展示值应脱敏为简短可读文本', () => {
  assert.equal(formatBuildIdLabel('github-run-123456789-attempt-2'), '#123456789.2')
  assert.equal(formatBuildIdLabel('local-development'), 'local-development')
  assert.equal(formatBuildIdLabel(''), '')
  assert.equal(
    formatBuildIdLabel('c0ffee1234567890c0ffee1234567890c0ffee12'),
    'c0ffee12…'
  )
})
