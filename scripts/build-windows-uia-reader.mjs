#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helperRoot = join(projectRoot, 'helpers', 'windows-uia-reader')
const sourcePath = join(helperRoot, 'Program.cs')
const outputPath = join(helperRoot, 'windows-uia-reader.exe')
const checksumPath = join(helperRoot, 'SHA256.txt')
const windowsDirectory = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
const frameworkRoots = [
  join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
  join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319')
]
const compilerCandidates = frameworkRoots.map((root) => join(root, 'csc.exe'))
const referenceAssembliesRoot = join(
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  'Reference Assemblies',
  'Microsoft',
  'Framework',
  '.NETFramework'
)
const referenceAssemblyRoots = findVersionedReferenceRoots(referenceAssembliesRoot)
const gacRoots = ['GAC_MSIL', 'GAC_32', 'GAC_64'].map((name) =>
  join(windowsDirectory, 'Microsoft.NET', 'assembly', name)
)
const assemblyNames = [
  'System.dll',
  'System.Core.dll',
  'System.Windows.Forms.dll',
  'UIAutomationClient.dll',
  'UIAutomationTypes.dll'
]

/**
 * 判断当前是否为 Windows 构建环境。
 * @returns 是否运行在 Windows 上。
 * @author zhenghq
 */
function isWindowsHost() {
  return process.platform === 'win32'
}

/**
 * 查找 Reference Assemblies 下所有 .NET Framework 4.x 版本目录。
 * @param root Reference Assemblies 的 .NETFramework 根目录。
 * @returns 按版本号倒序排列的目录列表。
 * @author zhenghq
 */
function findVersionedReferenceRoots(root) {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^v4\.\d+(?:\.\d+)?$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((name) => join(root, name))
  } catch {
    return []
  }
}

/**
 * 在目录中递归查找指定文件名。
 * @param root 待搜索目录。
 * @param fileName 目标文件名。
 * @returns 找到的文件路径；不存在时返回 null。
 * @author zhenghq
 */
function findFileRecursively(root, fileName) {
  if (!existsSync(root)) return null
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return path
      if (entry.isDirectory()) {
        const found = findFileRecursively(path, fileName)
        if (found) return found
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * 按 Framework、Reference Assemblies、GAC 的顺序解析程序集。
 * @param fileName 程序集文件名。
 * @returns 程序集路径与全部尝试路径。
 * @author zhenghq
 */
function resolveAssembly(fileName) {
  const directRoots = [...frameworkRoots, ...referenceAssemblyRoots]
  const attempts = directRoots.map((root) => join(root, fileName))
  for (const path of attempts) {
    if (existsSync(path)) return { path, attempts }
  }
  for (const root of gacRoots) {
    attempts.push(join(root, '**', fileName))
    const found = findFileRecursively(root, fileName)
    if (found) return { path: found, attempts }
  }
  return { path: null, attempts }
}

/**
 * 检查编译输入和 .NET Framework 编译器是否齐全。
 * @returns 编译器路径与已解析的程序集引用。
 * @author zhenghq
 */
function verifyBuildInputs() {
  if (!existsSync(sourcePath)) {
    throw new Error(`Windows UIA helper 源码不存在：${sourcePath}`)
  }

  const compilerPath = compilerCandidates.find((path) => existsSync(path))
  if (!compilerPath) {
    throw new Error(
      `找不到 .NET Framework 4.x C# 编译器。全部搜索路径：\n${compilerCandidates.join('\n')}\n` +
        '请在 Windows 构建机安装 .NET Framework 4.7.2 或更高版本。'
    )
  }

  const references = []
  const missing = []
  const allAttempts = []
  for (const fileName of assemblyNames) {
    const resolved = resolveAssembly(fileName)
    allAttempts.push(...resolved.attempts)
    if (resolved.path) references.push(resolved.path)
    else missing.push(fileName)
  }
  if (missing.length > 0) {
    throw new Error(
      `Windows UIA helper 编译缺少程序集：${missing.join(', ')}。全部搜索路径：\n${allAttempts.join('\n')}`
    )
  }
  return { compilerPath, references }
}

/**
 * 计算文件的 SHA-256 校验值。
 * @param path 文件路径。
 * @returns 小写十六进制校验值。
 * @author zhenghq
 */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 使用 Windows 自带的 .NET Framework 编译器生成 helper。
 * @returns 无返回值；编译失败时抛出异常。
 * @author zhenghq
 */
function compileHelper() {
  const { compilerPath, references } = verifyBuildInputs()
  mkdirSync(helperRoot, { recursive: true })
  rmSync(outputPath, { force: true })
  rmSync(checksumPath, { force: true })

  const result = spawnSync(
    compilerPath,
    [
      '/nologo',
      '/target:exe',
      '/platform:anycpu',
      '/codepage:65001',
      `/out:${outputPath}`,
      ...references.map((path) => `/reference:${path}`),
      sourcePath
    ],
    {
      cwd: helperRoot,
      stdio: 'inherit',
      env: process.env
    }
  )

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Windows UIA helper 编译失败，退出码 ${result.status}`)
  if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
    throw new Error(`Windows UIA helper 未生成有效可执行文件：${outputPath}`)
  }
}

/**
 * 校验并写入 helper 的 SHA-256 文件。
 * @returns 无返回值；校验文件不可写时抛出异常。
 * @author zhenghq
 */
function writeChecksum() {
  const digest = sha256(outputPath)
  writeFileSync(checksumPath, `${digest}  windows-uia-reader.exe\n`, 'utf8')
  console.log(`[windows-uia-reader] 已生成 ${outputPath}`)
  console.log(`[windows-uia-reader] SHA256 ${digest}`)
}

/**
 * 在 Windows 上编译 helper；非 Windows 构建机明确跳过，避免生成不可用二进制。
 * @returns 无返回值；Windows 编译失败时以非零退出码结束。
 * @author zhenghq
 */
function main() {
  if (!isWindowsHost()) {
    console.log('[windows-uia-reader] 非 Windows 构建机，跳过 helper 编译；Windows 安装包必须由 Windows CI 构建。')
    return
  }

  compileHelper()
  writeChecksum()
}

try {
  main()
} catch (error) {
  console.error(`[windows-uia-reader] ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}
