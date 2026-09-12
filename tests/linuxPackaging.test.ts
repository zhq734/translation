import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

type PackageJson = {
  scripts?: Record<string, string>
  overrides?: Record<string, string>
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson
const packagingDoc = readFileSync('docs/ocr-packaging-verification.md', 'utf8')

/**
 * 校验 Linux 打包脚本使用 electron-builder 的 AppImage 目标生成 x64/arm64 安装包。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux 打包脚本应生成 x64 与 arm64 AppImage', () => {
  assert.equal(
    packageJson.scripts?.['dist:linux'],
    'npm run build && node scripts/prepare-linux-ocr-runtime.mjs && electron-builder --linux AppImage --x64 --arm64 --publish never'
  )
})

/**
 * 校验 Linux 打包会预取并验证 x64/arm64 的 sharp 与 libvips 运行时，避免交叉打包
 * 把构建机的原生依赖带入 AppImage 后导致 PaddleOCR 初始化失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux 打包前应准备并校验双架构 sharp 运行时', () => {
  assert.equal(existsSync('scripts/prepare-linux-ocr-runtime.mjs'), true)
  assert.equal(packageJson.overrides?.sharp, '0.34.2')

  const prepareScript = readFileSync('scripts/prepare-linux-ocr-runtime.mjs', 'utf8')
  assert.match(prepareScript, /'x64', 'arm64'/u)
  assert.match(prepareScript, /sharp-linux-\$\{arch\}\.node/u)
  assert.match(prepareScript, /sharp-libvips-linux-\$\{arch\}/u)
  assert.match(prepareScript, /libvips-cpp\.so\.8\.16\.1/u)
  assert.match(packagingDoc, /Linux 双架构 sharp 运行时/u)
})
