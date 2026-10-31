import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildTesseractWorkerOptions,
  ensureTessDataDirectory,
  normalizeTesseractBlocks,
  resolveTesseractLangPath,
  resolveTesseractLangPathForLanguage,
  resolveTesseractWorkerPath,
  tesseractLanguageTag,
  normalizeTesseractLines,
  TesseractOcrEngine,
  type TesseractOcrDeps
} from '../src/main/tesseractOcr.ts'
import { setMainMessageTranslator } from '../src/main/messages.ts'
import { createTranslator } from '../src/shared/i18n/index.ts'
import { OcrEngineError } from '../src/shared/ocrEngine.ts'
import { tForTest } from './helpers/i18n.ts'

setMainMessageTranslator(createTranslator('zh-CN'))

/**
 * 校验语言映射：中文 auto/zh-hans 映射为 chi_sim+eng。
 * @returns 无返回值。
 * @author zhenghq
 */
test('tesseractLanguageTag 中文应映射为 chi_sim+eng', () => {
  assert.equal(tesseractLanguageTag('auto'), 'chi_sim+eng')
  assert.equal(tesseractLanguageTag('zh'), 'chi_sim+eng')
  assert.equal(tesseractLanguageTag('zh-hans'), 'chi_sim+eng')
  assert.equal(tesseractLanguageTag('zh-Hans'), 'chi_sim+eng')
  assert.equal(tesseractLanguageTag(''), 'chi_sim+eng')
})

/**
 * 校验繁体中文映射为 chi_tra+eng。
 * @returns 无返回值。
 * @author zhenghq
 */
test('tesseractLanguageTag 繁体中文应映射为 chi_tra+eng', () => {
  assert.equal(tesseractLanguageTag('zh-hant'), 'chi_tra+eng')
  assert.equal(tesseractLanguageTag('zh-Hant'), 'chi_tra+eng')
})

/**
 * 校验英文映射为 eng。
 * @returns 无返回值。
 * @author zhenghq
 */
test('tesseractLanguageTag 英文应映射为 eng', () => {
  assert.equal(tesseractLanguageTag('en'), 'eng')
})

/**
 * 校验日文映射为 jpn+eng。
 * @returns 无返回值。
 * @author zhenghq
 */
test('tesseractLanguageTag 日文应映射为 jpn+eng', () => {
  assert.equal(tesseractLanguageTag('ja'), 'jpn+eng')
})

/**
 * 校验未知语言回退 chi_sim+eng。
 * @returns 无返回值。
 * @author zhenghq
 */
test('tesseractLanguageTag 未知语言应回退 chi_sim+eng', () => {
  assert.equal(tesseractLanguageTag('xx-unknown'), 'chi_sim+eng')
})

/**
 * 校验 tessdata 缓存目录缺失时会被自动创建，避免语言模型无法落盘。
 * @returns 无返回值。
 * @author zhenghq
 */
test('ensureTessDataDirectory 应递归创建缺失的缓存目录', () => {
  const base = mkdtempSync(join(tmpdir(), 'tessdata-test-'))
  const target = join(base, 'nested', 'tessdata')
  try {
    assert.equal(existsSync(target), false)
    ensureTessDataDirectory(target)
    assert.equal(existsSync(target), true)
    // 目录已存在时应幂等，不抛异常。
    ensureTessDataDirectory(target)
    // 空路径不应创建任何内容。
    ensureTessDataDirectory('')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

/**
 * 校验 Tesseract 语言模型地址只接受 HTTP(S) 或本地绝对路径，并去除尾部斜杠。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveTesseractLangPath 应规范化镜像地址并忽略空值', () => {
  assert.equal(resolveTesseractLangPath(''), undefined)
  assert.equal(resolveTesseractLangPath('   '), undefined)
  assert.equal(resolveTesseractLangPath('https://mirror.example/tessdata/'), 'https://mirror.example/tessdata')
  assert.equal(resolveTesseractLangPath('http://mirror.example/tessdata'), 'http://mirror.example/tessdata')
  assert.equal(resolveTesseractLangPath('/opt/tessdata/'), '/opt/tessdata')
  assert.equal(resolveTesseractLangPath('C:\\tessdata\\'), 'C:\\tessdata')
  assert.equal(resolveTesseractLangPath('file:///opt/tessdata'), undefined)
  assert.equal(resolveTesseractLangPath('javascript:alert(1)'), undefined)
})

/**
 * 校验显式配置的语言模型目录始终优先于安装包内置模型。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveTesseractLangPathForLanguage 应优先使用显式配置目录', () => {
  const selected = resolveTesseractLangPathForLanguage({
    lang: 'chi_sim+eng',
    configuredPath: 'D:\\ocr-mirror\\',
    bundledPath: '/resources/tessdata',
    fileExists: () => true
  })

  assert.equal(selected, 'D:\\ocr-mirror')
})

/**
 * 校验内置模型完整时，中文和英文识别不依赖 CDN。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveTesseractLangPathForLanguage 应使用包含全部语言的内置目录', () => {
  const existing = new Set([
    join('/resources/tessdata', 'chi_sim.traineddata.gz'),
    join('/resources/tessdata', 'eng.traineddata.gz')
  ])
  const selected = resolveTesseractLangPathForLanguage({
    lang: 'chi_sim+eng',
    bundledPath: '/resources/tessdata/',
    fileExists: (path) => existing.has(path)
  })

  assert.equal(selected, '/resources/tessdata')
})

/**
 * 校验未内置的 OCR 语言会回退到 Tesseract 默认 CDN。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveTesseractLangPathForLanguage 缺少任一内置模型时应回退 CDN', () => {
  const existing = new Set([join('/resources/tessdata', 'eng.traineddata.gz')])
  const selected = resolveTesseractLangPathForLanguage({
    lang: 'jpn+eng',
    bundledPath: '/resources/tessdata',
    fileExists: (path) => existing.has(path)
  })

  assert.equal(selected, undefined)
})

/**
 * 校验 Tesseract 原始输出规范化为文本行数组。
 * @returns 无返回值。
 * @author zhenghq
 */
test('normalizeTesseractLines 应拆分并过滤空行', () => {
  const lines = normalizeTesseractLines('Hello World\n\nFoo Bar\n')
  assert.equal(lines.length, 2)
  assert.equal(lines[0]!.text, 'Hello World')
  assert.equal(lines[1]!.text, 'Foo Bar')
})

/**
 * 校验空输出返回空数组。
 * @returns 无返回值。
 * @author zhenghq
 */
test('normalizeTesseractLines 空输出应返回空数组', () => {
  assert.deepEqual(normalizeTesseractLines(''), [])
  assert.deepEqual(normalizeTesseractLines('  \n  '), [])
})

/**
 * 校验 TesseractOcrDeps 接口可注入。
 * @returns 无返回值。
 * @author zhenghq
 */
test('TesseractOcrDeps 接口应可构造', () => {
  const deps: TesseractOcrDeps = {
    tessDataPath: '/tmp/tessdata',
    workerPath: '/tmp/app.asar.unpacked/node_modules/tesseract.js/src/worker-script/node/index.js',
    createWorker: async () => ({
      recognize: async () => ({ data: { text: '' } }),
      setParameters: async () => undefined,
      terminate: async () => undefined
    }),
    onProgress: () => undefined
  }
  assert.equal(deps.tessDataPath, '/tmp/tessdata')
  assert.equal(deps.workerPath, '/tmp/app.asar.unpacked/node_modules/tesseract.js/src/worker-script/node/index.js')
})

/**
 * 校验自定义 worker 路径会被传给 tesseract.js，避免打包后从 app.asar 内启动 worker。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('Tesseract worker 选项应传入 workerPath、内置模型与缓存目录', () => {
  const workerPath = '/tmp/app.asar.unpacked/node_modules/tesseract.js/src/worker-script/node/index.js'
  const existing = new Set([
    join('/resources/tessdata', 'chi_sim.traineddata.gz'),
    join('/resources/tessdata', 'eng.traineddata.gz')
  ])
  const options = buildTesseractWorkerOptions({
    lang: 'chi_sim+eng',
    tessDataPath: '/tmp/tessdata',
    bundledLangPath: '/resources/tessdata',
    workerPath,
    fileExists: (path) => existing.has(path)
  })

  assert.equal(options.cachePath, '/tmp/tessdata')
  assert.equal(options.langPath, '/resources/tessdata')
  assert.equal(options.workerPath, workerPath)
  assert.equal(typeof options.logger, 'function')
})

/**
 * 校验打包后的 worker 路径指向 asar.unpacked，开发环境不覆盖默认路径。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveTesseractWorkerPath 应仅对打包应用返回 asar.unpacked 路径', () => {
  assert.equal(resolveTesseractWorkerPath('/resources', false), undefined)
  assert.equal(
    resolveTesseractWorkerPath('/resources', true),
    join(
      '/resources',
      'app.asar.unpacked',
      'node_modules',
      'tesseract.js',
      'src',
      'worker-script',
      'node',
      'index.js'
    )
  )
})

/**
 * 校验引擎通过注入 worker 正常识别并返回文本行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('TesseractOcrEngine 正常识别应返回文本行', async () => {
  const { TesseractOcrEngine } = await import('../src/main/tesseractOcr.ts')
  const engine = new TesseractOcrEngine({
    tessDataPath: '/tmp/tessdata',
    createWorker: async (_lang: string) => ({
      recognize: async (_input: unknown) => ({
        data: { text: '你好世界\nHello\n' }
      }),
      setParameters: async (_params: unknown) => undefined,
      terminate: async () => undefined
    }),
    onProgress: () => undefined
  })
  const result = await engine.recognize({
    imageBytes: Buffer.from([1, 2, 3]),
    language: 'zh',
    timeoutMs: 500
  })
  assert.equal(result.engine, 'tesseract')
  assert.equal(result.lines.length, 2)
  assert.equal(result.lines[0]!.text, '你好世界')
})

/**
 * 校验 Tesseract blocks 被规范化为带像素行框和 0-1 置信度的文本行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Tesseract blocks 应保留行框并归一化置信度', () => {
  const lines = normalizeTesseractBlocks([{
    paragraphs: [{
      lines: [{
        text: '第一行',
        confidence: 92,
        bbox: { x0: 10, y0: 20, x1: 110, y1: 50 }
      }, {
        text: '第二行',
        confidence: 140,
        bbox: { x0: 20, y0: 60, x1: 180, y1: 90 }
      }]
    }]
  }])

  assert.deepEqual(lines, [{
    text: '第一行',
    confidence: 0.92,
    box: { x: 10, y: 20, width: 100, height: 30 }
  }, {
    text: '第二行',
    confidence: 1,
    box: { x: 20, y: 60, width: 160, height: 30 }
  }])
})

/**
 * 校验 Tesseract 引擎显式请求 blocks，并把结构化行框返回给文档流水线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('TesseractOcrEngine 应请求并返回结构化行框', async () => {
  let receivedOutput: unknown
  const engine = new TesseractOcrEngine({
    tessDataPath: '/tmp/tessdata',
    createWorker: async () => ({
      recognize: async (_input: unknown, _options?: unknown, output?: unknown) => {
        receivedOutput = output
        return {
          data: {
            text: '结构化文本',
            blocks: [{
              paragraphs: [{
                lines: [{
                  text: '结构化文本',
                  confidence: 88,
                  bbox: { x0: 12, y0: 24, x1: 132, y1: 54 }
                }]
              }]
            }]
          }
        }
      },
      setParameters: async () => undefined,
      terminate: async () => undefined
    })
  })

  const result = await engine.recognize({
    imageBytes: Buffer.from([1, 2, 3]),
    language: 'zh',
    timeoutMs: 500
  })

  assert.deepEqual(receivedOutput, { text: true, blocks: true })
  assert.deepEqual(result.lines[0]!.box, { x: 12, y: 24, width: 120, height: 30 })
  assert.equal(result.lines[0]!.confidence, 0.88)
})

/**
 * 校验缺少图片输入时抛出 engine-unavailable 错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('TesseractOcrEngine 缺少图片应抛出错误', async () => {
  const { TesseractOcrEngine } = await import('../src/main/tesseractOcr.ts')
  const engine = new TesseractOcrEngine({
    tessDataPath: '/tmp/tessdata',
    createWorker: async (_lang: string) => ({
      recognize: async (_input: unknown) => ({ data: { text: '' } }),
      setParameters: async (_params: unknown) => undefined,
      terminate: async () => undefined
    }),
    onProgress: () => undefined
  })
  await assert.rejects(
    () => engine.recognize({ timeoutMs: 200 }),
    (err: unknown) => {
      assert.ok(err instanceof OcrEngineError)
      assert.equal(err.code, 'engine-unavailable')
      return true
    }
  )
})

/**
 * 校验 Tesseract worker terminated 异常会转换为可展示的引擎错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('TesseractOcrEngine worker terminated 应转换为引擎不可用错误', async () => {
  const { TesseractOcrEngine } = await import('../src/main/tesseractOcr.ts')
  const engine = new TesseractOcrEngine({
    tessDataPath: '/tmp/tessdata',
    createWorker: async (_lang: string) => ({
      recognize: async (_input: unknown) => {
        throw new TypeError('terminated')
      },
      setParameters: async (_params: unknown) => undefined,
      terminate: async () => undefined
    }),
    onProgress: () => undefined
  })
  await assert.rejects(
    () => engine.recognize({ imageBytes: Buffer.from([1, 2, 3]), timeoutMs: 200 }),
    (err: unknown) => {
      assert.ok(err instanceof OcrEngineError)
      assert.equal(err.code, 'engine-unavailable')
      assert.equal(err.message, tForTest('zh-CN', 'ocr.error.tesseractInterrupted'))
      return true
    }
  )
})

/**
 * 校验 worker 创建失败的 Promise 不会污染缓存，后续识别应能重新创建并成功。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('TesseractOcrEngine worker 创建失败后应允许重试', async () => {
  const { TesseractOcrEngine } = await import('../src/main/tesseractOcr.ts')
  let createCount = 0
  const engine = new TesseractOcrEngine({
    tessDataPath: '/tmp/tessdata',
    createWorker: async (_lang: string) => {
      createCount += 1
      if (createCount === 1) {
        throw new Error("Error opening data file ./玂traineddata")
      }
      return {
        recognize: async (_input: unknown) => ({ data: { text: '第二次截图成功' } }),
        setParameters: async (_params: unknown) => undefined,
        terminate: async () => undefined
      }
    }
  })

  await assert.rejects(() => engine.recognize({
    imageBytes: Buffer.from([1, 2, 3]),
    timeoutMs: 200
  }))
  const result = await engine.recognize({
    imageBytes: Buffer.from([1, 2, 3]),
    timeoutMs: 200
  })

  assert.equal(createCount, 2)
  assert.equal(result.text, '第二次截图成功')
})

/**
 * 校验 worker 创建失败也应转换为可展示的引擎不可用错误，而不是泄漏原始英文堆栈。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('TesseractOcrEngine worker 创建失败应转换为引擎不可用错误', async () => {
  const { TesseractOcrEngine } = await import('../src/main/tesseractOcr.ts')
  const engine = new TesseractOcrEngine({
    tessDataPath: '/tmp/tessdata',
    createWorker: async (_lang: string) => {
      throw new Error("Error opening data file ./玂traineddata")
    }
  })

  await assert.rejects(
    () => engine.recognize({ imageBytes: Buffer.from([1, 2, 3]), timeoutMs: 200 }),
    (err: unknown) => {
      assert.ok(err instanceof OcrEngineError)
      assert.equal(err.code, 'engine-unavailable')
      assert.equal(err.engine, 'tesseract')
      return true
    }
  )
})
