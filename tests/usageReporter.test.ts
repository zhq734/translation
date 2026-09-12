import assert from 'node:assert/strict'
import test from 'node:test'
import type { SendMailOptions, SentMessageInfo, Transporter } from 'nodemailer'
import {
  buildReportBody,
  sendUsageReport,
  type UsageReportConfig,
  type UsageReportEnvironment
} from '../src/main/usageReporter.ts'
import { resolveIpLocation } from '../src/main/ipLocation.ts'
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

test('邮件正文应包含访问公网 IP 与归属地信息', () => {
  const body = buildReportBody(stats, environment, '2026-08-31', '2026-08-30', {
    ip: '203.0.113.8',
    location: '中国 广东省 深圳市 电信'
  })
  assert.match(body, /访问公网IP：203\.0\.113\.8/u)
  assert.match(body, /IP归属地：中国 广东省 深圳市 电信/u)
  // 新增字段不得破坏原有统计内容
  assert.match(body, /划词翻译：45/u)
})

test('IP 或归属地缺失时正文应降级显示未知', () => {
  const body = buildReportBody(stats, environment, '2026-08-31', '2026-08-30', { ip: '203.0.113.8' })
  assert.match(body, /访问公网IP：203\.0\.113\.8/u)
  assert.match(body, /IP归属地：未知/u)

  const emptyBody = buildReportBody(stats, environment, '2026-08-31', '2026-08-30')
  assert.match(emptyBody, /访问公网IP：未知/u)
  assert.match(emptyBody, /IP归属地：未知/u)
  // 页脚隐私说明需要与新字段保持一致
  assert.match(emptyBody, /访问公网IP与归属地/u)
})

test('应解析 IP 归属地为中文位置描述并支持服务回退', async () => {
  const location = await resolveIpLocation('203.0.113.8', async () =>
    new Response(
      JSON.stringify({
        success: true,
        country: '中国',
        region: '广东省',
        city: '深圳市',
        connection: { isp: '电信' }
      })
    )
  )
  assert.equal(location, '中国 广东省 深圳市 电信')

  const requestedUrls: string[] = []
  const fallback = await resolveIpLocation('203.0.113.9', async (url) => {
    requestedUrls.push(String(url))
    if (requestedUrls.length === 1) return new Response('service unavailable', { status: 503 })
    return new Response(
      JSON.stringify({
        success: true,
        country: '中国',
        region: '北京市',
        city: '北京市',
        connection: { isp: '联通' }
      })
    )
  })
  // 重复的省市去重，避免出现「北京市 北京市」
  assert.equal(fallback, '中国 北京市 联通')
  assert.equal(requestedUrls.length, 2)
  assert.match(requestedUrls[0]!, /203\.0\.113\.9/u)
})

test('归属地服务全部失败或响应非法时应返回 null', async () => {
  assert.equal(await resolveIpLocation('203.0.113.8', async () => new Response('not json')), null)
  assert.equal(
    await resolveIpLocation('203.0.113.8', async () => {
      throw new Error('offline')
    }),
    null
  )
  assert.equal(await resolveIpLocation('not-an-ip', async () => new Response('{}')), null)
})

test('应兼容百度与 ip-api 的中文归属地响应结构', async () => {
  // 百度：data[0].location 已是合并后的中文描述
  const baidu = await resolveIpLocation('203.0.113.8', async () =>
    new Response(JSON.stringify({ status: '0', data: [{ location: '江苏省南京市 电信' }] }))
  )
  assert.equal(baidu, '江苏省南京市 电信')

  // ip-api：字段拆分，查询失败时必须拒绝而不是拼出空串
  const ipApi = await resolveIpLocation(
    '203.0.113.8',
    async () =>
      new Response(
        JSON.stringify({
          status: 'success',
          country: '中国',
          regionName: '广东省',
          city: '深圳市',
          isp: '电信'
        })
      )
  )
  assert.equal(ipApi, '中国 广东省 深圳市 电信')
  assert.equal(
    await resolveIpLocation(
      '203.0.113.8',
      async () => new Response(JSON.stringify({ status: 'fail' }))
    ),
    null
  )
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

test('发送邮件应携带 IP 与归属地信息', async () => {
  const { transporter, sent } = createTransporter()
  const ok = await sendUsageReport({
    config,
    stats,
    environment,
    today: '2026-08-31',
    yesterday: '2026-08-30',
    network: { ip: '203.0.113.8', location: '中国 广东省 深圳市 电信' },
    transporter
  })
  assert.equal(ok, true)
  assert.match(String(sent[0]?.text), /访问公网IP：203\.0\.113\.8/u)
  assert.match(String(sent[0]?.text), /IP归属地：中国 广东省 深圳市 电信/u)
})

test('IP 获取失败时应降级为未知并照常发送', async () => {
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
  assert.match(String(sent[0]?.text), /访问公网IP：未知/u)
  assert.match(String(sent[0]?.text), /IP归属地：未知/u)
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
