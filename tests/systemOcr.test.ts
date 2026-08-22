import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildVisionOcrScript,
  MacOsVisionOcrEngine,
  parseVisionOcrOutput,
  defaultMacOsVisionHelperPath,
  buildWindowsOcrCommand,
  type SystemOcrDeps
} from '../src/main/systemOcr.ts'

/**
 * 校验 macOS Vision OCR Swift 脚本包含关键 Vision API 调用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS Vision 脚本应包含 VNRecognizeTextRequest 调用', () => {
  const script = buildVisionOcrScript('/tmp/test.png', 'zh-Hans')
  assert.ok(script.includes('VNRecognizeTextRequest'), '应包含 VNRecognizeTextRequest')
  assert.ok(script.includes('zh-Hans'), '应包含语言标签')
  assert.ok(script.includes('/tmp/test.png'), '应包含图片路径')
})

/**
 * 校验 auto 语言时 Vision 脚本显式提供中英文等候选语言，避免中文系统环境误识别英文日志。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Vision 脚本 auto 语言时应显式提供多语言识别候选', () => {
  const script = buildVisionOcrScript('/tmp/test.png', 'auto')
  assert.ok(script.includes('VNRecognizeTextRequest'), '应包含 VNRecognizeTextRequest')
  assert.ok(script.includes('en-US'), 'auto 应包含英文，适配日志和代码截图')
  assert.ok(script.includes('zh-Hans'), 'auto 应包含简体中文')
  assert.ok(script.includes('zh-Hant'), 'auto 应包含繁体中文')
  assert.ok(typeof script === 'string' && script.length > 0)
})

/**
 * 校验 auto 语言时中文候选排在英文前，避免中文截图被系统 OCR 误按英文形状识别。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Vision 脚本 auto 语言时应优先中文候选', () => {
  const script = buildVisionOcrScript('/tmp/test.png', 'auto')

  assert.ok(script.indexOf('zh-Hans') >= 0)
  assert.ok(script.indexOf('en-US') >= 0)
  assert.ok(script.indexOf('zh-Hans') < script.indexOf('en-US'))
})

/**
 * 校验 Vision OCR 输出解析：每行文字正确提取。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Vision OCR 输出解析应正确提取每行文字', () => {
  const raw = '你好世界\nHello World\n测试文本'
  const lines = parseVisionOcrOutput(raw)
  assert.equal(lines.length, 3)
  assert.equal(lines[0]!.text, '你好世界')
  assert.equal(lines[1]!.text, 'Hello World')
  assert.equal(lines[2]!.text, '测试文本')
})

/**
 * 校验 Vision OCR 输出解析时过滤空行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Vision OCR 输出解析应过滤空行', () => {
  const raw = '第一行\n\n\n第二行\n'
  const lines = parseVisionOcrOutput(raw)
  assert.equal(lines.length, 2)
  assert.equal(lines[0]!.text, '第一行')
  assert.equal(lines[1]!.text, '第二行')
})

/**
 * 校验空输出返回空数组，不抛出异常。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Vision OCR 空输出应返回空数组', () => {
  assert.deepEqual(parseVisionOcrOutput(''), [])
  assert.deepEqual(parseVisionOcrOutput('   \n  \n  '), [])
})

/**
 * 校验 macOS Vision 引擎识别图片字节前会写入临时文件，再把该路径传入 osascript。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('MacOsVisionOcrEngine 应先写入图片字节再执行 Vision 脚本', async () => {
  let writtenPath = ''
  let writtenBytes = 0
  const engine = new MacOsVisionOcrEngine({
    platform: 'darwin',
    visionHelperPath: '/tmp/macos-vision-ocr',
    fileExists: () => true,
    tmpDir: () => '/tmp',
    writeFile: async (path, data) => {
      writtenPath = path
      writtenBytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data)
    },
    execFile: async (executable, args) => {
      assert.equal(executable, '/tmp/macos-vision-ocr')
      assert.ok(writtenPath, '应先写入临时图片')
      assert.ok(args.some((arg) => arg.includes(writtenPath)), 'Vision helper 应引用临时图片路径')
      return { stdout: 'Hello log', stderr: '' }
    }
  })

  const result = await engine.recognize({ imageBytes: Buffer.from([1, 2, 3]), language: 'auto' })

  assert.equal(writtenBytes, 3)
  assert.equal(result.text, 'Hello log')
})

/**
 * 校验缺少 Vision helper 时 macOS Vision OCR 返回简短不可用提示。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('MacOsVisionOcrEngine 缺少 Vision helper 时应提示不可用', async () => {
  const engine = new MacOsVisionOcrEngine({
    platform: 'darwin',
    visionHelperPath: '/tmp/missing-helper',
    fileExists: () => false,
    tmpDir: () => '/tmp',
    writeFile: async () => undefined,
    execFile: async () => {
      throw new Error('不应执行缺失的 helper')
    }
  })

  await assert.rejects(
    () => engine.recognize({ imageBytes: Buffer.from([1, 2, 3]), language: 'auto' }),
    (err: unknown) => {
      assert.equal((err as Error).message, 'macOS Vision OCR helper 未安装')
      return true
    }
  )
})

/**
 * 校验 macOS Vision OCR 可用性检测不依赖 Swift OSA 组件。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('MacOsVisionOcrEngine 缺少 Swift OSA 组件时不应影响 helper 可用性', async () => {
  const calls: string[] = []
  const engine = new MacOsVisionOcrEngine({
    platform: 'darwin',
    visionHelperPath: '/tmp/macos-vision-ocr',
    fileExists: () => true,
    tmpDir: () => '/tmp',
    writeFile: async () => undefined,
    execFile: async (executable, args) => {
      calls.push([executable, ...args].join(' '))
      return { stdout: 'macos-vision-ocr 1.0', stderr: '' }
    }
  })

  assert.equal(await engine.isAvailable(), true)
  assert.equal(calls[0], '/tmp/macos-vision-ocr --version')
  assert.ok(!calls.some((call) => call.includes('osascript -l Swift')))
})

/**
 * 校验开发环境下 macOS Vision helper 默认回退到 build 目录产物。
 * @returns 无返回值。
 * @author zhenghq
 */
test('defaultMacOsVisionHelperPath 应在 resources 缺失时回退到 build 目录', () => {
  const helperPath = defaultMacOsVisionHelperPath({
    cwd: '/repo',
    resourcesPath: '/Electron.app/Contents/Resources',
    fileExists: (path) => path === '/repo/build/macos-vision-ocr'
  })

  assert.equal(helperPath, '/repo/build/macos-vision-ocr')
})

/**
 * 校验 Windows OCR 命令包含 powershell 与脚本路径。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows OCR 命令应包含 powershell 与脚本路径', () => {
  const cmd = buildWindowsOcrCommand('C:\\tmp\\img.png', 'C:\\ocr\\win-ocr.ps1', 'zh-Hans')
  assert.equal(cmd.executable, 'powershell.exe')
  assert.ok(cmd.args.some((a) => a.includes('win-ocr.ps1')), '应引用脚本路径')
  assert.ok(cmd.args.some((a) => a.includes('img.png')), '应包含图片路径')
  assert.ok(cmd.args.some((a) => a.includes('zh-Hans')), '应包含语言参数')
})

/**
 * 校验 Windows OCR auto 语言时传入 auto 标签。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows OCR auto 语言时应传 auto 标签给脚本', () => {
  const cmd = buildWindowsOcrCommand('C:\\tmp\\img.png', 'C:\\ocr\\win-ocr.ps1', 'auto')
  assert.ok(cmd.args.some((a) => a === 'auto' || a.includes('auto')), '应传入 auto 语言')
})

/**
 * 校验系统 OCR 依赖接口类型导出可供主进程使用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('SystemOcrDeps 接口应可在测试中构造', () => {
  const deps: SystemOcrDeps = {
    platform: 'darwin',
    execFile: async () => ({ stdout: '', stderr: '' }),
    writeFile: async () => undefined,
    tmpDir: () => '/tmp'
  }
  assert.equal(deps.platform, 'darwin')
})
