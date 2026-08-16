#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const RELEASE_FILE_PATTERN = /\.(?:AppImage|dmg|zip|exe)$/u

/**
 * 解析校验和生成命令的目录与输出路径参数。
 * @param {string[]} argumentsList 命令行参数列表。
 * @returns {{ directory: string, output: string }} 规范化后的目录与输出路径。
 * @author zhenghq
 */
function parseArguments(argumentsList) {
  let directory = 'dist'
  let output
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--directory') {
      directory = argumentsList[index + 1]
      index += 1
      continue
    }
    if (argument === '--output') {
      output = argumentsList[index + 1]
      index += 1
      continue
    }
    throw new Error(`不支持的参数：${argument}`)
  }
  if (!directory) throw new Error('--directory 缺少目录参数。')
  const resolvedDirectory = resolve(directory)
  return {
    directory: resolvedDirectory,
    output: resolve(output || join(resolvedDirectory, 'SHA256SUMS'))
  }
}

/**
 * 判断文件是否为需要发布并生成校验和的安装包。
 * @param {string} fileName 候选文件名。
 * @returns {boolean} 是否为支持的发行安装包。
 * @author zhenghq
 */
function isReleaseFile(fileName) {
  return RELEASE_FILE_PATTERN.test(fileName)
}

/**
 * 使用流式读取计算文件 SHA-256，避免将大型安装包整体载入内存。
 * @param {string} filePath 待计算文件路径。
 * @returns {Promise<string>} 小写 SHA-256 字符串。
 * @author zhenghq
 */
function calculateSha256(filePath) {
  return new Promise((resolveChecksum, rejectChecksum) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', rejectChecksum)
    stream.on('end', () => resolveChecksum(hash.digest('hex')))
  })
}

/**
 * 为目录中的桌面安装包生成 GNU sha256sum 兼容的校验和清单。
 * @param {string} directory 安装包目录。
 * @param {string} outputPath SHA256SUMS 输出路径。
 * @returns {Promise<number>} 写入清单的安装包数量。
 * @author zhenghq
 */
async function generateChecksums(directory, outputPath) {
  if (!existsSync(directory)) throw new Error(`发行目录不存在：${directory}`)
  const files = readdirSync(directory)
    .filter((fileName) => isReleaseFile(fileName))
    .filter((fileName) => statSync(join(directory, fileName)).isFile())
    .sort((left, right) => left.localeCompare(right, 'en'))
  if (files.length === 0) throw new Error(`发行目录中没有可生成校验和的安装包：${directory}`)

  const lines = []
  for (const fileName of files) {
    const checksum = await calculateSha256(join(directory, fileName))
    lines.push(`${checksum}  ${fileName}`)
  }
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8')
  return files.length
}

/**
 * 执行校验和生成命令并输出结果摘要。
 * @returns {Promise<void>} 无返回值。
 * @author zhenghq
 */
async function main() {
  const options = parseArguments(process.argv.slice(2))
  const count = await generateChecksums(options.directory, options.output)
  console.log(`已为 ${count} 个安装包生成校验和：${options.output}`)
}

main().catch((error) => {
  console.error(`[release:checksums] ${(error).message}`)
  process.exitCode = 1
})
