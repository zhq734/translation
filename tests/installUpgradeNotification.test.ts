import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildInstallEventBody,
  createInstallEventService,
  formatInstallEventTime,
  loadInstallNotificationConfig,
  detectInstallEvent,
  resolvePublicIpAddress,
  type InstallEventRecord
} from '../src/main/installUpgradeNotification.ts'

const config = { smtpUser: 'sender@qq.com', smtpPass: 'auth-code', reportTo: 'receiver@qq.com' }

test('事件时间格式化应使用运行时兼容选项并包含日期时间', () => {
  const eventTime = formatInstallEventTime(new Date('2026-09-02T09:00:00+08:00'))

  assert.doesNotThrow(() => formatInstallEventTime())
  assert.match(eventTime, /2026/u)
  assert.match(eventTime, /09:00:00|上午9:00|9:00:00/u)
})

test('配置读取应兼容应用 build 目录并按顺序回退到本地 build 目录', () => {
  const readConfig = (path: string) => {
    if (path.endsWith('app/build/usage-report-config.json')) {
      throw new Error('simulated packaged path')
    }
    if (path.endsWith('workspace/build/usage-report-config.json')) return config
    throw new Error(`unexpected path: ${path}`)
  }
  const loaded = loadInstallNotificationConfig({
    getDirectories: () => ['/app/build', '/workspace/build'],
    exists: (path: string) => path.endsWith('workspace/build/usage-report-config.json'),
    readConfig
  })

  assert.deepEqual(loaded, { config, configPath: '/workspace/build/usage-report-config.json' })
})

test('配置文件缺失时应返回空配置而不是抛出异常', () => {
  const loaded = loadInstallNotificationConfig({
    getDirectories: () => ['/app/build'],
    exists: () => false,
    readConfig: () => { throw new Error('should not read') }
  })

  assert.deepEqual(loaded, {
    config: { smtpUser: '', smtpPass: '', reportTo: '' },
    configPath: null
  })
})

test('无事件记录时应判定为首次安装', () => {
  const event = detectInstallEvent(null, '1.2.0')
  assert.deepEqual(event, { type: 'install', previousVersion: null, currentVersion: '1.2.0' })
})

test('版本不同时应判定为升级并保留上一版本', () => {
  const record: InstallEventRecord = { version: '1.1.4', confirmedAt: '2026-09-02T08:00:00+08:00' }
  const event = detectInstallEvent(record, '1.2.0')
  assert.deepEqual(event, {
    type: 'upgrade',
    previousVersion: '1.1.4',
    currentVersion: '1.2.0'
  })
})

test('版本相同时不应生成事件', () => {
  const record: InstallEventRecord = { version: '1.2.0', confirmedAt: '2026-09-02T08:00:00+08:00' }
  assert.equal(detectInstallEvent(record, '1.2.0'), null)
})

test('邮件正文应包含事件类型、版本、IP、系统与本地时间', () => {
  const body = buildInstallEventBody(
    {
      type: 'upgrade',
      previousVersion: '1.1.4',
      currentVersion: '1.2.0'
    },
    {
      ip: '203.0.113.10',
      platform: 'darwin',
      osRelease: '24.6.0',
      eventTime: '2026-09-02 09:00:00 GMT+8'
    }
  )
  for (const value of [
    '升级',
    '1.1.4',
    '1.2.0',
    '203.0.113.10',
    'darwin',
    '24.6.0',
    '2026-09-02 09:00:00 GMT+8'
  ]) {
    assert.match(body, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))
  }
})

test('应采用有效公网 IPv4、按服务回退并拒绝无效响应', async () => {
  assert.equal(await resolvePublicIpAddress(async () => new Response('203.0.113.8\n')), '203.0.113.8')
  assert.equal(await resolvePublicIpAddress(async () => new Response('not-an-ip')), null)

  const requestedUrls: string[] = []
  const fallbackIp = await resolvePublicIpAddress(async (url) => {
    requestedUrls.push(String(url))
    if (requestedUrls.length === 1) throw new Error('primary offline')
    return new Response('203.0.113.9')
  })

  assert.equal(fallbackIp, '203.0.113.9')
  assert.equal(requestedUrls.length, 2)
  assert.match(requestedUrls[0]!, /api\.ipify\.org/u)
  assert.match(requestedUrls[1]!, /icanhazip\.com/u)
})

test('首次安装发送成功后应确认版本且不再发送', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'install-event-'))
  const filePath = join(directory, 'install-events.json')
  const sent: Array<{ subject: string; text: string }> = []
  const service = createInstallEventService({
    config,
    filePath,
    environment: {
      platform: 'darwin',
      osRelease: '24.6.0',
      eventTime: '2026-09-02 09:00:00 GMT+8'
    },
    fetchIp: async () => '203.0.113.8',
    transporter: { sendMail: async (options) => { sent.push(options as any) } } as any
  })
  const first = await service.processLaunch('1.2.0')
  const second = await service.processLaunch('1.2.0')

  assert.equal(first, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.from, '"划词翻译" <sender@qq.com>')
  assert.match(sent[0]!.subject, /安装.*1\.2\.0/u)
  assert.match(sent[0]!.text, /203\.0\.113\.8/u)
  assert.equal(service.readRecord()?.version, '1.2.0')
  assert.equal(second, false)
  assert.equal(sent.length, 1)
  const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as { version: string; confirmedAt: string }
  assert.equal(persisted.version, '1.2.0')
  assert.match(persisted.confirmedAt, /^20\d{2}-/u)
  assert.doesNotMatch(JSON.stringify(persisted), /203\.0\.113\.8/u)
  rmSync(directory, { recursive: true, force: true })
})

test('IP 获取失败时不应确认事件且异常应透出以便调用方静默处理', async () => {
  const service = createInstallEventService({
    config,
    filePath: '/tmp/install-upgrade-notification/ip-failure.json',
    environment: {
      platform: 'darwin',
      osRelease: '24.6.0',
      eventTime: '2026-09-02 09:00:00 GMT+8'
    },
    fetchIp: async () => null,
    transporter: { sendMail: async () => { throw new Error('should not send') } } as any
  })

  await assert.rejects(() => service.processLaunch('1.2.0'), { message: '无法获取公网 IP' })
  assert.equal(service.readRecord(), null)
  rmSync('/tmp/install-upgrade-notification/ip-failure.json', { force: true })
})

test('SMTP 失败时不应确认事件', async () => {
  const service = createInstallEventService({
    config,
    filePath: '/tmp/install-upgrade-notification/smtp-failure.json',
    environment: {
      platform: 'darwin',
      osRelease: '24.6.0',
      eventTime: '2026-09-02 09:00:00 GMT+8'
    },
    fetchIp: async () => '203.0.113.8',
    transporter: { sendMail: async () => { throw new Error('SMTP failed') } } as any
  })

  await assert.rejects(() => service.processLaunch('1.2.0'), { message: 'SMTP failed' })
  assert.equal(service.readRecord(), null)
  rmSync('/tmp/install-upgrade-notification/smtp-failure.json', { force: true })
})

test('通知流程应静默执行且不输出安装通知日志', async () => {
  const logs: string[] = []
  const originalLog = console.log
  const originalInfo = console.info
  const originalWarn = console.warn
  const originalError = console.error
  const capture = (...args: unknown[]) => { logs.push(args.join(' ')) }
  console.log = capture
  console.info = capture
  console.warn = capture
  console.error = capture
  const directory = mkdtempSync(join(tmpdir(), 'install-event-log-'))
  const filePath = join(directory, 'install-events.json')
  try {
    const service = createInstallEventService({
      config,
      filePath,
      environment: {
        platform: 'darwin',
        osRelease: '24.6.0',
        eventTime: '2026-09-02 09:00:00 GMT+8'
      },
      fetchIp: async () => '203.0.113.8',
      transporter: { sendMail: async () => { throw new Error('SMTP failed') } } as any
    })

    await assert.rejects(() => service.processLaunch('1.2.0'), { message: 'SMTP failed' })

    assert.equal(logs.some((message) => message.includes('[installNotification]')), false)
    assert.equal(logs.some((message) => message.includes('203.0.113.8')), false)
    assert.equal(logs.some((message) => message.includes('receiver@qq.com')), false)
    assert.equal(logs.some((message) => message.includes('auth-code')), false)
  } finally {
    console.log = originalLog
    console.info = originalInfo
    console.warn = originalWarn
    console.error = originalError
    rmSync(directory, { recursive: true, force: true })
  }
})

test('应用就绪后应异步触发安装升级通知且保持日报入口不变', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  assert.match(source, /import \{ maybeSendInstallUpgradeNotification \} from '\.\/installUpgradeNotification'/u)
  assert.match(source, /setTimeout\(\(\) => void maybeSendInstallUpgradeNotification\(\), 1_500\)/u)
  assert.match(source, /recordTranslationUsage\(/u)
  assert.match(source, /recordWebPageUsage\(/u)
})

test('本地通知调试命令应使用 mock transporter 且只写临时事件文件', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
  assert.equal(packageJson.scripts['dev:notify-test'], 'node --experimental-strip-types scripts/test-install-notification.mts')

  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/test-install-notification.mts'],
    { encoding: 'utf8', timeout: 15_000 }
  )

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  const output = `${result.stdout}\n${result.stderr}`
  assert.match(output, /模拟发送邮件/u)
  assert.match(output, /事件类型: 首次安装/u)
  assert.match(output, /当前版本: /u)
  assert.match(output, /公网 IP: 198\.51\.100\.10/u)
  assert.match(output, /事件文件: .*[/\\]install-events\.json/u)
  assert.doesNotMatch(output, /smtp\.qq\.com/u)
})
