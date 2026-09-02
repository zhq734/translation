#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 解析命令行中的配置路径，兼容默认位置与 --output 参数。
 * @returns 配置文件绝对路径。
 * @author zhenghq
 */
function resolveConfigPath() {
  const outputArgumentIndex = process.argv.indexOf('--output')
  const positional = process.argv[2]
  const output =
    outputArgumentIndex >= 0 ? process.argv[outputArgumentIndex + 1] : positional
  return resolve(output ?? 'build/usage-report-config.json')
}

/**
 * 校验使用量统计上报配置是否已完整注入，并仅输出非敏感布尔结果。
 * @returns 无返回值；校验失败时以非零退出码结束。
 * @author zhenghq
 */
function main() {
  const path = resolveConfigPath()
  if (!existsSync(path)) {
    console.error('[usage-report-config] 校验失败：配置文件不存在')
    process.exit(1)
  }
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'))
    const injected = {
      smtpUser: Boolean(config.smtpUser),
      smtpPass: Boolean(config.smtpPass),
      reportTo: Boolean(config.reportTo)
    }
    if (!injected.smtpUser || !injected.smtpPass || !injected.reportTo) {
      console.error(
        `[usage-report-config] 校验失败：凭据未完整注入（${JSON.stringify(injected)}）`
      )
      process.exit(1)
    }
    console.log(`[usage-report-config] 校验通过（${JSON.stringify(injected)}）`)
  } catch {
    console.error('[usage-report-config] 校验失败：配置不是有效 JSON')
    process.exit(1)
  }
}

main()
