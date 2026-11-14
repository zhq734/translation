import assert from 'node:assert/strict'
import test from 'node:test'
import { extractPdfImageRegions } from '../src/main/documentPdfParser.ts'

/**
 * 构造测试用 PDF.js 运行时，仅需提供操作符常量表。
 * @returns 最小 PDF.js 运行时。
 * @author zhenghq
 */
function createRuntime(): { OPS: Record<string, number> } {
  return {
    OPS: {
      save: 1,
      restore: 2,
      transform: 3,
      paintFormXObjectBegin: 4,
      paintFormXObjectEnd: 5,
      paintImageXObject: 6,
      paintInlineImageXObject: 7,
      paintImageXObjectRepeat: 8,
      paintInlineImageXObjectGroup: 9,
      paintImageMaskXObject: 10,
      paintImageMaskXObjectGroup: 11,
      paintImageMaskXObjectRepeat: 12,
      beginGroup: 13,
      endGroup: 14
    }
  }
}

/**
 * 把操作符序列包装成 PDF.js 操作符列表结构。
 * @param ops 操作符与参数的有序序列。
 * @returns 操作符列表。
 * @author zhenghq
 */
function createOperatorList(
  ops: Array<[number, unknown[]]>
): { fnArray: number[]; argsArray: unknown[][] } {
  return {
    fnArray: ops.map(([operation]) => operation),
    argsArray: ops.map(([, args]) => args)
  }
}

const VIEWPORT = { width: 595.92, height: 842.88 }

test('软掩膜组内的图片绘制不应生成可见图片区块', () => {
  const runtime = createRuntime()
  const operatorList = createOperatorList([
    // 模拟 PDF.js 对亮度软掩膜组的输出：beginGroup(smask) → 画掩膜图 → endGroup。
    [runtime.OPS['beginGroup']!, [{ bbox: [0, 0, 100, 100], smask: { subtype: 'Luminosity' }, isolated: true, knockout: false }]],
    [runtime.OPS['save']!, []],
    [runtime.OPS['transform']!, [474, 0, 0, 333, 60, 100]],
    [runtime.OPS['paintImageXObject']!, ['img_shadow_mask']],
    [runtime.OPS['restore']!, []],
    [runtime.OPS['endGroup']!, []],
    // 普通可见图片保持在掩膜组之外。
    [runtime.OPS['transform']!, [400, 0, 0, 300, 80, 140]],
    [runtime.OPS['paintImageXObject']!, ['img_card']]
  ])

  const regions = extractPdfImageRegions(operatorList, runtime as never, VIEWPORT)

  assert.equal(regions.length, 1)
  assert.equal(regions[0]!.objectId, 'img_card')
})

test('普通透明组内的图片仍是可见图片区块', () => {
  const runtime = createRuntime()
  const operatorList = createOperatorList([
    [runtime.OPS['beginGroup']!, [{ bbox: [0, 0, 100, 100], smask: null, isolated: true, knockout: false }]],
    [runtime.OPS['transform']!, [400, 0, 0, 300, 50, 100]],
    [runtime.OPS['paintImageXObject']!, ['img_normal']],
    [runtime.OPS['endGroup']!, []]
  ])

  const regions = extractPdfImageRegions(operatorList, runtime as never, VIEWPORT)

  assert.equal(regions.length, 1)
  assert.equal(regions[0]!.objectId, 'img_normal')
})

test('软掩膜组结束后绘制的图片应正常生成区块', () => {
  const runtime = createRuntime()
  const operatorList = createOperatorList([
    [runtime.OPS['beginGroup']!, [{ smask: { subtype: 'Luminosity' } }]],
    [runtime.OPS['save']!, []],
    [runtime.OPS['transform']!, [400, 0, 0, 300, 50, 100]],
    [runtime.OPS['paintImageXObject']!, ['img_mask']],
    [runtime.OPS['restore']!, []],
    [runtime.OPS['endGroup']!, []],
    [runtime.OPS['transform']!, [400, 0, 0, 300, 50, 100]],
    [runtime.OPS['paintImageXObject']!, ['img_visible']]
  ])

  const regions = extractPdfImageRegions(operatorList, runtime as never, VIEWPORT)

  assert.equal(regions.length, 1)
  assert.equal(regions[0]!.objectId, 'img_visible')
})

test('软掩膜组内嵌套普通组时仍应排除图片区块', () => {
  const runtime = createRuntime()
  const operatorList = createOperatorList([
    [runtime.OPS['beginGroup']!, [{ smask: { subtype: 'Luminosity' } }]],
    [runtime.OPS['beginGroup']!, [{ smask: null, isolated: true, knockout: false }]],
    [runtime.OPS['save']!, []],
    [runtime.OPS['transform']!, [400, 0, 0, 300, 50, 100]],
    [runtime.OPS['paintImageXObject']!, ['img_nested']],
    [runtime.OPS['restore']!, []],
    [runtime.OPS['endGroup']!, []],
    [runtime.OPS['endGroup']!, []]
  ])

  const regions = extractPdfImageRegions(operatorList, runtime as never, VIEWPORT)

  assert.equal(regions.length, 0)
})

test('软掩膜组内的图片掩膜绘制不应生成区块，组外仍生成', () => {
  const runtime = createRuntime()
  const operatorList = createOperatorList([
    [runtime.OPS['beginGroup']!, [{ smask: { subtype: 'Luminosity' } }]],
    [runtime.OPS['save']!, []],
    [runtime.OPS['transform']!, [400, 0, 0, 300, 50, 100]],
    [runtime.OPS['paintImageMaskXObject']!, [{ data: new Uint8Array(16), width: 4, height: 4 }]],
    [runtime.OPS['restore']!, []],
    [runtime.OPS['endGroup']!, []],
    [runtime.OPS['transform']!, [400, 0, 0, 300, 50, 100]],
    [runtime.OPS['paintImageMaskXObject']!, [{ data: new Uint8Array(16), width: 4, height: 4 }]]
  ])

  const regions = extractPdfImageRegions(operatorList, runtime as never, VIEWPORT)

  assert.equal(regions.length, 1)
})
