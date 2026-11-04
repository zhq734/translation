//! macOS 默认输入设备（麦克风）采集。
//!
//! 移植并简化自 Mimi 的 `src-tauri/src/audio/microphone.rs`（MIT，Copyright (c)
//! 2026 yuxino）。单个工作线程独占原生输入流：回调只做降混与重采样，并通过
//! 有界通道把 PCM16 采样送给上层；停止时置取消标志并等待原生流真正释放。
//! 采集前先请求并检查麦克风权限，未授权时返回
//! [`CaptureError::PermissionDenied`]，绝不静默失败。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SizedSample};

use super::streaming_resampler::StreamingPcm16Resampler;
use super::CaptureError;

/// 目标采样率：Deepgram 实时识别使用 24 kHz PCM16。
const TARGET_SAMPLE_RATE_HZ: u32 = 24_000;
/// 工作线程轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(5);
/// 单次回调允许的最大时长（毫秒），用于拒绝异常大的回调。
const MAX_CALLBACK_MS: usize = 250;

/// 启动麦克风采集线程。
///
/// # 参数
/// - `sink`：PCM16 单声道采样输出通道。
/// - `paused`：暂停标志，为真时丢弃音频。
/// - `running`：运行标志，为假时线程退出并释放输入流。
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
    request_microphone_permission(&running)?;
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<(), CaptureError>>(1);
    let thread_running = Arc::clone(&running);
    let handle = std::thread::Builder::new()
        .name("mimi-microphone".into())
        .spawn(move || {
            let stream = match open_stream(
                sink,
                Arc::clone(&paused),
                Arc::clone(&thread_running),
                errors,
            ) {
                Ok(stream) => stream,
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            if let Err(error) = stream.play() {
                let _ = ready_tx.send(Err(map_native_error(error)));
                return;
            }
            if ready_tx.send(Ok(())).is_err() {
                return;
            }
            while thread_running.load(Ordering::SeqCst) {
                std::thread::sleep(POLL_INTERVAL);
            }
            // 显式 drop 关闭输入流，不残留采集。
            drop(stream);
        })
        .map_err(|_| CaptureError::DeviceUnavailable)?;
    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| CaptureError::DeviceUnavailable)??;
    Ok(handle)
}

/// 打开默认输入设备并构建输入流。
///
/// # 参数
/// - `sink`：PCM16 输出通道。
/// - `paused`：暂停标志。
/// - `running`：运行标志。
///
/// # 返回值
/// 已构建但尚未播放的输入流。
fn open_stream(
    sink: tokio::sync::mpsc::Sender<Vec<i16>>,
    paused: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    errors: tokio::sync::mpsc::UnboundedSender<CaptureError>,
) -> Result<cpal::Stream, CaptureError> {
    // 绝不回退到输出端点：缺失或未授权的麦克风必须保持可见错误。
    let device = cpal::default_host()
        .default_input_device()
        .ok_or(CaptureError::DeviceUnavailable)?;
    let config = device.default_input_config().map_err(map_native_error)?;
    let sample_format = config.sample_format();
    let processor = MicrophoneProcessor::new(
        config.sample_rate(),
        config.channels() as usize,
        TARGET_SAMPLE_RATE_HZ,
    )?;
    let config = config.into();
    macro_rules! stream {
        ($sample:ty) => {
            build_stream::<$sample>(
                &device,
                config,
                Arc::clone(&paused),
                Arc::clone(&running),
                sink,
                processor,
                errors,
                |sample| f32::from_sample(sample),
            )
        };
    }
    match sample_format {
        cpal::SampleFormat::F32 => stream!(f32),
        cpal::SampleFormat::F64 => stream!(f64),
        cpal::SampleFormat::I8 => stream!(i8),
        cpal::SampleFormat::I16 => stream!(i16),
        cpal::SampleFormat::I24 => build_stream::<cpal::I24>(
            &device,
            config,
            Arc::clone(&paused),
            Arc::clone(&running),
            sink,
            processor,
            errors,
            f32::from_sample,
        ),
        cpal::SampleFormat::I32 => stream!(i32),
        cpal::SampleFormat::I64 => stream!(i64),
        cpal::SampleFormat::U8 => stream!(u8),
        cpal::SampleFormat::U16 => stream!(u16),
        cpal::SampleFormat::U24 => stream!(cpal::U24),
        cpal::SampleFormat::U32 => stream!(u32),
        cpal::SampleFormat::U64 => stream!(u64),
        _ => Err(CaptureError::Unsupported),
    }
}

/// 把 cpal 原生错误映射为分类错误。
///
/// # 参数
/// - `error`：cpal 错误。
///
/// # 返回值
/// 分类后的采集错误。
fn map_native_error(error: cpal::Error) -> CaptureError {
    match error.kind() {
        cpal::ErrorKind::PermissionDenied => CaptureError::PermissionDenied,
        cpal::ErrorKind::DeviceNotAvailable => CaptureError::DeviceUnavailable,
        _ => CaptureError::DeviceUnavailable,
    }
}

/// 麦克风采样处理器：降混并重采样为 PCM16 单声道。
struct MicrophoneProcessor {
    /// 流式重采样器。
    resampler: StreamingPcm16Resampler,
    /// 归一化后的交错采样缓冲。
    normalized: Vec<f32>,
    /// 单次回调允许的最大采样数。
    max_samples: usize,
}

impl MicrophoneProcessor {
    /// 创建采样处理器。
    ///
    /// # 参数
    /// - `rate`：输入采样率。
    /// - `channels`：输入声道数。
    /// - `target_rate`：目标采样率。
    ///
    /// # 返回值
    /// 处理器；参数非法时返回错误。
    fn new(rate: u32, channels: usize, target_rate: u32) -> Result<Self, CaptureError> {
        Ok(Self {
            resampler: StreamingPcm16Resampler::new(rate, target_rate, channels)?,
            normalized: Vec::new(),
            max_samples: rate as usize * channels * MAX_CALLBACK_MS / 1000,
        })
    }

    /// 处理一次原生回调的数据。
    ///
    /// # 参数
    /// - `data`：原生采样。
    /// - `normalize`：把原生采样转换为 f32 的函数。
    ///
    /// # 返回值
    /// 本次可输出的 i16 采样块；回调过大时返回错误。
    fn process<T: Sample>(
        &mut self,
        data: &[T],
        normalize: &impl Fn(T) -> f32,
    ) -> Result<Vec<Vec<i16>>, CaptureError> {
        if data.len() > self.max_samples {
            return Err(CaptureError::DeviceUnavailable);
        }
        self.normalized.extend(data.iter().copied().map(normalize));
        let buffers = self
            .resampler
            .push_interleaved(&self.normalized)
            .map(|buffers| {
                buffers
                    .into_iter()
                    .map(|bytes| super::pcm::decode_i16(&bytes))
                    .collect()
            });
        self.normalized.clear();
        buffers
    }
}

/// 构建 cpal 输入流。
///
/// # 参数
/// - `device`：输入设备。
/// - `config`：流配置。
/// - `paused`：暂停标志。
/// - `running`：运行标志。
/// - `sink`：PCM16 输出通道。
/// - `processor`：采样处理器。
/// - `errors`：运行期间设备故障的错误发送端。
/// - `normalize`：采样归一化函数。
///
/// # 返回值
/// 已构建的输入流。
fn build_stream<T: SizedSample>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    paused: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    sink: tokio::sync::mpsc::Sender<Vec<i16>>,
    mut processor: MicrophoneProcessor,
    errors: tokio::sync::mpsc::UnboundedSender<CaptureError>,
    normalize: impl Fn(T) -> f32 + Send + 'static,
) -> Result<cpal::Stream, CaptureError> {
    let error_running = Arc::clone(&running);
    let error_events = errors.clone();
    let sink_running = Arc::clone(&running);
    let sink_errors = errors;
    let mut consecutive_sink_fulls = 0;
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                if !running.load(Ordering::SeqCst) || paused.load(Ordering::SeqCst) {
                    return;
                }
                let buffers = match processor.process(data, &normalize) {
                    Ok(buffers) => buffers,
                    Err(_) => return,
                };
                for pcm in buffers {
                    if !running.load(Ordering::SeqCst) {
                        return;
                    }
                    if pcm.is_empty() {
                        continue;
                    }
                    if super::handle_capture_sink_result(
                        sink.try_send(pcm),
                        &mut consecutive_sink_fulls,
                        &sink_running,
                        &sink_errors,
                        "microphone",
                    ) {
                        return;
                    }
                }
            },
            move |_error| {
                super::report_unexpected_capture_failure(
                    &error_running,
                    &error_events,
                    CaptureError::DeviceUnavailable,
                );
                error_running.store(false, Ordering::SeqCst);
            },
            None,
        )
        .map_err(map_native_error)
}

/// 检查并请求 macOS 麦克风权限。
///
/// # 参数
/// - `running`：运行标志，用于在等待授权时响应取消。
///
/// # 返回值
/// 已授权返回 `Ok(())`，拒绝返回 [`CaptureError::PermissionDenied`]。
#[cfg(target_os = "macos")]
fn request_microphone_permission(running: &Arc<AtomicBool>) -> Result<(), CaptureError> {
    use objc2::runtime::Bool;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    // 加载 AVFoundation 以注册 AVCaptureDevice；只请求音频媒体类型。
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeAudio: &'static NSString;
    }
    // SAFETY: AVFoundation 文档化的类方法接受 NSString 媒体类型，返回 NSInteger
    // 授权状态，并拷贝 completion block。
    unsafe {
        let media_type = AVMediaTypeAudio;
        let status: isize =
            msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: media_type];
        match status {
            3 => return Ok(()), // AVAuthorizationStatusAuthorized
            1 | 2 => return Err(CaptureError::PermissionDenied),
            0 => {} // AVAuthorizationStatusNotDetermined
            _ => return Err(CaptureError::PermissionDenied),
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let completion = block2::RcBlock::new(move |granted: Bool| {
            let _ = tx.try_send(granted.as_bool());
        });
        let _: () = msg_send![
            class!(AVCaptureDevice),
            requestAccessForMediaType: media_type,
            completionHandler: &*completion
        ];
        loop {
            if !running.load(Ordering::SeqCst) {
                return Err(CaptureError::DeviceUnavailable);
            }
            match rx.recv_timeout(POLL_INTERVAL) {
                Ok(true) => return Ok(()),
                Ok(false) => return Err(CaptureError::PermissionDenied),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err(CaptureError::DeviceUnavailable),
            }
        }
    }
}

/// 非 macOS 平台不提供麦克风采集。
///
/// # 参数
/// - `_running`：运行标志。
///
/// # 返回值
/// 始终返回不支持错误。
#[cfg(not(target_os = "macos"))]
fn request_microphone_permission(_running: &Arc<AtomicBool>) -> Result<(), CaptureError> {
    Err(CaptureError::Unsupported)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microphone_converts_stereo_integer_input_to_mono_pcm() {
        let mut processor = MicrophoneProcessor::new(24_000, 2, 24_000).unwrap();
        let pcm = processor
            .process(&[16_384_i16, 0, -16_384, 0], &f32::from_sample)
            .unwrap();
        let samples = pcm.concat();
        assert_eq!(samples.len(), 2);
        assert!((samples[0] - 8_192).abs() <= 1);
        assert!((samples[1] + 8_192).abs() <= 1);
        assert!(processor.normalized.is_empty());
    }

    #[test]
    fn oversized_native_callback_is_rejected_before_copying() {
        let mut processor = MicrophoneProcessor::new(24_000, 1, 24_000).unwrap();
        let oversized = vec![0.0_f32; 24_000 * 250 / 1000 + 1];
        assert!(matches!(
            processor.process(&oversized, &|sample| sample),
            Err(CaptureError::DeviceUnavailable)
        ));
        assert!(processor.normalized.is_empty());
    }

    #[test]
    fn native_errors_remain_permission_specific() {
        assert_eq!(
            map_native_error(cpal::Error::new(cpal::ErrorKind::PermissionDenied)),
            CaptureError::PermissionDenied
        );
        assert_eq!(
            map_native_error(cpal::Error::new(cpal::ErrorKind::DeviceNotAvailable)),
            CaptureError::DeviceUnavailable
        );
    }
}
