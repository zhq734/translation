import { ipcMain } from 'electron'
import type {
  AiConfigPatch,
  DashScopeConfigPatch,
  DeepgramConfigPatch,
  DeepLxConfigPatch,
  DingTalkConfigPatch,
  GeminiLiveConfigPatch,
  OpenAIRealtimeConfigPatch,
  OcrStatus,
  Settings,
  WhisperConfigPatch
} from '../../shared/types'
import type { DeferredServiceAccess } from './deferredServiceAccess'

/** 保存对话框返回值中设置 IPC 关心的字段。 */
interface SaveDialogResult {
  /** 用户是否取消。 */
  canceled: boolean
  /** 用户选择的文件路径。 */
  filePath?: string
}

/** 保存对话框选项中设置 IPC 使用的字段。 */
interface SaveDialogOptions {
  /** 对话框标题。 */
  title: string
  /** 默认文件名。 */
  defaultPath: string
  /** 可选文件过滤器。 */
  filters?: Array<{ name: string; extensions: string[] }>
}

/** 设置、日志、诊断和提供商配置 IPC 注册依赖。 */
export interface SettingsIpcDependencies {
  /** 延迟服务访问器。 */
  deferredServices: DeferredServiceAccess
  /** 等待后台服务初始化。 */
  ensureReady(): Promise<void>
  /** 返回当前设置。 */
  getSettings(): Settings
  /** 返回快捷键注册状态。 */
  getShortcutRegistrationStates(): unknown
  /** 应用设置补丁。 */
  applySettingsPatch(patch: Partial<Settings>): Promise<Settings>
  /** 返回近期日志。 */
  getLogHistory(): unknown[]
  /** 返回当前日志文件路径。 */
  getLogFilePath(): string
  /** 显示保存对话框。 */
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogResult>
  /** 复制日志文件。 */
  copyFile(source: string, destination: string): Promise<void>
  /** 写入诊断导出文件。 */
  writeFile(path: string, data: string, encoding: 'utf-8'): Promise<void>
  /** 返回取词诊断摘要。 */
  getCaptureDiagnosticsSummary(): { days: Record<string, { summary: unknown }> }
  /** 返回取词诊断导出数据。 */
  getCaptureDiagnosticsExportData(): unknown
  /** 检查钉钉翻译。 */
  checkDingTalk(): unknown
  /** 检查 Microsoft 翻译。 */
  checkMicrosoft(): unknown
  /** 检查 Bilibili 索引翻译。 */
  checkBilibiliIndex(): unknown
  /** 列出 AI 模型。 */
  listAiModels(): unknown
  /** 检查 AI 配置。 */
  checkAi(): unknown
  /** 返回 OCR 状态。 */
  getOcrStatus(): OcrStatus | Promise<OcrStatus>
  /** 检查 DeepLX 服务。 */
  checkDeepLx(): unknown
  /** 构建 DeepLX Docker 部署命令。 */
  buildDockerCommand(port: number): string
  /** 打开 DeepLX 部署文档。 */
  openDeployDoc(): void
  /** 返回对话框标题。 */
  getLogExportTitle(): string
  /** 返回诊断导出标题。 */
  getDiagnosticsExportTitle(): string
}

/**
 * 注册设置、日志、诊断与各翻译提供商配置 IPC。
 * @param dependencies 设置状态、导出能力和提供商服务依赖。
 * @returns 无返回值。
 * @author zhenghq
 */
export function registerSettingsIpc(dependencies: SettingsIpcDependencies): void {
  ipcMain.handle('shortcut-guide:dismiss', () =>
    dependencies.applySettingsPatch({ shortcutGuideSeen: true })
  )
  ipcMain.handle('settings:get', () => dependencies.getSettings())
  ipcMain.handle('shortcuts:get-registration', () =>
    dependencies.getShortcutRegistrationStates()
  )
  /**
   * 返回内存环形缓冲中的全部近期日志，供日志查看界面初始化展示。
   * @returns 按时间升序排列的结构化日志条目。
   * @author zhenghq
   */
  ipcMain.handle('logs:get-history', () => dependencies.getLogHistory())
  /**
   * 弹出保存对话框，将当日日志文件复制到用户选定路径。
   * @returns 导出结果：成功返回保存路径，取消返回 null。
   * @author zhenghq
   */
  ipcMain.handle('logs:export', async (): Promise<string | null> => {
    const source = dependencies.getLogFilePath()
    const { canceled, filePath } = await dependencies.showSaveDialog({
      title: dependencies.getLogExportTitle(),
      defaultPath: `main-${new Date().toISOString().slice(0, 10)}.log`
    })
    if (canceled || !filePath) return null
    await dependencies.copyFile(source, filePath)
    return filePath
  })
  /**
   * 返回近两天取词诊断聚合摘要，供设置页诊断卡片展示。
   * @returns 两天聚合摘要。
   * @author zhenghq
   */
  ipcMain.handle('capture-diagnostics:get-summary', () => {
    const data = dependencies.getCaptureDiagnosticsSummary()
    const days: Record<string, unknown> = {}
    for (const [date, bucket] of Object.entries(data.days)) {
      days[date] = bucket.summary
    }
    return { days }
  })
  /**
   * 弹出保存对话框，将近两天诊断聚合与原始样本导出为 JSON 文件。
   * @returns 导出结果：成功返回保存路径，取消返回 null。
   * @author zhenghq
   */
  ipcMain.handle('capture-diagnostics:export', async (): Promise<string | null> => {
    const data = dependencies.getCaptureDiagnosticsExportData()
    const { canceled, filePath } = await dependencies.showSaveDialog({
      title: dependencies.getDiagnosticsExportTitle(),
      defaultPath: `capture-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return null
    await dependencies.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
    return filePath
  })
  ipcMain.handle('settings:set', (_event, patch: Partial<Settings>) =>
    dependencies.applySettingsPatch(patch)
  )
  ipcMain.handle('dingtalk:configure', async (_event, patch: DingTalkConfigPatch) =>
    (await dependencies.deferredServices.getReadyDingTalkConfiguration()).applyPatch(patch)
  )
  ipcMain.handle('dingtalk:clear-secret', async () =>
    (await dependencies.deferredServices.getReadyDingTalkConfiguration()).clearSecret()
  )
  ipcMain.handle('dingtalk:check', async () => {
    await dependencies.ensureReady()
    return dependencies.checkDingTalk()
  })
  ipcMain.handle('deepgram:configure', async (_event, patch: DeepgramConfigPatch) =>
    (await dependencies.deferredServices.getReadyDeepgramConfiguration()).configure(patch)
  )
  ipcMain.handle('deepgram:clear-key', async () =>
    (await dependencies.deferredServices.getReadyDeepgramConfiguration()).clearApiKey()
  )
  ipcMain.handle('whisper:configure', async (_event, patch: WhisperConfigPatch) =>
    (await dependencies.deferredServices.getReadyWhisperConfiguration()).configure(patch)
  )
  ipcMain.handle('whisper:clear-key', async () =>
    (await dependencies.deferredServices.getReadyWhisperConfiguration()).clearApiKey()
  )
  ipcMain.handle('dashscope:configure', async (_event, patch: DashScopeConfigPatch) =>
    (await dependencies.deferredServices.getReadyDashScopeConfiguration()).configure(patch)
  )
  ipcMain.handle('dashscope:clear-key', async () =>
    (await dependencies.deferredServices.getReadyDashScopeConfiguration()).clearApiKey()
  )
  ipcMain.handle('openai-realtime:configure', async (_event, patch: OpenAIRealtimeConfigPatch) =>
    (await dependencies.deferredServices.getReadyOpenAIRealtimeConfiguration()).configure(patch)
  )
  ipcMain.handle('openai-realtime:clear-key', async () =>
    (await dependencies.deferredServices.getReadyOpenAIRealtimeConfiguration()).clearApiKey()
  )
  ipcMain.handle('gemini-live:configure', async (_event, patch: GeminiLiveConfigPatch) =>
    (await dependencies.deferredServices.getReadyGeminiLiveConfiguration()).configure(patch)
  )
  ipcMain.handle('gemini-live:clear-key', async () =>
    (await dependencies.deferredServices.getReadyGeminiLiveConfiguration()).clearApiKey()
  )
  ipcMain.handle('microsoft:check', async () => {
    await dependencies.ensureReady()
    return dependencies.checkMicrosoft()
  })
  ipcMain.handle('bili-index:check', async () => {
    await dependencies.ensureReady()
    return dependencies.checkBilibiliIndex()
  })
  ipcMain.handle('ai:configure', async (_event, patch: AiConfigPatch) =>
    (await dependencies.deferredServices.getReadyAiConfiguration()).applyPatch(patch)
  )
  ipcMain.handle('ai:clear-key', async () =>
    (await dependencies.deferredServices.getReadyAiConfiguration()).clearApiKey()
  )
  ipcMain.handle('ai:list-models', async () => {
    await dependencies.ensureReady()
    return dependencies.listAiModels()
  })
  ipcMain.handle('ai:check', async () => {
    await dependencies.ensureReady()
    return dependencies.checkAi()
  })
  ipcMain.handle('ocr:get-status', () => dependencies.getOcrStatus())
  ipcMain.handle('deeplx:configure', async (_event, patch: DeepLxConfigPatch) =>
    (await dependencies.deferredServices.getReadyDeepLxConfiguration()).applyPatch(patch)
  )
  ipcMain.handle('deeplx:check', async () => {
    await dependencies.ensureReady()
    return dependencies.checkDeepLx()
  })
  ipcMain.handle('deeplx:docker-command', (_event, port: number) =>
    dependencies.buildDockerCommand(port)
  )
  ipcMain.on('deeplx:open-doc', () => dependencies.openDeployDoc())
}
