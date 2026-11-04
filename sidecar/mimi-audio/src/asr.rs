//! Deepgram 与 Whisper 实时 ASR 客户端。
//!
//! 音频采集与文本归并沿用 Mimi（MIT，Copyright (c) 2026 yuxino）的移植实现；
//! 本模块把 24 kHz PCM16 音频送入 Deepgram WebSocket 或本地 OpenAI 兼容 Whisper
//! 转写接口，并把识别事件转换为 sidecar 内部事件。翻译始终由宿主应用的多通道
//! 翻译管道完成。

use futures_util::{SinkExt, StreamExt};
use reqwest::multipart::{Form, Part};
use tokio::sync::{broadcast, Mutex};
use tokio::time::{interval, Duration, MissedTickBehavior};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::protocol::AsrProvider;

/// ASR 错误分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AsrError {
    /// Deepgram 鉴权失败。
    #[error("asr authentication failed")]
    Auth,
    /// 网络连接失败。
    #[error("asr network failure")]
    Network,
    /// 请求参数被 ASR 服务拒绝。
    #[error("asr request rejected")]
    InvalidRequest,
    /// 设备或端点不可用。
    #[error("asr endpoint unavailable")]
    DeviceUnavailable,
}

/// ASR 下行事件。
#[derive(Debug, Clone, PartialEq)]
pub enum AsrEvent {
    /// 可能被修正的临时识别文本。
    Partial {
        /// 识别原文。
        text: String,
        /// 识别语言（可选）。
        lang: Option<String>,
    },
    /// 已提交的稳定识别文本。
    Final {
        /// 识别原文。
        text: String,
        /// 识别语言（可选）。
        lang: Option<String>,
    },
    /// 连接或服务端错误，需要由会话层上报给主进程。
    Error {
        /// 结构化错误分类。
        error: AsrError,
    },
}

/// Deepgram WebSocket 端点。
const DEEPGRAM_LISTEN_URL: &str = "wss://api.deepgram.com/v1/listen";

/// Deepgram 默认识别模型。
const DEEPGRAM_MODEL: &str = "nova-3";

/// Deepgram 空闲连接保活间隔。
///
/// Deepgram 会在约 10 秒无数据时关闭 WebSocket；切换视频或暂停播放期间
/// 系统音频可能长时间静音，因此必须主动发送应用层 KeepAlive。
const DEEPGRAM_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(8);

/// 单次 WebSocket 写入的最长等待时间。
///
/// 底层连接处于半开状态时，`SinkExt::send` 可能永久等待可写；若不加超时，
/// 上行任务会一直占用音频消费端，采集队列随后持续塞满。
const DEEPGRAM_SEND_TIMEOUT: Duration = Duration::from_secs(5);

/// Whisper 单次转写窗口的最短采样数（24 kHz、2 秒）。
///
/// 短于该时长时即使检测到停顿也继续累积，避免把词句切得过碎。
const WHISPER_MIN_WINDOW_SAMPLES: usize = 48_000;

/// Whisper 滚动预览间隔对应的采样数（24 kHz、1.5 秒）。
///
/// 预览只用于尽快显示临时原文；连续语音仍会继续累积到完整窗口后再定稿。
const WHISPER_PREVIEW_INTERVAL_SAMPLES: usize = 36_000;

/// Whisper 单次转写窗口的最长采样数（24 kHz、4 秒）。
///
/// 新闻等连续语音可能长时间没有明显停顿，必须用最长窗口限制字幕延迟。
const WHISPER_MAX_WINDOW_SAMPLES: usize = 96_000;

/// Whisper 句尾静音判定使用的采样数（24 kHz、350 毫秒）。
const WHISPER_SILENCE_TAIL_SAMPLES: usize = 8_400;

/// Whisper 句尾静音判定阈值；低于该 RMS 视为当前句已经结束。
const WHISPER_SILENCE_RMS_THRESHOLD: f64 = 0.008;

/// 判定窗口内确实存在人声的峰值阈值，避免将纯静音送给模型产生幻觉。
const WHISPER_SPEECH_PEAK_THRESHOLD: i16 = 800;

/// Whisper 批量转写请求超时。
const WHISPER_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// 下行事件通道容量。
const EVENT_CAPACITY: usize = 128;

/// 实时 ASR 客户端句柄。
pub struct AsrClient {
    /// 上行音频发送端。
    upstream: Mutex<Option<tokio::sync::mpsc::Sender<Vec<i16>>>>,
    /// 下行事件广播端。
    downstream: broadcast::Sender<AsrEvent>,
    /// 后台连接任务。
    task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl AsrClient {
    /// 连接所选实时识别服务。
    ///
    /// # 参数
    /// - `provider`：实时 ASR 提供商。
    /// - `lang`：识别语言，`auto` 表示自动检测。
    ///
    /// # 返回值
    /// 已就绪的客户端；失败时返回分类错误。
    pub async fn connect(provider: AsrProvider, lang: &str) -> Result<Self, AsrError> {
        match provider {
            AsrProvider::Deepgram => Self::connect_deepgram(lang).await,
            AsrProvider::Whisper => Self::connect_whisper(lang).await,
        }
    }

    /// 连接 Deepgram 实时识别服务。
    ///
    /// # 参数
    /// - `lang`：识别语言，`auto` 表示自动检测。
    ///
    /// # 返回值
    /// 已就绪的客户端；失败时返回分类错误。
    async fn connect_deepgram(lang: &str) -> Result<Self, AsrError> {
        let api_key = std::env::var("DEEPGRAM_API_KEY")
            .map_err(|_| AsrError::Auth)?
            .trim()
            .to_string();
        if api_key.is_empty() {
            return Err(AsrError::Auth);
        }

        // 必须先完成 WebSocket 握手，再向会话层返回成功。否则会话层会过早
        // 采集音频并发送 ready，用户在连接已经失败时仍会看到“正在启动”。
        let stream = connect_deepgram(api_key, lang).await?;

        let (downstream, _) = broadcast::channel(EVENT_CAPACITY);
        let (audio_tx, audio_rx) = tokio::sync::mpsc::channel::<Vec<i16>>(64);
        let events = downstream.clone();
        let task = tokio::spawn(async move {
            run_deepgram(stream, audio_rx, events).await;
        });

        Ok(Self {
            upstream: Mutex::new(Some(audio_tx)),
            downstream,
            task: std::sync::Mutex::new(Some(task)),
        })
    }

    /// 连接 OpenAI 兼容的 Whisper 转写服务。
    ///
    /// # 参数
    /// - `lang`：识别语言，`auto` 表示不传 language 参数。
    ///
    /// # 返回值
    /// 已就绪的客户端；失败时返回分类错误。
    async fn connect_whisper(lang: &str) -> Result<Self, AsrError> {
        let base_url = std::env::var("WHISPER_BASE_URL").map_err(|_| AsrError::InvalidRequest)?;
        let model = std::env::var("WHISPER_MODEL").map_err(|_| AsrError::InvalidRequest)?;
        if base_url.trim().is_empty() || model.trim().is_empty() {
            return Err(AsrError::InvalidRequest);
        }
        let endpoint = whisper_transcription_url(&base_url)?;
        let api_key = std::env::var("WHISPER_API_KEY")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let language = whisper_language(lang);

        let (downstream, _) = broadcast::channel(EVENT_CAPACITY);
        let (audio_tx, audio_rx) = tokio::sync::mpsc::channel::<Vec<i16>>(64);
        let events = downstream.clone();
        let task = tokio::spawn(async move {
            run_whisper(endpoint, model, api_key, language, audio_rx, events).await;
        });

        Ok(Self {
            upstream: Mutex::new(Some(audio_tx)),
            downstream,
            task: std::sync::Mutex::new(Some(task)),
        })
    }

    /// 订阅下行识别事件。
    ///
    /// # 返回值
    /// 事件广播接收器。
    pub fn subscribe(&self) -> broadcast::Receiver<AsrEvent> {
        self.downstream.subscribe()
    }

    /// 推送一段 PCM16 单声道音频。
    ///
    /// # 参数
    /// - `pcm`：24 kHz 单声道 i16 采样。
    ///
    /// # 返回值
    /// 通道关闭时返回错误。
    pub async fn push_audio(&self, pcm: &[i16]) -> Result<(), AsrError> {
        // 只在加锁期间克隆发送端，避免音频推送在锁内等待通道腾挪。
        let sender = {
            let guard = self.upstream.lock().await;
            guard.as_ref().cloned()
        };
        let Some(sender) = sender else {
            return Err(AsrError::DeviceUnavailable);
        };
        sender
            .send(pcm.to_vec())
            .await
            .map_err(|_| AsrError::DeviceUnavailable)
    }
}

/// 规范化 Whisper OpenAI 兼容转写端点。
///
/// # 参数
/// - `base_url`：服务 Base URL 或完整转写端点。
///
/// # 返回值
/// 以 `/audio/transcriptions` 结尾的 HTTP(S) URL；非法协议返回错误。
fn whisper_transcription_url(base_url: &str) -> Result<String, AsrError> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| AsrError::InvalidRequest)?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(AsrError::InvalidRequest);
    }
    let path = parsed.path().trim_end_matches('/');
    // whisper.cpp 使用 /inference，其他 OpenAI 兼容服务通常使用
    // /audio/transcriptions；用户填写完整端点时不能再追加路径。
    if path.ends_with("/audio/transcriptions")
        || path.ends_with("/transcriptions")
        || path == "/inference"
    {
        return Ok(trimmed.to_string());
    }
    Ok(format!("{trimmed}/audio/transcriptions"))
}

/// 将界面语言标签映射为 Whisper 接受的短语言代码。
///
/// # 参数
/// - `lang`：界面识别语言，`auto` 表示自动检测。
///
/// # 返回值
/// Whisper 的 language 参数；自动检测时返回 `None`。
fn whisper_language(lang: &str) -> Option<String> {
    let normalized = lang.trim();
    if normalized.is_empty() || normalized.eq_ignore_ascii_case("auto") {
        return None;
    }
    let primary = normalized.split(['-', '_']).next().unwrap_or(normalized);
    Some(primary.to_ascii_lowercase())
}

/// 将 PCM16 单声道采样封装为 24 kHz WAV。
///
/// # 参数
/// - `pcm`：24 kHz 单声道 i16 采样。
///
/// # 返回值
/// 标准 44 字节 WAV 头加小端 PCM16 数据。
fn pcm16_to_wav(pcm: &[i16]) -> Vec<u8> {
    let data_len = (pcm.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&24_000u32.to_le_bytes());
    wav.extend_from_slice(&48_000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for sample in pcm {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

/// 将 Whisper HTTP 状态码映射为稳定错误分类。
///
/// # 参数
/// - `status`：HTTP 状态码。
///
/// # 返回值
/// 对应的 ASR 错误分类。
fn classify_whisper_status(status: u16) -> AsrError {
    match status {
        401 | 403 => AsrError::Auth,
        400 | 404 | 405 | 413 | 415 | 422 | 429 => AsrError::InvalidRequest,
        _ => AsrError::Network,
    }
}

/// 从 Whisper 兼容服务的响应体中提取识别文本。
///
/// # 参数
/// - `body`：服务返回的 JSON 或纯文本响应。
///
/// # 返回值
/// 去除首尾空白后的识别文本；空响应返回空字符串。
///
/// @author zhenghq
fn whisper_response_text(body: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(payload) => payload["text"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string(),
        Err(_) => body.trim().to_string(),
    }
}

/// 判断 Whisper 窗口是否已经可以提交转写。
///
/// # 参数
/// - `window`：当前累积的 PCM 窗口。
///
/// # 返回值
/// 达到最长时长，或达到最短时长且句尾存在足够静音时返回 `true`。
///
/// @author zhenghq
fn whisper_window_ready(window: &[i16]) -> bool {
    if window.len() >= WHISPER_MAX_WINDOW_SAMPLES {
        return true;
    }
    if window.len() < WHISPER_MIN_WINDOW_SAMPLES + WHISPER_SILENCE_TAIL_SAMPLES {
        return false;
    }
    let tail = &window[window.len() - WHISPER_SILENCE_TAIL_SAMPLES..];
    let mean_square = tail
        .iter()
        .map(|sample| {
            let normalized = f64::from(*sample) / f64::from(i16::MAX);
            normalized * normalized
        })
        .sum::<f64>()
        / tail.len() as f64;
    mean_square.sqrt() <= WHISPER_SILENCE_RMS_THRESHOLD
}

/// 判断 Whisper 窗口内是否包含可识别的语音峰值。
///
/// # 参数
/// - `window`：待提交的 PCM 窗口。
///
/// # 返回值
/// 至少有一个采样超过人声峰值阈值时返回 `true`。
///
/// @author zhenghq
fn whisper_window_has_speech(window: &[i16]) -> bool {
    window
        .iter()
        .any(|sample| sample.unsigned_abs() >= WHISPER_SPEECH_PEAK_THRESHOLD as u16)
}

/// 判断当前累积窗口是否应发起一次临时预览转写。
///
/// # 参数
/// - `window`：当前尚未定稿的 PCM 窗口。
/// - `last_preview_samples`：上一次预览时的窗口采样数。
///
/// # 返回值
/// 距上次预览新增至少 1.5 秒语音时返回 `true`。
///
/// @author zhenghq
fn whisper_preview_due(window: &[i16], last_preview_samples: usize) -> bool {
    window.len().saturating_sub(last_preview_samples) >= WHISPER_PREVIEW_INTERVAL_SAMPLES
        && whisper_window_has_speech(window)
}

/// 把新到 PCM 累积成 Whisper 窗口，并在最短时长后根据句尾静音提前提交。
///
/// # 参数
/// - `window`：尚未提交的 PCM 缓冲。
/// - `pending`：等待发送的最新完整窗口。
/// - `pcm`：新到达的 PCM 采样。
///
/// # 返回值
/// 本次调用是否产生了一个待定稿窗口。
///
/// @author zhenghq
fn queue_whisper_window(
    window: &mut Vec<i16>,
    pending: &mut Option<Vec<i16>>,
    pcm: &[i16],
) -> bool {
    let mut queued = false;
    window.extend_from_slice(pcm);
    while whisper_window_ready(window) {
        let chunk_len = window.len().min(WHISPER_MAX_WINDOW_SAMPLES);
        let chunk = window.drain(..chunk_len).collect::<Vec<_>>();
        // 纯静音窗口不发送，否则 Whisper 可能在无声片段输出固定幻觉文本。
        if whisper_window_has_speech(&chunk) {
            *pending = Some(chunk);
            queued = true;
        }
    }
    queued
}

/// 累积 PCM，并在句尾停顿或最长窗口处调用 Whisper 转写。
///
/// # 参数
/// - `endpoint`：完整转写端点。
/// - `model`：模型名称。
/// - `api_key`：可选 Bearer API Key。
/// - `language`：可选语言代码。
/// - `audio_rx`：PCM 上行通道。
/// - `events`：下行事件广播端。
///
/// # 返回值
/// 无返回值。
///
/// @author zhenghq
async fn run_whisper(
    endpoint: String,
    model: String,
    api_key: Option<String>,
    language: Option<String>,
    mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
    events: broadcast::Sender<AsrEvent>,
) {
    let client = match reqwest::Client::builder()
        .timeout(WHISPER_REQUEST_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            let _ = events.send(AsrEvent::Error {
                error: AsrError::Network,
            });
            return;
        }
    };
    let mut window = Vec::<i16>::with_capacity(WHISPER_MAX_WINDOW_SAMPLES);
    let mut pending: Option<Vec<i16>> = None;
    let mut last_preview_samples = 0usize;
    let mut in_flight: Option<tokio::task::JoinHandle<Result<(), AsrError>>> = None;
    let mut audio_closed = false;
    loop {
        if in_flight.is_none() {
            if let Some(chunk) = pending.take() {
                // 同一时间只保留一个 HTTP 转写请求；慢服务期间丢弃更旧的待处理
                // 窗口而不是阻塞采集，避免实时字幕延迟无限增长。
                let request_client = client.clone();
                let request_endpoint = endpoint.clone();
                let request_model = model.clone();
                let request_api_key = api_key.clone();
                let request_language = language.clone();
                let request_events = events.clone();
                in_flight = Some(tokio::spawn(async move {
                    transcribe_whisper_window(
                        &request_client,
                        &request_endpoint,
                        &request_model,
                        request_api_key.as_deref(),
                        request_language.as_deref(),
                        &chunk,
                        &request_events,
                        true,
                    )
                    .await
                }));
                continue;
            }
            if whisper_preview_due(&window, last_preview_samples) {
                let preview = window.clone();
                last_preview_samples = window.len();
                let request_client = client.clone();
                let request_endpoint = endpoint.clone();
                let request_model = model.clone();
                let request_api_key = api_key.clone();
                let request_language = language.clone();
                let request_events = events.clone();
                in_flight = Some(tokio::spawn(async move {
                    transcribe_whisper_window(
                        &request_client,
                        &request_endpoint,
                        &request_model,
                        request_api_key.as_deref(),
                        request_language.as_deref(),
                        &preview,
                        &request_events,
                        false,
                    )
                    .await
                }));
                continue;
            }
            if audio_closed {
                break;
            }
            match audio_rx.recv().await {
                Some(pcm) => {
                    if queue_whisper_window(&mut window, &mut pending, &pcm) {
                        last_preview_samples = 0;
                    }
                }
                None => audio_closed = true,
            }
            continue;
        }

        tokio::select! {
            result = in_flight.as_mut().expect("in-flight request must exist") => {
                in_flight = None;
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        let _ = events.send(AsrEvent::Error { error });
                        return;
                    }
                    Err(_) => {
                        let _ = events.send(AsrEvent::Error { error: AsrError::Network });
                        return;
                    }
                }
            }
            pcm = audio_rx.recv(), if !audio_closed => {
                match pcm {
                    Some(pcm) => {
                        if queue_whisper_window(&mut window, &mut pending, &pcm) {
                            last_preview_samples = 0;
                        }
                    }
                    None => audio_closed = true,
                }
            }
        }
    }
}

/// 转写一个 PCM 窗口并派发临时预览或稳定定稿文本。
///
/// # 参数
/// - `client`：复用的 HTTP 客户端。
/// - `endpoint`：完整转写端点。
/// - `model`：模型名称。
/// - `api_key`：可选 Bearer API Key。
/// - `language`：可选语言代码。
/// - `pcm`：窗口 PCM 采样。
/// - `events`：下行事件广播端。
/// - `finalize`：是否为稳定定稿事件；`false` 时作为可覆盖的临时预览。
///
/// # 返回值
/// 成功或结构化 ASR 错误。
///
/// @author zhenghq
async fn transcribe_whisper_window(
    client: &reqwest::Client,
    endpoint: &str,
    model: &str,
    api_key: Option<&str>,
    language: Option<&str>,
    pcm: &[i16],
    events: &broadcast::Sender<AsrEvent>,
    finalize: bool,
) -> Result<(), AsrError> {
    let wav = pcm16_to_wav(pcm);
    let file = Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|_| AsrError::InvalidRequest)?;
    let mut form = Form::new()
        .part("file", file)
        .text("model", model.to_string())
        .text("response_format", "json");
    if let Some(language) = language {
        form = form.text("language", language.to_string());
    }
    let mut request = client.post(endpoint).multipart(form);
    if let Some(api_key) = api_key {
        request = request.bearer_auth(api_key);
    }
    let response = request.send().await.map_err(|_| AsrError::Network)?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(classify_whisper_status(status));
    }
    let body = response.text().await.map_err(|_| AsrError::Network)?;
    let text = whisper_response_text(&body);
    if !text.is_empty() {
        let lang = language.map(str::to_string);
        let event = if finalize {
            AsrEvent::Final { text, lang }
        } else {
            AsrEvent::Partial { text, lang }
        };
        let _ = events.send(event);
    }
    Ok(())
}

impl Drop for AsrClient {
    /// 释放客户端时中止后台连接任务，确保 WebSocket 不会悬挂。
    ///
    /// # 返回值
    /// 无返回值。
    fn drop(&mut self) {
        let task = self
            .task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(task) = task {
            task.abort();
        }
    }
}

/// 构造 Deepgram 实时识别 WebSocket URL。
///
/// # 参数
/// - `lang`：识别语言，`auto` 表示自动检测。
///
/// # 返回值
/// 包含音频格式、模型与端点检测参数的 URL。
fn deepgram_url(lang: &str) -> String {
    let mut url = format!(
        "{DEEPGRAM_LISTEN_URL}?model={DEEPGRAM_MODEL}&encoding=linear16&sample_rate=24000&channels=1&interim_results=true&punctuate=true&smart_format=true&utterance_end_ms=1000&vad_events=true"
    );
    if lang.eq_ignore_ascii_case("auto") {
        // Nova 流式接口不支持预录音频式的语言检测参数；自动识别应使用多语言模型。
        url.push_str("&language=multi");
    } else {
        url.push_str("&language=");
        url.push_str(&urlencoding(lang));
    }
    url
}

/// 对 URL 查询参数做最小百分号编码，避免语言标签中的特殊字符破坏请求。
///
/// # 参数
/// - `value`：待编码文本。
///
/// # 返回值
/// 可直接拼接到 URL 查询串的文本。
fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                char::from(byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// 运行 Deepgram 会话：转发音频并解析转写事件。
///
/// # 参数
/// - `api_key`：Deepgram API Key。
/// - `lang`：识别语言。
/// - `audio_rx`：PCM 上行通道。
/// - `events`：下行事件广播端。
///
/// # 返回值
/// 无返回值。
async fn connect_deepgram(
    api_key: String,
    lang: &str,
) -> Result<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, AsrError> {
    let mut request = deepgram_url(lang)
        .into_client_request()
        .map_err(|_| AsrError::Network)?;
    let authorization =
        HeaderValue::from_str(&format!("Token {api_key}")).map_err(|_| AsrError::Auth)?;
    request.headers_mut().insert("Authorization", authorization);

    match connect_async(request).await {
        Ok((stream, _)) => Ok(stream),
        Err(error) => {
            // HTTP 错误响应体通常包含可操作的参数说明，且不包含 API Key；
            // 只记录响应体，不记录请求头，便于定位 400 等握手失败。
            let response_body = match &error {
                tokio_tungstenite::tungstenite::Error::Http(response) => response
                    .body()
                    .as_deref()
                    .map(|body| String::from_utf8_lossy(body).trim().to_string())
                    .filter(|body| !body.is_empty()),
                _ => None,
            };
            if let Some(body) = response_body {
                tracing::warn!(%error, %body, "deepgram connect failed");
            } else {
                tracing::warn!(%error, "deepgram connect failed");
            }
            Err(classify_connect_error(&error))
        }
    }
}

/// 把 WebSocket 握手错误转换为会话层可展示的错误分类。
///
/// # 参数
/// - `error`：Deepgram WebSocket 握手错误。
///
/// # 返回值
/// 鉴权错误、网络错误或端点不可用错误。
fn classify_connect_error(error: &tokio_tungstenite::tungstenite::Error) -> AsrError {
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => match response.status().as_u16() {
            401 | 403 => AsrError::Auth,
            400 | 402 | 404 | 405 | 406 | 409 | 413 | 415 | 422 | 429 => AsrError::InvalidRequest,
            _ => AsrError::Network,
        },
        _ => AsrError::Network,
    }
}

/// 在已建立的 Deepgram 连接上转发音频并解析转写事件。
///
/// # 参数
/// - `stream`：已完成握手的 Deepgram WebSocket。
/// - `audio_rx`：PCM 上行通道。
/// - `events`：下行事件广播端。
///
/// # 返回值
/// 无返回值。
async fn run_deepgram(
    stream: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
    events: broadcast::Sender<AsrEvent>,
) {
    run_deepgram_with_keepalive(stream, audio_rx, events, DEEPGRAM_KEEPALIVE_INTERVAL).await;
}

/// 在已建立的 WebSocket 上运行转发循环，并允许测试覆盖保活间隔。
///
/// # 参数
/// - `stream`：已完成握手的 WebSocket。
/// - `audio_rx`：PCM 上行通道。
/// - `events`：下行事件广播端。
/// - `keepalive_interval`：应用层 KeepAlive 发送间隔。
///
/// # 返回值
/// 无返回值。
async fn run_deepgram_with_keepalive(
    stream: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
    events: broadcast::Sender<AsrEvent>,
    keepalive_interval: Duration,
) {
    let (mut write, mut read) = stream.split();
    let mut transcript = DeepgramTranscriptState::default();
    let mut keepalive = interval(keepalive_interval);
    keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // 第一次 tick 立即完成；先消费掉，确保连接建立后不会立刻多发一帧。
    keepalive.tick().await;
    let mut failure = Some(AsrError::Network);

    loop {
        tokio::select! {
            maybe_pcm = audio_rx.recv() => {
                let Some(pcm) = maybe_pcm else { break };
                let bytes: Vec<u8> = pcm.iter().flat_map(|sample| sample.to_le_bytes()).collect();
                if !send_with_timeout(
                    &mut write,
                    Message::Binary(bytes.into()),
                    DEEPGRAM_SEND_TIMEOUT,
                )
                .await
                {
                    failure = Some(AsrError::Network);
                    break;
                }
            }
            _ = keepalive.tick() => {
                if !send_with_timeout(
                    &mut write,
                    Message::Text("{\"type\":\"KeepAlive\"}".into()),
                    DEEPGRAM_SEND_TIMEOUT,
                )
                .await
                {
                    failure = Some(AsrError::Network);
                    break;
                }
            }
            message = read.next() => {
                let Some(Ok(message)) = message else { break };
                let text = match message {
                    Message::Text(text) => text,
                    // 服务端主动发送 Close 同样表示连接已不可用；会话层需要
                    // 上报网络错误并由主进程决定是否重连。
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                if handle_deepgram_event(&value, &mut transcript, &events) {
                    // 服务端明确返回 Error 事件时已在上方派发具体错误分类，
                    // 不再重复上报为网络断开。
                    failure = None;
                    break;
                }
            }
        }
    }

    if let Some(error) = failure {
        // 先上报错误，再发送关闭帧。否则对端已经关闭时 Close 发送失败，
        // 仍应确保会话层能收到可恢复的网络错误。
        let _ = events.send(AsrEvent::Error { error });
    }
    // 关闭帧也必须有超时，否则半开连接会让任务在错误已上报后仍永久悬挂。
    let _ = send_with_timeout(&mut write, Message::Close(None), DEEPGRAM_SEND_TIMEOUT).await;
}

/// 在限定时间内发送一条 WebSocket 消息。
///
/// # 参数
/// - `sink`：WebSocket 写半端或测试替身。
/// - `message`：待发送消息。
/// - `timeout_duration`：最长等待时间。
///
/// # 返回值
/// 在超时前发送成功返回 `true`，超时或底层写入失败返回 `false`。
///
/// @author zhenghq
async fn send_with_timeout<S>(sink: &mut S, message: Message, timeout_duration: Duration) -> bool
where
    S: SinkExt<Message> + Unpin,
{
    matches!(
        tokio::time::timeout(timeout_duration, sink.send(message)).await,
        Ok(Ok(()))
    )
}

/// Deepgram 单次连接内的累计转写状态。
#[derive(Debug, Default)]
struct DeepgramTranscriptState {
    /// 最近一条临时转写，用于过滤服务端重复推送。
    partial: String,
    /// 尚未由 speech_final/UtteranceEnd 提交的候选文本。
    candidate: String,
}

/// 解析一条 Deepgram 服务端事件并派发内部事件。
///
/// Deepgram 的 transcript 通常在当前 utterance 内累计，因此 `is_final` 只更新
/// 候选，只有 `speech_final` 或 `UtteranceEnd` 才提交稳定 final。
///
/// # 参数
/// - `value`：服务端 JSON 事件。
/// - `state`：当前连接的累计转写状态。
/// - `events`：下行事件广播端。
///
/// # 返回值
/// 连接需要终止时返回 true。
fn handle_deepgram_event(
    value: &serde_json::Value,
    state: &mut DeepgramTranscriptState,
    events: &broadcast::Sender<AsrEvent>,
) -> bool {
    match value["type"].as_str() {
        Some("Results") => {
            let text = value["channel"]["alternatives"][0]["transcript"]
                .as_str()
                .unwrap_or_default()
                .trim();
            if text.is_empty() {
                return false;
            }
            let is_final = value["is_final"].as_bool().unwrap_or(false);
            let speech_final = value["speech_final"].as_bool().unwrap_or(false);
            // language=multi 时语言位于 alternatives[0].languages；旧字段
            // detected_language 仅作为兼容回退。
            let lang = value["channel"]["alternatives"][0]["languages"][0]
                .as_str()
                .or_else(|| value["channel"]["detected_language"].as_str())
                .map(str::to_string);

            if is_final || speech_final {
                state.candidate = text.to_string();
            }
            if speech_final {
                let final_text = std::mem::take(&mut state.candidate);
                state.partial.clear();
                if !final_text.is_empty() {
                    let _ = events.send(AsrEvent::Final {
                        text: final_text,
                        lang,
                    });
                }
            } else if is_final {
                // 最终片段先作为候选保留，避免把同一 utterance 的累计文本
                // 在多个 is_final 消息中重复提交给翻译管道。
            } else if text != state.partial {
                state.partial = text.to_string();
                let _ = events.send(AsrEvent::Partial {
                    text: text.to_string(),
                    lang,
                });
            }
            false
        }
        Some("UtteranceEnd") => {
            let final_text = std::mem::take(&mut state.candidate);
            state.partial.clear();
            if !final_text.is_empty() {
                let _ = events.send(AsrEvent::Final {
                    text: final_text,
                    lang: None,
                });
            }
            false
        }
        Some("Error") | Some("error") => {
            tracing::warn!(event = %value, "deepgram error");
            let _ = events.send(AsrEvent::Error {
                error: classify_deepgram_error(value),
            });
            true
        }
        _ => false,
    }
}

/// 根据 Deepgram 错误事件中的 code/type 字段做保守分类。
///
/// # 参数
/// - `value`：服务端错误事件。
///
/// # 返回值
/// 结构化 ASR 错误分类。
fn classify_deepgram_error(value: &serde_json::Value) -> AsrError {
    let code = value["code"].as_str().unwrap_or_default();
    let kind = value["type"].as_str().unwrap_or_default();
    match (code, kind) {
        ("401", _) | ("403", _) | (_, "invalid_request_error") => AsrError::Auth,
        _ => AsrError::Network,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::Sink;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::time::timeout;
    use tokio_tungstenite::{accept_async, connect_async};

    /// 启动只处理一次请求的本地 HTTP 服务并返回请求内容。
    ///
    /// # 参数
    /// - `status`：响应状态码。
    /// - `body`：响应正文。
    ///
    /// # 返回值
    /// 服务地址和读取请求的任务。
    ///
    /// @author zhenghq
    async fn spawn_http_once(
        status: u16,
        body: &'static str,
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let read = stream.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&request);
                if let Some(header_end) = text.find("\r\n\r\n") {
                    let content_length = text[..header_end]
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length: ")
                                .or_else(|| line.strip_prefix("Content-Length: "))
                        })
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if request.len() >= header_end + 4 + content_length {
                        break;
                    }
                }
            }
            let response = format!(
                "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            request
        });
        (address, server)
    }

    /// 启动延迟响应的本地 HTTP 服务，用于验证请求在途时音频消费不被阻塞。
    ///
    /// # 参数
    /// - `delay`：读取请求后等待多久再返回。
    ///
    /// # 返回值
    /// 服务地址和响应任务。
    ///
    /// @author zhenghq
    async fn spawn_delayed_http(
        delay: Duration,
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let read = stream.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&request);
                if let Some(header_end) = text.find("\r\n\r\n") {
                    let content_length = text[..header_end]
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length: ")
                                .or_else(|| line.strip_prefix("Content-Length: "))
                        })
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if request.len() >= header_end + 4 + content_length {
                        break;
                    }
                }
            }
            tokio::time::sleep(delay).await;
            let body = r#"{"text":"slow"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        (address, server)
    }

    /// 永不就绪的 Sink，用于验证 WebSocket 写入超时边界。
    struct PendingSink;

    impl Sink<Message> for PendingSink {
        type Error = ();

        /// 始终返回未就绪，模拟底层网络写入永久阻塞。
        ///
        /// # 参数
        /// - `_cx`：任务上下文。
        ///
        /// # 返回值
        /// 始终为 `Poll::Pending`。
        ///
        /// @author zhenghq
        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }

        /// 接收待写消息。
        ///
        /// # 参数
        /// - `_item`：待写消息。
        ///
        /// # 返回值
        /// 始终返回成功。
        ///
        /// @author zhenghq
        fn start_send(self: Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
            Ok(())
        }

        /// 模拟刷新未完成。
        ///
        /// # 参数
        /// - `_cx`：任务上下文。
        ///
        /// # 返回值
        /// 始终为 `Poll::Pending`。
        ///
        /// @author zhenghq
        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }

        /// 模拟关闭未完成。
        ///
        /// # 参数
        /// - `_cx`：任务上下文。
        ///
        /// # 返回值
        /// 始终为 `Poll::Pending`。
        ///
        /// @author zhenghq
        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }
    }

    #[test]
    fn asr_errors_have_stable_messages() {
        assert_eq!(AsrError::Auth.to_string(), "asr authentication failed");
        assert_eq!(AsrError::Network.to_string(), "asr network failure");
        assert_eq!(AsrError::InvalidRequest.to_string(), "asr request rejected");
    }

    #[test]
    fn deepgram_url_uses_required_audio_format() {
        let url = deepgram_url("zh-CN");
        assert!(url.starts_with("wss://api.deepgram.com/v1/listen?"));
        assert!(url.contains("model=nova-3"));
        assert!(url.contains("encoding=linear16"));
        assert!(url.contains("sample_rate=24000"));
        assert!(url.contains("channels=1"));
        assert!(url.contains("interim_results=true"));
        assert!(url.contains("punctuate=true"));
        assert!(url.contains("smart_format=true"));
        assert!(url.contains("utterance_end_ms=1000"));
        assert!(url.contains("vad_events=true"));
        assert!(url.contains("language=zh-CN"));
        assert!(!url.contains("language=auto"));
    }

    #[test]
    fn deepgram_url_uses_multi_for_auto_language() {
        let url = deepgram_url("auto");
        assert!(url.contains("language=multi"));
        assert!(!url.contains("detect_language"));
    }

    #[test]
    fn whisper_transcription_url_appends_endpoint_once() {
        assert_eq!(
            whisper_transcription_url("http://127.0.0.1:8000/v1").unwrap(),
            "http://127.0.0.1:8000/v1/audio/transcriptions"
        );
        assert_eq!(
            whisper_transcription_url("http://127.0.0.1:8000/v1/audio/transcriptions").unwrap(),
            "http://127.0.0.1:8000/v1/audio/transcriptions"
        );
        assert_eq!(
            whisper_transcription_url("https://api.openai.com/v1/").unwrap(),
            "https://api.openai.com/v1/audio/transcriptions"
        );
        assert_eq!(
            whisper_transcription_url("http://127.0.0.1:8080/inference").unwrap(),
            "http://127.0.0.1:8080/inference"
        );
        assert!(whisper_transcription_url("file:///tmp/whisper").is_err());
    }

    #[test]
    fn whisper_language_maps_ui_locale_to_short_code() {
        assert_eq!(whisper_language("auto"), None);
        assert_eq!(whisper_language("zh-CN"), Some("zh".into()));
        assert_eq!(whisper_language("zh-TW"), Some("zh".into()));
        assert_eq!(whisper_language("ja-JP"), Some("ja".into()));
    }

    #[test]
    fn whisper_wav_contains_pcm16_mono_header() {
        let wav = pcm16_to_wav(&[0, 1, -1]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 24_000);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
        assert_eq!(wav.len(), 44 + 6);
    }

    /// 校验 Whisper 窗口不足最短时长时不会提前提交。
    ///
    /// # 参数
    /// 无。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn whisper_window_waits_for_minimum_duration() {
        let mut window = Vec::new();
        let mut pending = None;

        queue_whisper_window(
            &mut window,
            &mut pending,
            &vec![2_000; WHISPER_MIN_WINDOW_SAMPLES - 1],
        );

        assert!(pending.is_none());
        assert_eq!(window.len(), WHISPER_MIN_WINDOW_SAMPLES - 1);
    }

    /// 校验检测到句尾停顿后应提前提交 Whisper 窗口。
    ///
    /// # 参数
    /// 无。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn whisper_window_flushes_after_trailing_silence() {
        let mut window = vec![2_000; WHISPER_MIN_WINDOW_SAMPLES];
        let mut pending = None;

        queue_whisper_window(
            &mut window,
            &mut pending,
            &vec![0; WHISPER_SILENCE_TAIL_SAMPLES],
        );

        assert_eq!(window.len(), 0);
        assert_eq!(
            pending.as_ref().map(Vec::len),
            Some(WHISPER_MIN_WINDOW_SAMPLES + WHISPER_SILENCE_TAIL_SAMPLES)
        );
    }

    /// 校验持续说话时仍在最长窗口处强制提交，避免字幕无限延后。
    ///
    /// # 参数
    /// 无。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn whisper_window_flushes_at_maximum_duration() {
        let mut window = vec![2_000; WHISPER_MAX_WINDOW_SAMPLES / 2];
        let mut pending = None;

        queue_whisper_window(
            &mut window,
            &mut pending,
            &vec![2_000; WHISPER_MAX_WINDOW_SAMPLES / 2],
        );

        assert_eq!(window.len(), 0);
        assert_eq!(
            pending.as_ref().map(Vec::len),
            Some(WHISPER_MAX_WINDOW_SAMPLES)
        );
    }

    /// 校验纯静音不会触发 Whisper，避免模型对无声片段产生幻觉字幕。
    ///
    /// # 参数
    /// 无。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn whisper_window_discards_silence_without_speech() {
        let mut window = Vec::new();
        let mut pending = None;

        queue_whisper_window(
            &mut window,
            &mut pending,
            &vec![0; WHISPER_MAX_WINDOW_SAMPLES],
        );

        assert!(window.is_empty());
        assert!(pending.is_none());
    }

    /// 校验滚动预览在累积最短预览时长后才触发。
    ///
    /// # 参数
    /// 无。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn whisper_preview_waits_for_interval_and_speech() {
        assert!(!whisper_preview_due(
            &vec![2_000; WHISPER_PREVIEW_INTERVAL_SAMPLES - 1],
            0
        ));
        assert!(whisper_preview_due(
            &vec![2_000; WHISPER_PREVIEW_INTERVAL_SAMPLES],
            0
        ));
        assert!(!whisper_preview_due(
            &vec![0; WHISPER_PREVIEW_INTERVAL_SAMPLES],
            0
        ));
    }

    /// 校验同一窗口在预览后必须继续累积足够新音频才会再次预览。
    ///
    /// # 参数
    /// 无。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn whisper_preview_requires_new_audio_after_previous_snapshot() {
        let window = vec![2_000; WHISPER_PREVIEW_INTERVAL_SAMPLES * 2];

        assert!(!whisper_preview_due(&window, window.len()));
        assert!(whisper_preview_due(
            &window,
            window.len() - WHISPER_PREVIEW_INTERVAL_SAMPLES
        ));
    }

    #[test]
    fn whisper_http_status_maps_to_stable_errors() {
        assert_eq!(classify_whisper_status(401), AsrError::Auth);
        assert_eq!(classify_whisper_status(403), AsrError::Auth);
        assert_eq!(classify_whisper_status(400), AsrError::InvalidRequest);
        assert_eq!(classify_whisper_status(404), AsrError::InvalidRequest);
        assert_eq!(classify_whisper_status(429), AsrError::InvalidRequest);
        assert_eq!(classify_whisper_status(500), AsrError::Network);
    }

    /// 校验 Whisper 请求使用 multipart、Bearer 鉴权并派发最终文本。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[tokio::test]
    async fn whisper_request_sends_multipart_and_emits_final_text() {
        let (address, server) = spawn_http_once(200, r#"{"text":"你好"}"#).await;
        let client = reqwest::Client::new();
        let (events, mut received) = broadcast::channel(4);
        let endpoint = format!("http://{address}/v1/audio/transcriptions");

        transcribe_whisper_window(
            &client,
            &endpoint,
            "large-v3",
            Some("local-secret"),
            Some("zh"),
            &[1, -1],
            &events,
            true,
        )
        .await
        .unwrap();

        let request = String::from_utf8_lossy(&server.await.unwrap()).into_owned();
        assert!(request.starts_with("POST /v1/audio/transcriptions HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer local-secret"));
        assert!(request.contains("name=\"file\"; filename=\"audio.wav\""));
        assert!(request.contains("name=\"model\"\r\n\r\nlarge-v3"));
        assert!(request.contains("name=\"response_format\"\r\n\r\njson"));
        assert!(request.contains("name=\"language\"\r\n\r\nzh"));
        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Final {
                text: "你好".into(),
                lang: Some("zh".into())
            }
        );
    }

    /// 校验滚动预览请求会派发可被后续结果覆盖的临时文本。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[tokio::test]
    async fn whisper_request_can_emit_partial_text() {
        let (address, server) = spawn_http_once(200, r#"{"text":"临时字幕"}"#).await;
        let client = reqwest::Client::new();
        let (events, mut received) = broadcast::channel(4);
        let endpoint = format!("http://{address}/v1/audio/transcriptions");

        transcribe_whisper_window(
            &client,
            &endpoint,
            "ggml-medium",
            None,
            Some("zh"),
            &[1, -1],
            &events,
            false,
        )
        .await
        .unwrap();

        server.await.unwrap();
        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Partial {
                text: "临时字幕".into(),
                lang: Some("zh".into())
            }
        );
    }

    /// 校验本地无鉴权 Whisper 服务不会收到 Authorization 请求头。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[tokio::test]
    async fn whisper_request_omits_authorization_without_api_key() {
        let (address, server) = spawn_http_once(200, r#"{"text":"local"}"#).await;
        let client = reqwest::Client::new();
        let (events, mut received) = broadcast::channel(4);
        let endpoint = format!("http://{address}/v1/audio/transcriptions");

        transcribe_whisper_window(
            &client,
            &endpoint,
            "whisper-1",
            None,
            None,
            &[0, 0],
            &events,
            true,
        )
        .await
        .unwrap();

        let request = String::from_utf8_lossy(&server.await.unwrap()).into_owned();
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        assert!(!request.contains("name=\"language\""));
        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Final {
                text: "local".into(),
                lang: None
            }
        );
    }

    /// 校验非 2xx Whisper 响应返回稳定的鉴权或请求错误。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[tokio::test]
    async fn whisper_request_maps_http_errors() {
        let (address, server) = spawn_http_once(401, r#"{"error":"unauthorized"}"#).await;
        let client = reqwest::Client::new();
        let (events, _received) = broadcast::channel(4);
        let endpoint = format!("http://{address}/v1/audio/transcriptions");

        let error = transcribe_whisper_window(
            &client,
            &endpoint,
            "whisper-1",
            None,
            None,
            &[0],
            &events,
            true,
        )
        .await
        .unwrap_err();

        server.await.unwrap();
        assert_eq!(error, AsrError::Auth);
    }

    /// 校验 whisper.cpp 等兼容服务的纯文本响应也能转换为最终字幕。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[tokio::test]
    async fn whisper_request_accepts_plain_text_response() {
        let (address, server) = spawn_http_once(200, " 本地识别结果 \n").await;
        let client = reqwest::Client::new();
        let (events, mut received) = broadcast::channel(4);
        let endpoint = format!("http://{address}/v1/audio/transcriptions");

        transcribe_whisper_window(
            &client,
            &endpoint,
            "ggml-base",
            None,
            Some("zh"),
            &[0, 0],
            &events,
            true,
        )
        .await
        .unwrap();

        server.await.unwrap();
        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Final {
                text: "本地识别结果".into(),
                lang: Some("zh".into())
            }
        );
    }

    /// 校验慢速 Whisper 请求期间仍持续消费音频，避免采集队列被 HTTP 阻塞塞满。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[tokio::test]
    async fn whisper_keeps_consuming_audio_while_request_is_in_flight() {
        let (address, server) = spawn_delayed_http(Duration::from_millis(250)).await;
        let endpoint = format!("http://{address}/v1/audio/transcriptions");
        let (audio_tx, audio_rx) = tokio::sync::mpsc::channel(1);
        let (events, _received) = broadcast::channel(4);
        let task = tokio::spawn(run_whisper(
            endpoint,
            "whisper-1".into(),
            None,
            None,
            audio_rx,
            events,
        ));

        for _ in 0..3 {
            timeout(
                Duration::from_millis(100),
                audio_tx.send(vec![2_000; WHISPER_MAX_WINDOW_SAMPLES]),
            )
            .await
            .expect("audio intake should not block on the in-flight request")
            .unwrap();
        }
        drop(audio_tx);

        timeout(Duration::from_secs(2), task)
            .await
            .expect("whisper loop should stop after audio channel closes")
            .unwrap();
        server.await.unwrap();
    }

    #[test]
    fn interim_results_update_partial_only() {
        let (tx, mut rx) = broadcast::channel(4);
        let mut state = DeepgramTranscriptState::default();
        let value = serde_json::json!({
            "type": "Results",
            "is_final": false,
            "speech_final": false,
            "channel": { "alternatives": [{ "transcript": "hello" }] }
        });
        assert!(!handle_deepgram_event(&value, &mut state, &tx));
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Partial {
                text: "hello".into(),
                lang: None
            }
        );
    }

    #[test]
    fn is_final_is_not_committed_until_speech_final() {
        let (tx, mut rx) = broadcast::channel(4);
        let mut state = DeepgramTranscriptState::default();
        let is_final = serde_json::json!({
            "type": "Results",
            "is_final": true,
            "speech_final": false,
            "channel": { "alternatives": [{ "transcript": "hello world" }] }
        });
        assert!(!handle_deepgram_event(&is_final, &mut state, &tx));
        assert!(rx.try_recv().is_err());

        let speech_final = serde_json::json!({
            "type": "Results",
            "is_final": true,
            "speech_final": true,
            "channel": { "alternatives": [{ "transcript": "hello world" }] }
        });
        assert!(!handle_deepgram_event(&speech_final, &mut state, &tx));
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Final {
                text: "hello world".into(),
                lang: None
            }
        );
    }

    #[test]
    fn utterance_end_commits_candidate_once() {
        let (tx, mut rx) = broadcast::channel(4);
        let mut state = DeepgramTranscriptState::default();
        let is_final = serde_json::json!({
            "type": "Results",
            "is_final": true,
            "speech_final": false,
            "channel": { "alternatives": [{ "transcript": "hello world" }] }
        });
        handle_deepgram_event(&is_final, &mut state, &tx);
        let end = serde_json::json!({ "type": "UtteranceEnd" });
        handle_deepgram_event(&end, &mut state, &tx);
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Final {
                text: "hello world".into(),
                lang: None
            }
        );
        handle_deepgram_event(&end, &mut state, &tx);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn cumulative_transcripts_are_not_duplicated_as_finals() {
        let (tx, mut rx) = broadcast::channel(4);
        let mut state = DeepgramTranscriptState::default();
        for (text, speech_final) in [("hello", false), ("hello world", true)] {
            let value = serde_json::json!({
                "type": "Results",
                "is_final": true,
                "speech_final": speech_final,
                "channel": { "alternatives": [{ "transcript": text }] }
            });
            handle_deepgram_event(&value, &mut state, &tx);
        }
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Final {
                text: "hello world".into(),
                lang: None
            }
        );
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn error_event_terminates_connection() {
        let (tx, mut rx) = broadcast::channel(4);
        let mut state = DeepgramTranscriptState::default();
        let value = serde_json::json!({ "type": "Error", "code": "401" });
        assert!(handle_deepgram_event(&value, &mut state, &tx));
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Error {
                error: AsrError::Auth
            }
        );
    }

    #[test]
    fn bad_request_is_not_reported_as_network_failure() {
        let response = tokio_tungstenite::tungstenite::http::Response::builder()
            .status(400)
            .body(None)
            .unwrap();
        let error = tokio_tungstenite::tungstenite::Error::Http(Box::new(response));
        assert_eq!(classify_connect_error(&error), AsrError::InvalidRequest);
    }

    #[test]
    fn multilingual_result_reads_first_language() {
        let (tx, mut rx) = broadcast::channel(4);
        let mut state = DeepgramTranscriptState::default();
        let value = serde_json::json!({
            "type": "Results",
            "is_final": false,
            "speech_final": false,
            "channel": {
                "alternatives": [{
                    "transcript": "你好 hello",
                    "languages": ["zh-CN", "en"]
                }]
            }
        });
        assert!(!handle_deepgram_event(&value, &mut state, &tx));
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Partial {
                text: "你好 hello".into(),
                lang: Some("zh-CN".into())
            }
        );
    }

    #[tokio::test]
    async fn sends_keepalive_when_audio_is_idle() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            timeout(Duration::from_millis(500), socket.next())
                .await
                .expect("keepalive should arrive before timeout")
                .expect("server socket should stay open")
                .expect("server should receive a valid websocket frame")
        });
        let (stream, _) = connect_async(format!("ws://{address}")).await.unwrap();
        let (_audio_tx, audio_rx) = tokio::sync::mpsc::channel(1);
        let (events, _) = broadcast::channel(4);

        let task = tokio::spawn(run_deepgram_with_keepalive(
            stream,
            audio_rx,
            events,
            Duration::from_millis(10),
        ));
        let message = server.await.unwrap();

        assert_eq!(message, Message::Text("{\"type\":\"KeepAlive\"}".into()));
        task.abort();
    }

    /// 校验 WebSocket 写入超时会返回失败，避免上行任务永久卡死。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[tokio::test]
    async fn websocket_send_times_out_when_sink_never_becomes_ready() {
        let mut sink = PendingSink;

        let sent = send_with_timeout(
            &mut sink,
            Message::Text("{\"type\":\"KeepAlive\"}".into()),
            Duration::from_millis(10),
        )
        .await;

        assert!(!sent);
    }

    #[tokio::test]
    async fn unexpected_disconnect_is_reported_as_network_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            socket.close(None).await.unwrap();
        });
        let (stream, _) = connect_async(format!("ws://{address}")).await.unwrap();
        let (_audio_tx, audio_rx) = tokio::sync::mpsc::channel(1);
        let (events, mut received) = broadcast::channel(4);

        timeout(
            Duration::from_secs(1),
            run_deepgram_with_keepalive(stream, audio_rx, events, Duration::from_secs(60)),
        )
        .await
        .expect("disconnect should stop the ASR loop");
        server.await.unwrap();

        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Error {
                error: AsrError::Network
            }
        );
    }
}
