import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  hasNativeBuildForceFlag,
  isNativeBuildUpToDate
} from '../scripts/lib/native-build-cache.mjs'

/**
 * 创建带指定修改时间的临时文件。
 * @param directory 临时目录。
 * @param name 文件名。
 * @param mtimeSeconds 文件修改时间（秒）。
 * @returns 文件绝对路径。
 * @author zhenghq
 */
function createFile(directory: string, name: string, mtimeSeconds: number): string {
  const path = join(directory, name)
  writeFileSync(path, name)
  utimesSync(path, mtimeSeconds, mtimeSeconds)
  return path
}

test('原生构建产物不早于全部输入时应判定为可跳过', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-build-cache-'))
  try {
    const source = createFile(directory, 'source.m', 100)
    const output = createFile(directory, 'helper', 200)

    assert.equal(isNativeBuildUpToDate([output], [source]), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('原生输入更新或任一产物缺失时应要求重新构建', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-build-cache-'))
  try {
    const source = createFile(directory, 'source.m', 300)
    const output = createFile(directory, 'helper', 200)
    const missingOutput = join(directory, 'missing-helper')

    assert.equal(isNativeBuildUpToDate([output], [source]), false)
    assert.equal(isNativeBuildUpToDate([output, missingOutput], [source]), false)
    assert.equal(isNativeBuildUpToDate([output], [join(directory, 'missing-source.m')]), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('原生构建应支持 --force 强制重建', () => {
  assert.equal(hasNativeBuildForceFlag(['--force']), true)
  assert.equal(hasNativeBuildForceFlag(['--verbose']), false)
})

test('macOS 原生构建脚本应默认增量跳过并支持 --force', () => {
  const cacheHelper = readFileSync('scripts/lib/native-build-cache.mjs', 'utf8')
  assert.match(cacheHelper, /up to date/u)
  for (const path of [
    'scripts/build-macos-vision-ocr.mjs',
    'scripts/build-macos-ax-reader.mjs',
    'scripts/build-macos-window-helper.mjs',
    'scripts/build-macos-screen-capture.mjs',
    'scripts/build-macos-subtitle-audio.mjs'
  ]) {
    const source = readFileSync(path, 'utf8')
    assert.match(source, /hasNativeBuildForceFlag/u, `${path} 应解析 --force`)
    assert.match(source, /isNativeBuildUpToDate/u, `${path} 应比较输入与产物修改时间`)
    assert.match(source, /logNativeBuildUpToDate/u, `${path} 应输出可诊断的跳过日志`)
  }
})
