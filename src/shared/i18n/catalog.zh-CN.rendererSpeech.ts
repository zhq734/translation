import { defineCatalog } from './catalog.ts'

/** 中文界面词条目录：Renderer 语音播放。 */
export const rendererSpeechZhCN = defineCatalog({
  'rendererSpeech.error.noText': '暂无可朗读的译文',
  'rendererSpeech.error.unsupported': '当前环境不支持语音播放',
  'rendererSpeech.error.voiceListFailed': '读取系统语音失败，请检查系统语音设置',
  'rendererSpeech.error.noVoice': '当前系统没有可用语音，请检查系统语音设置',
  'rendererSpeech.error.playFailed': '语音播放失败，请重试',
  'rendererSpeech.edge.cancelled': 'Edge 语音请求已取消',
  'rendererSpeech.edge.unavailable': 'Edge 在线语音暂不可用',
  'rendererSpeech.edge.decodeFailed': 'Edge 音频解码失败',
  'rendererSpeech.edge.noAudio': 'Edge 语音服务未返回音频',
  'rendererSpeech.edge.playFailed': 'Edge 音频播放失败',
  'rendererSpeech.audio.playFailed': '音频播放失败',
  'rendererSpeech.audio.playCancelled': '音频播放已取消'
})
