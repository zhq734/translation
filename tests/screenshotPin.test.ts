import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_SCREENSHOT_PINS,
  clampPinBounds,
  clampPinOpacity,
  clampPinScale,
  fitPinScale,
  fitPinBounds
} from '../src/shared/screenshotPin'

/**
 * 校验贴图缩放倍率被限制在可用范围内。
 * @returns 无返回值。
 * @author zhenghq
 */
test('贴图缩放应限制在 0.1 到 8 倍', () => {
  assert.equal(clampPinScale(0.01), 0.1)
  assert.equal(clampPinScale(2.5), 2.5)
  assert.equal(clampPinScale(20), 8)
})

/**
 * 校验贴图透明度边界与显示窗口可接受范围一致。
 * @returns 无返回值。
 * @author zhenghq
 */
test('贴图透明度应限制在 0.05 到 1', () => {
  assert.equal(clampPinOpacity(0), 0.05)
  assert.equal(clampPinOpacity(0.5), 0.5)
  assert.equal(clampPinOpacity(2), 1)
})

/**
 * 校验首次贴图会按屏幕可用区域等比缩小并居中。
 * @returns 无返回值。
 * @author zhenghq
 */
test('贴图初始位置应在工作区内等比适配', () => {
  const bounds = fitPinBounds(
    { x: 0, y: 0, width: 4000, height: 2000 },
    { x: 100, y: 50, width: 1200, height: 800 }
  )
  assert.equal(bounds.width, 1200)
  assert.equal(bounds.height, 600)
  assert.equal(bounds.x, 100)
  assert.equal(bounds.y, 150)
  assert.equal(fitPinScale(
    { x: 0, y: 0, width: 4000, height: 2000 },
    { x: 100, y: 50, width: 1200, height: 800 }
  ), 0.3)
})

/**
 * 校验大图初始适配后的缩放倍率与窗口尺寸一致，避免首次滚轮缩放发生跳变。
 * @returns 无返回值。
 * @author zhenghq
 */
test('贴图大图初始适配后首次缩放不应跳变', () => {
  const scale = fitPinScale(
    { x: 0, y: 0, width: 4000, height: 2000 },
    { x: 0, y: 0, width: 1200, height: 800 }
  )
  assert.equal(scale, 0.3)
  assert.ok(Math.abs(scale * 4000 * (1 - 0.08) - 1104) < 1)
})

/**
 * 校验拖动后的贴图不会被完全移出工作区。
 * @returns 无返回值。
 * @author zhenghq
 */
test('贴图拖动位置应保留可抓取区域', () => {
  const bounds = clampPinBounds(
    { x: 5000, y: -500, width: 300, height: 200 },
    { x: 0, y: 0, width: 1000, height: 700 }
  )
  assert.ok(bounds.x <= 1000 - 48)
  assert.ok(bounds.x + bounds.width >= 48)
  assert.ok(bounds.y <= 700 - 48)
  assert.ok(bounds.y + bounds.height >= 48)
})

/**
 * 校验贴图实例数量上限。
 * @returns 无返回值。
 * @author zhenghq
 */
test('贴图实例上限应为 20', () => {
  assert.equal(MAX_SCREENSHOT_PINS, 20)
})
