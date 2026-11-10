import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 读取源码文件行数，用于约束超大核心文件继续膨胀。
 * @param path 相对项目根目录的源码路径。
 * @returns 文件行数。
 * @author zhenghq
 */
function sourceLineCount(path: string): number {
  return readFileSync(path, 'utf8').split(/\r?\n/u).length
}

test('主进程入口应按 IPC 领域拆分，避免继续承载全部注册逻辑', () => {
  assert.ok(sourceLineCount('src/main/index.ts') < 7_900, 'src/main/index.ts 应低于 7900 行')
  for (const path of [
    'src/main/ipc/subtitleIpc.ts',
    'src/main/ipc/popupIpc.ts',
    'src/main/ipc/documentIpc.ts',
    'src/main/ipc/webReaderIpc.ts',
    'src/main/ipc/ocrIpc.ts',
    'src/main/ipc/translationIpc.ts',
    'src/main/ipc/settingsIpc.ts',
    'src/main/ipc/updaterIpc.ts'
  ]) {
    assert.equal(existsSync(path), true, `${path} 应存在`)
  }
})

test('文档工作台入口应按历史、导出和导航职责拆分', () => {
  assert.ok(sourceLineCount('src/renderer/src/document.ts') < 7_000, 'document.ts 应低于 7000 行')
  for (const path of [
    'src/renderer/src/documentHistoryController.ts',
    'src/renderer/src/documentNavigationController.ts',
    'src/renderer/src/documentExportController.ts'
  ]) {
    assert.equal(existsSync(path), true, `${path} 应存在`)
  }
})
