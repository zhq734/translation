import assert from 'node:assert/strict'
import test from 'node:test'
import type { SendMailOptions, SentMessageInfo, Transporter } from 'nodemailer'
import {
  buildReportBody,
  sendUsageReport,
  type UsageReportConfig,
  type UsageReportEnvironment
} from '../src/main/usageReporter.ts'
import type { UsageStatsData } from '../src/main/usageStats.ts'

/** 测试用统计快照。 */
const stats: UsageStatsData = {
  days: {
    '2026-08-30': {
      channels: { selection: 45, hotkey: 12 },
      providers: { dingtalk: 30, ai: 27 }
    },
    '2026-08-31': {
      channels: { webpage: 8, screenshot: 3 },
      providers: { microsoft: 8, google: 3 }
    }
  },
  report: { lastSentDate: null }
}

/** 测试用运行环境信息。 */
const environment: UsageReportEnvironment = {
  platform: 'darwin',
  osRelease: '24.6.0',
  appVersion: '0.1.0',
  buildId: '20260831001'
}

const config: UsageReportConfig = {
  smtpUser: 'sender@qq.com',
  smtpPass: 'auth-code',
  reportTo: 'receiver@qq.com'
}

/**
 * 创建记录调用参数的模拟 Transporter。
 * @param behavior 可选的发送行为（成功或抛错）。
 * @returns 模拟 transporter 与已发送邮件列表。
 * @author zhenghq
 */
function createTransporter(behavior?: 'fail'): { transporter: Transporter; sent: SendMailOptions[] } {
  const sent: SendMailOptions[] = []
  const transporter = {
    sendMail: async (options: SendMailOptions): Promise<SentMessageInfo> => {
      if (behavior === 'fail') throw new Error('SMTP 连接失败')
      sent.push(options)
      return { messageId: 'mock-id' } as SentMessageInfo
    }
  } as Transporter
  return { transporter, sent }
}

test('邮件正文应包含系统、版本与昨日和今日快照', () => {
  const body = buildReportBody(stats, environment, '2026-08-31', '2026-08-30')
  assert.match(body, /darwin/)
  assert.match(body, /24\.6\.0/)
  assert.match(body, /0\.1\.0/)
  assert.match(body, /20260831001/)
  assert.match(body, /2026-08-30/)
  assert.match(body, /2026-08-31/)
  assert.match(body, /划词翻译：45/)
  assert.match(body, /快捷键翻译：12/)
  assert.match(body, /网页翻译：8/)
  assert.match(body, /截图翻译：3/)
  assert.match(body, /钉钉：30/)
  assert.match(body, /AI 翻译：27/)
  assert.match(body, /微软：8/)
  assert.match(body, /谷歌：3/)
})

test('正文不得包含任何用户文本字段', () => {
  const body = buildReportBody(stats, environment, '2026-08-31', '2026-08-30')
  assert.equal(body.includes('original'), false)
  assert.equal(body.includes('translation'), false)
})

test('配置完整时应发送邮件并返回 true', async () => {
  const { transporter, sent } = createTransporter()
  const ok = await sendUsageReport({
    config,
    stats,
    environment,
    today: '2026-08-31',
    yesterday: '2026-08-30',
    transporter
  })
  assert.equal(ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.from, '"划词翻译" <sender@qq.com>')
  assert.equal(sent[0]?.to, 'receiver@qq.com')
  assert.match(String(sent[0]?.subject), /2026-08-31/)
})

test('配置缺失时应跳过发送并返回 false', async () => {
  const { transporter, sent } = createTransporter()
  const ok = await sendUsageReport({
    config: { smtpUser: '', smtpPass: '', reportTo: '' },
    stats,
    environment,
    today: '2026-08-31',
    yesterday: '2026-08-30',
    transporter
  })
  assert.equal(ok, false)
  assert.equal(sent.length, 0)
})

test('发送失败应静默返回 false 且不抛出异常', async () => {
  const { transporter } = createTransporter('fail')
  const ok = await sendUsageReport({
    config,
    stats,
    environment,
    today: '2026-08-31',
    yesterday: '2026-08-30',
    transporter
  })
  assert.equal(ok, false)
})
