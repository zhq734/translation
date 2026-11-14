import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const projectRoot = resolve(import.meta.dirname, '..')
const entry = process.argv[2]
if (!entry) {
  console.error('usage: node tmp/run-ts-electron.mjs <entry.ts> [...args]')
  process.exit(2)
}
const require = createRequire(join(projectRoot, 'package.json'))
const temporaryDirectory = mkdtempSync(join(projectRoot, '.translation-repro-'))
try {
  const bundlePath = join(temporaryDirectory, 'entry.mjs')
  await build({
    entryPoints: [resolve(projectRoot, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
    external: [
      '@napi-rs/canvas',
      '@gutenye/ocr-node',
      'sharp',
      'onnxruntime-node',
      'path2d-polyfill',
      'pdfjs-dist',
      'pdfjs-dist/*',
      'pdf-lib',
      '@pdf-lib/fontkit',
      'tesseract.js'
    ]
  })
  const result = spawnSync(require('electron'), [bundlePath, ...process.argv.slice(3)], {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60 * 1000
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  console.error('[repro-runtime]', {
    status: result.status,
    signal: result.signal,
    error: result.error?.message
  })
  if (result.error) console.error(result.error)
  process.exitCode = result.status ?? 1
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
