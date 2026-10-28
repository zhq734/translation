import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DOCUMENT_PDF_CJK_FONT_RELATIVE_PATH,
  loadDocumentPdfFontBytes,
  resetDocumentPdfFontCache,
  resolveDocumentPdfFontPath
} from '../src/main/documentPdfFont.ts'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies: Record<string, string>
  build: {
    npmRebuild: boolean
    files: string[]
    asarUnpack: string[]
    mac: { extraResources: Array<{ from: string; to: string }> }
    win: { extraResources: Array<{ from: string; to: string }> }
    linux: { extraResources: Array<{ from: string; to: string }> }
  }
}

test('开发环境应从应用根目录读取内置 CJK 字体', () => {
  const path = resolveDocumentPdfFontPath({
    isPackaged: false,
    appPath: '/app',
    resourcesPath: '/app/resources'
  })

  assert.equal(path, `/app/${DOCUMENT_PDF_CJK_FONT_RELATIVE_PATH}`)
})

test('打包环境应从 Resources 根目录读取内置 CJK 字体', () => {
  const path = resolveDocumentPdfFontPath({
    isPackaged: true,
    appPath: '/app.asar',
    resourcesPath: '/Applications/Translator.app/Contents/Resources'
  })

  assert.equal(path, `/Applications/Translator.app/Contents/Resources/${DOCUMENT_PDF_CJK_FONT_RELATIVE_PATH}`)
})

test('字体读取失败时返回 null 并允许后续重试', async () => {
  resetDocumentPdfFontCache()
  let calls = 0
  const dependencies = {
    isPackaged: false,
    appPath: '/app',
    resourcesPath: '/resources',
    readFile: async () => {
      calls += 1
      throw new Error('missing')
    }
  }

  assert.equal(await loadDocumentPdfFontBytes(dependencies), null)
  assert.equal(await loadDocumentPdfFontBytes(dependencies), null)
  assert.equal(calls, 2)
})

test('字体读取成功后必须缓存字节避免重复 IO', async () => {
  resetDocumentPdfFontCache()
  let calls = 0
  const dependencies = {
    isPackaged: false,
    appPath: '/app',
    resourcesPath: '/resources',
    readFile: async () => {
      calls += 1
      return new Uint8Array([1, 2, 3])
    }
  }

  assert.deepEqual(await loadDocumentPdfFontBytes(dependencies), new Uint8Array([1, 2, 3]))
  assert.deepEqual(await loadDocumentPdfFontBytes(dependencies), new Uint8Array([1, 2, 3]))
  assert.equal(calls, 1)
})

test('PDF 字体与文档运行时依赖必须纳入打包配置', () => {
  for (const dependency of [
    'canvas',
    'path2d-polyfill',
    'pdfjs-dist',
    'pdf-lib',
    '@pdf-lib/fontkit',
    'jszip',
    'mammoth',
    'fast-xml-parser'
  ]) {
    assert.equal(typeof packageJson.dependencies[dependency], 'string', `${dependency} 应为直接依赖`)
    assert.ok(packageJson.build.files.includes(`node_modules/${dependency}/**/*`), `${dependency} 应进入安装包`)
  }
  assert.ok(packageJson.build.files.includes('assets/fonts/**/*'))
  assert.ok(packageJson.build.asarUnpack.includes('node_modules/canvas/**/*'))
})

test('Electron 打包必须重建原生依赖以匹配 canvas 的 Node ABI', () => {
  assert.equal(
    packageJson.build.npmRebuild,
    true,
    'canvas 是原生模块，npmRebuild=false 会把系统 Node ABI 的二进制带入 Electron 33 产物'
  )
})

test('三平台打包产物必须把 CJK 字体复制到 Resources 根目录', () => {
  for (const platform of ['mac', 'win', 'linux'] as const) {
    const resources = packageJson.build[platform].extraResources
    assert.ok(
      resources.some((entry) => entry.from === 'assets/fonts' && entry.to === 'assets/fonts'),
      `${platform} 必须声明字体 extraResources，否则打包后无法按 resourcesPath 读取`
    )
  }
})
