import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ScreenCaptureError,
  buildWindowsCaptureCommand,
  buildHelperExeCompileCommand,
  captureWindowsRegionAsPng,
  type WindowsScreenCaptureDeps
} from '../src/main/windowsScreenCapture.ts'

/** 默认 DPI helper DLL 缓存路径（由 tmpDir() 派生）。 */
const HELPER_DLL = 'C:\\Temp\\selection-translator-ocr-cache\\ScreenCaptureDpiHelper.dll'
/** 默认 helper exe 缓存路径（由 tmpDir() 派生）。 */
const HELPER_EXE = 'C:\\Temp\\selection-translator-ocr-cache\\ScreenCaptureHelper.exe'

/**
 * 构造可注入依赖：记录 execFile/spawn 调用并返回预置文件内容。
 * @param overrides 覆盖默认行为的依赖子集。
 * @returns 完整依赖对象。
 * @author zhenghq
 */
function makeDeps(overrides: Partial<WindowsScreenCaptureDeps> = {}): WindowsScreenCaptureDeps {
  return {
    platform: 'win32',
    execFile: async () => ({ stdout: '', stderr: '' }),
    spawn: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    readFile: async (path: string) => Buffer.from(`png:${path}`),
    unlink: async () => undefined,
    tmpDir: () => 'C:\\Temp',
    ...overrides
  }
}

/**
 * 校验 Windows 采集命令构造：使用 PowerShell 静默执行 GDI 截屏。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 采集命令应使用 PowerShell 静默执行 GDI 截屏', () => {
  const cmd = buildWindowsCaptureCommand(
    { x: 0, y: 0, width: 1920, height: 1080 },
    1.5,
    'C:\\Temp\\shot.png',
    HELPER_DLL
  )
  assert.equal(cmd.executable, 'powershell.exe')
  assert.ok(cmd.args.includes('-NoProfile'))
  assert.ok(cmd.args.includes('-NonInteractive'))
  assert.ok(cmd.args.includes('-WindowStyle'))
  assert.ok(cmd.args.includes('Hidden'))
  const script = cmd.args[cmd.args.indexOf('-Command') + 1]
  assert.match(script, /Add-Type -AssemblyName System\.Drawing/u)
  assert.match(script, /SetProcessDpiAwarenessContext/u)
  assert.match(script, /SetProcessDPIAware/u)
  assert.match(script, /CopyFromScreen\(\[int\]\$x,\s*\[int\]\$y,\s*0,\s*0,/u)
  assert.match(script, /\$x = 0/u)
  assert.match(script, /\$y = 0/u)
  assert.match(script, /\$width = 2880/u)
  assert.match(script, /\$height = 1620/u)
  assert.match(script, /New-Object System\.Drawing\.Bitmap\(\$width,\s*\$height\)/u)
  assert.match(script, /ImageFormat\]::Png/u)
  assert.ok(script.includes("C:\\Temp\\shot.png"))
})

/**
 * 校验脚本优先加载磁盘缓存的 DPI helper DLL，缓存缺失时才现场编译并落盘，
 * 避免每次采集都触发 csc.exe 编译造成的 1~3 秒延迟。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 采集脚本应优先加载缓存 DLL 并回退现场编译', () => {
  const cmd = buildWindowsCaptureCommand(
    { x: 0, y: 0, width: 1920, height: 1080 },
    1.5,
    'C:\\Temp\\shot.png',
    HELPER_DLL
  )
  const script = cmd.args[cmd.args.indexOf('-Command') + 1]
  assert.match(script, /Test-Path -LiteralPath 'C:\\Temp\\selection-translator-ocr-cache\\ScreenCaptureDpiHelper\.dll'/u)
  assert.match(script, /Add-Type -Path 'C:\\Temp\\selection-translator-ocr-cache\\ScreenCaptureDpiHelper\.dll'/u)
  assert.match(script, /Add-Type -TypeDefinition/u)
  assert.match(script, /-OutputAssembly 'C:\\Temp\\selection-translator-ocr-cache\\ScreenCaptureDpiHelper\.dll'/u)
  assert.doesNotMatch(script, /Add-Type @'/u)
  assert.doesNotMatch(script, /Add-Type -MemberDefinition/u)
  assert.match(script, /\[ScreenCaptureDpiHelper\]::SetProcessDpiAwarenessContext\(\[IntPtr\]\(-4\)\)/u)
})

/**
 * 校验 Windows 采集命令把非主显示器按虚拟屏幕物理坐标偏移。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 采集命令应支持多显示器物理坐标偏移', () => {
  const cmd = buildWindowsCaptureCommand(
    { x: 1920, y: 0, width: 1920, height: 1080 },
    1,
    'shot.png',
    HELPER_DLL
  )
  const script = cmd.args[cmd.args.indexOf('-Command') + 1]
  assert.match(script, /\$x = 1920/u)
  assert.match(script, /\$y = 0/u)
  assert.match(script, /\$width = 1920/u)
  assert.match(script, /\$height = 1080/u)
})

/**
 * 校验 helper exe 编译命令包含 C# 源码与输出程序集路径。
 * @returns 无返回值。
 * @author zhenghq
 */
test('helper exe 编译命令应包含 C# 源码与输出路径', () => {
  const cmd = buildHelperExeCompileCommand(HELPER_EXE)
  assert.equal(cmd.executable, 'powershell.exe')
  const script = cmd.args[cmd.args.indexOf('-Command') + 1]
  assert.match(script, /Add-Type -TypeDefinition/u)
  assert.match(script, /-OutputAssembly 'C:\\Temp\\selection-translator-ocr-cache\\ScreenCaptureHelper\.exe'/u)
  assert.match(script, /-OutputType ConsoleApplication/u)
  assert.match(script, /class ScreenCaptureHelper/u)
  assert.match(script, /CopyFromScreen/u)
})

/**
 * 校验 helper exe 缓存命中时直接 spawn exe 传递坐标参数，不启动 PowerShell。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('helper exe 缓存命中时应直接 spawn exe 传递坐标参数', async () => {
  const spawnCalls: Array<{ executable: string; args: string[] }> = []
  const execFileCalls: Array<{ executable: string; args: string[] }> = []
  let unlinked: string | null = null
  const png = await captureWindowsRegionAsPng(
    { x: 0, y: 0, width: 1920, height: 1080 },
    1.5,
    makeDeps({
      spawn: async (executable, args) => {
        spawnCalls.push({ executable, args })
        // 首次调用（无参数）返回 exitCode 1 表示 exe 存在；第二次调用（有参数）返回 exitCode 0
        if (args.length === 0) return { exitCode: 1, stdout: '', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      execFile: async (executable, args) => {
        execFileCalls.push({ executable, args })
        return { stdout: '', stderr: '' }
      },
      unlink: async (path: string) => {
        unlinked = path
      }
    })
  )
  // 应有两次 spawn：第一次验证 exe 存在，第二次实际截图
  assert.equal(spawnCalls.length, 2)
  // 不应调用 execFile（PowerShell）
  assert.equal(execFileCalls.length, 0)
  // 第二次 spawn 应包含坐标参数
  const captureArgs = spawnCalls[1].args
  assert.equal(captureArgs[0], '0')
  assert.equal(captureArgs[1], '0')
  assert.equal(captureArgs[2], '2880')
  assert.equal(captureArgs[3], '1620')
  assert.ok(captureArgs[4].includes('selection-translator-ocr'))
  assert.match(png.toString('utf8'), /^png:/u)
  assert.ok(unlinked?.startsWith('C:\\Temp\\'))
})

/**
 * 校验 helper exe 缓存未命中时触发 PowerShell 编译命令。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('helper exe 缓存未命中时应触发 PowerShell 编译', async () => {
  const spawnCalls: Array<{ executable: string; args: string[] }> = []
  const execFileCalls: Array<{ executable: string; args: string[] }> = []
  let compileTriggered = false
  const png = await captureWindowsRegionAsPng(
    { x: 0, y: 0, width: 1920, height: 1080 },
    1,
    makeDeps({
      // 首次 spawn exe 抛出（exe 不存在），触发编译；后续 spawn 成功
      spawn: async (executable, args) => {
        spawnCalls.push({ executable, args })
        if (args.length === 0) throw new Error('ENOENT')
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      execFile: async (executable, args) => {
        execFileCalls.push({ executable, args })
        const script = args[args.indexOf('-Command') + 1] || ''
        if (script.includes('Add-Type') && script.includes('ScreenCaptureHelper')) {
          compileTriggered = true
        }
        return { stdout: '', stderr: '' }
      },
      unlink: async () => undefined
    })
  )
  assert.ok(compileTriggered, '应触发 helper exe 编译命令')
  // 编译后应 spawn exe 进行实际截图
  assert.ok(spawnCalls.length >= 2, '应至少 spawn 两次（验证 + 截图）')
  assert.match(png.toString('utf8'), /^png:/u)
})

/**
 * 校验编译失败时回退到 PowerShell 脚本路径。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('helper exe 编译失败时应回退到 PowerShell 脚本路径', async () => {
  const spawnCalls: Array<{ executable: string; args: string[] }> = []
  const execFileCalls: Array<{ executable: string; args: string[] }> = []
  let unlinked = false
  const png = await captureWindowsRegionAsPng(
    { x: 0, y: 0, width: 1920, height: 1080 },
    1,
    makeDeps({
      // spawn exe 抛出（不存在），编译也失败 → 回退 PowerShell
      spawn: async (executable, args) => {
        spawnCalls.push({ executable, args })
        throw new Error('ENOENT')
      },
      execFile: async (executable, args) => {
        execFileCalls.push({ executable, args })
        const script = args[args.indexOf('-Command') + 1] || ''
        // 编译命令失败，PowerShell 截图命令成功
        if (script.includes('ScreenCaptureHelper') && script.includes('Add-Type')) {
          throw new Error('csc 编译失败')
        }
        return { stdout: '', stderr: '' }
      },
      unlink: async () => {
        unlinked = true
      }
    })
  )
  // spawn 应被调用（尝试 exe 失败）
  assert.ok(spawnCalls.length > 0)
  // execFile 应被调用（编译尝试 + 回退 PowerShell 截图）
  assert.ok(execFileCalls.length >= 2)
  // 最后一次 execFile 应是 PowerShell 脚本截图命令
  const lastCall = execFileCalls[execFileCalls.length - 1]
  assert.equal(lastCall.executable, 'powershell.exe')
  const script = lastCall.args[lastCall.args.indexOf('-Command') + 1]
  assert.match(script, /CopyFromScreen/u)
  assert.match(png.toString('utf8'), /^png:/u)
  assert.equal(unlinked, true)
})

/**
 * 校验 fallback 路径仍使用现有 buildWindowsCaptureCommand 构造的 PowerShell 脚本。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('fallback 路径应使用 buildWindowsCaptureCommand 构造的 PowerShell 脚本', async () => {
  const execFileCalls: Array<{ executable: string; args: string[] }> = []
  await captureWindowsRegionAsPng(
    { x: 100, y: 200, width: 800, height: 600 },
    1,
    makeDeps({
      spawn: async () => { throw new Error('ENOENT') },
      execFile: async (executable, args) => {
        execFileCalls.push({ executable, args })
        const script = args[args.indexOf('-Command') + 1] || ''
        // 编译命令失败，PowerShell 截图命令成功
        if (script.includes('ScreenCaptureHelper') && script.includes('Add-Type')) {
          throw new Error('csc 编译失败')
        }
        return { stdout: '', stderr: '' }
      }
    })
  )
  // 最后一次 execFile 是 PowerShell 截图（非编译）
  const captureCall = execFileCalls[execFileCalls.length - 1]
  assert.equal(captureCall.executable, 'powershell.exe')
  const script = captureCall.args[captureCall.args.indexOf('-Command') + 1]
  assert.match(script, /Add-Type -AssemblyName System\.Drawing/u)
  assert.match(script, /\$x = 100/u)
  assert.match(script, /\$y = 200/u)
  assert.match(script, /\$width = 800/u)
  assert.match(script, /\$height = 600/u)
})

/**
 * 校验 Windows 采集失败时归类为 no-source 并清理临时文件。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('Windows 采集失败应归类为无画面源错误并清理临时文件', async () => {
  let unlinked = false
  await assert.rejects(
    captureWindowsRegionAsPng(
      { x: 0, y: 0, width: 1920, height: 1080 },
      1,
      makeDeps({
        spawn: async () => { throw new Error('CopyFromScreen 失败') },
        execFile: async () => {
          throw new Error('CopyFromScreen 失败')
        },
        unlink: async () => {
          unlinked = true
        }
      })
    ),
    (error: unknown) => error instanceof ScreenCaptureError && error.code === 'no-source'
  )
  assert.equal(unlinked, true)
})

/**
 * 校验非 Windows 平台调用直接抛出无画面源错误，避免误用。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('非 Windows 平台调用应拒绝执行', async () => {
  await assert.rejects(
    captureWindowsRegionAsPng(
      { x: 0, y: 0, width: 1920, height: 1080 },
      1,
      makeDeps({ platform: 'linux' })
    ),
    (error: unknown) => error instanceof ScreenCaptureError && error.code === 'no-source'
  )
})
