import AVFoundation
import AudioToolbox
import CoreGraphics
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit
import Speech

/// sidecar 支持的音频来源。
enum AudioSource: String, Codable {
  case system
  case microphone
  case both
}

/// sidecar 支持的会话状态。
enum SessionState: String, Codable {
  case idle
  case starting
  case running
  case paused
  case stopping
}

/// 主进程下发的控制命令。
struct ControlCommand: Decodable {
  let type: String
  let source: AudioSource?
  let language: String?
}

/// 单行 JSON 输出器。stdout 只承载协议事件，诊断信息一律写入 stderr。
enum ProtocolOutput {
  private static let lock = NSLock()

  /// 输出一条 JSON Lines 事件并立即 flush。
  /// - Parameter payload: 可 JSON 序列化的字典。
  static func send(_ payload: [String: Any]) {
    lock.lock()
    defer { lock.unlock() }
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else {
      return
    }
    line.append("\n")
    FileHandle.standardOutput.write(Data(line.utf8))
  }

  /// 输出结构化错误。
  /// - Parameters:
  ///   - code: 稳定错误分类。
  ///   - message: 面向用户的说明。
  static func error(_ code: String, _ message: String) {
    send(["type": "error", "code": code, "message": message])
  }
}

/// 线程安全地汇集系统音频与麦克风 PCM，并以 16 kHz 单声道交给 Speech。
final class AudioMixer {
  private let queue = DispatchQueue(label: "subtitle.audio.mixer")
  private var systemSamples: [Float] = []
  private var microphoneSamples: [Float] = []
  private var enabledSources: Set<AudioSource> = []
  private var onSamples: (([Float]) -> Void)?
  private var lastLevelAt = Date.distantPast

  /// 更新本次会话启用的音频来源。
  /// - Parameter sources: 已启用的来源集合。
  func configure(sources: Set<AudioSource>) {
    queue.sync {
      enabledSources = sources
      systemSamples.removeAll(keepingCapacity: true)
      microphoneSamples.removeAll(keepingCapacity: true)
    }
  }

  /// 注册统一采样回调。
  /// - Parameter handler: 接收交错后的 16 kHz 单声道采样。
  func setSampleHandler(_ handler: @escaping ([Float]) -> Void) {
    queue.sync { onSamples = handler }
  }

  /// 追加一路已重采样到 16 kHz 单声道的音频。
  /// - Parameters:
  ///   - samples: 单声道采样。
  ///   - source: 音频来源。
  func append(_ samples: [Float], source: AudioSource) {
    guard !samples.isEmpty else { return }
    queue.async {
      guard self.enabledSources.contains(source) else { return }
      if source == .microphone {
        self.microphoneSamples.append(contentsOf: samples)
      } else {
        self.systemSamples.append(contentsOf: samples)
      }
      self.flushAlignedSamples()
    }
  }

  /// 清空未输出的尾部采样，避免暂停后把旧音频拼到新会话。
  func reset() {
    queue.sync {
      systemSamples.removeAll(keepingCapacity: true)
      microphoneSamples.removeAll(keepingCapacity: true)
    }
  }

  /// 当两路都启用时按时间轴逐样本混音，单路时直接输出。
  private func flushAlignedSamples() {
    let hasSystem = enabledSources.contains(.system)
    let hasMicrophone = enabledSources.contains(.microphone)
    if hasSystem && hasMicrophone {
      let count = min(systemSamples.count, microphoneSamples.count)
      guard count > 0 else { return }
      var mixed = [Float](repeating: 0, count: count)
      for index in 0..<count {
        mixed[index] = max(-1, min(1, (systemSamples[index] + microphoneSamples[index]) * 0.5))
      }
      systemSamples.removeFirst(count)
      microphoneSamples.removeFirst(count)
      emit(mixed)
      return
    }

    if hasSystem && !systemSamples.isEmpty {
      let output = systemSamples
      systemSamples.removeAll(keepingCapacity: true)
      emit(output)
    }
    if hasMicrophone && !microphoneSamples.isEmpty {
      let output = microphoneSamples
      microphoneSamples.removeAll(keepingCapacity: true)
      emit(output)
    }
  }

  /// 发出采样并限频报告音量。
  /// - Parameter samples: 待识别采样。
  private func emit(_ samples: [Float]) {
    onSamples?(samples)
    let now = Date()
    guard now.timeIntervalSince(lastLevelAt) >= 0.1 else { return }
    lastLevelAt = now
    var sum: Float = 0
    for sample in samples { sum += sample * sample }
    let rms = sqrt(sum / Float(samples.count))
    ProtocolOutput.send(["type": "level", "rms": min(1, max(0, rms * 4))])
  }
}

/// 将任意 PCM 缓冲转换为 16 kHz 单声道 Float 采样。
final class AudioResampler {
  private var converter: AVAudioConverter?
  private let outputFormat: AVAudioFormat

  /// 创建目标格式固定的重采样器。
  init() {
    outputFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 16_000,
      channels: 1,
      interleaved: false
    )!
  }

  /// 将输入缓冲转换为目标格式。
  /// - Parameter buffer: 系统音频或麦克风音频缓冲。
  /// - Returns: 单声道 Float 采样；格式不合法时返回空数组。
  func convert(_ buffer: AVAudioPCMBuffer) -> [Float] {
    if buffer.format.sampleRate == outputFormat.sampleRate,
       buffer.format.channelCount == 1,
       buffer.format.commonFormat == .pcmFormatFloat32 {
      guard let channel = buffer.floatChannelData?[0] else { return [] }
      return Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
    }

    if converter == nil || converter?.inputFormat != buffer.format {
      converter = AVAudioConverter(from: buffer.format, to: outputFormat)
    }
    guard let converter else { return [] }
    let ratio = outputFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(max(1, ceil(Double(buffer.frameLength) * ratio)))
    guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
      return []
    }
    var supplied = false
    var error: NSError?
    converter.convert(to: output, error: &error) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, let channel = output.floatChannelData?[0] else { return [] }
    return Array(UnsafeBufferPointer(start: channel, count: Int(output.frameLength)))
  }
}

/// 管理端侧语音识别任务，并在静音达到阈值时提交 final。
final class SpeechRecognizer: NSObject, SFSpeechRecognizerDelegate {
  private let audioMixer: AudioMixer
  private let recognizer: SFSpeechRecognizer
  private let audioFormat: AVAudioFormat
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var latestTranscript = ""
  private var lastVoiceAt = Date()
  private var silenceTimer: DispatchSourceTimer?
  private var paused = false
  private var active = false

  /// 创建固定语言与端侧模式的识别器。
  /// - Parameters:
  ///   - language: BCP-47 语言标识；auto 时使用系统语言。
  ///   - audioMixer: 统一采样来源。
  init(language: String, audioMixer: AudioMixer) {
    let requested = language == "auto"
      ? Locale.preferredLanguages.first ?? Locale.current.identifier
      : language
    recognizer = SFSpeechRecognizer(locale: Locale(identifier: requested))
      ?? SFSpeechRecognizer(locale: Locale.current)!
    self.audioMixer = audioMixer
    audioFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 16_000,
      channels: 1,
      interleaved: false
    )!
    super.init()
    recognizer.delegate = self
  }

  /// 判断当前识别器是否可用。
  var isAvailable: Bool { recognizer.isAvailable }

  /// 开始新的识别请求并建立静音检测。
  func start() {
    active = true
    paused = false
    latestTranscript = ""
    lastVoiceAt = Date()
    beginRecognitionRequest()
    startSilenceTimer()
  }

  /// 暂停识别但保留采集状态。
  func pause() {
    paused = true
    endCurrentRequest(commit: true)
  }

  /// 恢复识别并重建请求。
  func resume() {
    paused = false
    latestTranscript = ""
    lastVoiceAt = Date()
    beginRecognitionRequest()
    startSilenceTimer()
  }

  /// 停止识别并释放全部 Speech 资源。
  func stop() {
    active = false
    paused = true
    silenceTimer?.cancel()
    silenceTimer = nil
    endCurrentRequest(commit: true)
    audioMixer.setSampleHandler { _ in }
  }

  /// 创建识别请求并绑定音频回调。
  private func beginRecognitionRequest() {
    endCurrentRequest(commit: false)
    guard active, !paused else { return }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    request.taskHint = .dictation
    self.request = request
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      guard let self else { return }
      guard self.active, !self.paused else { return }
      if let result {
        let text = result.bestTranscription.formattedString
          .trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
          self.latestTranscript = text
          self.lastVoiceAt = Date()
          ProtocolOutput.send([
            "type": result.isFinal ? "final" : "partial",
            "text": text,
            "lang": self.recognizer.locale.identifier
          ])
          if result.isFinal { self.resetAfterFinal() }
        }
      }
      if error != nil, !self.paused {
        self.resetAfterFinal()
      }
    }
    audioMixer.setSampleHandler { [weak self] samples in
      guard let self, self.active, !self.paused,
            let request = self.request, !samples.isEmpty else { return }
      guard let buffer = AVAudioPCMBuffer(
        pcmFormat: self.audioFormat,
        frameCapacity: AVAudioFrameCount(samples.count)
      ) else { return }
      buffer.frameLength = AVAudioFrameCount(samples.count)
      if let channel = buffer.floatChannelData?[0] {
        samples.withUnsafeBufferPointer { pointer in
          if let base = pointer.baseAddress {
            channel.update(from: base, count: samples.count)
          }
        }
      }
      request.append(buffer)
    }
  }

  /// 启动静音切段定时器。
  private func startSilenceTimer() {
    silenceTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "subtitle.silence"))
    timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
    timer.setEventHandler { [weak self] in
      guard let self, !self.paused, !self.latestTranscript.isEmpty,
            Date().timeIntervalSince(self.lastVoiceAt) >= 1.2 else { return }
      self.commitFinalAndRestart()
    }
    timer.resume()
    silenceTimer = timer
  }

  /// 静音时提交当前文本并重建识别请求。
  private func commitFinalAndRestart() {
    let text = latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty {
      ProtocolOutput.send([
        "type": "final",
        "text": text,
        "lang": recognizer.locale.identifier
      ])
    }
    latestTranscript = ""
    lastVoiceAt = Date()
    beginRecognitionRequest()
  }

  /// 收到系统 final 后重建请求，继续识别下一段。
  private func resetAfterFinal() {
    latestTranscript = ""
    lastVoiceAt = Date()
    beginRecognitionRequest()
  }

  /// 结束当前请求并按需提交尾部文本。
  /// - Parameter commit: 是否输出尚未 final 的文本。
  private func endCurrentRequest(commit: Bool) {
    if commit {
      let text = latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty {
        ProtocolOutput.send([
          "type": "final",
          "text": text,
          "lang": recognizer.locale.identifier
        ])
      }
    }
    latestTranscript = ""
    request?.endAudio()
    task?.cancel()
    request = nil
    task = nil
  }
}

/// 采集 ScreenCaptureKit 系统音频。
final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
  private let mixer: AudioMixer
  private let resampler = AudioResampler()
  private var stream: SCStream?
  private var cancelled = false
  private let sampleQueue = DispatchQueue(label: "subtitle.system.audio")

  /// 创建系统音频采集器。
  /// - Parameter mixer: 统一混音器。
  init(mixer: AudioMixer) {
    self.mixer = mixer
  }

  /// 启动默认显示器与全部音频的采集。
  /// - Throws: 权限、设备或 SCStream 启动错误。
  func start() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(
      false,
      onScreenWindowsOnly: true
    )
    guard !cancelled else { return }
    guard let display = content.displays.first else {
      throw NSError(domain: "subtitle", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "No display is available for system audio capture"
      ])
    }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.excludesCurrentProcessAudio = true
    configuration.sampleRate = 16_000
    configuration.channelCount = 1
    configuration.width = 2
    configuration.height = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
    try await stream.startCapture()
    guard !cancelled else {
      try? await stream.stopCapture()
      return
    }
    self.stream = stream
  }

  /// 停止系统音频采集并释放 SCStream。
  func stop() async {
    cancelled = true
    if let stream {
      self.stream = nil
      try? await stream.stopCapture()
    }
  }

  /// 处理 ScreenCaptureKit 音频样本。
  /// - Parameters:
  ///   - stream: 音频来源流。
  ///   - sampleBuffer: CMSampleBuffer。
  ///   - outputType: 输出类型。
  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
    guard outputType == SCStreamOutputType.audio, sampleBuffer.isValid else { return }
    guard let formatDescription = sampleBuffer.formatDescription,
          let asbd = formatDescription.audioStreamBasicDescription else { return }
    let format = withUnsafePointer(to: asbd) {
      AVAudioFormat(streamDescription: $0)
    }
    guard let format else { return }
    let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
    guard frameCount > 0,
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount)) else {
      return
    }
    buffer.frameLength = AVAudioFrameCount(frameCount)
    guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
    let byteCount = CMBlockBufferGetDataLength(blockBuffer)
    guard let destination = buffer.audioBufferList.pointee.mBuffers.mData else { return }
    let status = CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: byteCount, destination: destination)
    guard status == kCMBlockBufferNoErr else { return }
    mixer.append(resampler.convert(buffer), source: .system)
  }

  /// 处理 SCStream 运行错误。
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    ProtocolOutput.error("device-unavailable", error.localizedDescription)
  }
}

/// 采集默认麦克风。
final class MicrophoneCapture {
  private let mixer: AudioMixer
  private let engine = AVAudioEngine()
  private let resampler = AudioResampler()
  private var running = false

  /// 创建麦克风采集器。
  /// - Parameter mixer: 统一混音器。
  init(mixer: AudioMixer) {
    self.mixer = mixer
  }

  /// 启动麦克风 tap 并转发重采样后的音频。
  /// - Throws: 音频引擎启动错误。
  func start() throws {
    guard !running else { return }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.channelCount > 0, format.sampleRate > 0 else {
      throw NSError(domain: "subtitle", code: 2, userInfo: [
        NSLocalizedDescriptionKey: "No microphone input is available"
      ])
    }
    input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, _ in
      guard let self else { return }
      self.mixer.append(self.resampler.convert(buffer), source: .microphone)
    }
    engine.prepare()
    try engine.start()
    running = true
  }

  /// 停止麦克风并移除 tap。
  func stop() {
    guard running else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    running = false
  }
}

/// 校验并请求系统音频、Speech 与麦克风权限。
enum Permissions {
  /// 请求屏幕录制权限，并在首次授权后等待 TCC 状态刷新。
  /// - Returns: 是否已获授权。
  static func screenCapture() async -> Bool {
    if CGPreflightScreenCaptureAccess() { return true }
    guard CGRequestScreenCaptureAccess() else {
      // 首次弹出系统授权面板时，请求接口可能先返回 false；短暂轮询可避免
      // 用户完成授权后 sidecar 仍被错误地立即终止。
      for _ in 0..<60 {
        try? await Task.sleep(nanoseconds: 500_000_000)
        if CGPreflightScreenCaptureAccess() { return true }
      }
      return false
    }
    return true
  }

  /// 请求 Speech 识别权限。
  /// - Returns: 是否已获授权。
  static func speech() async -> Bool {
    await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: status == .authorized)
      }
    }
  }

  /// 请求麦克风权限。
  /// - Returns: 是否已获授权。
  static func microphone() async -> Bool {
    await withCheckedContinuation { continuation in
      AVCaptureDevice.requestAccess(for: .audio) { granted in
        continuation.resume(returning: granted)
      }
    }
  }
}

/// 协调控制协议、权限、采集器与识别器。
final class SubtitleService {
  private let mixer = AudioMixer()
  private var systemCapture: SystemAudioCapture?
  private var microphoneCapture: MicrophoneCapture?
  private var recognizer: SpeechRecognizer?
  private var source: AudioSource = .system
  private var running = false
  private var generation = 0

  /// 启动一次新的字幕会话。
  /// - Parameters:
  ///   - source: 音频来源。
  ///   - language: 识别语言。
  func start(source: AudioSource, language: String) {
    stopInternal()
    generation += 1
    let currentGeneration = generation
    self.source = source
    running = true
    ProtocolOutput.send(["type": "status", "state": "starting"])
    Task { await self.startAsync(language: language, generation: currentGeneration) }
  }

  /// 异步完成权限与采集启动，并丢弃已被停止或重启的旧会话结果。
  /// - Parameters:
  ///   - language: 识别语言。
  ///   - generation: 启动任务所属会话代次。
  private func startAsync(language: String, generation: Int) async {
    let needsSystem = source == .system || source == .both
    let needsMicrophone = source == .microphone || source == .both
    guard isCurrent(generation) else { return }
    guard await Permissions.screenCapture() || !needsSystem else {
      fail("permission-denied", "Screen Recording permission is required")
      return
    }
    guard isCurrent(generation) else { return }
    guard await Permissions.speech() else {
      fail("permission-denied", "Speech Recognition permission is required")
      return
    }
    guard isCurrent(generation) else { return }
    if needsMicrophone, !(await Permissions.microphone()) {
      fail("permission-denied", "Microphone permission is required")
      return
    }
    guard isCurrent(generation) else { return }

    let mixerSources: Set<AudioSource> = source == .both
      ? [.system, .microphone]
      : [source]
    mixer.configure(sources: mixerSources)
    let speech = SpeechRecognizer(language: language, audioMixer: mixer)
    guard speech.isAvailable else {
      fail("device-unavailable", "Speech recognition is unavailable for the selected language")
      return
    }
    recognizer = speech
    var startedSystemCapture: SystemAudioCapture?
    defer {
      if !isCurrent(generation) {
        if let startedSystemCapture {
          Task { await startedSystemCapture.stop() }
        }
        if self.systemCapture === startedSystemCapture {
          self.systemCapture = nil
        }
      }
    }

    do {
      if needsSystem {
        let capture = SystemAudioCapture(mixer: mixer)
        systemCapture = capture
        try await capture.start()
        startedSystemCapture = capture
        guard isCurrent(generation) else { return }
      }
      if needsMicrophone {
        let capture = MicrophoneCapture(mixer: mixer)
        try capture.start()
        microphoneCapture = capture
      }
      guard isCurrent(generation) else { return }
      speech.start()
      ProtocolOutput.send(["type": "ready", "source": source.rawValue])
      ProtocolOutput.send(["type": "status", "state": "running"])
    } catch {
      guard isCurrent(generation) else { return }
      fail("device-unavailable", error.localizedDescription)
    }
  }

  /// 暂停采集与识别。
  func pause() {
    guard running else { return }
    mixer.reset()
    recognizer?.pause()
    ProtocolOutput.send(["type": "status", "state": "paused"])
  }

  /// 恢复采集与识别。
  func resume() {
    guard running else { return }
    mixer.reset()
    recognizer?.resume()
    ProtocolOutput.send(["type": "status", "state": "running"])
  }

  /// 停止会话并释放全部资源。
  func stop() {
    stopInternal()
    ProtocolOutput.send(["type": "status", "state": "idle"])
  }

  /// 判断异步任务是否仍属于当前活动会话。
  /// - Parameter generation: 异步任务启动时的会话代次。
  /// - Returns: 会话仍活动且代次未变化时返回 true。
  private func isCurrent(_ generation: Int) -> Bool {
    running && self.generation == generation
  }

  /// 停止采集器与识别器，并使所有在途异步启动任务失效。
  private func stopInternal() {
    running = false
    generation += 1
    recognizer?.stop()
    recognizer = nil
    microphoneCapture?.stop()
    microphoneCapture = nil
    if let systemCapture {
      Task { await systemCapture.stop() }
    }
    systemCapture = nil
    mixer.reset()
  }

  /// 输出错误、停止资源并回到空闲状态。
  /// - Parameters:
  ///   - code: 稳定错误分类。
  ///   - message: 错误说明。
  private func fail(_ code: String, _ message: String) {
    stopInternal()
    ProtocolOutput.error(code, message)
    ProtocolOutput.send(["type": "status", "state": "idle"])
  }
}

/// 从 stdin（STDIN_FILENO）逐行读取控制命令。
func readCommands(service: SubtitleService) {
  while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty,
          let data = line.data(using: .utf8),
          let command = try? JSONDecoder().decode(ControlCommand.self, from: data) else {
      continue
    }
    switch command.type {
    case "start":
      service.start(source: command.source ?? .system, language: command.language ?? "auto")
    case "pause":
      service.pause()
    case "resume":
      service.resume()
    case "stop":
      service.stop()
    default:
      break
    }
  }
}

/// sidecar 入口。
func main() {
  setvbuf(stdout, nil, _IONBF, 0)
  let service = SubtitleService()
  signal(SIGTERM, SIG_IGN)
  signal(SIGINT, SIG_IGN)
  let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  termSource.setEventHandler {
    service.stop()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) }
  }
  termSource.resume()
  readCommands(service: service)
  exit(0)
}

main()
