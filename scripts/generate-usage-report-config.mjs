#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * 解析命令行中的输出路径，兼容默认位置与 --output 参数。
 * @returns 输出文件绝对路径。
 * @author zhenghq
 */
function resolveOutputPath() {
  const outputArgumentIndex = process.argv.indexOf('--output')
  const positional = process.argv[2]
  const output =
    outputArgumentIndex >= 0 ? process.argv[outputArgumentIndex + 1] : positional
  return resolve(output ?? 'build/usage-report-config.json')
}

/**
 * 从环境变量读取使用量统计上报 SMTP 配置。
 * @returns 仅包含三个配置字段的对象。
 * @author zhenghq
 */
function readEnvironmentConfig() {
  return {
    smtpUser: process.env.USAGE_SMTP_USER ?? '',
    smtpPass: process.env.USAGE_SMTP_PASS ?? '',
    reportTo: process.env.USAGE_REPORT_TO ?? ''
  }
}

/**
 * 判断配置三项是否全部非空。
 * @param config 待判断的配置对象。
 * @returns 全部字段非空时返回 true。
 * @author zhenghq
 */
function isConfigured(config) {
  return Boolean(config.smtpUser && config.smtpPass && config.reportTo)
}

/**
 * 读取已存在的配置，避免空输入覆盖先前注入的非空凭据。
 * @param path 配置文件路径。
 * @returns 存在且三项非空时返回原配置，否则返回 null。
 * @author zhenghq
 */
function readPreservedConfig(path) {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return isConfigured(raw) ? raw : null
  } catch {
    return null
  }
}

/**
 * 从环境变量生成使用量统计上报 SMTP 配置。
 * 凭据仅由 GitHub Actions Secrets 在打包流水线注入；本地构建缺省为空配置，
 * 运行时检测到空配置会静默跳过发送。同一 job 中后续打包链再次调用时，
 * 只要凭据输入一致即可幂等写入；空输入不得覆盖已有非空产物。
 * @author zhenghq
 */
function main() {
  const output = resolveOutputPath()
  const environmentConfig = readEnvironmentConfig()
  const config = isConfigured(environmentConfig)
    ? environmentConfig
    : readPreservedConfig(output) ?? environmentConfig
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(config, null, 2))
  const configured = isConfigured(config)
  // 只回显是否配置，绝不输出任何敏感值
  console.log(`[usage-report-config] 已生成 ${output}（凭据${configured ? '已注入' : '未配置，发送将静默跳过'}）`)
}

main()
