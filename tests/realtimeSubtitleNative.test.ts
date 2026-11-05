import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 读取仓库内文本文件。
 * @param path 相对仓库根目录的路径。
 * @returns 文件文本。
 * @author zhenghq
 */
function read(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * 校验 Rust sidecar 使用 Core Audio Process Tap、cpal 与屏幕录制权限预检。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Rust sidecar 应实现系统音频、麦克风采集与权限预检', () => {
  const audio = read('sidecar/mimi-audio/src/audio.rs')
  const tap = read('sidecar/mimi-audio/src/audio/macos_tap.rs')
  const microphone = read('sidecar/mimi-audio/src/audio/microphone.rs')
  const main = read('sidecar/mimi-audio/src/main.rs')
  const cargo = read('sidecar/mimi-audio/Cargo.toml')
  assert.match(audio, /Core Audio[\s\S]*?Process Tap/u)
  assert.match(audio, /cpal/u)
  assert.match(audio, /check_permission/u)
  assert.match(tap, /AudioHardwareCreateProcessTap/u)
  assert.match(tap, /preflight_screen_capture_access/u)
  assert.match(tap, /request_screen_capture_access/u)
  assert.match(tap, /initMonoGlobalTapButExcludeProcesses/u)
  assert.match(microphone, /default_input_device/u)
  assert.match(main, /tokio::io::stdin/u)
  assert.match(main, /serde_json::from_str/u)
  assert.match(cargo, /rustls[\s\S]*?features = \["ring"\]/u)
  assert.match(main, /install_default/u)
})

/**
 * 校验构建脚本生成 universal sidecar，并接入打包资源与权限声明。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕 Rust sidecar 应接入 universal 构建与 macOS 打包', () => {
  const scriptPath = 'scripts/build-macos-subtitle-audio.mjs'
  assert.equal(existsSync(scriptPath), true)
  const script = read(scriptPath)
  assert.match(script, /aarch64-apple-darwin/u)
  assert.match(script, /x86_64-apple-darwin/u)
  assert.match(script, /lipo/u)
  assert.match(script, /macos-subtitle-audio/u)

  const packageJson = JSON.parse(read('package.json')) as {
    scripts?: Record<string, string>
    build?: { mac?: { extraResources?: Array<{ from?: string; to?: string }>; extendInfo?: Record<string, string> } }
  }
  assert.match(packageJson.scripts?.['dev'] ?? '', /build-macos-subtitle-audio\.mjs/u)
  assert.match(packageJson.scripts?.['build'] ?? '', /build-macos-subtitle-audio\.mjs/u)
  assert.ok(packageJson.build?.mac?.extraResources?.some((entry) =>
    entry.from === 'build/macos-subtitle-audio' && entry.to === 'macos-subtitle-audio'
  ))
  assert.match(packageJson.build?.mac?.extendInfo?.NSScreenCaptureUsageDescription ?? '', /\S/u)
  assert.equal(packageJson.build?.mac?.extendInfo?.NSSpeechRecognitionUsageDescription, undefined)
  assert.match(packageJson.build?.mac?.extendInfo?.NSMicrophoneUsageDescription ?? '', /\S/u)

  const entitlements = read('scripts/entitlements.mac.plist')
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/u)
})

/**
 * 校验开发模式为 Electron 补充屏幕录制与麦克风用途说明，避免 TCC 拒绝授权。
 * @returns 无返回值。
 * @author zhenghq
 */
test('开发模式应准备带屏幕录制与麦克风用途说明的 Electron 元数据', () => {
  const scriptPath = 'scripts/prepare-dev-electron-plist.mjs'
  assert.equal(existsSync(scriptPath), true)
  const script = read(scriptPath)
  assert.doesNotMatch(script, /NSSpeechRecognitionUsageDescription/u)
  assert.match(script, /NSScreenCaptureUsageDescription/u)
  assert.match(script, /NSMicrophoneUsageDescription/u)
  assert.match(script, /Info\.plist/u)
  assert.match(script, /codesign/u)
  assert.match(script, /--force/u)
  assert.match(script, /--deep/u)
  assert.match(script, /--sign/u)
  assert.match(script, /electronAppPath/u)

  const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
  assert.match(packageJson.scripts?.['dev'] ?? '', /prepare-dev-electron-plist\.mjs/u)
})

/**
 * 校验 macOS 构建使用 Rust sidecar，而不是 Swift Speech 辅助进程。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 实时字幕构建应编译 Rust sidecar 并合并 universal 产物', () => {
  const script = read('scripts/build-macos-subtitle-audio.mjs')
  assert.match(script, /sidecar\/mimi-audio\/Cargo\.toml/u)
  assert.match(script, /cargo/u)
  assert.match(script, /--target/u)
  assert.match(script, /aarch64-apple-darwin/u)
  assert.match(script, /x86_64-apple-darwin/u)
  assert.match(script, /lipo/u)
  assert.doesNotMatch(script, /swiftc|helpers\/macos-subtitle-audio/u)
})

/**
 * 校验 Rust sidecar 首版只实现 Deepgram，并保留稳定 final 的归并边界。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Rust sidecar 应实现 Deepgram ASR 且不在 sidecar 内翻译', () => {
  const protocol = read('sidecar/mimi-audio/src/protocol.rs')
  const asr = read('sidecar/mimi-audio/src/asr.rs')
  const notice = read('sidecar/mimi-audio/NOTICE')
  assert.match(protocol, /Deepgram/u)
  assert.match(asr, /wss:\/\/api\.deepgram\.com\/v1\/listen/u)
  assert.match(asr, /DEEPGRAM_API_KEY/u)
  assert.match(asr, /language=multi/u)
  assert.doesNotMatch(asr, /push_str\("&detect_language=/u)
  assert.match(asr, /speech_final/u)
  assert.match(asr, /utterance_end_ms/u)
  assert.match(asr, /encoding=linear16/u)
  assert.match(asr, /sample_rate=24000/u)
  assert.doesNotMatch(asr, /itranslate|translation/iu)
  assert.match(notice, /翻译由宿主应用/u)
})

/**
 * 校验 stdin 快速关闭时 sidecar 仍会先处理 start 命令并输出可诊断事件，不会静默退出。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕 sidecar 应处理快速 start/stop 输入', () => {
  if (process.platform !== 'darwin' || !existsSync('build/macos-subtitle-audio')) return
  const result = spawnSync('build/macos-subtitle-audio', [], {
    input: [
      '{"cmd":"start","source":"system","asr":"deepgram","lang":"zh-CN"}',
      '{"cmd":"stop"}',
      ''
    ].join('\n'),
    encoding: 'utf8',
    timeout: 10_000
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /"type":"(?:status|error|ready)"/u)
  assert.doesNotMatch(result.stdout, /invalid control command/u)
})

/**
 * 校验启动中的采集器在会话被停止后仍会被释放，且快速重启不会串用旧会话状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Rust sidecar 应串行处理 stop/start 并释放旧采集资源', () => {
  const session = read('sidecar/mimi-audio/src/session.rs')
  assert.match(session, /async fn start[\s\S]*?self\.stop\(\)\.await/u)
  assert.match(session, /pub async fn stop[\s\S]*?capture\.stop\(\)/u)
  assert.match(session, /task\.abort\(\)/u)
})

/**
 * 校验自动语言流式识别使用 Deepgram 多语言模型，而不是仅支持预录音频的语言检测参数。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Deepgram 自动语言应使用流式 language=multi', () => {
  const asr = read('sidecar/mimi-audio/src/asr.rs')
  assert.match(asr, /fn deepgram_url[\s\S]*?language=multi/u)
  assert.doesNotMatch(asr, /push_str\("&detect_language=/u)
  assert.match(asr, /detected_language|"languages"/u)
})

/**
 * 校验 sidecar 只有在 Deepgram WebSocket 握手成功后才发送 ready。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Deepgram 握手应先于 ready 与音频采集', () => {
  const asr = read('sidecar/mimi-audio/src/asr.rs')
  const session = read('sidecar/mimi-audio/src/session.rs')
  assert.match(asr, /connect_async\(request\)\.await/u)
  assert.match(asr, /Result<Self, AsrError>/u)
  assert.match(session, /AsrClient::connect\(asr, &lang\)\.await[\s\S]*?AudioCapture::start/u)
  assert.match(session, /AudioCapture::start[\s\S]*?Event::Ready/u)
})

/**
 * 校验 Rust sidecar 支持 WebSocket ASR 协议、16 kHz 重采样与结束帧。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Rust sidecar 应支持 WebSocket ASR 流式协议', () => {
  const protocol = read('sidecar/mimi-audio/src/protocol.rs')
  const asr = read('sidecar/mimi-audio/src/asr.rs')
  const audio = read('sidecar/mimi-audio/src/audio.rs')

  assert.match(protocol, /WebSocket/u)
  assert.match(protocol, /rename\s*=\s*"websocket"/u)
  assert.match(asr, /WEBSOCKET_ASR_URL/u)
  assert.match(asr, /ws:\/\/127\.0\.0\.1:9092\/ws\/asr/u)
  assert.match(asr, /StreamingPcm16Resampler::new\(24_000,\s*16_000,\s*1\)/u)
  assert.match(asr, /"type":"end"/u)
  assert.match(asr, /value\["text"\]/u)
  assert.doesNotMatch(asr, /value\["full"\]/u)
  assert.match(audio, /mod streaming_resampler;/u)
})
