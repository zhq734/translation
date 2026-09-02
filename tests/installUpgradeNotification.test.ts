import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildInstallEventBody,
  createInstallEventService,
  detectInstallEvent,
  resolvePublicIpAddress,
  type InstallEventRecord
} from '../src/main/installUpgradeNotification.ts'

const config = { smtpUser: 'sender@qq.com', smtpPass: 'auth-code', reportTo: 'receiver@qq.com' }

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

test('应采用有效公网 IPv4 并拒绝无效响应', async () => {
  assert.equal(await resolvePublicIpAddress(async () => new Response('203.0.113.8\n')), '203.0.113.8')
  assert.equal(await resolvePublicIpAddress(async () => new Response('not-an-ip')), null)
  await assert.rejects(
    () => resolvePublicIpAddress(async () => { throw new Error('offline') }),
    { message: 'offline' }
  )
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

test('应用就绪后应异步触发安装升级通知且保持日报入口不变', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  assert.match(source, /import \{ maybeSendInstallUpgradeNotification \} from '\.\/installUpgradeNotification'/u)
  assert.match(source, /setTimeout\(\(\) => void maybeSendInstallUpgradeNotification\(\), 1_500\)/u)
  assert.match(source, /recordTranslationUsage\(/u)
  assert.match(source, /recordWebPageUsage\(/u)
})
