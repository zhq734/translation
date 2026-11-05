//! Sidecar 与主进程之间的 stdio 行协议定义。
//!
//! 主进程通过 stdin 下发控制命令，sidecar 通过 stdout 输出低频文本事件。
//! 原始 PCM 数据只在 sidecar 内部流转，不进入协议。

use serde::{Deserialize, Serialize};

/// 音频来源选择。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioSource {
    /// 仅采集系统声音。
    System,
    /// 仅采集麦克风。
    Microphone,
    /// 同时采集系统声音与麦克风。
    Both,
}

/// 实时 ASR 提供商。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AsrProvider {
    /// Deepgram 实时语音识别。
    Deepgram,
    /// OpenAI 兼容的 Whisper 批量转写服务。
    Whisper,
    /// 本机或兼容服务提供的 WebSocket 流式语音识别。
    #[serde(rename = "websocket")]
    WebSocket,
}

/// 主进程下发的控制命令。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
pub enum Command {
    /// 启动一次采集与识别会话。
    Start {
        /// 音频来源。
        source: AudioSource,
        /// 实时 ASR 提供商。
        asr: AsrProvider,
        /// 识别语言，`auto` 表示自动检测。
        lang: String,
    },
    /// 暂停采集与识别。
    Pause,
    /// 恢复采集与识别。
    Resume,
    /// 停止会话并释放设备。
    Stop,
}

/// sidecar 上报的运行状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunState {
    /// 采集中。
    Running,
    /// 已暂停。
    Paused,
    /// 已停止。
    Stopped,
}

/// 结构化错误分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// 缺少系统录音/屏幕录制或麦克风权限。
    PermissionDenied,
    /// 音频设备不可用。
    DeviceUnavailable,
    /// 与 ASR 提供商的网络连接失败。
    Network,
    /// ASR 提供商鉴权失败。
    Auth,
    /// ASR 请求参数或当前账号额度不被服务端接受。
    InvalidRequest,
    /// 未分类错误。
    Unknown,
}

/// sidecar 输出的结构化事件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
    /// 采集与识别连接已就绪。
    Ready,
    /// 可能被后续修正的临时识别文本。
    Partial {
        /// 识别原文。
        text: String,
        /// 识别语言（可选）。
        #[serde(skip_serializing_if = "Option::is_none")]
        lang: Option<String>,
    },
    /// 已提交的稳定识别文本，主进程据此触发翻译。
    Final {
        /// 识别原文。
        text: String,
        /// 识别语言（可选）。
        #[serde(skip_serializing_if = "Option::is_none")]
        lang: Option<String>,
    },
    /// 音频电平，用于界面反馈。
    Level {
        /// 均方根电平，取值 0–1。
        rms: f32,
    },
    /// 运行状态变化。
    Status {
        /// 当前运行状态。
        state: RunState,
    },
    /// 结构化错误。
    Error {
        /// 错误分类。
        code: ErrorCode,
        /// 可选内部摘要，不直接展示给用户。
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

impl Event {
    /// 将事件编码为一行 JSON（末尾带换行）。
    ///
    /// # 返回值
    /// 可直接写入 stdout 的一行 JSON。
    pub fn to_line(&self) -> String {
        let mut line = serde_json::to_string(self)
            .unwrap_or_else(|_| "{\"type\":\"error\",\"code\":\"unknown\"}".to_string());
        line.push('\n');
        line
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_start_command() {
        let command: Command = serde_json::from_str(
            "{\"cmd\":\"start\",\"source\":\"system\",\"asr\":\"deepgram\",\"lang\":\"auto\"}",
        )
        .expect("start command should parse");
        match command {
            Command::Start { source, asr, lang } => {
                assert_eq!(source, AudioSource::System);
                assert_eq!(asr, AsrProvider::Deepgram);
                assert_eq!(lang, "auto");
            }
            _ => panic!("expected start command"),
        }
    }

    #[test]
    fn parses_whisper_start_command() {
        let command: Command = serde_json::from_str(
            "{\"cmd\":\"start\",\"source\":\"system\",\"asr\":\"whisper\",\"lang\":\"auto\"}",
        )
        .expect("whisper start command should parse");
        match command {
            Command::Start { source, asr, lang } => {
                assert_eq!(source, AudioSource::System);
                assert_eq!(asr, AsrProvider::Whisper);
                assert_eq!(lang, "auto");
            }
            _ => panic!("expected start command"),
        }
    }

    #[test]
    fn parses_websocket_start_command() {
        let command: Command = serde_json::from_str(
            "{\"cmd\":\"start\",\"source\":\"system\",\"asr\":\"websocket\",\"lang\":\"zh-CN\"}",
        )
        .expect("websocket start command should parse");
        match command {
            Command::Start { source, asr, lang } => {
                assert_eq!(source, AudioSource::System);
                assert_eq!(asr, AsrProvider::WebSocket);
                assert_eq!(lang, "zh-CN");
            }
            _ => panic!("expected start command"),
        }
    }

    #[test]
    fn parses_control_commands() {
        assert!(matches!(
            serde_json::from_str::<Command>("{\"cmd\":\"pause\"}").unwrap(),
            Command::Pause
        ));
        assert!(matches!(
            serde_json::from_str::<Command>("{\"cmd\":\"resume\"}").unwrap(),
            Command::Resume
        ));
        assert!(matches!(
            serde_json::from_str::<Command>("{\"cmd\":\"stop\"}").unwrap(),
            Command::Stop
        ));
    }

    #[test]
    fn rejects_unknown_commands() {
        assert!(serde_json::from_str::<Command>("{\"cmd\":\"explode\"}").is_err());
    }

    #[test]
    fn encodes_events_as_single_json_lines() {
        let line = Event::Partial {
            text: "hello".into(),
            lang: Some("en".into()),
        }
        .to_line();
        assert!(line.ends_with('\n'));
        let value: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(value["type"], "partial");
        assert_eq!(value["text"], "hello");
        assert_eq!(value["lang"], "en");
    }

    #[test]
    fn omits_absent_optional_fields() {
        let line = Event::Ready.to_line();
        assert_eq!(line.trim(), "{\"type\":\"ready\"}");
    }
}
