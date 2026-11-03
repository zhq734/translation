import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHROMIUM_PROCESS_DETECTION_TIMEOUT_MS,
  createChromiumProcessDetector,
  resolveMacosAppBundlePath
} from '../src/main/chromiumProcessDetector.ts'

/**
 * 校验进程探测超时足够短，失败时不会显著拖慢取词兜底。
 * @returns 无返回值。
 * @author zhenghq
 */
test('进程探测超时应保持在短延迟范围', () => {
  assert.ok(CHROMIUM_PROCESS_DETECTION_TIMEOUT_MS > 0)
  assert.ok(CHROMIUM_PROCESS_DETECTION_TIMEOUT_MS <= 120)
})

/**
 * 校验已知 Chromium bundle id 直接命中，避免每次预热都启动进程探测。
 * @returns 无返回值。
 * @author zhenghq
 */
test('已知 Chromium bundle id 应跳过进程探测', async () => {
  let probeCount = 0
  const detector = createChromiumProcessDetector({
    platform: 'darwin',
    probeExecutablePath: async () => {
      probeCount += 1
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    }
  })

  assert.equal(await detector.isChromiumLikeProcess('com.google.chrome', 1001), true)
  assert.equal(probeCount, 0)
})

/**
 * 校验 Electron 主进程可执行文件路径可以识别为 Chromium 系应用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Electron 主进程路径应识别为 Chromium 系应用', async () => {
  const detector = createChromiumProcessDetector({
    platform: 'darwin',
    probeExecutablePath: async () => '/Applications/WorkBuddy.app/Contents/MacOS/Electron',
    fileExists: () => false
  })

  assert.equal(await detector.isChromiumLikeProcess('com.example.workbuddy', 1002), true)
})

/**
 * 校验主程序名不含 Electron 的应用仍可通过应用包内 Framework 被识别。
 * @returns 无返回值。
 * @author zhenghq
 */
test('应用包内 Electron Framework 应识别 Chromium 系应用', async () => {
  const expectedFramework = '/Applications/Slack.app/Contents/Frameworks/Electron Framework.framework'
  const detector = createChromiumProcessDetector({
    platform: 'darwin',
    probeExecutablePath: async () => '/Applications/Slack.app/Contents/MacOS/Slack',
    fileExists: (path) => path === expectedFramework
  })

  assert.equal(await detector.isChromiumLikeProcess('com.example.slack', 1003), true)
})

/**
 * 校验原生应用不会被误判为 Chromium 系应用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('IntelliJ IDEA 不应识别为 Chromium 系应用', async () => {
  const detector = createChromiumProcessDetector({
    platform: 'darwin',
    probeExecutablePath: async () => '/Applications/IntelliJ IDEA.app/Contents/MacOS/idea',
    fileExists: () => false
  })

  assert.equal(await detector.isChromiumLikeProcess('com.jetbrains.intellij', 1004), false)
})

/**
 * 校验同一 PID 的成功探测结果会被复用，避免重复执行系统命令。
 * @returns 无返回值。
 * @author zhenghq
 */
test('同一 PID 的顺序查询应复用探测结果', async () => {
  let probeCount = 0
  const detector = createChromiumProcessDetector({
    platform: 'darwin',
    probeExecutablePath: async () => {
      probeCount += 1
      return '/Applications/Cursor.app/Contents/MacOS/Electron'
    },
    fileExists: () => false
  })

  assert.equal(await detector.isChromiumLikeProcess('com.example.cursor', 1005), true)
  assert.equal(await detector.isChromiumLikeProcess('com.example.cursor', 1005), true)
  assert.equal(probeCount, 1)
})

/**
 * 校验同一 PID 的并发查询共享同一次进程探测。
 * @returns 无返回值。
 * @author zhenghq
 */
test('同一 PID 的并发查询应单飞', async () => {
  let probeCount = 0
  let releaseProbe: ((path: string) => void) | undefined
  const detector = createChromiumProcessDetector({
    platform: 'darwin',
    probeExecutablePath: () => {
      probeCount += 1
      return new Promise<string>((resolve) => {
        releaseProbe = resolve
      })
    },
    fileExists: () => false
  })

  const first = detector.isChromiumLikeProcess('com.example.concurrent', 1006)
  const second = detector.isChromiumLikeProcess('com.example.concurrent', 1006)
  assert.equal(probeCount, 1)
  releaseProbe?.('/Applications/Postman.app/Contents/MacOS/Electron')

  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(probeCount, 1)
})

/**
 * 校验瞬时探测失败不会被永久缓存，后续查询仍可重试。
 * @returns 无返回值。
 * @author zhenghq
 */
test('进程探测失败后应允许后续重试', async () => {
  let probeCount = 0
  const detector = createChromiumProcessDetector({
    platform: 'darwin',
    probeExecutablePath: async () => {
      probeCount += 1
      if (probeCount === 1) throw new Error('temporary failure')
      return '/Applications/Claude.app/Contents/MacOS/Electron'
    },
    fileExists: () => false
  })

  assert.equal(await detector.isChromiumLikeProcess('com.example.claude', 1007), false)
  assert.equal(await detector.isChromiumLikeProcess('com.example.claude', 1007), true)
  assert.equal(probeCount, 2)
})

/**
 * 校验非 macOS 平台不会执行进程探测。
 * @returns 无返回值。
 * @author zhenghq
 */
test('非 macOS 平台应直接返回 false', async () => {
  let probeCount = 0
  const detector = createChromiumProcessDetector({
    platform: 'linux',
    probeExecutablePath: async () => {
      probeCount += 1
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    }
  })

  assert.equal(await detector.isChromiumLikeProcess(undefined, 1008), false)
  assert.equal(probeCount, 0)
})

/**
 * 校验标准 macOS 应用可执行文件路径可解析出应用包根目录。
 * @returns 无返回值。
 * @author zhenghq
 */
test('应能从标准可执行文件路径解析应用包根目录', () => {
  assert.equal(
    resolveMacosAppBundlePath('/Applications/Slack.app/Contents/MacOS/Slack'),
    '/Applications/Slack.app'
  )
  assert.equal(resolveMacosAppBundlePath('/usr/bin/say'), null)
})
