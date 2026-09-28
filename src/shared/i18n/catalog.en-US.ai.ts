import { defineCatalog } from './catalog.ts'

/** 英文界面词条目录：ai 领域补充。 */
export const aiEnUS = defineCatalog({
  'ai.check.incomplete': 'AI configuration is incomplete. Enter a Base URL and model.',
  'ai.check.available': 'AI translation configuration is available.',
  'ai.check.permission': 'The AI application does not have sufficient permissions.',
  'ai.check.rateLimit': 'AI requests are too frequent. Try again later.',
  'ai.check.serviceUnavailable': 'The AI service is temporarily unavailable. Try again later.',
  'ai.credentials.secureStorageReadUnavailable': 'The current system cannot use secure storage, so the AI credential cannot be read.',
  'ai.credentials.readFailed': 'The saved AI credential could not be read. Configure it again.',
  'ai.credentials.secureStorageWriteUnavailable': 'Secure storage is unavailable on this system. The AI credential cannot be saved.',
  'ai.error.authentication': 'AI authentication failed. Check your API key.',
  'ai.error.rateLimit': 'AI requests are rate limited. Try again later.',
  'ai.error.notFound': 'The AI model does not exist or the path is incorrect.',
  'ai.error.serviceUnavailable': 'The AI service is temporarily unavailable.',
  'ai.error.httpStatus': 'The AI service returned an error (HTTP {{status}}).',
  'ai.error.timeout': 'AI request timed out.',
  'ai.error.network': 'AI network connection failed.',
  'ai.error.requestBuild': 'Failed to build the AI request.',
  'ai.error.nonJsonResponse': 'The AI service returned a non-JSON response.',
  'ai.error.responseParse': 'Failed to parse the AI service response.',
  'ai.error.emptyTranslation': 'AI returned an empty translation.',
  'ai.modelDiscovery.unsupported': 'This service does not support model discovery. Enter a model name manually.',
  'ai.modelDiscovery.unsupportedResponse': 'The model list response format is not supported.',
  'ai.modelDiscovery.parseFailed': 'Failed to parse the model list.',
  'ai.modelDiscovery.authentication': 'Model list authentication failed. Check your API key.',
  'ai.modelDiscovery.rateLimit': 'Model list requests are too frequent. Try again later.',
  'ai.modelDiscovery.loadFailed': 'Failed to load the model list.'
})
