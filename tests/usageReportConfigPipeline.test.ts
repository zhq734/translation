import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const workflowPath = '.github/workflows/package.yml'
const scriptPath = 'scripts/generate-usage-report-config.mjs'

/**
 * 构造隔离的临时输出目录。
 * @returns 临时目录绝对路径。
 * @author zhenghq
 */
function createTemporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'usage-report-config-'))
}

/**
 * 读取使用量上报配置文件并返回各字段是否已注入。
 * @param path 配置文件路径。
 * @returns 字段名到是否非空的布尔映射。
 * @author zhenghq
 */
function readConfiguredFields(path: string): Record<string, boolean> {
  const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
  return {
    smtpUser: Boolean(config.smtpUser),
    smtpPass: Boolean(config.smtpPass),
    reportTo: Boolean(config.reportTo)
  }
}

/**
 * 在隔离环境中执行使用量上报配置生成脚本。
 * @param environment 需要注入的使用量上报环境变量。
 * @param outputPath 生成的配置文件路径。
 * @returns 进程退出码、标准输出、标准错误与配置路径。
 * @author zhenghq
 */
function runGenerator(
  environment: Record<string, string | undefined>,
  outputPath: string
): { status: number | null; stdout: string; stderr: string; path: string } {
  const baseEnvironment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('USAGE_')) continue
    if (typeof value === 'string') baseEnvironment[key] = value
  }
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === 'string') baseEnvironment[key] = value
  }
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath], {
    encoding: 'utf8',
    env: baseEnvironment
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    path: outputPath
  }
}

test('同一组凭据重复生成应保持一致且非空', () => {
  const directory = createTemporaryDirectory()
  const path = join(directory, 'usage-report-config.json')
  const environment = {
    USAGE_SMTP_USER: 'sender@qq.com',
    USAGE_SMTP_PASS: 'auth-code',
    USAGE_REPORT_TO: 'receiver@qq.com'
  }
  const first = runGenerator(environment, path)
  const second = runGenerator(environment, path)

  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(existsSync(path), true)
  assert.deepEqual(readConfiguredFields(path), {
    smtpUser: true,
    smtpPass: true,
    reportTo: true
  })
  assert.equal(readFileSync(path, 'utf8'), readFileSync(path, 'utf8'))
})

test('空凭据不得覆盖已有非空产物', () => {
  const directory = createTemporaryDirectory()
  const path = join(directory, 'usage-report-config.json')
  const previous = {
    smtpUser: 'sender@qq.com',
    smtpPass: 'auth-code',
    reportTo: 'receiver@qq.com'
  }
  writeFileSync(path, JSON.stringify(previous, null, 2))

  const result = runGenerator({}, path)

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readConfiguredFields(path), {
    smtpUser: true,
    smtpPass: true,
    reportTo: true
  })
})

test('本地开发无凭据时应生成空配置', () => {
  const directory = createTemporaryDirectory()
  const path = join(directory, 'usage-report-config.json')

  const result = runGenerator({}, path)

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readConfiguredFields(path), {
    smtpUser: false,
    smtpPass: false,
    reportTo: false
  })
})

test('生成日志不得包含凭据值', () => {
  const directory = createTemporaryDirectory()
  const path = join(directory, 'usage-report-config.json')

  const result = runGenerator(
    {
      USAGE_SMTP_USER: 'sender-secret@qq.com',
      USAGE_SMTP_PASS: 'auth-code-secret',
      USAGE_REPORT_TO: 'receiver-secret@qq.com'
    },
    path
  )

  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /sender-secret|auth-code-secret|receiver-secret/u)
  assert.doesNotMatch(result.stderr, /sender-secret|auth-code-secret|receiver-secret/u)
})

test('打包 job 应在独立生成和后续构建中保持凭据作用域', () => {
  const workflow = readFileSync(workflowPath, 'utf8')
  const packageIndex = workflow.indexOf('  package:')
  assert.ok(packageIndex >= 0)
  const jobSection = workflow.slice(packageIndex, workflow.indexOf('\n  release:', packageIndex))

  assert.match(jobSection, /USAGE_SMTP_USER:\s*\$\{\{\s*secrets\.USAGE_SMTP_USER\s*\}\}/u)
  assert.match(jobSection, /USAGE_SMTP_PASS:\s*\$\{\{\s*secrets\.USAGE_SMTP_PASS\s*\}\}/u)
  assert.match(jobSection, /USAGE_REPORT_TO:\s*\$\{\{\s*secrets\.USAGE_REPORT_TO\s*\}\}/u)
})

test('打包后应非敏感校验使用量上报配置', () => {
  const validator = readFileSync('scripts/validate-usage-report-config.mjs', 'utf8')
  const workflow = readFileSync(workflowPath, 'utf8')
  const packageIndex = workflow.indexOf('  package:')
  const jobSection = workflow.slice(packageIndex, workflow.indexOf('\n  release:', packageIndex))

  assert.match(jobSection, /validate-usage-report-config\.mjs/u)
  assert.match(validator, /smtpUser/u)
  assert.match(validator, /smtpPass/u)
  assert.match(validator, /reportTo/u)
  assert.match(validator, /smtpPass:\s*Boolean\(config\.smtpPass\)/u)
})
