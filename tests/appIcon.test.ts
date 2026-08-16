import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import test from 'node:test'

interface PackageJson {
  scripts?: Record<string, string>
  build?: {
    icon?: string
    files?: string[]
    mac?: { icon?: string }
    win?: { icon?: string }
    linux?: { icon?: string }
  }
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson

/**
 * 读取 PNG 图片在 IHDR 中声明的宽高。
 * @param path PNG 图片路径。
 * @returns PNG 图片宽高。
 * @author zhenghq
 */
function readPngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR')
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  }
}

/**
 * 校验应用图标配置覆盖 macOS、Windows 和 Linux 打包目标。
 * @returns 无返回值。
 * @author zhenghq
 */
test('应用打包应使用翻译主题的自定义图标', () => {
  assert.equal(packageJson.build?.icon, 'build/icon.png')
  assert.equal(packageJson.build?.mac?.icon, 'build/icon.icns')
  assert.equal(packageJson.build?.win?.icon, 'build/icon.ico')
  assert.equal(packageJson.build?.linux?.icon, 'build/icon.png')
  assert.equal(packageJson.scripts?.['icons:generate'], 'node scripts/generate-icons.mjs')
})

/**
 * 校验应用图标与托盘图标沿用选区按钮的“译”字视觉。
 * @returns 无返回值。
 * @author zhenghq
 */
test('应用与托盘图标应显示和选区按钮一致的“译”字', () => {
  const selectionHtml = readFileSync('src/renderer/selection.html', 'utf8')
  const iconSvg = readFileSync('build/icon.svg', 'utf8')
  const trayColorSvg = readFileSync('build/tray-color.svg', 'utf8')
  const trayTemplateSvg = readFileSync('build/tray-template.svg', 'utf8')

  assert.match(selectionHtml, /<button[^>]+id="translate"[^>]*>译<\/button>/u)
  for (const source of [iconSvg, trayColorSvg, trayTemplateSvg]) {
    assert.match(source, /<title>译<\/title>/u)
    assert.match(source, /id="rounded-yi-glyph"[^>]+data-font-family="Wawati SC"/u)
    assert.match(source, /stroke-linecap="round"[^>]+stroke-linejoin="round"/u)
    assert.doesNotMatch(source, /font-family="Heiti SC"/u)
  }
  assert.match(iconSvg, /transform="translate\(162\.5 720\) scale\(2\.82\)"/u)
  assert.match(trayColorSvg, /transform="translate\(5\.5 21\.6\) scale\(0\.084\)"/u)
  assert.match(trayTemplateSvg, /transform="translate\(3\.2 25\.9\) scale\(0\.113\)"/u)
})

/**
 * 校验打包图标及托盘图标资源存在且具备正确的基础格式。
 * @returns 无返回值。
 * @author zhenghq
 */
test('应用图标资源应完整且满足桌面打包尺寸要求', () => {
  const expectedFiles = [
    'build/icon.svg',
    'build/icon.png',
    'build/icon.icns',
    'build/icon.ico',
    'build/tray.png',
    'build/trayTemplate.png',
    'build/trayTemplate@2x.png'
  ]
  for (const file of expectedFiles) {
    assert.equal(existsSync(file), true, `${file} 应存在`)
    assert.ok(statSync(file).size > 0, `${file} 不应为空`)
  }

  assert.deepEqual(readPngSize('build/icon.png'), { width: 1024, height: 1024 })
  assert.deepEqual(readPngSize('build/tray.png'), { width: 32, height: 32 })
  assert.deepEqual(readPngSize('build/trayTemplate.png'), { width: 18, height: 18 })
  assert.deepEqual(readPngSize('build/trayTemplate@2x.png'), { width: 36, height: 36 })

  assert.equal(readFileSync('build/icon.icns').subarray(0, 4).toString('ascii'), 'icns')
  assert.deepEqual([...readFileSync('build/icon.ico').subarray(0, 4)], [0, 0, 1, 0])
})

/**
 * 校验主进程加载真实托盘图标并为 macOS 启用模板图适配深浅主题。
 * @returns 无返回值。
 * @author zhenghq
 */
test('托盘应加载翻译图标而不是空白占位图', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.doesNotMatch(source, /nativeImage\.createEmpty\(\)/u)
  assert.match(source, /nativeImage\.createFromPath\(/u)
  assert.match(source, /setTemplateImage\(true\)/u)
  assert.ok(packageJson.build?.files?.includes('build/tray*.png'))
})
