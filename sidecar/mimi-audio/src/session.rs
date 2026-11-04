//! 实时字幕会话管理：驱动音频采集与实时 ASR，归并 partial/final 事件。

use std::sync::Arc;

use tokio::sync::mpsc;

use crate::asr::{AsrClient, AsrError, AsrEvent};
use crate::audio::{AudioCapture, CaptureError, CaptureHandle};
use crate::protocol::{AsrProvider, AudioSource, Command, ErrorCode, Event, RunState};
use crate::reducer::{ReducedEvent, SubtitleReducer};

/// 计算一段 PCM16 采样的均方根电平，归一化到 0–1。
///
/// # 参数
/// - `pcm`：单声道 PCM16 采样。
///
/// # 返回值
/// 归一化 RMS 电平；空输入返回 0。
fn pcm_rms(pcm: &[i16]) -> f32 {
    if pcm.is_empty() {
        return 0.0;
    }
    let sum: f64 = pcm.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
    let mean = sum / pcm.len() as f64;
    (mean.sqrt() / f64::from(i16::MAX)).min(1.0) as f32
}

/// 会话管理器：同一时刻只允许一个活动会话。
pub struct SessionManager {
    /// 事件输出通道。
    events: mpsc::Sender<Event>,
    /// 当前活动采集句柄。
    capture: Option<CaptureHandle>,
    /// 当前活动 ASR 客户端任务。
    asr_task: Option<tokio::task::JoinHandle<()>>,
    /// 当前采集任务。
    capture_task: Option<tokio::task::JoinHandle<()>>,
    /// partial/final 归并状态机。
    reducer: SubtitleReducer,
    /// 当前运行状态。
    state: RunState,
    /// 当前会话是否已进入 running。
    ready: bool,
}

impl SessionManager {
    /// 创建会话管理器。
    ///
    /// # 参数
    /// - `events`：向 stdout 事件泵发送事件的通道。
    ///
    /// # 返回值
    /// 处于 stopped 状态的管理器。
    pub fn new(events: mpsc::Sender<Event>) -> Self {
        Self {
            events,
            capture: None,
            asr_task: None,
            capture_task: None,
            reducer: SubtitleReducer::new(),
            state: RunState::Stopped,
            ready: false,
        }
    }

    /// 处理主进程下发的一条控制命令。
    ///
    /// # 参数
    /// - `command`：已解析的控制命令。
    ///
    /// # 返回值
    /// 无返回值。
    pub async fn handle_command(&mut self, command: Command) {
        match command {
            Command::Start { source, asr, lang } => self.start(source, asr, lang).await,
            Command::Pause => self.pause().await,
            Command::Resume => self.resume().await,
            Command::Stop => self.stop().await,
        }
    }

    /// 启动一次采集与识别会话。
    ///
    /// # 参数
    /// - `source`：音频来源。
    /// - `asr`：实时 ASR 提供商。
    /// - `lang`：识别语言。
    ///
    /// # 返回值
    /// 无返回值。
    async fn start(&mut self, source: AudioSource, asr: AsrProvider, lang: String) {
        self.stop().await;
        self.reducer.reset();

        // 采集前先做无副作用权限预检，未授权时直接给出可恢复的结构化错误，
        // 避免先建立网络连接再因权限失败。
        if let Err(error) = AudioCapture::check_permission(source) {
            self.report_capture_error(error).await;
            return;
        }

        let client = match AsrClient::connect(asr, &lang).await {
            Ok(client) => Arc::new(client),
            Err(error) => {
                self.report_asr_error(error).await;
                return;
            }
        };

        let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<i16>>(64);
        let mut capture = match AudioCapture::start(source, audio_tx).await {
            Ok(handle) => handle,
            Err(error) => {
                self.report_capture_error(error).await;
                return;
            }
        };
        let capture_errors = capture.take_error_receiver();

        // ASR 上行任务：把采集到的 PCM 推送给提供商。
        let upstream = client.clone();
        let level_events = self.events.clone();
        let asr_task = tokio::spawn(async move {
            while let Some(pcm) = audio_rx.recv().await {
                // 音频电平只做本地计算，用于界面反馈，不进入协议音频通道。
                let rms = pcm_rms(&pcm);
                let _ = level_events.try_send(Event::Level { rms });
                if upstream.push_audio(&pcm).await.is_err() {
                    break;
                }
            }
        });

        // 下行任务：接收识别事件并归并后输出。连接关闭或出错时把采集
        // 运行标志置假，让采集线程自行退出并释放原生资源。
        let capture_running = capture.running_flag();
        let events = self.events.clone();
        let mut reducer = SubtitleReducer::new();
        let mut downstream = client.subscribe();
        let downstream_task = tokio::spawn(async move {
            let mut capture_errors = capture_errors;
            let failure = loop {
                tokio::select! {
                    event = downstream.recv() => {
                        let event = match event {
                            Ok(event) => event,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break None,
                        };
                        match event {
                            AsrEvent::Partial { text, lang } => {
                                if let ReducedEvent::Partial(text) = reducer.push_partial(&text) {
                                    let _ = events.send(Event::Partial { text, lang }).await;
                                }
                            }
                            AsrEvent::Final { text, lang } => {
                                if let ReducedEvent::Final(text) = reducer.push_final(&text) {
                                    let _ = events.send(Event::Final { text, lang }).await;
                                }
                            }
                            AsrEvent::Error { error } => {
                                // 连接或服务端错误：上报结构化错误并结束本次会话，
                                // 已展示的字幕由主进程保留，不在此清空。
                                break Some(asr_error_event(error));
                            }
                        }
                    }
                    error = async {
                        match capture_errors.as_mut() {
                            Some(receiver) => receiver.recv().await,
                            None => std::future::pending().await,
                        }
                    } => {
                        if let Some(error) = error {
                            break Some(Event::Error {
                                code: ErrorCode::DeviceUnavailable,
                                message: Some(error.to_string()),
                            });
                        }
                        capture_errors = None;
                    }
                }
            };
            if let Some(error) = failure {
                let _ = events.send(error).await;
            }
            // 连接关闭或出错后停止采集并通知主进程回到停止状态，
            // 避免采集线程在 ASR 已断开后继续空转。
            capture_running.store(false, std::sync::atomic::Ordering::SeqCst);
            let _ = events
                .send(Event::Status {
                    state: RunState::Stopped,
                })
                .await;
        });

        self.capture = Some(capture);
        self.capture_task = Some(downstream_task);
        self.asr_task = Some(asr_task);
        self.state = RunState::Running;
        self.ready = true;
        let _ = self.events.send(Event::Ready).await;
        let _ = self
            .events
            .send(Event::Status {
                state: RunState::Running,
            })
            .await;
    }

    /// 暂停当前会话。
    ///
    /// # 返回值
    /// 无返回值。
    async fn pause(&mut self) {
        if self.state != RunState::Running {
            return;
        }
        if let Some(capture) = &self.capture {
            capture.pause();
        }
        self.state = RunState::Paused;
        let _ = self
            .events
            .send(Event::Status {
                state: RunState::Paused,
            })
            .await;
    }

    /// 恢复当前会话。
    ///
    /// # 返回值
    /// 无返回值。
    async fn resume(&mut self) {
        if self.state != RunState::Paused {
            return;
        }
        if let Some(capture) = &self.capture {
            capture.resume();
        }
        self.state = RunState::Running;
        let _ = self
            .events
            .send(Event::Status {
                state: RunState::Running,
            })
            .await;
    }

    /// 停止当前会话并释放采集设备与网络连接。
    ///
    /// Whisper 按约 4 秒窗口批量转写；用户停止时，最后一个不足 4 秒的窗口
    /// 会随任务取消而丢弃。这是实时字幕优先降低停止延迟的既定行为。
    ///
    /// # 返回值
    /// 无返回值。
    pub async fn stop(&mut self) {
        if let Some(capture) = self.capture.take() {
            capture.stop();
        }
        if let Some(task) = self.capture_task.take() {
            task.abort();
        }
        if let Some(task) = self.asr_task.take() {
            task.abort();
        }
        let was_active = self.ready || self.state != RunState::Stopped;
        self.ready = false;
        self.state = RunState::Stopped;
        if was_active {
            let _ = self
                .events
                .send(Event::Status {
                    state: RunState::Stopped,
                })
                .await;
        }
    }

    /// 应用退出时释放全部资源。
    ///
    /// # 返回值
    /// 无返回值。
    pub async fn shutdown(&mut self) {
        self.stop().await;
    }

    /// 上报采集错误。
    ///
    /// # 参数
    /// - `error`：采集错误。
    ///
    /// # 返回值
    /// 无返回值。
    async fn report_capture_error(&self, error: CaptureError) {
        let code = match error {
            CaptureError::PermissionDenied => ErrorCode::PermissionDenied,
            CaptureError::DeviceUnavailable => ErrorCode::DeviceUnavailable,
            CaptureError::Unsupported => ErrorCode::Unknown,
        };
        let _ = self
            .events
            .send(Event::Error {
                code,
                message: Some(error.to_string()),
            })
            .await;
    }

    /// 上报 ASR 错误。
    ///
    /// # 参数
    /// - `error`：ASR 错误。
    ///
    /// # 返回值
    /// 无返回值。
    async fn report_asr_error(&self, error: AsrError) {
        let code = match error {
            AsrError::Auth => ErrorCode::Auth,
            AsrError::Network => ErrorCode::Network,
            AsrError::InvalidRequest => ErrorCode::InvalidRequest,
            AsrError::DeviceUnavailable => ErrorCode::DeviceUnavailable,
        };
        let _ = self
            .events
            .send(Event::Error {
                code,
                message: Some(error.to_string()),
            })
            .await;
    }
}

/// 把 ASR 错误转换为 sidecar 输出事件。
///
/// # 参数
/// - `error`：ASR 错误。
///
/// # 返回值
/// 带稳定错误分类的输出事件。
///
/// @author zhenghq
fn asr_error_event(error: AsrError) -> Event {
    let code = match error {
        AsrError::Auth => ErrorCode::Auth,
        AsrError::Network => ErrorCode::Network,
        AsrError::InvalidRequest => ErrorCode::InvalidRequest,
        AsrError::DeviceUnavailable => ErrorCode::DeviceUnavailable,
    };
    Event::Error {
        code,
        message: Some(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rms_is_normalized_and_handles_empty_input() {
        assert_eq!(pcm_rms(&[]), 0.0);
        assert_eq!(pcm_rms(&[0, 0, 0]), 0.0);
        assert!((pcm_rms(&[i16::MAX, i16::MAX]) - 1.0).abs() < 1e-6);
    }
}
