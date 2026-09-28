import { defineCatalog } from './catalog.ts'

/** 英文界面词条目录：webReader 领域补充。 */
export const webReaderEnUS = defineCatalog({
  'webReader.error.disabled': 'Web page translation is disabled in settings',
  'webReader.error.pageChanged': 'The web page changed. Extract it again.',
  'webReader.error.extractFirst': 'Extract the current web page text first',
  'webReader.error.loadFailed': 'Failed to load the web page: {{description}}',
  'webReader.error.notOpen': 'The web reader is not open',
  'webReader.error.urlRequired': 'Open an HTTP or HTTPS web page first',
  'webReader.error.onlyHttp': 'The web reader supports only HTTP or HTTPS addresses',
  'webReader.error.invalidUrl': 'Enter a valid web address',
  'webReader.error.extractionTimeout': 'Web page text extraction timed out',
  'webReader.error.extractionFailed': 'Failed to extract web page text. Check that the page has finished loading.',
  'webReader.error.documentNotReady': 'The web page document is not ready yet. Try again shortly.',
  'webReader.error.rootNotReady': 'The web page root element has not been created yet. Try again shortly.',
  'webReader.error.translationFailed': 'Translation failed',
  'webReader.mainWindowTitle': 'Selection Translator · Web Translation'
})
