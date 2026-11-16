import { app, net, shell } from 'electron'
import { translationFetch } from './network'
import { getMainMessageTranslator } from './messages'
import { UpdateManager } from './updateManager'
import { PortableUpdateDriver, PORTABLE_RELEASE_URL } from './portableUpdateDriver'
import type { UpdateStatus } from '../shared/types'

/**
 * 创建便携手动更新管理器，不加载安装版更新驱动。
 * @param onStatusChanged 向界面推送状态的回调。
 * @returns 只检查便携 ZIP 并打开发布页的管理器。
 * @author zhenghq
 */
export async function createPortableUpdateManager(
  onStatusChanged: (status: UpdateStatus) => void
): Promise<UpdateManager> {
  const currentVersion = app.getVersion()
  return new UpdateManager({
    driver: new PortableUpdateDriver({ currentVersion, arch: process.arch, fetch: translationFetch }),
    currentVersion,
    enabled: app.isPackaged,
    installMode: 'manual',
    releaseUrl: PORTABLE_RELEASE_URL,
    getTranslator: getMainMessageTranslator,
    isOnline: () => net.isOnline(),
    openExternal: async (url) => { await shell.openExternal(url) },
    onStatusChanged
  })
}
