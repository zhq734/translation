import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const root = resolve(dirname(scriptPath), '..')
const require = createRequire(import.meta.url)
const { open } = require('yauzl')
const outputDirectory = join(root, 'dist-portable')

/**
 * 为便携配置提供全新的现代 Windows 资源配置，不继承其他平台、NSIS 或发布元数据。
 * @returns {object} electron-builder 父配置；每次读取独立对象，不修改 package.json。
 * @author zhenghq
 */
export default function portableBaseConfiguration() {
  const { build } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const { appId, productName, npmRebuild, files, asarUnpack, icon, win } = build
  return {
    appId, productName, npmRebuild, files, asarUnpack, icon,
    win: { files: win.files, extraResources: win.extraResources, icon: win.icon }
  }
}

/**
 * 执行构建子命令，保留输出与环境并在失败时停止后续打包。
 * @param {string} command 可执行文件。
 * @param {string[]} args 子命令参数。
 * @returns {void} 成功时无返回值，失败时抛出异常。
 * @author zhenghq
 */
function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: command === 'npm.cmd'
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 构建失败，退出码 ${result.status}`)
}

/**
 * 只读取 ZIP 目录索引，避免大型 OCR ZIP 整包载入内存或解压到工作目录。
 * @param {string} archivePath ZIP 文件路径。
 * @returns {Promise<{zip: object, entries: Map<string, object>}>} ZIP 句柄与条目索引。
 * @author zhenghq
 */
function readArchiveIndex(archivePath) {
  return new Promise((resolveIndex, reject) => {
    open(archivePath, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error) return reject(error)
      const entries = new Map()
      zip.on('error', (zipError) => { zip.close(); reject(zipError) })
      zip.on('entry', (entry) => {
        entries.set(entry.fileName, entry)
        zip.readEntry()
      })
      zip.on('end', () => resolveIndex({ zip, entries }))
      zip.readEntry()
    })
  })
}

/**
 * 读取有大小上限的便携标识，不读取其它大体积运行资源内容。
 * @param {object} zip 已打开的 ZIP 句柄。
 * @param {object} entry portable.json 条目。
 * @returns {Promise<string>} 标识 UTF-8 文本。
 * @author zhenghq
 */
function readMarker(zip, entry) {
  if (entry.uncompressedSize > 1024) throw new Error('portable.json 大小异常')
  return new Promise((resolveMarker, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error)
      const chunks = []
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolveMarker(Buffer.concat(chunks).toString('utf8')))
    })
  })
}

/**
 * 校验可解压的便携 ZIP，确保 EXE 同级标识、Windows 资源与目标架构原生库齐全。
 * @param {string} archivePath ZIP 文件路径。
 * @param {'x64' | 'arm64'} arch ZIP 的目标架构。
 * @returns {Promise<void>} 校验成功无返回值，否则抛出具体缺失或污染错误。
 * @author zhenghq
 */
export async function verifyPortableArchive(archivePath, arch) {
  const { zip, entries } = await readArchiveIndex(archivePath)
  try {
    const names = [...entries.keys()].filter((name) => entries.get(name).uncompressedSize > 0)
    const unpacked = 'resources/app.asar.unpacked'
    const required = [
      `${portableBaseConfiguration().productName}.exe`, 'portable.json', 'icudtl.dat',
      'resources/app.asar', 'resources/app-icon.ico', 'resources/build-info.json',
      'resources/windows-uia-reader.exe',
      `${unpacked}/assets/ocr/ppocrv6_tiny/det.onnx`,
      `${unpacked}/assets/ocr/ppocrv6_tiny/rec.onnx`,
      `${unpacked}/assets/ocr/ppocrv6_tiny/dict.txt`,
      `${unpacked}/node_modules/@img/sharp-win32-${arch}/lib/sharp-win32-${arch}.node`,
      `${unpacked}/node_modules/@img/sharp-win32-${arch}/lib/libvips-42.dll`,
      `${unpacked}/node_modules/@napi-rs/canvas-win32-${arch}-msvc/skia.win32-${arch}-msvc.node`,
      `${unpacked}/node_modules/@napi-rs/canvas-win32-${arch}-msvc/icudtl.dat`,
      `${unpacked}/node_modules/onnxruntime-node/bin/napi-v6/win32/${arch}/onnxruntime_binding.node`,
      `${unpacked}/node_modules/onnxruntime-node/bin/napi-v6/win32/${arch}/onnxruntime.dll`
    ]
    for (const name of required) {
      if (!names.includes(name)) throw new Error(`${arch} ZIP 缺少非空资源：${name}`)
    }
    const groups = [
      /^locales\/[^/]+\.pak$/u,
      /^resources\/assets\/fonts\/.+\.(?:ttf|otf)$/u,
      new RegExp(`^${unpacked}/node_modules/uiohook-napi/(?:prebuilds/win32-${arch}|bin/win32-${arch}[^/]*|build/Release)/[^/]+\\.node$`, 'u'),
      new RegExp(`^${unpacked}/node_modules/(?:@koromix/koffi-win32-${arch}/win32_${arch}|koffi/build/koffi/win32_${arch})/koffi\\.node$`, 'u')
    ]
    for (const pattern of groups) {
      if (!names.some((name) => pattern.test(name))) throw new Error(`${arch} ZIP 缺少运行资源：${pattern}`)
    }
    for (const name of entries.keys()) {
      if (/(?:^|\/)(?:app-update\.yml|latest[^/]*\.yml)$|\.blockmap$/u.test(name)) {
        throw new Error(`便携 ZIP 不得包含自动更新元数据：${name}`)
      }
      if (name === 'data' || name.startsWith('data/')) throw new Error(`便携 ZIP 不得预置用户 data：${name}`)
    }
    try {
      const marker = JSON.parse(await readMarker(zip, entries.get('portable.json')))
      if (marker?.version !== 1 || Object.keys(marker).length !== 1) throw new Error('版本或字段错误')
    } catch (error) {
      throw new Error(`portable.json 无效：${error.message}`)
    }
  } finally {
    zip.close()
  }
}

/**
 * 验证两个架构 ZIP 已生成，且独立输出目录没有安装版更新清单或差分包。
 * @param {string} directory 便携产物目录，默认 dist-portable。
 * @param {string} version 当前构建版本，默认 package.json 版本。
 * @returns {Promise<void>} 校验成功无返回值。
 * @author zhenghq
 */
export async function verifyPortablePackages(directory = outputDirectory, version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version) {
  for (const name of readdirSync(directory)) {
    if (/^latest.*\.yml$|\.blockmap$/u.test(name)) throw new Error(`便携输出不得包含自动更新元数据：${name}`)
  }
  for (const arch of ['x64', 'arm64']) {
    await verifyPortableArchive(join(directory, `SelectionTranslator-${version}-Portable-${arch}.zip`), arch)
  }
}

/**
 * 使用既有 build 和 OCR/UIA 准备流程构建双架构 ZIP，不触碰安装版配置及输出。
 * @param {object} options 测试可注入平台、命令执行器和产物校验器；CLI 使用默认实现。
 * @returns {Promise<void>} 完成构建与校验，无返回值。
 * @author zhenghq
 */
export async function buildWindowsPortable({ platform = process.platform, run = runCommand, verify = verifyPortablePackages } = {}) {
  if (platform !== 'win32') throw new Error('Windows 便携包必须在 Windows 上构建')
  if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, 'run', 'build'])
  else run('npm.cmd', ['run', 'build'])
  run(process.execPath, [join(root, 'scripts/prepare-windows-ocr-runtime.mjs')])
  run(process.execPath, [
    join(root, 'node_modules/electron-builder/cli.js'),
    '--win', 'zip', '--x64', '--arm64', '--publish', 'never',
    '--config', join(root, 'electron-builder-portable.yml')
  ])
  await verify()
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  buildWindowsPortable().catch((error) => {
    console.error(`[windows-portable] ${error.message}`)
    process.exitCode = 1
  })
}
