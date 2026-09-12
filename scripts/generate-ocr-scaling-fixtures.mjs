import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, '..')
const OUTPUT_DIRECTORY = resolve(PROJECT_ROOT, 'tests', 'fixtures', 'ocr-scaling')
const EXPECTED_TEXT = 'ADAPTIVE OCR 2026'
const WIDTH = 720
const HEIGHT = 220

/**
 * 创建固定文字样本的 SVG 源图。
 * @param foreground 文字颜色。
 * @param background 背景颜色。
 * @returns 可交给 Sharp 渲染的 SVG 字节。
 * @author zhenghq
 */
function createTextSvg(foreground, background) {
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
      <rect width="100%" height="100%" fill="${background}"/>
      <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle"
        fill="${foreground}" font-family="Arial, Helvetica, sans-serif"
        font-size="58" font-weight="700" letter-spacing="1">${EXPECTED_TEXT}</text>
    </svg>
  `)
}

/**
 * 把 Sharp 图像管线保存为固定 PNG 文件。
 * @param fileName 输出文件名。
 * @param pipeline 待编码的 Sharp 图像管线。
 * @returns 无返回值。
 * @author zhenghq
 */
async function writePng(fileName, pipeline) {
  await pipeline.png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(resolve(OUTPUT_DIRECTORY, fileName))
}

/**
 * 生成清晰、失焦、低对比度与压缩伪影四类固定 OCR 样本及真值清单。
 * @returns 无返回值。
 * @author zhenghq
 */
async function generateFixtures() {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  const clearSvg = createTextSvg('#151719', '#f7f7f5')
  const lowContrastSvg = createTextSvg('#a6aaad', '#e5e7e8')

  await writePng('clear.png', sharp(clearSvg))
  await writePng('defocused.png', sharp(clearSvg).blur(2.2))
  await writePng('low-contrast.png', sharp(lowContrastSvg))

  const compressedJpeg = await sharp(clearSvg)
    .jpeg({ quality: 16, chromaSubsampling: '4:2:0', mozjpeg: false })
    .toBuffer()
  await writePng('compressed.png', sharp(compressedJpeg))

  const source = '由仓库内生成脚本 scripts/generate-ocr-scaling-fixtures.mjs 确定性生成'
  const manifest = {
    version: 1,
    expectedTextNormalization: '去除空白与标点并转为大写后计算字符准确率',
    fixtures: [
      {
        id: 'clear', category: 'clear', file: 'clear.png', expectedText: EXPECTED_TEXT, source,
        generation: `${WIDTH}×${HEIGHT}，Arial 58px 粗体，深色文字与浅色背景`
      },
      {
        id: 'defocused', category: 'defocused', file: 'defocused.png', expectedText: EXPECTED_TEXT, source,
        generation: `${WIDTH}×${HEIGHT}，由清晰源图应用 Gaussian blur sigma=2.2`
      },
      {
        id: 'low-contrast', category: 'low-contrast', file: 'low-contrast.png', expectedText: EXPECTED_TEXT, source,
        generation: `${WIDTH}×${HEIGHT}，文字 #a6aaad、背景 #e5e7e8`
      },
      {
        id: 'compressed', category: 'compressed', file: 'compressed.png', expectedText: EXPECTED_TEXT, source,
        generation: `${WIDTH}×${HEIGHT}，由清晰源图经 JPEG quality=16、4:2:0 往返后保存为 PNG`
      }
    ]
  }
  await writeFile(resolve(OUTPUT_DIRECTORY, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

await generateFixtures()
