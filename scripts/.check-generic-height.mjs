import { build } from 'esbuild'

const out = await build({
  stdin: {
    contents: "export { buildWebPagePrintCss } from '../src/main/webPagePdfExport.ts'",
    resolveDir: process.cwd() + '/scripts',
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
})
const code = out.outputFiles[0].text
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const css = mod.buildWebPagePrintCss()
console.log(css.slice(0, css.indexOf('html::after')))
