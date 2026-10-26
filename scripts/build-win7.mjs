#!/usr/bin/env node
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listPackage } from '@electron/asar'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = join(root, 'dist-win7')
const unpackedDirectory = join(outputDirectory, 'win-unpacked')
const resourcesDirectory = join(unpackedDirectory, 'resources')
const requiredUnpackedFiles = [
  'node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node',
  'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node'
]
const forbiddenAsarPrefixes = [
  '/assets/ocr',
  '/node_modules/@gutenye',
  '/node_modules/@techstark',
  '/node_modules/@img',
  '/node_modules/builder-util-runtime',
  '/node_modules/electron-updater',
  '/node_modules/onnxruntime-common',
  '/node_modules/onnxruntime-node',
  '/node_modules/sharp',
  '/node_modules/tesseract.js',
  '/node_modules/tesseract.js-core',
  '/out/main/ocrDispatcher-',
  '/out/main/ocrModelAssets-',
  '/out/main/paddleOcr-',
  '/out/main/systemOcr-',
  '/out/main/tesseractOcr-',
  '/out/main/updater-'
]

/**
 * 判断 asar 或解包目录中的路径是否属于非 Win7 平台绑定或已禁用运行时。
 * @param {string} path 使用正斜杠的相对路径。
 * @returns {boolean} 路径必须从 Win7 包中排除时返回 true。
 * @author zhenghq
 */
function isForbiddenRuntimePath(path) {
  return /(?:^|\/)@koromix\/koffi-(?!win32-x64(?:\/|$))/u.test(path) ||
    /(?:^|\/)uiohook-napi\/prebuilds\/(?!win32-x64(?:\/|$))/u.test(path)
}

/**
 * 执行项目脚本，并在失败时保留子进程输出。
 * @param {string} command 可执行文件。
 * @param {string[]} args 命令参数。
 * @returns {void}
 * @author zhenghq
 */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, WIN7_BUILD: '1' }
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 执行失败`)
}

/**
 * 使用当前 Node 可执行文件运行项目脚本。
 * @param {string} script 项目内脚本路径。
 * @param {string[]} args 脚本参数。
 * @returns {void}
 * @author zhenghq
 */
function runNode(script, args = []) {
  run(process.execPath, [join(root, script), ...args])
}

/**
 * 删除 Win7 构建目录中不应发布的自动更新清单与差分文件。
 * @returns {string[]} 已删除的文件名。
 * @author zhenghq
 */
function removeUpdateArtifacts() {
  if (!existsSync(outputDirectory)) return []
  const removed = []
  for (const name of readdirSync(outputDirectory)) {
    if (/^latest.*\.yml$/u.test(name) || /\.blockmap$/u.test(name)) {
      rmSync(join(outputDirectory, name), { force: true })
      removed.push(name)
    }
  }
  return removed
}

/**
 * 递归检查解包目录中是否存在禁止分发的 OCR 原生资源。
 * @param {string} directory 待检查目录。
 * @returns {string[]} 命中的相对路径。
 * @author zhenghq
 */
function findForbiddenFiles(directory) {
  if (!existsSync(directory)) return []
  const matches = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const relative = path.slice(directory.length + 1).replaceAll('\\', '/')
      if (
        /(^|\/)(assets\/ocr|@gutenye|@techstark|@img|onnxruntime-(common|node)|sharp|tesseract\.js|tesseract\.js-core)(\/|$)/u.test(relative) ||
        isForbiddenRuntimePath(relative)
      ) {
        matches.push(relative)
      }
      if (entry.isDirectory()) visit(path)
    }
  }
  visit(directory)
  return matches
}

/**
 * 校验 Win7 包内没有 OCR 原生链路，并确认必要运行时仍被打入 asar。
 * @returns {void}
 * @author zhenghq
 */
function verifyWin7Package() {
  const asarPath = join(resourcesDirectory, 'app.asar')
  if (!existsSync(asarPath)) throw new Error(`Win7 包缺少 app.asar：${asarPath}`)
  if (existsSync(join(resourcesDirectory, 'app-update.yml'))) {
    throw new Error('Win7 包仍包含 resources/app-update.yml，必须通过 publish: null 阻止生成')
  }
  const helperPath = join(resourcesDirectory, 'windows-uia-reader.exe')
  if (!existsSync(helperPath)) {
    throw new Error(`Win7 包缺少 Windows UIA helper：${helperPath}`)
  }
  if (statSync(helperPath).size < 4096) {
    throw new Error(`Win7 包中的 Windows UIA helper 体积异常：${statSync(helperPath).size} 字节`)
  }
  const entries = listPackage(asarPath)
  const forbidden = entries.filter((entry) =>
    forbiddenAsarPrefixes.some((prefix) => entry === prefix || entry.startsWith(`${prefix}/`)) ||
    isForbiddenRuntimePath(entry)
  )
  if (forbidden.length > 0) {
    throw new Error(`Win7 包仍包含禁用运行时或 OCR 资源：\n${forbidden.slice(0, 20).join('\n')}`)
  }
  const required = [
    '/out/main/updateManager-',
    '/node_modules/uiohook-napi/package.json',
    '/node_modules/koffi/package.json'
  ]
  const missing = required.filter((entry) =>
    entry.endsWith('-') ? !entries.some((candidate) => candidate.startsWith(entry)) : !entries.includes(entry)
  )
  if (missing.length > 0) {
    throw new Error(`Win7 包缺少必要运行时：${missing.join(', ')}`)
  }

  const unpackedRoot = join(resourcesDirectory, 'app.asar.unpacked')
  const unpackedMatches = findForbiddenFiles(unpackedRoot)
  if (unpackedMatches.length > 0) {
    throw new Error(`Win7 解包资源仍包含 OCR 或其它平台绑定：\n${unpackedMatches.slice(0, 20).join('\n')}`)
  }
  for (const path of requiredUnpackedFiles) {
    const fullPath = join(unpackedRoot, path)
    if (!existsSync(fullPath) || statSync(fullPath).size === 0) {
      throw new Error(`Win7 包缺少 x64 原生绑定：${fullPath}`)
    }
  }
  console.log(`[win7] 包内容校验通过：${entries.length} 个 asar 条目，未发现 OCR 原生依赖`)
}

/**
 * 构建并校验 Windows 7 x64 专用安装包。
 * @returns {void}
 * @author zhenghq
 */
function main() {
  if (process.platform !== 'win32') {
    throw new Error('Windows 安装包必须由 Windows CI 构建')
  }
  rmSync(outputDirectory, { recursive: true, force: true })
  runNode('scripts/build-windows-uia-reader.mjs')
  runNode('scripts/generate-build-info.mjs', [
    '--output',
    'build/build-info.json',
    '--allow-local-fallback'
  ])
  runNode('scripts/generate-usage-report-config.mjs')
  run(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'])
  run(process.execPath, [
    join(root, 'node_modules/electron-builder/cli.js'),
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
    '--config',
    join(root, 'electron-builder-win7.yml')
  ])

  const removed = removeUpdateArtifacts()
  if (removed.length > 0) console.log(`[win7] 已清理自动更新产物：${removed.join(', ')}`)
  if (readdirSync(outputDirectory).some((name) => /^latest.*\.yml$/u.test(name) || /\.blockmap$/u.test(name))) {
    throw new Error('Win7 构建目录仍存在自动更新清单或 blockmap')
  }
  verifyWin7Package()
  const installer = readdirSync(outputDirectory).find((name) => name.endsWith('-Setup-win7-x64.exe'))
  if (!installer) throw new Error('Win7 构建未生成 Setup-win7-x64.exe 安装包')
  console.log(`[win7] 构建完成：${join(outputDirectory, installer)}`)
}

try {
  main()
} catch (error) {
  console.error(`[win7] ${error instanceof Error ? error.message : error}`)
  rmSync(outputDirectory, { recursive: true, force: true })
  process.exitCode = 1
}
