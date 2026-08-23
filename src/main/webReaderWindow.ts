import {
  BrowserWindow,
  WebContentsView,
  session,
  type Session
} from 'electron'
import { randomUUID } from 'node:crypto'
import { buildProxyConfig } from '../shared/proxySettings'
import type {
  Settings,
  WebReaderState,
  WebTranslationApplyPayload,
  WebTranslationExtractionPayload,
  WebTranslationMode,
  WebTranslationProgressPayload,
  WebTranslationRunPayload,
  WebTranslationRunRequest,
  WebTranslationUnitResult,
  WebViewBounds
} from '../shared/types'
import {
  extractWebTextBlocks,
  type ExtractedWebTextUnit
} from '../shared/webPageTranslation'
import {
  aggregatePageTranslationUnits,
  PageTranslationCoordinator,
  type PageTranslationResult,
  type PageTranslationStream
} from './pageTranslationCoordinator'
import {
  createWebPageContentFingerprint,
  WebPageTranslationCache,
  type WebPageTranslationCacheContext
} from './webPageTranslationCache'
import { normalizeWebReaderUrl, isAllowedWebReaderUrl, sanitizeWebViewBounds } from './webReaderSecurity'
import { isDisposedWebFrameError } from '../shared/webTranslationErrors'
import {
  buildWebPageChangeObserverScript,
  buildWebPageChangeStatusScript,
  buildWebDocumentReadyScript,
  buildWebIncrementalCollectorDrainScript,
  buildWebIncrementalCollectorStartScript,
  buildWebIncrementalCollectorStopScript,
  buildWebTextApplyScript,
  executeWebTextExtraction,
  waitForWebDocumentReady,
  type WebDocumentReadiness,
  type WebIncrementalTextBatch,
  type WebTextWriteOperation
} from './webTextExtractionScript'

/** 阅读器专用持久化 Session 分区。 */
export const WEB_READER_PARTITION = 'persist:web-page-translation'
const WEB_INCREMENTAL_DEBOUNCE_MS = 300
const WEB_INCREMENTAL_STOP_QUIET_MS = 1500
const WEB_INCREMENTAL_WINDOW_MAX_MS = 30_000

/** 网页阅读器依赖。 */
export interface WebReaderManagerOptions {
  /** App preload 文件路径，仅注入本地阅读器壳窗口。 */
  preloadPath: string
  /** 加载本地 Renderer 页面的函数。 */
  loadRenderer(window: BrowserWindow, html: string): void
  /** 获取当前完整设置。 */
  getSettings(): Settings
  /** 调用现有 TranslationRuntime 翻译单段文本。 */
  translate(text: string, sourceLang: string, targetLang: string): Promise<{ translation: string; provider?: string; channel?: string }>
}

/** 管理网页阅读器窗口、远程 WebContentsView、原位写回与任务代次。 */
export class WebReaderManager {
  private readonly readerId = randomUUID()
  private readonly options: WebReaderManagerOptions
  private readonly coordinator: PageTranslationCoordinator
  private readonly pageCache = new WebPageTranslationCache()
  private readerSession: Session | null = null
  private window: BrowserWindow | null = null
  private view: WebContentsView | null = null
  private pageRevision = 0
  private extractedUnits: ExtractedWebTextUnit[] = []
  private translatedUnits: WebTranslationUnitResult[] = []
  private activeJobId = ''
  private activeSourceLang = ''
  private activeTargetLang = ''
  private activeAbort: AbortController | null = null
  private mode: WebTranslationMode = 'target'
  private pageChangeTimer: ReturnType<typeof setInterval> | null = null
  private incrementalPollTimer: ReturnType<typeof setInterval> | null = null
  private incrementalQuietTimer: ReturnType<typeof setTimeout> | null = null
  private incrementalDeadlineTimer: ReturnType<typeof setTimeout> | null = null
  private activeStream: PageTranslationStream | null = null
  private incrementalUnitSequence = 0
  private incrementalDrainQueue = Promise.resolve()
  private incrementalUnitHandler: ((units: ExtractedWebTextUnit[]) => void | Promise<void>) | null = null
  private incrementalWindowRevision: number | null = null
  private incrementalGeneration = 0
  private incrementalFinishPromise: Promise<void> | null = null
  private incrementalStopPromise: Promise<unknown> = Promise.resolve()
  private incrementalSeenUnitKeys = new Set<string>()
  private hasExtractedSnapshot = false
  private state: WebReaderState

  /** 创建网页阅读器管理器。
   * @param options 阅读器依赖。
   * @author zhenghq
   */
  constructor(options: WebReaderManagerOptions) {
    this.options = options
    this.coordinator = new PageTranslationCoordinator({ concurrency: 3, translate: options.translate })
    this.state = this.createState()
  }

  /** 打开或聚焦阅读器。
   * @param url 可选初始 URL。
   * @returns 无返回值。
   * @author zhenghq
   */
  async open(url?: string): Promise<void> {
    if (!this.options.getSettings().webTranslationEnabled) throw new Error('网页全文翻译已在设置中关闭')
    await this.ensureWindow()
    this.window?.show()
    this.window?.focus()
    if (url) await this.navigate(url)
  }

  /** 关闭阅读器并取消任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  close(): void {
    this.cancel()
    this.window?.close()
  }

  /** 导航到 HTTP(S) URL。
   * @param url 地址栏内容。
   * @returns 最新导航状态。
   * @author zhenghq
   */
  async navigate(url: string): Promise<WebReaderState> {
    await this.ensureWindow()
    const normalized = normalizeWebReaderUrl(url)
    this.clearError()
    await this.view?.webContents.loadURL(normalized)
    return this.getState()
  }

  /** 在历史记录中后退。
   * @returns 无返回值。
   * @author zhenghq
   */
  back(): void {
    if (this.view?.webContents.navigationHistory.canGoBack()) this.view.webContents.navigationHistory.goBack()
  }

  /** 在历史记录中前进。
   * @returns 无返回值。
   * @author zhenghq
   */
  forward(): void {
    if (this.view?.webContents.navigationHistory.canGoForward()) this.view.webContents.navigationHistory.goForward()
  }

  /** 刷新当前网页。
   * @returns 无返回值。
   * @author zhenghq
   */
  reload(): void {
    this.view?.webContents.reload()
  }

  /** 同步原生 View 矩形。
   * @param bounds Renderer 占位区矩形。
   * @returns 无返回值。
   * @author zhenghq
   */
  setBounds(bounds: WebViewBounds): void {
    if (!this.window || !this.view || this.window.isDestroyed()) return
    const [width, height] = this.window.getContentSize()
    this.view.setBounds(sanitizeWebViewBounds(bounds, { width, height }))
  }

  /** 显式提取当前已渲染网页文本并启动初始加载增量收集器。
   * @returns 最新提取结果。
   * @author zhenghq
   */
  async extract(): Promise<WebTranslationExtractionPayload> {
    const view = this.requireLoadedView()
    this.invalidateActiveJob(true)
    await this.incrementalStopPromise
    const navigationRevision = this.pageRevision
    // 只等待主文档根节点出现，不等待 DOMContentLoaded、图片、埋点或长连接。
    await waitForWebDocumentReady(() =>
      view.webContents.executeJavaScript(buildWebDocumentReadyScript(), true) as Promise<WebDocumentReadiness>
    )
    await this.restoreSource()
    const raw = await executeWebTextExtraction(() =>
      view.webContents.executeJavaScript(buildWebIncrementalCollectorStartScript(WEB_INCREMENTAL_DEBOUNCE_MS), true)
    )
    if (navigationRevision !== this.pageRevision) throw new Error('网页已变化，请重新提取')
    const result = extractWebTextBlocks(raw.snapshot, raw.pageMeta)
    this.pageRevision += 1
    this.extractedUnits = result.units
    this.translatedUnits = []
    this.incrementalUnitSequence = result.units.length
    this.incrementalSeenUnitKeys = new Set(result.units.map((unit) => this.unitKey(unit)))
    this.hasExtractedSnapshot = true
    this.state = {
      ...this.state,
      pageRevision: this.pageRevision,
      pageUpdated: false,
      translationWindowActive: true,
      translationDiscovered: 0,
      translationDone: 0,
      translationCacheHits: 0
    }
    this.emitState()
    this.stopPageChangePolling()
    return { ...result, readerId: this.readerId, pageRevision: this.pageRevision }
  }

  /** 按语言方向翻译当前快照并原位写回。
   * @param request 翻译范围和语言方向。
   * @returns 翻译、聚合与写回结果。
   * @author zhenghq
   */
  async run(request: WebTranslationRunRequest = {}): Promise<WebTranslationRunPayload> {
    if (!this.hasExtractedSnapshot) throw new Error('请先提取当前网页文本')
    // run 只失效旧翻译任务，不停止本次 extract 已启动的增量收集器。
    this.invalidateActiveJob(false)
    await this.restoreSource()
    const settings = this.options.getSettings()
    const sourceLang = request.sourceLang?.trim() || settings.sourceLang || 'auto'
    const configuredTarget = request.targetLang?.trim() || settings.targetLang?.trim()
    const targetLang = configuredTarget && configuredTarget.toLowerCase() !== 'auto' ? configuredTarget : 'ZH'
    const jobId = randomUUID()
    const controller = new AbortController()
    const revision = this.pageRevision
    const scope = request.scope ?? settings.webTranslationScope
    this.activeJobId = jobId
    this.activeSourceLang = sourceLang
    this.activeTargetLang = targetLang
    this.activeAbort = controller
    let apply: WebTranslationApplyPayload = { applied: 0, mismatched: 0, skipped: 0 }
    let applyQueue = Promise.resolve()
    const latestResults = new Map<string, PageTranslationResult>()
    const cachedTranslations = new Map<string, WebTranslationUnitResult>()
    const cacheContext = this.createCacheContext(scope, sourceLang, targetLang)
    /** 判断增量结果是否仍属于当前阅读器任务。 */
    const isCurrentJob = (): boolean => this.activeJobId === jobId && this.pageRevision === revision &&
      this.activeSourceLang === sourceLang && this.activeTargetLang === targetLang
    /** 累加一次文本单元写回统计，供最终结果汇总。 */
    const addApplyResult = (result: WebTranslationApplyPayload): void => {
      apply = {
        applied: apply.applied + result.applied,
        mismatched: apply.mismatched + result.mismatched,
        skipped: apply.skipped + result.skipped
      }
    }
    /**
     * 将缓存命中单元合并到当前结果并按当前锚点写回。
     * @param units 当前页面缓存命中的文本单元。
     * @returns 写回完成后的 Promise。
     * @author zhenghq
     */
    const applyCacheHits = async (units: WebTranslationUnitResult[]): Promise<void> => {
      if (!isCurrentJob() || units.length === 0) return
      for (const unit of units) cachedTranslations.set(unit.id, unit)
      this.translatedUnits = this.mergeTranslatedUnits(latestResults, cachedTranslations)
      this.state = { ...this.state, translationCacheHits: cachedTranslations.size }
      this.emitState()
      if (this.mode === 'target') {
        addApplyResult(await this.applyUnits('target', new Set(units.map((unit) => unit.id))))
      }
    }
    const initialHits = this.pageCache.match(cacheContext, this.extractedUnits)
    await applyCacheHits(initialHits)
    const initialHitIds = new Set(initialHits.map((unit) => unit.id))
    const stream = this.coordinator.createStream({
      readerId: this.readerId,
      pageRevision: revision,
      jobId,
      scope,
      maxCharsPerSegment: 500,
      maxBlocks: settings.webTranslationMaxBlocks,
      maxChars: settings.webTranslationMaxChars,
      locale: sourceLang === 'auto' ? undefined : sourceLang,
      sourceLang,
      targetLang
    }, (progress) => {
      this.state = {
        ...this.state,
        translationDiscovered: progress.discovered,
        translationDone: progress.done,
        translationWindowActive: !progress.inputClosed
      }
      this.emitState()
      this.emitProgress({ ...progress, readerId: this.readerId, sourceLang, targetLang, cacheHits: cachedTranslations.size })
    }, controller.signal, async (segmentResult: PageTranslationResult, unitComplete: boolean) => {
      if (!isCurrentJob()) return
      latestResults.set(segmentResult.segmentId, segmentResult)
      if (!unitComplete) return
      // 不让多个翻译 worker 并发执行 executeJavaScript，避免页面写回互相覆盖。
      applyQueue = applyQueue.then(async () => {
        if (!isCurrentJob()) return
        const units = this.mergeTranslatedUnits(latestResults, cachedTranslations)
        const completedUnit = units.find((unit) => unit.id === segmentResult.unitId)
        if (!completedUnit || !isCurrentJob()) return
        this.translatedUnits = units
        // 仅写回刚完成的文本单元，避免等待其他分段或重复刷新整页。
        if (isCurrentJob() && this.mode === 'target' && typeof completedUnit.translation === 'string') {
          addApplyResult(await this.applyUnits('target', new Set([completedUnit.id])))
        }
      })
      await applyQueue
    })
    this.activeStream = stream
    stream.enqueue(this.extractedUnits.filter((unit) => !initialHitIds.has(unit.id)))
    this.startIncrementalWindow(stream, revision, async (newUnits) => {
      if (!isCurrentJob()) return
      const currentContext = this.createCacheContext(scope, sourceLang, targetLang)
      const hits = this.pageCache.match(currentContext, newUnits)
      await applyCacheHits(hits)
      const hitIds = new Set(hits.map((unit) => unit.id))
      stream.enqueue(newUnits.filter((unit) => !hitIds.has(unit.id)))
    })
    const result = await stream.result
    await applyQueue
    const current = isCurrentJob()
    let units: WebTranslationUnitResult[] = []
    if (current) {
      units = this.mergeTranslatedUnits(latestResults, cachedTranslations)
      this.translatedUnits = units
      if (!result.progress.cancelled) {
        const finalContext = this.createCacheContext(scope, sourceLang, targetLang)
        this.pageCache.put(finalContext, units.map((unit) => ({
          sourceText: unit.sourceText,
          sourceFingerprint: unit.anchor.sourceFingerprint,
          translation: unit.translation,
          error: unit.error
        })))
        this.activeJobId = ''
        this.activeAbort = null
        this.activeStream = null
      }
    }
    return {
      ...result,
      results: result.results,
      units,
      apply,
      sourceLang,
      targetLang,
      cacheHits: cachedTranslations.size,
      progress: { ...result.progress, readerId: this.readerId, sourceLang, targetLang, cacheHits: cachedTranslations.size }
    }
  }

  /** 取消当前任务并拒绝迟到结果。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancel(): void {
    this.invalidateActiveJob(true)
  }

  /** 在原文和当前译文之间切换，不重新加载页面。
   * @param mode 展示模式。
   * @returns 写回统计。
   * @author zhenghq
   */
  async setMode(mode: WebTranslationMode): Promise<WebTranslationApplyPayload> {
    this.mode = mode
    return this.applyUnits(mode)
  }

  /** 将代理配置应用到独立阅读器 Session。
   * @param settings 当前设置。
   * @returns 应用完成的 Promise。
   * @author zhenghq
   */
  async applyProxy(settings: Settings): Promise<void> {
    const currentSession = this.getSession()
    await currentSession.setProxy(buildProxyConfig(settings))
    await currentSession.closeAllConnections()
  }

  /** 返回当前阅读器状态。
   * @returns 状态副本。
   * @author zhenghq
   */
  getState(): WebReaderState {
    return { ...this.state }
  }

  /**
   * 根据最新分段结果和页面缓存结果聚合当前快照。
   * @param latestResults 当前任务已经完成的分段结果。
   * @param cachedTranslations 当前页面缓存命中的文本单元译文。
   * @returns 按当前页面快照顺序排列的文本单元结果。
   * @author zhenghq
   */
  private mergeTranslatedUnits(
    latestResults: ReadonlyMap<string, PageTranslationResult>,
    cachedTranslations: ReadonlyMap<string, WebTranslationUnitResult>
  ): WebTranslationUnitResult[] {
    const translated = aggregatePageTranslationUnits(
      this.extractedUnits,
      Array.from(latestResults.values())
    )
    return translated.map((unit) => cachedTranslations.get(unit.id) ?? unit)
  }

  /**
   * 创建当前页面翻译缓存上下文，避免不同配置之间串用译文。
   * @param scope 当前翻译范围。
   * @param sourceLang 当前源语言。
   * @param targetLang 当前目标语言。
   * @returns 页面缓存上下文。
   * @author zhenghq
   */
  private createCacheContext(
    scope: WebTranslationRunRequest['scope'],
    sourceLang: string,
    targetLang: string
  ): WebPageTranslationCacheContext {
    const settings = this.options.getSettings()
    const translationContext = JSON.stringify({
      preferredTranslationProvider: settings.preferredTranslationProvider,
      aiEnabled: settings.aiEnabled,
      aiProtocol: settings.aiProtocol,
      aiBaseUrl: settings.aiBaseUrl,
      aiModel: settings.aiModel,
      microsoftEnabled: settings.microsoftEnabled,
      deepLxUrl: settings.deepLxUrl,
      dingTalkEnabled: settings.dingTalkEnabled
    })
    return {
      url: this.state.url,
      pageFingerprint: createWebPageContentFingerprint(this.extractedUnits),
      scope: scope ?? settings.webTranslationScope,
      sourceLang,
      targetLang,
      translationContext
    }
  }

  /**
   * 生成主进程侧的文本单元去重键，防止局部快照重复加入翻译队列。
   * @param unit 待去重的网页文本单元。
   * @returns 由锚点、原文指纹和原文组成的稳定键。
   * @author zhenghq
   */
  private unitKey(unit: ExtractedWebTextUnit): string {
    return `${unit.anchor.parentSelector}|${unit.anchor.textNodeIndex}|${unit.anchor.sourceFingerprint}|${unit.sourceText}`
  }

  /**
   * 启动有限的网页初始加载增量翻译窗口。
   * @param stream 当前页面翻译流。
   * @param revision 当前页面代次。
   * @param onUnits 新增文本单元回调。
   * @returns 无返回值。
   * @author zhenghq
   */
  private startIncrementalWindow(
    stream: PageTranslationStream,
    revision: number,
    onUnits: (units: ExtractedWebTextUnit[]) => void | Promise<void>
  ): void {
    const collectorActive = this.state.translationWindowActive === true
    this.stopIncrementalTimers()
    this.incrementalGeneration += 1
    this.incrementalFinishPromise = null
    this.incrementalWindowRevision = revision
    this.incrementalUnitHandler = onUnits
    this.activeStream = stream
    if (!collectorActive) {
      this.incrementalWindowRevision = null
      this.incrementalUnitHandler = null
      this.activeStream = null
      stream.closeInput()
      void this.installPageChangeMonitoring(revision)
      return
    }

    const poll = (): void => { void this.drainIncrementalUnits(revision) }
    this.incrementalPollTimer = setInterval(poll, WEB_INCREMENTAL_DEBOUNCE_MS)
    poll()
    this.incrementalDeadlineTimer = setTimeout(() => {
      void this.finishIncrementalWindow(revision)
    }, WEB_INCREMENTAL_WINDOW_MAX_MS)
    if (!this.state.loading) this.scheduleIncrementalQuietStop(revision)
  }

  /**
   * 排空页面侧增量快照并把新增文本追加到当前翻译任务。
   * @param revision 当前页面代次。
   * @returns 排空完成后的 Promise。
   * @author zhenghq
   */
  private drainIncrementalUnits(revision: number): Promise<void> {
    const run = this.incrementalDrainQueue.then(async () => {
      if (this.incrementalWindowRevision !== revision || this.pageRevision !== revision) return
      const contents = this.view?.webContents
      if (!contents || contents.isDestroyed()) return
      let batch: WebIncrementalTextBatch
      try {
        batch = await contents.executeJavaScript(buildWebIncrementalCollectorDrainScript(), true) as WebIncrementalTextBatch
      } catch (error) {
        if (!isDisposedWebFrameError(error)) this.markPageUpdated()
        return
      }
      if (this.incrementalWindowRevision !== revision || this.pageRevision !== revision) return
      if (!batch.active) {
        void this.finishIncrementalWindow(revision)
        return
      }
      const newUnits: ExtractedWebTextUnit[] = []
      for (const snapshot of batch.snapshots ?? []) {
        const extracted = extractWebTextBlocks(snapshot, batch.pageMeta)
        for (const unit of extracted.units) {
          const key = this.unitKey(unit)
          if (this.incrementalSeenUnitKeys.has(key)) continue
          this.incrementalSeenUnitKeys.add(key)
          const sequence = this.incrementalUnitSequence++
          newUnits.push({
            ...unit,
            id: `stream-${revision}-${sequence}`,
            blockId: `${unit.blockId}:stream-${sequence}`
          })
        }
      }
      if (newUnits.length === 0) return
      this.extractedUnits.push(...newUnits)
      this.state = {
        ...this.state,
        translationDiscovered: this.activeStream?.getProgress().discovered ?? this.state.translationDiscovered
      }
      this.emitState()
      await this.incrementalUnitHandler?.(newUnits)
    })
    this.incrementalDrainQueue = run.catch(() => undefined)
    return run
  }

  /**
   * 页面停止加载后安排静默期结束增量窗口。
   * @param revision 当前页面代次。
   * @returns 无返回值。
   * @author zhenghq
   */
  private scheduleIncrementalQuietStop(revision: number): void {
    if (this.incrementalQuietTimer) clearTimeout(this.incrementalQuietTimer)
    this.incrementalQuietTimer = setTimeout(() => {
      void this.finishIncrementalWindow(revision)
    }, WEB_INCREMENTAL_STOP_QUIET_MS)
  }

  /**
   * 结束增量收集器并关闭翻译流输入，之后只保留页面变化提示。
   * @param revision 当前页面代次。
   * @returns 停止操作完成后的 Promise。
   * @author zhenghq
   */
  private async finishIncrementalWindow(revision: number): Promise<void> {
    if (this.incrementalWindowRevision !== revision) return
    if (this.incrementalFinishPromise) return this.incrementalFinishPromise
    const generation = this.incrementalGeneration
    this.stopIncrementalTimers()
    const finish = (async () => {
      await this.drainIncrementalUnits(revision)
      if (generation !== this.incrementalGeneration || this.incrementalWindowRevision !== revision) return
      const stream = this.activeStream
      this.incrementalWindowRevision = null
      this.incrementalUnitHandler = null
      this.activeStream = null
      stream?.closeInput()
      this.state = { ...this.state, translationWindowActive: false }
      this.emitState()
      const contents = this.view?.webContents
      if (contents && !contents.isDestroyed()) {
        try {
          await contents.executeJavaScript(buildWebIncrementalCollectorStopScript(), true)
        } catch (error) {
          if (!isDisposedWebFrameError(error)) this.markPageUpdated()
        }
      }
      if (generation === this.incrementalGeneration) await this.installPageChangeMonitoring(revision)
    })()
    this.incrementalFinishPromise = finish.finally(() => {
      if (generation === this.incrementalGeneration) this.incrementalFinishPromise = null
    })
    return this.incrementalFinishPromise
  }

  /**
   * 立即终止增量窗口，不再排空旧页面缓冲区。
   * @returns 无返回值。
   * @author zhenghq
   */
  private abortIncrementalWindow(): void {
    this.incrementalGeneration += 1
    this.incrementalFinishPromise = null
    this.stopIncrementalTimers()
    this.incrementalWindowRevision = null
    this.incrementalUnitHandler = null
    this.activeStream?.closeInput()
    this.activeStream = null
    this.state = { ...this.state, translationWindowActive: false }
    this.emitState()
    const contents = this.view?.webContents
    if (contents && !contents.isDestroyed()) {
      this.incrementalStopPromise = contents.executeJavaScript(buildWebIncrementalCollectorStopScript(), true).catch(() => undefined)
    } else {
      this.incrementalStopPromise = Promise.resolve()
    }
  }

  /**
   * 安装窗口结束后的页面变化观察器并启动状态轮询。
   * @param revision 当前页面代次。
   * @returns 安装完成后的 Promise。
   * @author zhenghq
   */
  private async installPageChangeMonitoring(revision: number): Promise<void> {
    if (this.pageRevision !== revision) return
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) return
    try {
      await contents.executeJavaScript(buildWebPageChangeObserverScript(), true)
      if (this.pageRevision === revision) this.startPageChangePolling()
    } catch (error) {
      if (!isDisposedWebFrameError(error)) this.markPageUpdated()
    }
  }

  /**
   * 清理增量窗口的轮询和定时器。
   * @returns 无返回值。
   * @author zhenghq
   */
  private stopIncrementalTimers(): void {
    if (this.incrementalPollTimer) clearInterval(this.incrementalPollTimer)
    if (this.incrementalQuietTimer) clearTimeout(this.incrementalQuietTimer)
    if (this.incrementalDeadlineTimer) clearTimeout(this.incrementalDeadlineTimer)
    this.incrementalPollTimer = null
    this.incrementalQuietTimer = null
    this.incrementalDeadlineTimer = null
  }

  /**
   * 将保存的文本单元按指定模式写回远程页面。
   * @param mode 原文或译文模式。
   * @param onlyUnitIds 可选的增量写回单元集合；未提供时写回全部快照单元。
   * @returns 写回统计。
   * @author zhenghq
   */
  private async applyUnits(mode: WebTranslationMode, onlyUnitIds?: ReadonlySet<string>): Promise<WebTranslationApplyPayload> {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return { applied: 0, mismatched: 0, skipped: 0 }
    const translations = new Map(this.translatedUnits.map((unit) => [unit.id, unit]))
    const operations: WebTextWriteOperation[] = this.extractedUnits
      .filter((unit) => !onlyUnitIds || onlyUnitIds.has(unit.id))
      .map((unit) => ({
        unitId: unit.id,
        sourceText: unit.sourceText,
        anchor: unit.anchor,
        translation: translations.get(unit.id)?.translation
      }))
    if (operations.length === 0) return { applied: 0, mismatched: 0, skipped: 0 }
    try {
      const result = await view.webContents.executeJavaScript(buildWebTextApplyScript(operations, mode), true) as WebTranslationApplyPayload
      if (result.mismatched > 0) this.markPageUpdated()
      return result
    } catch (error) {
      // 导航或关闭窗口会销毁远程 Frame，旧任务的增量写回应安全跳过而不是冒泡异常。
      if (isDisposedWebFrameError(error)) return { applied: 0, mismatched: 0, skipped: operations.length }
      throw error
    }
  }

  /**
   * 恢复当前快照原文。
   * @returns 写回统计。
   * @author zhenghq
   */
  private async restoreSource(): Promise<WebTranslationApplyPayload> {
    return this.applyUnits('source')
  }

  /**
   * 创建阅读器壳窗口与远程 View。
   * @returns 窗口初始化完成后的 Promise。
   * @author zhenghq
   */
  private async ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return
    await this.applyProxy(this.options.getSettings())
    const window = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 760,
      minHeight: 520,
      title: '划词翻译 · 网页翻译',
      webPreferences: { preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    const view = new WebContentsView({
      webPreferences: { session: this.getSession(), contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    window.contentView.addChildView(view)
    this.window = window
    this.view = view
    this.bindRemoteEvents(view)
    window.on('closed', () => this.disposeWindow(window, view))
    window.webContents.once('did-finish-load', () => this.emitState())
    this.mode = this.options.getSettings().webTranslationDefaultMode
    this.options.loadRenderer(window, 'web-reader.html')
  }

  /**
   * 返回或创建隔离的阅读器 Session。
   * @returns 阅读器专用 Session。
   * @author zhenghq
   */
  private getSession(): Session {
    if (!this.readerSession) {
      this.readerSession = session.fromPartition(WEB_READER_PARTITION)
      this.readerSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
      this.readerSession.setPermissionCheckHandler(() => false)
    }
    return this.readerSession
  }

  /**
   * 绑定远程页面导航、安全与加载事件。
   * @param view 远程网页原生视图。
   * @returns 无返回值。
   * @author zhenghq
   */
  private bindRemoteEvents(view: WebContentsView): void {
    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedWebReaderUrl(url)) event.preventDefault()
    })
    contents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return
      this.advancePage(url)
      this.state.loading = true
      this.emitState()
    })
    contents.on('page-title-updated', (_event, title) => {
      this.state.title = title
      this.emitState()
    })
    contents.on('did-stop-loading', () => {
      this.state.loading = false
      this.syncNavigationState()
      this.emitState()
      if (this.incrementalWindowRevision !== null) {
        this.scheduleIncrementalQuietStop(this.incrementalWindowRevision)
      }
    })
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      this.state = { ...this.state, url, loading: false, error: `网页加载失败：${description || code}` }
      this.syncNavigationState()
      this.emitState()
    })
  }

  /**
   * 页面主文档变化时递增代次并清空快照。
   * @param url 新页面地址。
   * @returns 无返回值。
   * @author zhenghq
   */
  private advancePage(url: string): void {
    this.invalidateActiveJob(true)
    this.stopPageChangePolling()
    this.pageRevision += 1
    this.extractedUnits = []
    this.translatedUnits = []
    this.incrementalSeenUnitKeys.clear()
    this.hasExtractedSnapshot = false
    this.state = {
      ...this.state,
      pageRevision: this.pageRevision,
      url,
      title: '',
      error: undefined,
      pageUpdated: false,
      translationWindowActive: false,
      translationDiscovered: 0,
      translationDone: 0,
      translationCacheHits: 0
    }
  }

  /**
   * 使当前任务失效并触发取消信号。
   * @param stopCollector 是否同时结束当前页面的增量收集窗口。
   * @returns 无返回值。
   * @author zhenghq
   */
  private invalidateActiveJob(stopCollector = true): void {
    if (stopCollector) this.abortIncrementalWindow()
    if (this.activeJobId) {
      this.coordinator.invalidate(
        this.readerId,
        this.pageRevision,
        this.activeJobId,
        this.activeSourceLang,
        this.activeTargetLang
      )
    }
    this.activeAbort?.abort()
    this.activeAbort = null
    this.activeJobId = ''
    this.activeSourceLang = ''
    this.activeTargetLang = ''
  }

  /**
   * 启动页面变化状态轮询。
   * @returns 无返回值。
   * @author zhenghq
   */
  private startPageChangePolling(): void {
    this.stopPageChangePolling()
    this.pageChangeTimer = setInterval(() => {
      const contents = this.view?.webContents
      if (!contents || contents.isDestroyed() || this.state.loading || this.state.pageUpdated) return
      void contents.executeJavaScript(buildWebPageChangeStatusScript(), true)
        .then((updated) => { if (updated) this.markPageUpdated() })
        .catch(() => undefined)
    }, 1000)
  }

  /**
   * 停止页面变化状态轮询。
   * @returns 无返回值。
   * @author zhenghq
   */
  private stopPageChangePolling(): void {
    if (this.pageChangeTimer) clearInterval(this.pageChangeTimer)
    this.pageChangeTimer = null
  }

  /**
   * 标记页面内容已更新并广播。
   * @returns 无返回值。
   * @author zhenghq
   */
  private markPageUpdated(): void {
    if (this.state.pageUpdated) return
    this.state = { ...this.state, pageUpdated: true }
    this.emitState()
    this.window?.webContents.send('web-translate:page-updated', true)
  }

  /**
   * 同步前进后退能力。
   * @returns 无返回值。
   * @author zhenghq
   */
  private syncNavigationState(): void {
    const history = this.view?.webContents.navigationHistory
    this.state.canGoBack = history?.canGoBack() ?? false
    this.state.canGoForward = history?.canGoForward() ?? false
  }

  /**
   * 广播阅读器状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  private emitState(): void {
    this.window?.webContents.send('web-reader:state', this.getState())
  }

  /**
   * 广播网页翻译进度。
   * @param progress 最新网页翻译进度。
   * @returns 无返回值。
   * @author zhenghq
   */
  private emitProgress(progress: WebTranslationProgressPayload): void {
    this.window?.webContents.send('web-translate:progress', progress)
  }

  /**
   * 清理已关闭窗口的引用与任务。
   * @param window 已关闭的壳窗口。
   * @param view 已关闭的远程网页视图。
   * @returns 无返回值。
   * @author zhenghq
   */
  private disposeWindow(window: BrowserWindow, view: WebContentsView): void {
    if (this.window !== window) return
    this.invalidateActiveJob(true)
    this.stopPageChangePolling()
    if (!view.webContents.isDestroyed()) view.webContents.close()
    this.window = null
    this.view = null
    this.extractedUnits = []
    this.translatedUnits = []
    this.hasExtractedSnapshot = false
  }

  /**
   * 要求远程网页已经加载。
   * @returns 可执行提取与写回的远程网页视图。
   * @author zhenghq
   */
  private requireLoadedView(): WebContentsView {
    if (!this.view || this.view.webContents.isDestroyed()) throw new Error('网页阅读器尚未打开')
    if (!isAllowedWebReaderUrl(this.state.url)) throw new Error('请先打开一个 HTTP 或 HTTPS 网页')
    return this.view
  }

  /**
   * 清除上一次加载错误。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearError(): void {
    this.state.error = undefined
    this.emitState()
  }

  /**
   * 创建初始状态。
   * @returns 阅读器初始状态。
   * @author zhenghq
   */
  private createState(): WebReaderState {
    return {
      readerId: this.readerId,
      pageRevision: 0,
      url: '',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pageUpdated: false
    }
  }
}
