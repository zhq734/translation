import { defineCatalog } from './catalog.ts'
import { zhCNBase } from './catalog.zh-CN.base.ts'
import { appZhCN } from './catalog.zh-CN.app.ts'
import { aiZhCN } from './catalog.zh-CN.ai.ts'
import { captureZhCN } from './catalog.zh-CN.capture.ts'
import { deepLxZhCN } from './catalog.zh-CN.deepLx.ts'
import { dingtalkZhCN } from './catalog.zh-CN.dingtalk.ts'
import { microsoftZhCN } from './catalog.zh-CN.microsoft.ts'
import { ocrZhCN } from './catalog.zh-CN.ocr.ts'
import { speechZhCN } from './catalog.zh-CN.speech.ts'
import { rendererSpeechZhCN } from './catalog.zh-CN.rendererSpeech.ts'
import { webReaderZhCN } from './catalog.zh-CN.webReader.ts'

/**
 * 中文界面词条目录。
 * 基础词条保持原有键位，领域词条按模块拆分，便于多模块并行维护且避免键冲突。
 */
export const zhCNCatalog = defineCatalog({
  ...zhCNBase,
  ...appZhCN,
  ...aiZhCN,
  ...captureZhCN,
  ...deepLxZhCN,
  ...dingtalkZhCN,
  ...microsoftZhCN,
  ...ocrZhCN,
  ...speechZhCN,
  ...rendererSpeechZhCN,
  ...webReaderZhCN
})
