#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 解析 macOS 更新清单合并命令参数。
 * @param {string[]} argumentsList 命令行参数列表。
 * @returns {{ directory: string }} 参数解析结果。
 * @author zhenghq
 */
function parseArguments(argumentsList) {
  let directory = 'release-assets'
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--directory') {
      directory = argumentsList[index + 1]
      index += 1
      continue
    }
    throw new Error(`不支持的参数：${argument}`)
  }
  if (!directory) throw new Error('--directory 缺少目录参数。')
  return { directory: resolve(directory) }
}

/**
 * 从 electron-builder 生成的更新清单中读取顶层标量字段。
 * @param {string} manifest 更新清单文本。
 * @param {string} key 字段名。
 * @returns {string} 字段值。
 * @author zhenghq
 */
function readScalar(manifest, key) {
  const match = manifest.match(new RegExp(`^${key}:\\s*(.+)$`, 'mu'))
  if (!match?.[1]) throw new Error(`macOS 更新清单缺少字段：${key}`)
  return match[1]
}

/**
 * 读取更新清单中 files 下的完整条目，避免引入额外 YAML 运行时依赖。
 * @param {string} manifest 更新清单文本。
 * @returns {string[]} 安装包条目文本。
 * @author zhenghq
 */
function readFileEntries(manifest) {
  const lines = manifest.split(/\r?\n/u)
  const filesIndex = lines.findIndex((line) => line === 'files:')
  if (filesIndex < 0) throw new Error('macOS 更新清单缺少 files 字段')

  const entries = []
  let current = []
  for (const line of lines.slice(filesIndex + 1)) {
    if (line.startsWith('  - url:')) {
      if (current.length > 0) entries.push(current.join('\n'))
      current = [line]
      continue
    }
    if (current.length > 0 && line.startsWith('    ')) {
      current.push(line)
      continue
    }
    if (current.length > 0) break
  }
  if (current.length > 0) entries.push(current.join('\n'))
  if (entries.length === 0) throw new Error('macOS 更新清单 files 为空')
  return entries
}

/**
 * 合并 x64 与 arm64 更新清单，并保留 electron-updater 兼容的 latest-mac.yml 文件名。
 * @param {string} directory 发布资产目录。
 * @returns {string} 合并后的清单路径。
 * @author zhenghq
 */
function mergeMacUpdateInfo(directory) {
  const manifests = ['x64', 'arm64'].map((arch) => {
    const path = join(directory, `latest-mac-${arch}.yml`)
    if (!existsSync(path)) throw new Error(`缺少 macOS ${arch} 更新清单：${path}`)
    return { arch, path, content: readFileSync(path, 'utf8') }
  })

  const version = readScalar(manifests[0].content, 'version')
  for (const manifest of manifests.slice(1)) {
    if (readScalar(manifest.content, 'version') !== version) {
      throw new Error('macOS 双架构更新清单版本不一致')
    }
  }

  const entries = manifests
    .flatMap((manifest) => readFileEntries(manifest.content))
    .filter((entry, index, all) => {
      const url = entry.match(/^  - url:\s*(.+)$/mu)?.[1]
      return url && all.findIndex((candidate) => candidate.match(/^  - url:\s*(.+)$/mu)?.[1] === url) === index
    })
  const primary = manifests[0].content
  const outputPath = join(directory, 'latest-mac.yml')
  const output = [
    `version: ${version}`,
    'files:',
    ...entries,
    `path: ${readScalar(primary, 'path')}`,
    `sha512: ${readScalar(primary, 'sha512')}`,
    `releaseDate: ${readScalar(primary, 'releaseDate')}`,
    ''
  ].join('\n')
  writeFileSync(outputPath, output, 'utf8')

  for (const manifest of manifests) unlinkSync(manifest.path)
  return outputPath
}

/**
 * 执行 macOS 更新清单合并命令并输出结果摘要。
 * @returns {Promise<void>} 无返回值。
 * @author zhenghq
 */
async function main() {
  const { directory } = parseArguments(process.argv.slice(2))
  const outputPath = mergeMacUpdateInfo(directory)
  console.log(`已合并 macOS 双架构更新清单：${outputPath}`)
}

main().catch((error) => {
  console.error(`[merge-mac-update-info] ${(error).message}`)
  process.exitCode = 1
})
