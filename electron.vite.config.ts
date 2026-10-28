import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

/** Win7 专用构建使用 Electron 22 对应的 Node 16 与 Chromium 108。 */
const isWindows7Build = process.env['WIN7_BUILD'] === '1'

export default defineConfig({
  main: {
    build: {
      target: isWindows7Build ? 'node16.17' : undefined
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    build: {
      target: isWindows7Build ? 'node16.17' : undefined
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    base: './',
    build: {
      target: isWindows7Build ? 'chrome108' : undefined,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          selection: resolve('src/renderer/selection.html'),
          settings: resolve('src/renderer/settings.html'),
          'web-reader': resolve('src/renderer/web-reader.html'),
          document: resolve('src/renderer/document.html'),
          toast: resolve('src/renderer/toast.html')
        }
      }
    }
  }
})
