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
   * 返回系统临时目录。
   * @returns 临时目录路径。
   */
  tmpDir(): string
}

/** Windows 采集命令描述，包含可执行文件与参数列表。 */
export interface WindowsCaptureCommand {
  /** 可执行文件（powershell.exe）。 */
  executable: string
  /** 参数列表。 */
  args: string[]
}

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
 * 脚本先声明进程 DPI-Aware 再调用 System.Drawing Graphics.CopyFromScreen
 * 原样抓取物理像素，绕开 desktopCapturer/DXGI 缩略图在 Windows 高 DPI 下
 * 行错位导致的彩色条纹问题。
 * @param displayBounds 目标显示器矩形（虚拟屏幕坐标）。
 * @param scaleFactor 目标显示器缩放因子。
 * @param outputPath 临时 PNG 输出路径。
 * @returns 命令描述对象。
 * @author zhenghq
 */
export function buildWindowsCaptureCommand(
  displayBounds: CaptureBounds,
  scaleFactor: number,
  outputPath: string
): WindowsCaptureCommand {
  const scale = scaleFactor || 1
  const x = Math.round(displayBounds.x * scale)
  const y = Math.round(displayBounds.y * scale)
  const width = Math.max(1, Math.round(displayBounds.width * scale))
  const height = Math.max(1, Math.round(displayBounds.height * scale))
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Drawing',
    "Add-Type @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class ScreenCaptureDpiHelper {',
    '  [DllImport("user32.dll", SetLastError = true)]',
    '  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);',
    '  [DllImport("user32.dll")]',
    '  public static extern bool SetProcessDPIAware();',
    '}',
    "'@",
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
 * 采集 Windows 目标显示器区域为 PNG：通过 PowerShell + System.Drawing GDI
 * CopyFromScreen 直读物理像素，避免 desktopCapturer/DXGI 在 Windows 高 DPI
 * 下把 RGB 行错位重排产生的彩色条纹。
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
  const command = buildWindowsCaptureCommand(displayBounds, scaleFactor, path)
  try {
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
