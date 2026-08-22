/** 剪贴板图片最小结构（Electron NativeImage 结构兼容）。 */
export interface ClipboardImageLike {
  /** 是否为空图。 */
  isEmpty(): boolean
  /** 导出 PNG 字节。 */
  toPNG(): Buffer
}

/** 剪贴板最小结构（Electron clipboard 结构兼容，便于注入测试）。 */
export interface ClipboardLike {
  /** 读取剪贴板图片。 */
  readImage(): ClipboardImageLike
  /** 读取剪贴板文本。 */
  readText(type?: string): string
}

/** 剪贴板内容分类。 */
export type ClipboardImageKind = 'image' | 'text' | 'empty'

/** 剪贴板图片读取结果。 */
export interface ClipboardImageResult {
  /** 内容分类：图片 / 仅文本 / 空。 */
  kind: ClipboardImageKind
  /** 图片 PNG 字节，仅 kind 为 image 时存在。 */
  png?: Buffer
}

/**
 * 读取剪贴板图片并分类：图片、仅文本、空。
 * 分类结果用于区分"剪贴板没有图片"与"识别为空"等提示。
 * @param clipboard 剪贴板对象（测试可注入）。
 * @returns 分类结果；图片时附带 PNG 字节。
 * @author zhenghq
 */
export function readClipboardImage(clipboard: ClipboardLike): ClipboardImageResult {
  const image = clipboard.readImage()
  if (image && !image.isEmpty()) {
    return { kind: 'image', png: image.toPNG() }
  }
  const text = clipboard.readText('')
  if (text.trim()) return { kind: 'text' }
  return { kind: 'empty' }
}
