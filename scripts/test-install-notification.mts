#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstallEventService } from '../src/main/installUpgradeNotification.ts'

/**
 * 本地调试安装升级通知：使用 mock transporter 打印模拟邮件，不访问真实 SMTP。
 * 事件文件写入系统临时目录，退出时清理。
 * @author zhenghq
 */
async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'install-notification-test-'))
  const filePath = join(directory, 'install-events.json')
  try {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }
    const service = createInstallEventService({
      config: { smtpUser: 'mock-sender@example.com', smtpPass: 'mock-auth-code', reportTo: 'mock-receiver@example.com' },
      environment: {
        platform: process.platform,
        osRelease: process.version,
        eventTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      },
      fetchIp: async () => '198.51.100.10',
      transporter: {
        sendMail: async (options) => {
          console.log('模拟发送邮件')
          console.log(`主题: ${options.subject}`)
          console.log(options.text)
        }
      },
      filePath
    })

    const version = packageJson.version ?? '0.0.0'
    const sent = await service.processLaunch(version)
    console.log(`模拟结果: ${sent ? '已生成' : '无需生成'}`)
    console.log(`事件文件: ${filePath}`)
    console.log(readFileSync(filePath, 'utf8'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

await main()
