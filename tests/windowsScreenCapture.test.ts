import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ScreenCaptureError,
  buildWindowsCaptureCommand,
  captureWindowsRegionAsPng,
  type WindowsScreenCaptureDeps
} from '../src/main/windowsScreenCapture.ts'

/** 校验用可注入依赖：记录 execFile 调用并返回预置文件内容。 */
function makeDeps(overrides: Partial<WindowsScreenCaptureDeps> = {}): WindowsScreenCaptureDeps {
  return {
    platform: 'win32',
    execFile: async () => ({ stdout: '', stderr: '' }),
    readFile: async (path: string) => Buffer.from(`png:${path}`),
    unlink: async () => undefined,
    tmpDir: () => 'C:\\Temp',
    ...overrides
  }
}

/**
 * 校验 Windows 采集命令构造：使用 PowerShell 静默执行 GDI CopyFromScreen。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 采集命令应使用 PowerShell 静默执行 GDI 截屏', () => {
  const cmd = buildWindowsCaptureCommand(
    { x: 0, y: 0, width: 1920, height: 1080 },
    1.5,
    'C:\\Temp\\shot.png'
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
 * 校验 Windows 采集命令把非主显示器按虚拟屏幕物理坐标偏移。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 采集命令应支持多显示器物理坐标偏移', () => {
  const cmd = buildWindowsCaptureCommand(
    { x: 1920, y: 0, width: 1920, height: 1080 },
    1,
    'shot.png'
  )
  const script = cmd.args[cmd.args.indexOf('-Command') + 1]
  assert.match(script, /\$x = 1920/u)
  assert.match(script, /\$y = 0/u)
  assert.match(script, /\$width = 1920/u)
  assert.match(script, /\$height = 1080/u)
})

/**
 * 校验 Windows 采集成功时返回临时 PNG 文件内容。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('Windows 采集成功应返回临时 PNG 文件内容', async () => {
  const calls: Array<{ executable: string; args: string[] }> = []
  let unlinked: string | null = null
  const png = await captureWindowsRegionAsPng(
    { x: 0, y: 0, width: 1920, height: 1080 },
    1,
    makeDeps({
      execFile: async (executable, args) => {
        calls.push({ executable, args })
        return { stdout: '', stderr: '' }
      },
      unlink: async (path: string) => {
        unlinked = path
      }
    })
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].executable, 'powershell.exe')
  assert.match(png.toString('utf8'), /^png:/u)
  assert.ok(unlinked?.startsWith('C:\\Temp\\'))
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
