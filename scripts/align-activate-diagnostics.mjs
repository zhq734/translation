#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { alignActivatesWithCandidates, parseActivateDiagnosticLogLine } from '../src/shared/activateDiagnostics.ts'

/**
 * 解析命令行参数。
 * @param argv 原始参数列表。
 * @returns 日志文件路径、窗口毫秒数与候选数量。
 * @author zhenghq
 */
function parseArgs(argv) {
  const options = { file: '', windowMs: 60_000, maxCandidates: 3 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--window-ms') {
      options.windowMs = Number(argv[index + 1])
      index += 1
    } else if (arg === '--max-candidates') {
      options.maxCandidates = Number(argv[index + 1])
      index += 1
    } else if (!options.file) {
      options.file = arg
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (!options.file) {
  console.error('用法: node scripts/align-activate-diagnostics.mjs <main-YYYY-MM-DD.log> [--window-ms 60000] [--max-candidates 3]')
  process.exit(1)
}

// 只读取诊断前缀行，绝不读取或输出选中文字、剪贴板内容与窗口标题。
const records = readFileSync(options.file, 'utf8')
  .split('\n')
  .map((line) => parseActivateDiagnosticLogLine(line))
  .filter((record) => record !== null)

const aligned = alignActivatesWithCandidates(records, {
  windowMs: options.windowMs,
  maxCandidates: options.maxCandidates
})

console.log(`共解析 ${records.length} 条诊断记录，其中 activate ${aligned.length} 次`)
for (const item of aligned) {
  const time = new Date(item.activate.timestampMs).toISOString()
  const head = `${time} decision=${item.activate.decision}`
  if (item.noNearbyCandidate) {
    console.log(`${head} <- 无近邻候选`)
    continue
  }
  for (const candidate of item.candidates) {
    console.log(
      `${head} <- ${candidate.record.action} +${candidate.deltaMs}ms visible=${candidate.record.windowVisible}`
    )
  }
}
