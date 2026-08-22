import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { OcrEngineError, type OcrEngine, type OcrRecognizeInput, type OcrRecognizeResult } from '../shared/ocrEngine'
import { joinOcrLines } from '../shared/ocrEngine'
import type { OcrTextLine } from '../shared/types'

/** 系统 OCR 可注入依赖，方便单元测试替换 execFile/writeFile。 */
export interface SystemOcrDeps {
  /** 运行平台标识。 */
  platform: NodeJS.Platform
  /**
   * 执行外部命令，返回 stdout/stderr 字符串。
   * @param executable 可执行文件路径或名称。
   * @param args 参数列表。
   * @param options 超时等选项。
   * @returns stdout 与 stderr。
   */
  execFile(
    executable: string,
    args: string[],
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<{ stdout: string; stderr: string }>
  /**
   * 写文件到磁盘。
   * @param path 目标路径。
   * @param data 内容。
   */
  writeFile(path: string, data: string | Buffer): Promise<void>
  /**
   * 返回系统临时目录。
   * @returns 临时目录路径。
   */
  tmpDir(): string
  /** macOS Vision OCR helper 可执行文件路径。 */
  visionHelperPath?: string
  /**
   * 判断文件是否存在。
   * @param path 文件路径。
   * @returns 文件是否存在。
   */
  fileExists?(path: string): boolean
}

/**
 * 将 OCR 语言偏好映射为 macOS Vision 语言标签列表。
 * auto 时返回空数组（Vision 自动检测）。
 * @param language 语言偏好字符串。
 * @returns Vision 语言标签数组。
 * @author zhenghq
 */
function toVisionLanguages(language: string): string[] {
  if (!language || language === 'auto') {
    return ['zh-Hans', 'zh-Hant', 'en-US', 'ja-JP', 'ko-KR']
  }
  const map: Record<string, string[]> = {
    'zh': ['zh-Hans', 'zh-Hant'],
    'zh-hans': ['zh-Hans'],
    'zh-hant': ['zh-Hant'],
    'en': ['en-US'],
    'ja': ['ja-JP'],
    'ko': ['ko-KR'],
    'fr': ['fr-FR'],
    'de': ['de-DE'],
    'es': ['es-ES'],
    'pt': ['pt-BR'],
    'ru': ['ru-RU'],
    'ar': ['ar-SA'],
  }
  const key = language.toLowerCase()
  return map[key] ?? [language]
}

/**
 * 生成用于 osascript 执行的内联 Swift 脚本，调用 Vision VNRecognizeTextRequest 识别图片文字。
 * 每行识别结果单独一行输出到 stdout。
 * @param imagePath 图片本地路径（PNG/JPEG）。
 * @param language 语言偏好，'auto' 时由 Vision 自动判断。
 * @returns Swift 脚本字符串。
 * @author zhenghq
 */
export function buildVisionOcrScript(imagePath: string, language: string): string {
  const langs = toVisionLanguages(language)
  const langsLiteral = langs.length > 0
    ? `["${langs.join('", "')}"]`
    : '[]'

  // 使用内联 Swift via `osascript -l Swift`，调用 Vision 框架离线识别
  return `
import Vision
import Foundation

let imagePath = "${imagePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
let fileURL = URL(fileURLWithPath: imagePath)

guard let ciImage = CIImage(contentsOf: fileURL) else {
  fputs("error: cannot load image\\n", stderr)
  exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
let langs: [String] = ${langsLiteral}
if !langs.isEmpty {
  request.recognitionLanguages = langs
}

let handler = VNImageRequestHandler(ciImage: ciImage, options: [:])
try? handler.perform([request])

if let results = request.results {
  for observation in results {
    if let candidate = observation.topCandidates(1).first {
      let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty {
        print(text)
      }
    }
  }
}
`.trim()
}

/**
 * 解析 Vision OCR 脚本的 stdout 输出，每行映射为一个 OcrTextLine。
 * 空行和仅空白行自动过滤。
 * @param output osascript 的 stdout 字符串。
 * @returns 文本行数组。
 * @author zhenghq
 */
export function parseVisionOcrOutput(output: string): OcrTextLine[] {
  if (!output || !output.trim()) return []
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ text }))
}

/**
 * 将 OCR 语言偏好映射为 Windows PowerShell 脚本可接受的语言标签。
 * @param language 语言偏好字符串。
 * @returns Windows BCP-47 语言标签或 'auto'。
 * @author zhenghq
 */
export function windowsOcrLanguageTag(language: string): string {
  if (!language || language === 'auto') return 'auto'
  const map: Record<string, string> = {
    'zh': 'zh-Hans-CN',
    'zh-hans': 'zh-Hans-CN',
    'zh-hant': 'zh-Hant-TW',
    'en': 'en-US',
    'ja': 'ja-JP',
    'ko': 'ko-KR',
    'fr': 'fr-FR',
    'de': 'de-DE',
    'es': 'es-ES',
    'pt': 'pt-BR',
    'ru': 'ru-RU',
  }
  return map[language.toLowerCase()] ?? language
}

/** Windows OCR 命令描述，包含可执行文件与参数列表。 */
export interface WindowsOcrCommand {
  /** 可执行文件（powershell.exe）。 */
  executable: string
  /** 参数列表。 */
  args: string[]
}

/**
 * 构造用于调用 win-ocr.ps1 的 PowerShell 命令参数。
 * @param imagePath 图片本地路径（PNG）。
 * @param scriptPath win-ocr.ps1 的本地路径。
 * @param language 语言偏好字符串。
 * @returns 命令描述对象。
 * @author zhenghq
 */
export function buildWindowsOcrCommand(
  imagePath: string,
  scriptPath: string,
  language: string
): WindowsOcrCommand {
  const langTag = windowsOcrLanguageTag(language)
  return {
    executable: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-ImagePath', imagePath,
      '-Language', langTag
    ]
  }
}

/** win-ocr.ps1 脚本内容（从 Lumi-translate 迁移，Apache-2.0 兼容）。 */
const WIN_OCR_SCRIPT = `param([string]$ImagePath, [string]$Language = 'auto')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

function Await-Operation($AsyncOperation, [type]$ResultType) {
  $method = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
  } | Select-Object -First 1).MakeGenericMethod($ResultType)
  $task = $method.Invoke($null, @($AsyncOperation))
  $task.Wait()
  return $task.Result
}

$file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  try {
    function New-OcrEngine([string]$Tag) {
      if (!$Tag -or $Tag -eq 'auto') {
        return [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      }
      try {
        $lang = [Windows.Globalization.Language]::new($Tag)
        return [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
      } catch {
        return $null
      }
    }

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Language -and $Language -ne 'auto') {
      $candidates.Add($Language)
      $candidates.Add('auto')
    } else {
      foreach ($tag in @('auto', 'zh-Hans-CN', 'zh-Hant-TW', 'en-US', 'ja-JP', 'ko-KR')) {
        $candidates.Add($tag)
      }
    }

    $bestText = ''
    foreach ($tag in $candidates) {
      $engine = New-OcrEngine $tag
      if ($null -eq $engine) { continue }
      $result = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $text = [string]$result.Text
      if ($text.Trim().Length -gt $bestText.Trim().Length) {
        $bestText = $text
      }
      if ($Language -and $Language -ne 'auto' -and $bestText.Trim().Length -gt 0) {
        break
      }
    }

    if ($bestText.Trim().Length -eq 0) {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      if ($null -eq $engine) { throw 'No Windows OCR language is available.' }
    }
    Write-Output $bestText
  } finally {
    if ($bitmap) { $bitmap.Dispose() }
  }
} finally {
  if ($stream) { $stream.Dispose() }
}
`

/**
 * macOS Vision OCR 引擎：通过 osascript 执行内联 Swift 调用 Vision 框架。
 * 仅在 darwin 平台可用，支持 zh-Hans 等中文离线识别。
 * @author zhenghq
 */
export class MacOsVisionOcrEngine implements OcrEngine {
  /** 引擎标识。 */
  readonly id = 'system' as const

  /** 可注入依赖，默认使用 Node.js 内置模块与 Electron 运行时。 */
  private readonly deps: SystemOcrDeps

  /** Swift OSA 组件可用性探测缓存。 */
  private availabilityCheck: Promise<boolean> | null = null

  /** 最近一次不可用原因。 */
  private unavailableReason: string | undefined

  /**
   * 创建 macOS Vision OCR 引擎。
   * @param deps 可注入依赖；生产环境省略使用默认值。
   * @author zhenghq
   */
  constructor(deps?: Partial<SystemOcrDeps>) {
    this.deps = {
      platform: process.platform,
      execFile: defaultExecFile,
      writeFile: async (path, data) => {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path, data)
      },
      tmpDir: tmpdir,
      visionHelperPath: defaultMacOsVisionHelperPath(),
      fileExists: existsSync,
      ...deps
    }
  }

  /**
   * 判断当前平台和 Vision OCR helper 是否可用。
   * @returns 是否可用。
   * @author zhenghq
   */
  async isAvailable(): Promise<boolean> {
    if (this.deps.platform !== 'darwin') return false
    if (!this.availabilityCheck) {
      const helperPath = this.resolveHelperPath()
      if (!helperPath) {
        this.unavailableReason = 'macOS Vision OCR helper 未安装'
        this.availabilityCheck = Promise.resolve(false)
      } else {
        this.availabilityCheck = this.deps.execFile(helperPath, ['--version'], { timeout: 2000 })
          .then(() => {
            this.unavailableReason = undefined
            return true
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            this.unavailableReason = `macOS Vision OCR helper 不可用: ${message}`
            return false
          })
      }
    }
    return this.availabilityCheck
  }

  /**
   * 返回 macOS system OCR 最近一次不可用原因。
   * @returns 不可用原因。
   * @author zhenghq
   */
  getUnavailableReason(): string | undefined {
    return this.unavailableReason
  }

  /**
   * 解析可用的 macOS Vision OCR helper 路径。
   * @returns helper 路径，缺失时返回 undefined。
   * @author zhenghq
   */
  private resolveHelperPath(): string | undefined {
    const helperPath = this.deps.visionHelperPath
    if (!helperPath || !this.deps.fileExists?.(helperPath)) return undefined
    return helperPath
  }

  /**
   * 使用 osascript Swift 桥调用 Vision OCR 识别图片文字。
   * @param input 识别输入（图片字节或路径）。
   * @returns 识别结果，含文本行与拼接文本。
   * @author zhenghq
   */
  async recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult> {
    if (this.deps.platform !== 'darwin') {
      throw new OcrEngineError('engine-unavailable', 'macOS Vision OCR 仅在 macOS 上可用', 'system')
    }

    const lang = input.language ?? 'auto'
    let imagePath: string
    let tempPath: string | undefined

    if (input.imageBytes && input.imageBytes.length > 0) {
      tempPath = join(
        this.deps.tmpDir(),
        `ocr-vision-${process.pid}-${Date.now()}.png`
      )
      await this.deps.writeFile(tempPath, Buffer.from(input.imageBytes))
      imagePath = tempPath
    } else if (input.imagePath) {
      imagePath = input.imagePath
    } else {
      throw new OcrEngineError('empty', 'Vision OCR 缺少图片输入', 'system')
    }

    const timeoutMs = input.timeoutMs ?? 15000
    const helperPath = this.resolveHelperPath()
    if (!helperPath) {
      this.unavailableReason = 'macOS Vision OCR helper 未安装'
      throw new OcrEngineError('engine-unavailable', 'macOS Vision OCR helper 未安装', 'system')
    }

    try {
      const { stdout, stderr } = await this.deps.execFile(
        helperPath,
        [imagePath, lang],
        { timeout: timeoutMs, signal: input.signal }
      )

      if (stderr?.toLowerCase().includes('permission')) {
        throw new OcrEngineError('permission', '屏幕录制权限缺失，请在系统设置中授权', 'system')
      }

      const lines = parseVisionOcrOutput(stdout)
      const text = joinOcrLines(lines)
      return { lines, text, engine: 'system' }
    } catch (error) {
      if (error instanceof OcrEngineError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/permission|tcc/i.test(message)) {
        throw new OcrEngineError('permission', '屏幕录制权限缺失', 'system')
      }
      if (/timeout|signal/i.test(message)) {
        throw new OcrEngineError('timeout', 'Vision OCR 超时', 'system')
      }
      const reason = `macOS Vision OCR 执行失败: ${message}`
      this.unavailableReason = reason
      throw new OcrEngineError('engine-unavailable', reason, 'system')
    }
  }
}

/**
 * Windows 系统 OCR 引擎：通过 win-ocr.ps1 调用 Windows.Media.Ocr，支持多语言包自动择优。
 * 仅在 win32 平台可用。
 * @author zhenghq
 */
export class WindowsSystemOcrEngine implements OcrEngine {
  /** 引擎标识。 */
  readonly id = 'system' as const

  /** win-ocr.ps1 在 userData 目录的缓存路径。 */
  private scriptPath: string | undefined

  /** 可注入依赖。 */
  private readonly deps: SystemOcrDeps

  /**
   * 创建 Windows 系统 OCR 引擎。
   * @param deps 可注入依赖；生产环境省略使用默认值。
   * @author zhenghq
   */
  constructor(deps?: Partial<SystemOcrDeps>) {
    this.deps = {
      platform: process.platform,
      execFile: defaultExecFile,
      writeFile: async () => undefined,
      tmpDir: tmpdir,
      ...deps
    }
  }

  /**
   * 判断当前平台是否为 Windows。
   * @returns 是否可用。
   * @author zhenghq
   */
  isAvailable(): boolean {
    return this.deps.platform === 'win32'
  }

  /**
   * 确保 win-ocr.ps1 已写入临时目录并返回其路径。
   * @returns 脚本路径。
   * @author zhenghq
   */
  private async ensureScript(): Promise<string> {
    if (this.scriptPath) return this.scriptPath
    const path = join(this.deps.tmpDir(), 'win-ocr.ps1')
    await this.deps.writeFile(path, WIN_OCR_SCRIPT)
    this.scriptPath = path
    return path
  }

  /**
   * 使用 PowerShell win-ocr.ps1 调用 Windows.Media.Ocr 识别图片文字。
   * @param input 识别输入（图片字节或路径）。
   * @returns 识别结果，含文本行与拼接文本。
   * @author zhenghq
   */
  async recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult> {
    if (!this.isAvailable()) {
      throw new OcrEngineError('engine-unavailable', 'Windows 系统 OCR 仅在 Windows 上可用', 'system')
    }

    const lang = input.language ?? 'auto'
    let imagePath: string
    let tempPath: string | undefined

    if (input.imageBytes && input.imageBytes.length > 0) {
      tempPath = join(
        this.deps.tmpDir(),
        `ocr-win-${process.pid}-${Date.now()}.png`
      )
      await this.deps.writeFile(tempPath, Buffer.from(input.imageBytes))
      imagePath = tempPath
    } else if (input.imagePath) {
      imagePath = input.imagePath
    } else {
      throw new OcrEngineError('empty', 'Windows OCR 缺少图片输入', 'system')
    }

    const scriptPath = await this.ensureScript()
    const cmd = buildWindowsOcrCommand(imagePath, scriptPath, lang)
    const timeoutMs = input.timeoutMs ?? 20000

    try {
      const { stdout, stderr } = await this.deps.execFile(
        cmd.executable,
        cmd.args,
        { timeout: timeoutMs, signal: input.signal }
      )

      if (stderr?.includes('No Windows OCR language is available')) {
        throw new OcrEngineError('engine-unavailable', 'Windows OCR 语言包未安装', 'system')
      }

      const lines = parseVisionOcrOutput(stdout) // Windows 输出同样是每行一条文本
      const text = joinOcrLines(lines)
      return { lines, text, engine: 'system' }
    } catch (error) {
      if (error instanceof OcrEngineError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/timeout/i.test(message)) {
        throw new OcrEngineError('timeout', 'Windows OCR 超时', 'system')
      }
      if (/No Windows OCR/i.test(message)) {
        throw new OcrEngineError('engine-unavailable', 'Windows OCR 语言包未安装', 'system')
      }
      throw new OcrEngineError('engine-unavailable', `Windows OCR 执行失败: ${message}`, 'system')
    }
  }
}

/**
 * 默认 execFile 实现，封装 node:child_process.execFile。
 * @param executable 可执行文件。
 * @param args 参数。
 * @param options 选项。
 * @returns stdout/stderr 字符串。
 * @author zhenghq
 */
async function defaultExecFile(
  executable: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileP = promisify(execFile)
  const result = await execFileP(executable, args, {
    timeout: options?.timeout,
    signal: options?.signal,
    maxBuffer: 1024 * 1024 * 4,
    encoding: 'utf8'
  } as Parameters<typeof execFileP>[2])
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? '')
  }
}

/** macOS Vision OCR helper 默认路径解析选项。 */
export interface MacOsVisionHelperPathOptions {
  /** 当前工作目录。 */
  cwd?: string
  /** Electron resourcesPath。 */
  resourcesPath?: string
  /**
   * 判断文件是否存在。
   * @param path 文件路径。
   * @returns 文件是否存在。
   */
  fileExists?: (path: string) => boolean
}

/**
 * 返回默认 macOS Vision OCR helper 路径。
 * 打包环境优先使用 Electron resourcesPath，开发环境使用 build 目录。
 * @param options 路径解析选项，测试中可注入。
 * @returns helper 可执行文件路径。
 * @author zhenghq
 */
export function defaultMacOsVisionHelperPath(options?: MacOsVisionHelperPathOptions): string {
  const fileExists = options?.fileExists ?? existsSync
  const cwd = options?.cwd ?? process.cwd()
  const resourcesPath = options?.resourcesPath ?? (
    typeof process.resourcesPath === 'string' && process.resourcesPath
      ? process.resourcesPath
      : cwd
  )
  const resourcesHelperPath = join(resourcesPath, 'macos-vision-ocr')
  if (fileExists(resourcesHelperPath)) return resourcesHelperPath
  return join(cwd, 'build', 'macos-vision-ocr')
}

/**
 * 根据当前平台返回合适的系统 OCR 引擎实例；Linux 返回 null（无系统 OCR）。
 * @param deps 可注入依赖（可选）。
 * @returns 系统 OCR 引擎，Linux 平台返回 null。
 * @author zhenghq
 */
export function createSystemOcrEngine(deps?: Partial<SystemOcrDeps>): OcrEngine | null {
  const platform = deps?.platform ?? process.platform
  if (platform === 'darwin') return new MacOsVisionOcrEngine(deps)
  if (platform === 'win32') return new WindowsSystemOcrEngine(deps)
  return null
}
