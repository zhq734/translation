import { defineCatalog } from './catalog.ts'

/** 英文界面词条目录：microsoft 领域补充。 */
export const microsoftEnUS = defineCatalog({
  'microsoft.error.authentication': 'The Microsoft translation web session has expired',
  'microsoft.error.rateLimit': 'Too many Microsoft translation API requests',
  'microsoft.error.parameter': 'Invalid Microsoft translation request parameters',
  'microsoft.error.serviceUnavailable': 'The Microsoft translation service is temporarily unavailable',
  'microsoft.error.timeout': 'Microsoft translation request timed out',
  'microsoft.error.network': 'Unable to connect to Microsoft translation',
  'microsoft.error.authenticationStatus': 'Unable to obtain the Microsoft translation web session. Try again later.',
  'microsoft.error.rateLimitStatus': 'Too many Microsoft translation API requests. Try again later.',
  'microsoft.error.parameterStatus': 'The Microsoft translation request parameters are not supported',
  'microsoft.error.serviceStatus': 'The Microsoft translation service is temporarily unavailable. Try again later.',
  'microsoft.error.textEmpty': 'Microsoft translation text cannot be empty',
  'microsoft.error.responseEmpty': 'The Microsoft translation response was empty',
  'microsoft.error.pageReadFailed': 'Unable to read the Microsoft translation web page response',
  'microsoft.error.redirectInvalid': 'The Microsoft translation web page redirect address is invalid',
  'microsoft.error.authParametersParse': 'Unable to parse the Microsoft translation web page authentication parameters',
  'microsoft.error.authExpiryInvalid': 'The Microsoft translation web page authentication expiry is invalid',
  'microsoft.error.responseParse': 'Unable to parse the Microsoft translation response'
})
