'use strict'

const {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} = require('node:fs')
const { join, relative } = require('node:path')
const { createPackageFromStreams, extractAll, getRawHeader } = require('@electron/asar')

const requiredUnpackedFiles = new Set([
  'node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node',
  'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
  'node_modules/tesseract.js/src/worker-script/node/index.js',
  'node_modules/tesseract.js-core/tesseract-core-lstm.wasm',
  'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm',
  'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm'
])

const requiredUnpackedDirectories = [
  'node_modules/tesseract.js',
  'node_modules/tesseract.js-core',
  'node_modules/node-fetch',
  'node_modules/whatwg-url',
  'node_modules/tr46',
  'node_modules/webidl-conversions',
  'node_modules/wasm-feature-detect',
  'node_modules/is-url',
  'node_modules/bmp-js',
  'node_modules/zlibjs',
  'node_modules/regenerator-runtime',
  'node_modules/idb-keyval'
]

const forbiddenAsarPatterns = [
  /^\/node_modules\/electron-updater(?:\/|$)/u,
  /^\/node_modules\/builder-util-runtime(?:\/|$)/u,
  /^\/node_modules\/@koromix\/koffi-(?!win32-x64(?:\/|$))/u,
  /^\/node_modules\/uiohook-napi\/prebuilds\/(?!win32-x64(?:\/|$))/u,
  /^\/out\/main\/updater-[^/]+\.js$/u,
  /^\/out\/main\/chunks\/updater-[^/]+\.js$/u,
  /^\/out\/main\/ocrModelAssets-[^/]+\.js$/u,
  /^\/out\/main\/chunks\/ocrModelAssets-[^/]+\.js$/u,
  /^\/out\/main\/paddleOcr-[^/]+\.js$/u,
  /^\/out\/main\/chunks\/paddleOcr-[^/]+\.js$/u,
  /^\/out\/main\/systemOcr-[^/]+\.js$/u,
  /^\/out\/main\/chunks\/systemOcr-[^/]+\.js$/u,
  /^\/node_modules\/(?:@gutenye|@techstark|@img|@napi-rs|onnxruntime-common|onnxruntime-node|sharp)(?:\/|$)/u,
  /^\/assets\/ocr(?:\/|$)/u
]

/**
 * 判断文件是否需要从 asar 解包到 app.asar.unpacked。
 * Tesseract worker 会按真实文件路径加载 WASM 与语言数据，asar 内路径无法直接工作。
 * @param path asar 内的相对路径。
 * @returns 需要解包时返回 true。
 * @author zhenghq
 */
function shouldUnpack(path) {
  return requiredUnpackedFiles.has(path) ||
    requiredUnpackedDirectories.some((directory) => path === directory || path.startsWith(`${directory}/`))
}

/**
 * 判断 asar 条目是否必须从 Win7 包中移除。
 * @param {string} entry asar 内的绝对路径。
 * @returns {boolean} 是否命中禁止规则。
 * @author zhenghq
 */
function isForbiddenEntry(entry) {
  return forbiddenAsarPatterns.some((pattern) => pattern.test(entry))
}

/**
 * 递归列出目录内的全部文件和目录，返回使用正斜杠的相对路径。
 * @param {string} root 根目录。
 * @returns {{ path: string, type: 'file' | 'directory' }[]} 按路径排序的条目。
 * @author zhenghq
 */
function listEntries(root) {
  const entries = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name)
      const path = relative(root, fullPath).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        entries.push({ path, type: 'directory' })
        visit(fullPath)
      } else if (entry.isFile()) {
        entries.push({ path, type: 'file' })
      } else {
        throw new Error(`Win7 afterPack 不支持符号链接：${fullPath}`)
      }
    }
  }
  visit(root)
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * 将解包目录转换为 @electron/asar 可接受的流条目。
 * @param {string} root 已解包的临时应用目录。
 * @returns {import('@electron/asar').AsarStreamType[]} asar 写入条目。
 * @author zhenghq
 */
function createAsarStreams(root) {
  return listEntries(root).map((entry) => {
    const fullPath = join(root, entry.path)
    if (entry.type === 'directory') {
      return { path: entry.path, type: 'directory', unpacked: false }
    }
    return {
      path: entry.path,
      type: 'file',
      unpacked: shouldUnpack(entry.path),
      stat: statSync(fullPath),
      streamGenerator: () => createReadStream(fullPath)
    }
  })
}

/**
 * 验证重建后的 asar 和解包目录只保留 Win7 所需的原生绑定与 Tesseract WASM 运行时。
 * @param {string} asarPath 临时 asar 路径。
 * @returns {void}
 * @author zhenghq
 */
function verifyTemporaryAsar(asarPath) {
  const header = getRawHeader(asarPath).header
  const forbidden = []
  const unpacked = []
  const visit = (node, current) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const entry = `${current}/${name}`
      if (isForbiddenEntry(entry)) forbidden.push(entry)
      if (child.files) {
        visit(child, entry)
      } else if (child.unpacked) {
        unpacked.push(entry.slice(1))
      }
    }
  }
  visit(header, '')

  if (forbidden.length > 0) {
    throw new Error(`Win7 afterPack 裁剪失败：\n${forbidden.slice(0, 20).join('\n')}`)
  }
  const unexpectedUnpacked = unpacked.filter((entry) => !shouldUnpack(entry))
  const missingUnpacked = [...requiredUnpackedFiles].filter((entry) => !unpacked.includes(entry))
  if (unexpectedUnpacked.length > 0 || missingUnpacked.length > 0) {
    throw new Error(
      `Win7 afterPack 原生解包文件不符合预期。缺少：${missingUnpacked.join(', ') || '无'}；` +
        `多余：${unexpectedUnpacked.join(', ') || '无'}`
    )
  }
  for (const path of requiredUnpackedFiles) {
    const fullPath = join(`${asarPath}.unpacked`, path)
    if (!existsSync(fullPath) || lstatSync(fullPath).size === 0) {
      throw new Error(`Win7 afterPack 缺少原生文件：${fullPath}`)
    }
  }
  for (const directory of requiredUnpackedDirectories) {
    const fullPath = join(`${asarPath}.unpacked`, directory)
    if (!existsSync(fullPath)) {
      throw new Error(`Win7 afterPack 缺少解包目录：${fullPath}`)
    }
  }
}

/**
 * 用临时文件替换 electron-builder 生成的 asar 与解包目录，失败时恢复原文件。
 * @param {string} temporaryAsar 已生成的临时 asar。
 * @param {string} asarPath 目标 app.asar。
 * @returns {void}
 * @author zhenghq
 */
function replaceAsar(temporaryAsar, asarPath) {
  const temporaryUnpacked = `${temporaryAsar}.unpacked`
  const targetUnpacked = `${asarPath}.unpacked`
  const backupAsar = `${asarPath}.win7-backup`
  const backupUnpacked = `${targetUnpacked}.win7-backup`

  rmSync(backupAsar, { recursive: true, force: true })
  rmSync(backupUnpacked, { recursive: true, force: true })
  if (existsSync(asarPath)) renameSync(asarPath, backupAsar)
  if (existsSync(targetUnpacked)) renameSync(targetUnpacked, backupUnpacked)

  try {
    renameSync(temporaryAsar, asarPath)
    if (existsSync(temporaryUnpacked)) renameSync(temporaryUnpacked, targetUnpacked)
    rmSync(backupAsar, { recursive: true, force: true })
    rmSync(backupUnpacked, { recursive: true, force: true })
  } catch (error) {
    rmSync(asarPath, { force: true })
    rmSync(targetUnpacked, { recursive: true, force: true })
    if (existsSync(backupAsar)) renameSync(backupAsar, asarPath)
    if (existsSync(backupUnpacked)) renameSync(backupUnpacked, targetUnpacked)
    throw error
  }
}

/**
 * 根据 asar 头部重建不含禁止条目的归档，并解包 x64 原生文件与 Tesseract WASM 运行时。
 * @param {string} appOutDir electron-builder 的应用输出目录。
 * @returns {Promise<void>} 重建与替换完成后的 Promise。
 * @author zhenghq
 */
async function pruneAsar(appOutDir) {
  const resourcesDirectory = join(appOutDir, 'resources')
  const asarPath = join(resourcesDirectory, 'app.asar')
  if (!existsSync(asarPath)) throw new Error(`Win7 afterPack 找不到 app.asar：${asarPath}`)

  const stagingRoot = mkdtempSync(join(resourcesDirectory, '.win7-asar-'))
  const sourceRoot = join(stagingRoot, 'app')
  const temporaryAsar = join(stagingRoot, 'app.win7.asar')
  try {
    extractAll(asarPath, sourceRoot)

    const header = getRawHeader(asarPath).header
    const forbidden = []
    const visit = (node, current) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const entry = `${current}/${name}`
        if (isForbiddenEntry(entry)) forbidden.push(entry)
        if (child.files) visit(child, entry)
      }
    }
    visit(header, '')
    for (const entry of forbidden) {
      rmSync(join(sourceRoot, entry.slice(1)), { recursive: true, force: true })
    }

    await createPackageFromStreams(temporaryAsar, createAsarStreams(sourceRoot))
    verifyTemporaryAsar(temporaryAsar)
    replaceAsar(temporaryAsar, asarPath)
    console.log(`[win7] afterPack 已裁剪 ${forbidden.length} 个禁止条目`)
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

/**
 * electron-builder 打包完成后的 Win7 专属裁剪入口。
 * @param {import('app-builder-lib').AfterPackContext} context 打包上下文。
 * @returns {Promise<void>} 裁剪完成后的 Promise。
 * @author zhenghq
 */
module.exports = async function win7AfterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  await pruneAsar(context.appOutDir)
}
