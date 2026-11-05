import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 读取设置页相关文件。
 * @param path 相对仓库根目录的路径。
 * @returns 文件文本。
 * @author zhenghq
 */
function read(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * 校验实时字幕设置页具备来源、语言、显示、外观、快捷键与运行控制。
 * @returns 无返回值。
 * @author zhenghq
 */
test('设置页应提供完整的实时字幕配置与运行入口', () => {
  const html = read('src/renderer/settings.html')
  for (const id of [
    'settings-tab-subtitle',
    'settings-panel-subtitle',
    'realtime-subtitle-audio-source',
    'realtime-subtitle-recognition-lang',
    'realtime-subtitle-display-mode',
    'realtime-subtitle-font-size',
    'realtime-subtitle-hide-after',
    'realtime-subtitle-text-color',
    'realtime-subtitle-click-through',
    'realtime-subtitle-hotkey',
    'realtime-subtitle-hotkey-clear',
    'realtime-subtitle-start',
    'realtime-subtitle-pause',
    'realtime-subtitle-resume',
    'realtime-subtitle-stop',
    'realtime-subtitle-status',
    'realtime-subtitle-open-screen-recording',
    'realtime-subtitle-asr-provider',
    'realtime-subtitle-deepgram-api-key',
    'realtime-subtitle-deepgram-save',
    'realtime-subtitle-deepgram-clear',
    'realtime-subtitle-whisper-settings',
    'realtime-subtitle-whisper-base-url',
    'realtime-subtitle-whisper-model',
    'realtime-subtitle-whisper-api-key',
    'realtime-subtitle-whisper-save',
    'realtime-subtitle-whisper-clear',
    'realtime-subtitle-whisper-status',
    'realtime-subtitle-websocket-settings',
    'realtime-subtitle-websocket-url'
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, 'u'), `设置页缺少 ${id}`)
  }

  const source = read('src/renderer/src/settings.ts')
  assert.match(source, /startRealtimeSubtitle/u)
  assert.match(source, /pauseRealtimeSubtitle/u)
  assert.match(source, /resumeRealtimeSubtitle/u)
  assert.match(source, /stopRealtimeSubtitle/u)
  assert.match(source, /onRealtimeSubtitleUpdate/u)
  assert.match(source, /openRealtimeSubtitleScreenRecordingSettings/u)
  assert.match(source, /realtimeSubtitleAudioSource/u)
  assert.match(source, /realtimeSubtitleRecognitionLang/u)
  assert.match(source, /realtimeSubtitleDisplayMode/u)
  assert.match(source, /realtimeSubtitleHideAfterMs/u)
  assert.match(source, /realtime-subtitle-hide-after/u)
  assert.match(source, /setDeepgramConfig/u)
  assert.match(source, /clearDeepgramApiKey/u)
  assert.match(source, /setWhisperConfig/u)
  assert.match(source, /clearWhisperApiKey/u)
  assert.match(source, /realtimeSubtitleWhisperBaseUrl/u)
  assert.match(source, /realtimeSubtitleWhisperModel/u)
  assert.match(source, /realtimeSubtitleAsrProvider\.value\s*===\s*['"]websocket['"]/u)
  assert.match(source, /realtimeSubtitleWebSocketUrl/u)
  assert.doesNotMatch(source, /realtimeSubtitleITranslate|saveRealtimeSubtitleITranslate|clearRealtimeSubtitleITranslate/u)
  assert.doesNotMatch(source, /realtimeSubtitleDeepgramApiKeyConfigured\s*=/u)
  assert.match(html, /id=["']realtime-subtitle-whisper-api-key["'][^>]*type=["']password["']/u)
  assert.doesNotMatch(html, /NSSpeechRecognition|端侧 Speech|on device/iu)
})

/**
 * 校验实时字幕界面词条在中英文目录中完整且可插值。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕设置与状态应具备中英文词条', () => {
  const zh = read('src/shared/i18n/catalog.zh-CN.subtitle.ts')
  const en = read('src/shared/i18n/catalog.en-US.subtitle.ts')
  for (const key of [
    'settings.tab.subtitle',
    'settings.realtimeSubtitle.title',
    'settings.realtimeSubtitle.windowTitle',
    'settings.realtimeSubtitle.audioSource',
    'settings.realtimeSubtitle.recognitionLang',
    'settings.realtimeSubtitle.displayMode',
    'settings.realtimeSubtitle.fontSize',
    'settings.realtimeSubtitle.hideAfter',
    'settings.realtimeSubtitle.hideAfterHint',
    'settings.realtimeSubtitle.textColor',
    'settings.realtimeSubtitle.clickThrough',
    'settings.realtimeSubtitle.hotkey',
    'settings.realtimeSubtitle.start',
    'settings.realtimeSubtitle.stop',
    'settings.realtimeSubtitle.pause',
    'settings.realtimeSubtitle.resume',
    'settings.realtimeSubtitle.status.running',
    'settings.realtimeSubtitle.audioDetected',
    'settings.realtimeSubtitle.waitingForSpeech',
    'settings.realtimeSubtitle.error.permissionDenied',
    'settings.realtimeSubtitle.error.invalidRequest',
    'settings.realtimeSubtitle.openScreenRecordingSettings',
    'settings.realtimeSubtitle.privacy',
    'settings.realtimeSubtitle.asrProvider',
    'settings.realtimeSubtitle.asrProvider.whisper',
    'settings.realtimeSubtitle.asrProvider.websocket',
    'settings.realtimeSubtitle.websocketUrl',
    'settings.realtimeSubtitle.websocketUrlPlaceholder',
    'settings.realtimeSubtitle.websocketHint',
    'settings.realtimeSubtitle.whisperBaseUrl',
    'settings.realtimeSubtitle.whisperModel',
    'settings.realtimeSubtitle.whisperApiKey',
    'settings.realtimeSubtitle.whisperApiKeyPlaceholder',
    'settings.realtimeSubtitle.whisperSave',
    'settings.realtimeSubtitle.whisperClear',
    'settings.realtimeSubtitle.whisperHint',
    'settings.realtimeSubtitle.deepgramApiKey',
    'settings.realtimeSubtitle.deepgramSave',
    'settings.realtimeSubtitle.deepgramClear',
    'settings.realtimeSubtitle.credentials.configured',
    'settings.realtimeSubtitle.credentials.notConfigured'
  ]) {
    assert.match(zh, new RegExp(`['"]${key.replaceAll('.', '\\.')}['"]\\s*:`, 'u'), `中文词条缺少 ${key}`)
    assert.match(en, new RegExp(`['"]${key.replaceAll('.', '\\.')}['"]\\s*:`, 'u'), `英文词条缺少 ${key}`)
  }
})

/**
 * 校验 Whisper 设置明确支持本地部署与无鉴权 OpenAI 兼容服务。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Whisper 设置应说明本地部署和无鉴权用法', () => {
  const html = read('src/renderer/settings.html')
  const zh = read('src/shared/i18n/catalog.zh-CN.subtitle.ts')
  const en = read('src/shared/i18n/catalog.en-US.subtitle.ts')

  assert.match(html, /value=["']whisper["']/u)
  assert.match(zh, /本地部署/iu)
  assert.match(zh, /faster-whisper|whisper\.cpp/iu)
  assert.match(zh, /\/inference/iu)
  assert.match(zh, /API Key 留空/iu)
  assert.match(en, /self-hosted|local/iu)
  assert.match(en, /\/inference/iu)
  assert.match(en, /leave the API key (?:blank|empty)/iu)
})

/**
 * 校验 WebSocket 设置暴露默认本地地址并说明音频格式。
 * @returns 无返回值。
 * @author zhenghq
 */
test('WebSocket 设置应说明本地 faster-whisper-stream 用法', () => {
  const html = read('src/renderer/settings.html')
  const zh = read('src/shared/i18n/catalog.zh-CN.subtitle.ts')
  const en = read('src/shared/i18n/catalog.en-US.subtitle.ts')

  assert.match(html, /value=["']websocket["']/u)
  assert.match(html, /id=["']realtime-subtitle-websocket-url["'][^>]*type=["']url["']/u)
  assert.match(html, /ws:\/\/127\.0\.0\.1:9092\/ws\/asr/u)
  assert.match(zh, /WebSocket/iu)
  assert.match(zh, /16\s*kHz/iu)
  assert.match(zh, /faster-whisper-stream/iu)
  assert.match(en, /16\s*kHz/iu)
  assert.match(en, /faster-whisper-stream/iu)
})

/**
 * 校验设置页明确区分 Deepgram ASR 与现有多通道翻译。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕设置应明确 Deepgram ASR 与复用翻译边界', () => {
  const html = read('src/renderer/settings.html')
  const zh = read('src/shared/i18n/catalog.zh-CN.subtitle.ts')
  const en = read('src/shared/i18n/catalog.en-US.subtitle.ts')
  for (const source of [html, zh, en]) {
    assert.match(source, /Deepgram/iu)
    assert.match(source, /(翻译|translation)/iu)
  }
  assert.match(zh, /复用|多通道/iu)
  assert.match(en, /reuse|multi-channel/iu)
  assert.match(html, /realtime-subtitle-deepgram-api-key[^>]*type=["']password["']/u)
  assert.match(html, /macOS 14\.2/u)
})

/**
 * 校验设置页不再展示 iTranslate 可选翻译通道。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕设置页不应展示 iTranslate 可选翻译通道', () => {
  const html = read('src/renderer/settings.html')
  const source = read('src/renderer/src/settings.ts')
  const zh = read('src/shared/i18n/catalog.zh-CN.subtitle.ts')
  const en = read('src/shared/i18n/catalog.en-US.subtitle.ts')

  assert.doesNotMatch(html, /iTranslate|realtime-subtitle-itranslate/iu)
  assert.doesNotMatch(source, /ITranslate|itranslate/iu)
  assert.doesNotMatch(zh, /iTranslate|itranslate/iu)
  assert.doesNotMatch(en, /iTranslate|itranslate/iu)
})

/**
 * 校验权限失败与组件异常提供可操作的恢复说明，而不是误导用户重装。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕启动错误应给出权限和重启操作说明', () => {
  const zh = read('src/shared/i18n/catalog.zh-CN.subtitle.ts')
  const en = read('src/shared/i18n/catalog.en-US.subtitle.ts')
  assert.match(zh, /屏幕录制[^']*允许[^']*重启/iu)
  assert.match(en, /Screen Recording[^']*allow[^']*restart/iu)
  assert.doesNotMatch(zh, /重新安装应用/u)
  assert.doesNotMatch(en, /Reinstall the app/iu)
})

/**
 * 校验设置页和字幕窗会把“有声音但未识别到语音”作为提示而不是错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('有声音但无语音时应展示可区分的状态提示', () => {
  const settings = read('src/renderer/src/settings.ts')
  const subtitle = read('src/renderer/src/subtitle.ts')
  const zh = read('src/shared/i18n/catalog.zh-CN.subtitle.ts')
  const en = read('src/shared/i18n/catalog.en-US.subtitle.ts')

  assert.match(settings, /audioActivity\s*===\s*['"]speech-pending['"]/u)
  assert.match(settings, /settings\.realtimeSubtitle\.waitingForSpeech/u)
  assert.match(subtitle, /audioActivity\s*===\s*['"]speech-pending['"]/u)
  assert.match(subtitle, /settings\.realtimeSubtitle\.waitingForSpeech/u)
  assert.match(zh, /检测到声音[^']*未识别到语音/iu)
  assert.match(en, /audio[^']*but[^']*speech/iu)
})

/**
 * 校验实时字幕高频更新只触发必要的界面刷新，并避免广播到无关窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕高频更新应合并渲染并定向发送', () => {
  const settings = read('src/renderer/src/settings.ts')
  const subtitle = read('src/renderer/src/subtitle.ts')
  const main = read('src/main/index.ts')
  const settingsRenderStart = settings.indexOf('function renderRealtimeSubtitleStatus(')
  const settingsRenderEnd = settings.indexOf('/**', settingsRenderStart + 1)
  const settingsRenderSource = settings.slice(settingsRenderStart, settingsRenderEnd)
  const mainSnapshotStart = main.indexOf('onSnapshot: (snapshot) => {')
  const mainSnapshotEnd = main.indexOf('setWindowVisible:', mainSnapshotStart)
  const mainSnapshotSource = main.slice(mainSnapshotStart, mainSnapshotEnd)
  const subtitleRenderStart = subtitle.indexOf('function render(viewModel:')
  const subtitleRenderEnd = subtitle.indexOf('/**', subtitleRenderStart + 1)
  const subtitleRenderSource = subtitle.slice(subtitleRenderStart, subtitleRenderEnd)

  assert.match(settingsRenderSource, /latestRealtimeSubtitleStatus[\s\S]*?state[\s\S]*?audioActivity[\s\S]*?return/u)
  assert.match(settings, /renderRealtimeSubtitleStatus\(latestRealtimeSubtitleStatus,\s*true\)/u)
  assert.match(mainSnapshotSource, /settingsWin[\s\S]*?webContents\.send\(['"]subtitle:update['"]/u)
  assert.doesNotMatch(mainSnapshotSource, /broadcast\(['"]subtitle:update['"]/u)
  assert.match(subtitle, /function scheduleViewModelRender/u)
  assert.match(subtitle, /onRealtimeSubtitleViewModel\(scheduleViewModelRender\)/u)
  assert.match(subtitle, /function scheduleDragHitAreaSync/u)
  assert.doesNotMatch(subtitleRenderSource, /requestAnimationFrame\(syncDragHitArea\)/u)
})

/**
 * 校验字幕右上角提供拖动入口、目标语言下拉与即时设置同步。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕右上角应支持拖动定位并切换目标译文语言', () => {
  const html = read('src/renderer/subtitle.html')
  const source = read('src/renderer/src/subtitle.ts')
  const css = read('src/renderer/src/subtitle.css')
  const main = read('src/main/index.ts')
  const preload = read('src/preload/index.ts')

  assert.match(html, /id=["']subtitle-toolbar["']/u)
  assert.match(html, /id=["']subtitle-drag-handle["']/u)
  assert.match(html, /id=["']subtitle-target-lang["']/u)
  assert.match(source, /localizedLanguages/u)
  assert.match(source, /currentTargetLang\s*=\s*targetLanguage\.value/u)
  assert.match(source, /setSettings\(\{\s*targetLang:\s*currentTargetLang\s*\}\)/u)
  assert.match(source, /onSettingsChanged/u)
  assert.match(source, /setRealtimeSubtitleMouseInteraction/u)
  assert.match(css, /\.subtitle-toolbar[\s\S]*-webkit-app-region:\s*no-drag/u)
  assert.match(css, /\.subtitle-drag-handle[\s\S]*-webkit-app-region:\s*no-drag/u)
  assert.match(css, /\.subtitle-drag-handle[\s\S]*pointer-events:\s*auto/u)
  assert.doesNotMatch(
    css,
    /\.subtitle-card\s*\{[^}]*-webkit-app-region:\s*drag/u,
    '字幕卡片不应成为原生拖动区，否则会吞掉卡片区域内的普通点击'
  )
  assert.match(source, /moveRealtimeSubtitleWindow/u)
  assert.match(source, /dragHandle\.addEventListener\('pointerenter',\s*showToolbar\)/u)
  assert.match(source, /onRealtimeSubtitlePointerPoint/u)
  assert.match(source, /point\.insideDragArea/u)
  assert.match(source, /function syncDragHitArea/u)
  assert.match(source, /const rect\s*=\s*toolbar\.getBoundingClientRect\(\)/u)
  assert.doesNotMatch(source, /const rect\s*=\s*dragHandle\.getBoundingClientRect\(\)/u)
  assert.match(source, /ResizeObserver/u)
  assert.match(source, /dragHitAreaObserver\.observe\(toolbar\)/u)
  assert.match(source, /setRealtimeSubtitleDragHitArea/u)
  assert.match(preload, /setRealtimeSubtitleDragHitArea/u)
  assert.match(preload, /ipcRenderer\.send\(['"]subtitle:drag-hit-area['"]/u)
  assert.match(main, /ipcMain\.on\(['"]subtitle:drag-hit-area['"][\s\S]*?subtitleWindow\.setDragHitArea/u)
  assert.match(source, /pointerOffsetX:\s*dragPointerOffset\.x/u)
  assert.match(source, /pointerOffsetY:\s*dragPointerOffset\.y/u)
  assert.match(source, /dragPointerOffset\s*=\s*\{\s*x:\s*event\.clientX,\s*y:\s*event\.clientY\s*\}/u)
  assert.match(preload, /setRealtimeSubtitleMouseInteraction/u)
  assert.match(preload, /ipcRenderer\.send\(['"]subtitle:move-window['"]/u)
  assert.match(preload, /subtitle:pointer-point/u)
  assert.match(main, /ipcMain\.on\(['"]subtitle:move-window['"][\s\S]*?subtitleWindow\.moveWindow/u)
  assert.match(main, /patch\.targetLang\s*!==\s*undefined/u)
})

/**
 * 校验屏幕录制权限操作与下方隐私说明之间保留清晰的垂直间距。
 * @returns 无返回值。
 * @author zhenghq
 */
test('屏幕录制设置按钮与隐私说明应保留足够间距', () => {
  const css = read('src/renderer/src/settings.css')

  assert.match(
    css,
    /\.realtime-subtitle-privacy\s*\{[^}]*margin-top:\s*var\(--space-3\)/u,
    '隐私说明应通过主题间距令牌与上方按钮分隔'
  )
})

/**
 * 校验字幕无正文时工具栏在字幕卡片内垂直居中且不会溢出卡片边界。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕空状态工具栏应在卡片内垂直居中', () => {
  const css = read('src/renderer/src/subtitle.css')

  assert.match(
    css,
    /\.subtitle-root\[data-empty='true'\] \.subtitle-card\s*\{[^}]*min-height:\s*calc\(var\(--control-height-compact\) \+ var\(--space-3\) \+ var\(--space-3\)\)/u,
    '空状态卡片应保留容纳工具栏的最小高度'
  )
  assert.match(
    css,
    /\.subtitle-root\[data-empty='true'\] \.subtitle-toolbar\s*\{[^}]*inset-block-start:\s*50%;[^}]*transform:\s*translateY\(-50%\)/u,
    '空状态工具栏应相对字幕卡片垂直居中'
  )
})

/**
 * 校验 Whisper 返回文本中的换行符不会让短字幕提前折行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕原文应折叠服务返回的换行符', () => {
  const css = read('src/renderer/src/subtitle.css')

  assert.match(
    css,
    /\.subtitle-line\s*\{[^}]*white-space:\s*normal/u,
    '字幕行应折叠文本内容中的换行，仅在超过可用宽度时自动换行'
  )
  assert.doesNotMatch(
    css,
    /\.subtitle-line\s*\{[^}]*white-space:\s*pre-wrap/u,
    '字幕行不应原样保留 Whisper 服务返回的换行符'
  )
})

/**
 * 校验字幕卡片不再绘制外围阴影，避免透明字幕窗出现明显的投影轮廓。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕卡片不应绘制外围阴影', () => {
  const css = read('src/renderer/src/subtitle.css')

  assert.doesNotMatch(
    css,
    /\.subtitle-card\s*\{[^}]*box-shadow:\s*var\(--shadow-overlay\)/u,
    '字幕卡片本身不应设置 box-shadow'
  )
})

/**
 * 校验字幕工具栏只在悬停字幕卡片或内部控件获得焦点时显示。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕工具栏应在非交互状态下稳定隐藏', () => {
  const css = read('src/renderer/src/subtitle.css')

  assert.match(
    css,
    /\.subtitle-root\[data-toolbar-visible='true'\] \.subtitle-toolbar,[\s\S]*\.subtitle-toolbar:focus-within\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto/u,
    '工具栏应由显式可见状态驱动，并仅在可见时接收指针事件'
  )
  assert.match(
    css,
    /\.subtitle-toolbar\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none/u,
    '隐藏工具栏不应拦截字幕卡片上的点击'
  )
  assert.doesNotMatch(
    css,
    /data-click-through='true'\] \.subtitle-toolbar\s*\{[^}]*opacity:\s*0?\.72/u,
    '点击穿透模式不应让工具栏保持常显'
  )
})

/**
 * 校验选择目标语言和结束拖动后会释放工具栏焦点，避免焦点阻止工具栏隐藏。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕工具栏应在交互结束后释放焦点并恢复点击穿透', () => {
  const source = read('src/renderer/src/subtitle.ts')
  const html = read('src/renderer/subtitle.html')

  assert.match(html, /id=["']subtitle-root["'][^>]*data-toolbar-visible=["']false["']/u)
  assert.match(source, /const dragHandle\s*=/u)
  assert.match(source, /const subtitleCard\s*=/u)
  assert.match(source, /function isPointInside/u)
  assert.match(source, /function showToolbar/u)
  assert.match(source, /function scheduleToolbarHide/u)
  assert.match(source, /targetLanguage\.blur\(\)/u)
  assert.match(source, /dragHandle\.addEventListener\('pointerup',[\s\S]*?\.blur\(\)/u)
  assert.match(source, /document\.addEventListener\('pointerdown',[\s\S]*?scheduleToolbarHide/u)
  assert.doesNotMatch(source, /toolbarPointerDown/u, '鼠标事件被原生下拉框吞掉后不应残留锁定状态')
  assert.doesNotMatch(
    source,
    /window\.addEventListener\('mousemove',[\s\S]*?setMouseInteraction\(isToolbarEvent\(event\)\)/u,
    '鼠标移动应根据工具栏命中区域启用交互，而不是直接按事件目标重置状态'
  )
  assert.match(source, /function resetToolbarInteraction[\s\S]*?setMouseInteraction\(false\)/u)
  assert.match(source, /window\.addEventListener\('blur',\s*resetToolbarInteraction\)/u)
  assert.match(source, /document\.addEventListener\('mouseleave',\s*resetToolbarInteraction\)/u)
  assert.match(
    source,
    /document\.addEventListener\('visibilitychange',[\s\S]*?document\.hidden[\s\S]*?resetToolbarInteraction\(\)/u
  )
})
