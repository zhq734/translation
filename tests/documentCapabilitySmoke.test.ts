import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

/** 文档能力冒烟脚本路径。 */
const RUNNER_PATH = 'scripts/document-capability-smoke.mjs'

/** 在 Electron 内执行的冒烟入口路径。 */
const ENTRY_PATH = 'scripts/document-capability-smoke-entry.ts'

/**
 * 读取项目文本文件。
 * @param path 相对项目根目录的路径。
 * @returns 文件文本。
 * @author zhenghq
 */
function read(path: string): string {
  return readFileSync(path, 'utf8')
}

test('文档能力冒烟必须提供可重复执行的 npm 命令与 Electron 运行入口', () => {
  const packageJson = JSON.parse(read('package.json')) as {
    scripts?: Record<string, string>
  }

  assert.equal(packageJson.scripts?.['document:smoke'], 'node scripts/document-capability-smoke.mjs')
  assert.equal(existsSync(RUNNER_PATH), true)
  assert.equal(existsSync(ENTRY_PATH), true)

  const runner = read(RUNNER_PATH)
  assert.match(runner, /from 'esbuild'/u)
  assert.match(runner, /ELECTRON_RUN_AS_NODE:\s*'1'/u)
  assert.match(runner, /createRequire\(join\(projectRoot, 'package\.json'\)\)/u)
  assert.match(runner, /mkdtempSync/u)
  assert.match(runner, /rmSync\(temporaryDirectory, \{ recursive: true, force: true \}\)/u)
})

test('文档能力冒烟必须覆盖 PDF 原生文本、扫描页 OCR 和 PDF 回读', () => {
  const entry = read(ENTRY_PATH)

  for (const expected of [
    'parsePdfDocument',
    'createProductionPdfRasterizer',
    'exportDocumentToPdf',
    'tests/fixtures/document/sample.pdf',
    'assets/fonts/NotoSansSC-Regular.ttf',
    'ocr-required',
    'ocrRegions',
    'translatedText',
    'getTextContent'
  ]) {
    assert.match(entry, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), expected)
  }
})

test('文档能力冒烟必须验证 Canvas 矢量绘制颜色未退化为黑色', () => {
  const entry = read(ENTRY_PATH)

  assert.match(entry, /function verifyCanvasColorRendering\(/u)
  assert.match(entry, /verifyCanvasColorRendering\(\)/u)
  assert.match(entry, /canvasVectorColor/u)
})
