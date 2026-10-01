import { defineCatalog } from './catalog.ts'

/** 英文界面词条目录：speech 领域补充。 */
export const speechEnUS = defineCatalog({
  'speech.error.emptyText': 'Speech text is empty',
  'speech.error.cancelled': 'Edge speech request was cancelled',
  'speech.error.connectionFailed': 'Unable to connect to the Edge speech service',
  'speech.error.timeout': 'Edge speech request timed out',
  'speech.error.noAudio': 'The Edge speech service returned no audio',
  'speech.error.connectionClosed': 'The Edge speech service connection was closed',
  'speech.error.proxyUnsupported': 'The current proxy type does not support Edge online speech'
})
