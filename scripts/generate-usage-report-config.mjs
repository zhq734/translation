#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * 从环境变量生成使用量统计上报 SMTP 配置。
 * 凭据仅由 GitHub Actions Secrets 在打包流水线注入；本地构建缺省为空配置，
 * 运行时检测到空配置会静默跳过发送。
 * @author zhenghq
 */
function main() {
  const output = resolve(process.argv[2] ?? 'build/usage-report-config.json')
  const config = {
    smtpUser: process.env.USAGE_SMTP_USER ?? '',
    smtpPass: process.env.USAGE_SMTP_PASS ?? '',
    reportTo: process.env.USAGE_REPORT_TO ?? ''
  }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(config, null, 2))
  const configured = Boolean(config.smtpUser && config.smtpPass && config.reportTo)
  // 只回显是否配置，绝不输出任何敏感值
  console.log(`[usage-report-config] 已生成 ${output}（凭据${configured ? '已注入' : '未配置，发送将静默跳过'}）`)
}

main()
