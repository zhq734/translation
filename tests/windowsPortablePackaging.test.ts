import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = process.cwd()
const require = createRequire(join(root, 'package.json'))
const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
const { load } = require('js-yaml')
const { minimatch } = require('minimatch')
const JSZip = require('jszip')
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const scriptPath = resolve('scripts/build-windows-portable.mjs')

/**
 * 加载真实便携构建模块，避免把构建工具打入测试临时 bundle。
 * @returns 构建模块及可注入的验证入口。
 * @author zhenghq
 */
async function portableModule() {
  return import(pathToFileURL(scriptPath).href)
}

/**
 * 创建指定架构的最小 ZIP 文件内容，仅用于校验器测试，不冒充可运行 Windows 包。
 * @param arch 目标 CPU 架构。
 * @returns ZIP 条目名与测试字节内容。
 * @author zhenghq
 */
function archiveEntries(arch: string): Record<string, string> {
  const unpacked = 'resources/app.asar.unpacked'
  return {
    '划词翻译.exe': 'fixture-executable',
    'portable.json': '{"version":1}',
    'icudtl.dat': 'fixture-icu',
    'locales/en-US.pak': 'fixture-locale',
    'resources/app.asar': 'fixture-asar',
    'resources/app-icon.ico': 'fixture-icon',
    'resources/build-info.json': '{"version":"0.1.0"}',
    'resources/windows-uia-reader.exe': 'fixture-uia',
    'resources/assets/fonts/NotoSansSC-Regular.ttf': 'fixture-font',
    [`${unpacked}/assets/ocr/ppocrv6_tiny/det.onnx`]: 'fixture-model',
    [`${unpacked}/assets/ocr/ppocrv6_tiny/rec.onnx`]: 'fixture-model',
    [`${unpacked}/assets/ocr/ppocrv6_tiny/dict.txt`]: 'fixture-dictionary',
    [`${unpacked}/node_modules/@img/sharp-win32-${arch}/lib/sharp-win32-${arch}.node`]: 'fixture-sharp',
    [`${unpacked}/node_modules/@img/sharp-win32-${arch}/lib/libvips-42.dll`]: 'fixture-vips',
    [`${unpacked}/node_modules/@napi-rs/canvas-win32-${arch}-msvc/skia.win32-${arch}-msvc.node`]: 'fixture-canvas',
    [`${unpacked}/node_modules/@napi-rs/canvas-win32-${arch}-msvc/icudtl.dat`]: 'fixture-canvas-icu',
    [`${unpacked}/node_modules/onnxruntime-node/bin/napi-v6/win32/${arch}/onnxruntime_binding.node`]: 'fixture-onnx',
    [`${unpacked}/node_modules/onnxruntime-node/bin/napi-v6/win32/${arch}/onnxruntime.dll`]: 'fixture-onnx-dll',
    [`${unpacked}/node_modules/uiohook-napi/prebuilds/win32-${arch}/node.napi.node`]: 'fixture-uiohook',
    [`${unpacked}/node_modules/@koromix/koffi-win32-${arch}/koffi.node`]: 'fixture-koffi'
  }
}

/**
 * 将条目写成真实 ZIP，以覆盖目录解析和内容读取而不只检查源码字符串。
 * @param filePath ZIP 文件路径。
 * @param entries ZIP 条目及内容。
 * @returns 写入结束的 Promise。
 * @author zhenghq
 */
async function writeArchive(filePath: string, entries: Record<string, string>) {
  const zip = new JSZip()
  for (const [name, contents] of Object.entries(entries)) zip.file(name, contents)
  writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }))
}

/**
 * 验证真实 electron-builder 配置合并、资源复用和便携发布隔离。
 * @returns 无返回值。
 * @author zhenghq
 */
test('便携配置应复用现代 Windows 资源并只生成独立的双架构 ZIP', async () => {
  const config = await getConfig(root, 'electron-builder-portable.yml')
  await validateConfiguration(config)
  const base = await getConfig(root)
  assert.equal(config.directories.output, 'dist-portable')
  assert.equal(config.publish, null)
  assert.deepEqual(config.win.target, [{ target: 'zip', arch: ['x64', 'arm64'] }])
  assert.equal(config.win.artifactName, 'SelectionTranslator-${version}-Portable-${arch}.${ext}')
  assert.deepEqual(config.files, base.files)
  assert.deepEqual(config.asarUnpack, base.asarUnpack)
  assert.deepEqual(config.win.files, base.win.files)
  assert.deepEqual(config.win.extraResources, base.win.extraResources)
  assert.deepEqual(config.win.extraFiles, [{ from: 'scripts/portable/portable.json', to: 'portable.json' }])
  assert.equal(config.nsis, undefined)
  assert.equal(config.mac, undefined)
  assert.equal(config.linux, undefined)
  assert.deepEqual(JSON.parse(readFileSync('scripts/portable/portable.json', 'utf8')), { version: 1 })
  assert.match(readFileSync('.gitignore', 'utf8'), /^dist-portable\/$/mu)
})

/**
 * 验证未修改安装版命令，加载便携配置不会污染其他发行配置或源清单。
 * @returns 无返回值。
 * @author zhenghq
 */
test('便携标识与更新设置不能污染 NSIS、Win7、macOS 和 Linux', async () => {
  const before = readFileSync('package.json', 'utf8')
  const portable = await portableModule()
  const inherited = portable.default()
  inherited.files.push('test-only-mutation')
  assert.ok(!portable.default().files.includes('test-only-mutation'))
  await getConfig(root, 'electron-builder-portable.yml')
  const installed = await getConfig(root)
  const win7 = await getConfig(root, 'electron-builder-win7.yml')
  assert.equal(readFileSync('package.json', 'utf8'), before)
  assert.doesNotMatch(JSON.stringify(installed), /portable\.json|dist-portable/u)
  assert.doesNotMatch(JSON.stringify(win7), /portable\.json|dist-portable/u)
  assert.deepEqual(installed.publish, manifest.build.publish)
  assert.equal(installed.directories.output, 'dist')
  assert.equal(win7.directories.output, 'dist-win7')
  assert.equal(manifest.scripts['dist:win'], 'npm run build && node scripts/prepare-windows-ocr-runtime.mjs && electron-builder --win nsis --x64 --arm64 --publish never')
  assert.equal(manifest.scripts['dist:win:win7'], 'node scripts/build-win7.mjs')
  assert.equal(manifest.scripts['dist:win:portable'], 'node scripts/build-windows-portable.mjs')
})

/**
 * 执行注入子进程的真实构建流程，验证顺序、架构及错误中断。
 * @returns 无返回值。
 * @author zhenghq
 */
test('便携构建应先 build 再准备 OCR/UIA，最后打包并验证，失败时立即停止', async () => {
  const { buildWindowsPortable } = await portableModule()
  const calls: Array<{ command: string; args: string[] }> = []
  let verified = false
  await buildWindowsPortable({
    platform: 'win32',
    /** 记录命令及参数，不启动子进程；返回空值。创建者：zhenghq。 */
    run(command: string, args: string[]) { calls.push({ command, args }) },
    /** 记录构建后验证被调用；返回空值。创建者：zhenghq。 */
    verify() { verified = true }
  })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0].args.slice(-2), ['run', 'build'])
  assert.deepEqual(calls[1], { command: process.execPath, args: [resolve('scripts/prepare-windows-ocr-runtime.mjs')] })
  assert.deepEqual(calls[2].args.slice(1), ['--win', 'zip', '--x64', '--arm64', '--publish', 'never', '--config', resolve('electron-builder-portable.yml')])
  assert.equal(verified, true)
  calls.length = 0
  await assert.rejects(buildWindowsPortable({
    platform: 'win32',
    /** 模拟资源准备失败；参数为命令和参数，返回异常。创建者：zhenghq。 */
    run(command: string, args: string[]) { calls.push({ command, args }); if (calls.length === 2) throw new Error('prepare failed') },
    /** 不应进入验证；返回断言失败。创建者：zhenghq。 */
    verify() { assert.fail('资源准备失败后不能验证或发布') }
  }), /prepare failed/u)
  assert.equal(calls.length, 2)
  await assert.rejects(buildWindowsPortable({ platform: 'darwin' }), /Windows/u)
})

/**
 * 使用真实双架构 ZIP 验证产物命名、文件内容和缺失架构错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('产物校验应读取两份 Portable ZIP 并拒绝缺包或更新清单污染', async () => {
  const { verifyPortablePackages } = await portableModule()
  const directory = mkdtempSync(join(tmpdir(), 'portable-package-'))
  try {
    for (const arch of ['x64', 'arm64']) {
      await writeArchive(join(directory, `SelectionTranslator-0.1.0-Portable-${arch}.zip`), archiveEntries(arch))
    }
    await verifyPortablePackages(directory, '0.1.0')
    writeFileSync(join(directory, 'latest.yml'), 'installer-only')
    await assert.rejects(verifyPortablePackages(directory, '0.1.0'), /latest\.yml/u)
    rmSync(join(directory, 'latest.yml'))
    rmSync(join(directory, 'SelectionTranslator-0.1.0-Portable-arm64.zip'))
    await assert.rejects(verifyPortablePackages(directory, '0.1.0'), /arm64/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * 删除资源、损坏标识或放入安装版元数据，逐项证明构建校验可阻止坏包。
 * @returns 无返回值。
 * @author zhenghq
 */
test('ZIP 校验应拒绝缺失原生资源、错误架构、错误标识、预置 data 与自动更新元数据', async () => {
  const { verifyPortableArchive } = await portableModule()
  const directory = mkdtempSync(join(tmpdir(), 'portable-invalid-'))
  const path = join(directory, 'fixture.zip')
  try {
    const good = archiveEntries('x64')
    for (const entry of Object.keys(good)) {
      const broken = { ...good }
      delete broken[entry]
      await writeArchive(path, broken)
      await assert.rejects(verifyPortableArchive(path, 'x64'), `缺少 ${entry} 必须失败`)
    }
    for (const marker of ['bad-json', '{"version":2}', 'null']) {
      await writeArchive(path, { ...good, 'portable.json': marker })
      await assert.rejects(verifyPortableArchive(path, 'x64'), /portable\.json/u)
    }
    for (const entry of ['resources/app-update.yml', 'latest.yml', 'update.blockmap', 'data/user-data/settings.json']) {
      await writeArchive(path, { ...good, [entry]: 'forbidden' })
      await assert.rejects(verifyPortableArchive(path, 'x64'), /更新|data/u)
    }
    await writeArchive(path, archiveEntries('arm64'))
    await assert.rejects(verifyPortableArchive(path, 'x64'), /x64/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * 按真实工作流上传 glob 收集 ZIP，再运行现有 SHA-256 命令并逐字节核对摘要。
 * @returns 无返回值。
 * @author zhenghq
 */
test('CI 独立便携矩阵上传的两份 ZIP 必须进入现有 Release SHA256SUMS', async () => {
  const workflow = load(readFileSync('.github/workflows/package.yml', 'utf8'))
  const job = workflow.jobs.package
  const matrix = job.strategy.matrix.include
  const portable = matrix.find((row: { command: string }) => row.command === 'dist:win:portable')
  assert.ok(portable, 'CI 缺少便携构建矩阵项')
  assert.match(portable.os, /^windows-/u)
  assert.equal(portable.platform, 'windows')
  assert.ok(matrix.some((row: { command: string }) => row.command === 'dist:win'))
  assert.ok(matrix.some((row: { command: string }) => row.command === 'dist:win:win7'))
  assert.ok(job.steps.some((step: { run?: string; if?: string }) => step.run === 'npm run ${{ matrix.command }}' && step.if === "matrix.platform != 'macos'"))
  const upload = job.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@'))
  assert.equal(upload.with.name, '${{ matrix.artifact_name }}')
  assert.equal(upload.with.path, '${{ matrix.artifact_path }}')
  assert.equal(upload.with['if-no-files-found'], 'error')
  const release = workflow.jobs.release
  assert.equal(release.needs, 'package')
  const download = release.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/download-artifact@'))
  assert.ok(minimatch(portable.artifact_name, download.with.pattern))
  assert.equal(download.with['merge-multiple'], true)
  assert.ok(release.steps.some((step: { run?: string }) => step.run === 'node scripts/generate-checksums.mjs --directory release-assets'))
  const globs = portable.artifact_path.trim().split(/\s+/u)
  const candidates = ['x64', 'arm64'].map((arch) => `dist-portable/SelectionTranslator-0.1.0-Portable-${arch}.zip`)
  for (const file of candidates) assert.ok(globs.some((glob: string) => minimatch(file, glob)), file)
  for (const file of ['dist/latest.yml', 'dist-portable/latest.yml', 'dist-portable/resources/app-update.yml', 'dist-portable/test.blockmap']) {
    assert.ok(!globs.some((glob: string) => minimatch(file, glob)), `不能上传 ${file}`)
  }
  const directory = mkdtempSync(join(tmpdir(), 'portable-checksums-'))
  try {
    for (const [index, candidate] of candidates.entries()) {
      await writeArchive(join(directory, candidate.split('/').at(-1)!), archiveEntries(index === 0 ? 'x64' : 'arm64'))
    }
    writeFileSync(join(directory, 'SelectionTranslator-0.1.0-Setup-x64.exe'), 'installer-fixture')
    writeFileSync(join(directory, 'latest.yml'), 'installer-update-info')
    const command = spawnSync(process.execPath, ['scripts/generate-checksums.mjs', '--directory', directory], { cwd: root, encoding: 'utf8' })
    assert.equal(command.status, 0, command.stderr)
    const lines = readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)
    for (const line of lines) {
      const [hash, name] = line.split('  ')
      assert.equal(hash, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'))
    }
    for (const candidate of candidates) assert.ok(lines.some((line) => line.endsWith(`  ${candidate.split('/').at(-1)}`)))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
