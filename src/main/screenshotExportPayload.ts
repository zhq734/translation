import type {
  ScreenshotAnnotatedExportAction,
  ScreenshotAnnotatedExportRequest
} from '../shared/types'

/** 带标注 PNG 导出负载在主进程侧允许的最大尺寸与体积。 */
export const SCREENSHOT_EXPORT_LIMITS = {
  /** 导出图片最大宽度。 */
  maxWidth: 16_000,
  /** 导出图片最大高度。 */
  maxHeight: 16_000,
  /** 导出 PNG 最大字节数。 */
  maxBytes: 24 * 1024 * 1024
} as const

/** 带标注导出负载校验成功结果。 */
export type ValidateAnnotatedExportPayloadResult =
  | {
      /** 校验是否通过。 */
      ok: true
      /** 校验后的导出请求。 */
      request: Omit<ScreenshotAnnotatedExportRequest, 'png'> & { png: Buffer }
    }
  | {
      /** 校验是否通过。 */
      ok: false
      /** 稳定的错误码。 */
      code: 'invalid-export-payload'
      /** 用户可读错误描述。 */
      error: string
    }

/** PNG 文件签名。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 判断未知值是否为带标注导出动作。
 * @param value 待校验的动作值。
 * @returns 是否为合法导出动作。
 * @author zhenghq
 */
function isExportAction(value: unknown): value is ScreenshotAnnotatedExportAction {
  return value === 'copy-image' || value === 'save-image'
}

/**
 * 校验矩形字段是否为正有限数值。
 * @param value 待校验的选区。
 * @returns 是否为合法选区。
 * @author zhenghq
 */
function isValidBounds(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const raw = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  return (
    Number.isFinite(raw.x) &&
    Number.isFinite(raw.y) &&
    Number.isFinite(raw.width) &&
    Number.isFinite(raw.height) &&
    (raw.width as number) > 0 &&
    (raw.height as number) > 0
  )
}

/**
 * 校验 Renderer 提交的带标注 PNG 导出负载。
 * @param value 未知导出负载。
 * @returns 校验后的导出请求或稳定错误结果。
 * @author zhenghq
 */
export function validateAnnotatedExportPayload(value: unknown): ValidateAnnotatedExportPayloadResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, code: 'invalid-export-payload', error: '导出图片请求无效' }
  }
  const raw = value as Partial<ScreenshotAnnotatedExportRequest>
  if (!isExportAction(raw.action)) {
    return { ok: false, code: 'invalid-export-payload', error: '导出动作类型无效' }
  }
  if (typeof raw.requestId !== 'string' || !raw.requestId.trim()) {
    return { ok: false, code: 'invalid-export-payload', error: '导出请求 ID 无效' }
  }
  if (!isValidBounds(raw.bounds)) {
    return { ok: false, code: 'invalid-export-payload', error: '导出选区无效' }
  }
  if (
    !Number.isFinite(raw.width) ||
    !Number.isFinite(raw.height) ||
    (raw.width as number) <= 0 ||
    (raw.height as number) <= 0 ||
    (raw.width as number) > SCREENSHOT_EXPORT_LIMITS.maxWidth ||
    (raw.height as number) > SCREENSHOT_EXPORT_LIMITS.maxHeight
  ) {
    return { ok: false, code: 'invalid-export-payload', error: '导出图片尺寸无效' }
  }
  const png = Buffer.isBuffer(raw.png)
    ? raw.png
    : raw.png instanceof Uint8Array
      ? Buffer.from(raw.png)
      : null
  if (!png || png.length < PNG_SIGNATURE.length || png.length > SCREENSHOT_EXPORT_LIMITS.maxBytes) {
    return { ok: false, code: 'invalid-export-payload', error: '导出图片数据无效' }
  }
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { ok: false, code: 'invalid-export-payload', error: '导出图片必须是 PNG 格式' }
  }
  return {
    ok: true,
    request: {
      action: raw.action,
      requestId: raw.requestId,
      bounds: {
        x: Number(raw.bounds!.x),
        y: Number(raw.bounds!.y),
        width: Number(raw.bounds!.width),
        height: Number(raw.bounds!.height)
      },
      width: Math.round(raw.width as number),
      height: Math.round(raw.height as number),
      png
    }
  }
}
