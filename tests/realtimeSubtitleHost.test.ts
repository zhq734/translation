import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  resolveMacosSubtitleAudioPath,
  SubtitleSessionHost,
  type SubtitleSessionChildProcess,
  type SubtitleSidecarEvent
} from '../src/main/subtitleSession.ts'

/** 可脚本化的 sidecar 子进程。 */
interface FakeChild extends EventEmitter, SubtitleSessionChildProcess {
  stdin: { write: (chunk: string) => void }
  stdout: EventEmitter
  stderr: EventEmitter
  killed: boolean
  commands: unknown[]
}

/** 宿主默认 spawn 测试所需的调用记录。 */
interface SpawnInvocation {
  /** 子进程环境变量。 */
  environment: NodeJS.ProcessEnv
}

/**
 * 创建模拟 sidecar，记录主进程下发的控制命令。
 * @returns 模拟子进程。
 * @author zhenghq
 */
function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.commands = []
  child.killed = false
  child.stdin = {
    write(chunk: string) {
      child.commands.push(JSON.parse(chunk))
    }
  }
  child.kill = () => {
    child.killed = true
  }
  return child
}

/**
 * 等待微任务队列，让宿主完成同步状态迁移。
 * @returns 无返回值。
 * @author zhenghq
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * 校验宿主启动、状态迁移和停止命令。
 * @returns 无返回值。
 * @author zhenghq
 */
test('sidecar 宿主应下发 start/pause/resume/stop 并迁移状态', async () => {
  const child = createFakeChild()
  const events: Array<{ event: SubtitleSidecarEvent; generation: number }> = []
  const states: string[] = []
  const host = new SubtitleSessionHost({
    spawn: () => child,
    onEvent: (event, generation) => events.push({ event, generation }),
    onStateChange: (state) => states.push(state)
  })

  const generation = host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  assert.equal(generation, 1)
  assert.deepEqual(child.commands[0], {
    cmd: 'start',
    source: 'system',
    asr: 'deepgram',
    lang: 'zh-CN'
  })
  assert.equal(host.snapshot().state, 'starting')

  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'))
  assert.equal(host.snapshot().state, 'running')
  host.pause()
  assert.deepEqual(child.commands[1], { cmd: 'pause' })
  host.resume()
  assert.deepEqual(child.commands[2], { cmd: 'resume' })
  host.stop()
  assert.deepEqual(child.commands[3], { cmd: 'stop' })
  assert.equal(child.killed, true)
  assert.equal(host.snapshot().state, 'idle')
  assert.deepEqual(events.map((item) => item.event.type), ['ready'])
  assert.deepEqual(states, ['starting', 'running', 'paused', 'running', 'stopping', 'idle'])
})

/**
 * 校验 sidecar 启动、就绪、错误与超时均写入主进程诊断日志。
 * @returns 无返回值。
 * @author zhenghq
 */
test('sidecar 生命周期应输出可定位的主进程日志', async () => {
  const child = createFakeChild()
  const messages: string[] = []
  const host = new SubtitleSessionHost({
    spawn: () => child,
    startupTimeoutMs: 10,
    onEvent: () => undefined,
    log: (message) => messages.push(message)
  })

  host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  assert.match(messages[0] ?? '', /starting.*source=system.*asr=deepgram.*lang=zh-CN/u)
  child.stdout.emit('data', Buffer.from('{"type":"error","code":"auth","message":"invalid key"}\n'))
  assert.match(messages.at(-1) ?? '', /error.*code=auth.*invalid key/u)
  host.dispose()
})

/**
 * 校验 sidecar 长时间未就绪时会在启动超时后终止并上报可恢复错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('sidecar 启动超时应终止进程并回到空闲状态', async () => {
  const child = createFakeChild()
  const errors: SubtitleSidecarEvent[] = []
  const host = new SubtitleSessionHost({
    spawn: () => child,
    startupTimeoutMs: 10,
    onEvent: (event) => {
      if (event.type === 'error') errors.push(event)
    }
  })

  host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(child.killed, true)
  assert.equal(host.snapshot().state, 'idle')
  assert.equal(host.snapshot().errorCode, 'permission-denied')
  assert.match(host.snapshot().error ?? '', /timed out while starting/u)
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.type, 'error')
  assert.equal((errors[0] as { code: string }).code, 'permission-denied')
  host.dispose()
})

/**
 * 校验 sidecar 就绪后会取消启动超时，避免运行中被误判为启动失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('sidecar 就绪后应取消启动超时', async () => {
  const child = createFakeChild()
  const errors: SubtitleSidecarEvent[] = []
  const host = new SubtitleSessionHost({
    spawn: () => child,
    startupTimeoutMs: 10,
    onEvent: (event) => {
      if (event.type === 'error') errors.push(event)
    }
  })

  host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'))
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(child.killed, false)
  assert.equal(host.snapshot().state, 'running')
  assert.equal(errors.length, 0)
  host.dispose()
})

/**
 * 校验持续音频输入但没有识别文本时，快照明确标记“有声音但无语音”。
 * @returns 无返回值。
 * @author zhenghq
 */
test('持续音频输入且无识别文本时应标记有声音但未识别到语音', () => {
  const child = createFakeChild()
  const host = new SubtitleSessionHost({
    spawn: () => child,
    onEvent: () => undefined
  })

  host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'))
  child.stdout.emit('data', Buffer.from('{"type":"level","rms":0.18}\n'))

  assert.equal(host.snapshot().audioActivity, 'speech-pending')
  child.stdout.emit('data', Buffer.from('{"type":"partial","text":"Hello"}\n'))
  assert.equal(host.snapshot().audioActivity, 'speech-detected')
  child.stdout.emit('data', Buffer.from('{"type":"level","rms":0.001}\n'))
  assert.equal(host.snapshot().audioActivity, 'speech-detected')
  host.dispose()
})

/**
 * 校验音频电平只在活动状态发生迁移时通知上层，避免高频 PCM 块反复驱动界面刷新。
 * @returns 无返回值。
 * @author zhenghq
 */
test('重复音频电平事件不应重复通知上层', () => {
  const child = createFakeChild()
  const eventTypes: SubtitleSidecarEvent['type'][] = []
  const host = new SubtitleSessionHost({
    spawn: () => child,
    onEvent: (event) => eventTypes.push(event.type)
  })

  host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  child.stdout.emit('data', Buffer.from([
    '{"type":"ready"}',
    '{"type":"level","rms":0.18}',
    '{"type":"level","rms":0.25}',
    '{"type":"level","rms":0.001}',
    '{"type":"partial","text":"Hello"}',
    '{"type":"level","rms":0.3}',
    ''
  ].join('\n')))

  assert.deepEqual(eventTypes, ['ready', 'level', 'partial'])
  host.dispose()
})

/**
 * 校验自动隐藏只清空当前显示内容，不停止仍在运行的识别会话。
 * @returns 无返回值。
 * @author zhenghq
 */
test('清空显示应移除原文、译文和段落但保持会话运行', () => {
  const child = createFakeChild()
  const host = new SubtitleSessionHost({
    spawn: () => child,
    onEvent: () => undefined
  })

  host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'))
  child.stdout.emit('data', Buffer.from('{"type":"final","text":"Hello"}\n'))
  const segment = host.snapshot().segments[0]
  assert.ok(segment)
  host.updateTranslation(segment.id, '你好', 'translated')

  host.clearDisplay()

  assert.equal(host.snapshot().state, 'running')
  assert.equal(host.snapshot().sourceText, '')
  assert.equal(host.snapshot().translatedText, '')
  assert.deepEqual(host.snapshot().segments, [])
  assert.equal(child.killed, false)
  host.dispose()
})

/**
 * 校验低电平背景噪声不会触发“有声音但无语音”提示。
 * @returns 无返回值。
 * @author zhenghq
 */
test('低电平噪声不应标记音频活动', () => {
  const child = createFakeChild()
  const host = new SubtitleSessionHost({
    spawn: () => child,
    onEvent: () => undefined
  })

  host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'))
  child.stdout.emit('data', Buffer.from('{"type":"level","rms":0.001}\n'))

  assert.equal(host.snapshot().audioActivity, 'idle')
  host.dispose()
})

/**
 * 校验主动停止或释放宿主后不会再次触发启动超时错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主动停止和释放后应取消启动超时', async () => {
  const children: FakeChild[] = []
  const errors: SubtitleSidecarEvent[] = []
  const host = new SubtitleSessionHost({
    spawn: () => {
      const child = createFakeChild()
      children.push(child)
      return child
    },
    startupTimeoutMs: 10,
    onEvent: (event) => {
      if (event.type === 'error') errors.push(event)
    }
  })

  host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  host.stop()
  host.start({ source: 'microphone', asr: 'deepgram', language: 'en-US' })
  host.dispose()
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(errors.length, 0)
  assert.equal(host.snapshot().state, 'idle')
})

/**
 * 校验旧代次事件在重启后被丢弃。
 * @returns 无返回值。
 * @author zhenghq
 */
test('sidecar 重启后应丢弃旧代次事件', () => {
  const children: FakeChild[] = []
  const events: Array<{ event: SubtitleSidecarEvent; generation: number }> = []
  const host = new SubtitleSessionHost({
    spawn: () => {
      const child = createFakeChild()
      children.push(child)
      return child
    },
    onEvent: (event, generation) => events.push({ event, generation })
  })

  host.start({ source: 'system', asr: 'deepgram', language: 'en-US' })
  children[0]?.stdout.emit('data', Buffer.from('{"type":"partial","text":"old"}\n'))
  host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  children[0]?.stdout.emit('data', Buffer.from('{"type":"partial","text":"stale"}\n'))
  children[1]?.stdout.emit('data', Buffer.from('{"type":"partial","text":"new"}\n'))

  assert.deepEqual(events.map((item) => ({ text: (item.event as { text?: string }).text, generation: item.generation })), [
    { text: 'old', generation: 1 },
    { text: 'new', generation: 2 }
  ])
  host.dispose()
})

/**
 * 校验 sidecar 意外退出会转为空闲并上报可恢复错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('sidecar 意外退出应上报 sidecar-unavailable', async () => {
  const child = createFakeChild()
  const errors: SubtitleSidecarEvent[] = []
  const host = new SubtitleSessionHost({
    spawn: () => child,
    onEvent: (event) => {
      if (event.type === 'error') errors.push(event)
    }
  })
  host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  child.emit('exit', 1)
  await flush()
  assert.equal(host.snapshot().state, 'idle')
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.type, 'error')
  assert.equal((errors[0] as { code: string }).code, 'sidecar-unavailable')
  assert.equal(host.snapshot().errorCode, 'sidecar-unavailable')
  assert.ok(host.snapshot().error)
})

/**
 * 校验 sidecar 异常退出时保留 stderr 诊断，便于开发态定位启动失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('sidecar 异常退出应保留最近一条 stderr 诊断', () => {
  const child = createFakeChild()
  const errors: SubtitleSidecarEvent[] = []
  const host = new SubtitleSessionHost({
    spawn: () => child,
    onEvent: (event) => {
      if (event.type === 'error') errors.push(event)
    }
  })

  host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  child.stderr.emit('data', Buffer.from('dyld: Library not loaded\n'))
  child.emit('exit', 1, null)

  assert.equal(host.snapshot().errorCode, 'sidecar-unavailable')
  assert.match(host.snapshot().error ?? '', /dyld: Library not loaded/u)
  assert.equal(errors.length, 1)
})

/**
 * 校验 spawn 抛错时宿主持久化错误并保持空闲。
 * @returns 无返回值。
 * @author zhenghq
 */
test('sidecar spawn 失败应持久化错误并保持空闲', () => {
  const errors: SubtitleSidecarEvent[] = []
  const host = new SubtitleSessionHost({
    spawn: () => {
      throw new Error('helper missing')
    },
    onEvent: (event) => errors.push(event)
  })

  host.start({ source: 'system', asr: 'deepgram', language: 'zh-CN' })
  assert.equal(host.snapshot().state, 'idle')
  assert.equal(host.snapshot().errorCode, 'sidecar-unavailable')
  assert.equal(host.snapshot().error, 'helper missing')
  assert.deepEqual(errors, [{
    type: 'error',
    code: 'sidecar-unavailable',
    message: 'helper missing'
  }])
})

/**
 * 校验 start 命令写入失败时终止子进程、持久化错误并保持空闲。
 * @returns 无返回值。
 * @author zhenghq
 */
test('sidecar start 写入失败应持久化错误并终止进程', () => {
  const child = createFakeChild()
  child.stdin = {
    write() {
      throw new Error('broken pipe')
    }
  }
  const errors: SubtitleSidecarEvent[] = []
  const host = new SubtitleSessionHost({
    spawn: () => child,
    onEvent: (event) => errors.push(event)
  })

  host.start({ source: 'microphone', asr: 'deepgram', language: 'auto' })
  assert.equal(child.killed, true)
  assert.equal(host.snapshot().state, 'idle')
  assert.equal(host.snapshot().errorCode, 'sidecar-unavailable')
  assert.equal(host.snapshot().error, 'broken pipe')
  assert.deepEqual(errors.map((event) => event.type), ['error'])
})

/**
 * 校验 Deepgram 密钥只通过子进程环境注入，不会进入 stdin 命令。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Deepgram 启动应仅在子进程环境注入密钥', () => {
  const child = createFakeChild()
  const invocations: SpawnInvocation[] = []
  const host = new SubtitleSessionHost({
    spawn: (environment) => {
      invocations.push({ environment })
      return child
    },
    onEvent: () => undefined
  })

  host.start({
    source: 'system',
    asr: 'deepgram',
    language: 'zh-CN',
    deepgramApiKey: 'dg-secret'
  })

  assert.equal(invocations[0]?.environment.DEEPGRAM_API_KEY, 'dg-secret')
  assert.equal(JSON.stringify(child.commands).includes('dg-secret'), false)
  host.dispose()
})

/**
 * 校验未显式传入 Deepgram 密钥时不会继承外部环境中的密钥。
 * @returns 无返回值。
 * @author zhenghq
 */
test('未显式传入 Deepgram 密钥时应清理继承的环境变量', () => {
  const previousKey = process.env.DEEPGRAM_API_KEY
  process.env.DEEPGRAM_API_KEY = 'inherited-secret'
  try {
    const child = createFakeChild()
    const invocations: SpawnInvocation[] = []
    const host = new SubtitleSessionHost({
      spawn: (environment) => {
        invocations.push({ environment })
        return child
      },
      onEvent: () => undefined
    })

    host.start({
      source: 'microphone',
      asr: 'deepgram',
      language: 'en-US',
      deepgramApiKey: null
    })

    assert.equal(invocations[0]?.environment.DEEPGRAM_API_KEY, undefined)
    assert.equal(JSON.stringify(child.commands).includes('secret'), false)
    host.dispose()
  } finally {
    if (previousKey === undefined) delete process.env.DEEPGRAM_API_KEY
    else process.env.DEEPGRAM_API_KEY = previousKey
  }
})

/**
 * 校验 Whisper 配置只通过子进程环境变量传递，且无鉴权本地服务允许不配置密钥。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Whisper 启动应通过环境变量传递配置且不要求 API Key', () => {
  const child = createFakeChild()
  const invocations: SpawnInvocation[] = []
  const host = new SubtitleSessionHost({
    spawn: (environment) => {
      invocations.push({ environment })
      return child
    },
    onEvent: () => undefined
  })

  host.start({
    source: 'system',
    asr: 'whisper',
    language: 'zh-CN',
    whisperBaseUrl: 'http://127.0.0.1:8000/v1',
    whisperModel: 'large-v3',
    whisperApiKey: null
  })

  assert.equal(invocations[0]?.environment.WHISPER_BASE_URL, 'http://127.0.0.1:8000/v1')
  assert.equal(invocations[0]?.environment.WHISPER_MODEL, 'large-v3')
  assert.equal(invocations[0]?.environment.WHISPER_API_KEY, undefined)
  assert.equal(JSON.stringify(child.commands).includes('127.0.0.1'), false)
  host.dispose()
})

/**
 * 校验 Whisper 密钥与配置不会从父进程环境意外继承。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Whisper 启动前应清理继承的敏感环境变量', () => {
  const previousKey = process.env.WHISPER_API_KEY
  const previousBaseUrl = process.env.WHISPER_BASE_URL
  const previousModel = process.env.WHISPER_MODEL
  process.env.WHISPER_API_KEY = 'inherited-whisper-secret'
  process.env.WHISPER_BASE_URL = 'http://inherited.invalid/v1'
  process.env.WHISPER_MODEL = 'inherited-model'
  try {
    const child = createFakeChild()
    const invocations: SpawnInvocation[] = []
    const host = new SubtitleSessionHost({
      spawn: (environment) => {
        invocations.push({ environment })
        return child
      },
      onEvent: () => undefined
    })

    host.start({
      source: 'microphone',
      asr: 'whisper',
      language: 'auto',
      whisperBaseUrl: 'http://127.0.0.1:8000/v1',
      whisperModel: 'whisper-1',
      whisperApiKey: null
    })

    assert.equal(invocations[0]?.environment.WHISPER_API_KEY, undefined)
    assert.equal(invocations[0]?.environment.WHISPER_BASE_URL, 'http://127.0.0.1:8000/v1')
    assert.equal(invocations[0]?.environment.WHISPER_MODEL, 'whisper-1')
    assert.equal(JSON.stringify(child.commands).includes('inherited'), false)
    host.dispose()
  } finally {
    if (previousKey === undefined) delete process.env.WHISPER_API_KEY
    else process.env.WHISPER_API_KEY = previousKey
    if (previousBaseUrl === undefined) delete process.env.WHISPER_BASE_URL
    else process.env.WHISPER_BASE_URL = previousBaseUrl
    if (previousModel === undefined) delete process.env.WHISPER_MODEL
    else process.env.WHISPER_MODEL = previousModel
  }
})

/**
 * 校验开发环境与打包环境的 sidecar 路径回退顺序。
 * @returns 无返回值。
 * @author zhenghq
 */
test('应优先解析打包 sidecar，再回退开发构建产物', () => {
  assert.equal(
    resolveMacosSubtitleAudioPath({
      resourcesPath: '/app/resources',
      cwd: '/repo',
      fileExists: (path) => path === '/app/resources/macos-subtitle-audio'
    }),
    '/app/resources/macos-subtitle-audio'
  )
  assert.equal(
    resolveMacosSubtitleAudioPath({
      resourcesPath: '/app/resources',
      cwd: '/repo',
      fileExists: (path) => path === '/repo/build/macos-subtitle-audio'
    }),
    '/repo/build/macos-subtitle-audio'
  )
})
