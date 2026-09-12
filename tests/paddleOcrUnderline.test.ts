import assert from 'node:assert/strict'
import test from 'node:test'
import { restorePaddleOcrUnderlines } from '../src/main/paddleOcrUnderline.ts'
import { PaddleOcrEngine } from '../src/main/paddleOcr.ts'
import { encodePng } from '../src/main/pngCodec.ts'
import type { RgbaImage } from '../src/shared/imagePreprocess.ts'

/**
 * 创建指定尺寸的纯色 RGBA 测试图像。
 * @param width 图像宽度。
 * @param height 图像高度。
 * @param background 背景灰度值（0-255）。
 * @returns 测试图像。
 * @author zhenghq
 */
function makeImage(width: number, height: number, background = 255): RgbaImage {
  const image: RgbaImage = { width, height, data: new Uint8Array(width * height * 4) }
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = background
    image.data[offset + 1] = background
    image.data[offset + 2] = background
    image.data[offset + 3] = 255
  }
  return image
}

/**
 * 在测试图像上填充矩形区域。
 * @param image 目标图像。
 * @param x0 起始横坐标（含）。
 * @param y0 起始纵坐标（含）。
 * @param x1 结束横坐标（含）。
 * @param y1 结束纵坐标（含）。
 * @param value 灰度值（0-255）。
 * @returns 无返回值。
 * @author zhenghq
 */
function fillRect(
  image: RgbaImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value: number
): void {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const offset = (y * image.width + x) * 4
      image.data[offset] = value
      image.data[offset + 1] = value
      image.data[offset + 2] = value
      image.data[offset + 3] = 255
    }
  }
}

/**
 * 绘制一个由多个字符块组成的单词，块之间保留固定字符间隙。
 * @param image 目标图像。
 * @param startX 单词起始横坐标。
 * @param glyphCount 字符块数量。
 * @param glyphWidth 单字符块宽度。
 * @param glyphGap 字符间隙宽度。
 * @param value 灰度值。
 * @returns 单词结束后的下一个横坐标。
 * @author zhenghq
 */
function drawWord(
  image: RgbaImage,
  startX: number,
  glyphCount: number,
  glyphWidth: number,
  glyphGap: number,
  value: number
): number {
  let x = startX
  for (let index = 0; index < glyphCount; index += 1) {
    fillRect(image, x, 8, x + glyphWidth - 1, 26, value)
    x += glyphWidth + glyphGap
  }
  return x
}

/** 覆盖词间下划线场景的行盒。 */
const LINE_BOX = { x: 0, y: 0, width: 140, height: 36 }

/**
 * 校验词间存在横线时应把 OCR 丢失的下划线恢复出来。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 词间横线应恢复为下划线', () => {
  const image = makeImage(200, 44)
  drawWord(image, 4, 4, 6, 1, 20)
  drawWord(image, 50, 4, 6, 1, 20)
  fillRect(image, 32, 32, 47, 34, 20)

  assert.equal(restorePaddleOcrUnderlines('user name', LINE_BOX, image), 'user_name')
})

/**
 * 校验词间没有横线时应保留普通空格，避免把英文短语误改成下划线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 无词间横线应保留空格', () => {
  const image = makeImage(200, 44)
  drawWord(image, 4, 4, 6, 1, 20)
  drawWord(image, 50, 4, 6, 1, 20)

  assert.equal(restorePaddleOcrUnderlines('user name', LINE_BOX, image), 'user name')
})

/**
 * 校验字形中部的连字符不应被当成下划线恢复。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 字形中部横线不应恢复', () => {
  const image = makeImage(200, 44)
  drawWord(image, 4, 4, 6, 1, 20)
  drawWord(image, 50, 4, 6, 1, 20)
  fillRect(image, 32, 16, 47, 18, 20)

  assert.equal(restorePaddleOcrUnderlines('user name', LINE_BOX, image), 'user name')
})

/**
 * 校验同一行多个词间下划线可以全部恢复。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 应恢复同一行多个下划线', () => {
  const image = makeImage(260, 44)
  drawWord(image, 4, 2, 7, 1, 20)
  drawWord(image, 50, 2, 7, 1, 20)
  drawWord(image, 96, 2, 7, 1, 20)
  fillRect(image, 27, 32, 47, 34, 20)
  fillRect(image, 73, 32, 93, 34, 20)

  const box = { x: 0, y: 0, width: 130, height: 36 }
  assert.equal(restorePaddleOcrUnderlines('aa bb cc', box, image), 'aa_bb_cc')
})

/**
 * 校验字符间细小间隙不会被误判成词边界。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 字符间隙不应影响下划线定位', () => {
  const image = makeImage(200, 44)
  drawWord(image, 4, 4, 6, 3, 20)
  drawWord(image, 50, 4, 6, 3, 20)
  fillRect(image, 32, 32, 47, 34, 20)

  assert.equal(restorePaddleOcrUnderlines('user name', LINE_BOX, image), 'user_name')
})

/**
 * 校验词间间隙过窄（无法与字符间隙区分）时保守保留原文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 词间无有效间隙应保守返回原文', () => {
  const image = makeImage(200, 44)
  fillRect(image, 4, 8, 30, 26, 20)
  fillRect(image, 33, 8, 60, 26, 20)

  assert.equal(restorePaddleOcrUnderlines('user name', LINE_BOX, image), 'user name')
})

/**
 * 校验深色背景下同样可以恢复下划线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 深色背景应恢复下划线', () => {
  const image = makeImage(200, 44, 0)
  drawWord(image, 4, 4, 6, 1, 240)
  drawWord(image, 50, 4, 6, 1, 240)
  fillRect(image, 32, 32, 47, 34, 240)

  assert.equal(restorePaddleOcrUnderlines('user name', LINE_BOX, image), 'user_name')
})

/**
 * 绘制包含两处词内下划线的三词行：det_model_dir。
 * @returns 渲染后的图像与行盒。
 * @author zhenghq
 */
function drawWordInternalUnderlineImage(): RgbaImage {
  const image = makeImage(200, 44)
  drawWord(image, 4, 3, 6, 1, 20)
  fillRect(image, 25, 32, 38, 34, 20)
  drawWord(image, 39, 5, 6, 1, 20)
  fillRect(image, 74, 32, 87, 34, 20)
  drawWord(image, 88, 3, 6, 1, 20)
  return image
}

/**
 * 校验词内下划线被识别成空格时可全部恢复。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 词内下划线应恢复为下划线', () => {
  const image = drawWordInternalUnderlineImage()
  const box = { x: 0, y: 0, width: 120, height: 36 }

  assert.equal(restorePaddleOcrUnderlines('det model dir', box, image), 'det_model_dir')
})

/**
 * 校验 OCR 已识别的词内下划线不会因其它空格未命中而被丢弃。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 部分识别的下划线应保留并补全', () => {
  const image = drawWordInternalUnderlineImage()
  const box = { x: 0, y: 0, width: 120, height: 36 }

  assert.equal(restorePaddleOcrUnderlines('det model_dir', box, image), 'det_model_dir')
})

/**
 * 校验同样布局下缺少横线像素时保留普通空格。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 词内无横线应保留空格', () => {
  const image = makeImage(200, 44)
  drawWord(image, 4, 3, 6, 1, 20)
  drawWord(image, 39, 5, 6, 1, 20)
  drawWord(image, 88, 3, 6, 1, 20)
  const box = { x: 0, y: 0, width: 120, height: 36 }

  assert.equal(restorePaddleOcrUnderlines('det model dir', box, image), 'det model dir')
})

/**
 * 绘制同一行内既有下划线又有真实空格的配置文本。
 * 文本内容为 det_model_dir models/ch_PP-OCRv3_det_infer。
 * @returns 渲染后的图像。
 * @author zhenghq
 */
function drawMixedUnderlineAndSpaceImage(): RgbaImage {
  const image = makeImage(560, 44)
  const glyphWidth = 6
  const glyphGap = 1
  const underlineGap = 8
  const spaceGap = 16
  const words = [3, 5, 3, 9, 9, 3, 5]
  const separators: Array<'under' | 'space'> = [
    'under',
    'under',
    'space',
    'under',
    'under',
    'under'
  ]

  let x = 4
  for (let index = 0; index < words.length; index += 1) {
    const wordEnd = drawWord(image, x, words[index]!, glyphWidth, glyphGap, 20)
    if (index >= separators.length) {
      x = wordEnd
      continue
    }
    const gap = separators[index] === 'under' ? underlineGap : spaceGap
    if (separators[index] === 'under') {
      fillRect(image, wordEnd, 32, wordEnd + gap - 1, 34, 20)
    }
    x = wordEnd + gap
  }
  return image
}

/**
 * 校验整行合并框内应同时保留真实空格并恢复下划线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 整行合并框应保留空格并恢复下划线', () => {
  const image = drawMixedUnderlineAndSpaceImage()
  const box = { x: 0, y: 0, width: 300, height: 36 }

  assert.equal(
    restorePaddleOcrUnderlines('det model dir models/ch PP-OCRv3 det infer', box, image),
    'det_model_dir models/ch_PP-OCRv3_det_infer'
  )
})

/**
 * 绘制下划线后紧跟真实空格的场景：OCR 会把下划线与相邻空格合并成一个宽间隙，
 * 下划线自身只占其中一个字符格。文本内容为 det_model dir。
 * @returns 渲染后的图像。
 * @author zhenghq
 */
function drawUnderlineFollowedBySpaceImage(): RgbaImage {
  const image = makeImage(200, 44)
  const glyphWidth = 6
  const glyphGap = 1
  const secondWordEnd = drawWord(image, 4, 3, glyphWidth, glyphGap, 20)
  fillRect(image, secondWordEnd, 32, secondWordEnd + 6, 34, 20)
  drawWord(image, secondWordEnd + 14, 3, glyphWidth, glyphGap, 20)
  return image
}

/**
 * 校验下划线后紧跟真实空格、下划线只覆盖一个字符格时仍能恢复，
 * 且紧随其后的真实空格应保持不变。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 下划线后接真实空格时应恢复', () => {
  const image = drawUnderlineFollowedBySpaceImage()

  assert.equal(
    restorePaddleOcrUnderlines('det model dir', LINE_BOX, image),
    'det_model dir'
  )
})

/**
 * 绘制下划线落在行盒下沿之外的场景：检测框未覆盖下划线所在的行。
 * 文本内容为 det_model。
 * @returns 渲染后的图像。
 * @author zhenghq
 */
function drawUnderlineOutsideBoxImage(): RgbaImage {
  const image = makeImage(200, 52)
  const glyphWidth = 10
  const glyphGap = 2
  const firstWordEnd = drawWord(image, 4, 3, glyphWidth, glyphGap, 20)
  fillRect(image, firstWordEnd, 45, firstWordEnd + 11, 47, 20)
  drawWord(image, firstWordEnd + 12, 5, glyphWidth, glyphGap, 20)
  return image
}

/**
 * 校验下划线位于行盒下沿之外时仍能在行盒下方兜底找到横线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 下划线在行盒外时应恢复', () => {
  const image = drawUnderlineOutsideBoxImage()

  assert.equal(restorePaddleOcrUnderlines('det model', LINE_BOX, image), 'det_model')
})

/**
 * 绘制小字号等宽字体场景：下划线墨迹很薄，会抬高列墨迹高度，
 * 使下划线列无法形成空白间隙，只能在字形像素中直接寻找横线。
 * 文本内容为 det_model_dir。
 * @returns 渲染后的图像。
 * @author zhenghq
 */
function drawThinUnderlineImage(): RgbaImage {
  const image = makeImage(200, 20)
  const glyphWidth = 6
  const glyphGap = 1
  const drawThinWord = (startX: number, glyphCount: number, value: number): number => {
    let x = startX
    for (let index = 0; index < glyphCount; index += 1) {
      fillRect(image, x, 2, x + glyphWidth - 1, 6, value)
      x += glyphWidth + glyphGap
    }
    return x
  }
  const firstWordEnd = drawThinWord(4, 3, 20)
  fillRect(image, firstWordEnd, 11, firstWordEnd + 5, 12, 20)
  const secondWordEnd = drawThinWord(firstWordEnd + 6, 5, 20)
  fillRect(image, secondWordEnd, 11, secondWordEnd + 5, 12, 20)
  drawThinWord(secondWordEnd + 6, 3, 20)
  return image
}

/**
 * 校验小字号下划线墨迹很薄、无法形成空白间隙时仍能恢复下划线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 薄下划线无法形成间隙时应恢复', () => {
  const image = drawThinUnderlineImage()
  const box = { x: 0, y: 0, width: 120, height: 15 }

  assert.equal(restorePaddleOcrUnderlines('det model dir', box, image), 'det_model_dir')
})

/**
 * 校验缺少行盒或行盒无效时直接返回原文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('restorePaddleOcrUnderlines 无效行盒应返回原文', () => {
  const image = makeImage(200, 44)
  assert.equal(restorePaddleOcrUnderlines('user name', undefined, image), 'user name')
  assert.equal(
    restorePaddleOcrUnderlines('user name', { x: 0, y: 0, width: 0, height: 0 }, image),
    'user name'
  )
})

/**
 * 校验 PaddleOCR 引擎在识别下划线为空格时会按截图像素恢复出来。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('PaddleOcrEngine 应恢复被识别成空格的下划线', async () => {
  const image = makeImage(200, 44)
  drawWord(image, 4, 4, 6, 1, 20)
  drawWord(image, 50, 4, 6, 1, 20)
  fillRect(image, 32, 32, 47, 34, 20)
  const imageBytes = encodePng(image)

  const engine = new PaddleOcrEngine({
    tmpDir: () => '/tmp',
    writeFile: async () => undefined,
    unlink: async () => undefined,
    readFile: async () => imageBytes,
    createOcrNode: async () => ({
      detect: async () => [{
        text: 'user name',
        box: [[0, 0], [140, 0], [140, 36], [0, 36]],
        confidence: 0.95
      }]
    })
  })

  const result = await engine.recognize({ imageBytes, language: 'en' })

  assert.equal(result.text, 'user_name')
})

/**
 * 校验没有下划线像素时引擎不会改写普通英文短语。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('PaddleOcrEngine 无下划线像素应保留空格', async () => {
  const image = makeImage(200, 44)
  drawWord(image, 4, 4, 6, 1, 20)
  drawWord(image, 50, 4, 6, 1, 20)
  const imageBytes = encodePng(image)

  const engine = new PaddleOcrEngine({
    tmpDir: () => '/tmp',
    writeFile: async () => undefined,
    unlink: async () => undefined,
    readFile: async () => imageBytes,
    createOcrNode: async () => ({
      detect: async () => [{
        text: 'user name',
        box: [[0, 0], [140, 0], [140, 36], [0, 36]],
        confidence: 0.95
      }]
    })
  })

  const result = await engine.recognize({ imageBytes, language: 'en' })

  assert.equal(result.text, 'user name')
})
