import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>
  build: {
    files: string[]
    asarUnpack: string[]
    mac: {
      extendInfo?: Record<string, unknown>
      extraResources?: Array<{ from: string; to: string }>
    }
    win: { target: Array<{ target: string; arch: string[] }> }
    linux: { target: Array<{ target: string; arch: string[] }> }
  }
}
const packagingDoc = readFileSync('docs/ocr-packaging-verification.md', 'utf8')

/**
 * 校验 OCR 模型和 native runtime 已进入 Electron 三平台打包配置。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 模型资产与 native runtime 应纳入打包并解包', () => {
  assert.ok(packageJson.build.files.includes('assets/ocr/**/*'))
  assert.ok(packageJson.build.files.includes('node_modules/onnxruntime-node/**/*'))
  assert.ok(packageJson.build.files.includes('node_modules/sharp/**/*'))
  assert.ok(
    packageJson.build.asarUnpack.includes('node_modules/@gutenye/**/*'),
    '@gutenye OCR runtime 必须与 onnxruntime native 模块位于同一解包目录'
  )
  assert.ok(packageJson.build.asarUnpack.includes('assets/ocr/**/*'))
  assert.ok(packageJson.build.asarUnpack.includes('node_modules/onnxruntime-node/**/*'))
  assert.ok(packageJson.build.asarUnpack.includes('node_modules/sharp/**/*'))
})

/**
 * 校验 macOS Vision OCR helper 会在构建时生成并复制到 Electron Resources 根目录。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS Vision OCR helper 应纳入构建和 macOS 打包资源', () => {
  assert.match(packageJson.scripts.build, /build-macos-vision-ocr\.mjs/u)
  assert.match(packageJson.scripts.dev, /build-macos-vision-ocr\.mjs/u)
  assert.ok(
    packageJson.build.mac.extraResources?.some((resource) =>
      resource.from === 'build/macos-vision-ocr' && resource.to === 'macos-vision-ocr'
    ),
    'macOS 打包应复制 macos-vision-ocr 到 Resources 根目录'
  )
})

/**
 * 校验 OCR 三平台打包验证文档覆盖路径、权限和测试门禁。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 打包验证文档应覆盖三平台路径、权限与测试结果', () => {
  assert.match(packagingDoc, /macOS/u)
  assert.match(packagingDoc, /Windows/u)
  assert.match(packagingDoc, /Linux/u)
  assert.match(packagingDoc, /app\.asar\.unpacked\/node_modules\/@gutenye\/ocr-models\/assets/u)
  assert.match(packagingDoc, /Screen Recording/u)
  assert.match(packagingDoc, /Windows\.Media\.Ocr/u)
  assert.match(packagingDoc, /npm test/u)
  assert.match(packagingDoc, /npm run build/u)
})

/**
 * 校验三平台打包脚本仍保留目标架构。
 * @returns 无返回值。
 * @author zhenghq
 */
test('三平台打包脚本应覆盖 macOS Windows Linux', () => {
  assert.match(packageJson.scripts['dist:mac'], /--mac --x64 --arm64/u)
  assert.match(packageJson.scripts['dist:win'], /--win nsis --x64 --arm64/u)
  assert.match(packageJson.scripts['dist:linux'], /--linux AppImage --x64 --arm64/u)
  assert.deepEqual(packageJson.build.win.target, [{ target: 'nsis', arch: ['x64', 'arm64'] }])
  assert.deepEqual(packageJson.build.linux.target, [{ target: 'AppImage', arch: ['x64', 'arm64'] }])
})
