import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  POPUP_AUTO_SIZE_LIMITS,
  isPopupAutoSizeRequest,
  resolvePopupAutoSize,
  resolvePopupResizeBounds
} from '../src/shared/popupAutoSize.ts'

const workArea = { x: 0, y: 0, width: 1920, height: 1080 }

/**
 * 校验内容测量结果会被收敛到允许区间，避免弹窗过大或过小。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗自适应尺寸应取整并收敛到允许区间', () => {
  assert.deepEqual(resolvePopupAutoSize({ width: 9999, height: 9999 }, workArea), {
    width: POPUP_AUTO_SIZE_LIMITS.maxWidth,
    height: POPUP_AUTO_SIZE_LIMITS.maxHeight
  })
  assert.deepEqual(resolvePopupAutoSize({ width: 1, height: 1 }, workArea), {
    width: POPUP_AUTO_SIZE_LIMITS.minWidth,
    height: POPUP_AUTO_SIZE_LIMITS.minHeight
  })
  assert.deepEqual(resolvePopupAutoSize({ width: 560.6, height: 384.2 }, workArea), {
    width: 561,
    height: 384
  })
})

/**
 * 校验小屏幕工作区会压过尺寸上下限，保证窗口始终放得下。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗自适应尺寸不得超出工作区可用区域', () => {
  const small = { x: 100, y: 50, width: 500, height: 400 }
  const size = resolvePopupAutoSize({ width: 900, height: 900 }, small, { edgeGap: 8 })

  assert.equal(size.width, small.width - 16)
  assert.equal(size.height, small.height - 16)
})

/**
 * 校验放大弹窗时保持左上锚点，越界时向内收拢。
 * @returns 无返回值。
 * @author zhenghq
 */
test('放大弹窗应保持锚点并收拢进工作区', () => {
  const kept = resolvePopupResizeBounds(
    { x: 300, y: 200, width: 460, height: 360 },
    { width: 560, height: 520 },
    workArea
  )
  assert.deepEqual(kept, { x: 300, y: 200, width: 560, height: 520 })

  const clamped = resolvePopupResizeBounds(
    { x: 1500, y: 900, width: 460, height: 360 },
    { width: 640, height: 620 },
    workArea
  )
  assert.equal(clamped.x + clamped.width, workArea.width)
  assert.equal(clamped.y + clamped.height, workArea.height)
})

/**
 * 校验非法尺寸负载会被拒绝，避免渲染进程异常值直接作用到窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗尺寸负载应校验数值合法性', () => {
  assert.equal(isPopupAutoSizeRequest({ width: 520, height: 480 }), true)
  assert.equal(isPopupAutoSizeRequest({ width: 0, height: 480 }), false)
  assert.equal(isPopupAutoSizeRequest({ width: 520, height: Number.NaN }), false)
  assert.equal(isPopupAutoSizeRequest({ width: '520', height: 480 }), false)
  assert.equal(isPopupAutoSizeRequest(null), false)
})

/**
 * 校验自适应最小宽度足以容纳单行顶部栏，避免默认弹窗顶部栏换行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗最小宽度应保证顶部栏单行不换行', () => {
  const styles = readFileSync('src/renderer/src/style.css', 'utf8')
  const popupMain = readFileSync('src/main/popup.ts', 'utf8')

  assert.ok(
    POPUP_AUTO_SIZE_LIMITS.minWidth >= 520,
    '最小宽度需 >= 520，才能容纳标题、三个图标、翻译 API 与关闭按钮'
  )
  assert.match(popupMain, /minWidth:\s*520/u)
  assert.match(styles, /\.header-top\s*\{[^}]*flex-wrap:\s*nowrap/su)
  assert.doesNotMatch(styles, /\.header-top\s*\{[^}]*flex-wrap:\s*wrap/su)
  assert.doesNotMatch(styles, /\.provider-bar\s*\{[^}]*flex:\s*1\s+1\s+100%/su)
})

/**
 * 校验渲染进程在内容变化后测量并上报尺寸，主进程复用共享边界计算。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗自适应尺寸应贯通渲染进程、preload 与主进程', () => {
  const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  const types = readFileSync('src/shared/types.ts', 'utf8')
  const main = readFileSync('src/main/index.ts', 'utf8')
  const popupMain = readFileSync('src/main/popup.ts', 'utf8')

  assert.match(renderer, /function measureAutoSize/u)
  assert.match(renderer, /function requestAutoResize/u)
  assert.match(renderer, /window\.api\.resizePopup\(/u)
  assert.match(preload, /resizePopup\(size: PopupAutoSizeRequest\)/u)
  assert.match(preload, /ipcRenderer\.send\('popup:resize', size\)/u)
  assert.match(types, /resizePopup\(size: PopupAutoSizeRequest\): void/u)
  assert.match(main, /ipcMain\.on\('popup:resize'/u)
  assert.match(main, /isPopupAutoSizeRequest/u)
  assert.match(popupMain, /export function resizePopup\(/u)
  assert.match(popupMain, /resolvePopupResizeBounds\(/u)
})
