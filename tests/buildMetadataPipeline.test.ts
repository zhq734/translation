import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const workflowPath = '.github/workflows/package.yml'
const scriptPath = 'scripts/generate-build-info.mjs'
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>
  build: {
    mac: { extraResources?: Array<{ from: string; to: string }> }
    win: { extraResources?: Array<{ from: string; to: string }> }
    linux: { extraResources?: Array<{ from: string; to: string }> }
  }
}

/**
 * 读取多平台打包工作流内容。
 * @returns GitHub Actions 工作流的 UTF-8 文本。
 * @author zhenghq
 */
function readWorkflow(): string {
  assert.equal(existsSync(workflowPath), true, `缺少工作流：${workflowPath}`)
  return readFileSync(workflowPath, 'utf8')
}

/**
 * 在隔离的临时目录中执行构建元数据生成脚本。
 * @param environment 需要注入的 GitHub Actions 环境变量。
 * @param extraArguments 附加命令行参数。
 * @param outputDirectory 输出目录；省略时自动创建临时目录。
 * @returns 进程退出码、标准输出、标准错误与输出文件路径。
 * @author zhenghq
 */
function runGenerator(
  environment: Record<string, string | undefined>,
  extraArguments: string[] = [],
  outputDirectory?: string
): { status: number | null; stdout: string; stderr: string; outputPath: string } {
  const directory = outputDirectory ?? mkdtempSync(join(tmpdir(), 'build-info-'))
  const outputPath = join(directory, 'build-info.json')
  const baseEnvironment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GITHUB_')) continue
    if (typeof value === 'string') baseEnvironment[key] = value
  }
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === 'string') baseEnvironment[key] = value
  }
  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, ...extraArguments],
    { encoding: 'utf8', env: baseEnvironment }
  )
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    outputPath
  }
}

test('构建元数据生成脚本应存在并可被流水线调用', () => {
  assert.equal(existsSync(scriptPath), true, `缺少构建元数据生成脚本：${scriptPath}`)
})

test('生成脚本应使用工作流运行标识写出规范化构建元数据', () => {
  const result = runGenerator({
    GITHUB_REF_NAME: 'V1.1.2',
    GITHUB_SHA: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e',
    GITHUB_RUN_ID: '123456789',
    GITHUB_RUN_ATTEMPT: '2'
  })

  assert.equal(result.status, 0, result.stderr)
  const metadata = JSON.parse(readFileSync(result.outputPath, 'utf8')) as Record<string, unknown>
  assert.deepEqual(metadata, {
    schemaVersion: 1,
    version: '1.1.2',
    buildId: 'github-run-123456789-attempt-2',
    sourceCommit: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e',
    workflowRunId: '123456789',
    workflowRunAttempt: '2'
  })
  rmSync(result.outputPath, { force: true })
})

test('同一提交不同运行或重试应生成不同 buildId', () => {
  const commonEnvironment = {
    GITHUB_REF_NAME: 'V1.1.2',
    GITHUB_SHA: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e'
  }
  const first = runGenerator({ ...commonEnvironment, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' })
  const second = runGenerator({ ...commonEnvironment, GITHUB_RUN_ID: '2', GITHUB_RUN_ATTEMPT: '1' })
  const retried = runGenerator({ ...commonEnvironment, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '2' })

  const readBuildId = (path: string): string =>
    (JSON.parse(readFileSync(path, 'utf8')) as { buildId: string }).buildId
  const firstBuildId = readBuildId(first.outputPath)
  const secondBuildId = readBuildId(second.outputPath)
  const retriedBuildId = readBuildId(retried.outputPath)

  assert.notEqual(firstBuildId, secondBuildId)
  assert.notEqual(firstBuildId, retriedBuildId)
  assert.doesNotMatch(firstBuildId, /ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e/u)
})

test('缺少 GitHub 运行环境变量时生成脚本应失败且不生成伪造元数据', () => {
  const result = runGenerator({
    GITHUB_REF_NAME: 'V1.1.2',
    GITHUB_SHA: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e'
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /GITHUB_RUN_ID|GITHUB_RUN_ATTEMPT/u)
  assert.equal(existsSync(result.outputPath), false)
})

test('版本号无法规范化时生成脚本应失败', () => {
  const result = runGenerator({
    GITHUB_REF_NAME: 'nightly',
    GITHUB_SHA: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e',
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    BUILD_INFO_VERSION: 'nightly'
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /version|SemVer/u)
  assert.equal(existsSync(result.outputPath), false)
})

test('输出目录不可写时生成脚本应失败', () => {
  const directory = mkdtempSync(join(tmpdir(), 'build-info-readonly-'))
  const target = join(directory, 'nested')
  mkdirSync(target)
  chmodSync(target, 0o500)
  try {
    const result = runGenerator({
      GITHUB_REF_NAME: 'V1.1.2',
      GITHUB_SHA: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e',
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1'
    }, [], target)

    assert.notEqual(result.status, 0)
    assert.equal(existsSync(result.outputPath), false)
  } finally {
    chmodSync(target, 0o700)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('本地构建允许降级生成不可用于正式发布的占位构建元数据', () => {
  const result = runGenerator({}, ['--allow-local-fallback'])

  assert.equal(result.status, 0, result.stderr)
  const metadata = JSON.parse(readFileSync(result.outputPath, 'utf8')) as {
    buildId: string
    workflowRunId: string
  }
  assert.match(metadata.buildId, /local/u)
  assert.match(metadata.workflowRunId, /local/u)
})

test('校验模式应确认已有构建元数据属于当前工作流运行', () => {
  const environment = {
    GITHUB_REF_NAME: 'V1.1.2',
    GITHUB_SHA: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e',
    GITHUB_RUN_ID: '555',
    GITHUB_RUN_ATTEMPT: '1'
  }
  const generated = runGenerator(environment)
  assert.equal(generated.status, 0, generated.stderr)

  const matching = spawnSync(
    process.execPath,
    [scriptPath, '--output', generated.outputPath, '--check'],
    { encoding: 'utf8', env: { ...process.env, ...environment } }
  )
  assert.equal(matching.status, 0, matching.stderr)

  const mismatched = spawnSync(
    process.execPath,
    [scriptPath, '--output', generated.outputPath, '--check'],
    { encoding: 'utf8', env: { ...process.env, ...environment, GITHUB_RUN_ID: '556' } }
  )
  assert.notEqual(mismatched.status, 0)
  assert.match(mismatched.stderr, /buildId|构建/u)
})

test('本地构建脚本应在不依赖 GitHub 环境变量的情况下准备构建元数据', () => {
  assert.match(packageJson.scripts.build, /generate-build-info\.mjs[^&]*--allow-local-fallback/u)
  assert.doesNotMatch(packageJson.scripts.dist_mac ?? '', /GITHUB_RUN_ID/u)
})

test('三平台打包配置应把同一份构建元数据复制到应用资源根目录', () => {
  for (const platform of ['mac', 'win', 'linux'] as const) {
    const resources = packageJson.build[platform].extraResources ?? []
    assert.ok(
      resources.some((resource) =>
        resource.from === 'build/build-info.json' && resource.to === 'build-info.json'
      ),
      `${platform} 打包应把 build/build-info.json 复制到 Resources/build-info.json`
    )
  }
})

test('生成的构建元数据不应被提交到仓库', () => {
  const gitignore = readFileSync('.gitignore', 'utf8')

  assert.match(gitignore, /^build\/build-info\.json$/mu)
})

test('正式打包阶段应在构建前生成构建元数据', () => {
  const workflow = readWorkflow()

  assert.match(workflow, /生成构建元数据/u)
  assert.match(workflow, /node scripts\/generate-build-info\.mjs/u)
  assert.match(workflow, /GITHUB_RUN_ID|github\.run_id/u)
  assert.match(workflow, /GITHUB_RUN_ATTEMPT|github\.run_attempt/u)
  const packageJobIndex = workflow.indexOf('  package:')
  const generateIndex = workflow.indexOf('node scripts/generate-build-info.mjs', packageJobIndex)
  const buildIndex = workflow.indexOf('npm run ${{ matrix.command }}', packageJobIndex)
  assert.ok(generateIndex > packageJobIndex, '打包 job 必须调用构建元数据生成脚本')
  assert.ok(generateIndex < buildIndex, '构建元数据必须在安装包构建之前生成')
})

test('Release 阶段应生成、校验并覆盖上传 build-info.json 资产', () => {
  const workflow = readWorkflow()
  const releaseIndex = workflow.indexOf('  release:')
  const releaseSection = workflow.slice(releaseIndex)

  assert.match(releaseSection, /node scripts\/generate-build-info\.mjs[\s\S]*release-assets\/build-info\.json/u)
  assert.match(releaseSection, /--check/u)
  assert.match(releaseSection, /gh release upload "\$GITHUB_REF_NAME" release-assets\/\* --clobber/u)
  const checksumIndex = releaseSection.indexOf('generate-checksums.mjs')
  const verifyIndex = releaseSection.indexOf('--check')
  assert.ok(checksumIndex >= 0 && verifyIndex > checksumIndex, 'build-info 校验应在生成 SHA256SUMS 之后执行')
})

test('README 应说明构建元数据协议、迁移限制与发布运维步骤', () => {
  const chinese = readFileSync('README.zh-CN.md', 'utf8')
  const english = readFileSync('README.md', 'utf8')

  for (const document of [chinese, english]) {
    assert.match(document, /build-info\.json/u)
    assert.match(document, /github-run-<run_id>-attempt-<attempt>/u)
    assert.match(document, /generate-build-info\.mjs/u)
    assert.match(document, /--allow-local-fallback/u)
    assert.match(document, /--clobber/u)
  }
  assert.match(chinese, /迁移限制/u)
  assert.match(english, /Migration limit/u)
})

test('构建元数据不得包含 token、路径或机器相关信息', () => {
  const generator = readFileSync(scriptPath, 'utf8')
  const shared = readFileSync('src/shared/buildMetadata.ts', 'utf8')

  for (const source of [generator, shared]) {
    assert.doesNotMatch(source, /GITHUB_TOKEN|GH_TOKEN|CSC_LINK|APPLE_API/u)
    assert.doesNotMatch(source, /os\.hostname|userInfo|homedir/u)
  }
  assert.doesNotMatch(shared, /process\.env/u)
})
