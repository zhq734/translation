import {
  DOCUMENT_MAX_FILE_BYTES,
  DOCUMENT_ZIP_TAIL_BYTES,
  getDocumentZipCentralDirectoryRange,
  validateDocumentFile,
  type DocumentFileValidationResult
} from '../../shared/documentFormat'
import type {
  DocumentBlock,
  DocumentContentArea,
  DocumentImageBlock,
  DocumentModel,
  DocumentOcrRegion,
  DocumentPage,
  DocumentTableBlock,
  DocumentTextBlock,
  DocumentTextRun,
  DocumentTextStyle,
  DocumentWarning
} from '../../shared/documentTypes'
import {
  resolveOcrRegionFontSize,
  resolveOcrRegionGapBefore,
  resolveOcrRegionLineHeight,
  resolveOcrRegionPadding
} from '../../shared/documentOcrLayout'
import type {
  DocumentAssetResult,
  DocumentExportResult,
  DocumentFileSelectionResult,
  DocumentPlatformCapability,
  DocumentRunResult,
  DocumentWorkspaceSnapshot
} from '../../shared/types'
import type { Settings } from '../../shared/types'
import { LANGUAGES, langLabel } from '../../shared/langs'
import { TRANSLATION_WATERMARK_LOGO_PATH } from '../../shared/translationWatermark'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.js?url'
import { startThemeRuntime } from './theme'
import { startLocaleRuntime } from './locale'
import {
  occupiesDocumentTranslationFlow,
  resolveTranslationFlowDecorationTop,
  type DocumentFlowDecorationAnchor,
  resolveTranslationFlowGroupGeometry,
  resolveTranslationWatermarkHorizontalOffset
} from './documentPdfLayout'

startThemeRuntime(window.api)
const localeRuntime = startLocaleRuntime(window.api)
pdfjsModule.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

/** 任务代际在 Renderer 重载后继续递增，避免主进程拒绝复用旧值。 */
const DOCUMENT_GENERATION_STORAGE_KEY = 'selection-translator.document-generation'

/** 文档双栏的渲染侧；OCR 文本层只允许出现在译文侧。 */
type DocumentRenderSide = 'source' | 'translation'

/** 文档预览按格式采用的渲染方式；HTML 原文使用独立 webview，译文仍采用流式布局。 */
type DocumentPreviewKind = 'paged' | 'markdown' | 'table' | 'subtitle' | 'flow' | 'html-source'

/** 文档工作台当前上传状态。 */
interface DocumentSelectionState {
  /** 已通过校验的本地文件绝对路径；未选择时为 null。 */
  path: string | null
  /** 用于界面展示的文件名。 */
  name: string
  /** 文件字节数。 */
  size: number
  /** 已识别格式；未选择时为空。 */
  format: string
  /** 当前应展示的错误分类；无错误时为 null。 */
  error: string | null
}

/** 初始空选择状态。 */
const EMPTY_SELECTION: DocumentSelectionState = {
  path: null,
  name: '',
  size: 0,
  format: '',
  error: null
}

const dropZone = document.getElementById('document-drop-zone') as HTMLElement
const documentFileInput = document.getElementById('document-file-input') as HTMLInputElement
const fileSummary = document.getElementById('document-file-summary') as HTMLElement
const fileName = document.getElementById('document-file-name') as HTMLElement
const fileDetail = document.getElementById('document-file-detail') as HTMLElement
const fileReplaceButton = document.getElementById('document-file-replace') as HTMLButtonElement
const uploadStatus = document.getElementById('document-upload-status') as HTMLElement
const startButton = document.getElementById('document-start-button') as HTMLButtonElement
const historyButton = document.getElementById('document-history-button') as HTMLButtonElement
const sourceLanguageSelect = document.getElementById('document-source-lang') as HTMLSelectElement
const targetLanguageSelect = document.getElementById('document-target-lang') as HTMLSelectElement
const uploadPanel = document.getElementById('document-upload-panel') as HTMLElement
const workbench = document.getElementById('document-workbench') as HTMLElement
const workbenchName = document.getElementById('document-workbench-name') as HTMLElement
const workbenchMeta = document.getElementById('document-workbench-meta') as HTMLElement
const progressStage = document.getElementById('document-progress-stage') as HTMLElement
const progressCount = document.getElementById('document-progress-count') as HTMLElement
const progressbar = document.getElementById('document-progressbar') as HTMLElement
const sourceContent = document.getElementById('document-source-content') as HTMLElement
const translationContent = document.getElementById('document-translation-content') as HTMLElement
const sourcePageCount = document.getElementById('document-source-page-count') as HTMLElement
const translationPageCount = document.getElementById('document-translation-page-count') as HTMLElement
const cancelButton = document.getElementById('document-cancel-button') as HTMLButtonElement
const exportButton = document.getElementById('document-export-button') as HTMLButtonElement
const retryButton = document.getElementById('document-retry-button') as HTMLButtonElement
const documentWorkbenchReplaceButton = document.getElementById('document-workbench-replace') as HTMLButtonElement
const partialStatus = document.getElementById('document-partial-status') as HTMLElement
const titlebar = document.getElementById('document-titlebar') as HTMLElement
const windowMinimizeButton = document.getElementById('window-minimize') as HTMLButtonElement
const windowMaximizeButton = document.getElementById('window-maximize') as HTMLButtonElement
const windowCloseButton = document.getElementById('window-close') as HTMLButtonElement

let selectionState: DocumentSelectionState = { ...EMPTY_SELECTION }
let platformCapability: DocumentPlatformCapability | null = null
let dragDepth = 0
/** 当前 Renderer 任务代际；每次开始翻译递增。 */
let generation = readPersistedGeneration()
/** 当前主进程任务标识；未启动时为 null。 */
let activeJobId: string | null = null
/** 当前代际下已确认的主进程任务标识；首条进度事件到达前为 null。 */
let expectedJobId: string | null = null
/** 最近一次收到且属于当前任务的进度快照。 */
let latestSnapshot: DocumentWorkspaceSnapshot | null = null
/** 等待下一帧合并执行的渲染回调。 */
let pendingRenderFrame: number | null = null
/** 当前文档图片 Blob URL，重绘或关闭时统一释放。 */
const assetUrls = new Map<string, string>()
/** 左右栏滚动同步的递归保护标记。 */
let syncingScroll = false
/** 文件预检读取的头部字节数。 */
const DOCUMENT_HEAD_BYTES = 8192
/** 已渲染的源预览身份；PDF 只按文件指纹复用，避免流式事件重载 Canvas。 */
let renderedSourcePreviewIdentity = ''
/** 已渲染的源告警签名；告警变化时只更新告警层。 */
let renderedSourceWarningSignature = ''
/** 已渲染的译文内容签名。 */
let renderedTranslationSignature = ''
/** 当前译文预览的渲染方式；结构变化时才允许回退整页重绘。 */
let renderedTranslationPreviewKind: DocumentPreviewKind | null = null
/** 是否已完成过译文栏首次渲染；空模型与空签名不能省略初始等待态。 */
let hasRenderedTranslation = false
/** 已渲染的译文告警签名；告警变化时只更新告警层。 */
let renderedTranslationWarningSignature = ''
/** 每个 PDF 预览容器当前有效的异步渲染令牌，避免旧渲染覆盖新文件。 */
const pdfRenderTokens = new WeakMap<HTMLElement, symbol>()
/** 每个 PDF 预览容器的资源清理函数；切换文件或重绘时取消观察与未完成绘制。 */
const pdfPreviewCleanups = new WeakMap<HTMLElement, () => void>()
/** 当前译文 PDF 页面的缩放观察器；重绘前统一断开，避免旧页面泄漏。 */
let pageScaleObserver: ResizeObserver | null = null
/** 当前待执行的译文页面重排帧；同一帧内合并缩放、字体与图片尺寸变化。 */
let pageLayoutFrame: number | null = null
/** 当前译文页面重排调度器；图片异步加载完成后复用同一帧合并逻辑。 */
let activePageLayoutScheduler: (() => void) | null = null
/** 当前译文水印的尺寸观察器；容器宽度变化时重新计算图案横向起点。 */
let watermarkResizeObserver: ResizeObserver | null = null
/** 最近一次读取到的完整设置，供界面语言变化时重建语言下拉。 */
let currentSettings: Settings | null = null
/** 最近一次已提交的语言组合，用于忽略程序化回填触发的 change 事件。 */
let appliedLanguagePair = ''
/** 当前是否正在等待 runDocument 返回任务标识。 */
let documentStartInFlight = false
/** 启动请求进行中收到语言变化时，待启动完成后再执行一次最新语言的重译。 */
let pendingLanguageRetranslation = false
/** 语言切换序号，用于丢弃取消旧任务期间已经过期的重译请求。 */
let languageChangeRevision = 0

/**
 * 使用当前界面语言翻译词条。
 * @param key 语义化词条 key。
 * @param params 可选插值参数。
 * @returns 当前语言下的词条文本。
 * @author zhenghq
 */
function t(key: string, params?: Record<string, string | number>): string {
  return localeRuntime.translator.t(key, params)
}

/**
 * 从 sessionStorage 恢复上次任务代际；存储不可用时从零开始。
 * @returns 可继续递增的非负整数。
 * @author zhenghq
 */
function readPersistedGeneration(): number {
  try {
    const value = Number(sessionStorage.getItem(DOCUMENT_GENERATION_STORAGE_KEY))
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

/**
 * 生成并持久化下一次任务代际，确保 Renderer 重载后仍严格递增。
 * @returns 新的任务代际。
 * @author zhenghq
 */
function nextGeneration(): number {
  generation += 1
  try {
    sessionStorage.setItem(DOCUMENT_GENERATION_STORAGE_KEY, String(generation))
  } catch {
    // 存储不可用时仍使用内存代际，当前窗口内的事件隔离不受影响。
  }
  return generation
}

/**
 * 采用主进程建议的代际，并同步到当前 Renderer 的内存与会话存储。
 * 仅当建议值严格大于本地值时生效，避免异常响应让代际回退。
 * @param suggestedGeneration 主进程返回的下一可用代际。
 * @returns 是否成功采用。
 * @author zhenghq
 */
function adoptSuggestedGeneration(suggestedGeneration: number | undefined): boolean {
  if (!Number.isSafeInteger(suggestedGeneration) || (suggestedGeneration ?? 0) <= generation) {
    return false
  }
  generation = suggestedGeneration as number
  try {
    sessionStorage.setItem(DOCUMENT_GENERATION_STORAGE_KEY, String(generation))
  } catch {
    // 存储不可用时仍可在当前页面内完成本次重试。
  }
  return true
}

/**
 * 将解析告警按稳定 code 转为当前界面语言；未知 code 使用解析器兜底说明。
 * @param warning 文档告警。
 * @returns 当前语言下的告警说明。
 * @author zhenghq
 */
function localizeDocumentWarning(warning: DocumentWarning): string {
  const key = `document.warning.${warning.code}`
  return localeRuntime.translator.has(key)
    ? t(key)
    : warning.message || t('document.warning.unknown')
}

/**
 * 把文件字节数格式化为便于阅读的大小。
 * @param bytes 文件字节数。
 * @returns 带单位的大小文本。
 * @author zhenghq
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 填充文档翻译顶部栏的源语言和目标语言选项。
 * @param settings 当前应用设置。
 * @param sourceValue 可选源语言回填值；省略时读取设置默认值。
 * @param targetValue 可选目标语言回填值；省略时读取设置默认值。
 * @returns 无返回值。
 * @author zhenghq
 */
function populateDocumentLanguages(
  settings: Settings,
  sourceValue?: string,
  targetValue?: string
): void {
  const selectedSource = sourceValue?.trim() || sourceLanguageSelect.value || settings.sourceLang || 'auto'
  const selectedTarget = targetValue?.trim() || targetLanguageSelect.value || settings.targetLang || 'auto'
  sourceLanguageSelect.replaceChildren()
  targetLanguageSelect.replaceChildren()
  sourceLanguageSelect.add(new Option(t('popup.autoDetect'), 'auto'))
  targetLanguageSelect.add(new Option(t('popup.autoBilingual'), 'auto'))
  for (const language of LANGUAGES) {
    const label = langLabel(language.code, localeRuntime.locale)
    sourceLanguageSelect.add(new Option(label, language.code))
    targetLanguageSelect.add(new Option(label, language.code))
  }
  sourceLanguageSelect.value = selectedSource || 'auto'
  if (!sourceLanguageSelect.value) sourceLanguageSelect.value = 'auto'
  targetLanguageSelect.value = selectedTarget || 'auto'
  if (!targetLanguageSelect.value) targetLanguageSelect.value = 'auto'
  appliedLanguagePair = `${sourceLanguageSelect.value}\u0000${targetLanguageSelect.value}`
}

/**
 * 读取设置并初始化文档翻译语言下拉。
 * @returns 初始化完成后的 Promise。
 * @author zhenghq
 */
async function initializeDocumentLanguages(): Promise<void> {
  try {
    currentSettings = await window.api.getSettings()
    populateDocumentLanguages(currentSettings)
  } catch {
    // 设置读取失败时仍提供自动检测与自动中英互译，保证文档翻译可启动。
    currentSettings = null
    populateDocumentLanguages({ sourceLang: 'auto', targetLang: 'auto' } as Settings)
  }
}

/**
 * 在语言切换后取消旧任务，并使用新语言重新翻译当前文档。
 * 上传态只记录选择；工作台已有任务时立即重译。
 * @returns 无返回值。
 * @author zhenghq
 */
async function retranslateDocumentAfterLanguageChange(): Promise<void> {
  if (workbench.hidden || !selectionState.path) return
  if (documentStartInFlight) {
    pendingLanguageRetranslation = true
    return
  }
  const nextPair = `${sourceLanguageSelect.value}\u0000${targetLanguageSelect.value}`
  if (nextPair === appliedLanguagePair) return
  appliedLanguagePair = nextPair
  const revision = ++languageChangeRevision
  const jobId = activeJobId
  if (jobId) {
    try {
      await window.api.cancelDocument(jobId, generation)
    } catch {
      // 任务可能已经结束，继续以新代际重译并隔离旧任务迟到事件。
    }
  }
  if (revision !== languageChangeRevision) return
  await startDocumentTranslation()
}

/**
 * 将校验拒绝码转换为可本地化的用户提示。
 * @param code 稳定拒绝分类。
 * @returns 当前语言下的提示文本。
 * @author zhenghq
 */
function validationMessage(code: string): string {
  const keys: Record<string, string> = {
    'unsupported-format': 'document.error.invalidFile',
    'invalid-header': 'document.error.invalidFile',
    'empty-file': 'document.error.invalidFile',
    'too-large': 'document.error.tooLarge',
    unreadable: 'document.error.unreadable'
  }
  return t(keys[code] ?? 'document.error.invalidFile', {
    maxSize: formatFileSize(DOCUMENT_MAX_FILE_BYTES)
  })
}

/**
 * 根据当前选择状态刷新上传卡片、开始按钮与状态提示。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderSelectionState(): void {
  const hasFile = Boolean(selectionState.path)
  fileSummary.hidden = !hasFile
  startButton.disabled = !hasFile || !platformCapability?.supported
  if (hasFile) {
    fileName.textContent = selectionState.name
    fileDetail.textContent = `${selectionState.format.toUpperCase()} · ${formatFileSize(selectionState.size)}`
  }
  uploadStatus.textContent = selectionState.error ? validationMessage(selectionState.error) : ''
  uploadStatus.dataset.state = selectionState.error ? 'error' : 'normal'
  dropZone.setAttribute('aria-invalid', String(Boolean(selectionState.error)))
  if (!platformCapability?.supported && platformCapability) {
    uploadStatus.textContent = platformCapability.reason === 'windows-7-unsupported'
      ? t('document.error.windows7Unsupported')
      : t('document.error.unsupportedPlatform')
    uploadStatus.dataset.state = 'error'
  }
}

/**
 * 应用文件预检结果；失败时不保留任何任务或文件选择状态。
 * @param result 统一格式校验结果。
 * @param candidate 文件名称、大小与可读取路径。
 * @returns 是否通过校验。
 * @author zhenghq
 */
function applyValidationResult(
  result: DocumentFileValidationResult,
  candidate: { path: string; name: string; size: number }
): boolean {
  if (!result.ok) {
    selectionState = { ...EMPTY_SELECTION, error: result.code }
    renderSelectionState()
    return false
  }
  selectionState = {
    path: candidate.path,
    name: candidate.name,
    size: candidate.size,
    format: result.format,
    error: null
  }
  renderSelectionState()
  return true
}

/**
 * 读取浏览器 File 对象有限头尾片段和 ZIP 中央目录并执行本地预检。
 * @param file 用户拖放或选择的文件。
 * @returns 无返回值。
 * @author zhenghq
 */
async function inspectBrowserFile(file: File): Promise<void> {
  try {
    const head = new Uint8Array(await file.slice(0, DOCUMENT_HEAD_BYTES).arrayBuffer())
    const tailStart = Math.max(0, file.size - DOCUMENT_ZIP_TAIL_BYTES)
    const tail = new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer())
    const zipRange = getDocumentZipCentralDirectoryRange(tail, file.size)
    const zipDirectory = zipRange
      ? new Uint8Array(await file.slice(zipRange.start, zipRange.end).arrayBuffer())
      : undefined
    const path = window.api.getDocumentDroppedFilePath(file)
    if (!path) {
      selectionState = { ...EMPTY_SELECTION, error: 'unreadable' }
      renderSelectionState()
      return
    }
    const validation = validateDocumentFile({
      fileName: file.name,
      size: file.size,
      head,
      tail,
      ...(zipDirectory ? { zipDirectory } : {})
    })
    if (!applyValidationResult(validation, { path, name: file.name, size: file.size })) return
    // Renderer 预检只用于即时反馈，真正可运行资格仍由主进程重新读取文件头并登记。
    const approved = await window.api.approveDocumentFile(path)
    applyFileSelection(approved)
  } catch {
    selectionState = { ...EMPTY_SELECTION, error: 'unreadable' }
    renderSelectionState()
  }
}

/**
 * 应用主进程文件选择结果，确保拒绝结果不创建任务。
 * @param result 文件选择、取消或拒绝结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyFileSelection(result: DocumentFileSelectionResult): void {
  if (result.status === 'cancelled') return
  if (result.status === 'rejected') {
    selectionState = { ...EMPTY_SELECTION, error: result.code }
    renderSelectionState()
    return
  }
  selectionState = {
    path: result.path,
    name: result.fileName,
    size: result.size,
    format: result.format,
    error: null
  }
  renderSelectionState()
}

/**
 * 通过主进程受信任文件选择器选择文档。
 * @returns 无返回值。
 * @author zhenghq
 */
async function chooseDocumentFile(): Promise<void> {
  if (!platformCapability?.supported) {
    renderSelectionState()
    return
  }
  try {
    applyFileSelection(await window.api.selectDocumentFile())
  } catch {
    selectionState = { ...EMPTY_SELECTION, error: 'unreadable' }
    renderSelectionState()
  }
}

/**
 * 清空当前工作台预览及任务快照，供更换文件后回到上传态。
 * @returns 无返回值。
 * @author zhenghq
 */
function resetWorkbenchPreview(): void {
  if (pendingRenderFrame !== null) {
    cancelAnimationFrame(pendingRenderFrame)
    pendingRenderFrame = null
  }
  latestSnapshot = null
  watermarkResizeObserver?.disconnect()
  watermarkResizeObserver = null
  activeJobId = null
  expectedJobId = null
  renderedSourcePreviewIdentity = ''
  renderedSourceWarningSignature = ''
  renderedTranslationSignature = ''
  renderedTranslationPreviewKind = null
  hasRenderedTranslation = false
  renderedTranslationWarningSignature = ''
  revokeAssetUrls()
  pdfPreviewCleanups.get(sourceContent)?.()
  pdfPreviewCleanups.get(translationContent)?.()
  sourceContent.replaceChildren()
  translationContent.replaceChildren()
  sourceContent.dataset.previewKind = ''
  translationContent.dataset.previewKind = ''
  sourcePageCount.textContent = ''
  translationPageCount.textContent = ''
  progressStage.textContent = t('document.progress.ready')
  progressCount.textContent = ''
  progressbar.setAttribute('aria-valuenow', '0')
  progressbar.style.width = '0%'
  partialStatus.hidden = true
  cancelButton.hidden = true
  exportButton.disabled = true
  retryButton.disabled = true
  workbench.dataset.state = 'idle'
}

/**
 * 从工作台更换文件；取消文件选择时保留当前预览，选择成功后返回上传确认态。
 * @returns 无返回值。
 * @author zhenghq
 */
async function replaceDocumentFromWorkbench(): Promise<void> {
  if (!platformCapability?.supported) return
  documentWorkbenchReplaceButton.disabled = true
  try {
    const jobId = activeJobId
    const jobGeneration = generation
    if (jobId) {
      try {
        await window.api.cancelDocument(jobId, jobGeneration)
      } catch {
        // 任务可能已结束；文件选择仍可继续，迟到事件由新代际隔离。
      }
    }
    // 无论旧任务是否取消成功，都递增代际以丢弃后续进度与完成事件。
    nextGeneration()
    activeJobId = null
    expectedJobId = null
    const result = await window.api.selectDocumentFile()
    if (result.status === 'cancelled') {
      startButton.disabled = !selectionState.path || !platformCapability.supported
      return
    }
    applyFileSelection(result)
    resetWorkbenchPreview()
    workbench.hidden = true
    uploadPanel.hidden = false
  } catch {
    uploadStatus.textContent = t('document.error.unreadable')
    uploadStatus.dataset.state = 'error'
  } finally {
    documentWorkbenchReplaceButton.disabled = false
  }
}

/**
 * 释放当前所有文档图片 Blob URL，避免切换文件或重绘后泄漏内存。
 * @returns 无返回值。
 * @author zhenghq
 */
function revokeAssetUrls(): void {
  for (const url of assetUrls.values()) URL.revokeObjectURL(url)
  assetUrls.clear()
}

/**
 * 读取图片资源并缓存 Blob URL；同一资源在单次任务内只读取一次。
 * @param assetId 受控资源标识。
 * @returns 可用于 img.src 的 Blob URL；资源不可用时返回 null。
 * @author zhenghq
 */
async function resolveAssetUrl(assetId: string): Promise<string | null> {
  const cached = assetUrls.get(assetId)
  if (cached) return cached
  try {
    const asset: DocumentAssetResult = await window.api.getDocumentAsset(assetId)
    if (!asset.ok || !asset.bytes) return null
    const bytes = new Uint8Array(asset.bytes)
    const url = URL.createObjectURL(new Blob([bytes], {
      type: asset.mimeType ?? 'application/octet-stream'
    }))
    assetUrls.set(assetId, url)
    return url
  } catch {
    return null
  }
}

/**
 * 将文档样式转换为 CSS 属性；只接受模型中的受控样式字段。
 * @param style 文档样式。
 * @returns 可应用到 HTMLElement 的样式映射。
 * @author zhenghq
 */
function styleProperties(style: DocumentTextStyle | undefined): Partial<CSSStyleDeclaration> {
  if (!style) return {}
  const result: Partial<CSSStyleDeclaration> = {}
  if (style.fontFamily) result.fontFamily = style.fontFamily
  if (style.fontSize !== undefined) result.fontSize = `${style.fontSize}pt`
  if (style.fontWeight !== undefined) result.fontWeight = String(style.fontWeight)
  if (style.color) result.color = style.color
  if (style.backgroundColor) result.backgroundColor = style.backgroundColor
  if (style.italic) result.fontStyle = 'italic'
  if (style.underline) result.textDecoration = 'underline'
  if (style.strikethrough) {
    result.textDecoration = result.textDecoration === 'underline'
      ? 'underline line-through'
      : 'line-through'
  }
  if (style.letterSpacing !== undefined) result.letterSpacing = `${style.letterSpacing}pt`
  if (style.lineHeight !== undefined) result.lineHeight = `${style.lineHeight}pt`
  return result
}

/**
 * 将 PDF 原文样式写入可缩放文本元素；字号保留为 CSS 自定义属性供译文页换算。
 * @param element 目标文本元素。
 * @param style 文档文本样式。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyScalableTextStyle(element: HTMLElement, style: DocumentTextStyle | undefined): void {
  if (style?.fontSize !== undefined) {
    // PDF.js 在 scale=1 时页面点与 CSS 像素一一对应；变量显式携带 px，避免 pt 与屏幕像素混算。
    element.style.setProperty('--document-run-font-size-px', `${style.fontSize}px`)
  }
  if (style?.lineHeight !== undefined) {
    element.style.setProperty('--document-run-line-height-px', `${style.lineHeight}px`)
  }
  if (style?.color) element.style.color = style.color
  if (style?.fontWeight !== undefined) element.style.fontWeight = String(style.fontWeight)
  if (style?.fontFamily) {
    element.style.setProperty('--document-run-font-family', pdfPreviewFontFamily(style.fontFamily))
  }
  if (style?.italic) element.style.fontStyle = 'italic'
  if (style?.underline) element.style.textDecoration = 'underline'
  if (style?.strikethrough) {
    element.style.textDecoration = element.style.textDecoration === 'underline'
      ? 'underline line-through'
      : 'line-through'
  }
  if (style?.letterSpacing !== undefined) element.style.letterSpacing = `${style.letterSpacing}px`
}

/**
 * 合并区块与文本片段的样式，片段样式优先。
 * PDF 解析器常把字号、颜色、字重和行高放在区块上，只读取 run 样式会导致译文回退到默认 12px。
 * @param block 文本区块。
 * @param run 文本片段。
 * @returns 用于预览渲染的最终文本样式。
 * @author zhenghq
 */
function effectiveTextStyle(block: DocumentTextBlock, run: DocumentTextRun): DocumentTextStyle {
  return { ...block.style, ...run.style }
}

/**
 * 计算文档预览栏扣除页面留白后的统一可用宽度。
 * 源文 PDF Canvas 与译文流式页面必须共用该值，避免两栏缩放比例不一致。
 * @param container 当前预览滚动容器。
 * @returns 可用于页面布局的 CSS 像素宽度。
 * @author zhenghq
 */
function documentPageAvailableWidth(container: HTMLElement): number {
  const style = getComputedStyle(container)
  const padding = Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0')
  const borderWidth = Number.parseFloat(style.getPropertyValue('--border-width')) || 0
  // Canvas 与译文内容都位于页面边框内部，必须扣除左右边框后再计算缩放比例。
  return Math.max(1, container.clientWidth - padding - borderWidth * 2)
}

/**
 * 计算 PDF 页面实际可绘制内容宽度。
 * 原文 Canvas 与译文页面统一使用该值，避免双栏因边框或滚动区留白产生比例偏差。
 * @param container 当前预览滚动容器。
 * @returns 页面边框内部的 CSS 像素宽度。
 * @author zhenghq
 */
function documentPageContentWidth(container: HTMLElement): number {
  // 内容宽度与可用宽度必须来自同一公式，避免两侧各自扣除留白后出现比例漂移。
  return documentPageAvailableWidth(container)
}

/**
 * 计算 PDF 译文文本块相对上一条已排版区块的段前距离。
 * PDF 文本层已按段落合并；同字号、同左边线的相邻段落使用原始基线推进，
 * 其余情况才使用 bbox 间距，避免行盒高度与坐标距离重复叠加。
 * @param block 当前区块；仅文本区块参与基线推进计算。
 * @param previousBlock 上一条已排版区块。
 * @param previousBottom 上一条区块的原始底边。
 * @returns 以页面点为单位的段前距离。
 * @author zhenghq
 */
function pdfFlowGapBefore(
  block: DocumentBlock,
  previousBlock: DocumentBlock | undefined,
  previousBottom: number
): number {
  if (!block.bbox) return 0
  if (block.kind !== 'text') return Math.max(0, block.bbox.y - previousBottom)
  const previousText = previousBlock?.kind === 'text' ? previousBlock : undefined
  const currentStyle = block.runs[0] ? effectiveTextStyle(block, block.runs[0]) : block.style
  const previousStyle = previousText?.runs[0]
    ? effectiveTextStyle(previousText, previousText.runs[0])
    : previousText?.style
  const currentSize = currentStyle?.fontSize ?? 0
  const previousSize = previousStyle?.fontSize ?? 0
  const currentLineHeight = currentStyle?.lineHeight
  const previousLineHeight = previousStyle?.lineHeight
  const sameLineStyle = previousText !== undefined &&
    Math.abs(currentSize - previousSize) <= Math.max(0.5, currentSize * 0.05) &&
    Math.abs((currentLineHeight ?? 0) - (previousLineHeight ?? 0)) <= 0.5 &&
    Math.abs(block.bbox.x - previousText.bbox!.x) <= Math.max(2, currentSize * 0.25)
  if (sameLineStyle && currentLineHeight !== undefined) {
    const baselineAdvance = block.bbox.y - previousText.bbox!.y
    if (baselineAdvance >= currentSize * 1.02 && baselineAdvance <= currentSize * 3) {
      return Math.max(0, baselineAdvance - currentLineHeight)
    }
  }
  return Math.max(0, block.bbox.y - previousBottom)
}

/**
 * 测量译文流式区块在页面中的真实底边，供图片纵向锚定与后续内容避让使用。
 * @param element 已挂载的译文区块。
 * @returns 区块相对视口的底边坐标；尚未布局时返回 0。
 * @author zhenghq
 */
function measureTranslationFlowBottom(element: HTMLElement): number {
  return element.getBoundingClientRect().bottom
}

/**
 * 依据真实 DOM 高度修正 PDF 译文流式排版。
 * 图片优先锚定原文纵向坐标；当前文译文变高并越过该坐标时，图片从文字实际底边继续下推，
 * 绝不能用负间距回退覆盖已排版的译文。后续文本再从图片实际底边继续排列。
 * 文本与其他区块仍按原文段前距离跟随实际底边，避免使用原始 bbox 底边造成图片被重复下推。
 * @param page 已挂载的译文页面。
 * @returns 无返回值。
 * @author zhenghq
 */
function normalizeTranslationFlowLayout(page: HTMLElement): void {
  if (!page.isConnected || page.dataset.layout !== 'translation-flow') return
  const scale = Number.parseFloat(page.style.getPropertyValue('--document-page-scale')) || 1
  const pageMarginTop = Number.parseFloat(page.style.getPropertyValue('--document-page-margin-top')) || 0
  const computed = getComputedStyle(page)
  const borderTop = Number.parseFloat(computed.borderTopWidth) || 0
  const paddingTop = Number.parseFloat(computed.paddingTop) || 0
  const pageRect = page.getBoundingClientRect()
  // 页面 padding 已承载首个区块之前的原文留白，子元素坐标从这里开始计算，避免重复叠加。
  const flowOrigin = pageRect.top + borderTop + paddingTop
  let previousBottom = flowOrigin
  const flowDecorationAnchors: DocumentFlowDecorationAnchor[] = []

  for (const directChild of page.children) {
    if (!(directChild instanceof HTMLElement)) continue
    // 同行分组作为一个整体参与纵向排版，组内子区块不能再次叠加段前距离。
    const child = directChild
    // 绝对定位装饰线不占据普通流，不能参与实际底边测量，否则后续正文会被重复下推。
    if (child.dataset.flowOccupiesSpace === 'false') {
      const shapeSourceTop = Number(child.dataset.sourceTop)
      const desiredTop = resolveTranslationFlowDecorationTop(
        shapeSourceTop,
        flowDecorationAnchors,
        scale
      )
      if (desiredTop !== undefined) {
        const oldOffset = Number.parseFloat(
          child.style.getPropertyValue('--document-shape-flow-offset')
        ) || 0
        // 装饰线使用绝对定位，其 top 基准是页面内边距盒；先扣除上一次偏移，才能得到稳定基准。
        const baseTop = child.getBoundingClientRect().top - oldOffset
        child.style.setProperty('--document-shape-flow-offset', `${desiredTop - baseTop}px`)
      } else {
        child.style.removeProperty('--document-shape-flow-offset')
      }
      continue
    }
    const sourceY = Number(child.dataset.sourceY)
    const sourceGap = Math.max(0, Number(child.dataset.sourceGapBefore) || 0)
    let gapPx = sourceGap * scale
    if ((child.classList.contains('document-image-block') ||
      child.querySelector(':scope > .document-image-block')) && Number.isFinite(sourceY)) {
      const anchoredTop = flowOrigin + Math.max(0, sourceY - pageMarginTop) * scale
      // 原文锚点只允许下推图片，不能把图片拉回前文译文已占用的区域。
      gapPx = Math.max(0, anchoredTop - previousBottom)
      child.style.setProperty('--document-image-flow-gap-before', `${gapPx / scale}px`)
    } else {
      child.style.setProperty('--document-flow-gap-before', `${gapPx / scale}px`)
    }
    previousBottom = Math.max(previousBottom, measureTranslationFlowBottom(child))
    const sourceTop = Number(child.dataset.sourceTop)
    const sourceBottom = Number(child.dataset.sourceBottom)
    if (Number.isFinite(sourceTop) && Number.isFinite(sourceBottom)) {
      const childRect = child.getBoundingClientRect()
      flowDecorationAnchors.push({
        sourceTop,
        sourceBottom,
        actualTop: childRect.top,
        actualBottom: childRect.bottom
      })
    }
  }
}

/**
 * 将同行区块追加到页面；连续相同 flowGroupId 的区块共享一个横向 flex 容器。
 * 组容器承载首块的原点、段前距离与测量信息，组内区块只负责自身横向几何。
 * @param page 译文页面容器。
 * @param block 当前区块模型。
 * @param rendered 已渲染的区块元素。
 * @param groupClassName 分组容器使用的样式类名。
 * @param flowGroup 当前仍在延续的同组容器。
 * @returns 当前区块所属的同组容器；不属于分组时返回 undefined。
 * @author zhenghq
 */
function appendTranslationFlowBlock(
  page: HTMLElement,
  block: DocumentBlock,
  rendered: HTMLElement,
  groupClassName: string,
  flowGroup?: HTMLElement
): HTMLElement | undefined {
  if (!block.flowGroupId) {
    page.append(rendered)
    return undefined
  }
  if (flowGroup) {
    flowGroup.append(rendered)
    return flowGroup
  }
  const group = document.createElement('div')
  group.className = groupClassName
  group.dataset.flowGroupId = block.flowGroupId
  group.append(rendered)
  page.append(group)
  return group
}

/**
 * 为 PDF 内部字体名构造浏览器可用的字体回退链。
 * PDF.js 的 BaseFont 名称通常不是本机字体族，单独使用会回退到默认字体并造成译文观感不一致。
 * @param fontFamily PDF 模型中的字体名称。
 * @returns 带中英文系统字体回退的 CSS font-family 值。
 * @author zhenghq
 */
function pdfPreviewFontFamily(fontFamily: string): string {
  const escaped = fontFamily.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
  const normalized = fontFamily.toLowerCase()
  // PDF.js 对中文 PDF 常把内嵌字体标记为 monospace；优先依据实际字体名选择衬线或无衬线回退。
  if (/song|simsun|serif|times|georgia|garamond|ming|kai|fang|宋|明|楷|仿/iu.test(normalized)) {
    return `"${escaped}", "Times New Roman", "Songti SC", "SimSun", "Noto Serif CJK SC", serif`
  }
  if (/mono|courier|consolas|menlo|monaco|code/iu.test(normalized)) {
    return `"${escaped}", Menlo, Consolas, "Songti SC", "SimSun", monospace`
  }
  return `"${escaped}", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif`
}

/**
 * 为译文文本块写入独立的对齐锚点和可用宽度，避免所有段落共用整页边界。
 * 左对齐固定原左边界；居中固定原中心线；右对齐固定原右边界。
 * @param element 译文文本块。
 * @param block 文本区块。
 * @param pageWidth 原始页面宽度。
 * @param contentArea 原文正文内容区；用于保留左右页边距并扩展短标题译文。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyTranslationBlockGeometry(
  element: HTMLElement,
  block: DocumentTextBlock,
  pageWidth: number,
  contentArea?: DocumentContentArea
): void {
  if (!block.bbox) return
  const left = Math.max(0, Math.min(pageWidth, block.bbox.x))
  const right = Math.max(left, Math.min(pageWidth, block.bbox.x + block.bbox.width))
  const blockWidth = Math.max(1, right - left)
  // 左对齐正文使用页面正文区右边界，既避免缩在原文短行内，也保留原文右侧页边距。
  // 居中标题围绕原中心线向正文区两侧扩展，避免中文短标题的 bbox 把英文译文过早折行。
  // 右对齐仍沿用原 bbox 宽度，防止扩大宽度后改变其右边缘。
  // 旧模型没有正文区信息时沿用原 bbox 宽度，不能退回物理页宽而重新铺满页面。
  const contentRight = Math.max(
    right,
    Math.min(pageWidth, contentArea?.right ?? right)
  )
  const contentLeft = Math.min(
    left,
    Math.max(0, contentArea?.left ?? left)
  )
  const blockCenter = block.bbox.x + block.bbox.width / 2
  const centeredWidth = Math.max(blockWidth, Math.min(
    contentRight - contentLeft,
    Math.min(blockCenter - contentLeft, contentRight - blockCenter) * 2
  ))
  const flowWidth = block.textAlign === 'center'
    ? centeredWidth
    : block.textAlign === 'right'
      ? blockWidth
      : block.role === 'code'
        ? blockWidth
        : Math.max(blockWidth, contentRight - left)
  const flowLeft = block.textAlign === 'center'
    ? blockCenter - flowWidth / 2
    : block.textAlign === 'right' ? right - flowWidth : left
  element.style.setProperty('--document-block-left', `${flowLeft}px`)
  element.style.setProperty('--document-block-width', `${flowWidth}px`)
  element.style.setProperty('--document-block-right', `${Math.max(0, pageWidth - right)}px`)
  element.dataset.blockWidth = String(blockWidth)
  if (block.textAlign) element.dataset.align = block.textAlign
}

/**
 * 为译文图片写入原文中的横向位置与尺寸，确保图片不被流式布局拉伸。
 * @param element 译文图片区块。
 * @param block 图片区块。
 * @param pageWidth 原始页面宽度。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyTranslationImageGeometry(
  element: HTMLElement,
  block: DocumentImageBlock,
  pageWidth: number
): void {
  if (!block.bbox) return
  const left = Math.max(0, Math.min(pageWidth, block.bbox.x))
  const right = Math.max(left, Math.min(pageWidth, block.bbox.x + block.bbox.width))
  element.style.setProperty('--document-image-left', `${left}px`)
  element.style.setProperty('--document-image-width', `${Math.max(1, right - left)}px`)
  element.style.setProperty('--document-image-height', `${Math.max(1, block.bbox.height)}px`)
  element.dataset.geometry = 'source'
}

/**
 * 应用模型中的通用区块位置和样式。
 * @param element 目标元素。
 * @param block 文档区块。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyBlockGeometry(element: HTMLElement, block: DocumentBlock): void {
  if (block.bbox) {
    element.style.left = `${block.bbox.x}px`
    element.style.top = `${block.bbox.y}px`
    element.style.width = `${Math.max(1, block.bbox.width)}px`
    element.style.minHeight = `${Math.max(1, block.bbox.height)}px`
  }
  Object.assign(element.style, styleProperties(block.style))
}

/**
 * 判断文本区块是否需要绝对页面定位；流式格式由 CSS 自动排版。
 * @param block 文本区块。
 * @returns 是否具有版面坐标。
 * @author zhenghq
 */
function hasPageGeometry(block: DocumentBlock): boolean {
  return Boolean(block.bbox)
}

/**
 * 判断文本区块是否至少包含一个非空可见片段。
 * @param block 文本区块。
 * @returns 是否存在可渲染文本。
 * @author zhenghq
 */
function hasVisibleText(block: DocumentTextBlock): boolean {
  return block.runs.some((run) => run.text.trim().length > 0)
}

/**
 * 判断区块是否会在流式预览中产生可见内容。
 * 表格需要递归检查单元格，避免只有空结构时误判为可渲染。
 * @param block 文档区块。
 * @param side 当前渲染侧。
 * @returns 是否存在可渲染内容。
 * @author zhenghq
 */
function hasVisibleBlockContent(block: DocumentBlock, side: DocumentRenderSide): boolean {
  switch (block.kind) {
    case 'text':
      return hasVisibleText(block)
    case 'table':
      return block.rows.some((row) => row.cells.some((cell) =>
        cell.blocks.some((child) => hasVisibleBlockContent(child, side))))
    case 'image':
      return !block.renderPending || Boolean(block.alt?.trim()) ||
        (side === 'translation' && (block.ocrRegions ?? []).some((region) =>
          Boolean(region.translatedText?.trim())))
    case 'formula':
      return Boolean(block.latex?.trim() || block.mathml?.trim() || block.sourceText?.trim())
    case 'shape':
      return Boolean(block.label?.trim() || block.assetId || block.vectorPath)
    case 'break':
      return false
  }
}

/**
 * 判断文档模型是否至少包含一个可渲染区块。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @returns 是否存在可见内容。
 * @author zhenghq
 */
function hasVisibleFlowContent(model: DocumentModel, side: DocumentRenderSide): boolean {
  return model.pages.some((page) =>
    page.blocks.some((block) => hasVisibleBlockContent(block, side)))
}

/**
 * 创建文本区块 DOM；正文只通过 textContent 写入，避免把译文当 HTML 执行。
 * @param block 文本区块。
 * @param side 当前渲染侧。
 * @param pageWidth 原始页面宽度。
 * @param contentArea 原文正文内容区。
 * @returns 文本区块元素。
 * @author zhenghq
 */
function renderTextBlock(
  block: DocumentTextBlock,
  side: DocumentRenderSide,
  pageWidth: number,
  contentArea?: DocumentContentArea
): HTMLElement {
  const element = document.createElement('div')
  element.className = `document-text-block document-text-${block.role}`
  element.dataset.blockId = block.blockId
  if (block.role === 'code') {
    // 代码块即使只恢复出横向外框，也必须显式标记为代码框，确保译文侧始终有
    // 主题边框和独立滚动区域；不能依赖 codeFrame 是否完整识别。
    element.dataset.codeFrame = 'true'
  }
  applyBlockGeometry(element, block)
  if (block.textAlign) {
    element.style.textAlign = block.textAlign
    element.dataset.align = block.textAlign
  }
  if (block.codeFrame) {
    // 代码框使用解析器识别的原始外框，不依赖已经移出模型的独立形状线。
    element.style.setProperty('--document-code-frame-left', `${block.codeFrame.x}px`)
    element.style.setProperty('--document-code-frame-width', `${block.codeFrame.width}px`)
  }
  if (side === 'translation') {
    applyTranslationBlockGeometry(element, block, pageWidth, contentArea)
  }
  if (block.toc) {
    // 目录项必须把标题、引导线和页码拆开排版；整段按普通 run 排列会把页码挤到下一行。
    element.classList.add('document-text-toc')
    const titleRun = block.runs.find((run) => run.protected !== true)
    const title = document.createElement('span')
    title.className = 'document-toc-title'
    title.dataset.runId = titleRun?.runId ?? `${block.blockId}-toc-title`
    title.textContent = block.runs
      .filter((run) => run.protected !== true)
      .map((run) => run.text)
      .join('')
    applyScalableTextStyle(title, titleRun ? effectiveTextStyle(block, titleRun) : block.style)
    const leader = document.createElement('span')
    leader.className = 'document-toc-leader'
    leader.setAttribute('aria-hidden', 'true')
    const pageNumber = document.createElement('span')
    pageNumber.className = 'document-toc-page'
    pageNumber.textContent = block.toc.pageNumber
    element.append(title, leader, pageNumber)
    return element
  }
  for (const run of block.runs) {
    const span = document.createElement('span')
    span.className = 'document-text-run'
    span.dataset.runId = run.runId
    span.textContent = run.text
    applyScalableTextStyle(span, effectiveTextStyle(block, run))
    element.append(span)
  }
  return element
}

/**
 * 判断 OCR 区域是否会在译文侧生成可见覆盖层。
 * @param region OCR 区域。
 * @returns 是否存在可展示的译文。
 * @author zhenghq
 */
function hasVisibleOcrTranslation(region: DocumentOcrRegion): boolean {
  return Boolean(region.translatedText?.trim())
}

/**
 * 按阅读顺序排列 OCR 区域；缺少坐标时保持引擎返回顺序。
 * @param regions OCR 区域列表。
 * @returns 已按从上到下、从左到右排列的区域副本。
 * @author zhenghq
 */
function orderedOcrRegions(regions: readonly DocumentOcrRegion[]): DocumentOcrRegion[] {
  return regions
    .map((region, index) => ({ region, index }))
    .sort((left, right) => {
      const topDifference = left.region.bbox.y - right.region.bbox.y
      if (Math.abs(topDifference) > 0.002) return topDifference
      const leftDifference = left.region.bbox.x - right.region.bbox.x
      return Math.abs(leftDifference) > 0.002 ? leftDifference : left.index - right.index
    })
    .map((entry) => entry.region)
}

/**
 * 计算 OCR 覆盖层的可见内容签名，用于跳过未变化图片的覆盖层替换。
 * @param block 图片区块。
 * @returns 覆盖层签名；没有可见译文时返回空字符串。
 * @author zhenghq
 */
function ocrTranslationLayerSignature(block: DocumentImageBlock): string {
  const regions = orderedOcrRegions(block.ocrRegions ?? []).filter(hasVisibleOcrTranslation)
  if (regions.length === 0) return ''
  return JSON.stringify(regions.map((region) => ({
    regionId: region.regionId,
    bbox: region.bbox,
    translatedText: region.translatedText,
    style: region.style,
    textAlign: region.textAlign,
    status: region.status
  })))
}

/**
 * 创建 OCR 译文覆盖层；源文侧不叠加识别文本，译文侧也只显示已成功翻译的内容。
 * 覆盖层高度随译文实际换行增长，相邻区域由流式布局避让，避免文字被裁切或重叠。
 * @param imageBlock 图片区块。
 * @param region OCR 区域。
 * @param previousRegion 上一条可见 OCR 区域。
 * @param side 当前渲染侧。
 * @returns OCR 覆盖元素；无需显示时返回 null。
 * @author zhenghq
 */
function renderOcrRegion(
  imageBlock: DocumentImageBlock,
  region: DocumentOcrRegion,
  previousRegion: DocumentOcrRegion | undefined,
  side: DocumentRenderSide
): HTMLElement | null {
  // 源文栏保留扫描页或原始图片，不在图片上重复叠加 OCR 原文。
  if (side !== 'translation') return null
  const translatedText = region.translatedText?.trim()
  // 翻译失败或尚未完成时保留原图，避免把 OCR 原文误当作译文覆盖显示。
  if (!translatedText) return null
  const element = document.createElement('div')
  element.className = 'document-ocr-region'
  element.dataset.status = region.status
  element.dataset.regionId = region.regionId
  // 横向沿用 OCR 原文 bbox；左对齐文本允许延伸到图片右边界，减少无意义的逐字换行。
  const left = Math.max(0, Math.min(1, region.bbox.x))
  const right = Math.max(left, Math.min(1, region.bbox.x + region.bbox.width))
  const width = region.textAlign === 'center' || region.textAlign === 'right'
    ? Math.max(0.001, right - left)
    : Math.max(0.001, 1 - left)
  const imageHeight = Math.max(1, imageBlock.bbox?.height ?? 1)
  const imageWidth = Math.max(1, imageBlock.bbox?.width ?? 1)
  const fontSize = resolveOcrRegionFontSize(region, imageHeight)
  const lineHeight = resolveOcrRegionLineHeight(fontSize)
  const padding = resolveOcrRegionPadding(imageWidth, imageHeight, region)
  element.style.left = `${left * 100}%`
  element.style.width = `${width * 100}%`
  // CSS 变量使用原图像素坐标，再由页面缩放比例统一换算到预览尺寸。
  element.style.setProperty(
    '--document-ocr-gap-before',
    `${resolveOcrRegionGapBefore(region, previousRegion, imageHeight)}px`
  )
  element.style.setProperty(
    '--document-ocr-padding-x',
    `${padding.x}px`
  )
  element.style.setProperty('--document-ocr-padding-y', `${padding.y}px`)
  element.style.setProperty('--document-ocr-font-size-pt', String(fontSize))
  element.style.setProperty('--document-ocr-line-height', String(lineHeight / fontSize))
  if (region.style?.color) element.style.color = region.style.color
  if (region.style?.fontWeight !== undefined) element.style.fontWeight = String(region.style.fontWeight)
  element.style.fontFamily = pdfPreviewFontFamily(region.style?.fontFamily ?? 'Noto Sans SC')
  if (region.style?.italic) element.style.fontStyle = 'italic'
  if (region.textAlign) element.style.textAlign = region.textAlign
  element.textContent = translatedText
  return element
}

/**
 * 创建图片的 OCR 译文覆盖层；没有可展示译文时返回 null。
 * @param block 图片区块。
 * @returns 可直接挂载到图片区块的 OCR 覆盖层。
 * @author zhenghq
 */
function createOcrTranslationLayer(block: DocumentImageBlock): HTMLElement | null {
  const regions = orderedOcrRegions(block.ocrRegions ?? []).filter(hasVisibleOcrTranslation)
  if (regions.length === 0) return null
  const layer = document.createElement('div')
  layer.className = 'document-ocr-translation-layer'
  layer.dataset.ocrTranslationSignature = ocrTranslationLayerSignature(block)
  const masks = document.createElement('div')
  masks.className = 'document-ocr-original-mask-layer'
  for (const region of regions) {
    const mask = document.createElement('span')
    mask.className = 'document-ocr-original-mask'
    mask.style.left = `${Math.max(0, Math.min(1, region.bbox.x)) * 100}%`
    mask.style.top = `${Math.max(0, Math.min(1, region.bbox.y)) * 100}%`
    mask.style.width = `${Math.max(0, Math.min(1, region.bbox.width)) * 100}%`
    mask.style.height = `${Math.max(0, Math.min(1, region.bbox.height)) * 100}%`
    masks.append(mask)
  }
  layer.append(masks)
  let previousRegion: DocumentOcrRegion | undefined
  for (const region of regions) {
    const overlay = renderOcrRegion(block, region, previousRegion, 'translation')
    if (overlay) layer.append(overlay)
    previousRegion = region
  }
  return layer
}

/**
 * 创建图片区块；资源加载成功前使用占位区域，加载完成后填入图片。
 * @param block 图片区块。
 * @param side 当前渲染侧。
 * @param pageWidth 原始页面宽度。
 * @returns 图片区块元素。
 * @author zhenghq
 */
function renderImageBlock(
  block: DocumentImageBlock,
  side: DocumentRenderSide,
  pageWidth: number
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'document-image-block'
  wrapper.dataset.blockId = block.blockId
  applyBlockGeometry(wrapper, block)
  if (side === 'translation') applyTranslationImageGeometry(wrapper, block, pageWidth)
  if (block.renderPending) {
    wrapper.dataset.pending = 'true'
    wrapper.textContent = t('document.ocr.pendingRender')
  } else {
    const image = document.createElement('img')
    image.className = 'document-page-image'
    image.alt = block.alt ?? ''
    image.decoding = 'async'
    wrapper.append(image)
    void resolveAssetUrl(block.assetId).then((url) => {
      if (!url) return
      image.src = url
    })
  }
  if (side === 'translation') {
    const layer = createOcrTranslationLayer(block)
    if (layer) {
      wrapper.dataset.ocrTranslation = 'true'
      wrapper.append(layer)
    }
  }
  return wrapper
}

/**
 * 创建表格区块并递归渲染单元格中的受支持内容。
 * @param block 表格区块。
 * @param side 当前渲染侧。
 * @param pageWidth 原始页面宽度，用于约束表格横向范围。
 * @returns 表格区块元素。
 * @author zhenghq
 */
function renderTableBlock(
  block: DocumentTableBlock,
  side: DocumentRenderSide,
  pageWidth: number
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'document-table-block'
  applyBlockGeometry(wrapper, block)
  if (block.bbox) {
    const left = Math.max(0, Math.min(pageWidth, block.bbox.x))
    const width = Math.max(1, Math.min(block.bbox.width, pageWidth - left))
    wrapper.style.setProperty('--document-table-left', `${left}px`)
    wrapper.style.setProperty('--document-table-width', `${width}px`)
  }
  const table = document.createElement('table')
  // 两侧都沿用原文列宽，保证译文表格与源 PDF 的列边界一致。
  table.style.tableLayout = 'fixed'
  if (block.columnWidths?.length) {
    const columns = document.createElement('colgroup')
    for (const width of normalizeTableColumnWidths(block.columnWidths, block.bbox?.width)) {
      const column = document.createElement('col')
      column.style.width = `${width}px`
      columns.append(column)
    }
    table.append(columns)
  }
  const headerRowCount = Math.max(0, Math.min(block.headerRows ?? 0, block.rows.length))
  if (headerRowCount > 0) {
    const head = document.createElement('thead')
    for (const row of block.rows.slice(0, headerRowCount)) {
      const tableRow = document.createElement('tr')
      for (const cell of row.cells) {
        const tableCell = document.createElement('th')
        tableCell.scope = 'col'
        tableCell.colSpan = Math.max(1, cell.colSpan)
        tableCell.rowSpan = Math.max(1, cell.rowSpan)
        for (const child of cell.blocks) tableCell.append(renderTableCellBlock(child, side))
        tableRow.append(tableCell)
      }
      head.append(tableRow)
    }
    table.append(head)
  }
  const body = document.createElement('tbody')
  for (const row of block.rows.slice(headerRowCount)) {
    const tableRow = document.createElement('tr')
    for (const cell of row.cells) {
      const tableCell = document.createElement('td')
      tableCell.colSpan = Math.max(1, cell.colSpan)
      tableCell.rowSpan = Math.max(1, cell.rowSpan)
      for (const child of cell.blocks) tableCell.append(renderTableCellBlock(child, side))
      tableRow.append(tableCell)
    }
    body.append(tableRow)
  }
  table.append(body)
  wrapper.append(table)
  return wrapper
}

/**
 * 渲染表格单元格内容；译文单元格是独立流式区域，不能沿用 PDF 页面的绝对坐标。
 * @param block 单元格子区块。
 * @param side 当前渲染侧。
 * @returns 单元格子区块元素。
 * @author zhenghq
 */
function renderTableCellBlock(block: DocumentBlock, side: DocumentRenderSide): HTMLElement {
  const pageWidth = 1
  const element = block.kind === 'image'
    ? renderTableCellImageBlock(block, side)
    : renderBlock(block, side, pageWidth)
  // 单元格内子区块的 bbox 是整页坐标，标记后由 CSS 清除页面级偏移并限制在单元格内。
  element.dataset.tableCellContent = 'true'
  return element
}

/**
 * 创建表格单元格图片；图片进入单元格普通流并按列宽等比缩放。
 * @param block 表格单元格内的图片区块。
 * @param side 当前渲染侧。
 * @returns 不继承页面绝对坐标的图片区块元素。
 * @author zhenghq
 */
function renderTableCellImageBlock(
  block: DocumentImageBlock,
  side: DocumentRenderSide
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'document-image-block'
  wrapper.dataset.blockId = block.blockId
  wrapper.dataset.tableCellImage = 'true'
  wrapper.dataset.tableCellContent = 'true'
  if (side === 'translation') wrapper.dataset.renderSide = side
  if (block.renderPending) {
    wrapper.dataset.pending = 'true'
    wrapper.textContent = t('document.ocr.pendingRender')
    return wrapper
  }
  const image = document.createElement('img')
  image.className = 'document-page-image'
  image.alt = block.alt ?? ''
  image.decoding = 'async'
  wrapper.append(image)
  void resolveAssetUrl(block.assetId).then((url) => {
    if (!url) {
      wrapper.dataset.pending = 'true'
      wrapper.textContent = block.alt || t('document.ocr.pendingRender')
      return
    }
    image.src = url
    image.addEventListener('load', scheduleTranslationPageLayout, { once: true })
  })
  return wrapper
}

/**
 * 将表格列宽按表格总宽度归一化，防止解析误差导致列宽总和超过页面边界。
 * @param columnWidths 原始列宽。
 * @param tableWidth 表格边界宽度；缺失时保留原始比例。
 * @returns 归一化后的列宽。
 * @author zhenghq
 */
function normalizeTableColumnWidths(
  columnWidths: readonly number[],
  tableWidth: number | undefined
): number[] {
  const validWidths = columnWidths.map((value) => Number.isFinite(value) && value > 0 ? value : 0)
  const total = validWidths.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return Array.from({ length: columnWidths.length }, () => 1)
  if (!tableWidth || !Number.isFinite(tableWidth) || tableWidth <= 0) return validWidths
  return validWidths.map((value) => value / total * tableWidth)
}

/**
 * 创建可随页面缩放的直线装饰区块；线宽与颜色使用原始 PDF 信息。
 * @param block 形状区块。
 * @returns 形状区块元素。
 * @author zhenghq
 */
function renderShapeBlock(block: Extract<DocumentBlock, { kind: 'shape' }>): HTMLElement {
  const element = document.createElement('div')
  element.className = 'document-shape-block'
  element.dataset.blockId = block.blockId
  element.textContent = block.line ? '' : block.label ?? ''
  applyBlockGeometry(element, block)
  if (block.line) {
    element.dataset.lineOrientation = block.line.orientation
    element.style.setProperty('--document-line-color', block.line.color ?? 'var(--document-paper-text)')
    element.style.setProperty('--document-line-thickness', `${Math.max(0.5, block.line.thickness ?? 1)}px`)
    if (block.bbox) {
      element.style.setProperty('--document-shape-left', `${Math.max(0, block.bbox.x)}px`)
      element.style.setProperty('--document-shape-top', `${Math.max(0, block.bbox.y)}px`)
      element.style.setProperty('--document-shape-width', `${Math.max(1, block.bbox.width)}px`)
      element.style.setProperty('--document-shape-height', `${Math.max(1, block.bbox.height)}px`)
    }
  }
  return element
}

/**
 * 创建公式区块；首版保留 LaTeX/MathML 原始表达，不执行任意标记。
 * @param block 公式区块。
 * @returns 公式区块元素。
 * @author zhenghq
 */
function renderFormulaBlock(block: Extract<DocumentBlock, { kind: 'formula' }>): HTMLElement {
  const element = document.createElement('div')
  element.className = 'document-formula-block'
  element.dataset.blockId = block.blockId
  element.textContent = block.latex ?? block.sourceText ?? block.mathml ?? t('document.formulaPreserved')
  applyBlockGeometry(element, block)
  return element
}

/**
 * 根据区块类型创建安全 DOM。
 * @param block 文档区块。
 * @param side 当前渲染侧。
 * @param pageWidth 原始页面宽度。
 * @param contentArea 原文正文内容区。
 * @returns 区块元素。
 * @author zhenghq
 */
function renderBlock(
  block: DocumentBlock,
  side: DocumentRenderSide,
  pageWidth: number,
  contentArea?: DocumentContentArea
): HTMLElement {
  switch (block.kind) {
    case 'text': return renderTextBlock(block, side, pageWidth, contentArea)
    case 'image': return renderImageBlock(block, side, pageWidth)
    case 'table': return renderTableBlock(block, side, pageWidth)
    case 'formula': return renderFormulaBlock(block)
    case 'shape': return renderShapeBlock(block)
    case 'break': {
      const element = document.createElement('div')
      element.className = 'document-break-block'
      element.dataset.breakType = block.breakType
      return element
    }
  }
}

/**
 * 创建单页容器并渲染全部区块。
 * @param page 文档页面。
 * @param side 当前渲染侧。
 * @returns 页面元素。
 * @author zhenghq
 */
function renderPage(
  page: DocumentPage,
  side: DocumentRenderSide
): HTMLElement {
  const element = document.createElement('article')
  element.className = 'document-page'
  element.dataset.pageId = page.pageId
  element.dataset.sourceWidth = String(Math.max(1, page.width))
  element.style.width = `${Math.max(1, page.width)}px`
  element.style.height = `${Math.max(1, page.height)}px`
  element.style.setProperty('--document-page-width', `${Math.max(1, page.width)}px`)
  element.style.setProperty('--document-page-height', `${Math.max(1, page.height)}px`)
  if (page.background?.kind === 'solid') {
    element.style.backgroundColor = page.background.color
  }
  const hasGeometry = page.blocks.some(hasPageGeometry)
  if (side === 'translation' && hasGeometry) {
    // PDF 译文页统一使用纸张主题兜底；显式页面底色已在前面覆盖，空白页也不能露出深色容器。
    element.style.backgroundColor = 'var(--document-paper-bg)'
  }
  element.dataset.layout = side === 'translation' && hasGeometry
    ? 'translation-flow'
    : hasGeometry ? 'absolute' : 'flow'
  let previousBottom = 0
  let previousBlock: DocumentBlock | undefined
  let activeFlowGroup: HTMLElement | undefined
  let activeFlowGroupId: string | undefined
  const flowGroupBlocks = new Map<string, DocumentBlock[]>()
  for (const block of page.blocks) {
    if (!block.flowGroupId) continue
    const groupBlocks = flowGroupBlocks.get(block.flowGroupId) ?? []
    groupBlocks.push(block)
    flowGroupBlocks.set(block.flowGroupId, groupBlocks)
  }
  if (element.dataset.layout === 'translation-flow') {
    // 译文页面用原始 PDF 页面宽度作为缩放基准，字号、间距和页边距随双栏宽度等比变化。
    const geometryBlocks = page.blocks.filter((block) => block.bbox)
    const minY = geometryBlocks.length > 0
      ? Math.max(0, Math.min(...geometryBlocks.map((block) => block.bbox!.y)))
      : 0
    element.style.setProperty('--document-page-margin-top', `${minY}px`)
    element.style.setProperty('--document-page-width', `${Math.max(1, page.width)}px`)
    element.style.setProperty('--document-page-scale', '1')
    previousBottom = minY
  }
  for (const block of page.blocks) {
    const rendered = renderBlock(block, side, page.width, page.contentArea)
    const occupiesFlow = occupiesDocumentTranslationFlow(block)
    rendered.dataset.flowOccupiesSpace = String(occupiesFlow)
    const continuesFlowGroup = element.dataset.layout === 'translation-flow' &&
      block.flowGroupId !== undefined &&
      block.flowGroupId === activeFlowGroupId
    const blockGapBefore = element.dataset.layout === 'translation-flow' && block.bbox
      ? pdfFlowGapBefore(block, previousBlock, previousBottom)
      : 0
    if (element.dataset.layout === 'translation-flow' && block.bbox) {
      // 译文仍按阅读顺序流式换行，但段前距离来自原文坐标，避免统一 gap 破坏标题和正文节奏。
      rendered.style.setProperty('--document-flow-gap-before', `${blockGapBefore}px`)
      // 图片需要优先回到原文纵向锚点；保留原始 y 与段前距离供挂载后的真实 DOM 测量使用。
      rendered.dataset.sourceY = String(block.bbox.y)
      rendered.dataset.sourceTop = String(block.bbox.y)
      rendered.dataset.sourceBottom = String(block.bbox.y + block.bbox.height)
      rendered.dataset.sourceGapBefore = String(blockGapBefore)
      // 装饰线虽然保留原文底边信息，但不占普通流高度；后续文本应继续以最后一个流式区块为基准。
      if (occupiesFlow) {
        previousBottom = Math.max(previousBottom, block.bbox.y + block.bbox.height)
      }
    }
    previousBlock = block
    if (element.dataset.layout !== 'translation-flow') {
      element.append(rendered)
      continue
    }
    if (!continuesFlowGroup && activeFlowGroup) {
      activeFlowGroup = undefined
      activeFlowGroupId = undefined
    }
    const nextGroup = appendTranslationFlowBlock(
      element,
      block,
      rendered,
      'document-flow-group',
      activeFlowGroup
    )
    if (nextGroup && block.flowGroupId) {
      if (!activeFlowGroup) {
        // 分组容器继承首块的原文坐标与段前距离，供挂载后的真实 DOM 测量使用。
        const groupGeometry = resolveTranslationFlowGroupGeometry(
          flowGroupBlocks.get(block.flowGroupId) ?? [block],
          page.blocks,
          page.width,
          page.contentArea
        )
        nextGroup.style.setProperty('--document-flow-group-left', `${groupGeometry.left}px`)
        nextGroup.style.setProperty('--document-flow-group-width', `${groupGeometry.width}px`)
        nextGroup.style.setProperty('--document-flow-group-height', `${groupGeometry.height}px`)
        nextGroup.style.setProperty('--document-flow-group-gap', `${groupGeometry.textGap}px`)
        nextGroup.style.setProperty('--document-flow-group-text-top', `${groupGeometry.textTop}px`)
        nextGroup.style.setProperty('--document-flow-gap-before', `${blockGapBefore}px`)
        nextGroup.dataset.flowOccupiesSpace = String(
          (flowGroupBlocks.get(block.flowGroupId) ?? [block]).some(occupiesDocumentTranslationFlow)
        )
        if (block.bbox) {
          nextGroup.dataset.sourceY = String(block.bbox.y)
          nextGroup.dataset.sourceGapBefore = String(blockGapBefore)
          const groupBlocks = flowGroupBlocks.get(block.flowGroupId) ?? [block]
          const groupBounds = groupBlocks.filter((groupBlock) => groupBlock.bbox)
          if (groupBounds.length > 0) {
            nextGroup.dataset.sourceTop = String(Math.min(
              ...groupBounds.map((groupBlock) => groupBlock.bbox!.y)
            ))
            nextGroup.dataset.sourceBottom = String(Math.max(
              ...groupBounds.map((groupBlock) => groupBlock.bbox!.y + groupBlock.bbox!.height)
            ))
          }
        }
        rendered.style.setProperty('--document-flow-gap-before', '0px')
        rendered.dataset.sourceGapBefore = '0'
      }
      activeFlowGroup = nextGroup
      activeFlowGroupId = block.flowGroupId
    } else {
      activeFlowGroup = undefined
      activeFlowGroupId = undefined
    }
  }
  return element
}

/**
 * 创建译文水印中的真实品牌图标；直接复用托盘模板的“译”字轮廓，并强制使用当前文字颜色。
 * @returns 无交互的品牌图标元素。
 * @author zhenghq
 */
function createTranslationWatermarkLogo(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const logo = document.createElementNS(namespace, 'svg')
  logo.classList.add('document-translation-watermark-logo')
  logo.setAttribute('viewBox', '0 0 36 36')
  logo.setAttribute('aria-hidden', 'true')
  const glyph = document.createElementNS(namespace, 'path')
  glyph.setAttribute('id', 'rounded-yi-glyph')
  glyph.setAttribute('data-font-family', 'Wawati SC')
  glyph.setAttribute('fill', 'currentColor')
  glyph.setAttribute('stroke', 'currentColor')
  glyph.setAttribute('stroke-width', '5')
  glyph.setAttribute('stroke-linecap', 'round')
  glyph.setAttribute('stroke-linejoin', 'round')
  glyph.setAttribute('paint-order', 'stroke fill')
  glyph.setAttribute('transform', 'translate(3.2 25.9) scale(0.113)')
  glyph.setAttribute('d', TRANSLATION_WATERMARK_LOGO_PATH)
  logo.append(glyph)
  return logo
}

/**
 * 创建译文水印中的产品名文本，并统一应用当前文字颜色。
 * @param value 水印展示的产品名。
 * @param className 文本节点附加的样式类名。
 * @returns 无交互的 SVG 文本元素。
 * @author zhenghq
 */
function createTranslationWatermarkText(value: string, className?: string): SVGTextElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const text = document.createElementNS(namespace, 'text')
  text.classList.add('document-translation-watermark-text')
  if (className) text.classList.add(className)
  text.setAttribute('fill', 'currentColor')
  text.textContent = value
  return text
}

/**
 * 创建铺满译文预览区域的 SVG 水印图案；图案随内容高度平铺，打印分页时每页都会重复。
 * @returns 包含斜向品牌文字的 SVG 图案元素。
 * @author zhenghq
 */
function createTranslationWatermarkPattern(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const pattern = document.createElementNS(namespace, 'svg')
  pattern.classList.add('document-translation-watermark-pattern')
  pattern.setAttribute('aria-hidden', 'true')
  pattern.setAttribute('preserveAspectRatio', 'none')
  const definitions = document.createElementNS(namespace, 'defs')
  const tile = document.createElementNS(namespace, 'pattern')
  tile.setAttribute('id', 'document-translation-watermark-tile-pattern')
  // 平移图案原点而不是旋转后的内容组，才能保持屏幕与 PDF 中的平铺周期不变。
  tile.setAttribute('x', '0')
  // 中英文上下两行沿用原始瓦片间距，保持与既有译文水印的疏密一致。
  tile.setAttribute('width', '320')
  tile.setAttribute('height', '180')
  tile.setAttribute('patternUnits', 'userSpaceOnUse')
  const content = document.createElementNS(namespace, 'g')
  content.classList.add('document-translation-watermark-tile')
  // Chromium 打印链路会忽略 patternTransform，直接旋转内容组可确保屏幕和 PDF 都是 45 度斜水印。
  content.setAttribute('transform', 'rotate(-45 160 90)')
  const logo = createTranslationWatermarkLogo()
  logo.setAttribute('x', '74')
  logo.setAttribute('y', '96')
  logo.setAttribute('width', '24')
  logo.setAttribute('height', '24')
  const chineseText = createTranslationWatermarkText('划词翻译')
  chineseText.setAttribute('x', '106')
  chineseText.setAttribute('y', '107')
  const englishText = createTranslationWatermarkText(
    'Selection Translator',
    'document-translation-watermark-text--english'
  )
  englishText.setAttribute('x', '108')
  englishText.setAttribute('y', '127')
  content.append(logo, chineseText, englishText)
  tile.append(content)
  definitions.append(tile)
  const surface = document.createElementNS(namespace, 'rect')
  surface.setAttribute('width', '100%')
  surface.setAttribute('height', '100%')
  surface.setAttribute('fill', 'url(#document-translation-watermark-tile-pattern)')
  pattern.append(definitions, surface)
  return pattern
}

/**
 * 在译文容器内创建覆盖全部内容的水印层，屏幕预览与打印 PDF 共用同一 DOM。
 * @param container 译文预览宿主；原文侧传入时不创建水印。
 * @param side 当前渲染侧。
 * @returns 无返回值。
 * @author zhenghq
 */
function appendTranslationWatermark(container: HTMLElement, side: DocumentRenderSide): void {
  if (side !== 'translation') return
  watermarkResizeObserver?.disconnect()
  watermarkResizeObserver = null
  const watermark = document.createElement('div')
  watermark.className = 'document-translation-watermark'
  watermark.setAttribute('aria-hidden', 'true')
  const pattern = createTranslationWatermarkPattern()
  watermark.append(pattern)
  container.append(watermark)
  const tile = pattern.querySelector<SVGPatternElement>('pattern')
  const updateOffset = (): void => {
    if (!tile) return
    tile.setAttribute('x', String(resolveTranslationWatermarkHorizontalOffset(watermark.clientWidth)))
  }
  updateOffset()
  // 首次挂载时容器可能尚未连接 DOM；ResizeObserver 会在布局完成后再次回调。
  const observer = new ResizeObserver(updateOffset)
  watermarkResizeObserver = observer
  observer.observe(watermark)
}

/**
 * 根据源文件格式和当前栏位选择预览呈现方式。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @returns 对应的预览类型。
 * @author zhenghq
 */
function resolvePreviewKind(model: DocumentModel, side: DocumentRenderSide): DocumentPreviewKind {
  const format = model.source.format
  if (format === 'pdf') return 'paged'
  if (format === 'markdown') return 'markdown'
  if (format === 'csv') return 'table'
  if (format === 'srt' || format === 'vtt') return 'subtitle'
  if (side === 'source' && format === 'html') return 'html-source'
  if (format === 'html') return 'flow'
  return 'flow'
}

/**
 * 将本机绝对路径转换为可供 webview 加载的 file URL。
 * 逐段编码空格、中文与 URL 保留字符，同时保留 Windows 盘符和 UNC 主机名。
 * @param filePath 本机文件绝对路径。
 * @returns 可直接交给 webview.src 的 file URL。
 * @author zhenghq
 */
function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/gu, '/')
  const encodeSegments = (segments: readonly string[]): string =>
    segments.map((segment) => encodeURIComponent(segment)).join('/')
  if (/^[a-z]:\//iu.test(normalized)) {
    return `file:///${normalized.slice(0, 2)}/${encodeSegments(normalized.slice(3).split('/'))}`
  }
  if (normalized.startsWith('//')) {
    const [, , host = '', ...segments] = normalized.split('/')
    return `file://${encodeURIComponent(host)}/${encodeSegments(segments)}`
  }
  const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeSegments(absolute.split('/'))}`
}

/**
 * 使用隔离 webview 直接加载原始 HTML，保留远程图片、样式、框架和链接。
 * webview 不继承 preload 或 Node 能力，页面脚本只能在独立 guest 中运行。
 * @param container 源文滚动容器。
 * @param model 当前 HTML 文档模型。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderHtmlSourcePreview(container: HTMLElement, model: DocumentModel): void {
  const webview = document.createElement('webview')
  webview.className = 'document-html-preview'
  webview.setAttribute('partition', 'document-html-preview')
  webview.setAttribute('aria-label', t('document.source'))
  webview.src = toFileUrl(model.source.path)
  container.append(webview)
}

/**
 * 渲染文本 run，保持受保护片段原样并通过 textContent 安全写入。
 * @param block 文本区块。
 * @returns 包含全部 run 的文档片段。
 * @author zhenghq
 */
function renderTextRuns(block: DocumentTextBlock): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const run of block.runs) {
    const span = document.createElement('span')
    span.className = 'document-text-run'
    span.dataset.runId = run.runId
    span.textContent = run.text
    applyScalableTextStyle(span, effectiveTextStyle(block, run))
    fragment.append(span)
  }
  return fragment
}

/**
 * 按 Markdown 语义创建单个区块元素。
 * @param block 文档区块。
 * @param side 当前渲染侧。
 * @returns 语义化区块元素。
 * @author zhenghq
 */
function renderMarkdownBlock(block: DocumentBlock, side: DocumentRenderSide): HTMLElement {
  if (block.kind === 'text') {
    if (block.role === 'code') {
      const pre = document.createElement('pre')
      pre.dataset.blockId = block.blockId
      const code = document.createElement('code')
      code.append(renderTextRuns(block))
      pre.append(code)
      return pre
    }
    if (block.role === 'heading') {
      const level = Math.max(1, Math.min(6, 7 - Math.round(((block.style?.fontSize ?? 30) - 14) / 3)))
      const heading = document.createElement(`h${level}`)
      heading.dataset.blockId = block.blockId
      heading.append(renderTextRuns(block))
      return heading
    }
    if (block.role === 'quote') {
      const quote = document.createElement('blockquote')
      quote.dataset.blockId = block.blockId
      quote.append(renderTextRuns(block))
      return quote
    }
    if (block.role === 'list-item') {
      const list = document.createElement('ul')
      const item = document.createElement('li')
      item.dataset.blockId = block.blockId
      item.append(renderTextRuns(block))
      list.append(item)
      return list
    }
  }
  return renderBlock(block, side, 1)
}

/**
 * 渲染 Markdown 文档为连续语义内容。
 * @param container 目标滚动容器。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderMarkdownDocument(
  container: HTMLElement,
  model: DocumentModel,
  side: DocumentRenderSide
): void {
  const article = document.createElement('article')
  article.className = 'document-markdown-preview'
  for (const page of model.pages) {
    for (const block of page.blocks) article.append(renderMarkdownBlock(block, side))
  }
  container.append(article)
}

/**
 * 渲染 CSV 表格文档，并保留单元格中的递归内容。
 * @param container 目标滚动容器。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderTableDocument(container: HTMLElement, model: DocumentModel, side: DocumentRenderSide): void {
  const article = document.createElement('article')
  article.className = 'document-table-preview'
  for (const page of model.pages) {
    for (const block of page.blocks) article.append(renderBlock(block, side, page.width))
  }
  container.append(article)
}

/**
 * 渲染字幕文档，并显示原始时间轴但不把时间轴送入翻译。
 * @param container 目标滚动容器。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderSubtitleDocument(container: HTMLElement, model: DocumentModel, side: DocumentRenderSide): void {
  const article = document.createElement('article')
  article.className = 'document-subtitle-preview'
  for (const page of model.pages) {
    for (const block of page.blocks) {
      const item = document.createElement('section')
      item.className = 'document-subtitle-item'
      if (block.kind === 'text' && block.timing) {
        const timing = document.createElement('span')
        timing.className = 'document-subtitle-timing'
        timing.textContent = block.timing
        item.append(timing)
      }
      item.append(renderBlock(block, side, page.width))
      article.append(item)
    }
  }
  container.append(article)
}

/**
 * 渲染 TXT、DOCX、EPUB、HTML 与 JSON 等流式格式。
 * @param container 目标滚动容器。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderFlowDocument(container: HTMLElement, model: DocumentModel, side: DocumentRenderSide): void {
  if (!hasVisibleFlowContent(model, side)) {
    const empty = document.createElement('p')
    empty.className = 'document-empty-state'
    empty.textContent = t(side === 'translation'
      ? 'document.translationEmpty'
      : 'document.waitingSource')
    container.append(empty)
    return
  }
  const article = document.createElement('article')
  article.className = 'document-flow-preview'
  for (const page of model.pages) {
    // HTML 译文同样使用流式页面：保留原页宽和段落间距，但让译文高度参与后续排版。
    article.append(renderPage(page, side))
  }
  container.append(article)
}

/**
 * 使用 PDF.js 将源 PDF 逐页绘制到 Canvas，保留原始字体、公式与版面。
 * @param container 源文滚动容器。
 * @param generationAtStart 开始渲染时的任务代际。
 * @returns 无返回值。
 * @author zhenghq
 */
async function renderPdfPages(container: HTMLElement, generationAtStart: number): Promise<void> {
  pdfPreviewCleanups.get(container)?.()
  const renderToken = Symbol('pdf-preview')
  pdfRenderTokens.set(container, renderToken)
  container.replaceChildren()
  container.dataset.previewKind = 'paged'
  const loading = document.createElement('p')
  loading.className = 'document-empty-state'
  loading.textContent = t('document.waitingSource')
  container.append(loading)

  let pdfDocument: Awaited<ReturnType<typeof pdfjsModule.getDocument>['promise']> | null = null
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const article = entry.target as HTMLElement
      observer.unobserve(article)
      void renderVisiblePage(article)
    }
  }, { root: container, rootMargin: '600px 0px' })
  const renderTasks = new Set<{ cancel(): void; promise: Promise<void> }>()
  let disposed = false
  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    for (const renderTask of renderTasks) renderTask.cancel()
    renderTasks.clear()
    if (pdfRenderTokens.get(container) === renderToken) pdfRenderTokens.delete(container)
    if (pdfPreviewCleanups.get(container) === cleanup) pdfPreviewCleanups.delete(container)
    if (pdfDocument) void pdfDocument.destroy().catch(() => undefined)
    pdfDocument = null
  }
  pdfPreviewCleanups.set(container, cleanup)
  const isCurrentRender = (): boolean => !disposed &&
    generationAtStart === generation &&
    container.isConnected &&
    pdfRenderTokens.get(container) === renderToken
  const renderVisiblePage = async (article: HTMLElement): Promise<void> => {
    if (!pdfDocument || !isCurrentRender() || article.dataset.pdfRendered === 'true') return
    article.dataset.pdfRendered = 'true'
    const pageNumber = Number(article.dataset.pageNumber)
    const canvas = article.querySelector<HTMLCanvasElement>('.document-pdf-canvas')
    if (!Number.isSafeInteger(pageNumber) || pageNumber <= 0 || !canvas) return
    try {
      const page = await pdfDocument.getPage(pageNumber)
      if (!isCurrentRender()) return
      const baseViewport = page.getViewport({ scale: 1 })
      const width = documentPageContentWidth(container)
      const scale = Math.max(0.25, width / baseViewport.width)
      const viewport = page.getViewport({ scale })
      const maxDeviceScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      canvas.width = Math.max(1, Math.floor(viewport.width * maxDeviceScale))
      canvas.height = Math.max(1, Math.floor(viewport.height * maxDeviceScale))
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      const canvasContext = canvas.getContext('2d', { alpha: false })
      if (!canvasContext) throw new Error('canvas-context-unavailable')
      // PDF.js 的透明页面必须显式铺白底，否则深色主题下空白区域会被合成成黑色。
      canvasContext.fillStyle = '#ffffff'
      canvasContext.fillRect(0, 0, canvas.width, canvas.height)
      const renderTask = page.render({
        canvasContext,
        viewport,
        background: '#ffffff',
        transform: maxDeviceScale === 1 ? undefined : [maxDeviceScale, 0, 0, maxDeviceScale, 0, 0]
      })
      renderTasks.add(renderTask)
      await renderTask.promise
      renderTasks.delete(renderTask)
      if (!isCurrentRender()) return
    } catch (error) {
      article.dataset.pdfRendered = 'false'
      if (!isCurrentRender()) return
      console.error('Failed to render PDF page', pageNumber, error)
    }
  }
  try {
    const source = await window.api.getDocumentSource()
    if (!source.ok || !source.bytes) throw new Error(source.code ?? 'source-not-found')
    if (!isCurrentRender()) return
    const loadingTask = pdfjsModule.getDocument({
      data: new Uint8Array(source.bytes),
      isEvalSupported: false,
      useSystemFonts: true
    })
    pdfDocument = await loadingTask.promise
    if (!isCurrentRender()) return
    container.replaceChildren()
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber)
      if (!isCurrentRender()) return
      const baseViewport = page.getViewport({ scale: 1 })
      const width = documentPageContentWidth(container)
      const scale = Math.max(0.25, width / baseViewport.width)
      const viewport = page.getViewport({ scale })
      const article = document.createElement('article')
      article.className = 'document-pdf-page'
      article.dataset.pageNumber = String(pageNumber)
      article.style.setProperty('--document-pdf-page-height', `${viewport.height}px`)
      const canvas = document.createElement('canvas')
      canvas.className = 'document-pdf-canvas'
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      article.append(canvas)
      container.append(article)
      observer.observe(article)
    }
    sourcePageCount.textContent = t('document.pageCount', { count: pdfDocument.numPages })
  } catch (error) {
    if (!isCurrentRender()) return
    console.error('Failed to render PDF preview', error)
    container.replaceChildren()
    const failed = document.createElement('p')
    failed.className = 'document-empty-state'
    failed.textContent = t('document.run.failed')
    container.append(failed)
  }
}

/**
 * 让译文 PDF 页面跟随双栏可用宽度缩放，并保持与左侧 Canvas 相同的页面基准。
 * @param container 译文滚动容器。
 * @returns 无返回值。
 * @author zhenghq
 */
function observeTranslationPageScale(container: HTMLElement): void {
  pageScaleObserver?.disconnect()
  pageScaleObserver = null
  if (pageLayoutFrame !== null) {
    cancelAnimationFrame(pageLayoutFrame)
    pageLayoutFrame = null
  }
  const pages = Array.from(container.querySelectorAll<HTMLElement>(".document-page[data-layout='translation-flow']"))
  if (pages.length === 0 || typeof ResizeObserver === 'undefined') return
  // 观察器可能因自身样式变化再次触发；统一在下一帧批量重排，避免同步测量循环造成卡顿。
  const scheduleLayout = (): void => {
    if (pageLayoutFrame !== null) cancelAnimationFrame(pageLayoutFrame)
    pageLayoutFrame = requestAnimationFrame(() => {
      pageLayoutFrame = null
      const availableWidth = documentPageContentWidth(container)
      for (const page of pages) {
        if (!page.isConnected) continue
        const sourceWidth = Number(page.dataset.sourceWidth)
        if (!Number.isFinite(sourceWidth) || sourceWidth <= 0) continue
        // 原文 Canvas 与译文页面使用同一内容宽度，确保左右两侧缩放比例一致。
        page.style.setProperty('--document-page-scale', String(Math.max(0.25, availableWidth / sourceWidth)))
        // 字号和宽度变化会改变译文真实高度，必须在缩放后重新测量图片锚点与流式底边。
        normalizeTranslationFlowLayout(page)
      }
    })
  }
  activePageLayoutScheduler = scheduleLayout
  const observer = new ResizeObserver(() => {
    scheduleLayout()
  })
  pageScaleObserver = observer
  observer.observe(container)
  // 字体或图片异步加载会改变页面自身高度，只观察外层容器无法触发装饰线重新锚定。
  for (const page of pages) observer.observe(page)
  scheduleLayout()
}

/**
 * 请求合并执行当前译文页面的缩放与流式重排。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleTranslationPageLayout(): void {
  activePageLayoutScheduler?.()
}

/**
 * 清理待执行的译文页面重排帧。
 * @returns 无返回值。
 * @author zhenghq
 */
function cancelTranslationPageLayout(): void {
  activePageLayoutScheduler = null
  if (pageLayoutFrame === null) return
  cancelAnimationFrame(pageLayoutFrame)
  pageLayoutFrame = null
}

/**
 * 创建独立告警层；告警更新不会替换 PDF Canvas 或正文页面。
    for (const page of pages) {
      if (page.isConnected) update(page)
    }
  })
  pageScaleObserver = observer
  observer.observe(container)
  // 字体或图片异步加载会改变页面自身高度，只观察外层容器无法触发装饰线重新锚定。
  for (const page of pages) observer.observe(page)
  for (const page of pages) update(page)
}

/**
 * 创建独立告警层；告警更新不会替换 PDF Canvas 或正文页面。
 * @param container 目标滚动容器。
 * @param warnings 当前解析或翻译告警。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderDocumentWarnings(container: HTMLElement, warnings: readonly DocumentWarning[] = []): void {
  container.querySelector(':scope > .document-warning-list')?.remove()
  if (warnings.length === 0) return
  const notice = document.createElement('aside')
  notice.className = 'document-warning-list'
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  for (const warning of warnings) {
    const item = document.createElement('p')
    item.className = 'document-warning-item'
    item.dataset.severity = warning.severity
    item.textContent = localizeDocumentWarning(warning)
    notice.append(item)
  }
  const previewHost = container.querySelector<HTMLElement>(':scope > .document-preview-host')
  if (previewHost) previewHost.after(notice)
  else container.append(notice)
}

/**
 * 原位更新文本区块中的 run；run 结构不兼容时返回失败并交由上层整块或整页回退。
 * @param element 已渲染的文本区块。
 * @param block 最新文本区块模型。
 * @param side 当前渲染侧。
 * @returns 是否已原位更新成功。
 * @author zhenghq
 */
function patchTranslationTextBlock(
  element: HTMLElement,
  block: DocumentTextBlock,
  side: DocumentRenderSide
): boolean {
  if (side !== 'translation') return false
  if (block.toc) {
    const title = element.querySelector<HTMLElement>(':scope > .document-toc-title')
    const pageNumber = element.querySelector<HTMLElement>(':scope > .document-toc-page')
    if (!title || !pageNumber) return false
    const titleRun = block.runs.find((run) => run.protected !== true)
    title.dataset.runId = titleRun?.runId ?? `${block.blockId}-toc-title`
    const titleText = block.runs
      .filter((run) => run.protected !== true)
      .map((run) => run.text)
      .join('')
    if (title.textContent !== titleText) title.textContent = titleText
    applyScalableTextStyle(title, titleRun ? effectiveTextStyle(block, titleRun) : block.style)
    if (pageNumber.textContent !== block.toc.pageNumber) {
      pageNumber.textContent = block.toc.pageNumber
    }
    return true
  }
  const existingRuns = Array.from(element.querySelectorAll<HTMLElement>('.document-text-run'))
  if (existingRuns.length !== block.runs.length) return false
  for (let index = 0; index < block.runs.length; index += 1) {
    const run = block.runs[index]!
    const existingRun = existingRuns[index]!
    if (existingRun.dataset.runId !== run.runId) return false
    if (existingRun.textContent !== run.text) existingRun.textContent = run.text
    applyScalableTextStyle(existingRun, effectiveTextStyle(block, run))
  }
  return true
}

/**
 * 原位更新图片 OCR 覆盖层；底图节点与资源 URL 保持不变，只替换覆盖层内容。
 * @param element 已渲染的图片区块。
 * @param block 最新图片区块模型。
 * @returns 是否已原位更新成功。
 * @author zhenghq
 */
function patchTranslationOcrLayer(
  element: HTMLElement,
  block: DocumentImageBlock
): boolean {
  if (!element.classList.contains('document-image-block')) return false
  const renderPending = element.dataset.pending === 'true'
  if (renderPending !== Boolean(block.renderPending)) return false
  const image = element.querySelector<HTMLImageElement>(':scope > img.document-page-image')
  if (!block.renderPending && !image) return false
  if (image) image.alt = block.alt ?? ''
  const existingLayer = element.querySelector<HTMLElement>(':scope > .document-ocr-translation-layer')
  const signature = ocrTranslationLayerSignature(block)
  if (!signature) {
    existingLayer?.remove()
    delete element.dataset.ocrTranslation
    return true
  }
  if (existingLayer?.dataset.ocrTranslationSignature === signature) return true
  const nextLayer = createOcrTranslationLayer(block)
  if (nextLayer) {
    if (existingLayer) existingLayer.replaceWith(nextLayer)
    else element.append(nextLayer)
    element.dataset.ocrTranslation = 'true'
  } else {
    existingLayer?.remove()
    delete element.dataset.ocrTranslation
  }
  return true
}

/**
 * 校验并原位更新表格内的单元格文本，避免流式译文触发整表重绘。
 * @param element 已渲染的表格区块。
 * @param block 最新表格区块模型。
 * @param takeBlockElement 按 DOM 顺序取得区块元素。
 * @returns 是否已原位更新成功。
 * @author zhenghq
 */
function patchTranslationTableBlock(
  element: HTMLElement,
  block: DocumentTableBlock,
  takeBlockElement: (blockId: string) => HTMLElement | undefined
): boolean {
  if (!element.classList.contains('document-table-block')) return false
  const table = element.querySelector<HTMLTableElement>(':scope > table')
  if (!table || table.rows.length !== block.rows.length) return false
  const headerRowCount = Math.max(0, Math.min(block.headerRows ?? 0, block.rows.length))
  for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
    const row = block.rows[rowIndex]!
    const tableRow = table.rows[rowIndex]!
    if (tableRow.cells.length !== row.cells.length) return false
    for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
      const cell = row.cells[cellIndex]!
      const tableCell = tableRow.cells[cellIndex]!
      if (tableCell.colSpan !== Math.max(1, cell.colSpan) ||
        tableCell.rowSpan !== Math.max(1, cell.rowSpan) ||
        (rowIndex < headerRowCount ? tableCell.tagName !== 'TH' : tableCell.tagName !== 'TD')) {
        return false
      }
      const renderedBlocks = Array.from(tableCell.children)
      if (renderedBlocks.length !== cell.blocks.length) return false
      for (let blockIndex = 0; blockIndex < cell.blocks.length; blockIndex += 1) {
        const child = cell.blocks[blockIndex]!
        const renderedBlock = child.kind === 'break'
          ? renderedBlocks[blockIndex]
          : takeBlockElement(child.blockId)
        if (!(renderedBlock instanceof HTMLElement) ||
          !patchTranslationBlock(child, renderedBlock, takeBlockElement)) {
          return false
        }
      }
    }
  }
  return true
}

/**
 * 按区块类型原位更新译文；结构不兼容时返回失败。
 * @param block 最新区块模型。
 * @param element 已渲染区块元素；分隔符没有稳定 DOM 标识时为 undefined。
 * @param takeBlockElement 按 DOM 顺序取得区块元素。
 * @returns 是否已原位更新成功。
 * @author zhenghq
 */
function patchTranslationBlock(
  block: DocumentBlock,
  element: HTMLElement | undefined,
  takeBlockElement: (blockId: string) => HTMLElement | undefined
): boolean {
  if (block.kind === 'break') return true
  if (!element) return false
  switch (block.kind) {
    case 'text':
      return patchTranslationTextBlock(element, block, 'translation')
    case 'image':
      return patchTranslationOcrLayer(element, block)
    case 'table':
      return patchTranslationTableBlock(element, block, takeBlockElement)
    case 'formula':
      return element.classList.contains('document-formula-block')
    case 'shape':
      return element.classList.contains('document-shape-block')
  }
}

/**
 * 收集模型中会生成 data-block-id 的区块标识；显式分页标记没有对应标识。
 * @param block 当前区块模型。
 * @param blockIds 收集结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function collectDocumentBlockIds(block: DocumentBlock, blockIds: string[]): void {
  if (block.kind === 'break') return
  blockIds.push(block.blockId)
  if (block.kind !== 'table') return
  for (const row of block.rows) {
    for (const cell of row.cells) {
      for (const child of cell.blocks) collectDocumentBlockIds(child, blockIds)
    }
  }
}

/**
 * 在现有译文 DOM 上原位更新流式内容；只有结构变化时才返回失败并允许整页重绘。
 * @param container 译文滚动容器。
 * @param model 最新译文模型。
 * @returns 是否已原位更新成功。
 * @author zhenghq
 */
function patchTranslationPreview(container: HTMLElement, model: DocumentModel | undefined): boolean {
  if (!model || renderedTranslationPreviewKind === null) return false
  const previewHost = container.querySelector<HTMLElement>(':scope > .document-preview-host')
  if (!previewHost) return false
  const kind = resolvePreviewKind(model, 'translation')
  if (kind !== renderedTranslationPreviewKind || previewHost.dataset.previewKind !== kind) return false

  const existingElements = Array.from(
    previewHost.querySelectorAll<HTMLElement>('[data-block-id]')
  )
  const elementsById = new Map<string, HTMLElement[]>()
  for (const element of existingElements) {
    const blockId = element.dataset.blockId
    if (!blockId) continue
    const matches = elementsById.get(blockId) ?? []
    matches.push(element)
    elementsById.set(blockId, matches)
  }
  let consumedElementCount = 0
  const takeBlockElement = (blockId: string): HTMLElement | undefined => {
    const element = elementsById.get(blockId)?.shift()
    if (element) consumedElementCount += 1
    return element
  }
  const expectedBlockIds: string[] = []
  for (const page of model.pages) {
    for (const block of page.blocks) {
      collectDocumentBlockIds(block, expectedBlockIds)
      if (!patchTranslationBlock(block, block.kind === 'break' ? undefined : takeBlockElement(block.blockId), takeBlockElement)) {
        return false
      }
    }
  }
  if (consumedElementCount !== existingElements.length ||
    expectedBlockIds.length !== existingElements.length) {
    return false
  }
  scheduleTranslationPageLayout()
  return true
}

/**
 * 渲染一个文档模型到指定栏；没有模型时展示等待提示。
 * @param container 目标滚动容器。
 * @param model 文档模型。
 * @param emptyKey 空状态词条。
 * @param side 当前渲染侧。
 * @param warnings 当前文档解析与翻译告警。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderDocumentModel(
  container: HTMLElement,
  model: DocumentModel | undefined,
  emptyKey: string,
  side: DocumentRenderSide,
  warnings: readonly DocumentWarning[] = []
): void {
  pageScaleObserver?.disconnect()
  pageScaleObserver = null
  activePageLayoutScheduler = null
  if (pageLayoutFrame !== null) {
    cancelAnimationFrame(pageLayoutFrame)
    pageLayoutFrame = null
  }
  pdfPreviewCleanups.get(container)?.()
  // 仅替换译文侧时清理旧水印观察器；原文重绘不能中断仍然保留的译文水印。
  if (container === translationContent) {
    watermarkResizeObserver?.disconnect()
    watermarkResizeObserver = null
  }
  const previousContent = document.createDocumentFragment()
  previousContent.append(...container.childNodes)
  if (!model) {
    const empty = document.createElement('p')
    empty.className = 'document-empty-state'
    empty.textContent = t(emptyKey)
    container.replaceChildren(empty)
    if (container === translationContent) renderedTranslationPreviewKind = null
    renderDocumentWarnings(container, warnings)
    return
  }
  try {
    const kind = resolvePreviewKind(model, side)
    const nextContent = document.createDocumentFragment()
    const previewHost = document.createElement('div')
    previewHost.className = 'document-preview-host'
    previewHost.dataset.previewKind = kind
    nextContent.append(previewHost)
    if (side === 'source' && model.source.format === 'html') {
      renderHtmlSourcePreview(previewHost, model)
    } else if (kind === 'paged') {
      if (model.source.format === 'pdf' && side === 'source') {
        container.dataset.previewKind = kind
        // PDF.js 异步渲染要求宿主已连接；此时只挂载空宿主，PDF 数据仍由旧内容保留到加载完成。
        container.replaceChildren(previewHost)
        void renderPdfPages(previewHost, generation)
      } else {
        for (const page of model.pages) previewHost.append(renderPage(page, side))
      }
    } else if (kind === 'markdown') {
      renderMarkdownDocument(previewHost, model, side)
    } else if (kind === 'table') {
      renderTableDocument(previewHost, model, side)
    } else if (kind === 'subtitle') {
      renderSubtitleDocument(previewHost, model, side)
    } else {
      renderFlowDocument(previewHost, model, side)
    }
    appendTranslationWatermark(previewHost, side)
    container.dataset.previewKind = kind
    if (previewHost.parentNode !== container) container.replaceChildren(nextContent)
    if (side === 'translation') renderedTranslationPreviewKind = kind
    if (side === 'translation' && (kind === 'paged' || model.source.format === 'html')) {
      observeTranslationPageScale(previewHost)
    }
    renderDocumentWarnings(container, warnings)
  } catch (error) {
    console.error('Failed to render document model', error)
    if (side === 'translation') renderedTranslationPreviewKind = null
    container.replaceChildren(previousContent)
    const failedContent = document.createDocumentFragment()
    const failed = document.createElement('p')
    failed.className = 'document-empty-state'
    failed.textContent = t('document.renderFailed')
    failedContent.append(failed)
    container.replaceChildren(failedContent)
  }
}

/**
 * 同步左右两栏滚动比例，并用递归保护避免互相触发。
 * @param source 主动滚动的容器。
 * @param target 需要跟随的容器。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncScroll(source: HTMLElement, target: HTMLElement): void {
  if (syncingScroll) return
  const sourceRange = source.scrollHeight - source.clientHeight
  const targetRange = target.scrollHeight - target.clientHeight
  if (sourceRange <= 0 || targetRange <= 0) return
  syncingScroll = true
  target.scrollTop = (source.scrollTop / sourceRange) * targetRange
  requestAnimationFrame(() => { syncingScroll = false })
}

/**
 * 计算文档模型的内容签名，用于区分仅进度变化与正文实际变化。
 * @param model 文档模型。
 * @returns 稳定内容签名；模型不存在时返回空字符串。
 * @author zhenghq
 */
function documentContentSignature(model: DocumentModel | undefined): string {
  if (!model) return ''
  return JSON.stringify({
    documentId: model.documentId,
    pages: model.pages.map((page) => ({
      pageId: page.pageId,
      width: page.width,
      height: page.height,
      background: page.background,
      contentArea: page.contentArea,
      blocks: page.blocks.map((block) => {
        if (block.kind === 'text') {
          return {
            kind: block.kind,
            blockId: block.blockId,
            bbox: block.bbox,
            style: block.style,
            textAlign: block.textAlign,
            role: block.role,
            toc: block.toc,
            runs: block.runs.map((run) => ({
              runId: run.runId,
              text: run.text,
              style: run.style,
              protected: run.protected
            }))
          }
        }
        if (block.kind === 'image') {
          return {
            kind: block.kind,
            blockId: block.blockId,
            bbox: block.bbox,
            assetId: block.assetId,
            renderPending: block.renderPending,
            ocrRegions: block.ocrRegions?.map((region) => ({
              regionId: region.regionId,
              bbox: region.bbox,
              text: region.text,
              translatedText: region.translatedText,
              style: region.style,
              textAlign: region.textAlign,
              status: region.status,
              reason: region.reason
            }))
          }
        }
        return block
      })
    }))
  })
}

/**
 * 计算源预览身份；PDF 与 HTML 使用文件指纹，译文流式更新时不会触发原生预览重载。
 * @param model 当前源文档模型。
 * @returns 稳定的预览身份。
 * @author zhenghq
 */
function documentPreviewIdentity(model: DocumentModel | undefined): string {
  if (!model) return ''
  if (model.source.format === 'pdf') {
    return `pdf:${model.source.sha256}`
  }
  if (model.source.format === 'html') {
    return `html:${model.source.sha256}`
  }
  return documentContentSignature(model)
}

/**
 * 计算告警签名；仅告警内容变化时更新独立告警层。
 * @param warnings 当前告警列表。
 * @returns 稳定告警签名。
 * @author zhenghq
 */
function documentWarningSignature(warnings: readonly DocumentWarning[] = []): string {
  return JSON.stringify(warnings.map((warning) => ({
    code: warning.code,
    severity: warning.severity,
    message: warning.message,
    pageId: warning.pageId,
    blockId: warning.blockId
  })))
}

/**
 * 仅在正文模型实际变化时释放并重建当前文档页面 DOM。
 * @param snapshot 当前任务快照。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderSnapshot(snapshot: DocumentWorkspaceSnapshot): void {
  const sourcePreviewIdentity = documentPreviewIdentity(snapshot.source)
  const translationSignature = documentContentSignature(snapshot.translation)
  const sourceWarningSignature = documentWarningSignature(snapshot.source?.warnings)
  const translationWarningSignature = documentWarningSignature(snapshot.translation?.warnings)
  const sourceChanged = renderedSourcePreviewIdentity !== sourcePreviewIdentity
  const sourceWarningsChanged = renderedSourceWarningSignature !== sourceWarningSignature
  const translationChanged = !hasRenderedTranslation ||
    renderedTranslationSignature !== translationSignature
  const translationWarningsChanged = renderedTranslationWarningSignature !== translationWarningSignature
  // 只有源文件身份变化才释放图片资源；译文流式增量不能破坏仍在使用的源预览。
  if (sourceChanged) revokeAssetUrls()
  if (sourceChanged) {
    renderDocumentModel(
      sourceContent,
      snapshot.source,
      'document.waitingSource',
      'source',
      snapshot.source?.warnings
    )
    renderedSourcePreviewIdentity = sourcePreviewIdentity
    renderedSourceWarningSignature = sourceWarningSignature
  } else if (sourceWarningsChanged) {
    renderDocumentWarnings(sourceContent, snapshot.source?.warnings)
    renderedSourceWarningSignature = sourceWarningSignature
  }
  if (translationChanged) {
    const patched = hasRenderedTranslation &&
      patchTranslationPreview(translationContent, snapshot.translation)
    if (!patched) {
      renderDocumentModel(
        translationContent,
        snapshot.translation,
        'document.waitingTranslation',
        'translation',
        snapshot.translation?.warnings
      )
    }
    renderedTranslationSignature = translationSignature
    hasRenderedTranslation = true
    renderedTranslationWarningSignature = translationWarningSignature
  } else if (translationWarningsChanged) {
    renderDocumentWarnings(translationContent, snapshot.translation?.warnings)
    renderedTranslationWarningSignature = translationWarningSignature
  }
  sourcePageCount.textContent = snapshot.source
    ? t('document.pageCount', { count: snapshot.source.pages.length })
    : ''
  translationPageCount.textContent = snapshot.translation
    ? t('document.pageCount', { count: snapshot.translation.pages.length })
    : ''
}

/**
 * 更新进度、任务状态和操作按钮。
 * @param snapshot 当前任务快照。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderTaskState(snapshot: DocumentWorkspaceSnapshot): void {
  const status = snapshot.task.status
  const stageKeys: Record<string, string> = {
    validating: 'document.progress.preparing',
    parsing: 'document.progress.parsing',
    ocr: 'document.progress.ocr',
    translating: 'document.progress.translating',
    rendering: 'document.progress.composing',
    exporting: 'document.progress.exporting',
    completed: 'document.progress.completed',
    partial: 'document.partial',
    cancelled: 'document.progress.cancelled',
    failed: 'document.progress.failed'
  }
  progressStage.textContent = t(stageKeys[status] ?? 'document.progress.preparing')
  const percent = Math.max(0, Math.min(100, Math.round(snapshot.percent)))
  progressbar.setAttribute('aria-valuenow', String(percent))
  progressbar.style.width = `${percent}%`
  progressCount.textContent = snapshot.task.progress.total > 0
    ? `${snapshot.task.progress.completed} / ${snapshot.task.progress.total} · ${percent}%`
    : `${percent}%`
  const terminal = ['completed', 'partial', 'cancelled', 'failed'].includes(status)
  cancelButton.hidden = terminal
  exportButton.disabled = status !== 'completed' && status !== 'partial'
  // 只有部分完成终态允许重试，避免重试期间沿用上一轮失败数而重复提交。
  retryButton.disabled = status !== 'partial' || snapshot.task.phaseCompleted ||
    (snapshot.retryableFailedBlocks ?? 0) <= 0
  partialStatus.hidden = status !== 'partial' && status !== 'failed' && status !== 'cancelled'
  if (status === 'partial') {
    partialStatus.textContent = t('document.partialSummary', {
      failed: snapshot.task.failedBlocks,
      warnings: snapshot.task.warningCount
    })
  } else if (status === 'failed') {
    partialStatus.textContent = t('document.run.failed')
  } else if (status === 'cancelled') {
    partialStatus.textContent = t('document.cancelled')
  }
  workbench.dataset.state = status
}

/**
 * 在下一帧合并快照重绘，避免高频进度事件反复重建大文档 DOM。
 * @param snapshot 最新任务快照。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleSnapshotRender(snapshot: DocumentWorkspaceSnapshot): void {
  latestSnapshot = snapshot
  if (pendingRenderFrame !== null) return
  pendingRenderFrame = requestAnimationFrame(() => {
    pendingRenderFrame = null
    if (!latestSnapshot || !isCurrentSnapshot(latestSnapshot)) return
    renderSnapshot(latestSnapshot)
    renderTaskState(latestSnapshot)
  })
}

/**
 * 立即渲染指定快照，并取消尚未执行的合并帧，避免终态或导出时沿用旧的流式部分译文。
 * @param snapshot 需要立即落到界面的最新任务快照。
 * @returns 无返回值。
 * @author zhenghq
 */
function flushSnapshotRender(snapshot: DocumentWorkspaceSnapshot): void {
  if (pendingRenderFrame !== null) {
    cancelAnimationFrame(pendingRenderFrame)
    pendingRenderFrame = null
  }
  latestSnapshot = snapshot
  renderSnapshot(snapshot)
  renderTaskState(snapshot)
}

/**
 * 判断事件是否属于当前任务，隔离旧任务或旧窗口的迟到事件。
 * @param snapshot 收到的任务快照。
 * @returns 是否属于当前任务。
 * @author zhenghq
 */
function isCurrentSnapshot(snapshot: DocumentWorkspaceSnapshot): boolean {
  if (snapshot.generation !== generation) return false
  if (expectedJobId !== null && snapshot.jobId !== expectedJobId) return false
  // run() 返回前可能收到首条进度事件；此时只接收事件，不提前绑定任务标识。
  return activeJobId === null || snapshot.jobId === activeJobId
}

/**
 * 启动当前已批准文件的翻译任务。
 * @returns 无返回值。
 * @author zhenghq
 */
async function startDocumentTranslation(): Promise<void> {
  if (!selectionState.path || !platformCapability?.supported) return
  if (documentStartInFlight) {
    pendingLanguageRetranslation = true
    return
  }
  // 先消费待重译标记再启动，确保本次启动期间再次切换语言时仍能留下新的待处理标记。
  pendingLanguageRetranslation = false
  documentStartInFlight = true
  // 先递增并取得本次任务代际，主进程要求代际严格大于上一任务；
  // 若发送递增前的旧值，首次运行或窗口重载后都会被判定为 generation-conflict。
  let jobGeneration = nextGeneration()
  const selectedPath = selectionState.path
  // 记录本次任务实际提交的语言组合，避免启动前切换过语言时误判为无需重译。
  appliedLanguagePair = `${sourceLanguageSelect.value}\u0000${targetLanguageSelect.value}`
  activeJobId = null
  expectedJobId = null
  latestSnapshot = null
  renderedSourcePreviewIdentity = ''
  renderedSourceWarningSignature = ''
  renderedTranslationSignature = ''
  renderedTranslationPreviewKind = null
  hasRenderedTranslation = false
  renderedTranslationWarningSignature = ''
  revokeAssetUrls()
  pdfPreviewCleanups.get(sourceContent)?.()
  pdfPreviewCleanups.get(translationContent)?.()
  uploadPanel.hidden = true
  workbench.hidden = false
  workbenchName.textContent = selectionState.name
  workbenchMeta.textContent = `${selectionState.format.toUpperCase()} · ${formatFileSize(selectionState.size)}`
  sourceContent.replaceChildren()
  translationContent.replaceChildren()
  progressStage.textContent = t('document.progress.preparing')
  progressCount.textContent = t('document.progress.pending')
  progressbar.setAttribute('aria-valuenow', '0')
  progressbar.style.width = '0%'
  cancelButton.hidden = false
  exportButton.disabled = true
  retryButton.disabled = true
  partialStatus.hidden = true
  startButton.disabled = true
  try {
    let result: DocumentRunResult = await window.api.runDocument({
      path: selectedPath,
      generation: jobGeneration,
      sourceLang: sourceLanguageSelect.value,
      targetLang: targetLanguageSelect.value
    })
    if (generation !== jobGeneration) return
    // 只有尚未绑定任务标识且未收到当前任务进度时才允许重试；
    // 同一 Renderer 的并发启动会返回 busy，不能被误当成可重试的冲突。
    if (!result.accepted && result.code === 'generation-conflict' && expectedJobId === null &&
      latestSnapshot === null &&
      adoptSuggestedGeneration(result.suggestedGeneration)) {
      jobGeneration = generation
      result = await window.api.runDocument({
        path: selectedPath,
        generation: jobGeneration,
        sourceLang: sourceLanguageSelect.value,
        targetLang: targetLanguageSelect.value
      })
    }
    if (generation !== jobGeneration) return
    if (!result.accepted || !result.jobId) {
      progressStage.textContent = t('document.run.failed')
      progressCount.textContent = t('document.run.failedCode', { code: result.code ?? 'run-failed' })
      cancelButton.hidden = true
      startButton.disabled = false
      return
    }
    expectedJobId = result.jobId
    activeJobId = result.jobId
    const pendingSnapshot = latestSnapshot as DocumentWorkspaceSnapshot | null
    if (pendingSnapshot?.jobId === result.jobId) scheduleSnapshotRender(pendingSnapshot)
  } catch {
    if (generation !== jobGeneration) return
    progressStage.textContent = t('document.run.failed')
    cancelButton.hidden = true
    startButton.disabled = false
  } finally {
    documentStartInFlight = false
    if (pendingLanguageRetranslation) {
      void retranslateDocumentAfterLanguageChange()
    }
  }
}

/**
 * 请求取消当前任务并立即禁用重复取消。
 * @returns 无返回值。
 * @author zhenghq
 */
async function cancelDocumentTranslation(): Promise<void> {
  if (!activeJobId) return
  cancelButton.disabled = true
  try {
    await window.api.cancelDocument(activeJobId, generation)
  } finally {
    cancelButton.disabled = false
  }
}

/**
 * 仅重新翻译当前文档中失败的目标，不清空已有译文或重新解析源文件。
 * @returns 无返回值。
 * @author zhenghq
 */
async function retryFailedDocumentTranslation(): Promise<void> {
  if (!latestSnapshot?.translation || latestSnapshot.task.status !== 'partial' ||
    (latestSnapshot.retryableFailedBlocks ?? 0) <= 0) return
  const jobGeneration = nextGeneration()
  retryButton.disabled = true
  cancelButton.hidden = false
  exportButton.disabled = true
  partialStatus.hidden = false
  partialStatus.textContent = t('document.retryStarted')
  progressStage.textContent = t('document.progress.translating')
  progressCount.textContent = t('document.progress.pending')
  try {
    const result = await window.api.retryFailedDocument(jobGeneration)
    if (generation !== jobGeneration) return
    if (!result.accepted) {
      partialStatus.textContent = result.code === 'no-retryable-failures'
        ? t('document.progress.completed')
        : t('document.run.failedCode', { code: result.code ?? 'retry-failed' })
      retryButton.disabled = true
      cancelButton.hidden = true
      // 重试请求被拒绝时仍停留在原来的部分完成快照，应恢复已有译文的导出能力。
      exportButton.disabled = false
    }
  } catch {
    if (generation !== jobGeneration) return
    partialStatus.textContent = t('document.run.failed')
    retryButton.disabled = false
    cancelButton.hidden = true
    exportButton.disabled = false
  }
}

/**
 * 将当前译文导出为 PDF，并把稳定结果映射为界面提示。
 * @returns 无返回值。
 * @author zhenghq
 */
async function exportTranslatedPdf(): Promise<void> {
  if (!latestSnapshot?.translation) return
  // 打印直接读取当前 DOM；先同步最新终态，避免保存对话框打开前仍显示流式部分译文。
  flushSnapshotRender(latestSnapshot)
  exportButton.disabled = true
  try {
    const result: DocumentExportResult = await window.api.exportDocumentPdf()
    if (result.status === 'saved') {
      partialStatus.textContent = result.warnings && result.warnings.length > 0
        ? `${t('document.export.saved')} ${result.warnings.map(localizeDocumentWarning).join(' ')}`
        : t('document.export.saved')
    }
    else if (result.status === 'cancelled') partialStatus.textContent = t('document.export.cancelled')
    else {
      partialStatus.textContent = result.code === 'font-missing'
        ? t('document.fontMissing')
        : t('document.export.failed')
    }
    partialStatus.hidden = false
  } catch {
    partialStatus.textContent = t('document.export.failed')
    partialStatus.hidden = false
  } finally {
    exportButton.disabled = latestSnapshot?.task.status !== 'completed' &&
      latestSnapshot?.task.status !== 'partial'
  }
}

/**
 * 根据窗口最大化状态更新标题栏按钮。
 * @param maximized 当前窗口是否已最大化。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderWindowMaximizedState(maximized: boolean): void {
  const label = maximized ? t('document.restoreWindow') : t('document.maximizeWindow')
  windowMaximizeButton.ariaLabel = label
  windowMaximizeButton.title = label
  windowMaximizeButton.dataset.maximized = String(maximized)
  windowMaximizeButton.innerHTML = maximized
    ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5h7v7H5z" /><path d="M3 11V3h8" /></svg>'
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" /></svg>'
}

/**
 * 初始化自绘标题栏窗口控制。
 * @returns 无返回值。
 * @author zhenghq
 */
async function initializeWindowTitlebar(): Promise<void> {
  windowMinimizeButton.addEventListener('click', () => window.api.windowMinimize())
  windowMaximizeButton.addEventListener('click', () => window.api.windowToggleMaximize())
  windowCloseButton.addEventListener('click', () => window.api.windowClose())
  titlebar.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement).closest('.window-controls')) return
    window.api.windowToggleMaximize()
  })
  window.api.onWindowMaximizedChanged(renderWindowMaximizedState)
  renderWindowMaximizedState(await window.api.windowIsMaximized())
}

/**
 * 根据平台能力禁用文档入口并显示原因。
 * @returns 无返回值。
 * @author zhenghq
 */
async function initializePlatformCapability(): Promise<void> {
  try {
    platformCapability = await window.api.getDocumentPlatformCapability()
  } catch {
    platformCapability = { supported: false, reason: 'unsupported-platform' }
  }
  dropZone.tabIndex = platformCapability.supported ? 0 : -1
  dropZone.setAttribute('aria-disabled', String(!platformCapability.supported))
  renderSelectionState()
}

/**
 * 初始化上传交互、拖放、键盘操作与窗口控制。
 * @returns 无返回值。
 * @author zhenghq
 */
async function initializeDocumentWorkspace(): Promise<void> {
  await initializeWindowTitlebar()
  await initializePlatformCapability()
  await initializeDocumentLanguages()

  dropZone.addEventListener('click', () => void chooseDocumentFile())
  dropZone.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void chooseDocumentFile()
  })
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    dropZone.dataset.dragging = 'true'
  })
  dropZone.addEventListener('dragleave', (event) => {
    if (event.relatedTarget && dropZone.contains(event.relatedTarget as Node)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) dropZone.dataset.dragging = 'false'
  })
  dropZone.addEventListener('dragenter', (event) => {
    event.preventDefault()
    dragDepth += 1
    dropZone.dataset.dragging = 'true'
  })
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault()
    dragDepth = 0
    dropZone.dataset.dragging = 'false'
    const file = event.dataTransfer?.files[0]
    if (file) void inspectBrowserFile(file)
  })
  documentFileInput.addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (file) void inspectBrowserFile(file)
    input.value = ''
  })
  fileReplaceButton.addEventListener('click', () => documentFileInput.click())
  documentWorkbenchReplaceButton.addEventListener('click', () => void replaceDocumentFromWorkbench())
  startButton.addEventListener('click', () => void startDocumentTranslation())
  cancelButton.addEventListener('click', () => void cancelDocumentTranslation())
  exportButton.addEventListener('click', () => void exportTranslatedPdf())
  retryButton.addEventListener('click', () => void retryFailedDocumentTranslation())
  sourceLanguageSelect.addEventListener('change', () => void retranslateDocumentAfterLanguageChange())
  targetLanguageSelect.addEventListener('change', () => void retranslateDocumentAfterLanguageChange())
  window.api.onDocumentProgress((snapshot) => {
    if (!isCurrentSnapshot(snapshot)) return
    scheduleSnapshotRender(snapshot)
  })
  window.api.onDocumentCompleted((snapshot) => {
    if (!isCurrentSnapshot(snapshot)) return
    // 终态必须绕过 rAF 合并立即落盘，确保最终译文覆盖最后一条流式部分译文。
    flushSnapshotRender(snapshot)
    startButton.disabled = false
  })
  sourceContent.addEventListener('scroll', () => syncScroll(sourceContent, translationContent))
  translationContent.addEventListener('scroll', () => syncScroll(translationContent, sourceContent))
  historyButton.addEventListener('click', () => {
    uploadStatus.textContent = t('document.historyEmpty')
  })
  localeRuntime.onLocaleChanged(() => {
    renderSelectionState()
    if (currentSettings) {
      populateDocumentLanguages(currentSettings, sourceLanguageSelect.value, targetLanguageSelect.value)
    }
    renderWindowMaximizedState(windowMaximizeButton.dataset.maximized === 'true')
    if (latestSnapshot) {
      renderedSourcePreviewIdentity = ''
      renderedSourceWarningSignature = ''
      renderedTranslationSignature = ''
      renderedTranslationPreviewKind = null
      hasRenderedTranslation = false
      renderedTranslationWarningSignature = ''
      renderSnapshot(latestSnapshot)
      renderTaskState(latestSnapshot)
    }
  })
}

void initializeDocumentWorkspace()
