import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampDocumentWindowBounds,
  resolveRestoredDocumentWindowBounds,
  type DocumentWindowBounds,
  type DocumentWindowDisplay
} from '../src/shared/documentWindowBounds.ts'

/**
 * 构造窗口边界。
 * @param x 横坐标。
 * @param y 纵坐标。
 * @param width 宽度。
 * @param height 高度。
 * @returns 窗口边界。
 * @author zhenghq
 */
function bounds(x: number, y: number, width: number, height: number): DocumentWindowBounds {
  return { x, y, width, height }
}

/**
 * 构造显示器工作区。
 * @param x 横坐标。
 * @param y 纵坐标。
 * @param width 宽度。
 * @param height 高度。
 * @returns 显示器工作区。
 * @author zhenghq
 */
function display(x: number, y: number, width: number, height: number): DocumentWindowDisplay {
  return { workArea: bounds(x, y, width, height) }
}

test('恢复窗口时必须优先落在仍有足够可见区域的显示器', () => {
  const displays = [display(0, 0, 1920, 1080), display(1920, 0, 2560, 1440)]
  const restored = resolveRestoredDocumentWindowBounds(
    bounds(2100, 100, 1180, 780),
    displays,
    { width: 900, height: 620 },
    { width: 1180, height: 780 }
  )
  assert.deepEqual(restored, bounds(2100, 100, 1180, 780))
})

test('显示器断开后必须把窗口移回主工作区并保持最小尺寸', () => {
  const restored = resolveRestoredDocumentWindowBounds(
    bounds(4200, 200, 1180, 780),
    [display(0, 0, 1440, 900)],
    { width: 900, height: 620 },
    { width: 1180, height: 780 }
  )
  assert.deepEqual(restored, bounds(130, 60, 1180, 780))
})

test('过小或超出工作区的历史尺寸必须被夹到可用范围', () => {
  const restored = resolveRestoredDocumentWindowBounds(
    bounds(-300, -100, 400, 300),
    [display(0, 0, 1280, 720)],
    { width: 900, height: 620 },
    { width: 1180, height: 780 }
  )
  assert.deepEqual(restored, bounds(0, 0, 900, 620))
})

test('没有显示器或历史边界非法时必须返回默认尺寸', () => {
  const fallback = { width: 1180, height: 780 }
  assert.deepEqual(
    resolveRestoredDocumentWindowBounds(null, [], { width: 900, height: 620 }, fallback),
    { width: 1180, height: 780 }
  )
  assert.deepEqual(
    resolveRestoredDocumentWindowBounds(
      { x: Number.NaN, y: 10, width: 100, height: 100 },
      [display(0, 0, 1280, 720)],
      { width: 900, height: 620 },
      fallback
    ),
    { width: 1180, height: 780 }
  )
})

test('当前窗口边界必须夹紧到显示器工作区', () => {
  assert.deepEqual(
    clampDocumentWindowBounds(
      bounds(-50, 30, 2000, 2000),
      display(0, 0, 1280, 720),
      { width: 900, height: 620 }
    ),
    bounds(0, 0, 1280, 720)
  )
})
