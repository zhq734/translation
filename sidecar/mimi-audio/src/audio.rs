//! 音频采集抽象与 macOS 实现。
//!
//! 移植自 Mimi 的 `src-tauri/src/audio/macos*.rs` 与 `microphone.rs`（MIT，
//! Copyright (c) 2026 yuxino），去除 Tauri 运行时依赖。系统声音走 Core Audio
//! Process Tap（macOS 14.2+），麦克风走 cpal。采集到的 PCM 统一降混、重采样为
//! 24 kHz 单声道 i16，原始数据不进入协议层。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;

use crate::protocol::AudioSource;

pub mod pcm;

/// 音频输出队列连续塞满的最大容忍次数。
///
/// 队列短暂塞满可能只是上层任务调度抖动；持续塞满通常意味着上行消费已卡住，
/// 此时继续静默丢包会让界面长期停在 running 却不再产生字幕，因此必须上报
/// 设备故障并交由主进程重建会话。
const MAX_CONSECUTIVE_SINK_FULLS: u32 = 8;

#[cfg(target_os = "macos")]
mod macos_tap;
#[cfg(target_os = "macos")]
mod microphone;
pub(crate) mod streaming_resampler;

/// 采集错误分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CaptureError {
    /// 缺少系统录音/屏幕录制或麦克风权限。
    #[error("audio capture permission denied")]
    PermissionDenied,
    /// 音频设备不可用。
    #[error("audio device unavailable")]
    DeviceUnavailable,
    /// 当前平台或系统版本不支持采集。
    #[error("audio capture unsupported")]
    Unsupported,
}

/// 在采集线程意外失败时向会话层上报错误。
///
/// 主动停止会先把运行标志置假，此时不再上报，避免用户停止字幕时出现误报。
///
/// # 参数
/// - `running`：采集运行标志。
/// - `errors`：采集错误发送端。
/// - `error`：采集线程遇到的错误。
///
/// # 返回值
/// 无返回值。
///
/// @author zhenghq
fn report_unexpected_capture_failure(
    running: &AtomicBool,
    errors: &mpsc::UnboundedSender<CaptureError>,
    error: CaptureError,
) {
    if running.load(Ordering::SeqCst) {
        let _ = errors.send(error);
    }
}

/// 处理一次采集音频入队结果，并在输出通道不可恢复时停止采集。
///
/// # 参数
/// - `result`：有界音频队列的非阻塞发送结果。
/// - `consecutive_full`：当前连续队列塞满次数，会在成功发送后清零。
/// - `running`：采集运行标志。
/// - `errors`：采集错误发送端。
/// - `source`：日志中使用的采集来源名称。
///
/// # 返回值
/// 需要立即结束采集时返回 `true`。
///
/// @author zhenghq
fn handle_capture_sink_result(
    result: Result<(), mpsc::error::TrySendError<Vec<i16>>>,
    consecutive_full: &mut u32,
    running: &AtomicBool,
    errors: &mpsc::UnboundedSender<CaptureError>,
    source: &str,
) -> bool {
    match result {
        Ok(()) => {
            *consecutive_full = 0;
            false
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            tracing::warn!(source, "audio sink closed; stopping capture");
            report_unexpected_capture_failure(running, errors, CaptureError::DeviceUnavailable);
            running.store(false, Ordering::SeqCst);
            true
        }
        Err(mpsc::error::TrySendError::Full(_)) => {
            *consecutive_full = consecutive_full.saturating_add(1);
            if *consecutive_full < MAX_CONSECUTIVE_SINK_FULLS {
                tracing::warn!(source, "audio sink full; dropping buffer");
                return false;
            }
            tracing::warn!(
                source,
                consecutive_full = *consecutive_full,
                "audio sink remained full; stopping capture"
            );
            report_unexpected_capture_failure(running, errors, CaptureError::DeviceUnavailable);
            running.store(false, Ordering::SeqCst);
            true
        }
    }
}

/// 活动采集句柄，负责暂停、恢复与停止。
pub struct CaptureHandle {
    /// 暂停标志。
    paused: Arc<AtomicBool>,
    /// 运行标志。
    running: Arc<AtomicBool>,
    /// 采集线程句柄，用于停止时等待资源释放。
    threads: Vec<std::thread::JoinHandle<()>>,
    /// 采集线程运行期间上报的错误；会话层启动后取走并监听。
    capture_errors: Option<mpsc::UnboundedReceiver<CaptureError>>,
}

impl CaptureHandle {
    /// 返回采集运行标志的共享句柄，供上层在连接断开时主动停止采集。
    ///
    /// # 返回值
    /// 与采集线程共享的运行标志。
    pub fn running_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.running)
    }

    /// 取走采集错误接收端，供会话层监听运行期间的设备故障。
    ///
    /// # 返回值
    /// 首次调用返回接收端，后续调用返回 `None`。
    ///
    /// @author zhenghq
    pub fn take_error_receiver(&mut self) -> Option<mpsc::UnboundedReceiver<CaptureError>> {
        self.capture_errors.take()
    }

    /// 暂停采集，丢弃暂停期间的音频。
    ///
    /// # 返回值
    /// 无返回值。
    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }

    /// 恢复采集，不重放暂停期间的音频。
    ///
    /// # 返回值
    /// 无返回值。
    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
    }

    /// 停止采集并等待原生资源释放。
    ///
    /// # 返回值
    /// 无返回值。
    pub fn stop(mut self) {
        self.running.store(false, Ordering::SeqCst);
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

/// 音频采集入口。
pub struct AudioCapture;

impl AudioCapture {
    /// 按来源启动采集，把 24 kHz 单声道 i16 PCM 送入通道。
    ///
    /// # 参数
    /// - `source`：音频来源选择。
    /// - `sink`：PCM 输出通道。
    ///
    /// # 返回值
    /// 活动采集句柄；失败时返回分类错误。
    pub async fn start(
        source: AudioSource,
        sink: mpsc::Sender<Vec<i16>>,
    ) -> Result<CaptureHandle, CaptureError> {
        platform::start(source, sink).await
    }

    /// 预检给定来源所需的系统权限，未授权时给出结构化错误。
    ///
    /// # 参数
    /// - `source`：音频来源选择。
    ///
    /// # 返回值
    /// 全部所需权限已授予时返回 `Ok(())`，否则返回分类错误。
    pub fn check_permission(source: AudioSource) -> Result<(), CaptureError> {
        platform::check_permission(source)
    }
}

#[cfg(target_os = "macos")]
mod platform {
    //! macOS 采集实现：系统声音走 Core Audio Tap，麦克风走 cpal。

    use super::*;

    /// 按来源启动采集。
    ///
    /// # 参数
    /// - `source`：音频来源。
    /// - `sink`：PCM 输出通道。
    ///
    /// # 返回值
    /// 活动采集句柄；失败时返回分类错误。
    pub async fn start(
        source: AudioSource,
        sink: mpsc::Sender<Vec<i16>>,
    ) -> Result<CaptureHandle, CaptureError> {
        let paused = Arc::new(AtomicBool::new(false));
        let running = Arc::new(AtomicBool::new(true));
        let (capture_errors_tx, capture_errors_rx) = mpsc::unbounded_channel();
        let mut threads = Vec::new();

        // 逐个启动来源；任一来源失败时立即停止并回收已启动的线程，避免残留采集。
        let mut start_one = |result: Result<std::thread::JoinHandle<()>, CaptureError>| match result
        {
            Ok(handle) => {
                threads.push(handle);
                Ok(())
            }
            Err(error) => Err(error),
        };
        let outcome = match source {
            AudioSource::System => start_one(spawn_system(
                sink.clone(),
                paused.clone(),
                running.clone(),
                capture_errors_tx.clone(),
            )),
            AudioSource::Microphone => start_one(spawn_microphone(
                sink.clone(),
                paused.clone(),
                running.clone(),
                capture_errors_tx.clone(),
            )),
            AudioSource::Both => start_one(spawn_system(
                sink.clone(),
                paused.clone(),
                running.clone(),
                capture_errors_tx.clone(),
            ))
            .and_then(|()| {
                start_one(spawn_microphone(
                    sink,
                    paused.clone(),
                    running.clone(),
                    capture_errors_tx.clone(),
                ))
            }),
        };
        if let Err(error) = outcome {
            running.store(false, Ordering::SeqCst);
            for thread in threads.drain(..) {
                let _ = thread.join();
            }
            return Err(error);
        }

        Ok(CaptureHandle {
            paused,
            running,
            threads,
            capture_errors: Some(capture_errors_rx),
        })
    }

    /// 预检 macOS 采集权限：系统声音需要屏幕录制权限。
    ///
    /// # 参数
    /// - `source`：音频来源。
    ///
    /// # 返回值
    /// 权限齐备时返回 `Ok(())`，否则返回分类错误。
    pub fn check_permission(source: AudioSource) -> Result<(), CaptureError> {
        let needs_system = matches!(source, AudioSource::System | AudioSource::Both);
        if needs_system {
            if !super::macos_tap::is_available() {
                return Err(CaptureError::Unsupported);
            }
            // 未授权时先触发一次系统授权请求；用户拒绝后只能到系统设置手动开启。
            if !super::macos_tap::has_system_audio_permission()
                && !super::macos_tap::request_system_audio_permission()
            {
                return Err(CaptureError::PermissionDenied);
            }
        }
        Ok(())
    }

    /// 启动系统声音采集线程。
    ///
    /// # 参数
    /// - `sink`：PCM 输出通道。
    /// - `paused`：暂停标志。
    /// - `running`：运行标志。
    ///
    /// # 返回值
    /// 采集线程句柄；启动失败时返回分类错误。
    fn spawn_system(
        sink: mpsc::Sender<Vec<i16>>,
        paused: Arc<AtomicBool>,
        running: Arc<AtomicBool>,
        errors: mpsc::UnboundedSender<CaptureError>,
    ) -> Result<std::thread::JoinHandle<()>, CaptureError> {
        if !super::macos_tap::is_available() {
            return Err(CaptureError::Unsupported);
        }
        super::macos_tap::start(sink, paused, running, errors)
    }

    /// 启动麦克风采集线程。
    ///
    /// # 参数
    /// - `sink`：PCM 输出通道。
    /// - `paused`：暂停标志。
    /// - `running`：运行标志。
    ///
    /// # 返回值
    /// 采集线程句柄；启动失败时返回分类错误。
    fn spawn_microphone(
        sink: mpsc::Sender<Vec<i16>>,
        paused: Arc<AtomicBool>,
        running: Arc<AtomicBool>,
        errors: mpsc::UnboundedSender<CaptureError>,
    ) -> Result<std::thread::JoinHandle<()>, CaptureError> {
        super::microphone::start(sink, paused, running, errors)
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    //! 非 macOS 平台占位：首版只交付 macOS。
    use super::*;

    /// 非 macOS 平台不支持采集。
    ///
    /// # 参数
    /// - `_source`：音频来源。
    /// - `_sink`：PCM 输出通道。
    ///
    /// # 返回值
    /// 始终返回不支持错误。
    pub async fn start(
        _source: AudioSource,
        _sink: mpsc::Sender<Vec<i16>>,
    ) -> Result<CaptureHandle, CaptureError> {
        Err(CaptureError::Unsupported)
    }

    /// 非 macOS 平台不支持任何采集权限。
    ///
    /// # 参数
    /// - `_source`：音频来源。
    ///
    /// # 返回值
    /// 始终返回不支持错误。
    pub fn check_permission(_source: AudioSource) -> Result<(), CaptureError> {
        Err(CaptureError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 校验非主动退出只在采集仍处于运行状态时上报，避免用户停止时误报设备故障。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn unexpected_capture_failure_is_reported_only_while_running() {
        let (error_tx, mut error_rx) = mpsc::unbounded_channel();
        let running = AtomicBool::new(true);

        report_unexpected_capture_failure(&running, &error_tx, CaptureError::DeviceUnavailable);
        assert_eq!(error_rx.try_recv(), Ok(CaptureError::DeviceUnavailable));

        running.store(false, Ordering::SeqCst);
        report_unexpected_capture_failure(&running, &error_tx, CaptureError::DeviceUnavailable);
        assert!(error_rx.try_recv().is_err());
    }

    #[test]
    fn capture_error_maps_to_stable_messages() {
        assert_eq!(
            CaptureError::PermissionDenied.to_string(),
            "audio capture permission denied"
        );
        assert_eq!(
            CaptureError::DeviceUnavailable.to_string(),
            "audio device unavailable"
        );
    }

    /// 校验采集输出通道关闭时会立即上报设备故障并停止采集。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn closed_capture_sink_reports_device_failure_immediately() {
        let (error_tx, mut error_rx) = mpsc::unbounded_channel();
        let running = AtomicBool::new(true);
        let mut consecutive_full = 0;

        let should_stop = handle_capture_sink_result(
            Err(mpsc::error::TrySendError::Closed(Vec::<i16>::new())),
            &mut consecutive_full,
            &running,
            &error_tx,
            "test",
        );

        assert!(should_stop);
        assert!(!running.load(Ordering::SeqCst));
        assert_eq!(error_rx.try_recv(), Ok(CaptureError::DeviceUnavailable));
    }

    /// 校验短暂队列塞满不会触发重连，成功发送后连续失败计数会清零。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn transient_capture_sink_full_is_tolerated_and_resets() {
        let (error_tx, mut error_rx) = mpsc::unbounded_channel();
        let running = AtomicBool::new(true);
        let mut consecutive_full = 0;

        for _ in 0..(MAX_CONSECUTIVE_SINK_FULLS - 1) {
            assert!(!handle_capture_sink_result(
                Err(mpsc::error::TrySendError::Full(Vec::<i16>::new())),
                &mut consecutive_full,
                &running,
                &error_tx,
                "test",
            ));
        }
        assert!(running.load(Ordering::SeqCst));
        assert!(error_rx.try_recv().is_err());

        assert!(!handle_capture_sink_result(
            Ok(()),
            &mut consecutive_full,
            &running,
            &error_tx,
            "test",
        ));
        assert_eq!(consecutive_full, 0);
    }

    /// 校验输出通道持续塞满超过阈值时会停止采集并上报设备故障。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn persistent_capture_sink_full_reports_device_failure_once() {
        let (error_tx, mut error_rx) = mpsc::unbounded_channel();
        let running = AtomicBool::new(true);
        let mut consecutive_full = 0;
        let mut should_stop = false;

        for _ in 0..MAX_CONSECUTIVE_SINK_FULLS {
            should_stop = handle_capture_sink_result(
                Err(mpsc::error::TrySendError::Full(Vec::<i16>::new())),
                &mut consecutive_full,
                &running,
                &error_tx,
                "test",
            );
        }

        assert!(should_stop);
        assert!(!running.load(Ordering::SeqCst));
        assert_eq!(error_rx.try_recv(), Ok(CaptureError::DeviceUnavailable));
        assert!(error_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn non_macos_capture_is_unsupported() {
        if cfg!(target_os = "macos") {
            return;
        }
        let (tx, _rx) = mpsc::channel(1);
        assert!(matches!(
            AudioCapture::start(AudioSource::System, tx).await,
            Err(CaptureError::Unsupported)
        ));
    }
}
