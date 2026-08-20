import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSpeechController,
  findSpeechVoice,
  languageToSpeechCode,
  splitSpeechText,
  type SpeechUtteranceLike
} from '../src/renderer/src/speech.ts'

test('项目语言代码应映射为常用语音语言代码', () => {
  assert.equal(languageToSpeechCode('ZH'), 'zh-CN')
  assert.equal(languageToSpeechCode('EN'), 'en-US')
  assert.equal(languageToSpeechCode('JA'), 'ja-JP')
  assert.equal(languageToSpeechCode('KO'), 'ko-KR')
  assert.equal(languageToSpeechCode('FR'), 'fr-FR')
  assert.equal(languageToSpeechCode('DE'), 'de-DE')
  assert.equal(languageToSpeechCode('ES'), 'es-ES')
  assert.equal(languageToSpeechCode('PT'), 'pt-BR')
  assert.equal(languageToSpeechCode('IT'), 'it-IT')
})

test('语音选择应优先完整语言代码，再匹配语言前缀', () => {
  const voices = [
    { lang: 'en-GB', name: 'English UK' },
    { lang: 'zh-TW', name: 'Chinese Taiwan' },
    { lang: 'en-US', name: 'English US' },
    { lang: 'fr-FR', name: 'French' }
  ] as SpeechSynthesisVoice[]

  assert.equal(findSpeechVoice(voices, 'EN')?.name, 'English US')
  assert.equal(findSpeechVoice(voices, 'ZH')?.name, 'Chinese Taiwan')
  assert.equal(findSpeechVoice([], 'EN'), null)
})

test('同一语言存在多个语音时应优先固定的首选音色，而不是动态切换增强标签', () => {
  const voices = [
    { lang: 'en-US', name: 'English US' },
    { lang: 'en-US', name: 'English US Premium' },
    { lang: 'en-US', name: 'English US Natural', localService: true },
    { lang: 'en-US', name: 'Samantha', localService: true },
    { lang: 'en-GB', name: 'English UK Neural' }
  ] as SpeechSynthesisVoice[]

  assert.equal(findSpeechVoice(voices, 'EN')?.name, 'Samantha')
})

test('固定首选音色同时存在普通版和增强版时应稳定使用增强版', () => {
  const englishVoices = [
    { lang: 'en-US', name: 'Samantha', localService: true },
    { lang: 'en-US', name: 'Samantha (Enhanced)', localService: true },
    { lang: 'en-US', name: 'English US Premium', localService: true }
  ] as SpeechSynthesisVoice[]
  const chineseVoices = [
    { lang: 'zh-CN', name: 'Xiaoxiao', localService: true },
    { lang: 'zh-CN', name: 'Xiaoxiao（增强）', localService: true },
    { lang: 'zh-CN', name: '普通中文神经语音', localService: true }
  ] as SpeechSynthesisVoice[]

  assert.equal(findSpeechVoice(englishVoices, 'EN')?.name, 'Samantha (Enhanced)')
  assert.equal(findSpeechVoice(chineseVoices, 'ZH')?.name, 'Xiaoxiao（增强）')
})

test('中文完整区域音色较机械时应优先选择更自然的同语言区域音色', () => {
  const voices = [
    { lang: 'zh-CN', name: 'Tingting', localService: true },
    { lang: 'zh-TW', name: 'Meijia', localService: true },
    { lang: 'zh-HK', name: 'Sinji', localService: true }
  ] as SpeechSynthesisVoice[]

  assert.equal(findSpeechVoice(voices, 'ZH')?.name, 'Meijia')
})

test('中文没有已知自然音色时仍应优先完整区域匹配', () => {
  const voices = [
    { lang: 'zh-CN', name: 'Z Chinese Mainland Standard', localService: true },
    { lang: 'zh-TW', name: 'A Chinese Taiwan Standard', localService: true }
  ] as SpeechSynthesisVoice[]

  assert.equal(findSpeechVoice(voices, 'ZH')?.name, 'Z Chinese Mainland Standard')
})

test('没有固定首选音色时应按稳定回退顺序选择普通语音', () => {
  const voices = [
    { lang: 'en-US', name: 'English US Natural', localService: true },
    { lang: 'en-US', name: 'English US Standard', localService: true },
    { lang: 'en-US', name: 'English US Premium', localService: true }
  ] as SpeechSynthesisVoice[]

  assert.equal(findSpeechVoice(voices, 'EN')?.name, 'English US Standard')
})

test('没有增强音色时应回退到同语言普通语音而不是返回空结果', () => {
  const voices = [
    { lang: 'en-US', name: 'English US' },
    { lang: 'en-GB', name: 'English UK' }
  ] as SpeechSynthesisVoice[]

  assert.equal(findSpeechVoice(voices, 'EN')?.name, 'English US')
})

test('英文语音选择应避开已知容易失真或音量异常的实验音色', () => {
  const voices = [
    { lang: 'en-US', name: 'Fred', default: true, localService: true },
    { lang: 'en-US', name: 'English US Standard', localService: true },
    { lang: 'en-US', name: 'Zarvox', localService: true }
  ] as SpeechSynthesisVoice[]

  assert.equal(findSpeechVoice(voices, 'EN')?.name, 'English US Standard')
})

test('长文本应按句子和最大长度分段并保留顺序', () => {
  const chunks = splitSpeechText('第一句。第二句！\nThird sentence? Fourth sentence.', 8)

  assert.deepEqual(chunks, ['第一句。', '第二句！', 'Third', 'sentence?', 'Fourth', 'sentence.'])
})

test('播放会话应支持停止、完成和旧回调失效', () => {
  const utterances: SpeechUtteranceLike[] = []
  let cancelCount = 0
  const synthesis = {
    speak(utterance: SpeechUtteranceLike): void {
      utterances.push(utterance)
    },
    cancel(): void {
      cancelCount += 1
    },
    getVoices(): SpeechSynthesisVoice[] {
      return [{ lang: 'en-US', name: 'English US' } as SpeechSynthesisVoice]
    }
  }
  const controller = createSpeechController({
    synthesis,
    createUtterance(text) {
      return { text, lang: '', voice: null, onend: null, onerror: null }
    },
    maxChunkLength: 50
  })

  assert.equal(controller.start('first. second.', 'EN').ok, true)
  assert.equal(controller.isSpeaking(), true)
  const oldUtterance = utterances[0]
  assert.ok(oldUtterance)

  assert.equal(controller.start('replacement.', 'EN').ok, true)
  assert.equal(cancelCount, 1)
  assert.equal(utterances.length, 2)
  oldUtterance.onend?.(new Event('end'))
  assert.equal(controller.isSpeaking(), true)

  utterances[1].onend?.(new Event('end'))
  assert.equal(controller.isSpeaking(), false)
  controller.stop()
  assert.equal(cancelCount, 2)
})

test('创建语音片段时应显式使用满音量、标准音调和正常一倍语速', () => {
  const utterances: SpeechUtteranceLike[] = []
  const controller = createSpeechController({
    synthesis: {
      speak(utterance): void { utterances.push(utterance) },
      cancel(): void {},
      getVoices(): SpeechSynthesisVoice[] {
        return [{ lang: 'en-US', name: 'English US Standard' } as SpeechSynthesisVoice]
      }
    },
    createUtterance(text) {
      return { text, lang: '', voice: null, onend: null, onerror: null }
    }
  })

  assert.equal(controller.start('A clear sentence.', 'EN').ok, true)
  assert.equal(utterances[0]?.volume, 1)
  assert.equal(utterances[0]?.pitch, 1)
  assert.equal(utterances[0]?.rate, 1)
})

test('替换播放时同步触发的旧错误回调不应覆盖新会话', () => {
  const utterances: SpeechUtteranceLike[] = []
  const synthesis = {
    speak(utterance: SpeechUtteranceLike): void {
      utterances.push(utterance)
    },
    cancel(): void {
      utterances.at(-1)?.onerror?.(new Event('error'))
    },
    getVoices(): SpeechSynthesisVoice[] {
      return [{ lang: 'zh-CN', name: 'Chinese' } as SpeechSynthesisVoice]
    }
  }
  let errorMessage = ''
  const controller = createSpeechController({
    synthesis,
    createUtterance(text) {
      return { text, lang: '', voice: null, onend: null, onerror: null }
    },
    onError(message) {
      errorMessage = message
    }
  })

  assert.equal(controller.start('旧译文。', 'ZH').ok, true)
  assert.equal(controller.start('新译文。', 'ZH').ok, true)
  assert.equal(controller.isSpeaking(), true)
  assert.equal(errorMessage, '')
})

test('语音 API 或系统语音不可用时应返回可展示错误', () => {
  const unsupportedMessages: string[] = []
  const unsupported = createSpeechController({
    synthesis: null,
    createUtterance(text) {
      return { text, lang: '', voice: null, onend: null, onerror: null }
    },
    onError(message) {
      unsupportedMessages.push(message)
    }
  })
  assert.equal(unsupported.canSpeak('EN'), false)
  assert.equal(unsupported.start('hello', 'EN').error, '当前环境不支持语音播放')
  assert.deepEqual(unsupportedMessages, ['当前环境不支持语音播放'])

  const noVoice = createSpeechController({
    synthesis: {
      speak(): void {},
      cancel(): void {},
      getVoices(): SpeechSynthesisVoice[] { return [] }
    },
    createUtterance(text) {
      return { text, lang: '', voice: null, onend: null, onerror: null }
    }
  })
  assert.equal(noVoice.canSpeak('EN'), false)
  assert.equal(noVoice.start('hello', 'EN').error, '当前系统没有可用语音，请检查系统语音设置')
})
