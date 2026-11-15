import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computePronunciationCardPlacement,
  type PronunciationCardPlacementInput
} from '../src/renderer/src/pronunciationCardPosition'

/** 构造定位输入基线：640x640 弹窗内一个位于 (100,100)-(160,124) 的触发词。@author zhenghq */
function buildInput(overrides: Partial<PronunciationCardPlacementInput> = {}): PronunciationCardPlacementInput {
  return {
    anchorRect: { left: 100, top: 100, right: 160, bottom: 124 },
    cardSize: { width: 280, height: 300 },
    popupSize: { width: 640, height: 640 },
    ...overrides
  }
}

/** 验证默认展示在触发词下方并与其左缘对齐；无参数、无返回值。@author zhenghq */
test('音标卡默认展示在触发词下方', () => {
  const placement = computePronunciationCardPlacement(buildInput())
  assert.deepEqual(placement, { left: 100, top: 132, placement: 'below' })
})

/** 验证下方空间不足时翻转到触发词上方；无参数、无返回值。@author zhenghq */
test('下方空间不足时音标卡翻转到触发词上方', () => {
  const placement = computePronunciationCardPlacement(buildInput({
    anchorRect: { left: 100, top: 400, right: 160, bottom: 424 }
  }))
  assert.equal(placement.placement, 'above')
  assert.equal(placement.top, 92)
})

/** 验证上下都放不下时回退下方并把卡片夹进弹窗可视区；无参数、无返回值。@author zhenghq */
test('上下都放不下时回退下方并夹在弹窗边界内', () => {
  const placement = computePronunciationCardPlacement(buildInput({
    anchorRect: { left: 100, top: 300, right: 160, bottom: 324 },
    cardSize: { width: 280, height: 500 }
  }))
  assert.equal(placement.placement, 'below')
  assert.equal(placement.top, 128)
})

/** 验证卡片横向越界时被夹回弹窗边界内；无参数、无返回值。@author zhenghq */
test('触发词靠近左右边缘时卡片横向夹在弹窗边界内', () => {
  const rightClamped = computePronunciationCardPlacement(buildInput({
    anchorRect: { left: 600, top: 100, right: 640, bottom: 124 }
  }))
  assert.equal(rightClamped.left, 348)

  const leftClamped = computePronunciationCardPlacement(buildInput({
    anchorRect: { left: 0, top: 100, right: 40, bottom: 124 }
  }))
  assert.equal(leftClamped.left, 12)
})

/** 验证卡片比弹窗还宽时按最小边距左对齐，不产生负偏移；无参数、无返回值。@author zhenghq */
test('卡片比弹窗还宽时按最小边距左对齐', () => {
  const placement = computePronunciationCardPlacement(buildInput({
    cardSize: { width: 700, height: 300 }
  }))
  assert.equal(placement.left, 12)
})
