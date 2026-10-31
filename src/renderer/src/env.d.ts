import type { Api } from '../../shared/types'
import type { Locale } from '../../shared/i18n/locale'
import type { DocumentPartialExportSummary } from '../../shared/documentPartialExport'

declare global {
  interface Window {
    api: Api
    /** preload 暴露的当前主进程界面语言同步读取函数。 */
    getSelectionTranslatorLocale?: () => Locale
    /** preload 暴露的 Windows 7 兼容外观同步判断函数。 */
    getSelectionTranslatorWin7Compatibility?: () => boolean
    /** 兼容首屏脚本的静态语言注入回退值。 */
    selectionTranslatorLocale?: Locale
    /** 主进程打印部分结果前调用的受控预览接口。 */
    __documentPrintPreview?: {
      /**
       * 插入仅用于打印的部分结果标记并等待布局稳定。
       * @param summary 部分导出目标统计。
       * @param label 可见标记标题。
       * @returns 准备完成状态。
       */
      preparePartialExport(
        summary: DocumentPartialExportSummary,
        label: string
      ): Promise<{ ready: true; summary: DocumentPartialExportSummary }>
      /**
       * 清除打印标记并恢复最新实时预览。
       * @returns 恢复完成状态。
       */
      restorePrintPreview(): { restored: true }
    }
  }
}

export {}
