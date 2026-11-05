# 实时字幕渠道说明

本项目将实时字幕渠道分为两类：一类由实时语音服务直接提供音频流识别，另一类使用独立 ASR 获取原文；两类渠道的 final 原文都统一交给文字翻译服务生成译文。

本文档只把已经落地的渠道标记为“已接入”。尚未实现的服务仅作为扩展方向，不在设置界面提供不可用的开关。

## 一、当前已接入

### 1. 实时语音链路识别 + 内置翻译

| 渠道 | 当前实现 |
| --- | --- |
| 阿里云百炼 | DashScope 实时 ASR，默认模型 `qwen-audio-3.0-asr-flash-streaming`；识别出的 final 原文交给项目现有多通道文字翻译。 |
| OpenAI Realtime | 自定义 OpenAI Realtime 转写会话，使用 `gpt-4o-mini-transcribe` 等实时转写模型；final 原文交给现有多通道文字翻译。 |

### 2. 独立 ASR + 独立文字翻译

| 渠道 | 当前实现 |
| --- | --- |
| Deepgram | WebSocket 实时 ASR，识别结果分成 partial/final；final 原文交给现有多通道文字翻译。 |
| Whisper / OpenAI 兼容服务 | 通过 HTTP 音频转写服务滚动识别，支持 faster-whisper、whisper.cpp 和 OpenAI 兼容接口。 |
| WebSocket 流式 ASR | 连接用户提供的通用 WebSocket ASR 服务。 |
| 阿里云百炼 | DashScope 实时 ASR；可使用内置阿里云端点、模型和 API Key。 |
| 自定义 DashScope ASR | 用户填写完整 WebSocket URL、模型和 API Key，适配 DashScope 协议。 |
| 自定义 OpenAI Realtime ASR | 用户填写完整 WebSocket URL、模型和 API Key，适配 OpenAI Realtime 转写协议。 |

所有 ASR 渠道只负责产出稳定的原文事件。final 原文统一进入本项目现有的文字翻译管道，因此可以复用 AI、DeepL、DeepLX、iTranslate、钉钉等文字翻译通道及其降级策略。

## 二、可扩展但尚未接入

以下能力在参考实现中已有独立协议或客户端，但当前工程尚未接入，设置界面不会展示：

| 渠道 | 能力说明 | 接入前置工作 |
| --- | --- | --- |
| Google Gemini Live | 原音频进入 Live 会话，同时产生原文和译文。 | 新增 Live WebSocket 客户端、增量对齐器和凭证配置。 |
| Azure OpenAI Realtime | 使用用户部署的实时翻译模型和实时转写模型。 | 新增 Azure 端点/部署名配置与 Realtime 事件适配。 |
| 火山引擎豆包同声传译 | 豆包同声传译 2.0，`volc.service_type.10053`。 | 新增二进制/JSON 混合协议客户端和鉴权配置。 |
| 腾讯云实时语音翻译 | ASR 实时语音翻译，配合 `hunyuan-translation-lite`。 | 新增腾讯云签名、WebSocket 事件和译文事件适配。 |
| 百度实时语音翻译 | `/ws/realtime_speech_trans` 实时语音翻译接口。 | 新增百度 WebSocket 协议和凭证配置。 |
| xAI Grok | `grok-voice-latest` + `grok-transcribe` 回合式语音翻译。 | 新增回合式会话客户端；它不是逐 token 流式输出。 |
| Apple Speech | macOS 本地 `SpeechTranscriber`。 | 要求 Apple 芯片、macOS 26+ 且系统语言资源可用；需要独立原生桥接。 |

## 三、字幕处理约定

- ASR partial 只作为实时草稿，经过稳定器去抖后才触发预览翻译；迟到或回退的 partial 不得覆盖已确认文本。
- ASR final 会立即抢占同一段落的预览翻译，并进入带指数退避和 `Retry-After` 支持的重试流程。
- 原文和译文分别按 `segmentId` 隔离，迟到事件不会串到下一段字幕。
- 双语模式分别维护原文与译文的展示状态，翻译失败时保留原文而不是清空整段字幕。
- 预览翻译有最短请求间隔和限流冷却；final 翻译不因预览冷却而被抑制。

## 四、接入说明

- 实时语音链路需要同时处理音频上行和原文增量事件；需要服务端同时返回译文的协议必须额外处理译文增量及其与原文的配对。
- 独立 ASR 渠道只需要输出稳定的原文事件，确认文本可以继续交给本项目现有多通道文字翻译管道。
- 渠道的模型 ID、接口地址和鉴权方式可能随服务商更新；实际接入时应以对应服务商当前文档为准。
