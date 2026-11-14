import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDocumentTableCellImageStackGroup,
  renderDocumentTableCellBlocks,
  resolveDocumentTableCellImageStackLayout,
  resolveDocumentImageStackBounds,
  resolveDocumentImageStackMemberOffset,
  setCssPixelPropertyIfChanged
} from '../src/renderer/src/documentImageStackLayout.ts'
import {
  createDocumentImageOverlayGroup,
  normalizeImageOverlayLayout,
  resolveDocumentImageOverlayBounds,
  resolveImageOverlayTextMaskColor
} from '../src/renderer/src/documentImageOverlayLayout.ts'
import type { DocumentImageBlock, DocumentTextBlock } from '../src/shared/documentTypes.ts'

/**
 * 构造叠放测试图片。
 * @param blockId 图片标识。
 * @param bbox 图片页面坐标。
 * @param stackOrder 叠放顺序。
 * @returns 图片区块。
 * @author zhenghq
 */
function stackedImage(
  blockId: string,
  bbox: DocumentImageBlock['bbox'],
  stackOrder: number
): DocumentImageBlock {
  return {
    kind: 'image',
    blockId,
    readingOrder: stackOrder,
    translatable: false,
    bbox,
    assetId: `${blockId}-asset`,
    stackGroupId: 'stack-group-1',
    stackOrder
  }
}

test('像素属性比较必须识别无单位旧值，不能因数值相同而跳过单位修正', () => {
  const values = new Map<string, string>([['--document-image-overlay-height', '452.93']])
  const element = {
    style: {
      getPropertyValue: (property: string) => values.get(property) ?? '',
      setProperty: (property: string, value: string) => values.set(property, value)
    }
  }

  const changed = setCssPixelPropertyIfChanged(
    element as unknown as HTMLElement,
    '--document-image-overlay-height',
    452.93
  )

  assert.equal(changed, true)
  assert.equal(values.get('--document-image-overlay-height'), '452.93px')
})

test('覆盖文字遮罩必须取底图不透明邻域颜色的平均值', () => {
  assert.equal(resolveImageOverlayTextMaskColor([
    { red: 118, green: 56, blue: 226, alpha: 255 },
    { red: 124, green: 58, blue: 236, alpha: 255 },
    { red: 255, green: 255, blue: 255, alpha: 0 }
  ]), 'rgb(121 57 231)')
  assert.equal(resolveImageOverlayTextMaskColor([
    { red: 255, green: 255, blue: 255, alpha: 0 }
  ]), undefined)
})

test('叠放图片边界必须取全部成员的并集而不是第一张图片', () => {
  const blocks = [
    stackedImage('back', { x: 0, y: 297.84, width: 595.92, height: 443.04 }, 0),
    stackedImage('middle', { x: 20.4, y: 319.44, width: 554.88, height: 382.56 }, 1),
    stackedImage('front', { x: 39.07, y: 333.92, width: 517.47, height: 344.98 }, 2)
  ]

  assert.deepEqual(resolveDocumentImageStackBounds(blocks), {
    x: 0,
    y: 297.84,
    width: 595.92,
    height: 443.04
  })
})

test('叠放成员必须相对组边界定位，不能再次使用原页面坐标', () => {
  const bounds = { x: 0, y: 297.84, width: 595.92, height: 443.04 }
  const middle = resolveDocumentImageStackMemberOffset(
    { x: 20.4, y: 319.44, width: 554.88, height: 382.56 },
    bounds
  )
  const front = resolveDocumentImageStackMemberOffset(
    { x: 39.07, y: 333.92, width: 517.47, height: 344.98 },
    bounds
  )
  // 坐标来自真实 PDF 的十进制点值，差值可能带浮点尾数，按亚像素容差比较。
  assert.ok(Math.abs(middle.left - 20.4) < 0.001)
  assert.ok(Math.abs(middle.top - 21.6) < 0.001)
  assert.ok(Math.abs(front.left - 39.07) < 0.001)
  assert.ok(Math.abs(front.top - 36.08) < 0.001)
})

test('表格单元格叠放图片必须按并集边界换算百分比坐标', () => {
  const blocks = [
    stackedImage('cell-back', { x: 330, y: 555, width: 150, height: 120 }, 0),
    stackedImage('cell-front', { x: 350, y: 575, width: 110, height: 80 }, 1)
  ]

  const layout = resolveDocumentTableCellImageStackLayout(blocks)

  assert.deepEqual(layout?.bounds, { x: 330, y: 555, width: 150, height: 120 })
  assert.deepEqual(layout?.members.map(({ block, left, top, width, height }) => ({
    blockId: block.blockId,
    left,
    top,
    width,
    height
  })), [
    { blockId: 'cell-back', left: 0, top: 0, width: 100, height: 100 },
    { blockId: 'cell-front', left: 13.333333333333334, top: 16.666666666666664, width: 73.33333333333333, height: 66.66666666666666 }
  ])
})

test('表格单元格叠放组必须只创建一个流式容器并按原始顺序定位成员', () => {
  type FakeElement = {
    className: string
    dataset: Record<string, string>
    children: FakeElement[]
    style: {
      values: Map<string, string>
      setProperty(property: string, value: string): void
      getPropertyValue(property: string): string
    }
    append(...children: FakeElement[]): void
  }
  const createFakeElement = (): FakeElement => {
    const values = new Map<string, string>()
    const element: FakeElement = {
      className: '',
      dataset: {},
      children: [],
      style: {
        values,
        setProperty: (property, value) => values.set(property, value),
        getPropertyValue: (property) => values.get(property) ?? ''
      },
      append: (...children) => { element.children.push(...children) }
    }
    return element
  }
  const previousDocument = (globalThis as typeof globalThis & { document?: unknown }).document
  ;(globalThis as typeof globalThis & { document?: unknown }).document = {
    createElement: () => createFakeElement()
  }
  try {
    const blocks = [
      stackedImage('cell-front', { x: 20, y: 10, width: 80, height: 80 }, 1),
      stackedImage('cell-back', { x: 0, y: 0, width: 100, height: 100 }, 0)
    ]
    const group = createDocumentTableCellImageStackGroup(
      blocks,
      (block) => {
        const element = createFakeElement()
        element.dataset.blockId = block.blockId
        return element as unknown as HTMLElement
      }
    ) as unknown as FakeElement

    assert.equal(group.className, 'document-image-stack document-table-cell-image-stack')
    assert.equal(group.dataset.tableCellImageStack, 'true')
    assert.deepEqual(group.children.map((child) => child.dataset.blockId), ['cell-back', 'cell-front'])
    assert.equal(group.children[1]!.style.getPropertyValue('--document-table-cell-image-member-left'), '20%')
    assert.equal(group.children[1]!.style.getPropertyValue('--document-table-cell-image-member-top'), '10%')
    assert.equal(group.children[1]!.style.getPropertyValue('--document-table-cell-image-member-width'), '80%')
    assert.equal(group.children[1]!.style.getPropertyValue('--document-table-cell-image-member-height'), '80%')
  } finally {
    ;(globalThis as typeof globalThis & { document?: unknown }).document = previousDocument
  }
})

test('历史快照没有 stackGroupId 时，表格渲染也必须用几何重叠合并为一次流式占位', () => {
  type FakeElement = {
    dataset: Record<string, string>
    children: FakeElement[]
    style: { setProperty(): void }
    append(...children: FakeElement[]): void
  }
  const createFakeElement = (): FakeElement => {
    const element: FakeElement = {
      dataset: {},
      children: [],
      style: { setProperty: () => undefined },
      append: (...children) => { element.children.push(...children) }
    }
    return element
  }
  const previousDocument = (globalThis as typeof globalThis & { document?: unknown }).document
  ;(globalThis as typeof globalThis & { document?: unknown }).document = {
    createElement: () => createFakeElement()
  }
  try {
    const blocks: DocumentImageBlock[] = [
      { ...stackedImage('legacy-back', { x: 0, y: 0, width: 100, height: 80 }, 0), stackGroupId: undefined, stackOrder: undefined },
      { ...stackedImage('legacy-front', { x: 20, y: 10, width: 60, height: 50 }, 1), stackGroupId: undefined, stackOrder: undefined },
      { ...stackedImage('separate', { x: 180, y: 0, width: 40, height: 40 }, 2), stackGroupId: undefined, stackOrder: undefined }
    ]
    const renderBlock = (block: DocumentImageBlock): FakeElement => {
      const element = createFakeElement()
      element.dataset.kind = 'block'
      element.dataset.blockId = block.blockId
      return element
    }
    const renderImage = (block: DocumentImageBlock): FakeElement => {
      const element = createFakeElement()
      element.dataset.kind = 'stack-member'
      element.dataset.blockId = block.blockId
      return element
    }

    const elements = renderDocumentTableCellBlocks(
      blocks,
      renderBlock as (block: DocumentImageBlock) => HTMLElement,
      renderImage as (block: DocumentImageBlock) => HTMLElement
    ) as unknown as FakeElement[]

    assert.equal(elements.length, 2)
    assert.equal(elements[0]!.dataset.tableCellImageStack, 'true')
    assert.deepEqual(elements[0]!.children.map((child) => child.dataset.blockId), [
      'legacy-back',
      'legacy-front'
    ])
    assert.equal(elements[1]!.dataset.kind, 'block')
    assert.equal(elements[1]!.dataset.blockId, 'separate')
  } finally {
    ;(globalThis as typeof globalThis & { document?: unknown }).document = previousDocument
  }
})

test('表格图片叠放范围内的文本必须原位覆盖，不能重复排在图片下方', () => {
  type FakeElement = {
    dataset: Record<string, string>
    children: FakeElement[]
    style: {
      values: Map<string, string>
      setProperty(property: string, value: string): void
      getPropertyValue(property: string): string
    }
    append(...children: FakeElement[]): void
  }
  const createFakeElement = (): FakeElement => {
    const values = new Map<string, string>()
    const element: FakeElement = {
      dataset: {},
      children: [],
      style: {
        values,
        setProperty: (property, value) => values.set(property, value),
        getPropertyValue: (property) => values.get(property) ?? ''
      },
      append: (...children) => { element.children.push(...children) }
    }
    return element
  }
  const previousDocument = (globalThis as typeof globalThis & { document?: unknown }).document
  ;(globalThis as typeof globalThis & { document?: unknown }).document = {
    createElement: () => createFakeElement()
  }
  try {
    const images = [
      stackedImage('table-back', { x: 100, y: 200, width: 300, height: 200 }, 0),
      stackedImage('table-front', { x: 120, y: 220, width: 260, height: 160 }, 1)
    ]
    const inside: DocumentTextBlock = {
      kind: 'text',
      blockId: 'table-inside-text',
      readingOrder: 2,
      translatable: true,
      role: 'paragraph',
      bbox: { x: 160, y: 280, width: 120, height: 10 },
      runs: [{ runId: 'table-inside-text-run', text: '原件内文字' }]
    }
    const outside: DocumentTextBlock = {
      ...inside,
      blockId: 'table-outside-text',
      readingOrder: 3,
      bbox: { x: 160, y: 430, width: 120, height: 10 }
    }
    const renderElement = (block: DocumentImageBlock | DocumentTextBlock): FakeElement => {
      const element = createFakeElement()
      element.dataset.blockId = block.blockId
      return element
    }

    const elements = renderDocumentTableCellBlocks(
      [...images, inside, outside],
      (block) => renderElement(block) as unknown as HTMLElement,
      (block) => renderElement(block) as unknown as HTMLElement,
      (block) => renderElement(block) as unknown as HTMLElement
    ) as unknown as FakeElement[]

    assert.equal(elements.length, 2)
    assert.equal(elements[0]!.dataset.tableCellImageStack, 'true')
    assert.deepEqual(elements[0]!.children.map((child) => child.dataset.blockId), [
      'table-back',
      'table-front',
      'table-inside-text'
    ])
    const text = elements[0]!.children[2]!
    assert.equal(text.dataset.tableCellImageText, 'true')
    assert.equal(text.style.getPropertyValue('--document-table-cell-image-text-left'), '20%')
    assert.equal(text.style.getPropertyValue('--document-table-cell-image-text-top'), '40%')
    assert.equal(text.style.getPropertyValue('--document-table-cell-image-text-width'), '40%')
    assert.equal(text.style.getPropertyValue('--document-table-cell-image-text-height'), '5%')
    assert.equal(elements[1]!.dataset.blockId, 'table-outside-text')
  } finally {
    ;(globalThis as typeof globalThis & { document?: unknown }).document = previousDocument
  }
})

test('图片覆盖组普通流边界必须只取全部底图并集', () => {
  const images = [
    stackedImage('back', { x: 0, y: 297.84, width: 595.92, height: 443.04 }, 0),
    stackedImage('front', { x: 39.07, y: 333.92, width: 517.47, height: 344.98 }, 2)
  ]
  const text: DocumentTextBlock = {
    kind: 'text',
    blockId: 'overlay-text',
    readingOrder: 3,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 43.92, y: 688.06, width: 506.18, height: 52 },
    overlayGroupId: 'stack-group-1',
    runs: [{ runId: 'overlay-text-run', text: '图内文字' }]
  }

  assert.deepEqual(resolveDocumentImageOverlayBounds(images, [text]), {
    x: 0,
    y: 297.84,
    width: 595.92,
    height: 443.04
  })
})

test('图内原生文字超出图片并集时也不能改变覆盖组普通流高度', () => {
  const images = [
    stackedImage('back', { x: 0, y: 100, width: 300, height: 240 }, 0)
  ]
  const text: DocumentTextBlock = {
    kind: 'text',
    blockId: 'overlay-long-text',
    readingOrder: 1,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 300, width: 200, height: 80 },
    overlayGroupId: 'stack-group-1',
    runs: [{ runId: 'overlay-long-text-run', text: '超出图片的文字' }]
  }

  assert.deepEqual(resolveDocumentImageOverlayBounds(images, [text]), {
    x: 0,
    y: 100,
    width: 300,
    height: 240
  })
})

test('覆盖组高度必须写回像素单位，避免 calc 得到无单位数值后塌陷为 0', () => {
  const styleValues = new Map<string, string>([
    ['--document-image-overlay-base-height', '443.04px'],
    ['--document-image-overlay-height', '443.04px']
  ])
  const overlayStyle = {
    getPropertyValue: (property: string) => styleValues.get(property) ?? '',
    setProperty: (property: string, value: string) => styleValues.set(property, value)
  }
  const overlay = {
    style: overlayStyle,
    getBoundingClientRect: () => ({ top: 733.289, bottom: 733.289, height: 0 }),
    // 只有底图或 OCR 译文可以扩大覆盖组；图内原生文字的实际行盒不能把后续正文向下推。
    querySelectorAll: (selector: string) => selector.includes('.document-image-block')
      ? [{ getBoundingClientRect: () => ({ top: 733.289, bottom: 1216.2026, height: 482.9136 }) }]
      : []
  }
  const pageStyle = new Map<string, string>([['--document-page-scale', '1.09']])
  const page = {
    isConnected: true,
    style: {
      getPropertyValue: (property: string) => pageStyle.get(property) ?? '',
      setProperty: (property: string, value: string) => pageStyle.set(property, value)
    },
    querySelectorAll: () => [overlay]
  }

  normalizeImageOverlayLayout(page as unknown as HTMLElement)

  const height = styleValues.get('--document-image-overlay-height') ?? ''
  assert.match(height, /px$/u, '覆盖组高度变量必须带像素单位，否则 calc 无法生成有效长度')
  assert.ok(Math.abs(Number.parseFloat(height) - 443.04) < 0.02,
    `图片实际底边未超出原始并集时不能改变覆盖组高度，实际=${height}`)
})

test('图内原生文字的实际行盒不能撑高覆盖组普通流占位', () => {
  const styleValues = new Map<string, string>([
    ['--document-image-overlay-base-height', '443.04px'],
    ['--document-image-overlay-height', '443.04px']
  ])
  const overlay = {
    style: {
      getPropertyValue: (property: string) => styleValues.get(property) ?? '',
      setProperty: (property: string, value: string) => styleValues.set(property, value)
    },
    getBoundingClientRect: () => ({ top: 733.289, bottom: 733.289, height: 0 }),
    querySelectorAll: (selector: string) => selector.includes('.document-text-block')
      ? [{ getBoundingClientRect: () => ({ top: 1159.58, bottom: 1220.47, height: 60.89 }) }]
      : []
  }
  const page = {
    isConnected: true,
    style: { getPropertyValue: () => '1.09', setProperty: () => undefined },
    querySelectorAll: () => [overlay]
  }

  normalizeImageOverlayLayout(page as unknown as HTMLElement)

  assert.equal(styleValues.get('--document-image-overlay-height'), '443.04px',
    '图内文字即使实际行盒超出图片，也不能把覆盖组和后续正文向下推')
})

test('图内文字译文换行超出原始 bbox 底边时必须扩展覆盖组普通流高度', () => {
  const styleValues = new Map<string, string>([
    ['--document-image-overlay-base-height', '443.04px'],
    ['--document-image-overlay-height', '443.04px']
  ])
  const memberStyle = {
    getPropertyValue: (property: string) => property === '--document-image-overlay-text-top'
      ? '390.22px'
      : property === '--document-image-overlay-text-height' ? '28px' : ''
  }
  const overlay = {
    style: {
      getPropertyValue: (property: string) => styleValues.get(property) ?? '',
      setProperty: (property: string, value: string) => styleValues.set(property, value)
    },
    getBoundingClientRect: () => ({ top: 733.289, bottom: 733.289, height: 0 }),
    querySelectorAll: (selector: string) => selector.includes('.document-text-block')
      ? [{
          style: memberStyle,
          getBoundingClientRect: () => ({ top: 1158.63, bottom: 1256.49, height: 97.86 })
        }]
      : []
  }
  const page = {
    isConnected: true,
    style: { getPropertyValue: () => '1.09', setProperty: () => undefined },
    querySelectorAll: () => [overlay]
  }

  normalizeImageOverlayLayout(page as unknown as HTMLElement)

  const height = styleValues.get('--document-image-overlay-height') ?? ''
  assert.match(height, /px$/u, '覆盖组高度变量必须带像素单位')
  assert.ok(Math.abs(Number.parseFloat(height) - 480) < 0.02,
    `译文换行超出原始 bbox 底边时必须扩展覆盖组高度，实际=${height}`)
})

test('图内文字行盒超出图片底边但仍在原始 bbox 预留空间内时不得扩展覆盖组高度', () => {
  const styleValues = new Map<string, string>([
    ['--document-image-overlay-base-height', '443.04px'],
    ['--document-image-overlay-height', '443.04px']
  ])
  const memberStyle = {
    getPropertyValue: (property: string) => property === '--document-image-overlay-text-top'
      ? '400px'
      : property === '--document-image-overlay-text-height' ? '47px' : ''
  }
  const overlay = {
    style: {
      getPropertyValue: (property: string) => styleValues.get(property) ?? '',
      setProperty: (property: string, value: string) => styleValues.set(property, value)
    },
    getBoundingClientRect: () => ({ top: 733.289, bottom: 733.289, height: 0 }),
    querySelectorAll: (selector: string) => selector.includes('.document-text-block')
      ? [{
          style: memberStyle,
          getBoundingClientRect: () => ({ top: 1169.29, bottom: 1220.47, height: 51.18 })
        }]
      : []
  }
  const page = {
    isConnected: true,
    style: { getPropertyValue: () => '1.09', setProperty: () => undefined },
    querySelectorAll: () => [overlay]
  }

  normalizeImageOverlayLayout(page as unknown as HTMLElement)

  assert.equal(styleValues.get('--document-image-overlay-height'), '443.04px',
    '原始 bbox 本身越出图片底边的预留部分是既有占位，不能再次向下推正文')
})

test('覆盖组实际测量高度为 0 时仍必须保留原始并集高度', () => {
  const styleValues = new Map<string, string>([
    ['--document-image-overlay-base-height', '84px'],
    ['--document-image-overlay-height', '84px']
  ])
  const overlay = {
    style: {
      getPropertyValue: (property: string) => styleValues.get(property) ?? '',
      setProperty: (property: string, value: string) => styleValues.set(property, value)
    },
    getBoundingClientRect: () => ({ top: 1069.02, bottom: 1069.02, height: 0 }),
    querySelectorAll: () => []
  }
  const page = {
    isConnected: true,
    style: { getPropertyValue: () => '1.09', setProperty: () => undefined },
    querySelectorAll: () => [overlay]
  }

  normalizeImageOverlayLayout(page as unknown as HTMLElement)

  assert.equal(styleValues.get('--document-image-overlay-height'), '84px')
})

test('覆盖组必须记录原生文字 bbox 高度，并保持底部四图与箭头的原始叠放顺序', () => {
  type FakeElement = {
    className: string
    dataset: Record<string, string>
    children: FakeElement[]
    style: {
      values: Map<string, string>
      setProperty(property: string, value: string): void
      getPropertyValue(property: string): string
    }
    append(...children: FakeElement[]): void
  }
  const createFakeElement = (): FakeElement => {
    const values = new Map<string, string>()
    return {
      className: '',
      dataset: {},
      children: [],
      style: {
        values,
        setProperty: (property, value) => values.set(property, value),
        getPropertyValue: (property) => values.get(property) ?? ''
      },
      append: (...children) => {
        for (const child of children) values.set('child', child.dataset.blockId ?? '')
      }
    }
  }
  const previousDocument = (globalThis as typeof globalThis & { document?: unknown }).document
  const fakeDocument = {
    createElement: () => {
      const element = createFakeElement()
      const originalAppend = element.append
      element.append = (...children) => {
        element.children.push(...children)
        originalAppend(...children)
      }
      return element
    }
  }
  ;(globalThis as typeof globalThis & { document?: unknown }).document = fakeDocument
  try {
    const images = [
      { ...stackedImage('bottom-image', { x: 0, y: 779.76, width: 595.92, height: 63.12 }, 0), overlayGroupId: 'overlay-bottom' },
      { ...stackedImage('caption-image', { x: 20.4, y: 801.36, width: 554.88, height: 39.36 }, 1), overlayGroupId: 'overlay-bottom' },
      { ...stackedImage('icon-back', { x: 507.36, y: 758.88, width: 72.48, height: 72.72 }, 2), overlayGroupId: 'overlay-bottom' },
      { ...stackedImage('icon-front', { x: 525.84, y: 772.08, width: 35.52, height: 35.76 }, 3), overlayGroupId: 'overlay-bottom' }
    ]
    const arrow: DocumentTextBlock = {
      kind: 'text',
      blockId: 'overlay-arrow',
      readingOrder: 4,
      translatable: true,
      role: 'paragraph',
      bbox: { x: 540.16, y: 784.01, width: 6.47, height: 8.62 },
      overlayGroupId: 'overlay-bottom',
      runs: [{ runId: 'overlay-arrow-run', text: '↑' }]
    }
    const renderElement = (block: DocumentImageBlock | DocumentTextBlock): FakeElement => {
      const element = createFakeElement()
      element.dataset.blockId = block.blockId
      return element
    }

    const overlay = createDocumentImageOverlayGroup(
      images,
      [arrow],
      595.92,
      (block) => renderElement(block) as unknown as HTMLElement,
      (block) => renderElement(block) as unknown as HTMLElement
    ) as unknown as FakeElement

    assert.deepEqual(overlay.children.map((child) => child.dataset.blockId), [
      'bottom-image',
      'caption-image',
      'icon-back',
      'icon-front',
      'overlay-arrow'
    ])
    assert.equal(overlay.children[4]!.style.getPropertyValue('--document-image-overlay-text-height'), '8.62px')
    assert.equal(overlay.style.getPropertyValue('--document-image-overlay-base-height'), '84px')
  } finally {
    ;(globalThis as typeof globalThis & { document?: unknown }).document = previousDocument
  }
})
