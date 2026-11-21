//! Windows WASAPI loopback 系统声音采集（默认渲染设备回环）。
//!
//! 本模块为本项目原创实现（MIT License，@author zhenghq），未移植任何上游
//! 版权代码。采集线程独占全部 COM/WASAPI 资源：MTA 初始化 → 默认渲染端点
//! → 共享模式 loopback 采集客户端 → 轮询读包。设备混音格式只接受 32 位浮点
//! 或 16 位整型交错 PCM，降混与重采样统一交给 [`StreamingPcm16Resampler`]，
//! 最终输出 24 kHz 单声道 PCM16。
//!
//! 使用轮询而非事件驱动：WASAPI loopback 在端点完全静音时不触发事件句柄，
//! 轮询可避免静音期间的采集停滞，也省去额外的事件内核对象。

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use windows::core::GUID;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

use super::pcm::decode_i16;
use super::streaming_resampler::StreamingPcm16Resampler;
use super::CaptureError;

/// 目标采样率：实时字幕识别使用 24 kHz PCM16。
const TARGET_SAMPLE_RATE_HZ: u32 = 24_000;
/// 工作线程轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(5);
/// 启动握手最长等待时间。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// loopback 缓冲时长：约 1 秒，单位 100 纳秒（REFERENCE_TIME）。
const LOOPBACK_BUFFER_DURATION: i64 = 10_000_000;
/// 单个 WASAPI 数据包允许的最大字节数，防御异常大的包。
const MAX_PACKET_BYTES: usize = 512 * 1024;
/// 连续轮询/读包失败的最大容忍次数，约 250ms；超过后判定设备不可用。
const MAX_CONSECUTIVE_POLL_FAILURES: u32 = 50;

/// WAVE_FORMAT_IEEE_FLOAT 格式标签（mmreg.h），windows 0.62 未导出该常量。
const WAVE_FORMAT_TAG_IEEE_FLOAT: u16 = 3;
/// WAVE_FORMAT_PCM 格式标签。
const WAVE_FORMAT_TAG_PCM: u16 = 1;
/// WAVE_FORMAT_EXTENSIBLE 格式标签。
const WAVE_FORMAT_TAG_EXTENSIBLE: u16 = 0xFFFE;
/// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT 子格式 GUID（ksmedia.h），
/// windows 0.62 未在 `Win32::Media::Audio` 下导出，直接按 GUID 数值构造。
const SUBTYPE_IEEE_FLOAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00AA00389B71);

/// 启动 Windows 系统声音 loopback 采集线程。
///
/// 线程内完成 COM/WASAPI 初始化并通过握手通道回报结果；初始化失败时
/// `start` 同步返回分类错误，运行期间设备故障由 `errors` 通道异步上报。
///
/// # 参数
/// - `sink`：PCM16 单声道采样输出通道。
/// - `paused`：暂停标志，为真时丢弃音频。
/// - `running`：运行标志，为假时线程退出并释放 COM/WASAPI 资源。
/// - `errors`：运行期间设备故障的错误发送端。
///
/// # 返回值
/// 启动成功返回采集线程句柄，否则返回分类错误。
///
/// @author zhenghq
pub fn start(
    sink: tokio::sync::mpsc::Sender<Vec<i16>>,
    paused: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    errors: tokio::sync::mpsc::UnboundedSender<CaptureError>,
) -> Result<std::thread::JoinHandle<()>, CaptureError> {
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<(), CaptureError>>(1);
    let handle = std::thread::Builder::new()
        .name("mimi-system-audio-tap".into())
        .spawn(move || {
            // COM 守卫先创建、最后释放，保证所有 COM 接口都在 apartment 存续期内。
            let _com_guard = ComGuard::new();
            let mut session = match open_loopback_session() {
                Ok(session) => session,
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            let mut resampler = match StreamingPcm16Resampler::new(
                session.format.sample_rate_hz,
                TARGET_SAMPLE_RATE_HZ,
                session.format.channels,
            ) {
                Ok(resampler) => resampler,
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            if let Err(error) = unsafe { session.audio_client.Start() } {
                tracing::warn!(?error, "system audio start failed");
                let _ = ready_tx.send(Err(CaptureError::DeviceUnavailable));
                return;
            }
            session.started = true;
            if ready_tx.send(Ok(())).is_err() {
                // 上层已放弃握手（超时），直接退出并释放全部 WASAPI 资源。
                return;
            }
            run_capture_loop(&sink, &paused, &running, &errors, &session, &mut resampler);
            // session 先释放（Stop + 接口引用），随后 com_guard 平衡 COM 初始化。
        })
        .map_err(|_| CaptureError::DeviceUnavailable)?;
    ready_rx
        .recv_timeout(HANDSHAKE_TIMEOUT)
        .map_err(|_| CaptureError::DeviceUnavailable)??;
    Ok(handle)
}

/// 判断当前系统是否可以进行 loopback 采集（默认渲染端点可解析）。
///
/// 查询在当前线程临时初始化 COM，结束后立即平衡释放；仅做无副作用的
/// 端点探测，不创建采集流。
///
/// # 返回值
/// 默认渲染端点可解析时返回 `true`。
///
/// @author zhenghq
pub fn is_available() -> bool {
    let _com_guard = ComGuard::new();
    default_render_endpoint_exists()
}

/// COM 初始化守卫。
///
/// 成功初始化时记录状态，析构时调用 `CoUninitialize` 平衡；失败时保持
/// 未初始化状态，让后续的 COM 调用自然失败并走统一错误分类。
struct ComGuard {
    /// 是否在当前线程成功初始化了 COM。
    initialized: bool,
}

impl ComGuard {
    /// 在当前线程初始化 MTA COM。
    ///
    /// # 返回值
    /// 守卫实例；初始化结果记录在 `initialized` 字段中。
    ///
    /// @author zhenghq
    fn new() -> Self {
        // SAFETY: CoInitializeEx 是 COM 标准初始化入口，参数均为文档化取值。
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_err() {
            tracing::warn!("system audio COM initialize failed");
        }
        Self {
            initialized: hr.is_ok(),
        }
    }
}

impl Drop for ComGuard {
    /// 平衡释放线程级 COM 初始化。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    fn drop(&mut self) {
        if self.initialized {
            // SAFETY: 与 new 中成功的 CoInitializeEx 一一对应。
            unsafe { CoUninitialize() };
        }
    }
}

/// 一次成功初始化的 loopback 采集会话。
struct LoopbackSession {
    /// WASAPI 客户端，负责 Start/Stop 并持有设备流引用。
    audio_client: IAudioClient,
    /// WASAPI 采集客户端，用于读取回环数据包。
    capture_client: IAudioCaptureClient,
    /// 归一化后的设备混音格式。
    format: MixFormat,
    /// 流是否已成功 Start；未启动的流在 Drop 时无需 Stop。
    started: bool,
}

impl Drop for LoopbackSession {
    /// 停止 WASAPI 流；接口引用随结构体释放，最终断开 loopback。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    fn drop(&mut self) {
        if !self.started {
            return;
        }
        // SAFETY: Stop 只在成功启动后的会话上调用。
        unsafe {
            if let Err(error) = self.audio_client.Stop() {
                tracing::warn!(?error, "system audio stop failed");
            }
        }
    }
}

/// 归一化后的设备混音格式。
struct MixFormat {
    /// 设备采样率（通常 44.1k/48k）。
    sample_rate_hz: u32,
    /// 声道数。
    channels: usize,
    /// 每帧字节数。
    bytes_per_frame: usize,
    /// 是否为 32 位浮点采样；否则为 16 位整型。
    is_float: bool,
}

/// 打开默认渲染设备的 loopback 采集会话。
///
/// 完成 COM 对象创建、混音格式解析、loopback 流初始化与采集服务获取。
///
/// # 返回值
/// 成功返回采集会话；端点或流初始化失败返回分类错误。
///
/// @author zhenghq
fn open_loopback_session() -> Result<LoopbackSession, CaptureError> {
    // SAFETY: COM 调用均遵循 WASAPI 文档化的标准初始化路径，指针参数
    // 由 WASAPI 返回并在使用完成后释放。
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|_| CaptureError::DeviceUnavailable)?;
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .map_err(|_| CaptureError::DeviceUnavailable)?;
    let audio_client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
        .map_err(|_| CaptureError::DeviceUnavailable)?;
    let format =
        unsafe { audio_client.GetMixFormat() }.map_err(|_| CaptureError::DeviceUnavailable)?;
    let mix = match parse_mix_format(format) {
        Ok(mix) => mix,
        Err(error) => {
            // SAFETY: 失败路径同样必须释放 GetMixFormat 返回的内存。
            unsafe { CoTaskMemFree(Some(format.cast::<c_void>().cast_const())) };
            return Err(error);
        }
    };
    let initialized = unsafe {
        audio_client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            LOOPBACK_BUFFER_DURATION,
            0,
            format,
            None,
        )
    };
    // SAFETY: mix format 由 GetMixFormat 分配，Initialize 使用完成后必须释放。
    unsafe { CoTaskMemFree(Some(format.cast::<c_void>().cast_const())) };
    initialized.map_err(|_| CaptureError::DeviceUnavailable)?;
    let capture_client: IAudioCaptureClient =
        unsafe { audio_client.GetService() }.map_err(|_| CaptureError::DeviceUnavailable)?;
    Ok(LoopbackSession {
        audio_client,
        capture_client,
        format: mix,
        started: false,
    })
}

/// 检查默认渲染端点是否可解析。
///
/// # 返回值
/// 可解析时返回 `true`。
///
/// @author zhenghq
fn default_render_endpoint_exists() -> bool {
    // SAFETY: COM 对象按标准方式创建，接口引用随返回值释放。
    let enumerator: Option<IMMDeviceEnumerator> =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.ok();
    let Some(enumerator) = enumerator else {
        return false;
    };
    // SAFETY: enumerator 在上一行成功创建后保持有效。
    unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }.is_ok()
}

/// 解析并校验设备混音格式。
///
/// 共享模式混音格式实际只可能是 32 位浮点（现代 Windows 默认）或 16 位
/// 整型 PCM；其余位深与标签一律拒绝，避免错误解码。
///
/// # 参数
/// - `format`：`GetMixFormat` 返回的格式指针，指向完整的可变长 PCM 结构。
///
/// # 返回值
/// 解析成功返回归一化格式信息，否则返回不支持错误。
///
/// @author zhenghq
fn parse_mix_format(format: *const WAVEFORMATEX) -> Result<MixFormat, CaptureError> {
    // SAFETY: 指针由 WASAPI 返回且指向完整格式结构，只在本次调用内读取。
    let wave = unsafe { &*format };
    let channels = wave.nChannels as usize;
    let bits = wave.wBitsPerSample as usize;
    let bytes_per_frame = wave.nBlockAlign as usize;
    if channels == 0 || wave.nSamplesPerSec == 0 || bytes_per_frame != channels * bits / 8 {
        return Err(CaptureError::Unsupported);
    }
    let is_float = match wave.wFormatTag {
        WAVE_FORMAT_TAG_IEEE_FLOAT => bits == 32,
        WAVE_FORMAT_TAG_EXTENSIBLE => {
            // SAFETY: extensible 格式在内存中即 WAVEFORMATEXTENSIBLE 布局，
            // 按文档仅读取 SubFormat 字段判断子格式；该结构按 packed(1)
            // 布局，必须以未对齐读取拷贝字段，不能建立字段引用。
            let sub_format = unsafe {
                std::ptr::addr_of!((*format.cast::<WAVEFORMATEXTENSIBLE>()).SubFormat)
                    .read_unaligned()
            };
            sub_format == SUBTYPE_IEEE_FLOAT && bits == 32
        }
        WAVE_FORMAT_TAG_PCM => bits == 16,
        _ => false,
    };
    if !is_float && (wave.wFormatTag != WAVE_FORMAT_TAG_PCM || bits != 16) {
        return Err(CaptureError::Unsupported);
    }
    Ok(MixFormat {
        sample_rate_hz: wave.nSamplesPerSec,
        channels,
        bytes_per_frame,
        is_float,
    })
}

/// 运行 loopback 采集主循环，直到运行标志置假或设备持续故障。
///
/// 轮询读取 WASAPI 数据包：静音与暂停期间只排空包不解码；有效数据按
/// 设备格式解码为交错 f32 后交给重采样器，并通过上层通用结果处理函数
/// 写入输出通道。
///
/// # 参数
/// - `sink`：PCM16 输出通道。
/// - `paused`：暂停标志，为真时丢弃音频。
/// - `running`：运行标志，为假时退出循环。
/// - `errors`：设备故障错误发送端。
/// - `session`：已初始化的采集会话。
/// - `resampler`：降混重采样器。
///
/// # 返回值
/// 无返回值。
///
/// @author zhenghq
fn run_capture_loop(
    sink: &tokio::sync::mpsc::Sender<Vec<i16>>,
    paused: &AtomicBool,
    running: &AtomicBool,
    errors: &tokio::sync::mpsc::UnboundedSender<CaptureError>,
    session: &LoopbackSession,
    resampler: &mut StreamingPcm16Resampler,
) {
    let mut consecutive_sink_fulls = 0u32;
    let mut consecutive_failures = 0u32;
    while running.load(Ordering::SeqCst) {
        let packet_frames = match unsafe { session.capture_client.GetNextPacketSize() } {
            Ok(frames) => frames,
            Err(error) => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_CONSECUTIVE_POLL_FAILURES {
                    tracing::warn!(?error, "system audio capture poll kept failing");
                    super::report_unexpected_capture_failure(
                        running,
                        errors,
                        CaptureError::DeviceUnavailable,
                    );
                    return;
                }
                std::thread::sleep(POLL_INTERVAL);
                continue;
            }
        };
        if packet_frames == 0 {
            consecutive_failures = 0;
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut frames: u32 = 0;
        let mut flags: u32 = 0;
        if let Err(error) = unsafe {
            session
                .capture_client
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
        } {
            consecutive_failures += 1;
            if consecutive_failures >= MAX_CONSECUTIVE_POLL_FAILURES {
                tracing::warn!(?error, "system audio GetBuffer kept failing");
                super::report_unexpected_capture_failure(
                    running,
                    errors,
                    CaptureError::DeviceUnavailable,
                );
                return;
            }
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }
        consecutive_failures = 0;
        let byte_len = frames as usize * session.format.bytes_per_frame;
        let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
        let oversized = byte_len > MAX_PACKET_BYTES;
        if oversized {
            tracing::warn!(frames, "system audio packet oversized; dropping");
        }
        // 解码必须在 ReleaseBuffer 之前完成，释放后 data 指针立即失效。
        let samples: Vec<f32> =
            if silent || paused.load(Ordering::SeqCst) || oversized || byte_len == 0 {
                Vec::new()
            } else {
                // SAFETY: data 指向 WASAPI 提供的 frames * bytes_per_frame 字节，
                // 在 ReleaseBuffer 之前只读访问。
                decode_packet(
                    unsafe { std::slice::from_raw_parts(data, byte_len) },
                    session.format.is_float,
                )
            };
        if let Err(error) = unsafe { session.capture_client.ReleaseBuffer(frames) } {
            tracing::warn!(?error, "system audio release buffer failed");
        }
        if samples.is_empty() {
            continue;
        }
        let buffers = match resampler.push_interleaved(&samples) {
            Ok(buffers) => buffers,
            Err(_) => {
                tracing::warn!("system audio resample failed");
                continue;
            }
        };
        for pcm in buffers {
            if !running.load(Ordering::SeqCst) {
                break;
            }
            if pcm.is_empty() {
                continue;
            }
            if super::handle_capture_sink_result(
                sink.try_send(decode_i16(&pcm)),
                &mut consecutive_sink_fulls,
                running,
                errors,
                "system audio",
            ) {
                return;
            }
        }
    }
}

/// 把原始字节按设备混音格式解码为交错 f32 采样。
///
/// # 参数
/// - `bytes`：WASAPI 数据包的原始字节。
/// - `is_float`：是否为 32 位浮点采样，否则按 16 位整型归一化。
///
/// # 返回值
/// 交错排列的 f32 采样。
///
/// @author zhenghq
fn decode_packet(bytes: &[u8], is_float: bool) -> Vec<f32> {
    if is_float {
        bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| f32::from_le_bytes(*chunk))
            .collect()
    } else {
        bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|chunk| i16::from_le_bytes(*chunk) as f32 / 32_768.0)
            .collect()
    }
}
