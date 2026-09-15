import {
  BrowserWindow,
  WebContentsView,
  session,
  type Rectangle,
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
  createWebTextUnitKey,
  extractWebTextBlocks,
  type ExtractedWebTextBlock,
  type ExtractedWebTextUnit,
  type WebImageCandidate
} from '../shared/webPageTranslation'
import {
  filterWebImageCandidates,
  resolveWebImageRenderDecision,
  summarizeWebImageProgress,
  type WebImageOverlayPlacement,
  type WebImageProgressSummary
} from '../shared/webImageOcr'
import { WEB_TRANSLATION_MAX_CHARS_PER_SEGMENT } from '../shared/webBlockSplitter'
import { buildWebBilingualOperations } from '../shared/webBilingualRender'
import {
  mergeWebImageResults,
  processWebImageCandidates,
  type WebImageRecognition
} from './webImagePipeline'
import type { WebImageSource } from './webImageSource'
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
import { sendToAliveWebContents } from './webContentsMessaging'
import { handBackFrontmostThen, rememberFrontmostAppIfInactiveAsync } from './macForeground'
import {
  buildWebPageChangeObserverScript,
  buildWebPageChangeStatusScript,
  buildWebDocumentReadyScript,
  buildWebIncrementalCollectorDrainScript,
  buildWebIncrementalCollectorStartScript,
  buildWebIncrementalCollectorStopScript,
  buildWebBilingualClearScript,
  buildWebBilingualInjectScript,
  buildWebBilingualStyleSheet,
  buildWebImageOverlayClearScript,
  buildWebImageOverlayInjectScript,
  buildWebImageOverlayStyleSheet,
  buildWebTextApplyScript,
  executeWebTextExtraction,
  waitForWebDocumentReady,
  type WebDocumentReadiness,
  type WebIncrementalTextBatch,
  type WebImageOverlayOperation,
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
  /** 为远程页面创建取图器；未注入时跳过图片 OCR。 */
  createImageSource?(view: WebContentsView, signal?: AbortSignal): WebImageSource
  /** 对图片字节执行 OCR 识别；未注入时跳过图片 OCR。 */
  recognizeImage?(bytes: Buffer, candidate: WebImageCandidate): Promise<WebImageRecognition>
  /** 阅读器窗口打开或关闭时通知主进程。 */
  onWindowStateChanged?: (open: boolean) => void
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
  private extractedBlocks: ExtractedWebTextBlock[] = []
  private blockUnitIds = new Map<string, string[]>()
  private extractedImageCandidates: WebImageCandidate[] = []
  private imageFilterSkipped = 0
  private translatedUnits: WebTranslationUnitResult[] = []
  private translatedImageCandidates: WebImageCandidate[] = []
  private bilingualInjected = false
  private bilingualCssKey: string | null = null
  private bilingualTargetLang = ''
  private imageOverlayInjected = false
  private imageOverlayCssKey: string | null = null
  private streamBlockIds = new Map<string, string>()
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
  private incrementalImageHandler: ((candidates: WebImageCandidate[]) => void | Promise<void>) | null = null
  private incrementalWindowRevision: number | null = null
  private incrementalGeneration = 0
  private incrementalFinishPromise: Promise<void> | null = null
  private incrementalStopPromise: Promise<unknown> = Promise.resolve()
  private incrementalSeenUnitKeys = new Set<string>()
  private hasExtractedSnapshot = false
  /** 是否正在「先交还前台、再关闭窗口」的过程中，用于阻止重复关闭。 */
  private closingWindow = false
  /** 本次关闭是否已经获准放行 close 事件，避免统一关闭入口被再次拦截。 */
  private allowWindowClose = false
  private state: WebReaderState

  /** 创建网页阅读器管理器。
   * @param options 阅读器依赖。
   * @author zhenghq
   */
  constructor(options: WebReaderManagerOptions) {
    this.options = options
    this.coordinator = new PageTranslationCoordinator({
      // 每次调度都读取最新设置，用户调整并发数后无需重启阅读器即可生效。
      concurrency: () => this.options.getSettings().webTranslationConcurrency,
      translate: options.translate
    })
    this.state = this.createState()
  }

  /** 打开或聚焦阅读器。
   * @param url 可选初始 URL。
   * @returns 无返回值。
   * @author zhenghq
   */
  async open(url?: string): Promise<void> {
    if (!this.options.getSettings().webTranslationEnabled) throw new Error('网页全文翻译已在设置中关闭')
    // 正在交还前台并关闭时不再复用即将销毁的窗口，避免关闭回调把新请求一起关掉。
    if (this.closingWindow) return
    // 必须在窗口 show()/focus() 之前等待源应用快照，否则读到的会是本应用自己，
    // 关闭阅读器时就没有可交还的目标，macOS 会把设置页提升为 key window 顶到最前。
    await rememberFrontmostAppIfInactiveAsync()
    await this.ensureWindow()
    this.window?.show()
    this.window?.focus()
    if (url) await this.navigate(url)
  }

  /**
   * 判断指定窗口是否为当前有效的网页阅读器壳窗口。
   * @param window 待校验窗口。
   * @returns 属于当前有效阅读器壳窗口时返回 true。
   * @author zhenghq
   */
  ownsWindow(window: BrowserWindow): boolean {
    return this.window === window && !window.isDestroyed()
  }

  /**
   * 激活仍然存在的网页阅读器窗口。
   * @returns 已成功激活时返回 true；窗口不存在或已销毁时返回 false。
   * @author zhenghq
   */
  focusExistingWindow(): boolean {
    if (!this.window || this.window.isDestroyed()) return false
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
    this.window.focus()
    return true
  }

  /**
   * 返回阅读器窗口当前可见的屏幕区域，供划词监听排除应用内鼠标操作。
   * @returns 窗口可见时返回其屏幕区域，不可见或已销毁时返回 null。
   * @author zhenghq
   */
  getVisibleBounds(): Rectangle | null {
    if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) return null
    return this.window.getBounds()
  }

  /**
   * 返回阅读器窗口当前是否持有焦点，供划词监听区分前台与后台窗口。
   * @returns 窗口存在且持有焦点时返回 true。
   * @author zhenghq
   */
  isWindowFocused(): boolean {
    if (!this.window || this.window.isDestroyed()) return false
    return this.window.isFocused()
  }

  /** 关闭阅读器并取消任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  close(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    this.cancel()
    if (this.closingWindow) return
    this.closingWindow = true
    // 阅读器通常是应用内最后一个 key window：直接关闭会让 macOS 把设置页提升为
    // key window 并顶到其它应用之上，因此先交还前台、确认失活后再销毁窗口。
    handBackFrontmostThen(window, () => {
      this.closingWindow = false
      if (window.isDestroyed()) return
      this.allowWindowClose = true
      window.close()
    })
  }

  /**
   * 应用退出时立即销毁阅读器，不再交还前台。
   * 退出流程中应用整体结束，交还会额外激活源应用，反而干扰系统退出动画。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    this.cancel()
    const window = this.window
    if (!window || window.isDestroyed()) return
    this.allowWindowClose = true
    this.closingWindow = false
    window.destroy()
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
    this.view.setBounds(this.calculateViewBounds(bounds, { width, height }))
  }

  /**
   * 计算远程网页视图的安全可用区域，确保标题栏和本地工具栏不被覆盖。
   * @param bounds Renderer 占位区矩形。
   * @param contentSize 当前窗口内容区尺寸。
   * @returns 裁剪后的 WebContentsView 矩形。
   * @author zhenghq
   */
  private calculateViewBounds(
    bounds: WebViewBounds,
    contentSize: Pick<Rectangle, 'width' | 'height'>
  ): Rectangle {
    return sanitizeWebViewBounds(bounds, contentSize)
  }

  /** 显式提取当前已渲染网页文本并启动初始加载增量收集器。
   * @returns 最新提取结果。
   * @author zhenghq
   */
  async extract(): Promise<WebTranslationExtractionPayload> {
    const view = this.requireLoadedView()
    this.invalidateActiveJob(true)
    await this.clearBilingualInjection()
    await this.clearImageOverlays()
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
    const settings = this.options.getSettings()
    const imageFilter = settings.webTranslationImageOcrEnabled
      ? filterWebImageCandidates(raw.imageCandidates, {
        minSize: settings.webTranslationImageOcrMinSize,
        maxImages: settings.webTranslationImageOcrMaxImages
      })
      : { accepted: [], skipped: raw.imageCandidates.length }
    this.pageRevision += 1
    this.extractedUnits = result.units
    this.extractedBlocks = result.blocks
    this.blockUnitIds = this.createBlockUnitIds(result.units)
    this.extractedImageCandidates = imageFilter.accepted
    this.imageFilterSkipped = imageFilter.skipped
    this.translatedUnits = []
    this.translatedImageCandidates = []
    this.streamBlockIds.clear()
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
      translationCacheHits: 0,
      ...summarizeWebImageProgress(this.extractedImageCandidates),
      imageSkipped: summarizeWebImageProgress(this.extractedImageCandidates).imageSkipped + this.imageFilterSkipped
    }
    this.emitState()
    this.stopPageChangePolling()
    return {
      ...result,
      readerId: this.readerId,
      pageRevision: this.pageRevision,
      imageCandidates: this.extractedImageCandidates.map((candidate) => ({ ...candidate }))
    }
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
    // 语言或任务切换时先清理旧语言对照节点，避免迟到结果与新语言叠加。
    await this.clearBilingualInjection()
    // 图片覆盖层同样按任务重建，避免旧语言或旧快照的译文残留。
    await this.clearImageOverlays()
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
    this.bilingualTargetLang = targetLang
    this.activeAbort = controller
    let apply: WebTranslationApplyPayload = { applied: 0, mismatched: 0, skipped: 0 }
    let applyQueue = Promise.resolve()
    const latestResults = new Map<string, PageTranslationResult>()
    const cachedTranslations = new Map<string, WebTranslationUnitResult>()
    const cacheContext = this.createCacheContext(scope, sourceLang, targetLang)
    const imagePlacement: WebImageOverlayPlacement = settings.webTranslationImageOcrOverlay
    const imageCandidates = settings.webTranslationImageOcrEnabled
      ? this.extractedImageCandidates.map((candidate) => ({ ...candidate }))
      : []
    // 图片缓存按页面指纹、图片标识与语言方向隔离，命中后跳过取图与 OCR。
    const cachedImageHits = new Map<string, WebImageCandidate & { ocrText: string; translation: string }>()
    for (const hit of this.pageCache.matchImages(cacheContext, imageCandidates)) {
      cachedImageHits.set(hit.imageId, hit)
    }
    const cachedImageCandidates = imageCandidates.map((candidate) => cachedImageHits.get(candidate.imageId) ?? candidate)
    const pendingImageCandidates = imageCandidates.filter((candidate) => !cachedImageHits.has(candidate.imageId))
    let imageCandidatesResult: WebImageCandidate[] = cachedImageCandidates
    let imageCancelled = false
    const processedImageIds = new Set(cachedImageHits.keys())
    let imageProcessChain = Promise.resolve()
    /** 判断增量结果是否仍属于当前阅读器任务。 */
    const isCurrentJob = (): boolean => this.activeJobId === jobId && this.pageRevision === revision &&
      this.activeSourceLang === sourceLang && this.activeTargetLang === targetLang
    /** 汇总当前图片维度的进度，包含提取阶段被过滤的候选。 */
    const currentImageSummary = (): WebImageProgressSummary => {
      const summary = summarizeWebImageProgress(imageCandidatesResult)
      return { ...summary, imageSkipped: summary.imageSkipped + this.imageFilterSkipped }
    }
    /**
     * 取图、OCR 与翻译一批图片候选，并把结果合并进当前任务。
     * @param batch 本批次待处理的图片候选。
     * @returns 处理完成后的 Promise。
     * @author zhenghq
     */
    const processImageBatch = async (batch: WebImageCandidate[]): Promise<void> => {
      if (batch.length === 0 || !isCurrentJob()) return
      const createSource = this.options.createImageSource
      const recognizeImage = this.options.recognizeImage
      const view = this.view
      const canFetch = Boolean(createSource && recognizeImage && view && !view.webContents.isDestroyed())
      let processedCandidates: WebImageCandidate[]
      if (canFetch) {
        const source = (createSource as NonNullable<typeof createSource>).call(this.options, view as WebContentsView, controller.signal)
        const processed = await processWebImageCandidates(batch, {
          source,
          recognize: (bytes, candidate) => (recognizeImage as NonNullable<typeof recognizeImage>).call(this.options, bytes, candidate),
          translate: async (text) => {
            const output = await this.options.translate(text, sourceLang, targetLang)
            return { translation: output.translation }
          },
          sourceLang,
          targetLang,
          signal: controller.signal
        })
        imageCancelled = imageCancelled || processed.cancelled
        processedCandidates = processed.candidates
      } else {
        // 缺少取图或 OCR 依赖时按跳过处理，保证图片失败不影响文本翻译。
        processedCandidates = batch.map((candidate) => ({ ...candidate, skippedReason: 'unavailable' }))
      }
      imageCandidatesResult = mergeWebImageResults(imageCandidatesResult, processedCandidates)
      for (const candidate of processedCandidates) processedImageIds.add(candidate.imageId)
      if (!isCurrentJob()) return
      this.translatedImageCandidates = imageCandidatesResult
      this.state = { ...this.state, ...currentImageSummary() }
      this.emitState()
      this.emitProgress({
        readerId: this.readerId,
        pageRevision: revision,
        jobId,
        done: this.state.translationDone ?? 0,
        discovered: this.state.translationDiscovered ?? 0,
        queued: 0,
        total: this.state.translationDiscovered ?? 0,
        failed: 0,
        cancelled: imageCancelled,
        partial: false,
        inputClosed: this.state.translationWindowActive !== true,
        sourceLang,
        targetLang,
        cacheHits: cachedTranslations.size,
        images: currentImageSummary()
      })
      await this.applyImageOverlays(imagePlacement)
    }

    /**
     * 串行排队一批图片候选，避免增量图片与首批图片并发写回互相覆盖。
     * @param batch 待处理的图片候选批次。
     * @returns 该批次处理完成后的 Promise。
     * @author zhenghq
     */
    const enqueueImageBatch = (batch: WebImageCandidate[]): Promise<void> => {
      if (batch.length === 0) return Promise.resolve()
      const run = imageProcessChain.then(() => processImageBatch(batch))
      imageProcessChain = run.catch(() => undefined)
      return run
    }
    const imagePromise = enqueueImageBatch(pendingImageCandidates)
    /** 累加一次文本单元写回统计，供最终结果汇总。 */
    const addApplyResult = (result: WebTranslationApplyPayload): void => {
      apply = {
        applied: apply.applied + result.applied,
        mismatched: apply.mismatched + result.mismatched,
        skipped: apply.skipped + result.skipped,
        bilingualSkipped: (apply.bilingualSkipped ?? 0) + (result.bilingualSkipped ?? 0),
        unrendered: (apply.unrendered ?? 0) + (result.unrendered ?? 0)
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
      if (this.mode === 'bilingual') {
        addApplyResult(await this.applyBilingual())
      } else if (this.mode === 'target') {
        addApplyResult(await this.applyUnits('target', new Set(units.map((unit) => unit.id))))
      }
    }
    const initialHits = this.selectCompleteCacheHits(
      this.pageCache.match(cacheContext, this.extractedUnits),
      this.extractedUnits
    )
    await applyCacheHits(initialHits)
    const initialHitIds = new Set(initialHits.map((unit) => unit.id))
    const stream = this.coordinator.createStream({
      readerId: this.readerId,
      pageRevision: revision,
      jobId,
      scope,
      maxCharsPerSegment: WEB_TRANSLATION_MAX_CHARS_PER_SEGMENT,
      // 相邻短段落合并为一次请求，显著降低请求数；模型未保留分隔标记时协调器会自动逐段回退。
      mergeAcrossBlocks: true,
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
        translationWindowActive: !progress.inputClosed,
        ...currentImageSummary()
      }
      this.emitState()
      this.emitProgress({
        ...progress,
        readerId: this.readerId,
        sourceLang,
        targetLang,
        cacheHits: cachedTranslations.size,
        images: currentImageSummary()
      })
    }, controller.signal, async (segmentResult: PageTranslationResult, unitComplete: boolean) => {
      if (!isCurrentJob()) return
      latestResults.set(segmentResult.segmentId, segmentResult)
      if (!unitComplete) return
      // 不让多个翻译 worker 并发执行 executeJavaScript，避免页面写回互相覆盖。
      applyQueue = applyQueue.then(async () => {
        if (!isCurrentJob()) return
        const units = this.mergeTranslatedUnits(latestResults, cachedTranslations)
        const primaryUnitId = segmentResult.unitIds[0] ?? segmentResult.unitId
        const completedUnit = units.find((unit) => unit.id === primaryUnitId)
        if (!completedUnit || !isCurrentJob()) return
        this.translatedUnits = units
        // 对照模式按块聚合：仅在所属块全部单元完成后才 upsert 该块译文节点。
        if (isCurrentJob() && this.mode === 'bilingual') {
          // 块内仍有单元未完成时不渲染、也不计入未对照，等整块完成后一次性 upsert。
          if (this.isBlockComplete(completedUnit.blockId, units)) {
            addApplyResult(await this.applyBilingual(new Set([completedUnit.blockId])))
          }
        } else if (isCurrentJob() && this.mode === 'target' && typeof completedUnit.translation === 'string') {
          // 段落级译文挂在首个单元，需整块写回并清空其余单元，避免残留多份原文。
          const blockUnitIds = this.blockUnitIds.get(completedUnit.blockId)
          if (blockUnitIds && this.isBlockComplete(completedUnit.blockId, units)) {
            addApplyResult(await this.applyUnits('target', new Set(blockUnitIds)))
          }
        }
      })
      await applyQueue
    })
    this.activeStream = stream
    stream.enqueue(this.extractedUnits.filter((unit) => !initialHitIds.has(unit.id)))
    this.startIncrementalWindow(stream, revision, async (newUnits) => {
      if (!isCurrentJob()) return
      const currentContext = this.createCacheContext(scope, sourceLang, targetLang)
      const hits = this.selectCompleteCacheHits(this.pageCache.match(currentContext, newUnits), newUnits)
      await applyCacheHits(hits)
      const hitIds = new Set(hits.map((unit) => unit.id))
      stream.enqueue(newUnits.filter((unit) => !hitIds.has(unit.id)))
    }, async (newImages) => {
      if (!isCurrentJob()) return
      const currentContext = this.createCacheContext(scope, sourceLang, targetLang)
      const hits = this.pageCache.matchImages(currentContext, newImages)
      const hitById = new Map(hits.map((candidate) => [candidate.imageId, candidate]))
      const pending: WebImageCandidate[] = []
      for (const candidate of newImages) {
        const hit = hitById.get(candidate.imageId)
        if (hit) {
          processedImageIds.add(hit.imageId)
          imageCandidatesResult.push(hit)
        } else {
          pending.push(candidate)
        }
      }
      await enqueueImageBatch(pending)
    })
    const result = await stream.result
    await applyQueue
    await imagePromise
    await imageProcessChain
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
        if (!imageCancelled) this.pageCache.putImages(finalContext, imageCandidatesResult)
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
      images: currentImageSummary(),
      progress: {
        ...result.progress,
        readerId: this.readerId,
        sourceLang,
        targetLang,
        cacheHits: cachedTranslations.size,
        images: currentImageSummary()
      }
    }
  }

  /** 取消当前任务并拒绝迟到结果。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancel(): void {
    void this.clearBilingualInjection()
    void this.clearImageOverlays()
    this.invalidateActiveJob(true)
  }

  /** 在原文和当前译文之间切换，不重新加载页面。
   * @param mode 展示模式。
   * @returns 写回统计。
   * @author zhenghq
   */
  async setMode(mode: WebTranslationMode): Promise<WebTranslationApplyPayload> {
    // D2 不变量：离开对照先清理注入；进入对照前先把文本节点还原为原文再注入。
    if (this.bilingualInjected && mode !== 'bilingual') await this.clearBilingualInjection()
    this.mode = mode
    const placement = this.options.getSettings().webTranslationImageOcrOverlay
    if (mode === 'source') {
      await this.clearImageOverlays()
      return this.applyUnits('source')
    }
    if (mode === 'target') {
      const result = await this.applyUnits('target')
      await this.applyImageOverlays(placement)
      return result
    }
    await this.applyUnits('source')
    await this.applyImageOverlays(placement)
    return this.applyBilingual()
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
    return createWebTextUnitKey(unit)
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
    onUnits: (units: ExtractedWebTextUnit[]) => void | Promise<void>,
    onImages?: (candidates: WebImageCandidate[]) => void | Promise<void>
  ): void {
    const collectorActive = this.state.translationWindowActive === true
    this.stopIncrementalTimers()
    this.incrementalGeneration += 1
    this.incrementalFinishPromise = null
    this.incrementalWindowRevision = revision
    this.incrementalUnitHandler = onUnits
    this.incrementalImageHandler = onImages ?? null
    this.activeStream = stream
    if (!collectorActive) {
      this.incrementalWindowRevision = null
      this.incrementalUnitHandler = null
      this.incrementalImageHandler = null
      this.activeStream = null
      stream.closeInput()
      void this.installPageChangeMonitoring(revision)
      return
    }

    const poll = (): void => { void this.drainIncrementalUnits(revision) }
    this.incrementalPollTimer = setInterval(poll, WEB_INCREMENTAL_DEBOUNCE_MS)
    poll()
    this.incrementalDeadlineTimer = setTimeout(() => {
      void this.finishIncrementalWindow(revision, true)
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
        void this.finishIncrementalWindow(revision, true)
        return
      }
      const newUnits: ExtractedWebTextUnit[] = []
      const snapshots = batch.snapshots ?? []
      // 增量窗口内新加载的图片同样进入 OCR 管道，重复候选由页面侧 imageId 去重。
      const newImages = batch.imageCandidates ?? []
      for (const snapshot of snapshots) {
        const extracted = extractWebTextBlocks(snapshot, batch.pageMeta)
        for (const unit of extracted.units) {
          const key = this.unitKey(unit)
          if (this.incrementalSeenUnitKeys.has(key)) continue
          this.incrementalSeenUnitKeys.add(key)
          const sequence = this.incrementalUnitSequence++
          // 同一原始 blockId 映射到页面代次内稳定的 streamBlockId，保持增量段落的对照分组。
          const streamBlockId = this.streamBlockIds.get(unit.blockId) ?? `${unit.blockId}:stream`
          this.streamBlockIds.set(unit.blockId, streamBlockId)
          newUnits.push({
            ...unit,
            id: `stream-${revision}-${sequence}`,
            blockId: streamBlockId
          })
        }
        // 把该批新单元所属块登记进 extractedBlocks，仅登记一次。
        for (const block of extracted.blocks) {
          const streamBlockId = this.streamBlockIds.get(block.id) ?? `${block.id}:stream`
          this.streamBlockIds.set(block.id, streamBlockId)
          if (this.extractedBlocks.some((existing) => existing.id === streamBlockId)) continue
          this.extractedBlocks.push({ ...block, id: streamBlockId })
        }
      }
      if (snapshots.length > 0 || newImages.length > 0) this.scheduleIncrementalQuietStop(revision)
      if (newImages.length > 0) {
        const settings = this.options.getSettings()
        if (settings.webTranslationImageOcrEnabled) {
          const filter = filterWebImageCandidates(newImages, {
            minSize: settings.webTranslationImageOcrMinSize,
            maxImages: settings.webTranslationImageOcrMaxImages
          })
          this.imageFilterSkipped += filter.skipped
          const known = new Set(this.extractedImageCandidates.map((candidate) => candidate.imageId))
          const added = filter.accepted.filter((candidate) => {
            if (known.has(candidate.imageId)) return false
            known.add(candidate.imageId)
            return true
          })
          if (added.length > 0) {
            this.extractedImageCandidates.push(...added)
            await this.incrementalImageHandler?.(added.map((candidate) => ({ ...candidate })))
          }
        } else {
          this.imageFilterSkipped += newImages.length
        }
      }
      if (newUnits.length === 0) return
      this.extractedUnits.push(...newUnits)
      this.blockUnitIds = this.createBlockUnitIds(this.extractedUnits)
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
      this.incrementalQuietTimer = null
      void this.drainIncrementalUnits(revision)
        .catch(() => undefined)
        .then(() => {
          if (this.incrementalWindowRevision !== revision || this.pageRevision !== revision) return
          // 排空期间若又发现页面变化，drain 会重新安排静默期，此时不能提前关闭输入窗口。
          if (this.incrementalQuietTimer) return
          void this.finishIncrementalWindow(revision)
        })
    }, WEB_INCREMENTAL_STOP_QUIET_MS)
  }

  /**
   * 结束增量收集器并关闭翻译流输入，之后只保留页面变化提示。
   * @param revision 当前页面代次。
   * @param force 是否忽略静默期续期并立即结束，最长窗口到期时使用。
   * @returns 停止操作完成后的 Promise。
   * @author zhenghq
   */
  private async finishIncrementalWindow(revision: number, force = false): Promise<void> {
    if (this.incrementalWindowRevision !== revision) return
    if (this.incrementalFinishPromise) return this.incrementalFinishPromise
    const generation = this.incrementalGeneration
    const finish = (async () => {
      await this.drainIncrementalUnits(revision)
      if (generation !== this.incrementalGeneration || this.incrementalWindowRevision !== revision) return
      // 最终排空期间发现了新内容时，保留轮询与最长窗口计时，等待新的静默期结束。
      if (!force && this.incrementalQuietTimer) return
      this.stopIncrementalTimers()
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
   * 判断指定块内的全部文本单元是否都已取得成功译文。
   * @param blockId 目标块标识。
   * @param units 当前页面的全部文本单元结果。
   * @returns 块内全部单元均已完成时返回 true。
   * @author zhenghq
   */
  private isBlockComplete(blockId: string, units: readonly WebTranslationUnitResult[]): boolean {
    const unitIds = this.blockUnitIds.get(blockId)
    if (!unitIds || unitIds.length === 0) return false
    const byId = new Map(units.map((unit) => [unit.id, unit]))
    return unitIds.every((unitId) => typeof byId.get(unitId)?.translation === 'string')
  }

  /**
   * 建立块到单元标识的映射，供对照模式按块聚合使用。
   * @param units 当前页面的全部文本单元。
   * @returns 块标识到单元标识列表的映射。
   * @author zhenghq
   */
  private createBlockUnitIds(units: readonly ExtractedWebTextUnit[]): Map<string, string[]> {
    const mapping = new Map<string, string[]>()
    for (const unit of units) {
      const list = mapping.get(unit.blockId)
      if (list) list.push(unit.id)
      else mapping.set(unit.blockId, [unit.id])
    }
    return mapping
  }

  /**
   * 仅保留整段文本单元全部命中的缓存结果，避免段落级翻译拼接部分缓存译文。
   * @param hits 当前批次命中的缓存单元。
   * @param units 当前批次参与匹配的文本单元。
   * @returns 可以安全复用的完整段落缓存单元。
   * @author zhenghq
   */
  private selectCompleteCacheHits(
    hits: Array<ExtractedWebTextUnit & { translation: string }>,
    units: readonly ExtractedWebTextUnit[]
  ): Array<ExtractedWebTextUnit & { translation: string }> {
    if (hits.length === 0) return hits
    const hitIds = new Set(hits.map((unit) => unit.id))
    const unitsByBlock = new Map<string, ExtractedWebTextUnit[]>()
    for (const unit of units) {
      const list = unitsByBlock.get(unit.blockId)
      if (list) list.push(unit)
      else unitsByBlock.set(unit.blockId, [unit])
    }
    const completeBlocks = new Set<string>()
    for (const [blockId, blockUnits] of unitsByBlock) {
      if (blockUnits.every((unit) => hitIds.has(unit.id))) completeBlocks.add(blockId)
    }
    return hits.filter((hit) => completeBlocks.has(hit.blockId))
  }

  /**
   * 按块聚合构建并执行对照译文注入，返回注入与未对照统计。
   * @returns 对照注入统计。
   * @author zhenghq
   */
  private async applyBilingual(onlyBlockIds?: ReadonlySet<string>): Promise<WebTranslationApplyPayload> {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) {
      return { applied: 0, mismatched: 0, skipped: 0, bilingualSkipped: 0, unrendered: 0 }
    }
    const translations = new Map<string, string>()
    for (const unit of this.translatedUnits) {
      if (typeof unit.translation === 'string') translations.set(unit.id, unit.translation)
    }
    const blocks = onlyBlockIds
      ? this.extractedBlocks.filter((block) => onlyBlockIds.has(block.id))
      : this.extractedBlocks
    const built = buildWebBilingualOperations({
      blocks,
      units: onlyBlockIds ? this.extractedUnits.filter((unit) => onlyBlockIds.has(unit.blockId)) : this.extractedUnits,
      translations
    })
    const configured = this.bilingualTargetLang || this.options.getSettings().targetLang?.trim() || ''
    const targetLang = configured && configured.toLowerCase() !== 'auto' ? configured : 'ZH'
    try {
      await this.ensureBilingualStyles(view)
      const result = await view.webContents.executeJavaScript(
        buildWebBilingualInjectScript(built.operations, targetLang),
        true
      ) as { applied: number; mismatched: number; skipped: number }
      this.bilingualInjected = true
      if (result.mismatched > 0) this.markPageUpdated()
      return {
        applied: result.applied,
        mismatched: result.mismatched,
        skipped: result.skipped,
        bilingualSkipped: built.skipped,
        unrendered: built.unrendered
      }
    } catch (error) {
      if (isDisposedWebFrameError(error)) {
        return { applied: 0, mismatched: 0, skipped: built.operations.length, bilingualSkipped: built.skipped, unrendered: built.unrendered }
      }
      throw error
    }
  }

  /**
   * 注入对照样式表并记录 key，重复调用不重复注入。
   * @param view 远程网页视图。
   * @returns 注入完成后的 Promise。
   * @author zhenghq
   */
  private async ensureBilingualStyles(view: WebContentsView): Promise<void> {
    if (this.bilingualCssKey) return
    this.bilingualCssKey = await view.webContents.insertCSS(buildWebBilingualStyleSheet())
  }

  /**
   * 清除对照注入节点与样式，远程 Frame 已销毁时安全跳过。
   * @returns 清理完成后的 Promise。
   * @author zhenghq
   */
  private async clearBilingualInjection(): Promise<void> {
    const view = this.view
    const cssKey = this.bilingualCssKey
    this.bilingualInjected = false
    this.bilingualCssKey = null
    if (!view || view.webContents.isDestroyed()) return
    if (cssKey) {
      try {
        await view.webContents.removeInsertedCSS(cssKey)
      } catch (error) {
        if (!isDisposedWebFrameError(error)) throw error
      }
    }
    try {
      await view.webContents.executeJavaScript(buildWebBilingualClearScript(), true)
    } catch (error) {
      if (!isDisposedWebFrameError(error)) throw error
    }
  }

  /**
   * 注入或更新图片译文覆盖层，按当前展示模式与位置设置决定渲染方式。
   * @param placement 用户配置的图片译文展示位置。
   * @returns 注入完成后的 Promise。
   * @author zhenghq
   */
  private async applyImageOverlays(placement: WebImageOverlayPlacement): Promise<void> {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return
    const operations: WebImageOverlayOperation[] = []
    for (const candidate of this.translatedImageCandidates) {
      const decision = resolveWebImageRenderDecision(candidate, this.mode, placement)
      if (decision === 'none' || !candidate.ocrText || !candidate.translation) continue
      operations.push({
        imageId: candidate.imageId,
        selector: candidate.selector,
        ...(candidate.shadowPath !== undefined ? { shadowPath: [...candidate.shadowPath] } : {}),
        ocrText: candidate.ocrText,
        translation: candidate.translation,
        placement: decision === 'overlay' ? 'overlay' : 'below',
        bilingual: decision === 'bilingual',
        lang: this.bilingualTargetLang || undefined
      })
    }
    if (operations.length === 0) {
      await this.clearImageOverlays()
      return
    }
    try {
      await this.ensureImageOverlayStyles(view)
      const result = await view.webContents.executeJavaScript(
        buildWebImageOverlayInjectScript(operations),
        true
      ) as { applied: number; mismatched: number; skipped: number }
      this.imageOverlayInjected = result.applied > 0
      if (result.mismatched > 0) this.markPageUpdated()
    } catch (error) {
      if (!isDisposedWebFrameError(error)) throw error
    }
  }

  /**
   * 注入图片译文样式表并记录 key，重复调用不重复注入。
   * @param view 远程网页视图。
   * @returns 注入完成后的 Promise。
   * @author zhenghq
   */
  private async ensureImageOverlayStyles(view: WebContentsView): Promise<void> {
    if (this.imageOverlayCssKey) return
    this.imageOverlayCssKey = await view.webContents.insertCSS(buildWebImageOverlayStyleSheet())
  }

  /**
   * 清除图片译文覆盖层与样式，远程 Frame 已销毁时安全跳过。
   * @returns 清理完成后的 Promise。
   * @author zhenghq
   */
  private async clearImageOverlays(): Promise<void> {
    const view = this.view
    const cssKey = this.imageOverlayCssKey
    this.imageOverlayInjected = false
    this.imageOverlayCssKey = null
    if (!view || view.webContents.isDestroyed()) return
    if (cssKey) {
      try {
        await view.webContents.removeInsertedCSS(cssKey)
      } catch (error) {
        if (!isDisposedWebFrameError(error)) throw error
      }
    }
    try {
      await view.webContents.executeJavaScript(buildWebImageOverlayClearScript(), true)
    } catch (error) {
      if (!isDisposedWebFrameError(error)) throw error
    }
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
    await this.clearImageOverlays()
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
      frame: false,
      resizable: true,
      maximizable: true,
      fullscreenable: false,
      backgroundColor: '#f5f7fa',
      webPreferences: { preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    const view = new WebContentsView({
      webPreferences: { session: this.getSession(), contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    window.contentView.addChildView(view)
    this.window = window
    this.view = view
    this.options.onWindowStateChanged?.(true)
    this.bindRemoteEvents(view)
    this.allowWindowClose = false
    this.closingWindow = false
    window.on('close', (event) => {
      if (this.allowWindowClose) return
      // 标题栏、快捷键或系统关闭都必须先交还前台，避免设置页被提升到最前。
      event.preventDefault()
      this.close()
    })
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
    // 导航会替换文档，先清掉旧页面的注入节点与样式，避免样式 key 悬挂。
    void this.clearBilingualInjection()
    void this.clearImageOverlays()
    this.invalidateActiveJob(true)
    this.stopPageChangePolling()
    this.pageRevision += 1
    this.extractedUnits = []
    this.extractedBlocks = []
    this.blockUnitIds.clear()
    this.extractedImageCandidates = []
    this.imageFilterSkipped = 0
    this.translatedUnits = []
    this.translatedImageCandidates = []
    this.streamBlockIds.clear()
    this.bilingualInjected = false
    this.bilingualCssKey = null
    this.imageOverlayInjected = false
    this.imageOverlayCssKey = null
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
      translationCacheHits: 0,
      imageCandidates: 0,
      imageProcessed: 0,
      imageSkipped: 0,
      imageFailed: 0
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
    this.sendToRenderer('web-translate:page-updated', true)
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
    this.sendToRenderer('web-reader:state', this.getState())
  }

  /**
   * 广播网页翻译进度。
   * @param progress 最新网页翻译进度。
   * @returns 无返回值。
   * @author zhenghq
   */
  private emitProgress(progress: WebTranslationProgressPayload): void {
    this.sendToRenderer('web-translate:progress', progress)
  }

  /**
   * 向网页阅读器壳窗口发送消息，并安全处理窗口关闭期间的生命周期竞争。
   * @param channel IPC 通道名称。
   * @param payload 要发送的消息载荷。
   * @returns 无返回值。
   * @author zhenghq
   */
  private sendToRenderer(channel: string, payload: unknown): void {
    const window = this.window
    if (!window) return
    try {
      if (window.isDestroyed()) return
      sendToAliveWebContents(window.webContents, channel, payload)
    } catch (error) {
      if (!isDisposedWebFrameError(error)) throw error
    }
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
    // BrowserWindow 的 closed 事件触发时其 WebContents 已进入销毁流程，先断开引用，
    // 避免取消增量任务时 emitState 继续向已销毁的壳窗口发送消息。
    this.window = null
    this.closingWindow = false
    this.allowWindowClose = false
    this.options.onWindowStateChanged?.(false)
    void this.clearBilingualInjection()
    void this.clearImageOverlays()
    this.invalidateActiveJob(true)
    this.stopPageChangePolling()
    if (!view.webContents.isDestroyed()) view.webContents.close()
    this.view = null
    this.extractedUnits = []
    this.extractedBlocks = []
    this.blockUnitIds.clear()
    this.extractedImageCandidates = []
    this.imageFilterSkipped = 0
    this.translatedUnits = []
    this.translatedImageCandidates = []
    this.streamBlockIds.clear()
    this.bilingualInjected = false
    this.bilingualCssKey = null
    this.imageOverlayInjected = false
    this.imageOverlayCssKey = null
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
