import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { formatUpdateProgressText } from '../src/shared/updateProgressFormat.ts'

test('更新进度文本应展示百分比、已下载量与瞬时速度', () => {
  assert.equal(
    formatUpdateProgressText({
      percent: 52.34,
      transferred: 52_428_800,
      total: 104_857_600,
      bytesPerSecond: 2_097_152
    }),
    '52.3% · 50.0 MB / 100.0 MB · 2.0 MB/s'
  )
})

test('更新进度文本在缺少总长度时只展示百分比与已下载量', () => {
  assert.equal(
    formatUpdateProgressText({
      percent: 0,
      transferred: 1024,
      total: 0,
      bytesPerSecond: 512
    }),
    '已下载 1.0 KB · 512 B/s'
  )
})

test('更新进度文本在速度未知时不应显示 0 B/s', () => {
  assert.equal(
    formatUpdateProgressText({
      percent: 0,
      transferred: 0,
      total: 104_857_600,
      bytesPerSecond: 0
    }),
    '0.0% · 0 B / 100.0 MB'
  )
})

test('更新进度文本应把百分比限制在 0 到 100 之间', () => {
  assert.match(
    formatUpdateProgressText({
      percent: 148,
      transferred: 104_857_600,
      total: 104_857_600,
      bytesPerSecond: 0
    }),
    /^100\.0%/u
  )
  assert.match(
    formatUpdateProgressText({
      percent: -12,
      transferred: 0,
      total: 104_857_600,
      bytesPerSecond: 0
    }),
    /^0\.0%/u
  )
})

test('设置页更新面板应复用共享进度格式化函数', () => {
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')

  assert.match(source, /formatUpdateProgressText/u)
  assert.match(
    source,
    /updateProgressText\.textContent = formatUpdateProgressText\(progress\)/u
  )
})
