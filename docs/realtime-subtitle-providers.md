# 实时字幕渠道与待实现清单

> 状态基线：2026-11-05。本文档用于记录实时字幕渠道的当前能力和后续待办；文中待办暂不纳入本轮开发，后续恢复实施时再按优先级逐项落地。

项目将实时字幕渠道分为两类：

- **同会话实时语音识别 + 原生翻译**：音频直接进入服务商的实时语音会话，服务端可同时返回原文和译文。
- **独立 ASR + 独立文字翻译**：实时语音链路只负责稳定原文，确认后的原文再交给项目现有多通道文字翻译服务。

没有原生译文，或原生译文为空时，必须回退到现有文字翻译链路，不能因为渠道支持原生翻译就跳过兜底。

## 一、当前已落地的运行时能力

| 渠道 | 当前实现 | 状态 |
| --- | --- | --- |
| Deepgram | WebSocket 实时 ASR，输出 partial/final；final 原文进入文字翻译。 | 已接入 |
| Whisper / OpenAI 兼容服务 | HTTP 音频转写服务滚动识别，支持 faster-whisper、whisper.cpp 和 OpenAI 兼容接口。 | 已接入 |
| 通用 WebSocket ASR | 连接用户提供的通用 WebSocket ASR 服务。 | 已接入 |
| 阿里云百炼 DashScope ASR | 使用实时 ASR 模型获取原文，final 原文进入文字翻译。 | 已接入 |
| 自定义 DashScope ASR | 用户填写完整 WebSocket URL、模型和 API Key，适配 DashScope 协议。 | 已接入 |
| 自定义 OpenAI Realtime ASR | 用户填写完整 WebSocket URL、模型和 API Key，适配 Realtime 转写协议。 | 已接入 |

以上渠道均以“原文识别 + 项目文字翻译”为主，不包含各服务商的原生同声传译能力。

## 二、暂缓实施：Google Gemini Live 全链路

目前仅完成 TypeScript 侧的配置、界面、IPC 和字幕事件骨架，Rust 音频 sidecar 尚未实现 Gemini 连接与事件处理，因此该渠道**暂不视为可用**。

恢复实施时需完成以下内容：

1. **协议层**
   - ASR 提供方增加 `gemini`。
   - 启动命令增加 `targetLang`，表示用户目标译文语言；`auto` 时不下发目标语言，继续使用文字翻译兜底。
   - partial/final 事件增加 `translatedText`、`translatedLang`。
   - 补齐命令和事件的序列化、反序列化测试。

2. **字幕归并层**
   - 原文和译文必须按同一轮次或同一字幕段配对。
   - partial 只能覆盖草稿，不得覆盖已确认 final。
   - final 必须提交尾部文本，不能因迟到 partial 或连接结束丢失。
   - 原文、译文增量更新时不得串段。

3. **Gemini Live 客户端**
   - 连接 `BidiGenerateContent` WebSocket。
   - 音频格式为 16 kHz、单声道、PCM16、100 ms 一帧，MIME 为 `audio/pcm;rate=16000`。
   - setup 中的 `inputAudioTranscription`、`outputAudioTranscription` 必须位于 `setup` 层级，不能放入 `generationConfig`。
   - 解析 `inputTranscription`、`outputTranscription`、`turnComplete`、`interrupted`、`generationComplete`、`goAway` 和 `error`。
   - `modelTurn.parts[].inlineData` 仅用于判断存在音频，内容必须立即丢弃，不保留、不写日志。
   - 401/403、权限或鉴权错误归类为认证失败；400、参数或前置条件错误归类为请求失败；连接关闭归类为网络错误，允许主进程重连。

4. **目标语言映射**
   - `zh-CN` / `zh` → `zh-Hans`
   - `zh-TW` / `zh_tw` → `zh-Hant`
   - `tl` → `fil`
   - 其他短语言码原样透传。

5. **配置与界面**
   - 补充 Gemini 渠道、URL、模型、API Key、保存和清除操作的国际化文案。
   - API Key 只允许保存在主进程安全存储中，不得进入公开设置对象。
   - 评估并升级设置架构版本，保证旧设置可安全迁移。

## 三、后续原生实时翻译渠道

以下渠道在恢复开发后按优先级接入：

| 优先级 | 渠道 | 目标能力 | 主要工作 |
| --- | --- | --- | --- |
| P1 | 阿里云百炼 | 原生同声传译模式 | 接入 `qwen3.5-livetranslate-flash-realtime`，处理原文与译文配对；原生译文缺失时回退文字翻译。 |
| P1 | OpenAI Realtime | 原生翻译 + 原文转写 | 翻译使用 `gpt-realtime-translate`，原文使用实时转写模型；统一 Realtime 事件适配。 |
| P1 | Azure OpenAI Realtime | 用户部署的原生翻译与实时转写 | 增加 Azure 端点、部署名、API 版本和凭证配置。 |
| P1 | 火山引擎豆包 | 同声传译 2.0 | 接入 `volc.service_type.10053` 和 `/api/v4/ast/v2/translate`，处理混合事件和鉴权。 |
| P1 | 腾讯云 | 实时语音翻译 | 接入实时语音翻译协议、云 API 签名和 `hunyuan-translation-lite` 译文事件。 |
| P1 | 百度 | 实时语音翻译 | 接入 `/ws/realtime_speech_trans` 和对应鉴权、事件解析。 |
| P1 | xAI Grok | 回合式语音翻译 | 接入 `grok-voice-latest` + `grok-transcribe`；明确其不是严格逐 token 流式输出。 |
| P2 | Apple Speech | macOS 本地 ASR | 增加 Apple 芯片、macOS 26+、系统语言资源检测和原生桥接；不支持自动语言检测。 |

## 四、独立 ASR 扩展

以下渠道属于“独立 ASR + 独立文字翻译”，不要求服务端返回译文：

| 渠道 | 说明 | 状态 |
| --- | --- | --- |
| Apple Speech | macOS 本地 `SpeechTranscriber`；要求 Apple 芯片、macOS 26+ 且系统语言资源可用，不需要 API Key，但不支持自动语言检测。 | 待接入 |
| 自定义 DashScope ASR | 用户填写完整 WebSocket URL、模型和 API Key。 | 已接入 |
| 自定义 OpenAI Realtime ASR | 用户填写完整 WebSocket URL、模型和 API Key。 | 已接入 |

## 五、统一字幕处理约定

- ASR partial 只翻译显示层当前可见的最近 cue，不翻译宿主内部持续累计的完整草稿；迟到或回退的 partial 不得覆盖已确认文本。
- ASR final 确认后立即进入拆分和翻译流程，并支持指数退避、`Retry-After` 和有限并发调度。
- 原文和译文分别按 `segmentId` 隔离，迟到事件不能串到下一段字幕。
- 双语模式分别维护原文与译文的展示状态；翻译失败时保留原文，不清空整段字幕。
- 宿主保留完整 partial 累计草稿，供 ASR 合并和 final 复用；显示层只展示最近一条不超过 32 字符的 cue，并实时展示该 cue 的预览译文。
- partial 预览译文不进入 final 的最短展示锁；可见 cue 切换时先清空旧译文，final 到达后复用同文预览或按修正后的原文重新翻译。
- 纯 ASR final 会按 ASR 词级停顿、句末标点、句内标点、语义连接词和最大长度兜底拆成多条 cue；每条 cue 独立提交并翻译，因此长句不会再作为一整条字幕显示。
- 切分后的 cue 按原文顺序拼接必须与 final 原文完全一致；长度兜底不得切断英文单词、数字或日期。
- final 翻译默认并发 2，等待队列默认 12；并发完成不改变上屏顺序，译文必须按原文段落顺序展示。
- final 译文上屏后默认保留约 700ms，避免下一句 partial 立即覆盖；渲染端再以 200ms 稳定等待、700ms 最大等待收敛流式译文。
- Deepgram 开启词级时间戳，相邻词静音达到阈值时提供 `pauseBoundaries`；无法可靠映射词文本时不输出边界，改由标点、语义和长度规则切分。
- 带原生译文的 final 不按原文 cue 二次拆分，避免提供商译文与本地切分错位；原生译文缺失时仍回退到文字翻译。
- 连续出现相同文本的 final 是两次独立识别，不得仅按文本内容去重；仅可按服务端时间片、item ID 或等价片段身份过滤网络重放。
- 原生译文非空时才跳过文字翻译；原生译文缺失、为空或请求失败时必须回退到现有文字翻译。

## 六、来源与许可清理

恢复实施并准备发布前，需要统一清理现有音频 sidecar 的目录名、crate 名、二进制名、构建脚本、打包断言、许可与通知文件，以及源码注释中的历史来源标识，确保最终产物只包含本项目自己的命名和说明。

## 七、恢复开发时的验收门槛

每接入一个渠道，至少完成以下验证：

1. 协议编解码和异常事件测试。
2. partial/final 归并、迟到事件、断线和重连测试。
3. 原文与原生译文配对测试。
4. 原生译文缺失时回退文字翻译测试。
5. `npm run typecheck`、`npm test` 和 Rust sidecar `cargo test` 全部通过。
