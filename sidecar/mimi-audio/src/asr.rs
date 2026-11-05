//! Deepgram、Whisper 与 WebSocket 实时 ASR 客户端。
//!
//! 音频采集与文本归并沿用 Mimi（MIT，Copyright (c) 2026 yuxino）的移植实现；
//! 本模块把 24 kHz PCM16 音频送入 Deepgram WebSocket、本地 OpenAI 兼容 Whisper
//! 转写接口或 WebSocket 流式 ASR 服务，并把识别事件转换为 sidecar 内部事件。
//! 翻译始终由宿主应用的多通道翻译管道完成。

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use reqwest::multipart::{Form, Part};
use tokio::sync::{broadcast, Mutex};
use tokio::time::{interval, Duration, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::audio::streaming_resampler::StreamingPcm16Resampler;
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
        /// 词级时间戳计算出的停顿边界，使用 Unicode 字符偏移。
        pause_boundaries: Vec<usize>,
    },
    /// 连接或服务端错误，需要由会话层上报给主进程。
    Error {
        /// 结构化错误分类。
        error: AsrError,
    },
}

/// Deepgram WebSocket 端点。
const DEEPGRAM_LISTEN_URL: &str = "wss://api.deepgram.com/v1/listen";

/// faster-whisper-stream 的默认 WebSocket ASR 地址。
const DEFAULT_WEBSOCKET_ASR_URL: &str = "ws://127.0.0.1:9092/ws/asr";

/// Deepgram 默认识别模型。
const DEEPGRAM_MODEL: &str = "nova-3";

/// Deepgram 相邻词之间达到该静音时长时视为自然停顿。
const DEEPGRAM_PAUSE_THRESHOLD_SECONDS: f64 = 0.45;

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

/// WebSocket ASR 心跳发送间隔。
///
/// 部分反向代理或服务端会在长时间无数据后静默丢弃半开连接；应用层音频
/// 写入仍可能短暂成功，无法及时暴露断链。定期发送 WebSocket Ping 可以用
/// Pong 确认连接仍然可用。
const WEBSOCKET_ASR_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);

/// WebSocket ASR 最长无下行帧时间。
///
/// 超过该时间没有收到任何文本、Pong 或关闭帧时视为连接已失效，主动上报
/// 网络错误，让主进程重建 sidecar 与 ASR 连接。
const WEBSOCKET_ASR_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

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

/// DashScope 建立任务并收到 `task-started` 的最长等待时间。
const DASHSCOPE_START_TIMEOUT: Duration = Duration::from_secs(10);

/// OpenAI Realtime 完成会话配置的最长等待时间。
const OPENAI_SESSION_TIMEOUT: Duration = Duration::from_secs(10);

/// OpenAI 音频停顿多久后提交当前输入缓冲区。
const OPENAI_COMMIT_IDLE: Duration = Duration::from_millis(600);

/// OpenAI 检查音频停顿是否达到提交阈值的轮询间隔。
const OPENAI_COMMIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

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
            AsrProvider::WebSocket => Self::connect_websocket(lang).await,
            AsrProvider::Alibaba | AsrProvider::CustomDashscope => {
                Self::connect_dashscope(lang).await
            }
            AsrProvider::CustomOpenai => Self::connect_openai_realtime(lang).await,
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

    /// 连接 WebSocket 流式语音识别服务。
    ///
    /// # 参数
    /// - `lang`：识别语言，会映射为服务接受的短语言代码并覆盖 URL 中的
    ///   `language` 参数。
    ///
    /// # 返回值
    /// 已就绪的客户端；配置非法或握手失败时返回分类错误。
    ///
    /// @author zhenghq
    async fn connect_websocket(lang: &str) -> Result<Self, AsrError> {
        let configured_url = std::env::var("WEBSOCKET_ASR_URL")
            .unwrap_or_else(|_| DEFAULT_WEBSOCKET_ASR_URL.to_string());
        let endpoint = websocket_asr_url(&configured_url, lang)?;
        let stream = connect_websocket(&endpoint).await?;

        let (downstream, _) = broadcast::channel(EVENT_CAPACITY);
        let (audio_tx, audio_rx) = tokio::sync::mpsc::channel::<Vec<i16>>(64);
        let events = downstream.clone();
        let task = tokio::spawn(async move {
            run_websocket(stream, audio_rx, events).await;
        });

        Ok(Self {
            upstream: Mutex::new(Some(audio_tx)),
            downstream,
            task: std::sync::Mutex::new(Some(task)),
        })
    }

    /// 连接 DashScope 实时语音识别任务。
    ///
    /// # 参数
    /// - `lang`：识别语言，`auto` 表示不发送语言提示。
    ///
    /// # 返回值
    /// 已收到 `task-started` 的客户端；配置、握手或任务启动失败时返回分类错误。
    ///
    /// @author zhenghq
    async fn connect_dashscope(lang: &str) -> Result<Self, AsrError> {
        let api_key = required_credential("DASHSCOPE_API_KEY")?;
        let endpoint = required_config("DASHSCOPE_ASR_URL")?;
        let model = required_config("DASHSCOPE_ASR_MODEL")?;
        validate_websocket_url(&endpoint)?;

        let task_id = uuid::Uuid::new_v4().to_string();
        let run_task = dashscope_run_task_payload(&model, lang, &task_id);
        let mut stream = connect_authenticated_websocket(&endpoint, &api_key).await?;
        if !send_with_timeout(
            &mut stream,
            Message::Text(run_task.to_string().into()),
            DEEPGRAM_SEND_TIMEOUT,
        )
        .await
        {
            return Err(AsrError::Network);
        }
        tokio::time::timeout(
            DASHSCOPE_START_TIMEOUT,
            wait_for_dashscope_start(&mut stream),
        )
        .await
        .map_err(|_| AsrError::Network)??;

        let (downstream, _) = broadcast::channel(EVENT_CAPACITY);
        let (audio_tx, audio_rx) = tokio::sync::mpsc::channel::<Vec<i16>>(64);
        let events = downstream.clone();
        let language = normalized_source_language(lang);
        let task = tokio::spawn(async move {
            run_dashscope(stream, audio_rx, task_id, language, events).await;
        });

        Ok(Self {
            upstream: Mutex::new(Some(audio_tx)),
            downstream,
            task: std::sync::Mutex::new(Some(task)),
        })
    }

    /// 连接 OpenAI Realtime 转写会话。
    ///
    /// # 参数
    /// - `lang`：识别语言，用于标注识别结果。
    ///
    /// # 返回值
    /// 已应用 `session.update` 的客户端；配置、握手或会话初始化失败时返回分类错误。
    ///
    /// @author zhenghq
    async fn connect_openai_realtime(lang: &str) -> Result<Self, AsrError> {
        let api_key = required_credential("OPENAI_REALTIME_API_KEY")?;
        let endpoint = required_config("OPENAI_REALTIME_ASR_URL")?;
        let model = required_config("OPENAI_REALTIME_ASR_MODEL")?;
        validate_websocket_url(&endpoint)?;

        let session_update = openai_session_update_payload(&model);
        let mut stream = connect_authenticated_websocket(&endpoint, &api_key).await?;
        if !send_with_timeout(
            &mut stream,
            Message::Text(session_update.to_string().into()),
            DEEPGRAM_SEND_TIMEOUT,
        )
        .await
        {
            return Err(AsrError::Network);
        }
        tokio::time::timeout(OPENAI_SESSION_TIMEOUT, wait_for_openai_session(&mut stream))
            .await
            .map_err(|_| AsrError::Network)??;

        let (downstream, _) = broadcast::channel(EVENT_CAPACITY);
        let (audio_tx, audio_rx) = tokio::sync::mpsc::channel::<Vec<i16>>(64);
        let events = downstream.clone();
        let language = normalized_source_language(lang);
        let task = tokio::spawn(async move {
            run_openai_realtime(stream, audio_rx, language, events).await;
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

/// 将界面语言标签映射为 WebSocket ASR 服务接受的短语言代码。
///
/// # 参数
/// - `lang`：界面识别语言，`auto` 表示自动检测。
///
/// # 返回值
/// 形如 `zh`、`en` 或 `auto` 的语言代码。
///
/// @author zhenghq
fn websocket_language(lang: &str) -> String {
    let normalized = lang.trim();
    if normalized.is_empty() || normalized.eq_ignore_ascii_case("auto") {
        return "auto".to_string();
    }
    let primary = normalized.split(['-', '_']).next().unwrap_or(normalized);
    primary.to_ascii_lowercase()
}

/// 构造 WebSocket ASR 端点，并只覆盖 URL 中已有的 `language` 参数。
///
/// # 参数
/// - `configured_url`：设置页或环境变量提供的 WebSocket 地址。
/// - `lang`：界面识别语言。
///
/// # 返回值
/// 保留其他查询参数并写入规范化语言代码的 `ws`/`wss` 地址；协议或主机非法时返回错误。
///
/// @author zhenghq
fn websocket_asr_url(configured_url: &str, lang: &str) -> Result<String, AsrError> {
    let trimmed = configured_url.trim();
    let mut parsed = reqwest::Url::parse(trimmed).map_err(|_| AsrError::InvalidRequest)?;
    if !matches!(parsed.scheme(), "ws" | "wss") || parsed.host_str().is_none() {
        return Err(AsrError::InvalidRequest);
    }

    let retained_query = parsed
        .query_pairs()
        .filter(|(key, _)| key != "language")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    {
        let mut query = parsed.query_pairs_mut();
        query.clear();
        for (key, value) in retained_query {
            query.append_pair(&key, &value);
        }
        query.append_pair("language", &websocket_language(lang));
    }
    Ok(parsed.to_string())
}

/// 读取必填凭证环境变量。
///
/// # 参数
/// - `name`：环境变量名称。
///
/// # 返回值
/// 去除首尾空白后的非空值；缺失或为空时返回鉴权错误。
///
/// @author zhenghq
fn required_credential(name: &str) -> Result<String, AsrError> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or(AsrError::Auth)
}

/// 读取必填的实时 ASR 配置环境变量。
///
/// # 参数
/// - `name`：环境变量名称。
///
/// # 返回值
/// 去除首尾空白后的非空值；缺失或为空时返回请求参数错误。
///
/// @author zhenghq
fn required_config(name: &str) -> Result<String, AsrError> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or(AsrError::InvalidRequest)
}

/// 校验实时 ASR 的 WebSocket 地址。
///
/// # 参数
/// - `endpoint`：设置页或环境变量提供的完整 WebSocket 地址。
///
/// # 返回值
/// 地址合法时返回 `Ok(())`；协议或主机非法时返回请求参数错误。
///
/// @author zhenghq
fn validate_websocket_url(endpoint: &str) -> Result<(), AsrError> {
    let parsed = reqwest::Url::parse(endpoint).map_err(|_| AsrError::InvalidRequest)?;
    if matches!(parsed.scheme(), "ws" | "wss") && parsed.host_str().is_some() {
        Ok(())
    } else {
        Err(AsrError::InvalidRequest)
    }
}

/// 建立带 Bearer 鉴权的 WebSocket 连接。
///
/// # 参数
/// - `endpoint`：已校验的 WebSocket 地址。
/// - `api_key`：服务端 API Key。
///
/// # 返回值
/// 已完成握手的 WebSocket；鉴权头非法或连接失败时返回分类错误。
///
/// @author zhenghq
async fn connect_authenticated_websocket(
    endpoint: &str,
    api_key: &str,
) -> Result<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, AsrError> {
    let mut request = endpoint
        .into_client_request()
        .map_err(|_| AsrError::InvalidRequest)?;
    let authorization =
        HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| AsrError::Auth)?;
    request.headers_mut().insert("Authorization", authorization);
    match connect_async(request).await {
        Ok((stream, _)) => Ok(stream),
        Err(error) => {
            tracing::warn!(%error, "authenticated realtime asr connect failed");
            Err(classify_connect_error(&error))
        }
    }
}

/// 将界面语言标签规范化为识别结果标注使用的语言。
///
/// # 参数
/// - `lang`：界面识别语言。
///
/// # 返回值
/// 明确语言返回原标签；`auto` 或空值返回 `None`。
///
/// @author zhenghq
fn normalized_source_language(lang: &str) -> Option<String> {
    let normalized = lang.trim();
    if normalized.is_empty() || normalized.eq_ignore_ascii_case("auto") {
        None
    } else {
        Some(normalized.to_string())
    }
}

/// 从界面语言标签中提取 DashScope 接受的语言提示。
///
/// # 参数
/// - `lang`：界面识别语言。
///
/// # 返回值
/// 主语言代码；自动检测时返回 `None`。
///
/// @author zhenghq
fn dashscope_language_hint(lang: &str) -> Option<String> {
    let normalized = lang.trim();
    if normalized.is_empty() || normalized.eq_ignore_ascii_case("auto") {
        return None;
    }
    Some(
        normalized
            .split(['-', '_'])
            .next()
            .unwrap_or(normalized)
            .to_ascii_lowercase(),
    )
}

/// 构造 DashScope 实时识别 `run-task` 控制帧。
///
/// # 参数
/// - `model`：实时识别模型。
/// - `lang`：界面识别语言。
/// - `task_id`：本次识别任务 ID。
///
/// # 返回值
/// 使用 16 kHz 单声道 PCM 输入的 JSON 控制帧。
///
/// @author zhenghq
fn dashscope_run_task_payload(model: &str, lang: &str, task_id: &str) -> serde_json::Value {
    let mut parameters = serde_json::json!({
        "format": "pcm",
        "sample_rate": 16_000,
    });
    if let Some(language) = dashscope_language_hint(lang) {
        parameters["language_hints"] = serde_json::json!([language]);
    }
    serde_json::json!({
        "header": {
            "action": "run-task",
            "task_id": task_id,
            "streaming": "duplex"
        },
        "payload": {
            "task_group": "audio",
            "task": "asr",
            "function": "recognition",
            "model": model,
            "parameters": parameters
        }
    })
}

/// 等待 DashScope 确认实时识别任务已启动。
///
/// # 参数
/// - `stream`：刚发送 `run-task` 的 WebSocket。
///
/// # 返回值
/// 收到 `task-started` 时成功；服务端拒绝、关闭或发送非法帧时返回分类错误。
///
/// @author zhenghq
async fn wait_for_dashscope_start(
    stream: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
) -> Result<(), AsrError> {
    loop {
        let Some(message) = stream.next().await else {
            return Err(AsrError::Network);
        };
        let text = match message.map_err(|_| AsrError::Network)? {
            Message::Text(text) => text,
            Message::Close(_) => return Err(AsrError::Network),
            _ => continue,
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        match value["header"]["event"].as_str() {
            Some("task-started") => return Ok(()),
            Some("task-failed") => return Err(classify_dashscope_error(&value)),
            Some("error") => return Err(classify_dashscope_error(&value)),
            _ => {}
        }
    }
}

/// 构造 OpenAI Realtime 转写会话配置帧。
///
/// # 参数
/// - `model`：实时转写模型。
///
/// # 返回值
/// 声明 24 kHz PCM 输入与转写模型的 `session.update` JSON。
///
/// @author zhenghq
fn openai_session_update_payload(model: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": {
                        "type": "audio/pcm",
                        "rate": 24_000
                    },
                    "transcription": {
                        "model": model
                    }
                }
            }
        }
    })
}

/// 构造 OpenAI Realtime 音频追加帧。
///
/// # 参数
/// - `pcm`：24 kHz 单声道 PCM16 采样。
///
/// # 返回值
/// 音频字段为小端 PCM16 Base64 的 `input_audio_buffer.append` JSON。
///
/// @author zhenghq
fn openai_audio_append_payload(pcm: &[i16]) -> serde_json::Value {
    let bytes = pcm
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect::<Vec<_>>();
    serde_json::json!({
        "type": "input_audio_buffer.append",
        "audio": base64::engine::general_purpose::STANDARD.encode(bytes)
    })
}

/// 等待 OpenAI Realtime 确认会话配置生效。
///
/// # 参数
/// - `stream`：刚发送 `session.update` 的 WebSocket。
///
/// # 返回值
/// 收到会话更新事件时成功；服务端拒绝、关闭或发送非法帧时返回分类错误。
///
/// @author zhenghq
async fn wait_for_openai_session(
    stream: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
) -> Result<(), AsrError> {
    loop {
        let Some(message) = stream.next().await else {
            return Err(AsrError::Network);
        };
        let text = match message.map_err(|_| AsrError::Network)? {
            Message::Text(text) => text,
            Message::Close(_) => return Err(AsrError::Network),
            _ => continue,
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        match value["type"].as_str() {
            Some("session.updated" | "transcription_session.updated") => return Ok(()),
            Some("error") => return Err(classify_openai_error(&value)),
            _ => {}
        }
    }
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
            AsrEvent::Final {
                text,
                lang,
                pause_boundaries: Vec::new(),
            }
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
        "{DEEPGRAM_LISTEN_URL}?model={DEEPGRAM_MODEL}&encoding=linear16&sample_rate=24000&channels=1&interim_results=true&punctuate=true&smart_format=true&utterance_end_ms=1000&vad_events=true&words=true"
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

/// 建立 WebSocket 流式 ASR 连接。
///
/// # 参数
/// - `endpoint`：已完成协议与查询参数校验的 WebSocket 地址。
///
/// # 返回值
/// 已完成握手的 WebSocket；失败时返回分类错误。
///
/// @author zhenghq
async fn connect_websocket(
    endpoint: &str,
) -> Result<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, AsrError> {
    let request = endpoint
        .into_client_request()
        .map_err(|_| AsrError::InvalidRequest)?;
    match connect_async(request).await {
        Ok((stream, _)) => Ok(stream),
        Err(error) => {
            tracing::warn!(%error, "websocket asr connect failed");
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

/// 在 WebSocket ASR 连接上转发 16 kHz PCM16 音频并解析识别事件。
///
/// 音频通道关闭时发送结束帧，但继续等待服务端返回剩余临时文本、最终文本和
/// `done`，避免丢失最后一句字幕。
///
/// # 参数
/// - `stream`：已完成握手的 WebSocket。
/// - `audio_rx`：24 kHz 单声道 PCM 上行通道。
/// - `events`：下行事件广播端。
///
/// # 返回值
/// 无返回值。
///
/// @author zhenghq
async fn run_websocket(
    stream: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
    events: broadcast::Sender<AsrEvent>,
) {
    run_websocket_with_heartbeat(
        stream,
        audio_rx,
        events,
        WEBSOCKET_ASR_HEARTBEAT_INTERVAL,
        WEBSOCKET_ASR_IDLE_TIMEOUT,
    )
    .await;
}

/// 在 WebSocket ASR 连接上运行时，允许测试覆盖心跳与空闲超时。
///
/// # 参数
/// - `stream`：已完成握手的 WebSocket。
/// - `audio_rx`：24 kHz 单声道 PCM 上行通道。
/// - `events`：下行事件广播端。
/// - `heartbeat_interval`：WebSocket Ping 发送间隔。
/// - `idle_timeout`：允许的最长无下行帧时间。
///
/// # 返回值
/// 无返回值。
///
/// @author zhenghq
async fn run_websocket_with_heartbeat(
    stream: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
    events: broadcast::Sender<AsrEvent>,
    heartbeat_interval: Duration,
    idle_timeout: Duration,
) {
    let (mut write, mut read) = stream.split();
    let mut resampler = match StreamingPcm16Resampler::new(24_000, 16_000, 1) {
        Ok(resampler) => resampler,
        Err(_) => {
            let _ = events.send(AsrEvent::Error {
                error: AsrError::InvalidRequest,
            });
            let _ =
                send_with_timeout(&mut write, Message::Close(None), DEEPGRAM_SEND_TIMEOUT).await;
            return;
        }
    };
    let mut audio_closed = false;
    let mut failure = Some(AsrError::Network);
    let mut heartbeat = interval(heartbeat_interval);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // 第一次 tick 立即完成；先消费掉，避免连接建立后立刻发送 Ping。
    heartbeat.tick().await;
    let mut last_inbound = Instant::now();

    loop {
        tokio::select! {
            maybe_pcm = audio_rx.recv(), if !audio_closed => {
                let Some(pcm) = maybe_pcm else {
                    if !send_with_timeout(
                        &mut write,
                        Message::Text(r#"{"type":"end"}"#.into()),
                        DEEPGRAM_SEND_TIMEOUT,
                    )
                    .await
                    {
                        tracing::warn!("websocket asr end frame send failed");
                        failure = Some(AsrError::Network);
                        break;
                    }
                    audio_closed = true;
                    continue;
                };
                let samples = pcm
                    .iter()
                    .map(|sample| f32::from(*sample) / 32_768.0)
                    .collect::<Vec<_>>();
                let blocks = match resampler.push_interleaved(&samples) {
                    Ok(blocks) => blocks,
                    Err(_) => {
                        failure = Some(AsrError::InvalidRequest);
                        break;
                    }
                };
                let mut send_failed = false;
                for block in blocks {
                    if !send_with_timeout(
                        &mut write,
                        Message::Binary(block.into()),
                        DEEPGRAM_SEND_TIMEOUT,
                    )
                    .await
                    {
                        send_failed = true;
                        break;
                    }
                }
                if send_failed {
                    tracing::warn!("websocket asr audio send failed or timed out");
                    failure = Some(AsrError::Network);
                    break;
                }
            }
            _ = heartbeat.tick() => {
                if last_inbound.elapsed() >= idle_timeout {
                    tracing::warn!(
                        idle_ms = last_inbound.elapsed().as_millis(),
                        "websocket asr heartbeat timeout"
                    );
                    failure = Some(AsrError::Network);
                    break;
                }
                if !send_with_timeout(
                    &mut write,
                    Message::Ping(Vec::new().into()),
                    DEEPGRAM_SEND_TIMEOUT,
                )
                .await
                {
                    tracing::warn!("websocket asr ping send failed or timed out");
                    failure = Some(AsrError::Network);
                    break;
                }
            }
            message = read.next() => {
                last_inbound = Instant::now();
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(frame))) => {
                        tracing::warn!(?frame, "websocket asr closed by peer");
                        break;
                    }
                    None => {
                        tracing::warn!("websocket asr stream ended");
                        break;
                    }
                    Some(Err(error)) => {
                        tracing::warn!(%error, "websocket asr read failed");
                        break;
                    }
                    _ => continue,
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                if handle_websocket_event(&value, &events) {
                    // `done` 或服务端 error 事件已明确结束本次识别；
                    // error 事件在解析函数内完成结构化上报，避免重复报错。
                    if value["type"].as_str() == Some("done") {
                        tracing::warn!("websocket asr server ended the stream");
                    }
                    failure = None;
                    break;
                }
            }
        }
    }

    if let Some(error) = failure {
        let _ = events.send(AsrEvent::Error { error });
    }
    let _ = send_with_timeout(&mut write, Message::Close(None), DEEPGRAM_SEND_TIMEOUT).await;
}

/// 驱动 DashScope 实时识别会话：重采样音频、发送结束任务并解析识别结果。
///
/// # 参数
/// - `stream`：已完成 `task-started` 握手的 WebSocket。
/// - `audio_rx`：24 kHz 单声道 PCM 上行通道。
/// - `task_id`：DashScope 任务 ID。
/// - `lang`：识别结果语言标注。
/// - `events`：下行事件广播端。
///
/// # 返回值
/// 无返回值。
///
/// @author zhenghq
async fn run_dashscope(
    stream: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
    task_id: String,
    lang: Option<String>,
    events: broadcast::Sender<AsrEvent>,
) {
    let (mut write, mut read) = stream.split();
    let mut resampler = match StreamingPcm16Resampler::new(24_000, 16_000, 1) {
        Ok(resampler) => resampler,
        Err(_) => {
            let _ = events.send(AsrEvent::Error {
                error: AsrError::InvalidRequest,
            });
            return;
        }
    };
    let mut audio_closed = false;
    let mut failure = Some(AsrError::Network);

    loop {
        tokio::select! {
            maybe_pcm = audio_rx.recv(), if !audio_closed => {
                let Some(pcm) = maybe_pcm else {
                    let finish_task = serde_json::json!({
                        "header": {
                            "action": "finish-task",
                            "task_id": task_id,
                            "streaming": "duplex"
                        },
                        "payload": {
                            "input": {}
                        }
                    });
                    if !send_with_timeout(
                        &mut write,
                        Message::Text(finish_task.to_string().into()),
                        DEEPGRAM_SEND_TIMEOUT,
                    )
                    .await
                    {
                        failure = Some(AsrError::Network);
                        break;
                    }
                    audio_closed = true;
                    continue;
                };
                let samples = pcm
                    .iter()
                    .map(|sample| f32::from(*sample) / 32_768.0)
                    .collect::<Vec<_>>();
                let blocks = match resampler.push_interleaved(&samples) {
                    Ok(blocks) => blocks,
                    Err(_) => {
                        failure = Some(AsrError::InvalidRequest);
                        break;
                    }
                };
                let mut send_failed = false;
                for block in blocks {
                    if !send_with_timeout(
                        &mut write,
                        Message::Binary(block.into()),
                        DEEPGRAM_SEND_TIMEOUT,
                    )
                    .await
                    {
                        send_failed = true;
                        break;
                    }
                }
                if send_failed {
                    tracing::warn!("dashscope asr audio send failed or timed out");
                    failure = Some(AsrError::Network);
                    break;
                }
            }
            message = read.next() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(error)) => {
                        tracing::warn!(%error, "dashscope asr read failed");
                        break;
                    }
                    _ => continue,
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                if handle_dashscope_event(&value, lang.as_deref(), &events) {
                    failure = None;
                    break;
                }
            }
        }
    }

    if let Some(error) = failure {
        let _ = events.send(AsrEvent::Error { error });
    }
    let _ = send_with_timeout(&mut write, Message::Close(None), DEEPGRAM_SEND_TIMEOUT).await;
}

/// 驱动 OpenAI Realtime 转写会话：追加 PCM、停顿后提交并解析转写事件。
///
/// # 参数
/// - `stream`：已完成 `session.update` 的 WebSocket。
/// - `audio_rx`：24 kHz 单声道 PCM 上行通道。
/// - `lang`：识别结果语言标注。
/// - `events`：下行事件广播端。
///
/// # 返回值
/// 无返回值。
///
/// @author zhenghq
async fn run_openai_realtime(
    stream: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
    lang: Option<String>,
    events: broadcast::Sender<AsrEvent>,
) {
    let (mut write, mut read) = stream.split();
    let mut transcripts = std::collections::HashMap::<String, String>::new();
    let mut audio_closed = false;
    let mut last_audio_at = None;
    let mut failure = Some(AsrError::Network);
    let mut commit_poll = interval(OPENAI_COMMIT_POLL_INTERVAL);
    commit_poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
    commit_poll.tick().await;

    loop {
        tokio::select! {
            maybe_pcm = audio_rx.recv(), if !audio_closed => {
                let Some(pcm) = maybe_pcm else {
                    audio_closed = true;
                    if last_audio_at.is_some() {
                        if !send_with_timeout(
                            &mut write,
                            Message::Text(r#"{"type":"input_audio_buffer.commit"}"#.into()),
                            DEEPGRAM_SEND_TIMEOUT,
                        )
                        .await
                        {
                            failure = Some(AsrError::Network);
                            break;
                        }
                        last_audio_at = None;
                    }
                    continue;
                };
                if !pcm.is_empty() {
                    let payload = openai_audio_append_payload(&pcm);
                    if !send_with_timeout(
                        &mut write,
                        Message::Text(payload.to_string().into()),
                        DEEPGRAM_SEND_TIMEOUT,
                    )
                    .await
                    {
                        tracing::warn!("openai realtime audio send failed or timed out");
                        failure = Some(AsrError::Network);
                        break;
                    }
                    last_audio_at = Some(Instant::now());
                }
            }
            _ = commit_poll.tick() => {
                if last_audio_at
                    .map(|last| last.elapsed() >= OPENAI_COMMIT_IDLE)
                    .unwrap_or(false)
                {
                    if !send_with_timeout(
                        &mut write,
                        Message::Text(r#"{"type":"input_audio_buffer.commit"}"#.into()),
                        DEEPGRAM_SEND_TIMEOUT,
                    )
                    .await
                    {
                        tracing::warn!("openai realtime commit send failed or timed out");
                        failure = Some(AsrError::Network);
                        break;
                    }
                    last_audio_at = None;
                }
            }
            message = read.next() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(error)) => {
                        tracing::warn!(%error, "openai realtime read failed");
                        break;
                    }
                    _ => continue,
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                let action = handle_openai_event(
                    &value,
                    &mut transcripts,
                    lang.as_deref(),
                    &events,
                );
                match action {
                    OpenAiEventAction::Terminate => {
                        failure = None;
                        break;
                    }
                    OpenAiEventAction::Continue => {
                        let completed = value["type"].as_str()
                            == Some("conversation.item.input_audio_transcription.completed");
                        if audio_closed && completed {
                            failure = None;
                            break;
                        }
                    }
                }
            }
        }
    }

    if let Some(error) = failure {
        let _ = events.send(AsrEvent::Error { error });
    }
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

/// Deepgram 单次连接内的转写状态。
#[derive(Debug, Default)]
struct DeepgramTranscriptState {
    /// 最近一条临时转写，用于过滤服务端重复推送。
    partial: String,
    /// 最近一次已提交 final 的时间片与文本，用于过滤重复事件。
    last_final: Option<(i64, i64, String)>,
}

/// 解析一条 Deepgram 服务端事件并派发内部事件。
///
/// Deepgram 的一个长 utterance 会包含多个 `is_final` 片段。每个片段都是
/// 该时间片内已经确认的稳定文本，应立即提交；`speech_final` 只表示整句结束，
/// `UtteranceEnd` 仅用于清理当前草稿，二者都不重复提交已经发出的片段。
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
            // language=multi 时语言位于 alternatives[0].languages；旧字段
            // detected_language 仅作为兼容回退。
            let lang = value["channel"]["alternatives"][0]["languages"][0]
                .as_str()
                .or_else(|| value["channel"]["detected_language"].as_str())
                .map(str::to_string);

            if is_final {
                // Deepgram 的 start/duration 标识该 final 覆盖的音频时间片。
                // 同一时间片与文本重复到达时跳过，避免网络重放造成重复字幕；
                // 缺少时间信息时不按文本去重，否则连续说出的相同短句会被误删。
                let signature = deepgram_final_signature(value, text);
                let duplicated = signature
                    .as_ref()
                    .is_some_and(|current| state.last_final.as_ref() == Some(current));
                if let Some(signature) = signature {
                    state.last_final = Some(signature);
                }
                state.partial.clear();
                if !duplicated {
                    let pause_boundaries = deepgram_pause_boundaries(value, text);
                    let _ = events.send(AsrEvent::Final {
                        text: text.to_string(),
                        lang,
                        pause_boundaries,
                    });
                }
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
            state.partial.clear();
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

/// 构造 Deepgram final 片段的去重标识。
///
/// # 参数
/// - `value`：Deepgram Results 事件。
/// - `text`：该事件携带的最终文本。
///
/// # 返回值
/// 服务端提供完整时间片时返回毫秒级起点、终点和文本；否则返回 `None`。
fn deepgram_final_signature(value: &serde_json::Value, text: &str) -> Option<(i64, i64, String)> {
    let start = value["start"].as_f64()?;
    let duration = value["duration"].as_f64()?;
    Some((
        (start * 1_000.0).round() as i64,
        ((start + duration) * 1_000.0).round() as i64,
        text.to_string(),
    ))
}

/// 从 Deepgram 词级时间戳计算自然停顿边界。
///
/// Deepgram 的 `words` 按识别顺序给出词文本与起止时间。这里只在词文本能够
/// 从当前游标开始可靠映射到 transcript 时计算边界；任一字段不匹配都返回空
/// 数组，让上层继续使用标点和长度规则切分，避免产生错位的字幕断点。
///
/// # 参数
/// - `value`：Deepgram Results 事件。
/// - `text`：当前 final 的识别文本，已去除首尾空白。
///
/// # 返回值
/// 按 Unicode 字符偏移表示、升序且去重的停顿边界。
///
/// @author zhenghq
fn deepgram_pause_boundaries(value: &serde_json::Value, text: &str) -> Vec<usize> {
    let Some(words) = value["channel"]["alternatives"][0]["words"].as_array() else {
        return Vec::new();
    };
    if words.is_empty() {
        return Vec::new();
    }

    let characters = text.chars().collect::<Vec<_>>();
    let mut cursor = 0;
    let mut mapped = Vec::with_capacity(words.len());
    for word in words {
        let Some(word_text) = word["punctuated_word"]
            .as_str()
            .filter(|candidate| !candidate.trim().is_empty())
            .or_else(|| {
                word["word"]
                    .as_str()
                    .filter(|candidate| !candidate.trim().is_empty())
            })
        else {
            return Vec::new();
        };
        let word_characters = word_text.trim().chars().collect::<Vec<_>>();
        let Some(start) = find_deepgram_word(&characters, cursor, &word_characters) else {
            return Vec::new();
        };
        let end = start + word_characters.len();
        mapped.push((start, word["start"].as_f64(), word["end"].as_f64()));
        cursor = end;
    }

    let mut boundaries = Vec::new();
    for pair in mapped.windows(2) {
        let (next_start, next_start_seconds, _) = pair[1];
        let (_, _, previous_end_seconds) = pair[0];
        if let (Some(previous_end), Some(next_start_time)) =
            (previous_end_seconds, next_start_seconds)
        {
            if next_start_time - previous_end >= DEEPGRAM_PAUSE_THRESHOLD_SECONDS {
                boundaries.push(next_start);
            }
        }
    }
    boundaries.retain(|boundary| *boundary > 0 && *boundary < characters.len());
    boundaries.sort_unstable();
    boundaries.dedup();
    boundaries
}

/// 从指定字符游标开始查找 Deepgram 词文本。
///
/// 查找前只允许跳过词间空白，不跨过其他未映射字符；这样词表与 transcript
/// 出现任何结构差异时会保守放弃停顿切分，而不是把边界落到错误位置。
///
/// # 参数
/// - `characters`：完整 transcript 的 Unicode 字符数组。
/// - `from`：本次查找的起始字符偏移。
/// - `word`：待匹配的词字符数组。
///
/// # 返回值
/// 匹配起点；无法可靠匹配时返回 `None`。
///
/// @author zhenghq
fn find_deepgram_word(characters: &[char], from: usize, word: &[char]) -> Option<usize> {
    if word.is_empty() || from >= characters.len() {
        return None;
    }
    let mut start = from;
    while start < characters.len() && characters[start].is_whitespace() {
        start += 1;
    }
    let end = start.checked_add(word.len())?;
    if end > characters.len() {
        return None;
    }
    characters[start..end]
        .iter()
        .zip(word)
        .all(|(actual, expected)| {
            actual == expected
                || (actual.is_ascii()
                    && expected.is_ascii()
                    && actual.eq_ignore_ascii_case(expected))
        })
        .then_some(start)
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

/// 解析一条 WebSocket ASR 服务端事件并派发内部事件。
///
/// 协议只使用当前句的 `text` 字段；`full` 是由服务端维护的累计全文，sidecar
/// 不读取也不拼接，避免与字幕归一化状态重复。
///
/// # 参数
/// - `value`：服务端 JSON 事件。
/// - `events`：下行事件广播端。
///
/// # 返回值
/// 服务端明确结束连接时返回 `true`。
///
/// @author zhenghq
fn handle_websocket_event(value: &serde_json::Value, events: &broadcast::Sender<AsrEvent>) -> bool {
    match value["type"].as_str() {
        Some("partial") => {
            let text = value["text"].as_str().unwrap_or_default().trim();
            if !text.is_empty() {
                let _ = events.send(AsrEvent::Partial {
                    text: text.to_string(),
                    lang: None,
                });
            }
            false
        }
        Some("final") => {
            let text = value["text"].as_str().unwrap_or_default().trim();
            if !text.is_empty() {
                let _ = events.send(AsrEvent::Final {
                    text: text.to_string(),
                    lang: None,
                    pause_boundaries: Vec::new(),
                });
            }
            false
        }
        Some("done") => true,
        Some("error") => {
            tracing::warn!(event = %value, "websocket asr error");
            let _ = events.send(AsrEvent::Error {
                error: classify_websocket_error(value),
            });
            true
        }
        _ => false,
    }
}

/// 根据 WebSocket ASR 错误事件分类，避免把鉴权问题误报为网络断线。
///
/// # 参数
/// - `value`：服务端错误事件。
///
/// # 返回值
/// 结构化 ASR 错误分类。
///
/// @author zhenghq
fn classify_websocket_error(value: &serde_json::Value) -> AsrError {
    let code = value["code"].as_str().unwrap_or_default();
    let message = value["message"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(code, "401" | "403")
        || message.contains("auth")
        || message.contains("unauthorized")
        || message.contains("forbidden")
    {
        AsrError::Auth
    } else {
        AsrError::InvalidRequest
    }
}

/// 解析一条 DashScope 实时识别事件并派发内部事件。
///
/// # 参数
/// - `value`：DashScope 服务端 JSON 事件。
/// - `lang`：识别结果语言标注。
/// - `events`：下行事件广播端。
///
/// # 返回值
/// 任务结束或失败时返回 `true`。
///
/// @author zhenghq
fn handle_dashscope_event(
    value: &serde_json::Value,
    lang: Option<&str>,
    events: &broadcast::Sender<AsrEvent>,
) -> bool {
    match value["header"]["event"].as_str() {
        Some("result-generated") => {
            let sentence = &value["payload"]["output"]["sentence"];
            let text = sentence["text"].as_str().unwrap_or_default().trim();
            if !text.is_empty() {
                let event = if sentence["sentence_end"].as_bool().unwrap_or(false) {
                    AsrEvent::Final {
                        text: text.to_string(),
                        lang: lang.map(str::to_string),
                        pause_boundaries: Vec::new(),
                    }
                } else {
                    AsrEvent::Partial {
                        text: text.to_string(),
                        lang: lang.map(str::to_string),
                    }
                };
                let _ = events.send(event);
            }
            false
        }
        Some("task-finished") => true,
        Some("task-failed") | Some("error") => {
            let error = classify_dashscope_error(value);
            let code = value["header"]["error_code"]
                .as_str()
                .or_else(|| value["header"]["code"].as_str())
                .unwrap_or("unknown");
            tracing::warn!(error_code = %code, "dashscope realtime asr failed");
            let _ = events.send(AsrEvent::Error { error });
            true
        }
        _ => false,
    }
}

/// 将 DashScope 错误码映射为稳定的内部错误分类。
///
/// # 参数
/// - `value`：DashScope 错误事件。
///
/// # 返回值
/// 鉴权、请求参数或网络错误分类。
///
/// @author zhenghq
fn classify_dashscope_error(value: &serde_json::Value) -> AsrError {
    let code = value["header"]["error_code"]
        .as_str()
        .or_else(|| value["header"]["code"].as_str())
        .or_else(|| value["payload"]["code"].as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(code.as_str(), "401" | "403")
        || code.contains("auth")
        || code.contains("unauthorized")
        || code.contains("forbidden")
        || code.contains("accessdenied")
        || code.contains("invalidapikey")
    {
        AsrError::Auth
    } else if matches!(
        code.as_str(),
        "400" | "404" | "405" | "409" | "413" | "415" | "422" | "429"
    ) || code.contains("invalid")
        || code.contains("parameter")
        || code.contains("badrequest")
        || code.contains("quota")
        || code.contains("ratelimit")
    {
        AsrError::InvalidRequest
    } else {
        AsrError::Network
    }
}

/// OpenAI Realtime 单条事件处理后的连接动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenAiEventAction {
    /// 连接可以继续接收音频和转写事件。
    Continue,
    /// 服务端错误已上报，连接应该终止。
    Terminate,
}

/// 解析一条 OpenAI Realtime 转写事件并派发内部事件。
///
/// # 参数
/// - `value`：OpenAI Realtime 服务端 JSON 事件。
/// - `transcripts`：按 item ID 累积的转写片段。
/// - `lang`：识别结果语言标注。
/// - `events`：下行事件广播端。
///
/// # 返回值
/// 后续应继续连接还是终止连接。
///
/// @author zhenghq
fn handle_openai_event(
    value: &serde_json::Value,
    transcripts: &mut std::collections::HashMap<String, String>,
    lang: Option<&str>,
    events: &broadcast::Sender<AsrEvent>,
) -> OpenAiEventAction {
    match value["type"].as_str() {
        Some("conversation.item.input_audio_transcription.delta") => {
            let Some(item_id) = value["item_id"].as_str() else {
                return OpenAiEventAction::Continue;
            };
            let delta = value["delta"].as_str().unwrap_or_default();
            if delta.is_empty() {
                return OpenAiEventAction::Continue;
            }
            let text = transcripts.entry(item_id.to_string()).or_default();
            text.push_str(delta);
            let _ = events.send(AsrEvent::Partial {
                text: text.clone(),
                lang: lang.map(str::to_string),
            });
            OpenAiEventAction::Continue
        }
        Some("conversation.item.input_audio_transcription.completed") => {
            let Some(item_id) = value["item_id"].as_str() else {
                return OpenAiEventAction::Continue;
            };
            let accumulated = transcripts.remove(item_id).unwrap_or_default();
            let transcript = value["transcript"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            let text = if transcript.is_empty() {
                accumulated.trim().to_string()
            } else {
                transcript
            };
            if !text.is_empty() {
                let _ = events.send(AsrEvent::Final {
                    text,
                    lang: lang.map(str::to_string),
                    pause_boundaries: Vec::new(),
                });
            }
            OpenAiEventAction::Continue
        }
        Some("conversation.item.input_audio_transcription.failed") | Some("error") => {
            let error = classify_openai_error(value);
            let code = value["error"]["code"]
                .as_str()
                .or_else(|| value["error"]["type"].as_str())
                .unwrap_or("unknown");
            tracing::warn!(error_code = %code, "openai realtime asr failed");
            let _ = events.send(AsrEvent::Error { error });
            OpenAiEventAction::Terminate
        }
        _ => OpenAiEventAction::Continue,
    }
}

/// 将 OpenAI Realtime 错误码映射为稳定的内部错误分类。
///
/// # 参数
/// - `value`：OpenAI Realtime 错误事件。
///
/// # 返回值
/// 鉴权、请求参数或网络错误分类。
///
/// @author zhenghq
fn classify_openai_error(value: &serde_json::Value) -> AsrError {
    let code = value["error"]["code"]
        .as_str()
        .or_else(|| value["code"].as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let kind = value["error"]["type"]
        .as_str()
        .or_else(|| value["type"].as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(code.as_str(), "401" | "403")
        || code.contains("invalid_api_key")
        || kind.contains("authentication")
        || kind.contains("permission")
    {
        AsrError::Auth
    } else if matches!(
        code.as_str(),
        "400" | "404" | "405" | "409" | "413" | "415" | "422" | "429"
    ) || kind.contains("invalid_request")
        || kind.contains("invalid_value")
        || kind.contains("model_not_found")
        || kind.contains("rate_limit")
    {
        AsrError::InvalidRequest
    } else {
        AsrError::Network
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
        assert!(url.contains("words=true"));
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

    /// 校验 WebSocket ASR 语言标签会映射为服务接受的短代码。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn websocket_language_maps_ui_locale_to_short_code() {
        assert_eq!(websocket_language("auto"), "auto");
        assert_eq!(websocket_language("zh-CN"), "zh");
        assert_eq!(websocket_language("en-US"), "en");
        assert_eq!(websocket_language("ja_JP"), "ja");
    }

    /// 校验 WebSocket ASR URL 会覆盖 language 并保留其他查询参数。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn websocket_asr_url_overrides_language_and_preserves_query() {
        assert_eq!(
            websocket_asr_url(DEFAULT_WEBSOCKET_ASR_URL, "zh-CN").unwrap(),
            "ws://127.0.0.1:9092/ws/asr?language=zh"
        );
        assert_eq!(
            websocket_asr_url(
                "wss://asr.example.com/ws/asr?token=abc&language=en",
                "en-US"
            )
            .unwrap(),
            "wss://asr.example.com/ws/asr?token=abc&language=en"
        );
        assert!(websocket_asr_url("http://127.0.0.1:9092/ws/asr", "zh").is_err());
        assert!(websocket_asr_url("ws://", "zh").is_err());
    }

    /// 校验 WebSocket ASR 事件只读取当前句 text，并正确处理 done/error。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn websocket_events_use_text_and_terminate_on_done_or_error() {
        let (tx, mut rx) = broadcast::channel(8);

        let partial = serde_json::json!({
            "type": "partial",
            "text": " 你好 ",
            "full": "不应读取的累计全文"
        });
        assert!(!handle_websocket_event(&partial, &tx));
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Partial {
                text: "你好".into(),
                lang: None
            }
        );

        let final_event = serde_json::json!({
            "type": "final",
            "text": "你好世界",
            "full": "不应读取的累计全文"
        });
        assert!(!handle_websocket_event(&final_event, &tx));
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Final {
                text: "你好世界".into(),
                lang: None,
                pause_boundaries: Vec::new()
            }
        );

        assert!(handle_websocket_event(
            &serde_json::json!({ "type": "done" }),
            &tx
        ));
        assert!(rx.try_recv().is_err());

        let error_event = serde_json::json!({
            "type": "error",
            "message": "authentication failed"
        });
        assert!(handle_websocket_event(&error_event, &tx));
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Error {
                error: AsrError::Auth
            }
        );
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
                lang: Some("zh".into()),
                pause_boundaries: Vec::new()
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
                lang: None,
                pause_boundaries: Vec::new()
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
                lang: Some("zh".into()),
                pause_boundaries: Vec::new()
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
    fn is_final_commits_immediately_without_waiting_for_speech_final() {
        let (tx, mut rx) = broadcast::channel(4);
        let mut state = DeepgramTranscriptState::default();
        let is_final = serde_json::json!({
            "type": "Results",
            "is_final": true,
            "speech_final": false,
            "start": 0.0,
            "duration": 1.2,
            "channel": { "alternatives": [{ "transcript": "hello world" }] }
        });
        assert!(!handle_deepgram_event(&is_final, &mut state, &tx));
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Final {
                text: "hello world".into(),
                lang: None,
                pause_boundaries: Vec::new()
            }
        );
    }

    #[test]
    fn utterance_end_does_not_duplicate_an_already_committed_final() {
        let (tx, mut rx) = broadcast::channel(4);
        let mut state = DeepgramTranscriptState::default();
        let is_final = serde_json::json!({
            "type": "Results",
            "is_final": true,
            "speech_final": false,
            "start": 0.0,
            "duration": 1.2,
            "channel": { "alternatives": [{ "transcript": "hello world" }] }
        });
        handle_deepgram_event(&is_final, &mut state, &tx);
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Final {
                text: "hello world".into(),
                lang: None,
                pause_boundaries: Vec::new()
            }
        );
        let end = serde_json::json!({ "type": "UtteranceEnd" });
        handle_deepgram_event(&end, &mut state, &tx);
        handle_deepgram_event(&end, &mut state, &tx);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn successive_final_segments_are_both_committed() {
        let (tx, mut rx) = broadcast::channel(4);
        let mut state = DeepgramTranscriptState::default();
        for (text, start, speech_final) in [("hello", 0.0, false), ("world", 1.0, true)] {
            let value = serde_json::json!({
                "type": "Results",
                "is_final": true,
                "speech_final": speech_final,
                "start": start,
                "duration": 1.0,
                "channel": { "alternatives": [{ "transcript": text }] }
            });
            handle_deepgram_event(&value, &mut state, &tx);
        }
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Final {
                text: "hello".into(),
                lang: None,
                pause_boundaries: Vec::new()
            }
        );
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Final {
                text: "world".into(),
                lang: None,
                pause_boundaries: Vec::new()
            }
        );
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn duplicate_final_event_for_same_segment_is_ignored() {
        let (tx, mut rx) = broadcast::channel(4);
        let mut state = DeepgramTranscriptState::default();
        let value = serde_json::json!({
            "type": "Results",
            "is_final": true,
            "speech_final": true,
            "start": 2.0,
            "duration": 1.0,
            "channel": { "alternatives": [{ "transcript": "same segment" }] }
        });
        handle_deepgram_event(&value, &mut state, &tx);
        handle_deepgram_event(&value, &mut state, &tx);
        assert_eq!(
            rx.try_recv().unwrap(),
            AsrEvent::Final {
                text: "same segment".into(),
                lang: None,
                pause_boundaries: Vec::new()
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

    #[test]
    fn deepgram_words_map_pause_boundaries_to_unicode_offsets() {
        let value = serde_json::json!({
            "type": "Results",
            "is_final": true,
            "start": 0.0,
            "duration": 3.0,
            "channel": {
                "alternatives": [{
                    "transcript": "你好，世界。今天天气很好",
                    "words": [
                        { "punctuated_word": "你好，", "start": 0.0, "end": 0.5 },
                        { "punctuated_word": "世界。", "start": 0.5, "end": 1.0 },
                        { "punctuated_word": "今天", "start": 1.5, "end": 1.8 },
                        { "punctuated_word": "天气", "start": 1.8, "end": 2.1 },
                        { "punctuated_word": "很好", "start": 2.1, "end": 2.5 }
                    ]
                }]
            }
        });

        assert_eq!(
            deepgram_pause_boundaries(&value, "你好，世界。今天天气很好"),
            vec![6]
        );
    }

    #[test]
    fn deepgram_pause_boundaries_are_empty_when_word_text_cannot_be_mapped() {
        let value = serde_json::json!({
            "channel": {
                "alternatives": [{
                    "transcript": "实际转写文本",
                    "words": [
                        { "punctuated_word": "不匹配", "start": 0.0, "end": 0.5 },
                        { "punctuated_word": "文本", "start": 1.0, "end": 1.5 }
                    ]
                }]
            }
        });

        assert!(deepgram_pause_boundaries(&value, "实际转写文本").is_empty());
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

    /// 校验 WebSocket ASR 上行会重采样为 PCM16，并在音频结束后发送 end 帧。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[tokio::test]
    async fn websocket_streams_resampled_pcm16_and_sends_end_frame() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let mut received_binary = false;
            let end_text = loop {
                let message = timeout(Duration::from_secs(2), socket.next())
                    .await
                    .expect("client should send audio and end frame")
                    .expect("client should keep the socket open")
                    .expect("client frame should be valid");
                match message {
                    Message::Binary(bytes) => received_binary |= !bytes.is_empty(),
                    Message::Text(text) => break text,
                    _ => continue,
                }
            };
            assert!(received_binary, "client should send PCM16 binary audio");
            assert_eq!(end_text.as_str(), r#"{"type":"end"}"#);
            socket
                .send(Message::Text(r#"{"type":"partial","text":"你好"}"#.into()))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    r#"{"type":"final","text":"你好世界"}"#.into(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Text(r#"{"type":"done"}"#.into()))
                .await
                .unwrap();
        });

        let (stream, _) = connect_async(format!("ws://{address}")).await.unwrap();
        let (audio_tx, audio_rx) = tokio::sync::mpsc::channel(2);
        let (events, mut received) = broadcast::channel(8);
        audio_tx.send(vec![1_000; 4_800]).await.unwrap();
        drop(audio_tx);

        timeout(
            Duration::from_secs(2),
            run_websocket(stream, audio_rx, events),
        )
        .await
        .expect("websocket loop should finish after done");
        server.await.unwrap();

        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Partial {
                text: "你好".into(),
                lang: None
            }
        );
        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Final {
                text: "你好世界".into(),
                lang: None,
                pause_boundaries: Vec::new()
            }
        );
    }

    /// 校验长时间收不到任何下行帧时会判定连接失效并上报网络错误。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[tokio::test]
    async fn websocket_heartbeat_timeout_reports_network_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let _socket = accept_async(stream).await.unwrap();
            // 保持连接打开但不读取任何帧，模拟半开连接或服务端失去响应。
            tokio::time::sleep(Duration::from_secs(1)).await;
        });

        let (stream, _) = connect_async(format!("ws://{address}")).await.unwrap();
        let (audio_tx, audio_rx) = tokio::sync::mpsc::channel(2);
        let (events, mut received) = broadcast::channel(8);

        timeout(
            Duration::from_secs(2),
            run_websocket_with_heartbeat(
                stream,
                audio_rx,
                events,
                Duration::from_millis(10),
                Duration::from_millis(30),
            ),
        )
        .await
        .expect("heartbeat timeout should end websocket loop");

        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Error {
                error: AsrError::Network
            }
        );
        drop(audio_tx);
        server.abort();
    }

    /// 校验 DashScope 任务帧包含模型、16 kHz PCM 与语言提示。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn dashscope_run_task_payload_matches_realtime_protocol() {
        let payload =
            dashscope_run_task_payload("qwen-audio-3.0-asr-flash-streaming", "zh-CN", "task-1");
        assert_eq!(payload["header"]["action"], "run-task");
        assert_eq!(payload["header"]["task_id"], "task-1");
        assert_eq!(payload["header"]["streaming"], "duplex");
        assert_eq!(payload["payload"]["task_group"], "audio");
        assert_eq!(payload["payload"]["task"], "asr");
        assert_eq!(payload["payload"]["function"], "recognition");
        assert_eq!(
            payload["payload"]["model"],
            "qwen-audio-3.0-asr-flash-streaming"
        );
        assert_eq!(payload["payload"]["parameters"]["format"], "pcm");
        assert_eq!(payload["payload"]["parameters"]["sample_rate"], 16_000);
        assert_eq!(payload["payload"]["parameters"]["language_hints"][0], "zh");

        let auto = dashscope_run_task_payload("model", "auto", "task-2");
        assert!(auto["payload"]["parameters"]
            .get("language_hints")
            .is_none());
    }

    /// 校验 DashScope 临时句、句末与失败事件的事件映射。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[tokio::test]
    async fn dashscope_events_emit_partial_final_and_classified_errors() {
        let (events, mut received) = broadcast::channel(8);
        let partial = serde_json::json!({
            "header": {"event": "result-generated"},
            "payload": {"output": {"sentence": {"text": "你好", "sentence_end": false}}}
        });
        assert!(!handle_dashscope_event(&partial, Some("zh-CN"), &events));
        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Partial {
                text: "你好".into(),
                lang: Some("zh-CN".into())
            }
        );

        let final_event = serde_json::json!({
            "header": {"event": "result-generated"},
            "payload": {"output": {"sentence": {"text": "你好世界", "sentence_end": true}}}
        });
        assert!(!handle_dashscope_event(
            &final_event,
            Some("zh-CN"),
            &events
        ));
        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Final {
                text: "你好世界".into(),
                lang: Some("zh-CN".into()),
                pause_boundaries: Vec::new()
            }
        );

        let failed = serde_json::json!({
            "header": {
                "event": "task-failed",
                "error_code": "InvalidParameter",
                "error_message": "sensitive upstream detail"
            },
            "payload": {}
        });
        assert!(handle_dashscope_event(&failed, None, &events));
        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Error {
                error: AsrError::InvalidRequest
            }
        );
    }

    /// 校验 OpenAI Realtime 会话开启转写并声明 PCM24 输入格式。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn openai_session_update_enables_transcription() {
        let payload = openai_session_update_payload("gpt-4o-mini-transcribe");
        assert_eq!(payload["type"], "session.update");
        assert_eq!(payload["session"]["type"], "transcription");
        assert_eq!(
            payload["session"]["audio"]["input"]["format"]["type"],
            "audio/pcm"
        );
        assert_eq!(
            payload["session"]["audio"]["input"]["format"]["rate"],
            24_000
        );
        assert_eq!(
            payload["session"]["audio"]["input"]["transcription"]["model"],
            "gpt-4o-mini-transcribe"
        );
    }

    /// 校验 OpenAI Realtime 音频追加帧使用 base64 PCM16。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[test]
    fn openai_audio_append_encodes_pcm16() {
        use base64::Engine as _;

        let payload = openai_audio_append_payload(&[1, 2, -1]);
        assert_eq!(payload["type"], "input_audio_buffer.append");
        let audio = payload["audio"].as_str().unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(audio)
                .unwrap(),
            vec![1, 0, 2, 0, 255, 255]
        );
    }

    /// 校验 OpenAI 转写增量累计为临时文本，完成事件派发最终文本。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[tokio::test]
    async fn openai_transcription_events_emit_partial_and_final() {
        let (events, mut received) = broadcast::channel(8);
        let mut transcripts = std::collections::HashMap::new();
        let first_delta = serde_json::json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-1",
            "delta": "你"
        });
        assert_eq!(
            handle_openai_event(&first_delta, &mut transcripts, Some("zh-CN"), &events),
            OpenAiEventAction::Continue
        );
        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Partial {
                text: "你".into(),
                lang: Some("zh-CN".into())
            }
        );

        let second_delta = serde_json::json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-1",
            "delta": "好"
        });
        handle_openai_event(&second_delta, &mut transcripts, Some("zh-CN"), &events);
        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Partial {
                text: "你好".into(),
                lang: Some("zh-CN".into())
            }
        );

        let completed = serde_json::json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-1",
            "transcript": "你好世界"
        });
        assert_eq!(
            handle_openai_event(&completed, &mut transcripts, Some("zh-CN"), &events),
            OpenAiEventAction::Continue
        );
        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Final {
                text: "你好世界".into(),
                lang: Some("zh-CN".into()),
                pause_boundaries: Vec::new()
            }
        );
        assert!(!transcripts.contains_key("item-1"));
    }

    /// 校验 OpenAI 错误事件按状态码映射为稳定错误分类。
    ///
    /// # 返回值
    /// 无返回值。
    ///
    /// @author zhenghq
    #[tokio::test]
    async fn openai_errors_are_classified_without_exposing_messages() {
        let (events, mut received) = broadcast::channel(8);
        let mut transcripts = std::collections::HashMap::new();
        let error = serde_json::json!({
            "type": "error",
            "error": {"code": "invalid_api_key", "message": "sensitive upstream detail"}
        });
        assert_eq!(
            handle_openai_event(&error, &mut transcripts, None, &events),
            OpenAiEventAction::Terminate
        );
        assert_eq!(
            received.recv().await.unwrap(),
            AsrEvent::Error {
                error: AsrError::Auth
            }
        );
    }
}
