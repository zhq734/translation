import { defineCatalog } from './catalog.ts'

/** 英文界面词条目录：capture 领域补充。 */
export const captureEnUS = defineCatalog({
  'capture.error.selectionOutOfBounds': 'The selection is outside the current display',
  'capture.error.screenCaptureFailed': 'Unable to capture the screen',
  'capture.error.screenRecordingPermissionRequired': 'Screen Recording permission is required',
  'capture.error.unsupportedPlatform': 'The current platform is not supported: {{platform}}',
  'capture.error.accessibilityPermissionRequired': 'Accessibility permission is required to simulate copy',
  'capture.error.copySimulationFailed': 'Failed to simulate copy: {{message}}',
  'capture.error.windowsOnlyGdi': 'Native GDI screen capture is only available on Windows',
  'capture.error.gdiGetDcFailed': 'GetDC failed: unable to obtain the screen device context',
  'capture.error.gdiCreateCompatibleDcFailed': 'CreateCompatibleDC failed',
  'capture.error.gdiCreateCompatibleBitmapFailed': 'CreateCompatibleBitmap failed',
  'capture.error.gdiBitBltFailed': 'BitBlt failed',
  'capture.error.gdiGetDIBitsFailed': 'GetDIBits failed: unable to retrieve pixel data',
  'capture.error.gdiBindingLoadFailed': 'Failed to load the koffi binding (will retry automatically in {{interval}} ms): {{detail}}',
  'capture.error.gdiCaptureFailed': 'GDI screen capture failed: {{message}}',
  'capture.error.gdiAndFallbackFailed': 'Unable to capture the screen: GDI failed ({{gdiMessage}}); fallback failed ({{fallbackMessage}})',
  'capture.error.windowsCaptureFailed': 'Unable to capture the screen: {{message}}',
  'capture.error.windowsHelperExit': 'The helper executable exited with code {{exitCode}}: {{stderr}}',
  'capture.error.nativeReaderHelperMissing': 'The windows-uia-reader helper executable is missing',
  'capture.error.exportRequestInvalid': 'The image export request is invalid',
  'capture.error.exportActionInvalid': 'The export action is invalid',
  'capture.error.exportRequestIdInvalid': 'The export request ID is invalid',
  'capture.error.exportSessionInvalid': 'The screenshot session is invalid',
  'capture.error.exportBoundsInvalid': 'The export selection is invalid',
  'capture.error.exportDimensionsInvalid': 'The export image dimensions are invalid',
  'capture.error.exportDataInvalid': 'The export image data is invalid',
  'capture.error.exportPngRequired': 'The export image must be in PNG format'
})
