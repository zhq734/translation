import { defineCatalog } from './catalog.ts'
import { enUSBase } from './catalog.en-US.base.ts'
import { appEnUS } from './catalog.en-US.app.ts'
import { aiEnUS } from './catalog.en-US.ai.ts'
import { captureEnUS } from './catalog.en-US.capture.ts'
import { deepLxEnUS } from './catalog.en-US.deepLx.ts'
import { dingtalkEnUS } from './catalog.en-US.dingtalk.ts'
import { microsoftEnUS } from './catalog.en-US.microsoft.ts'
import { ocrEnUS } from './catalog.en-US.ocr.ts'
import { speechEnUS } from './catalog.en-US.speech.ts'
import { rendererSpeechEnUS } from './catalog.en-US.rendererSpeech.ts'
import { webReaderEnUS } from './catalog.en-US.webReader.ts'

/**
 * 英文界面词条目录。
 * 基础词条保持原有键位，领域词条按模块拆分，便于多模块并行维护且避免键冲突。
 */
export const enUSCatalog = defineCatalog({
  ...enUSBase,
  ...appEnUS,
  ...aiEnUS,
  ...captureEnUS,
  ...deepLxEnUS,
  ...dingtalkEnUS,
  ...microsoftEnUS,
  ...ocrEnUS,
  ...speechEnUS,
  ...rendererSpeechEnUS,
  ...webReaderEnUS
})
