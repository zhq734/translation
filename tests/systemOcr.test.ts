import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodePng } from '../src/main/pngCodec.ts'
import {
  buildVisionOcrScript,
  MacOsVisionOcrEngine,
  parseVisionOcrOutput,
  defaultMacOsVisionHelperPath,
  buildWindowsOcrCommand,
  parseWindowsOcrStructuredOutput,
  restoreWindowsOcrUnderlines,
  WindowsSystemOcrEngine,
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
 * 校验 Windows OCR 执行失败时保留 PowerShell stderr，便于定位语言包、脚本或系统 API 问题。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('Windows OCR 失败应保留 PowerShell stderr 明细', async () => {
  const engine = new WindowsSystemOcrEngine({
    platform: 'win32',
    tmpDir: () => 'C:\\Temp',
    writeFile: async () => undefined,
    execFile: async () => {
      const error = new Error('Command failed: powershell.exe -File win-ocr.ps1') as Error & { stderr?: string }
      error.stderr = '无法加载文件 win-ocr.ps1，因为在此系统上禁止运行脚本。'
      throw error
    }
  })

  await assert.rejects(
    () => engine.recognize({ imageBytes: new Uint8Array([1, 2, 3]), language: 'auto' }),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /Windows OCR 执行失败/u)
      assert.match(message, /禁止运行脚本/u)
      return true
    }
  )
  assert.match(engine.getUnavailableReason() ?? '', /禁止运行脚本/u)
})

/**
 * 校验 Windows OCR 在未注入 writeFile 时会把 PowerShell 脚本真正写入临时目录，
 * 避免生产环境因空实现导致 PowerShell 找不到 win-ocr.ps1。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('Windows OCR 默认依赖应写入 PowerShell 脚本', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'selection-translator-win-ocr-'))
  let scriptContent = ''

  try {
    const engine = new WindowsSystemOcrEngine({
      platform: 'win32',
      tmpDir: () => temporaryDirectory,
      execFile: async (_executable, args) => {
        const fileIndex = args.indexOf('-File')
        assert.notEqual(fileIndex, -1, 'PowerShell 命令应包含 -File 参数')
        const scriptPath = args[fileIndex + 1] ?? ''
        assert.equal(scriptPath, join(temporaryDirectory, 'win-ocr.ps1'))
        scriptContent = await readFile(scriptPath, 'utf8')
        return { stdout: '测试文本', stderr: '' }
      }
    })

    const result = await engine.recognize({
      imagePath: 'C:\\Temp\\windows-ocr.png',
      language: 'zh-Hans'
    })

    assert.equal(result.text, '测试文本')
    assert.match(scriptContent, /Windows\.Media\.Ocr/u)
    assert.match(scriptContent, /\$ImagePath/u)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

/**
 * 校验 Windows OCR 脚本按 OcrResult.Lines 逐行输出，避免多行内容被 OcrResult.Text 合并成单行。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('Windows OCR 脚本应逐行输出识别结果以保留换行', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'selection-translator-win-ocr-lines-'))
  let scriptContent = ''

  try {
    const engine = new WindowsSystemOcrEngine({
      platform: 'win32',
      tmpDir: () => temporaryDirectory,
      execFile: async (_executable, args) => {
        const fileIndex = args.indexOf('-File')
        const scriptPath = args[fileIndex + 1] ?? ''
        scriptContent = await readFile(scriptPath, 'utf8')
        return { stdout: '第一行\n第二行', stderr: '' }
      }
    })

    const result = await engine.recognize({
      imagePath: 'C:\\Temp\\windows-ocr-lines.png',
      language: 'zh-Hans'
    })

    assert.equal(result.text, '第一行\n第二行')
    assert.match(scriptContent, /\$result\.Lines/u, 'PowerShell 脚本应遍历 OcrResult.Lines')
    assert.doesNotMatch(scriptContent, /\[string\]\$result\.Text/u, '不应直接输出会合并换行的 OcrResult.Text')
    assert.match(scriptContent, /Words/u, 'PowerShell 脚本应读取 OcrLine.Words 以定位下划线')
    assert.match(scriptContent, /BoundingRect/u, 'PowerShell 脚本应输出词框以检测词间下划线')
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

/**
 * 校验 Windows OCR 结构化输出解析会保留词框与行文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows OCR 结构化输出应解析每行的词框', () => {
  const lines = parseWindowsOcrStructuredOutput(JSON.stringify({
    lines: [{
      text: 'user id',
      words: [
        { text: 'user', x: 10, y: 20, width: 40, height: 16 },
        { text: 'id', x: 54, y: 20, width: 16, height: 16 }
      ]
    }]
  }))

  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.text, 'user id')
  assert.equal(lines[0]!.words?.length, 2)
  assert.deepEqual(lines[0]!.words?.[1], {
    text: 'id', x: 54, y: 20, width: 16, height: 16
  })
})

/**
 * 校验词间存在实际横线时把 OCR 丢失的下划线恢复出来。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows OCR 词间横线应将空格恢复为下划线', () => {
  const image = makeWindowsOcrTestImage()
  for (let y = 25; y <= 27; y += 1) {
    for (let x = 46; x <= 53; x += 1) setWindowsOcrTestPixel(image, x, y, 20)
  }
  const lines = restoreWindowsOcrUnderlines([{
    text: 'user id',
    words: [
      { text: 'user', x: 8, y: 6, width: 37, height: 16 },
      { text: 'id', x: 54, y: 6, width: 14, height: 16 }
    ]
  }], image)

  assert.equal(lines[0]!.text, 'user_id')
})

/**
 * 校验词间没有横线时保留普通空格，避免把英文短语误改成下划线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows OCR 无词间横线时应保留普通空格', () => {
  const image = makeWindowsOcrTestImage()
  const lines = restoreWindowsOcrUnderlines([{
    text: 'hello world',
    words: [
      { text: 'hello', x: 8, y: 6, width: 37, height: 16 },
      { text: 'world', x: 54, y: 6, width: 36, height: 16 }
    ]
  }], image)

  assert.equal(lines[0]!.text, 'hello world')
})

/**
 * 校验词间横线位于字形中部（连字符）时不应恢复成下划线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows OCR 连字符不应被恢复为下划线', () => {
  const image = makeWindowsOcrTestImage()
  for (let y = 14; y <= 16; y += 1) {
    for (let x = 46; x <= 53; x += 1) setWindowsOcrTestPixel(image, x, y, 20)
  }
  const lines = restoreWindowsOcrUnderlines([{
    text: 'foo bar',
    words: [
      { text: 'foo', x: 8, y: 6, width: 37, height: 16 },
      { text: 'bar', x: 54, y: 6, width: 32, height: 16 }
    ]
  }], image)

  assert.equal(lines[0]!.text, 'foo bar')
})

/**
 * 校验同一行多个词间下划线可全部恢复，覆盖重复单词的索引推进。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows OCR 应恢复同一行的多个下划线', () => {
  const image = makeWindowsOcrTestImage()
  for (let y = 25; y <= 27; y += 1) {
    for (let x = 46; x <= 53; x += 1) setWindowsOcrTestPixel(image, x, y, 20)
    for (let x = 74; x <= 92; x += 1) setWindowsOcrTestPixel(image, x, y, 20)
  }
  const lines = restoreWindowsOcrUnderlines([{
    text: 'user id user',
    words: [
      { text: 'user', x: 8, y: 6, width: 37, height: 16 },
      { text: 'id', x: 54, y: 6, width: 14, height: 16 },
      { text: 'user', x: 98, y: 6, width: 37, height: 16 }
    ]
  }], image)

  assert.equal(lines[0]!.text, 'user_id_user')
})

/**
 * 校验 Windows 引擎会把结构化词框与下划线恢复结果回传给调用方。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('Windows OCR 引擎应解析结构化输出并恢复下划线', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'selection-translator-win-ocr-underline-'))
  const source = makeWindowsOcrTestImage()
  for (let y = 25; y <= 27; y += 1) {
    for (let x = 46; x <= 53; x += 1) setWindowsOcrTestPixel(source, x, y, 20)
  }

  try {
    const engine = new WindowsSystemOcrEngine({
      platform: 'win32',
      tmpDir: () => temporaryDirectory,
      execFile: async () => ({
        stdout: JSON.stringify({
          lines: [{
            text: 'user id',
            words: [
              { text: 'user', x: 8, y: 6, width: 37, height: 16 },
              { text: 'id', x: 54, y: 6, width: 14, height: 16 }
            ]
          }]
        }),
        stderr: ''
      })
    })

    const result = await engine.recognize({
      imageBytes: encodePng(source),
      language: 'en'
    })

    assert.equal(result.text, 'user_id')
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

/**
 * 构造用于 Windows OCR 下划线检测的白色测试图像。
 * @returns 白色 RGBA 测试图像。
 * @author zhenghq
 */
function makeWindowsOcrTestImage(): { width: number; height: number; data: Uint8Array } {
  const image = { width: 144, height: 34, data: new Uint8Array(144 * 34 * 4) }
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = 255
    image.data[i + 1] = 255
    image.data[i + 2] = 255
    image.data[i + 3] = 255
  }
  return image
}

/**
 * 设置 Windows OCR 测试图像的单像素灰度值。
 * @param image 目标图像。
 * @param x 横坐标。
 * @param y 纵坐标。
 * @param value 灰度值。
 * @returns 无返回值。
 * @author zhenghq
 */
function setWindowsOcrTestPixel(
  image: { width: number; height: number; data: Uint8Array },
  x: number,
  y: number,
  value: number
): void {
  const offset = (y * image.width + x) * 4
  image.data[offset] = value
  image.data[offset + 1] = value
  image.data[offset + 2] = value
}

/**
 * 校验 Windows OCR 结构化输出损坏时安全回退为空结果，避免引擎整体失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows OCR 非结构化旧输出应安全回退为逐行文本', () => {
  assert.deepEqual(parseWindowsOcrStructuredOutput('普通旧版输出\n第二行'), [
    { text: '普通旧版输出' },
    { text: '第二行' }
  ])
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
