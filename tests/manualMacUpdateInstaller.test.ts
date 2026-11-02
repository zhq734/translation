import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildMacOSAutomaticInstallScript,
  createManualMacUpdateService
} from '../src/main/manualMacUpdate.ts'
import {
  getUpdateDownloadErrorCode
} from '../src/main/updateDownloadError.ts'
import { setMainMessageTranslator } from '../src/main/messages.ts'
import { translatorForTest } from './helpers/i18n.ts'

setMainMessageTranslator(translatorForTest('zh-CN'))

const dmgContent = new Uint8Array([1, 2, 3, 4, 5, 6])
const dmgSha512 = createHash('sha512').update(dmgContent).digest('base64')

/**
 * 创建自动安装测试使用的临时下载目录。
 * @returns 临时目录及清理函数。
 * @author zhenghq
 */
async function createDownloadsDirectory(): Promise<{
  directory: string
  cleanup: () => Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'selection-translator-installer-test-'))
  return {
    directory,
    cleanup: async () => rm(directory, { recursive: true, force: true })
  }
}

/**
 * 记录自动安装器发出的系统命令与后台 helper 启动请求。
 * @returns 可注入安装服务的命令记录器和启动记录器。
 * @author zhenghq
 */
function createCommandHarness(): {
  commands: Array<{ command: string; args: string[] }>
  launches: Array<{ command: string; args: string[] }>
  runCommand: (command: string, args: string[]) => Promise<void>
  readCommand: (command: string, args: string[]) => Promise<string>
  launchHelper: (command: string, args: string[]) => void
} {
  const commands: Array<{ command: string; args: string[] }> = []
  const launches: Array<{ command: string; args: string[] }> = []
  return {
    commands,
    launches,
    runCommand: async (command, args) => {
      commands.push({ command, args })
    },
    readCommand: async (command, args) => {
      commands.push({ command, args })
      if (args.includes('CFBundleIdentifier')) return 'com.selection.translator\n'
      if (args.includes('CFBundleShortVersionString')) return '1.0.4\n'
      return ''
    },
    launchHelper: (command, args) => {
      launches.push({ command, args })
    }
  }
}

/**
 * 创建自动安装服务，允许按用例覆盖下载器与命令执行依赖。
 * @param directory 临时下载目录。
 * @param overrides 需要覆盖的服务选项。
 * @returns 自动安装服务及命令记录。
 * @author zhenghq
 */
function createInstaller(
  directory: string,
  overrides: Partial<Parameters<typeof createManualMacUpdateService>[0]> = {}
) {
  const harness = createCommandHarness()
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    platform: 'darwin',
    applicationPath: '/Applications/划词翻译.app',
    fetch: async () => new Response(dmgContent, {
      status: 200,
      headers: { 'content-length': String(dmgContent.byteLength) }
    }),
    openPath: async () => '',
    ...harness,
    ...overrides
  })
  return { service, ...harness }
}

test('自动安装缺少 sha512 时不得下载或启动 helper', async () => {
  const { directory, cleanup } = await createDownloadsDirectory()
  const requests: string[] = []
  const { service, launches } = createInstaller(directory, {
    fetch: async (url) => {
      requests.push(url)
      return new Response(dmgContent)
    }
  })

  try {
    await assert.rejects(
      service.downloadAndInstall!(
        'https://example.com/SelectionTranslator-1.0.4-mac-arm64.dmg',
        '1.0.4',
        '1.0.3'
      ),
      (error) => getUpdateDownloadErrorCode(error) === 'integrity-failed'
    )
    assert.deepEqual(requests, [])
    assert.deepEqual(launches, [])
  } finally {
    await cleanup()
  }
})

test('自动安装 sha512 不匹配时不得挂载 DMG 或启动 helper', async () => {
  const { directory, cleanup } = await createDownloadsDirectory()
  const { service, commands, launches } = createInstaller(directory)

  try {
    await assert.rejects(
      service.downloadAndInstall!(
        'https://example.com/SelectionTranslator-1.0.4-mac-arm64.dmg',
        '1.0.4',
        '1.0.3',
        undefined,
        { sha512: 'wrong-sha512', size: dmgContent.byteLength }
      ),
      (error) => getUpdateDownloadErrorCode(error) === 'integrity-failed'
    )
    assert.equal(commands.some(({ command }) => command === '/usr/bin/hdiutil'), false)
    assert.deepEqual(launches, [])
  } finally {
    await cleanup()
  }
})

test('自动安装应拒绝非固定 Applications 路径', async () => {
  const { directory, cleanup } = await createDownloadsDirectory()
  const { service, commands, launches } = createInstaller(directory, {
    applicationPath: '/Users/test/Applications/划词翻译.app'
  })

  try {
    await assert.rejects(
      service.downloadAndInstall!(
        'https://example.com/SelectionTranslator-1.0.4-mac-arm64.dmg',
        '1.0.4',
        '1.0.3',
        undefined,
        { sha512: dmgSha512, size: dmgContent.byteLength }
      ),
      (error) => getUpdateDownloadErrorCode(error) === 'install-failed'
    )
    assert.equal(commands.some(({ command }) => command === '/usr/bin/hdiutil'), false)
    assert.deepEqual(launches, [])
  } finally {
    await cleanup()
  }
})

test('自动安装应校验 Bundle ID、版本和代码签名后才启动 helper', async () => {
  const { directory, cleanup } = await createDownloadsDirectory()
  const harness = createCommandHarness()
  const { service } = createInstaller(directory, {
    runCommand: async (command, args) => {
      await harness.runCommand(command, args)
      if (command === '/usr/bin/hdiutil' && args[0] === 'attach') {
        await mkdir(join(args[4], '划词翻译.app'), { recursive: true })
      }
    },
    readCommand: harness.readCommand,
    launchHelper: harness.launchHelper
  })

  try {
    const result = await service.downloadAndInstall!(
      'https://example.com/SelectionTranslator-1.0.4-mac-arm64.dmg',
      '1.0.4',
      '1.0.3',
      undefined,
      { sha512: dmgSha512, size: dmgContent.byteLength }
    )

    assert.equal(result.installScheduled, true)
    assert.equal(harness.launches.length, 1)
    assert.ok(harness.commands.some(({ command, args }) =>
      command === '/usr/bin/codesign' && args.includes('--verify')
    ))
    const launchArgs = harness.launches[0].args
    assert.equal(launchArgs[2], '/Applications/划词翻译.update-staged.app')
    assert.equal(launchArgs[3], '/Applications/划词翻译.app')
    assert.equal(launchArgs[4], '/Applications/划词翻译.update-backup.app')
  } finally {
    await cleanup()
  }
})

test('自动安装应在应用身份或版本校验失败时清理挂载且不启动 helper', async () => {
  const { directory, cleanup } = await createDownloadsDirectory()
  const harness = createCommandHarness()
  const { service } = createInstaller(directory, {
    runCommand: async (command, args) => {
      await harness.runCommand(command, args)
      if (command === '/usr/bin/hdiutil' && args[0] === 'attach') {
        await mkdir(join(args[4], '划词翻译.app'), { recursive: true })
      }
    },
    readCommand: async (command, args) => {
      await harness.readCommand(command, args)
      if (args.includes('CFBundleIdentifier')) return 'com.example.wrong\n'
      if (args.includes('CFBundleShortVersionString')) return '1.0.4\n'
      return ''
    },
    launchHelper: harness.launchHelper
  })

  try {
    await assert.rejects(
      service.downloadAndInstall!(
        'https://example.com/SelectionTranslator-1.0.4-mac-arm64.dmg',
        '1.0.4',
        '1.0.3',
        undefined,
        { sha512: dmgSha512, size: dmgContent.byteLength }
      ),
      (error) => getUpdateDownloadErrorCode(error) === 'install-failed'
    )
    assert.deepEqual(harness.launches, [])
    assert.ok(harness.commands.some(({ command, args }) =>
      command === '/usr/bin/hdiutil' && args[0] === 'detach'
    ))
  } finally {
    await cleanup()
  }
})

test('自动安装调度应具有幂等性，重复调用只启动一次 helper', async () => {
  const { directory, cleanup } = await createDownloadsDirectory()
  const harness = createCommandHarness()
  const { service } = createInstaller(directory, {
    runCommand: async (command, args) => {
      await harness.runCommand(command, args)
      if (command === '/usr/bin/hdiutil' && args[0] === 'attach') {
        await mkdir(join(args[4], '划词翻译.app'), { recursive: true })
      }
    },
    readCommand: harness.readCommand,
    launchHelper: harness.launchHelper
  })
  const integrity = { sha512: dmgSha512, size: dmgContent.byteLength }

  try {
    const first = await service.downloadAndInstall!(
      'https://example.com/SelectionTranslator-1.0.4-mac-arm64.dmg',
      '1.0.4',
      '1.0.3',
      undefined,
      integrity
    )
    const second = await service.downloadAndInstall!(
      'https://example.com/SelectionTranslator-1.0.4-mac-arm64.dmg',
      '1.0.4',
      '1.0.3',
      undefined,
      integrity
    )

    assert.equal(first.installScheduled, true)
    assert.equal(second.installScheduled, true)
    assert.equal(harness.launches.length, 1)
  } finally {
    await cleanup()
  }
})

test('后台 helper 应等待父进程退出并支持备份恢复与重启应用', () => {
  const script = buildMacOSAutomaticInstallScript()

  assert.match(script, /while kill -0 "\$parent_pid"/u)
  assert.match(script, /mv "\$target_app" "\$backup_app"/u)
  assert.match(script, /mv "\$staged_app" "\$target_app"/u)
  assert.match(script, /trap restore EXIT HUP INT TERM/u)
  assert.match(script, /xattr -dr com\.apple\.quarantine/u)
  assert.match(script, /\/usr\/bin\/open "\$target_app"/u)
})

test('自动安装成功后应保留已下载的 DMG', async () => {
  const { directory, cleanup } = await createDownloadsDirectory()
  const harness = createCommandHarness()
  const { service } = createInstaller(directory, {
    runCommand: async (command, args) => {
      await harness.runCommand(command, args)
      if (command === '/usr/bin/hdiutil' && args[0] === 'attach') {
        await mkdir(join(args[4], '划词翻译.app'), { recursive: true })
      }
    },
    readCommand: harness.readCommand,
    launchHelper: harness.launchHelper
  })

  try {
    const result = await service.downloadAndInstall!(
      'https://example.com/SelectionTranslator-1.0.4-mac-arm64.dmg',
      '1.0.4',
      '1.0.3',
      undefined,
      { sha512: dmgSha512, size: dmgContent.byteLength }
    )
    assert.deepEqual(new Uint8Array(await readFile(result.path)), dmgContent)
  } finally {
    await cleanup()
  }
})
