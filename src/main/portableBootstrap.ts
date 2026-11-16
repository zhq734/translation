import { app, dialog } from 'electron'
import { translateMain } from './messages'
import { initializePortableRuntime } from './portableRuntime'
import { isWindows7CompatibilityRuntime } from './platformCompatibility'
import type { PortableRuntimeInfo } from '../shared/portable'

/**
 * 在其他主进程模块加载前完成便携路径设置；失败时退出，禁止回退 AppData。
 * @returns 本次启动的便携状态。
 * @author zhenghq
 */
function bootstrapPortableRuntime(): PortableRuntimeInfo {
  try {
    return initializePortableRuntime({
      platform: process.platform,
      packaged: app.isPackaged,
      win7: isWindows7CompatibilityRuntime(),
      arch: process.arch,
      execPath: process.execPath,
      env: process.env,
      /** 接管 Electron 路径；参数为路径名和绝对路径，无返回值。@author zhenghq */
      setPath: (name, path) => app.setPath(name, path)
    })
  } catch (error) {
    try {
      dialog.showErrorBox(translateMain('portable.startup.title'), (error as Error).message)
    } finally {
      app.exit(1)
    }
    throw error
  }
}

export const portableRuntimeInfo = bootstrapPortableRuntime()
