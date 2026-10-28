import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import {
  DOCUMENT_MAX_FILE_BYTES,
  getDocumentZipCentralDirectoryRange,
  validateDocumentFile
} from '../src/shared/documentFormat.ts'
import type { DocumentFileSelectionResult } from '../src/shared/types.ts'

/**
 * 构造最小 PDF 文件头，供文件校验测试复用。
 * @returns PDF 文件头字节。
 * @author zhenghq
 */
function pdfHead(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.7\n')
}

/**
 * 构造最小 DOCX 包文件头；真实解析仍由后续 ZIP/OOXML 适配器负责。
 * @returns 包含 OOXML 关键路径的 ZIP 文件头字节。
 * @author zhenghq
 */
function docxHead(): Uint8Array {
  return new TextEncoder().encode(
    'PK\u0003\u0004[Content_Types].xml word/document.xml'
  )
}

/**
 * 构造中央目录位于文件末尾、正文条目不在 8KB 文件头内的 DOCX。
 * @returns 完整 DOCX 字节。
 * @author zhenghq
 */
async function docxWithLateDocumentEntry(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  zip.file('word/media/filler.bin', new Uint8Array(20 * 1024))
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>')
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
}

/**
 * 构造中央目录超过 256KB 的 DOCX，用于验证分段读取中央目录。
 * @returns 完整 DOCX 字节。
 * @author zhenghq
 */
async function docxWithLargeCentralDirectory(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  for (let index = 0; index < 6000; index += 1) {
    zip.file(`word/media/filler-${String(index).padStart(5, '0')}.bin`, '')
  }
  zip.file('word/document.xml', '<w:document/>')
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
}

test('取消选择与校验失败必须是不同结果，失败结果不得携带文件或任务字段', () => {
  const cancelled: DocumentFileSelectionResult = { status: 'cancelled' }
  const rejected: DocumentFileSelectionResult = {
    status: 'rejected',
    code: 'invalid-header',
    format: 'pdf'
  }

  assert.equal(cancelled.status, 'cancelled')
  assert.equal('file' in cancelled, false)
  assert.equal(rejected.status, 'rejected')
  assert.equal('file' in rejected, false)
  assert.equal('capabilities' in rejected, false)
})

test('文件选择结果只能使用明确的拒绝分类', () => {
  const codes: DocumentFileSelectionResult['status'][] = ['selected', 'cancelled', 'rejected']
  assert.deepEqual(codes, ['selected', 'cancelled', 'rejected'])
})

test('PDF 与 DOCX 文件头校验通过并返回格式能力', () => {
  const pdf = validateDocumentFile({
    fileName: 'paper.pdf',
    size: 2048,
    head: pdfHead()
  })
  assert.equal(pdf.ok, true)
  if (!pdf.ok) return
  assert.equal(pdf.format, 'pdf')
  assert.equal(pdf.capabilities.nativeLayout, true)

  const docx = validateDocumentFile({
    fileName: 'report.docx',
    size: 4096,
    head: docxHead()
  })
  assert.equal(docx.ok, true)
  if (!docx.ok) return
  assert.equal(docx.format, 'docx')
  assert.equal(docx.capabilities.ocrEmbeddedImages, true)
})

test('DOCX 正文条目位于 8KB 之后时应通过 ZIP 中央目录识别', async () => {
  const bytes = await docxWithLateDocumentEntry()
  const head = bytes.subarray(0, 8192)
  const tail = bytes.subarray(Math.max(0, bytes.length - 256 * 1024))

  assert.equal(new TextDecoder('latin1').decode(head).includes('word/document.xml'), false)
  const result = validateDocumentFile({
    fileName: 'late-document-entry.docx',
    size: bytes.length,
    head,
    tail
  })
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.format : null, 'docx')
})

test('DOCX 中央目录超出尾部窗口时仍应识别', async () => {
  const bytes = await docxWithLargeCentralDirectory()
  const head = bytes.subarray(0, 8192)
  const tail = bytes.subarray(Math.max(0, bytes.length - 256 * 1024))
  const range = getDocumentZipCentralDirectoryRange(tail, bytes.length)
  assert.ok(range)
  if (!range) return
  assert.ok(range.end - range.start > tail.length)

  const result = validateDocumentFile({
    fileName: 'large-directory.docx',
    size: bytes.length,
    head,
    tail,
    zipDirectory: bytes.subarray(range.start, range.end)
  })
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.format : null, 'docx')
})

test('仅扩展名为 docx 的普通 ZIP 仍应被拒绝', async () => {
  const zip = new JSZip()
  zip.file('notes/readme.txt', 'not an OOXML package')
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const result = validateDocumentFile({
    fileName: 'renamed.docx',
    size: bytes.length,
    head: bytes.subarray(0, 8192),
    tail: bytes.subarray(Math.max(0, bytes.length - 256 * 1024))
  })
  assert.deepEqual(result, { ok: false, code: 'invalid-header', format: 'docx' })
})

test('普通 ZIP 正文包含 OOXML 标记文本时仍不得误判', async () => {
  const zip = new JSZip()
  zip.file('notes/readme.txt', '[Content_Types].xml word/document.xml')
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const result = validateDocumentFile({
    fileName: 'renamed.docx',
    size: bytes.length,
    head: bytes.subarray(0, 8192),
    tail: bytes.subarray(Math.max(0, bytes.length - 256 * 1024))
  })
  assert.deepEqual(result, { ok: false, code: 'invalid-header', format: 'docx' })
})

test('格式、空文件、超大与不可读必须在创建任务前分别拒绝', () => {
  assert.deepEqual(validateDocumentFile({
    fileName: 'malware.exe',
    size: 10,
    head: new TextEncoder().encode('MZ')
  }), { ok: false, code: 'unsupported-format' })

  assert.deepEqual(validateDocumentFile({
    fileName: 'paper.pdf',
    size: 10,
    head: new TextEncoder().encode('not a pdf')
  }), { ok: false, code: 'invalid-header', format: 'pdf' })

  assert.deepEqual(validateDocumentFile({
    fileName: 'empty.txt',
    size: 0,
    head: new Uint8Array()
  }), { ok: false, code: 'empty-file', format: 'txt' })

  assert.deepEqual(validateDocumentFile({
    fileName: 'large.pdf',
    size: DOCUMENT_MAX_FILE_BYTES + 1,
    head: pdfHead()
  }), { ok: false, code: 'too-large', format: 'pdf' })

  assert.deepEqual(validateDocumentFile({
    fileName: 'locked.pdf',
    size: 1024,
    head: pdfHead(),
    readable: false
  }), { ok: false, code: 'unreadable', format: 'pdf' })
})

test('文件选择 API 与拖放预检必须复用同一校验函数', async () => {
  const { readFileSync } = await import('node:fs')
  const main = readFileSync('src/main/index.ts', 'utf8')
  const renderer = readFileSync('src/renderer/src/document.ts', 'utf8')
  const preload = readFileSync('src/preload/index.ts', 'utf8')

  assert.match(main, /validateDocumentFile\(/u)
  assert.match(main, /DOCUMENT_MAX_FILE_BYTES/u)
  assert.match(main, /showOpenDialog\(/u)
  assert.match(main, /document:select-file/u)
  assert.match(renderer, /validateDocumentFile\(/u)
  assert.match(renderer, /DOCUMENT_HEAD_BYTES/u)
  assert.match(renderer, /DOCUMENT_ZIP_TAIL_BYTES/u)
  assert.match(renderer, /getDocumentZipCentralDirectoryRange/u)
  assert.match(preload, /getPathForFile/u)
})

test('文件选择 IPC 必须校验发送者并只读取有限文件头', async () => {
  const { readFileSync } = await import('node:fs')
  const main = readFileSync('src/main/index.ts', 'utf8')
  assert.match(main, /documentWorkspace\?\.ownsWindow/u)
  assert.match(main, /openFile\(/u)
  assert.match(main, /stat\(/u)
  assert.match(main, /DOCUMENT_HEAD_BYTES|8192/u)
  assert.match(main, /DOCUMENT_ZIP_TAIL_BYTES/u)
  assert.match(main, /getDocumentZipCentralDirectoryRange/u)
  assert.match(main, /isFile\(\)/u)
  assert.match(main, /status: 'rejected',\s*code: 'unreadable'/u)
})
