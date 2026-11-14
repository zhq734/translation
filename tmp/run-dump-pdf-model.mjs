import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const projectRoot = resolve(import.meta.dirname, '..')
const require = createRequire(join(projectRoot, 'package.json'))
const pdfPath = process.argv[2]
if (!pdfPath) {
  console.error('usage: node tmp/run-repro-pdf.mjs <pdf>')
  process.exit(2)
}

const temporaryDirectory = mkdtempSync(join(projectRoot, '.translation-pdf-repro-'))
try {
  const bundlePath = join(temporaryDirectory, 'repro-pdf-entry.mjs')
  await build({
    entryPoints: [join(projectRoot, 'tmp/dump-pdf-model-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
    external: [
      '@napi-rs/canvas',
      'path2d-polyfill',
      'pdfjs-dist',
      'pdfjs-dist/*',
      'pdf-lib',
      '@pdf-lib/fontkit'
    ]
  })
  const result = spawnSync(require('electron'), [bundlePath, ...process.argv.slice(2)], {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60 * 1000
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) console.error(result.error)
  process.exitCode = result.status ?? 1
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
