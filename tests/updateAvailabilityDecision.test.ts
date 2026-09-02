import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareSemanticVersions,
  decideUpdateAvailability
} from '../src/shared/updateAvailability.ts'
import type { BuildMetadata } from '../src/shared/buildMetadata.ts'

/**
 * 构造用于决策测试的构建元数据。
 * @param version SemVer 版本号。
 * @param runId 工作流运行 ID。
 * @param attempt 工作流运行尝试。
 * @returns 构建元数据。
 * @author zhenghq
 */
function buildMetadata(version: string, runId: string, attempt = '1'): BuildMetadata {
  return {
    schemaVersion: 1,
    version,
    buildId: `github-run-${runId}-attempt-${attempt}`,
    sourceCommit: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e',
    workflowRunId: runId,
    workflowRunAttempt: attempt
  }
}

test('SemVer 比较应支持主次修订号数值比较', () => {
  assert.equal(compareSemanticVersions('1.1.3', '1.1.2'), 1)
  assert.equal(compareSemanticVersions('1.1.2', '1.1.3'), -1)
  assert.equal(compareSemanticVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareSemanticVersions('1.1.2', 'V1.1.2'), 0)
  assert.equal(compareSemanticVersions('1.1.2', 'latest'), null)
})

test('远程版本更高时应判定为版本更新', () => {
  const result = decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.3',
    localBuild: buildMetadata('1.1.2', '111'),
    remoteBuild: buildMetadata('1.1.3', '222')
  })

  assert.equal(result.outcome, 'higher-version')
  assert.equal(result.remoteVersion, '1.1.3')
})

test('远程版本更高时即使构建元数据缺失也判定为版本更新', () => {
  const result = decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.3'
  })

  assert.equal(result.outcome, 'higher-version')
})

test('远程版本更高时构建标识相同也不得降级为已是最新', () => {
  const localBuild = buildMetadata('1.1.2', '111')
  const result = decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.3',
    localBuild,
    remoteBuild: { ...localBuild, version: '1.1.3' }
  })

  assert.equal(result.outcome, 'higher-version')
})

test('同版本但构建标识不同时应判定为同版本新构建', () => {
  const result = decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.2',
    localBuild: buildMetadata('1.1.2', '111'),
    remoteBuild: buildMetadata('1.1.2', '222')
  })

  assert.equal(result.outcome, 'same-version-new-build')
  assert.equal(result.localBuildId, 'github-run-111-attempt-1')
  assert.equal(result.remoteBuildId, 'github-run-222-attempt-1')
})

test('同一运行的不同尝试应判定为同版本新构建', () => {
  const result = decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.2',
    localBuild: buildMetadata('1.1.2', '111', '1'),
    remoteBuild: buildMetadata('1.1.2', '111', '2')
  })

  assert.equal(result.outcome, 'same-version-new-build')
})

test('同版本且构建标识相同时应判定为已是最新构建', () => {
  const result = decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.2',
    localBuild: buildMetadata('1.1.2', '111'),
    remoteBuild: buildMetadata('1.1.2', '111')
  })

  assert.equal(result.outcome, 'up-to-date')
})

test('本地或远程构建元数据不可用时应判定为元数据不可用', () => {
  assert.equal(decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.2',
    remoteBuild: buildMetadata('1.1.2', '222')
  }).outcome, 'metadata-unavailable')

  assert.equal(decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.2',
    localBuild: buildMetadata('1.1.2', '111')
  }).outcome, 'metadata-unavailable')

  assert.equal(decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.2'
  }).outcome, 'metadata-unavailable')
})

test('构建元数据版本与被比较版本不一致时不得判定为同版本新构建', () => {
  const result = decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.2',
    localBuild: buildMetadata('1.1.1', '111'),
    remoteBuild: buildMetadata('1.1.2', '222')
  })

  assert.equal(result.outcome, 'metadata-unavailable')

  const remoteMismatch = decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.2',
    localBuild: buildMetadata('1.1.2', '111'),
    remoteBuild: buildMetadata('1.1.3', '222')
  })

  assert.equal(remoteMismatch.outcome, 'metadata-unavailable')
})

test('构建标识为空白时应视为元数据不可用', () => {
  const result = decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.2',
    localBuild: { ...buildMetadata('1.1.2', '111'), buildId: '   ' },
    remoteBuild: buildMetadata('1.1.2', '222')
  })

  assert.equal(result.outcome, 'metadata-unavailable')
})

test('远程版本更低或无法解析时不得提示更新', () => {
  assert.equal(decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: '1.1.1',
    localBuild: buildMetadata('1.1.2', '111'),
    remoteBuild: buildMetadata('1.1.1', '222')
  }).outcome, 'up-to-date')

  assert.equal(decideUpdateAvailability({
    currentVersion: '1.1.2',
    remoteVersion: ''
  }).outcome, 'metadata-unavailable')

  assert.equal(decideUpdateAvailability({
    currentVersion: 'dev',
    remoteVersion: '1.1.2'
  }).outcome, 'metadata-unavailable')
})
