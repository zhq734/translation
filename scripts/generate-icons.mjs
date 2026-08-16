import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const BUILD_DIRECTORY = 'build'
const ICON_SOURCE = join(BUILD_DIRECTORY, 'icon.svg')
const ICON_PNG = join(BUILD_DIRECTORY, 'icon.png')
const ICNS_WORK_DIRECTORY = join(BUILD_DIRECTORY, '.icns-work')

/**
 * 执行图标转换命令，并将命令输出直接转发到当前终端。
 * @param command 可执行命令名称。
 * @param args 命令参数列表。
 * @returns 无返回值。
 * @author zhenghq
 */
function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

/**
 * 使用 ImageMagick 将 SVG 转换为指定尺寸的 PNG。
 * @param source SVG 源文件路径。
 * @param size 目标正方形边长。
 * @param output PNG 输出路径。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderPng(source, size, output) {
  run('magick', [
    '-background',
    'none',
    source,
    '-resize',
    `${size}x${size}`,
    '-depth',
    '8',
    output
  ])
}

/**
 * 生成 macOS 所需的多尺寸 ICNS 应用图标。
 * @returns 无返回值。
 * @author zhenghq
 */
function generateIcns() {
  const output = join(BUILD_DIRECTORY, 'icon.icns')
  if (process.platform !== 'darwin') {
    if (!existsSync(output)) {
      throw new Error('非 macOS 环境无法首次生成 icon.icns，请提交已生成的图标文件')
    }
    return
  }

  rmSync(ICNS_WORK_DIRECTORY, { recursive: true, force: true })
  mkdirSync(ICNS_WORK_DIRECTORY, { recursive: true })
  const sizes = [16, 32, 48, 128, 256, 512, 1024]
  const tiffFiles = sizes.map((size) => {
    const tiff = join(ICNS_WORK_DIRECTORY, `icon-${size}.tiff`)
    run('sips', [
      '-z',
      String(size),
      String(size),
      '-s',
      'format',
      'tiff',
      ICON_PNG,
      '--out',
      tiff
    ])
    return tiff
  })
  const combinedTiff = join(ICNS_WORK_DIRECTORY, 'icon.tiff')
  run('tiffutil', ['-catnosizecheck', ...tiffFiles, '-out', combinedTiff])
  run('tiff2icns', [combinedTiff, output])
  rmSync(ICNS_WORK_DIRECTORY, { recursive: true, force: true })
}

/**
 * 生成应用打包和系统托盘所需的全部图标资源。
 * @returns 无返回值。
 * @author zhenghq
 */
function generateIcons() {
  mkdirSync(BUILD_DIRECTORY, { recursive: true })
  renderPng(ICON_SOURCE, 1024, ICON_PNG)
  run('magick', [
    ICON_PNG,
    '-define',
    'icon:auto-resize=256,128,64,48,32,16',
    join(BUILD_DIRECTORY, 'icon.ico')
  ])
  generateIcns()
  renderPng(join(BUILD_DIRECTORY, 'tray-template.svg'), 18, join(BUILD_DIRECTORY, 'trayTemplate.png'))
  renderPng(join(BUILD_DIRECTORY, 'tray-template.svg'), 36, join(BUILD_DIRECTORY, 'trayTemplate@2x.png'))
  renderPng(join(BUILD_DIRECTORY, 'tray-color.svg'), 32, join(BUILD_DIRECTORY, 'tray.png'))
}

generateIcons()
