import { defineCatalog } from './catalog.ts'

/** 中文界面词条目录：capture 领域补充。 */
export const captureZhCN = defineCatalog({
  'capture.error.selectionOutOfBounds': '选区不在当前屏幕内',
  'capture.error.screenCaptureFailed': '无法获取屏幕截图',
  'capture.error.screenRecordingPermissionRequired': '需要屏幕录制权限',
  'capture.error.unsupportedPlatform': '暂不支持当前平台：{{platform}}',
  'capture.error.accessibilityPermissionRequired': '需要「辅助功能」权限才能模拟复制',
  'capture.error.copySimulationFailed': '模拟复制失败: {{message}}',
  'capture.error.windowsOnlyGdi': '仅 Windows 支持 GDI 原生截屏',
  'capture.error.gdiGetDcFailed': 'GetDC 失败：无法获取屏幕设备上下文',
  'capture.error.gdiCreateCompatibleDcFailed': 'CreateCompatibleDC 失败',
  'capture.error.gdiCreateCompatibleBitmapFailed': 'CreateCompatibleBitmap 失败',
  'capture.error.gdiBitBltFailed': 'BitBlt 失败',
  'capture.error.gdiGetDIBitsFailed': 'GetDIBits 失败：无法获取像素数据',
  'capture.error.gdiBindingLoadFailed': 'koffi 绑定加载失败（将在 {{interval}} 毫秒后自动重试）: {{detail}}',
  'capture.error.gdiCaptureFailed': 'GDI 截屏失败: {{message}}',
  'capture.error.gdiAndFallbackFailed': '无法获取屏幕截图: GDI 失败（{{gdiMessage}}）；回退失败（{{fallbackMessage}}）',
  'capture.error.windowsCaptureFailed': '无法获取屏幕截图: {{message}}',
  'capture.error.windowsHelperExit': 'helper exe 退出码 {{exitCode}}: {{stderr}}',
  'capture.error.nativeReaderHelperMissing': '缺少 windows-uia-reader helper 可执行文件',
  'capture.error.exportRequestInvalid': '导出图片请求无效',
  'capture.error.exportActionInvalid': '导出动作类型无效',
  'capture.error.exportRequestIdInvalid': '导出请求 ID 无效',
  'capture.error.exportSessionInvalid': '截图会话无效',
  'capture.error.exportBoundsInvalid': '导出选区无效',
  'capture.error.exportDimensionsInvalid': '导出图片尺寸无效',
  'capture.error.exportDataInvalid': '导出图片数据无效',
  'capture.error.exportPngRequired': '导出图片必须是 PNG 格式'
})
