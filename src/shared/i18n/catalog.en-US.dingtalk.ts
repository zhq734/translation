import { defineCatalog } from './catalog.ts'

/** 英文界面词条目录：dingtalk 领域补充。 */
export const dingtalkEnUS = defineCatalog({
  'dingtalk.error.authentication': 'DingTalk authentication failed',
  'dingtalk.error.permission': 'The DingTalk app does not have permission to use text translation',
  'dingtalk.error.rateLimit': 'Too many DingTalk API requests',
  'dingtalk.error.parameter': 'Invalid DingTalk request parameters',
  'dingtalk.error.serviceUnavailable': 'The DingTalk service is temporarily unavailable',
  'dingtalk.error.timeout': 'DingTalk request timed out',
  'dingtalk.error.network': 'Unable to connect to DingTalk',
  'dingtalk.error.configurationIncomplete': 'DingTalk configuration is incomplete. Enter CorpId, ClientId, and ClientSecret.',
  'dingtalk.error.authenticationStatus': 'DingTalk authentication failed. Check CorpId, ClientId, and ClientSecret.',
  'dingtalk.error.permissionStatus': 'The DingTalk app does not have text translation permission',
  'dingtalk.error.rateLimitStatus': 'Too many DingTalk API requests. Try again later.',
  'dingtalk.error.parameterStatus': 'The DingTalk translation request parameters are not supported',
  'dingtalk.error.serviceStatus': 'The DingTalk service is temporarily unavailable. Try again later.',
  'dingtalk.error.tokenResponseInvalid': 'The DingTalk token response is invalid',
  'dingtalk.error.tokenResponseParse': 'Unable to parse the DingTalk token response',
  'dingtalk.error.translationResponseEmpty': 'The DingTalk translation response was empty',
  'dingtalk.error.translationResponseParse': 'Unable to parse the DingTalk translation response',
  'dingtalk.credential.secureStorageUnavailableRead': 'Secure storage is unavailable on this system, so the DingTalk credential cannot be read.',
  'dingtalk.credential.readFailed': 'Unable to read the saved DingTalk credential. Configure it again.',
  'dingtalk.credential.secureStorageUnavailableSave': 'Secure storage is unavailable on this system, so the DingTalk credential cannot be saved.'
})
