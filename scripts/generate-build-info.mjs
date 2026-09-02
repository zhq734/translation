#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * 构建元数据协议版本，必须与 src/shared/buildMetadata.ts 保持一致。
 */
const SCHEMA_VERSION = 1
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/u
const LOCAL_RUN_ID = 'local'
const LOCAL_RUN_ATTEMPT = '0'
const LOCAL_BUILD_ID = 'local-development'

/**
 * 解析构建元数据生成命令的参数。
 * @param {string[]} argumentsList 命令行参数列表。
 * @returns {{ output: string, allowLocalFallback: boolean, check: boolean }} 规范化后的选项。
 * @author zhenghq
 */
function parseArguments(argumentsList) {
  let output = 'build/build-info.json'
  let allowLocalFallback = false
  let check = false
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--output') {
      output = argumentsList[index + 1]
      index += 1
      continue
    }
    if (argument === '--allow-local-fallback') {
      allowLocalFallback = true
      continue
    }
    if (argument === '--check') {
      check = true
      continue
    }
    throw new Error(`不支持的参数：${argument}`)
  }
  if (!output) throw new Error('--output 缺少输出文件路径。')
  return { output: resolve(output), allowLocalFallback, check }
}

/**
 * 将版本号规范化为纯 SemVer 主次修订格式。
 * @param {string | undefined} value 原始版本号，允许带 `v`/`V` 前缀。
 * @returns {string | null} 规范化版本号；不符合格式时返回 null。
 * @author zhenghq
 */
function normalizeSemanticVersion(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/^[vV]/u, '')
  return SEMVER_PATTERN.test(normalized) ? normalized : null
}

/**
 * 读取 package.json 中声明的应用版本。
 * @returns {string} package.json 的 version 字段。
 * @author zhenghq
 */
function readPackageVersion() {
  const packageJsonPath = resolve('package.json')
  if (!existsSync(packageJsonPath)) return ''
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  return typeof parsed.version === 'string' ? parsed.version : ''
}

/**
 * 解析本次构建使用的规范化版本号。
 * 优先使用显式指定的 BUILD_INFO_VERSION，其次是版本标签，最后回退到 package.json。
 * @returns {string} 规范化 SemVer 版本号。
 * @author zhenghq
 */
function resolveVersion() {
  const explicitVersion = process.env['BUILD_INFO_VERSION']
  if (typeof explicitVersion === 'string' && explicitVersion.trim()) {
    const normalized = normalizeSemanticVersion(explicitVersion)
    if (!normalized) {
      throw new Error(`BUILD_INFO_VERSION 不是规范化 SemVer version：${explicitVersion}`)
    }
    return normalized
  }
  const tagVersion = normalizeSemanticVersion(process.env['GITHUB_REF_NAME'])
  if (tagVersion) return tagVersion
  const packageVersion = normalizeSemanticVersion(readPackageVersion())
  if (!packageVersion) {
    throw new Error('无法解析规范化 SemVer version：请提供 BUILD_INFO_VERSION 或版本标签。')
  }
  return packageVersion
}

/**
 * 读取本地 Git 仓库当前提交哈希。
 * @returns {string} 当前提交哈希；无法获取时返回空字符串。
 * @author zhenghq
 */
function readLocalCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/**
 * 校验必填的非空字段。
 * @param {string | undefined} value 字段值。
 * @param {string} field 字段名称。
 * @returns {string} 去除首尾空白后的字段值。
 * @author zhenghq
 */
function requireNonEmpty(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`缺少构建元数据字段 ${field}：请在 GitHub Actions 环境中运行。`)
  return normalized
}

/**
 * 依据当前环境生成构建元数据。
 * @param {boolean} allowLocalFallback 缺少 GitHub Actions 变量时是否允许生成本地占位元数据。
 * @returns {{ schemaVersion: number, version: string, buildId: string, sourceCommit: string, workflowRunId: string, workflowRunAttempt: string }} 构建元数据。
 * @author zhenghq
 */
function createBuildMetadata(allowLocalFallback) {
  const version = resolveVersion()
  const hasWorkflowIdentity = Boolean(process.env['GITHUB_RUN_ID'] && process.env['GITHUB_RUN_ATTEMPT'])
  if (!hasWorkflowIdentity && allowLocalFallback) {
    return {
      schemaVersion: SCHEMA_VERSION,
      version,
      buildId: LOCAL_BUILD_ID,
      sourceCommit: readLocalCommit() || 'unknown',
      workflowRunId: LOCAL_RUN_ID,
      workflowRunAttempt: LOCAL_RUN_ATTEMPT
    }
  }
  const workflowRunId = requireNonEmpty(process.env['GITHUB_RUN_ID'], 'GITHUB_RUN_ID')
  const workflowRunAttempt = requireNonEmpty(process.env['GITHUB_RUN_ATTEMPT'], 'GITHUB_RUN_ATTEMPT')
  const sourceCommit = requireNonEmpty(process.env['GITHUB_SHA'], 'GITHUB_SHA')
  return {
    schemaVersion: SCHEMA_VERSION,
    version,
    buildId: `github-run-${workflowRunId}-attempt-${workflowRunAttempt}`,
    sourceCommit,
    workflowRunId,
    workflowRunAttempt
  }
}

/**
 * 以固定字段顺序稳定序列化构建元数据。
 * @param {Record<string, unknown>} metadata 构建元数据。
 * @returns {string} 以换行结尾的 JSON 文本。
 * @author zhenghq
 */
function serializeBuildMetadata(metadata) {
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
 * 校验已有构建元数据是否与当前工作流运行完全一致。
 * @param {string} outputPath 已生成的构建元数据路径。
 * @param {Record<string, unknown>} expected 当前环境应产出的构建元数据。
 * @returns {void} 无返回值。
 * @author zhenghq
 */
function checkBuildMetadata(outputPath, expected) {
  if (!existsSync(outputPath)) throw new Error(`构建元数据不存在：${outputPath}`)
  const actualText = readFileSync(outputPath, 'utf8')
  if (actualText !== serializeBuildMetadata(expected)) {
    let actualBuildId = '未知'
    try {
      actualBuildId = String(JSON.parse(actualText).buildId)
    } catch {
      actualBuildId = '无法解析'
    }
    throw new Error(
      `构建元数据与当前工作流运行不一致：期望 buildId ${expected.buildId}，实际 buildId ${actualBuildId}`
    )
  }
}

/**
 * 生成或校验构建元数据文件。
 * @returns {void} 无返回值。
 * @author zhenghq
 */
function main() {
  const options = parseArguments(process.argv.slice(2))
  const metadata = createBuildMetadata(options.allowLocalFallback)
  if (options.check) {
    checkBuildMetadata(options.output, metadata)
    console.log(`构建元数据校验通过：${options.output}（buildId ${metadata.buildId}）`)
    return
  }
  mkdirSync(dirname(options.output), { recursive: true })
  writeFileSync(options.output, serializeBuildMetadata(metadata), 'utf8')
  console.log(`已生成构建元数据：${options.output}（buildId ${metadata.buildId}）`)
}

try {
  main()
} catch (error) {
  console.error(`[build-info] ${error.message}`)
  process.exitCode = 1
}
