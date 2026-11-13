import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  normalizeDocumentSearchQuery,
  resolveDocumentSearchStep
} from '../src/renderer/src/documentSearchController.ts'

test('正文检索必须规范化空白查询并循环计算上一项与下一项', () => {
  assert.equal(normalizeDocumentSearchQuery('  合同  '), '合同')
  assert.equal(normalizeDocumentSearchQuery('   '), '')
  assert.equal(resolveDocumentSearchStep(0, 0, 1), -1)
  assert.equal(resolveDocumentSearchStep(2, 3, 1), 0)
  assert.equal(resolveDocumentSearchStep(0, 3, -1), 2)
  assert.equal(resolveDocumentSearchStep(1, 3, 1), 2)
})

test('正文检索控制器必须同时遍历双栏、循环导航并保持流式重绘后的结果', () => {
  const source = readFileSync('src/renderer/src/documentSearchController.ts', 'utf8')

  assert.match(source, /getSourceContent\(\): HTMLElement/u)
  assert.match(source, /getTranslationContent\(\): HTMLElement/u)
  assert.match(source, /querySelectorAll<HTMLElement>/u)
  assert.match(source, /\.document-text-run\[data-run-id\]/u)
  assert.match(source, /\.document-ocr-region-text/u)
  assert.match(source, /\.document-toc-title/u)
  assert.match(source, /\.document-ocr-text-region/u)
  assert.match(source, /getClientRects\(\)\.length > 0/u)
  assert.match(source, /scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/u)
  assert.match(source, /event\.key === 'Enter'[\s\S]*?event\.shiftKey \? -1 : 1/u)
  assert.match(source, /event\.key === 'Escape'[\s\S]*?clear\(\)/u)
  assert.match(source, /refresh\(\): void/u)
  assert.match(source, /document\.search\.result/u)
  assert.match(source, /document\.search\.empty/u)
})

test('正文检索必须分别遍历原文与译文栏，不跨栏去重', () => {
  const source = readFileSync('src/renderer/src/documentSearchController.ts', 'utf8')

  assert.match(
    source,
    /for \(const container of \[dependencies\.getSourceContent\(\), dependencies\.getTranslationContent\(\)\]\)/u
  )
  assert.match(source, /matches\.push\(\{ range, element \}\)/u)
  assert.doesNotMatch(source, /new Set\([^)]*range/iu)
})
