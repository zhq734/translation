import { defineCatalog } from './catalog.ts'

/** 英文界面词条目录：Renderer 语音播放。 */
export const rendererSpeechEnUS = defineCatalog({
  'rendererSpeech.error.noText': 'No translation to read aloud',
  'rendererSpeech.error.unsupported': 'Speech playback is not supported in this environment',
  'rendererSpeech.error.voiceListFailed': 'Failed to read system voices. Check your system speech settings.',
  'rendererSpeech.error.noVoice': 'No voice is available for the target language. Check your system speech settings.',
  'rendererSpeech.error.playFailed': 'Speech playback failed. Please try again.',
  'rendererSpeech.edge.cancelled': 'Edge speech request was cancelled',
  'rendererSpeech.edge.unavailable': 'Edge online speech is temporarily unavailable',
  'rendererSpeech.edge.decodeFailed': 'Edge audio decoding failed',
  'rendererSpeech.edge.noAudio': 'Edge speech service returned no audio',
  'rendererSpeech.edge.playFailed': 'Edge audio playback failed',
  'rendererSpeech.audio.playFailed': 'Audio playback failed',
  'rendererSpeech.audio.playCancelled': 'Audio playback was cancelled'
})
