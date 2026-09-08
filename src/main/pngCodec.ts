import { deflateSync, inflateSync } from 'node:zlib'
import type { RgbaImage } from '../shared/imagePreprocess'

/** PNG 解码错误。 */
export class PngDecodeError extends Error {
  /**
   * 创建 PNG 解码错误。
   * @param message 错误描述。
   * @author zhenghq
   */
  constructor(message: string) {
    super(message)
    this.name = 'PngDecodeError'
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

let crcTable: Uint32Array | null = null

/**
 * 惰性构建 CRC32 查找表。
 * @returns CRC32 查找表。
 * @author zhenghq
 */
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  crcTable = table
  return table
}

/**
 * 计算 PNG 块 CRC32。
 * @param bytes 参与校验的字节（块类型 + 数据）。
 * @returns CRC32 值。
 * @author zhenghq
 */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 将经过滤镜的扫描线流展开为像素字节。
 * 支持 None/Sub/Up/Average/Paeth 五种滤镜，逐行还原。
 * @param raw 滤镜编码后的扫描线数据（每行首字节为滤镜类型）。
 * @param width 图像宽度。
 * @param height 图像高度。
 * @param bpp 每像素字节数（1/2/3/4）。
 * @returns 展开后的像素字节。
 * @author zhenghq
 */
export function expandScanlines(
  raw: Uint8Array,
  width: number,
  height: number,
  bpp: number
): Uint8Array {
  const stride = width * bpp
  const out = new Uint8Array(height * stride)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    const filter = raw[rowStart]
    const line = out.subarray(y * stride, (y + 1) * stride)
    const previous = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowStart + 1 + x]
      const left = x >= bpp ? line[x - bpp] : 0
      const up = previous ? previous[x] : 0
      const upLeft = previous && x >= bpp ? previous[x - bpp] : 0
      let reconstructed = 0
      switch (filter) {
        case 0:
          reconstructed = value
          break
        case 1:
          reconstructed = value + left
          break
        case 2:
          reconstructed = value + up
          break
        case 3:
          reconstructed = value + ((left + up) >> 1)
          break
        case 4: {
          const predictor = left + up - upLeft
          const diffLeft = Math.abs(predictor - left)
          const diffUp = Math.abs(predictor - up)
          const diffUpLeft = Math.abs(predictor - upLeft)
          const paeth = diffLeft <= diffUp && diffLeft <= diffUpLeft
            ? left
            : diffUp < diffUpLeft
              ? up
              : upLeft
          reconstructed = value + paeth
          break
        }
        default:
          throw new PngDecodeError(`不支持的 PNG 滤镜类型：${filter}`)
      }
      line[x] = reconstructed & 0xff
    }
  }
  return out
}

interface PngHeader {
  width: number
  height: number
  bitDepth: number
  colorType: number
}

/**
 * 解析 PNG 块结构，提取 IHDR 头与 IDAT 数据。
 * @param buffer PNG 字节。
 * @returns 头部信息与拼接后的 IDAT 原始数据。
 * @author zhenghq
 */
function parseChunks(buffer: Uint8Array): { header: PngHeader; idat: Uint8Array } {
  if (buffer.length < 8 || PNG_SIGNATURE.some((byte, i) => buffer[i] !== byte)) {
    throw new PngDecodeError('不是合法的 PNG 文件签名')
  }
  const header: PngHeader = { width: 0, height: 0, bitDepth: 0, colorType: 0 }
  const idatParts: Uint8Array[] = []
  let offset = 8
  while (offset < buffer.length) {
    if (buffer.length < offset + 8) throw new PngDecodeError('PNG 块长度不完整')
    const length = Number(((buffer[offset] << 24) | (buffer[offset + 1] << 16) |
      (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0)
    const type = String.fromCharCode(buffer[offset + 4], buffer[offset + 5], buffer[offset + 6], buffer[offset + 7])
    const dataStart = offset + 8
    if (buffer.length < dataStart + length + 4) throw new PngDecodeError('PNG 数据块越界')
    const data = buffer.subarray(dataStart, dataStart + length)
    if (type === 'IHDR') {
      header.width = Number((data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0)
      header.height = Number((data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7]) >>> 0)
      header.bitDepth = data[8]
      header.colorType = data[9]
      if (data[12] !== 0) throw new PngDecodeError('不支持隔行扫描的 PNG')
    } else if (type === 'IDAT') {
      idatParts.push(data)
    }
    offset = dataStart + length + 4
  }
  const idatLength = idatParts.reduce((sum, part) => sum + part.length, 0)
  const idat = new Uint8Array(idatLength)
  let cursor = 0
  for (const part of idatParts) {
    idat.set(part, cursor)
    cursor += part.length
  }
  return { header, idat }
}

/**
 * 将单通道像素值转换为 8 位值（16 位深度取高字节）。
 * @param value 原始像素值。
 * @param bitDepth 位深度。
 * @returns 8 位像素值。
 * @author zhenghq
 */
function toEightBits(value: number, bitDepth: number): number {
  return bitDepth === 16 ? value >> 8 : value
}

/**
 * 解码 PNG 字节为 RGBA 图像。
 * 支持位深度 8/16，颜色类型 0（灰度）/2（RGB）/4（灰度+Alpha）/6（RGBA），非隔行。
 * @param buffer PNG 字节。
 * @returns RGBA 图像。
 * @author zhenghq
 */
export function decodePng(buffer: Uint8Array): RgbaImage {
  const { header, idat } = parseChunks(buffer)
  const { width, height, bitDepth, colorType } = header
  if (!width || !height) throw new PngDecodeError('PNG 尺寸非法')
  if (bitDepth !== 8 && bitDepth !== 16) throw new PngDecodeError(`不支持的位深度：${bitDepth}`)
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : -1
  if (channels < 0) throw new PngDecodeError(`不支持的颜色类型：${colorType}`)
  const bytesPerPixel = channels * (bitDepth / 8)
  const stride = width * bytesPerPixel
  const inflated = new Uint8Array(inflateSync(Buffer.from(idat)))
  const expected = height * (stride + 1)
  if (inflated.length < expected) throw new PngDecodeError('PNG 扫描线数据不完整')
  const raw = inflated.subarray(0, expected)
  const pixels = expandScanlines(raw, width, height, bytesPerPixel)
  const data = new Uint8Array(width * height * 4)
  const sourceStride = width * bytesPerPixel
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * sourceStride + x * bytesPerPixel)
      const target = (y * width + x) * 4
      if (colorType === 0) {
        const gray = toEightBits(pixels[source], bitDepth)
        data[target] = gray
        data[target + 1] = gray
        data[target + 2] = gray
        data[target + 3] = 255
      } else if (colorType === 2) {
        data[target] = toEightBits(pixels[source], bitDepth)
        data[target + 1] = toEightBits(pixels[source + 1], bitDepth)
        data[target + 2] = toEightBits(pixels[source + 2], bitDepth)
        data[target + 3] = 255
      } else if (colorType === 4) {
        data[target] = toEightBits(pixels[source], bitDepth)
        data[target + 1] = data[target]
        data[target + 2] = data[target]
        data[target + 3] = toEightBits(pixels[source + 1], bitDepth)
      } else {
        data[target] = toEightBits(pixels[source], bitDepth)
        data[target + 1] = toEightBits(pixels[source + 1], bitDepth)
        data[target + 2] = toEightBits(pixels[source + 2], bitDepth)
        data[target + 3] = toEightBits(pixels[source + 3], bitDepth)
      }
    }
  }
  return { width, height, data }
}

/** PNG 编码选项。 */
export interface EncodePngOptions {
  /**
   * zlib 压缩级别，范围 0–9。
   * 截图预览与 OCR 选区优先速度，默认 1；体积对本地 IPC 不敏感。
   */
  level?: number
}

/**
 * 将 32 位无符号整数以大端序写入缓冲。
 * @param out 目标缓冲。
 * @param offset 写入偏移。
 * @param value 待写入的无符号整数。
 * @returns 无返回值。
 * @author zhenghq
 */
function writeUint32Be(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff
  out[offset + 1] = (value >>> 16) & 0xff
  out[offset + 2] = (value >>> 8) & 0xff
  out[offset + 3] = value & 0xff
}

/**
 * 写入一个 PNG 块到预分配缓冲。
 * CRC 直接对块类型与数据的连续字节计算，禁止 spread 大数组。
 * @param out 输出缓冲。
 * @param cursor 当前写入位置。
 * @param type 四字符块类型。
 * @param data 块数据。
 * @returns 新的写入位置。
 * @author zhenghq
 */
function writeChunk(
  out: Uint8Array,
  cursor: number,
  type: string,
  data: Uint8Array
): number {
  const length = data.length
  writeUint32Be(out, cursor, length)
  out[cursor + 4] = type.charCodeAt(0)
  out[cursor + 5] = type.charCodeAt(1)
  out[cursor + 6] = type.charCodeAt(2)
  out[cursor + 7] = type.charCodeAt(3)
  out.set(data, cursor + 8)
  const crc = crc32(out.subarray(cursor + 4, cursor + 8 + length))
  writeUint32Be(out, cursor + 8 + length, crc)
  return cursor + 12 + length
}

/**
 * 编码 RGBA 图像为 PNG 字节（8 位、每行滤镜 0、非隔行）。
 * 扫描线与 PNG 块均预分配 Uint8Array，默认 zlib 级别为 1，避免全屏截图阻塞主进程。
 * @param image RGBA 图像。
 * @param options 可选编码参数；未指定时默认压缩级别为 1。
 * @returns PNG 字节。
 * @author zhenghq
 */
export function encodePng(image: RgbaImage, options: EncodePngOptions = {}): Buffer {
  const { width, height, data } = image
  if (!width || !height || data.length < width * height * 4) {
    throw new PngDecodeError('无法编码空图像或数据不完整的图像')
  }
  const stride = width * 4
  const raw = new Uint8Array(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    const dest = y * (stride + 1)
    raw[dest] = 0
    raw.set(data.subarray(y * stride, y * stride + stride), dest + 1)
  }
  const level = options.level ?? 1
  const idat = deflateSync(raw, { level })
  const ihdr = new Uint8Array(13)
  writeUint32Be(ihdr, 0, width)
  writeUint32Be(ihdr, 4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  const total = 8 + (12 + 13) + (12 + idat.length) + 12
  const out = new Uint8Array(total)
  out.set(PNG_SIGNATURE, 0)
  let cursor = 8
  cursor = writeChunk(out, cursor, 'IHDR', ihdr)
  cursor = writeChunk(out, cursor, 'IDAT', idat)
  writeChunk(out, cursor, 'IEND', new Uint8Array(0))
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
}
