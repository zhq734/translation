import { ScreenCaptureError, type CaptureBounds } from './screenCapture'

export { ScreenCaptureError } from './screenCapture'

/** Windows 屏幕采集可注入依赖，便于单元测试替换 execFile/文件操作。 */
export interface WindowsScreenCaptureDeps {
  /** 运行平台标识。 */
  platform: NodeJS.Platform
  /**
   * 执行外部命令，返回 stdout/stderr 字符串。
   * @param executable 可执行文件路径或名称。
   * @param args 参数列表。
   * @param options 超时与隐藏窗口等选项。
   * @returns stdout 与 stderr。
   */
  execFile(
    executable: string,
    args: string[],
    options?: { timeout?: number; windowsHide?: boolean }
  ): Promise<{ stdout: string; stderr: string }>
  /**
   * 读取文件内容。
   * @param path 目标路径。
   * @returns 文件字节。
   */
  readFile(path: string): Promise<Buffer>
  /**
   * 删除文件。
   * @param path 目标路径。
   */
  unlink(path: string): Promise<void>
  /**
   * 返回系统临时目录。DPI helper DLL 缓存目录也由该目录派生，保证测试环境与真实环境一致。
   * @returns 临时目录路径。
   */
  tmpDir(): string
  /**
   * 启动外部进程并等待退出，返回退出码与 stdout/stderr。
   * 用于直接 spawn 预编译的 helper exe，跳过 PowerShell 进程启动开销。
   * @param executable 可执行文件路径。
   * @param args 命令行参数列表。
   * @param options 超时与隐藏窗口等选项。
   * @returns 退出码与 stdout/stderr。
   */
  spawn(
    executable: string,
    args: string[],
    options?: { timeout?: number; windowsHide?: boolean }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

/** Windows 采集命令描述，包含可执行文件与参数列表。 */
export interface WindowsCaptureCommand {
  /** 可执行文件（powershell.exe）。 */
  executable: string
  /** 参数列表。 */
  args: string[]
}

/** DPI helper DLL 缓存目录名，位于 tmpDir() 下。 */
const CACHE_DIR_NAME = 'selection-translator-ocr-cache'
/** DPI helper DLL 文件名。 */
const HELPER_DLL_NAME = 'ScreenCaptureDpiHelper.dll'
/** 预编译 helper exe 文件名，缓存后直接 spawn 以跳过 PowerShell 启动开销。 */
const HELPER_EXE_NAME = 'ScreenCaptureHelper.exe'

/**
 * DPI helper C# 源码：声明 SetProcessDpiAwarenessContext 与 SetProcessDPIAware 两个
 * user32 P/Invoke，仅在首次采集且缓存缺失/损坏时现场编译一次并落盘。
 * @author zhenghq
 */
const HELPER_CSHARP_SOURCE = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class ScreenCaptureDpiHelper {',
  '  [DllImport("user32.dll", SetLastError = true)]',
  '  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);',
  '  [DllImport("user32.dll")]',
  '  public static extern bool SetProcessDPIAware();',
  '}'
].join('\n')

/**
 * Helper exe 的完整 C# 控制台程序源码：解析命令行参数（x, y, width, height, outputPath），
 * 设置进程 DPI awareness 后通过 GDI CopyFromScreen 直读物理像素并保存为 PNG。
 * 首次截图时由 PowerShell 编译为 exe 并缓存，后续截图直接 spawn 该 exe，
 * 跳过 PowerShell 进程启动与脚本解析的 1.5-2.5 秒固定开销。
 * @author zhenghq
 */
const HELPER_EXE_CSHARP_SOURCE = [
  'using System;',
  'using System.Drawing;',
  'using System.Drawing.Imaging;',
  'using System.Runtime.InteropServices;',
  'using System.IO;',
  'class ScreenCaptureHelper {',
  '  [DllImport("user32.dll", SetLastError = true)]',
  '  static extern bool SetProcessDpiAwarenessContext(IntPtr value);',
  '  [DllImport("user32.dll")]',
  '  static extern bool SetProcessDPIAware();',
  '  static int Main(string[] args) {',
  '    if (args.Length < 5) {',
  '      Console.Error.WriteLine("Usage: ScreenCaptureHelper.exe <x> <y> <width> <height> <outputPath>");',
  '      return 1;',
  '    }',
  '    if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) {',
  '      SetProcessDPIAware();',
  '    }',
  '    int x = int.Parse(args[0]);',
  '    int y = int.Parse(args[1]);',
  '    int w = int.Parse(args[2]);',
  '    int h = int.Parse(args[3]);',
  '    string outPath = args[4];',
  '    using (var bmp = new Bitmap(w, h)) {',
  '      using (var g = Graphics.FromImage(bmp)) {',
  '        g.CopyFromScreen(x, y, 0, 0, new Size(w, h));',
  '      }',
  '      bmp.Save(outPath, ImageFormat.Png);',
  '    }',
  '    return 0;',
  '  }',
  '}'
].join('\n')

/**
 * 将单引号替换为 PowerShell 双写单引号，防止路径注入破坏脚本。
 * @param value 需要转义的文本。
 * @returns 转义后的文本。
 * @author zhenghq
 */
function escapeSingleQuote(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * 构造 Windows GDI 屏幕采集的 PowerShell 命令参数。
 * 脚本优先加载磁盘缓存的 DPI helper DLL（零 C# 编译），缓存缺失或加载失败时
 * 才现场编译一次并落盘，避免每次采集都触发 csc.exe 编译造成的 1~3 秒延迟；
 * 随后通过 GDI CopyFromScreen 原样抓取物理像素，绕开 desktopCapturer/DXGI
 * 缩略图在高 DPI 下的行错位彩色条纹问题。
 * @param displayBounds 目标显示器矩形（虚拟屏幕坐标）。
 * @param scaleFactor 目标显示器缩放因子。
 * @param outputPath 临时 PNG 输出路径。
 * @param helperDllPath DPI helper DLL 缓存路径。
 * @returns 命令描述对象。
 * @author zhenghq
 */
export function buildWindowsCaptureCommand(
  displayBounds: CaptureBounds,
  scaleFactor: number,
  outputPath: string,
  helperDllPath: string
): WindowsCaptureCommand {
  const scale = scaleFactor || 1
  const x = Math.round(displayBounds.x * scale)
  const y = Math.round(displayBounds.y * scale)
  const width = Math.max(1, Math.round(displayBounds.width * scale))
  const height = Math.max(1, Math.round(displayBounds.height * scale))
  const helperPath = escapeSingleQuote(helperDllPath)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Drawing',
    `if (Test-Path -LiteralPath '${helperPath}') {`,
    `  try { Add-Type -Path '${helperPath}' -ErrorAction Stop; $helperLoaded = $true } catch { $helperLoaded = $false }`,
    '} else { $helperLoaded = $false }',
    'if (-not $helperLoaded) {',
    `  $dllDir = Split-Path -Parent '${helperPath}'`,
    '  if (-not (Test-Path -LiteralPath $dllDir)) { $null = New-Item -ItemType Directory -Path $dllDir -Force }',
    '  try {',
    `    Add-Type -TypeDefinition '${escapeSingleQuote(HELPER_CSHARP_SOURCE)}' -OutputAssembly '${helperPath}'`,
    `    Add-Type -Path '${helperPath}'`,
    '  } catch {',
    `    Add-Type -TypeDefinition '${escapeSingleQuote(HELPER_CSHARP_SOURCE)}'`,
    '  }',
    '}',
    '$perMonitor = [ScreenCaptureDpiHelper]::SetProcessDpiAwarenessContext([IntPtr](-4))',
    'if (-not $perMonitor) { $null = [ScreenCaptureDpiHelper]::SetProcessDPIAware() }',
    `$x = ${x}`,
    `$y = ${y}`,
    `$width = ${width}`,
    `$height = ${height}`,
    '$bitmap = New-Object System.Drawing.Bitmap($width, $height)',
    'try {',
    '  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '  try {',
    '    $graphics.CopyFromScreen([int]$x, [int]$y, 0, 0, (New-Object System.Drawing.Size([int]$width, [int]$height)))',
    '  } finally {',
    '    $graphics.Dispose()',
    '  }',
    `  $bitmap.Save('${escapeSingleQuote(outputPath)}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '} finally {',
    '  $bitmap.Dispose()',
    '}'
  ].join('\n')
  return {
    executable: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      script
    ]
  }
}

/**
 * 生成带随机后缀的临时 PNG 路径。
 * @param tmpDir 系统临时目录。
 * @returns 临时文件完整路径。
 * @author zhenghq
 */
function makeTempPngPath(tmpDir: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${tmpDir}\\selection-translator-ocr-${process.pid}-${suffix}.png`
}

/**
 * 计算 DPI helper DLL 缓存路径（tmpDir/selection-translator-ocr-cache/ScreenCaptureDpiHelper.dll）。
 * @param tmpDir 系统临时目录。
 * @returns DLL 完整路径。
 * @author zhenghq
 */
function makeHelperDllPath(tmpDir: string): string {
  return `${tmpDir}\\${CACHE_DIR_NAME}\\${HELPER_DLL_NAME}`
}

/**
 * 计算 helper exe 缓存路径（tmpDir/selection-translator-ocr-cache/ScreenCaptureHelper.exe）。
 * @param tmpDir 系统临时目录。
 * @returns exe 完整路径。
 * @author zhenghq
 */
function makeHelperExePath(tmpDir: string): string {
  return `${tmpDir}\\${CACHE_DIR_NAME}\\${HELPER_EXE_NAME}`
}

/**
 * 构造通过 PowerShell 编译 helper exe 的命令。
 * 使用 Add-Type -TypeDefinition 将 C# 源码编译为独立可执行文件（-OutputAssembly 生成 .exe）。
 * @param helperExePath 目标 exe 缓存路径。
 * @returns 编译命令描述。
 * @author zhenghq
 */
export function buildHelperExeCompileCommand(helperExePath: string): WindowsCaptureCommand {
  const exePath = escapeSingleQuote(helperExePath)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$dllDir = Split-Path -Parent '${exePath}'`,
    "if (-not (Test-Path -LiteralPath $dllDir)) { $null = New-Item -ItemType Directory -Path $dllDir -Force }",
    `Add-Type -TypeDefinition '${escapeSingleQuote(HELPER_EXE_CSHARP_SOURCE)}' -OutputAssembly '${exePath}' -OutputType ConsoleApplication`
  ].join('\n')
  return {
    executable: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script]
  }
}

/**
 * 确保 helper exe 存在且可执行：已存在则直接返回路径，否则通过 PowerShell 编译落盘。
 * 编译失败时返回 null，调用方回退到 PowerShell 脚本路径。
 * @param deps 屏幕采集依赖。
 * @param helperExePath exe 缓存路径。
 * @returns exe 路径（成功）或 null（编译失败）。
 * @author zhenghq
 */
export async function ensureHelperExe(
  deps: WindowsScreenCaptureDeps,
  helperExePath: string
): Promise<string | null> {
  // 尝试 spawn exe 验证其存在且可执行（exitCode 1 表示参数不足但 exe 可运行）
  try {
    const result = await deps.spawn(helperExePath, [], { timeout: 3000, windowsHide: true })
    // exe 存在且可执行（exitCode 1 = 参数不足，说明 exe 本身没问题）
    if (result.exitCode === 1 || result.exitCode === 0) {
      return helperExePath
    }
  } catch {
    // exe 不存在或不可执行，继续编译
  }
  // 编译 helper exe
  const compileCmd = buildHelperExeCompileCommand(helperExePath)
  try {
    await deps.execFile(compileCmd.executable, compileCmd.args, {
      timeout: 10000,
      windowsHide: true
    })
    return helperExePath
  } catch {
    return null
  }
}

/**
 * 采集 Windows 目标显示器区域为 PNG：通过 PowerShell + System.Drawing GDI
 * CopyFromScreen 直读物理像素，避免 desktopCapturer/DXGI 在 Windows 高 DPI
 * 下把 RGB 行错位重排产生的彩色条纹；DPI helper 通过磁盘 DLL 缓存避免每次
 * 采集都触发 C# 编译，显著缩短截图键按下到实际截屏的等待时间。
 * @param displayBounds 目标显示器矩形（虚拟屏幕坐标）。
 * @param scaleFactor 目标显示器缩放因子。
 * @param deps 屏幕采集依赖（测试可注入）。
 * @returns PNG 图片字节。
 * @author zhenghq
 */
export async function captureWindowsRegionAsPng(
  displayBounds: CaptureBounds,
  scaleFactor: number,
  deps: WindowsScreenCaptureDeps
): Promise<Buffer> {
  if (deps.platform !== 'win32') {
    throw new ScreenCaptureError('no-source', '仅 Windows 支持 GDI 原生截屏')
  }
  const path = makeTempPngPath(deps.tmpDir())
  const helperDllPath = makeHelperDllPath(deps.tmpDir())
  const helperExePath = makeHelperExePath(deps.tmpDir())
  const scale = scaleFactor || 1
  const x = Math.round(displayBounds.x * scale)
  const y = Math.round(displayBounds.y * scale)
  const width = Math.max(1, Math.round(displayBounds.width * scale))
  const height = Math.max(1, Math.round(displayBounds.height * scale))
  try {
    // 优先使用预编译 helper exe（fast path），跳过 PowerShell 进程启动开销
    const exePath = await ensureHelperExe(deps, helperExePath)
    if (exePath !== null) {
      const exeArgs = [String(x), String(y), String(width), String(height), path]
      const result = await deps.spawn(exePath, exeArgs, { timeout: 5000, windowsHide: true })
      if (result.exitCode !== 0) {
        throw new Error(`helper exe 退出码 ${result.exitCode}: ${result.stderr}`)
      }
      return await deps.readFile(path)
    }
    // 回退到 PowerShell 脚本路径（fallback path）
    const command = buildWindowsCaptureCommand(displayBounds, scaleFactor, path, helperDllPath)
    await deps.execFile(command.executable, command.args, {
      timeout: 5000,
      windowsHide: true
    })
    return await deps.readFile(path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ScreenCaptureError('no-source', `无法获取屏幕截图: ${message}`)
  } finally {
    await deps.unlink(path).catch(() => undefined)
  }
}
