//! macOS 系统声音采集：Core Audio Process Tap（macOS 14.2+）。
//!
//! 移植并简化自 Mimi 的 `src-tauri/src/audio/macos_tap.rs` 与
//! `macos_tap_target.rs`（MIT，Copyright (c) 2026 yuxino），去除 Tauri 运行时、
//! 应用定向与主线程调度依赖。工作线程独占全部原生资源，音频回调只把有界的
//! 单声道缓冲拷贝进有界队列，解码与重采样都在音频线程之外完成。
//!
//! 首版只走 Core Audio Tap 路径；系统版本过低（缺少 14.2 的符号）时返回
//! [`CaptureError::Unsupported`]，由主进程提示用户升级系统。

use std::ffi::{c_void, CStr};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_core_audio::*;
use objc2_core_audio_types::{
    kAudioFormatFlagIsAlignedHigh, kAudioFormatFlagIsBigEndian, kAudioFormatFlagIsFloat,
    kAudioFormatFlagIsNonInterleaved, kAudioFormatFlagIsSignedInteger, kAudioFormatLinearPCM,
    AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp,
};
use objc2_core_foundation::CFDictionary;
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSUUID};

use super::pcm::decode_i16;
use super::streaming_resampler::StreamingPcm16Resampler;
use super::CaptureError;

/// 单次音频回调允许的最大字节数。
const MAX_CALLBACK_BYTES: usize = 64 * 1024;
/// 回调队列槽位上限。
const CALLBACK_QUEUE_CAPACITY: usize = 256;
/// 工作线程轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// 健康检查间隔。
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);
/// 已有音频回调后，允许连续无新回调的最长时间。
const CALLBACK_STALL_TIMEOUT: Duration = Duration::from_secs(5);

/// Core Audio Tap 动态入口点签名。
type CreateTap = unsafe extern "C-unwind" fn(Option<&CATapDescription>, *mut AudioObjectID) -> i32;
/// Core Audio Tap 销毁入口点签名。
type DestroyTap = unsafe extern "C-unwind" fn(AudioObjectID) -> i32;

/// 动态加载的 Core Audio Tap API。
#[derive(Clone, Copy)]
struct TapApi {
    /// 创建进程 Tap。
    create: CreateTap,
    /// 销毁进程 Tap。
    destroy: DestroyTap,
}

impl TapApi {
    /// 从系统框架动态解析 Tap 入口点。
    ///
    /// 只有 macOS 14.2+ 才导出这两个符号；动态解析可让可执行文件在更老的
    /// 系统上正常加载并优雅降级。
    ///
    /// # 返回值
    /// 可用时返回入口点集合，否则返回 `None`。
    fn load() -> Option<Self> {
        static API: OnceLock<Option<TapApi>> = OnceLock::new();
        *API.get_or_init(|| {
            objc2::runtime::AnyClass::get(c"CATapDescription")?;
            // SAFETY: CoreAudio 已由 cpal 链接；这里只解析 14.2+ 的入口点，
            // 签名与 AudioHardwareTapping.h 一致。
            unsafe {
                let create = libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"AudioHardwareCreateProcessTap".as_ptr(),
                );
                let destroy = libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"AudioHardwareDestroyProcessTap".as_ptr(),
                );
                if create.is_null() || destroy.is_null() {
                    return None;
                }
                Some(Self {
                    create: std::mem::transmute::<*mut c_void, CreateTap>(create),
                    destroy: std::mem::transmute::<*mut c_void, DestroyTap>(destroy),
                })
            }
        })
    }
}

/// 判断当前系统是否支持 Core Audio Tap。
///
/// # 返回值
/// 支持时返回 `true`。
pub fn is_available() -> bool {
    TapApi::load().is_some()
}

/// 检查系统声音采集所需的屏幕录制权限是否已授予。
///
/// Core Audio Process Tap 读取系统混音输出属于屏幕录制权限范畴，
/// 未授权时创建 Tap 会直接失败，因此启动前先做无副作用预检。
///
/// # 返回值
/// 已授权返回 `true`，未授权或系统过旧返回 `false`。
pub fn has_system_audio_permission() -> bool {
    core_graphics2::window::preflight_screen_capture_access()
}

/// 请求系统声音采集所需的屏幕录制权限。
///
/// 首次调用会弹出系统授权对话框；用户已拒绝时不会再弹窗，
/// 只能由用户在“系统设置 → 隐私与安全性 → 屏幕录制”中手动开启。
///
/// # 返回值
/// 请求后当前授权状态。
pub fn request_system_audio_permission() -> bool {
    core_graphics2::window::request_screen_capture_access()
}

/// 启动系统声音采集线程。
///
/// # 参数
/// - `sink`：PCM16 单声道采样输出通道。
/// - `paused`：暂停标志，为真时丢弃音频。
/// - `running`：运行标志，为假时工作线程退出并释放原生资源。
/// - `errors`：运行期间设备故障的错误发送端。
///
/// # 返回值
/// 启动成功返回采集线程句柄，否则返回分类错误。
pub fn start(
    sink: tokio::sync::mpsc::Sender<Vec<i16>>,
    paused: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    errors: tokio::sync::mpsc::UnboundedSender<CaptureError>,
) -> Result<std::thread::JoinHandle<()>, CaptureError> {
    let api = TapApi::load().ok_or(CaptureError::Unsupported)?;
    // 屏幕录制权限缺失时先请求授权；仍被拒绝则返回结构化错误，
    // 避免创建 Tap 后静默无音频。
    if !has_system_audio_permission() && !request_system_audio_permission() {
        return Err(CaptureError::PermissionDenied);
    }
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), CaptureError>>(1);
    let handle = std::thread::Builder::new()
        .name("mimi-system-audio-tap".into())
        .spawn(move || {
            objc2::rc::autoreleasepool(|_| {
                let mut native = NativeTap::new(api);
                let setup = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
                    native.prepare(&running)
                }))
                .unwrap_or(Err(CaptureError::Unsupported));
                let (asbd, receiver) = match setup {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                let mut resampler = match StreamingPcm16Resampler::new(
                    asbd.mSampleRate as u32,
                    TARGET_SAMPLE_RATE_HZ,
                    1,
                ) {
                    Ok(resampler) => resampler,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                // SAFETY: device/io_proc 由 NativeTap 独占且保持存活。
                if let Err(error) =
                    status(unsafe { AudioDeviceStart(native.device, native.io_proc) })
                {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
                native.started = true;
                if ready_tx.send(Ok(())).is_err() {
                    return;
                }
                let mut health_at = Instant::now();
                let mut callback_heartbeat = CallbackHeartbeat::new(health_at);
                let mut consecutive_sink_fulls = 0;
                while running.load(Ordering::SeqCst) {
                    match receiver.recv_timeout(POLL_INTERVAL) {
                        Ok(packet) => {
                            if !running.load(Ordering::SeqCst) {
                                break;
                            }
                            if paused.load(Ordering::SeqCst) {
                                continue;
                            }
                            let decoded = decode_to_f32_mono(&packet.bytes, &asbd)
                                .and_then(|samples| resampler.push_interleaved(&samples));
                            match decoded {
                                Ok(buffers) => {
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
                                            &running,
                                            &errors,
                                            "system audio",
                                        ) {
                                            break;
                                        }
                                    }
                                }
                                Err(error) => {
                                    tracing::warn!(?error, "system audio decode/resample failed");
                                }
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    if health_at.elapsed() >= HEALTH_INTERVAL {
                        let callback_count = native.callback_count.load(Ordering::Relaxed);
                        if callback_heartbeat.is_stalled(
                            callback_count,
                            Instant::now(),
                            paused.load(Ordering::SeqCst),
                        ) {
                            tracing::warn!(
                                callback_count,
                                timeout_ms = CALLBACK_STALL_TIMEOUT.as_millis(),
                                "system audio callback stalled"
                            );
                            super::report_unexpected_capture_failure(
                                &running,
                                &errors,
                                CaptureError::DeviceUnavailable,
                            );
                            break;
                        }
                        if !native.is_healthy() {
                            tracing::warn!("system audio device became unhealthy");
                            super::report_unexpected_capture_failure(
                                &running,
                                &errors,
                                CaptureError::DeviceUnavailable,
                            );
                            break;
                        }
                        health_at = Instant::now();
                    }
                }
            });
        })
        .map_err(|_| CaptureError::DeviceUnavailable)?;
    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| CaptureError::DeviceUnavailable)??;
    Ok(handle)
}

/// 目标采样率：Deepgram 实时识别使用 24 kHz PCM16。
const TARGET_SAMPLE_RATE_HZ: u32 = 24_000;

/// 原生 Tap 资源集合。
struct NativeTap {
    /// 动态入口点。
    api: TapApi,
    /// 进程 Tap 对象。
    tap: AudioObjectID,
    /// 聚合设备。
    device: AudioObjectID,
    /// 默认输出设备（用于健康检查）。
    output_device: AudioObjectID,
    /// IO 回调标识。
    io_proc: AudioDeviceIOProcID,
    /// 是否已启动。
    started: bool,
    /// 音频回调累计计数，用于识别设备仍报告运行但回调已停滞的情况。
    callback_count: Arc<AtomicUsize>,
    /// 回调上下文，Drop 时随 IOProc 一起释放。
    context: Option<Box<CallbackState>>,
    /// Tap 描述，刷新目标时需要。
    description: Option<Retained<CATapDescription>>,
}

impl NativeTap {
    /// 创建空的 Tap 资源集合。
    ///
    /// # 参数
    /// - `api`：动态解析出的入口点。
    ///
    /// # 返回值
    /// 尚未准备的资源集合。
    fn new(api: TapApi) -> Self {
        Self {
            api,
            tap: 0,
            device: 0,
            output_device: 0,
            io_proc: None,
            started: false,
            callback_count: Arc::new(AtomicUsize::new(0)),
            context: None,
            description: None,
        }
    }

    /// 创建 Tap、聚合设备与 IO 回调。
    ///
    /// # 参数
    /// - `running`：运行标志，用于在准备过程中检测取消。
    ///
    /// # 返回值
    /// Tap 的音频格式与回调包接收器。
    fn prepare(
        &mut self,
        running: &Arc<AtomicBool>,
    ) -> Result<(AudioStreamBasicDescription, Receiver<CallbackPacket>), CaptureError> {
        let check_current = || {
            if running.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(CaptureError::DeviceUnavailable)
            }
        };
        check_current()?;

        // 排除本进程自身，避免把 sidecar 的播放也采集进来。
        let pid = std::process::id() as libc::pid_t;
        let own_process: AudioObjectID = property(
            kAudioObjectSystemObject as AudioObjectID,
            kAudioHardwarePropertyTranslatePIDToProcessObject,
            kAudioObjectPropertyScopeGlobal,
            Some(&pid),
        )?;
        if own_process == kAudioObjectUnknown {
            return Err(CaptureError::Unsupported);
        }

        let numbers = vec![NSNumber::new_u32(own_process)];
        let processes = NSArray::from_retained_slice(&numbers);
        // SAFETY: 只在确认 Tap 符号存在后调用；描述对象在调用期间保持存活。
        let description = unsafe {
            let description = CATapDescription::initMonoGlobalTapButExcludeProcesses(
                CATapDescription::alloc(),
                &processes,
            );
            description.setPrivate(true);
            description.setMuteBehavior(CATapMuteBehavior::Unmuted);
            description.setName(&NSString::from_str("Realtime subtitle system audio"));
            description
        };
        check_current()?;

        // SAFETY: 描述对象有效；out 指针指向栈上变量。
        status(unsafe { (self.api.create)(Some(&description), &mut self.tap) })?;
        self.description = Some(description.clone());
        check_current()?;

        let asbd: AudioStreamBasicDescription = property(
            self.tap,
            kAudioTapPropertyFormat,
            kAudioObjectPropertyScopeGlobal,
            None,
        )?;
        validate_format(&asbd)?;

        self.output_device = property(
            kAudioObjectSystemObject as AudioObjectID,
            kAudioHardwarePropertyDefaultOutputDevice,
            kAudioObjectPropertyScopeGlobal,
            None,
        )?;

        let uid = unsafe { description.UUID().UUIDString() };
        let enabled = NSNumber::new_bool(true);
        let disabled = NSNumber::new_bool(false);
        let tap = dictionary(&[
            (kAudioSubTapUIDKey, &uid),
            (kAudioSubTapDriftCompensationKey, &enabled),
        ]);
        let taps = NSArray::from_retained_slice(&[tap]);
        let aggregate_uid = NSUUID::new().UUIDString();
        let name = NSString::from_str("Realtime subtitle private audio tap");
        let aggregate = dictionary(&[
            (kAudioAggregateDeviceNameKey, &name),
            (kAudioAggregateDeviceUIDKey, &aggregate_uid),
            (kAudioAggregateDeviceIsPrivateKey, &enabled),
            (kAudioAggregateDeviceIsStackedKey, &disabled),
            (kAudioAggregateDeviceTapAutoStartKey, &disabled),
            (kAudioAggregateDeviceTapListKey, &taps),
        ]);
        // SAFETY: NSDictionary 与 CFDictionary toll-free bridged，键值符合
        // Core Audio 聚合设备字典 schema。
        let aggregate_cf = unsafe {
            &*((&*aggregate as *const NSDictionary<NSString, AnyObject>).cast::<CFDictionary>())
        };
        status(unsafe {
            AudioHardwareCreateAggregateDevice(aggregate_cf, NonNull::from(&mut self.device))
        })?;
        check_current()?;

        let (sender, receiver) = mpsc::sync_channel(CALLBACK_QUEUE_CAPACITY);
        self.callback_count = Arc::new(AtomicUsize::new(0));
        self.context = Some(Box::new(CallbackState {
            sender,
            queued_bytes: Arc::new(AtomicUsize::new(0)),
            callback_count: Arc::clone(&self.callback_count),
            byte_limit: (asbd.mSampleRate as usize)
                .saturating_mul(asbd.mBytesPerFrame as usize)
                .max(1),
            bytes_per_frame: asbd.mBytesPerFrame as usize,
        }));
        let context = self.context.as_deref_mut().unwrap() as *mut CallbackState;
        // SAFETY: 上下文指针在 DestroyIOProcID 成功前保持有效。
        status(unsafe {
            AudioDeviceCreateIOProcID(
                self.device,
                Some(audio_callback),
                context.cast(),
                NonNull::from(&mut self.io_proc),
            )
        })?;
        check_current()?;
        Ok((asbd, receiver))
    }

    /// 检查设备是否仍在运行且输出路由未变化。
    ///
    /// # 返回值
    /// 健康时返回 `true`。
    fn is_healthy(&self) -> bool {
        let output: Result<AudioObjectID, _> = property(
            kAudioObjectSystemObject as AudioObjectID,
            kAudioHardwarePropertyDefaultOutputDevice,
            kAudioObjectPropertyScopeGlobal,
            None,
        );
        let running: Result<u32, _> = property(
            self.device,
            kAudioDevicePropertyDeviceIsRunning,
            kAudioObjectPropertyScopeGlobal,
            None,
        );
        output.is_ok_and(|output| output == self.output_device)
            && running.is_ok_and(|running| running != 0)
    }
}

impl Drop for NativeTap {
    /// 释放 Tap、聚合设备与 IO 回调。
    ///
    /// # 返回值
    /// 无返回值。
    fn drop(&mut self) {
        if self.started {
            let code = unsafe { AudioDeviceStop(self.device, self.io_proc) };
            if code != 0 {
                tracing::warn!(status = code, "system audio stop failed");
            }
        }
        if self.io_proc.is_some() {
            let code = unsafe { AudioDeviceDestroyIOProcID(self.device, self.io_proc) };
            if code != 0 {
                tracing::warn!(status = code, "system audio destroy ioproc failed");
                // 移除失败不代表回调已停止，保留上下文避免 use-after-free。
                if let Some(context) = self.context.take() {
                    std::mem::forget(context);
                }
            }
        }
        if self.device != 0 {
            let code = unsafe { AudioHardwareDestroyAggregateDevice(self.device) };
            if code != 0 {
                tracing::warn!(status = code, "destroy aggregate device failed");
            }
        }
        if self.tap != 0 {
            let code = unsafe { (self.api.destroy)(self.tap) };
            if code != 0 {
                tracing::warn!(status = code, "destroy process tap failed");
            }
        }
    }
}

/// 音频回调上下文。
struct CallbackState {
    /// 有界回调队列发送端。
    sender: SyncSender<CallbackPacket>,
    /// 已排队字节数。
    queued_bytes: Arc<AtomicUsize>,
    /// 有效音频回调累计计数。
    callback_count: Arc<AtomicUsize>,
    /// 字节预算上限（约一秒音频）。
    byte_limit: usize,
    /// 每帧字节数。
    bytes_per_frame: usize,
}

/// 系统音频回调心跳状态机。
///
/// 仅在至少收到过一次有效回调后启用停滞判断，避免用户尚未播放音频时误触发
/// 会话重连；暂停期间会重置时间基准，恢复后重新给予完整超时窗口。
struct CallbackHeartbeat {
    /// 上次观察到的回调计数。
    last_count: usize,
    /// 上次确认回调活跃或恢复运行的时间。
    last_activity_at: Instant,
    /// 是否至少收到过一次有效回调。
    saw_callback: bool,
    /// 上次检查时是否处于暂停状态。
    paused: bool,
}

impl CallbackHeartbeat {
    /// 创建回调心跳状态机。
    ///
    /// # 参数
    /// - `now`：开始采集的时间。
    ///
    /// # 返回值
    /// 尚未观察到音频回调的心跳状态。
    fn new(now: Instant) -> Self {
        Self {
            last_count: 0,
            last_activity_at: now,
            saw_callback: false,
            paused: false,
        }
    }

    /// 根据最新回调计数判断采集是否已经停滞。
    ///
    /// # 参数
    /// - `callback_count`：当前累计回调计数。
    /// - `now`：本次检查时间。
    /// - `paused`：采集当前是否暂停。
    ///
    /// # 返回值
    /// 已收到过回调且超过超时阈值仍无新回调时返回 `true`。
    fn is_stalled(&mut self, callback_count: usize, now: Instant, paused: bool) -> bool {
        if paused {
            self.last_count = callback_count;
            self.last_activity_at = now;
            self.saw_callback |= callback_count > 0;
            self.paused = true;
            return false;
        }
        if self.paused {
            self.last_count = callback_count;
            self.last_activity_at = now;
            self.saw_callback |= callback_count > 0;
            self.paused = false;
            return false;
        }
        if callback_count != self.last_count {
            self.last_count = callback_count;
            self.last_activity_at = now;
            self.saw_callback |= callback_count > 0;
            return false;
        }
        self.saw_callback
            && now.saturating_duration_since(self.last_activity_at) >= CALLBACK_STALL_TIMEOUT
    }
}

/// 一次音频回调拷贝出的有界数据包。
struct CallbackPacket {
    /// 原始 PCM 字节。
    bytes: Vec<u8>,
    /// 共享的排队字节计数。
    queued_bytes: Arc<AtomicUsize>,
}

impl Drop for CallbackPacket {
    /// 出队或丢弃时归还字节预算。
    ///
    /// # 返回值
    /// 无返回值。
    fn drop(&mut self) {
        self.queued_bytes
            .fetch_sub(self.bytes.len(), Ordering::Relaxed);
    }
}

impl CallbackState {
    /// 预留回调字节预算。
    ///
    /// # 参数
    /// - `byte_count`：本次回调字节数。
    ///
    /// # 返回值
    /// 预算充足返回 `true`，否则返回 `false`。
    fn reserve_bytes(&self, byte_count: usize) -> bool {
        let mut queued = self.queued_bytes.load(Ordering::Relaxed);
        loop {
            let Some(total) = queued
                .checked_add(byte_count)
                .filter(|total| *total <= self.byte_limit)
            else {
                return false;
            };
            match self.queued_bytes.compare_exchange_weak(
                queued,
                total,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(current) => queued = current,
            }
        }
    }
}

/// Core Audio IO 回调：只拷贝有界单声道缓冲，不做解码与阻塞操作。
///
/// # 参数
/// - `_device`：设备标识。
/// - `_now`：当前时间戳。
/// - `input`：输入缓冲列表。
/// - `_input_time`：输入时间戳。
/// - `_output`：输出缓冲列表。
/// - `_output_time`：输出时间戳。
/// - `context`：回调上下文指针。
///
/// # 返回值
/// Core Audio 状态码，始终为 0。
unsafe extern "C-unwind" fn audio_callback(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input: NonNull<AudioBufferList>,
    _input_time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    context: *mut c_void,
) -> i32 {
    // SAFETY: NativeTap 在 DestroyIOProcID 成功前保持上下文存活；输入缓冲只在
    // 本次调用期间有效，回调内立即拷贝，不保留原生指针。
    let state = unsafe { &*context.cast::<CallbackState>() };
    let input = unsafe { input.as_ref() };
    if input.mNumberBuffers != 1 {
        return 0;
    }
    let buffer = &input.mBuffers[0];
    let byte_count = buffer.mDataByteSize as usize;
    if buffer.mData.is_null() || byte_count == 0 {
        return 0;
    }
    if !valid_buffer(buffer.mNumberChannels, byte_count, state.bytes_per_frame) {
        return 0;
    }
    state.callback_count.fetch_add(1, Ordering::Relaxed);
    if !state.reserve_bytes(byte_count) {
        return 0;
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(buffer.mData.cast::<u8>(), byte_count) }.to_vec();
    let packet = CallbackPacket {
        bytes,
        queued_bytes: Arc::clone(&state.queued_bytes),
    };
    if let Err(TrySendError::Full(packet)) = state.sender.try_send(packet) {
        drop(packet);
    }
    0
}

/// 校验回调缓冲布局是否符合单声道线性 PCM 预期。
///
/// # 参数
/// - `channels`：缓冲声道数。
/// - `bytes`：缓冲字节数。
/// - `bytes_per_frame`：每帧字节数。
///
/// # 返回值
/// 合法时返回 `true`。
fn valid_buffer(channels: u32, bytes: usize, bytes_per_frame: usize) -> bool {
    channels == 1
        && bytes <= MAX_CALLBACK_BYTES
        && bytes_per_frame > 0
        && bytes.is_multiple_of(bytes_per_frame)
}

/// 构造 Core Audio 字典。
///
/// # 参数
/// - `entries`：键值对，键为 C 字符串，值为 Objective-C 对象。
///
/// # 返回值
/// 新的不可变字典。
fn dictionary(entries: &[(&CStr, &AnyObject)]) -> Retained<NSDictionary<NSString, AnyObject>> {
    let keys: Vec<_> = entries
        .iter()
        .map(|(key, _)| NSString::from_str(key.to_str().expect("Core Audio dictionary key")))
        .collect();
    let keys: Vec<_> = keys.iter().map(|key| &**key).collect();
    let values: Vec<_> = entries.iter().map(|(_, value)| *value).collect();
    NSDictionary::from_slices(&keys, &values)
}

/// 读取一个 Core Audio 属性。
///
/// # 参数
/// - `object`：目标音频对象。
/// - `selector`：属性选择器。
/// - `scope`：属性作用域。
/// - `qualifier`：可选的 PID 限定符。
///
/// # 返回值
/// 属性值；类型不匹配或系统调用失败时返回错误。
fn property<T: Copy>(
    object: AudioObjectID,
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope,
    qualifier: Option<&libc::pid_t>,
) -> Result<T, CaptureError> {
    let mut address = AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut value = std::mem::MaybeUninit::<T>::uninit();
    let mut size = std::mem::size_of::<T>() as u32;
    // SAFETY: 所有调用点都使用 Core Audio 的 POD 属性类型；输出与大小在调用
    // 期间保持有效；PID 限定符只读。
    status(unsafe {
        AudioObjectGetPropertyData(
            object,
            NonNull::from(&mut address),
            qualifier.map_or(0, |_| std::mem::size_of::<libc::pid_t>() as u32),
            qualifier.map_or(std::ptr::null(), |pid| (pid as *const libc::pid_t).cast()),
            NonNull::from(&mut size),
            NonNull::new(value.as_mut_ptr()).unwrap().cast(),
        )
    })?;
    if size as usize != std::mem::size_of::<T>() {
        return Err(CaptureError::Unsupported);
    }
    // SAFETY: 成功且大小完全匹配，说明整个 POD 输出已初始化。
    Ok(unsafe { value.assume_init() })
}

/// 把 Core Audio 状态码转换为分类错误。
///
/// # 参数
/// - `code`：Core Audio 状态码。
///
/// # 返回值
/// 成功返回 `Ok(())`，否则返回分类错误。
fn status(code: i32) -> Result<(), CaptureError> {
    if code == 0 {
        Ok(())
    } else if code == kAudioDevicePermissionsError {
        Err(CaptureError::PermissionDenied)
    } else {
        tracing::warn!(status = code, "core audio call failed");
        Err(CaptureError::DeviceUnavailable)
    }
}

/// 校验 Tap 输出的音频格式是否为受支持的线性 PCM。
///
/// # 参数
/// - `format`：Tap 音频格式。
///
/// # 返回值
/// 受支持时返回 `Ok(())`。
fn validate_format(format: &AudioStreamBasicDescription) -> Result<(), CaptureError> {
    let supported_sample = (format.mFormatFlags & kAudioFormatFlagIsFloat != 0
        && format.mBitsPerChannel == 32)
        || (format.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0
            && matches!(format.mBitsPerChannel, 16 | 32));
    if format.mFormatID != kAudioFormatLinearPCM
        || format.mChannelsPerFrame != 1
        || !supported_sample
        || !(8_000.0..=192_000.0).contains(&format.mSampleRate)
        || format.mSampleRate.fract() != 0.0
        || format.mBytesPerFrame != format.mBitsPerChannel / 8
        || format.mFramesPerPacket != 1
        || format.mBytesPerPacket != format.mBytesPerFrame
        || format.mFormatFlags & (kAudioFormatFlagIsBigEndian | kAudioFormatFlagIsAlignedHigh) != 0
    {
        return Err(CaptureError::Unsupported);
    }
    Ok(())
}

/// 把交错或平面的线性 PCM 解码为单声道 f32 采样。
///
/// # 参数
/// - `bytes`：原始 PCM 字节。
/// - `asbd`：音频格式描述。
///
/// # 返回值
/// 单声道 f32 采样；格式不受支持时返回错误。
pub fn decode_to_f32_mono(
    bytes: &[u8],
    asbd: &AudioStreamBasicDescription,
) -> Result<Vec<f32>, CaptureError> {
    let channels = asbd.mChannelsPerFrame.max(1) as usize;
    let is_float = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0;
    let is_signed_int = asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0;
    let is_planar = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0;

    if is_planar {
        let frames_per_channel = if is_float && asbd.mBitsPerChannel == 32 {
            bytes.len() / (4 * channels)
        } else if is_signed_int && asbd.mBitsPerChannel == 16 {
            bytes.len() / (2 * channels)
        } else if is_signed_int && asbd.mBitsPerChannel == 32 {
            bytes.len() / (4 * channels)
        } else {
            return Err(CaptureError::Unsupported);
        };
        let bytes_per_sample = (asbd.mBitsPerChannel / 8) as usize;
        let mut mono = Vec::with_capacity(frames_per_channel);
        for frame in 0..frames_per_channel {
            let mut mixed = 0.0f64;
            for channel in 0..channels {
                let offset = (frame + channel * frames_per_channel) * bytes_per_sample;
                mixed += sample_to_f32(bytes, offset, is_float, asbd.mBitsPerChannel)? as f64;
            }
            mono.push((mixed / channels as f64) as f32);
        }
        Ok(mono)
    } else if is_float && asbd.mBitsPerChannel == 32 {
        decode_interleaved(bytes, channels, 4, |bytes, offset| {
            Ok(f32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]) as f64)
        })
    } else if is_signed_int && asbd.mBitsPerChannel == 16 {
        decode_interleaved(bytes, channels, 2, |bytes, offset| {
            Ok(i16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as f64 / 32_768.0)
        })
    } else if is_signed_int && asbd.mBitsPerChannel == 32 {
        decode_interleaved(bytes, channels, 4, |bytes, offset| {
            Ok(i32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]) as f64
                / 2_147_483_648.0)
        })
    } else {
        Err(CaptureError::Unsupported)
    }
}

/// 解码交错 PCM，把每帧各声道平均成单声道。
///
/// # 参数
/// - `bytes`：原始 PCM 字节。
/// - `channels`：声道数。
/// - `bytes_per_sample`：每采样字节数。
/// - `sample`：把字节偏移转成归一化浮点的闭包。
///
/// # 返回值
/// 单声道 f32 采样。
fn decode_interleaved(
    bytes: &[u8],
    channels: usize,
    bytes_per_sample: usize,
    sample: impl Fn(&[u8], usize) -> Result<f64, CaptureError>,
) -> Result<Vec<f32>, CaptureError> {
    if channels == 0 || bytes_per_sample == 0 {
        return Err(CaptureError::Unsupported);
    }
    let frames = bytes.len() / (bytes_per_sample * channels);
    if frames == 0 {
        return Ok(Vec::new());
    }
    let mut mono = Vec::with_capacity(frames);
    for frame in 0..frames {
        let mut mixed = 0.0f64;
        for channel in 0..channels {
            let offset = (frame * channels + channel) * bytes_per_sample;
            mixed += sample(bytes, offset)?;
        }
        mono.push((mixed / channels as f64) as f32);
    }
    Ok(mono)
}

/// 从字节偏移读取一个归一化浮点采样。
///
/// # 参数
/// - `bytes`：原始字节。
/// - `offset`：采样起始偏移。
/// - `is_float`：是否为浮点采样。
/// - `bits`：位深。
///
/// # 返回值
/// 归一化到 -1.0 到 1.0 的采样。
fn sample_to_f32(
    bytes: &[u8],
    offset: usize,
    is_float: bool,
    bits: u32,
) -> Result<f32, CaptureError> {
    if is_float && bits == 32 {
        Ok(f32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]))
    } else if !is_float && bits == 16 {
        Ok(i16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as f32 / 32_768.0)
    } else if !is_float && bits == 32 {
        Ok(i32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]) as f32
            / 2_147_483_648.0)
    } else {
        Err(CaptureError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_core_audio_types::kAudioFormatFlagIsPacked;

    /// 构造 48 kHz 单声道 f32 的 ASBD。
    ///
    /// # 返回值
    /// 测试用音频格式。
    fn asbd_f32(channels: u32) -> AudioStreamBasicDescription {
        AudioStreamBasicDescription {
            mSampleRate: 48_000.0,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4 * channels,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4 * channels,
            mChannelsPerFrame: channels,
            mBitsPerChannel: 32,
            mReserved: 0,
        }
    }

    #[test]
    fn callback_rejects_extra_streams_oversized_and_partial_frames() {
        assert!(valid_buffer(1, 4096, 4));
        assert!(!valid_buffer(2, 4096, 4));
        assert!(!valid_buffer(1, MAX_CALLBACK_BYTES + 4, 4));
        assert!(!valid_buffer(1, 4095, 4));
        assert!(!valid_buffer(1, 4096, 0));
    }

    #[test]
    fn validate_format_rejects_stereo_and_unsupported_depth() {
        let stereo = asbd_f32(2);
        assert!(matches!(
            validate_format(&stereo),
            Err(CaptureError::Unsupported)
        ));
        let mono = asbd_f32(1);
        assert!(validate_format(&mono).is_ok());
    }

    /// 校验持续到达的音频回调会刷新心跳，不会被误判为失活。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn callback_heartbeat_tracks_continuous_callbacks() {
        let started_at = Instant::now();
        let mut heartbeat = CallbackHeartbeat::new(started_at);

        assert!(!heartbeat.is_stalled(1, started_at, false));
        assert!(!heartbeat.is_stalled(
            2,
            started_at + CALLBACK_STALL_TIMEOUT - Duration::from_millis(1),
            false
        ));
        assert!(!heartbeat.is_stalled(3, started_at + CALLBACK_STALL_TIMEOUT, false));
    }

    /// 校验从未收到回调时不会因用户尚未播放音频而误判失活。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn callback_heartbeat_waits_for_first_callback() {
        let started_at = Instant::now();
        let mut heartbeat = CallbackHeartbeat::new(started_at);

        assert!(!heartbeat.is_stalled(0, started_at + CALLBACK_STALL_TIMEOUT * 2, false));
    }

    /// 校验收到过回调后超过阈值仍无新回调时会判定失活。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn callback_heartbeat_detects_stalled_callbacks() {
        let started_at = Instant::now();
        let mut heartbeat = CallbackHeartbeat::new(started_at);

        assert!(!heartbeat.is_stalled(1, started_at, false));
        assert!(!heartbeat.is_stalled(
            1,
            started_at + CALLBACK_STALL_TIMEOUT - Duration::from_millis(1),
            false
        ));
        assert!(heartbeat.is_stalled(1, started_at + CALLBACK_STALL_TIMEOUT, false));
    }

    /// 校验暂停期间不累计无回调时长，恢复后不会立即误报。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn callback_heartbeat_ignores_paused_duration() {
        let started_at = Instant::now();
        let mut heartbeat = CallbackHeartbeat::new(started_at);
        let paused_at = started_at + CALLBACK_STALL_TIMEOUT * 2;

        assert!(!heartbeat.is_stalled(1, started_at, false));
        assert!(!heartbeat.is_stalled(1, paused_at, true));
        assert!(!heartbeat.is_stalled(
            1,
            paused_at + CALLBACK_STALL_TIMEOUT - Duration::from_millis(1),
            false
        ));
        assert!(heartbeat.is_stalled(
            1,
            paused_at + CALLBACK_STALL_TIMEOUT * 2 - Duration::from_millis(1),
            false
        ));
    }
}
