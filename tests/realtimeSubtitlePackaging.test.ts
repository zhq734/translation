import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveMacosSubtitleAudioPath } from '../src/main/subtitleSession.ts'

/**
 * 读取文本文件，缺失时返回空串，便于断言给出明确失败信息。
 * @param path 文件相对路径。
 * @returns 文件文本内容。
 * @author zhenghq
 */
function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/**
 * 校验构建脚本通过 cargo 生成 arm64 与 x86_64 产物并用 lipo 合并。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕构建脚本应生成 universal Rust sidecar', () => {
  const source = readText('scripts/build-macos-subtitle-audio.mjs')
  assert.ok(source.length > 0, '缺少实时字幕 sidecar 构建脚本')
  assert.match(source, /'rustup'[\s\S]*?'run'[\s\S]*?'stable'[\s\S]*?'cargo'/u)
  assert.match(source, /--release/u)
  assert.match(source, /aarch64-apple-darwin/u)
  assert.match(source, /x86_64-apple-darwin/u)
  assert.match(source, /lipo/u)
  assert.doesNotMatch(source, /swiftc|helpers\/macos-subtitle-audio/u)
})

/**
 * 校验 package.json 接入 Rust sidecar 构建、打包资源与 macOS 14.2 最低版本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('package.json 应接入 sidecar 构建并声明 macOS 14.2 权限', () => {
  const packageJson = JSON.parse(readText('package.json')) as {
    scripts: Record<string, string>
    build: {
      mac: {
        minimumSystemVersion?: string
        extendInfo?: Record<string, string>
        extraResources: Array<{ from: string; to: string }>
      }
    }
  }
  assert.match(packageJson.scripts.dev, /build-macos-subtitle-audio/u)
  assert.match(packageJson.scripts.build, /build-macos-subtitle-audio/u)
  assert.equal(packageJson.build.mac.minimumSystemVersion, '14.2')
  assert.match(packageJson.build.mac.extendInfo?.NSMicrophoneUsageDescription ?? '', /麦克风/u)
  assert.match(packageJson.build.mac.extendInfo?.NSScreenCaptureUsageDescription ?? '', /屏幕录制/u)
  assert.equal('NSSpeechRecognitionUsageDescription' in (packageJson.build.mac.extendInfo ?? {}), false)
  assert.ok(packageJson.build.mac.extraResources.some((entry) =>
    entry.from === 'build/macos-subtitle-audio' && entry.to === 'macos-subtitle-audio'
  ))
})

/**
 * 校验打包路径优先解析 Resources 下的 sidecar 可执行文件。
 * @returns 无返回值。
 * @author zhenghq
 */
test('打包路径应优先命中 Resources/macos-subtitle-audio', () => {
  const packaged = resolveMacosSubtitleAudioPath({
    resourcesPath: '/Applications/App.app/Contents/Resources',
    cwd: '/repo',
    fileExists: (candidate) =>
      candidate === '/Applications/App.app/Contents/Resources/macos-subtitle-audio'
  })
  assert.equal(packaged, '/Applications/App.app/Contents/Resources/macos-subtitle-audio')
})

/**
 * 校验 sidecar crate 保留 Mimi 的 MIT 许可与来源声明。
 * @returns 无返回值。
 * @author zhenghq
 */
test('sidecar 应附 MIT 许可、来源声明并明确翻译在宿主完成', () => {
  const license = readText('sidecar/mimi-audio/LICENSE')
  const notice = readText('sidecar/mimi-audio/NOTICE')
  assert.match(license, /MIT License/u)
  assert.match(license, /Copyright \(c\) 2026 yuxino/u)
  assert.match(notice, /yuxino\/Mimi/u)
  assert.match(notice, /翻译由宿主应用/u)
})
