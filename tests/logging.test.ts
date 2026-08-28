import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createAppLogger,
  createLogger,
  currentLogDate,
  formatLogMessage,
  parseLogFileDate,
  LOG_BUFFER_CAPACITY
} from '../src/main/logging'

/**
 * 创建临时日志目录，测试结束后自动清理。
 * @returns 临时日志目录路径。
 * @author zhenghq
 */
function makeLogDir(): string {
  return mkdtempSync(join(tmpdir(), 'app-logging-test-'))
}

test('console 包装后生成结构化条目且保留原终端输出', async (t) => {
  const logDir = makeLogDir()
  const originalLog = console.log
  let terminalOutput = ''
  console.log = (...args: unknown[]) => { terminalOutput += args.join(' ') }
  t.after(() => { console.log = originalLog; rmSync(logDir, { recursive: true, force: true }) })

  const logger = createAppLogger({ logDir })
  t.after(() => logger.dispose())

  console.log('hello', 'world')
  const history = logger.getHistory()
  assert.equal(history.length, 1)
  assert.equal(history[0].level, 'log')
  assert.equal(history[0].scope, 'main')
  assert.equal(history[0].message, 'hello world')
  assert.match(history[0].ts, /^\d{4}-\d{2}-\d{2}T/u)
  // dispose 恢复 console 后再校验终端转发，避免干扰断言输出
  logger.dispose()
  console.log = (...args: unknown[]) => { terminalOutput += args.join(' ') }
  // 重新验证：包装期间原始方法应被调用（通过第二次包装验证）
  const logger2 = createAppLogger({ logDir })
  console.log('forwarded')
  logger2.dispose()
  assert.ok(terminalOutput.includes('forwarded'))
})

test('Error 参数序列化包含 stack 信息', () => {
  const message = formatLogMessage(['识别失败', new Error('boom')])
  assert.ok(message.includes('识别失败'))
  assert.ok(message.includes('boom'))
  assert.ok(message.includes('Error'))
})

test('超长消息被截断至限定长度', () => {
  const message = formatLogMessage(['x'.repeat(10000)])
  assert.ok(message.length <= 2050)
  assert.ok(message.endsWith('…'))
})

test('日志按天命名文件并追加写入，内容格式正确', async (t) => {
  const logDir = makeLogDir()
  t.after(() => rmSync(logDir, { recursive: true, force: true }))
  const fixed = new Date('2026-08-28T10:00:00.000Z')
  const logger = createAppLogger({ logDir, hookConsole: false, now: () => fixed })
  t.after(() => logger.dispose())

  logger.append('warn', ['磁盘空间不足'])
  await new Promise((resolve) => setImmediate(resolve))
  logger.dispose()

  const files = readdirSync(logDir)
  assert.deepEqual(files, ['main-2026-08-28.log'])
  const content = readFileSync(join(logDir, files[0]), 'utf8')
  assert.match(content, /^\[2026-08-28T10:00:00\.000Z\] \[WARN\] \[main\] 磁盘空间不足\n$/u)
  assert.ok(logger.getLogFilePath().endsWith('main-2026-08-28.log'))
})

test('跨天时切换到新日期日志文件', async (t) => {
  const logDir = makeLogDir()
  t.after(() => rmSync(logDir, { recursive: true, force: true }))
  let fakeNow = new Date('2026-08-28T23:59:59')
  const logger = createAppLogger({ logDir, hookConsole: false, now: () => fakeNow })
  t.after(() => logger.dispose())

  logger.append('info', ['before midnight'])
  fakeNow = new Date('2026-08-29T00:00:01')
  logger.append('info', ['after midnight'])
  await new Promise((resolve) => setTimeout(resolve, 20))
  logger.dispose()

  const files = readdirSync(logDir).sort()
  assert.deepEqual(files, ['main-2026-08-28.log', 'main-2026-08-29.log'])
  assert.ok(readFileSync(join(logDir, 'main-2026-08-29.log'), 'utf8').includes('after midnight'))
})

test('启动时清理早于当天的历史日志文件', (t) => {
  const logDir = makeLogDir()
  t.after(() => rmSync(logDir, { recursive: true, force: true }))
  writeFileSync(join(logDir, 'main-2026-08-27.log'), 'old')
  writeFileSync(join(logDir, 'main-2026-08-28.log'), 'today')
  writeFileSync(join(logDir, 'other.txt'), 'keep')

  const fixed = new Date('2026-08-28T08:00:00')
  const logger = createAppLogger({ logDir, hookConsole: false, now: () => fixed })
  logger.dispose()

  const files = readdirSync(logDir).sort()
  assert.deepEqual(files, ['main-2026-08-28.log', 'other.txt'])
})

test('内存缓冲超过容量时丢弃最旧条目', (t) => {
  const logDir = makeLogDir()
  t.after(() => rmSync(logDir, { recursive: true, force: true }))
  const logger = createAppLogger({ logDir, hookConsole: false })
  t.after(() => logger.dispose())

  for (let index = 0; index < LOG_BUFFER_CAPACITY + 100; index += 1) {
    logger.append('info', [`entry-${index}`])
  }
  const history = logger.getHistory()
  assert.equal(history.length, LOG_BUFFER_CAPACITY)
  assert.equal(history[0].message, 'entry-100')
  assert.equal(history[history.length - 1].message, `entry-${LOG_BUFFER_CAPACITY + 99}`)
})

test('订阅者收到同 tick 聚合的增量日志，退订后停止接收', async (t) => {
  const logDir = makeLogDir()
  t.after(() => rmSync(logDir, { recursive: true, force: true }))
  const logger = createAppLogger({ logDir, hookConsole: false })
  t.after(() => logger.dispose())

  const batches: string[][] = []
  const unsubscribe = logger.subscribe((entries) => batches.push(entries.map((entry) => entry.message)))
  logger.append('info', ['a'])
  logger.append('error', ['b'])
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(batches, [['a', 'b']])

  unsubscribe()
  logger.append('info', ['c'])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(batches.length, 1)
})

test('createLogger 按模块 scope 打标', (t) => {
  const logDir = makeLogDir()
  t.after(() => rmSync(logDir, { recursive: true, force: true }))
  const logger = createAppLogger({ logDir, hookConsole: false })
  t.after(() => logger.dispose())

  const ocrLogger = createLogger(logger, 'ocr')
  ocrLogger.error('识别失败')
  const history = logger.getHistory()
  assert.equal(history[0].scope, 'ocr')
  assert.equal(history[0].level, 'error')
})

test('写盘异常时降级为仅内存缓冲，不抛错', (t) => {
  const logDir = join(makeLogDir(), 'not-a-dir')
  writeFileSync(logDir, 'file blocks mkdir')
  t.after(() => rmSync(join(logDir, '..'), { recursive: true, force: true }))

  const logger = createAppLogger({ logDir, hookConsole: false })
  t.after(() => logger.dispose())
  assert.doesNotThrow(() => logger.append('info', ['still buffered']))
  assert.equal(logger.getHistory().length, 1)
})

test('parseLogFileDate 与 currentLogDate 工具行为正确', () => {
  assert.equal(parseLogFileDate('main-2026-08-28.log'), '2026-08-28')
  assert.equal(parseLogFileDate('other.log'), null)
  assert.equal(currentLogDate(new Date(2026, 7, 5)), '2026-08-05')
})
