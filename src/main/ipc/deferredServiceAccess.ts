import type { DingTalkConfigurationService } from '../dingtalkConfig'
import type { AiConfigurationService } from '../aiConfig'
import type { DeepgramConfigurationService } from '../deepgramConfig'
import type { WhisperConfigurationService } from '../whisperConfig'
import type { DashScopeConfigurationService } from '../dashScopeConfig'
import type { OpenAIRealtimeConfigurationService } from '../openAIRealtimeConfig'
import type { GeminiLiveConfigurationService } from '../geminiLiveConfig'
import type { DeepLxConfigurationService } from '../deepLxConfig'
import type { WebReaderManager } from '../webReaderWindow'
import type { DocumentWorkspaceManager } from '../documentWorkspaceWindow'
import type { RealtimeSubtitleController } from '../realtimeSubtitleController'
import type { ScreenshotPinWindowManager } from '../screenshotPinWindow'

/** 延迟服务访问器依赖；所有 getter 均由主进程入口注入。 */
export interface DeferredServiceAccessDependencies {
  /** 等待后台服务初始化完成。 */
  ensureReady(): Promise<void>
  /** 返回钉钉配置服务。 */
  getDingTalkConfiguration(): DingTalkConfigurationService
  /** 返回 AI 配置服务。 */
  getAiConfiguration(): AiConfigurationService
  /** 返回 Deepgram 配置服务。 */
  getDeepgramConfiguration(): DeepgramConfigurationService
  /** 返回 Whisper 配置服务。 */
  getWhisperConfiguration(): WhisperConfigurationService
  /** 返回 DashScope 配置服务。 */
  getDashScopeConfiguration(): DashScopeConfigurationService
  /** 返回 OpenAI Realtime 配置服务。 */
  getOpenAIRealtimeConfiguration(): OpenAIRealtimeConfigurationService
  /** 返回 Gemini Live 配置服务。 */
  getGeminiLiveConfiguration(): GeminiLiveConfigurationService
  /** 返回 DeepLX 配置服务。 */
  getDeepLxConfiguration(): DeepLxConfigurationService
  /** 返回网页阅读器管理器。 */
  getWebReader(): WebReaderManager
  /** 返回文档工作台管理器。 */
  getDocumentWorkspace(): DocumentWorkspaceManager
  /** 返回实时字幕控制器。 */
  getRealtimeSubtitleController(): RealtimeSubtitleController | null
  /** 返回截图贴图窗口管理器。 */
  getScreenshotPinManager(): ScreenshotPinWindowManager
}

/** 等待后台服务后返回各领域服务的访问器。 */
export interface DeferredServiceAccess {
  /** 返回已初始化的钉钉配置服务。 */
  getReadyDingTalkConfiguration(): Promise<DingTalkConfigurationService>
  /** 返回已初始化的 AI 配置服务。 */
  getReadyAiConfiguration(): Promise<AiConfigurationService>
  /** 返回已初始化的 Deepgram 配置服务。 */
  getReadyDeepgramConfiguration(): Promise<DeepgramConfigurationService>
  /** 返回已初始化的 Whisper 配置服务。 */
  getReadyWhisperConfiguration(): Promise<WhisperConfigurationService>
  /** 返回已初始化的 DashScope 配置服务。 */
  getReadyDashScopeConfiguration(): Promise<DashScopeConfigurationService>
  /** 返回已初始化的 OpenAI Realtime 配置服务。 */
  getReadyOpenAIRealtimeConfiguration(): Promise<OpenAIRealtimeConfigurationService>
  /** 返回已初始化的 Gemini Live 配置服务。 */
  getReadyGeminiLiveConfiguration(): Promise<GeminiLiveConfigurationService>
  /** 返回已初始化的 DeepLX 配置服务。 */
  getReadyDeepLxConfiguration(): Promise<DeepLxConfigurationService>
  /** 返回已初始化的网页阅读器管理器。 */
  getReadyWebReader(): Promise<WebReaderManager>
  /** 返回已初始化的文档工作台管理器。 */
  getReadyDocumentWorkspace(): Promise<DocumentWorkspaceManager>
  /** 返回已初始化的实时字幕控制器。 */
  getReadyRealtimeSubtitleController(): Promise<RealtimeSubtitleController | null>
  /** 返回已初始化的截图贴图窗口管理器。 */
  getReadyScreenshotPinManager(): Promise<ScreenshotPinWindowManager>
}

/**
 * 创建统一的后台服务就绪访问器，避免各 IPC 模块重复等待初始化。
 * @param dependencies 主进程提供的服务 getter 与就绪等待函数。
 * @returns 可在 IPC 注册阶段复用的延迟服务访问器。
 * @author zhenghq
 */
export function createDeferredServiceAccess(
  dependencies: DeferredServiceAccessDependencies
): DeferredServiceAccess {
  return {
    async getReadyDingTalkConfiguration() {
      await dependencies.ensureReady()
      return dependencies.getDingTalkConfiguration()
    },
    async getReadyAiConfiguration() {
      await dependencies.ensureReady()
      return dependencies.getAiConfiguration()
    },
    async getReadyDeepgramConfiguration() {
      await dependencies.ensureReady()
      return dependencies.getDeepgramConfiguration()
    },
    async getReadyWhisperConfiguration() {
      await dependencies.ensureReady()
      return dependencies.getWhisperConfiguration()
    },
    async getReadyDashScopeConfiguration() {
      await dependencies.ensureReady()
      return dependencies.getDashScopeConfiguration()
    },
    async getReadyOpenAIRealtimeConfiguration() {
      await dependencies.ensureReady()
      return dependencies.getOpenAIRealtimeConfiguration()
    },
    async getReadyGeminiLiveConfiguration() {
      await dependencies.ensureReady()
      return dependencies.getGeminiLiveConfiguration()
    },
    async getReadyDeepLxConfiguration() {
      await dependencies.ensureReady()
      return dependencies.getDeepLxConfiguration()
    },
    async getReadyWebReader() {
      await dependencies.ensureReady()
      return dependencies.getWebReader()
    },
    async getReadyDocumentWorkspace() {
      await dependencies.ensureReady()
      return dependencies.getDocumentWorkspace()
    },
    async getReadyRealtimeSubtitleController() {
      await dependencies.ensureReady()
      return dependencies.getRealtimeSubtitleController()
    },
    async getReadyScreenshotPinManager() {
      await dependencies.ensureReady()
      return dependencies.getScreenshotPinManager()
    }
  }
}
