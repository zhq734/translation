"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const node_child_process = require("node:child_process");
const node_crypto = require("node:crypto");
const node_fs = require("node:fs");
const promises = require("node:fs/promises");
const node_os = require("node:os");
const node_path = require("node:path");
const node_util = require("node:util");
const uiohookNapi = require("uiohook-napi");
const node_module = require("node:module");
const undici = require("undici");
const require$$0 = require("events");
const require$$0$3 = require("crypto");
const require$$1 = require("tty");
const require$$1$1 = require("util");
const require$$0$1 = require("os");
const require$$2 = require("fs");
const require$$0$2 = require("stream");
const require$$4 = require("url");
const electronUpdater = require("electron-updater");
const node_zlib = require("node:zlib");
const MANUAL_TRANSLATION_MAX_CHARS = 5e3;
const DEFAULT_AI_BASE_URL = "http://127.0.0.1:11434";
function isAiProtocol(value) {
  return value === "ollama" || value === "openai" || value === "claude-code";
}
const DEFAULT_OCR_SCALE = 1;
function isOcrEnginePreference(value) {
  return value === "auto" || value === "system" || value === "paddle" || value === "tesseract";
}
function normalizeOcrScale$1(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_OCR_SCALE;
  return Math.min(3, Math.max(1, numeric));
}
const DEFAULT_LOCALE = "en-US";
function normalizeLocaleTag(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/_/gu, "-").replace(/\.[^@]*$/u, "").replace(/@.*$/u, "").trim().toLowerCase();
  if (!normalized || normalized === "c" || normalized === "posix") return null;
  const language = normalized.split("-")[0];
  if (language === "zh") return "zh-CN";
  if (language === "en") return "en-US";
  return null;
}
function normalizeUiLocale(value) {
  return value === "auto" || value === "zh-CN" || value === "en-US" ? value : "auto";
}
function resolveLocale(uiLocale, candidates = []) {
  const preference = normalizeUiLocale(uiLocale);
  if (preference !== "auto") return preference;
  for (const candidate of candidates) {
    const locale = normalizeLocaleTag(candidate);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}
function defineCatalog(catalog) {
  return catalog;
}
const enUSBase = defineCatalog({
  "app.name": "Selection Translator",
  "app.startupFailed.message": "The application could not finish starting: {{message}}",
  "app.startupFailed.title": "Selection Translator failed to start",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.maximize": "Maximize",
  "common.minimize": "Minimize",
  "common.ok": "OK",
  "common.retry": "Retry",
  "common.save": "Save",
  "common.unknownError": "Unknown error",
  "common.windowControls": "Window controls",
  "dialog.exportDiagnostics.title": "Export Selection Diagnostics",
  "dialog.exportLogs.title": "Export Logs",
  "dialog.installFromDiskImage.continue": "Run Anyway",
  "dialog.installFromDiskImage.detail": "Copy “Selection Translator” to the Applications folder, then launch it from there to avoid an old instance continuing to run after reinstall.",
  "dialog.installFromDiskImage.exit": "Quit",
  "dialog.installFromDiskImage.message": "The application is currently running from a disk image",
  "dialog.installFromDiskImage.title": "Install Selection Translator first",
  "dialog.quarantine.cancelled": "macOS quarantine removal was cancelled",
  "dialog.quarantine.confirm": "Installed, Continue",
  "dialog.quarantine.detail": "Continue after confirming the replacement is complete. This only processes /Applications/Selection Translator.app, does not use sudo, and cannot repair a code-signing mismatch.",
  "dialog.quarantine.message": "Download the DMG first, then drag “Selection Translator” into Applications to replace the old version",
  "dialog.quarantine.title": "Confirm macOS quarantine removal",
  "dialog.selectionService.message": "The selection button did not appear or selection failed repeatedly",
  "dialog.selectionService.title": "Selection service error",
  "error.copyShortcutAsOcrHotkey": "Ctrl+C / Command+C is the system copy shortcut and cannot be used as the OCR shortcut",
  "error.copyShortcutAsTranslationHotkey": "Ctrl+C / Command+C is the system copy shortcut and cannot be used as the translation shortcut",
  "error.shortcutConflictCopy": "Ctrl+C / Command+C is the system copy shortcut and cannot be assigned",
  "error.shortcutConflictDuplicate": "This shortcut is already used by another feature",
  "error.shortcutOccupied": "The shortcut is occupied by the system or another app",
  "error.shortcutInvalid": "The shortcut format is invalid",
  "error.dingTalkCredentialsUnavailable": "DingTalk credentials could not be read securely; please configure them again",
  "error.edgeSpeechEmptyText": "Speech text is empty",
  "error.edgeSpeechUnavailable": "Edge speech service is temporarily unavailable",
  "error.openWebReader": "Unable to open the web reader",
  "error.webTranslation": "Web Translation",
  "menu.autoBilingual": "Auto Chinese-English",
  "menu.clipboardImageOcr": "Clipboard Image OCR Translation…",
  "menu.manualTranslation": "Translate Manually…",
  "menu.openWebTranslation": "Open Web Translation…",
  "menu.quit": "Quit",
  "menu.repairMacSelectionService": "Repair macOS selection service…",
  "menu.screenshotOcr": "Screenshot OCR Translation…",
  "menu.settings": "Settings",
  "menu.showSelectionButton": "Show “Translate” button after selecting text",
  "menu.sourceLanguage": "Source Language",
  "menu.targetLanguage": "Target Language",
  "popup.chooseProvider": "Choose preferred translation API",
  "popup.clear": "Clear",
  "popup.clearManualSource": "Clear manual source text",
  "popup.copy": "Copy",
  "popup.copyOcrContent": "Copy OCR content",
  "popup.copyTranslation": "Copy translation",
  "popup.dragHandle.ariaLabel": "Drag translation window",
  "popup.dragHandle.title": "Drag window",
  "popup.languageToolbar": "Translation language toolbar",
  "popup.manualHint": "Enter / ⌘+Ctrl + Enter to translate",
  "popup.manualMode": "Toggle manual translation",
  "popup.manualPlaceholder": "Enter or paste text to translate",
  "popup.manualStale": "The source text or settings changed. Translate again.",
  "popup.manualTranslation": "Manual translation",
  "popup.ocrContent": "OCR content",
  "popup.ocrEngine": "OCR engine",
  "popup.openSettings": "Open settings",
  "popup.openWebReader": "Open web translation",
  "popup.selectionResult": "Selection translation result",
  "popup.speakUnavailable": "No translation to read aloud",
  "popup.statusActions": "Translation status and actions",
  "popup.translate": "Translate",
  "popup.translateOriginal": "Source text",
  "popup.translationApi": "Translation API",
  "popup.translationResult": "Translation",
  "selection.annotationColor": "Annotation color",
  "selection.annotationStyle": "Annotation style",
  "selection.annotationText": "Annotation text",
  "selection.annotationTools": "Annotation tools",
  "selection.boldText": "Bold text",
  "selection.chooseAnnotationColor": "Choose annotation color",
  "selection.clearAnnotations": "Clear annotations",
  "selection.color.blue": "Blue",
  "selection.color.green": "Green",
  "selection.color.orange": "Orange",
  "selection.color.purple": "Purple",
  "selection.color.red": "Red",
  "selection.color.yellow": "Yellow",
  "selection.copyImage": "Copy image",
  "selection.customColor": "Custom annotation color",
  "selection.fontSize": "Font size",
  "selection.mosaicBrushSize": "Mosaic brush size",
  "selection.mosaicIntensity": "Mosaic intensity",
  "selection.mosaicLevel.high": "High",
  "selection.mosaicLevel.low": "Low",
  "selection.mosaicLevel.medium": "Medium",
  "selection.ocrCapture": "OCR screenshot capture",
  "selection.ocrResult": "OCR result",
  "selection.ocrSource": "OCR source text",
  "selection.recognize": "Recognize text",
  "selection.redo": "Redo",
  "selection.redoAnnotation": "Redo annotation",
  "selection.resizeResult": "Resize OCR result area",
  "selection.saveImage": "Save to disk",
  "selection.screenshotActions": "Screenshot actions",
  "selection.strokeWidth": "Stroke width",
  "selection.tip": "Drag to select an area, move or resize it, then click Recognize to start OCR. Press Esc to cancel.",
  "selection.tool.arrow": "Arrow",
  "selection.tool.brush": "Brush",
  "selection.tool.ellipse": "Ellipse",
  "selection.tool.mosaic": "Mosaic",
  "selection.tool.rect": "Rectangle",
  "selection.tool.text": "Text",
  "selection.translate": "Translate",
  "selection.translateSelected": "Translate selected text",
  "selection.undo": "Undo",
  "selection.undoAnnotation": "Undo annotation",
  "selection.windowTitle": "Translate Selected Text / OCR Capture",
  "selection.recognizing": "Recognizing text in the selected area…",
  "selection.recognizeComplete": "Recognition complete",
  "selection.recognizeCompleteWithEngine": "Recognition complete ({{engine}})",
  "selection.noTextRecognized": "No text recognized",
  "selection.recognizeFailed": "Recognition failed. Try again.",
  "selection.copyingImage": "Copying image…",
  "selection.preparingSave": "Preparing to save…",
  "selection.screenshotNotReady": "The screenshot is not ready yet. Try again in a moment.",
  "selection.copyImageFailed": "Failed to copy image",
  "selection.saveImageFailed": "Failed to save image",
  "selection.screenshotLoadFailed": "Failed to load screenshot. Take a new screenshot.",
  "selection.tipLoading": "Capturing the screen; you can drag to select an area first. Press Esc to cancel.",
  "settings.about.author": "Author",
  "settings.about.email": "Email",
  "settings.about.project": "Project",
  "settings.about.projectHint": "Selection Translator is a desktop translation tool for macOS, Windows, and Linux. Update packages come from the project's public GitHub Releases.",
  "settings.ai.apiKey": "API Key",
  "settings.ai.apiKeyMissing": "API key not configured",
  "settings.ai.apiKeyPlaceholder": "Leave blank to keep the configured key",
  "settings.ai.availableModels": "Available models",
  "settings.ai.baseUrl": "Base URL",
  "settings.ai.baseUrlPlaceholder": "e.g. http://127.0.0.1:11434",
  "settings.ai.check": "Test configuration",
  "settings.ai.clearKey": "Clear API key",
  "settings.ai.enabled": "Enable channel",
  "settings.ai.enabledLabel": "Prefer AI translation",
  "settings.ai.expandModels": "Expand model list",
  "settings.ai.hint": "Use a local or cloud large language model for selection translation. Ollama, OpenAI-compatible, and Claude Code (Anthropic)-compatible HTTP protocols are supported. The API key is stored securely on this device only and is never shown again in the page.",
  "settings.ai.model": "Model",
  "settings.ai.modelPlaceholder": "Select or type a model name",
  "settings.ai.modelsNotLoaded": "Model list not loaded",
  "settings.ai.notChecked": "Not tested",
  "settings.ai.protocol": "Protocol",
  "settings.ai.protocolAria": "AI protocol",
  "settings.ai.protocolClaude": "Claude Code-compatible",
  "settings.ai.protocolOpenai": "OpenAI-compatible",
  "settings.ai.refreshModels": "Refresh model list",
  "settings.ai.save": "Save AI settings",
  "settings.ai.title": "AI Translation",
  "settings.appearance.title": "Appearance",
  "settings.autoSaveHint": "All changes are saved automatically and take effect immediately",
  "settings.brand": "Selection Translator settings",
  "settings.categories": "Settings categories",
  "settings.channels.dingTalkDesc": "used first when enabled and fully configured",
  "settings.channels.dingTalkName": "DingTalk",
  "settings.channels.googleDesc": "free; some networks require a proxy",
  "settings.channels.googleName": "Google",
  "settings.channels.hint": "Channels are tried in the following order by default; you can also choose a preferred API at the bottom of the popup. If the preferred API fails or its circuit breaker opens, the app automatically switches to the next one and keeps your preference for future translations.",
  "settings.channels.microsoftDesc": "no subscription required; used before free channels such as DeepLX when enabled",
  "settings.channels.microsoftName": "Microsoft Translator",
  "settings.channels.myMemoryDesc": "fallback with no registration but a free quota limit",
  "settings.channels.myMemoryName": "MyMemory",
  "settings.channels.publicDesc": "free, may be rate-limited",
  "settings.channels.publicName": "Public DeepLX",
  "settings.channels.selfHostedDesc": "configurable and the most stable (recommended)",
  "settings.channels.selfHostedName": "Self-hosted DeepLX",
  "settings.channels.title": "Translation Channels",
  "settings.deepLx.check": "Check online status",
  "settings.deepLx.copyCommand": "Copy command",
  "settings.deepLx.deployHint": "Deploy with one Docker command: replace the dl_session placeholder in the command with the dl_session cookie from your DeepL login, then run it in a terminal.",
  "settings.deepLx.notChecked": "Not tested",
  "settings.deepLx.openDoc": "Open deployment docs",
  "settings.deepLx.save": "Save settings",
  "settings.deepLx.title": "Self-hosted DeepLX",
  "settings.deepLx.url": "Service URL",
  "settings.deepLx.urlHint": "You can configure multiple service URLs, separated by English or Chinese commas. Translations rotate across the URLs and automatically switch on failure.",
  "settings.deepLx.urlPlaceholder": "http://127.0.0.1:1189/translate, https://example.com/translate",
  "settings.diagnostics.collapse": "Collapse",
  "settings.diagnostics.export": "Export diagnostics",
  "settings.diagnostics.hint": "Records the hit level, duration, and failure reason for each selection. Only the last two days are kept, and no selected text is stored.",
  "settings.diagnostics.title": "Selection Diagnostics",
  "settings.dingTalk.check": "Test configuration",
  "settings.dingTalk.clearSecret": "Clear secret",
  "settings.dingTalk.clientId": "ClientId",
  "settings.dingTalk.clientIdPlaceholder": "Enter the app ClientId",
  "settings.dingTalk.clientSecret": "ClientSecret",
  "settings.dingTalk.corpId": "CorpId",
  "settings.dingTalk.corpIdPlaceholder": "Enter the enterprise CorpId",
  "settings.dingTalk.enabled": "Enable channel",
  "settings.dingTalk.enabledLabel": "Prefer DingTalk translation",
  "settings.dingTalk.hint": "For accounts that have created an internal enterprise app with the AI text translation permission enabled. The ClientSecret is stored securely on this device only and is never shown again in the page.",
  "settings.dingTalk.notChecked": "Not tested",
  "settings.dingTalk.save": "Save DingTalk settings",
  "settings.dingTalk.secretMissing": "Secret not configured",
  "settings.dingTalk.secretPlaceholder": "Leave blank to keep the configured secret",
  "settings.dingTalk.title": "DingTalk",
  "settings.language.title": "Translation Languages",
  "settings.launch.autoLaunch": "Launch at login",
  "settings.launch.autoLaunchHint": "When enabled, the app starts at login and stays in the tray. Development mode does not write a system login item.",
  "settings.launch.autoLaunchLabel": "Run Selection Translator automatically at login",
  "settings.launch.dock": "Dock",
  "settings.launch.dockHint": "macOS only. Clicking the Dock icon opens Settings.",
  "settings.launch.showDock": "Show Dock icon",
  "settings.launch.title": "App Appearance and Startup",
  "settings.logs.clear": "Clear",
  "settings.logs.export": "Export",
  "settings.logs.filterAria": "Log level filters",
  "settings.logs.levelError": "Error",
  "settings.logs.levelInfo": "Info",
  "settings.logs.levelWarn": "Warning",
  "settings.logs.pause": "Pause",
  "settings.logs.search": "Search log contents",
  "settings.microsoft.check": "Check availability",
  "settings.microsoft.enabled": "Enable channel",
  "settings.microsoft.enabledLabel": "Use Microsoft Translator before free channels such as DeepLX",
  "settings.microsoft.hint": "Uses Microsoft Bing online translation. No Azure account, subscription key, or region is required. Once enabled, it joins the automatic translation fallback chain.",
  "settings.microsoft.notChecked": "Not tested",
  "settings.microsoft.title": "Microsoft Translator",
  "settings.microsoft.warning": "This channel relies on temporary parameters from Bing web translation and is not a publicly documented Microsoft developer API with stability guarantees. The interface may break if the service changes; on failure, the app automatically switches to the next channel.",
  "settings.ocr.assetLicense": "License",
  "settings.ocr.assetModel": "Model",
  "settings.ocr.assetVersion": "Version",
  "settings.ocr.assetsTitle": "Model Assets",
  "settings.ocr.engineAuto": "Auto select",
  "settings.ocr.enginePaddle": "PaddleOCR only",
  "settings.ocr.enginePreference": "Engine preference",
  "settings.ocr.engineSystem": "System OCR only",
  "settings.ocr.engineTesseract": "Tesseract only",
  "settings.ocr.hotkey": "Screenshot hotkey",
  "settings.ocr.hotkeyPlaceholder": "Click, then press a shortcut",
  "settings.ocr.lang": "Recognition language",
  "settings.ocr.langAuto": "Auto",
  "settings.ocr.loading": "Loading…",
  "settings.ocr.privacyHint": "Screenshots and clipboard images are recognized only when you explicitly trigger it; local OCR engines never upload images.",
  "settings.ocr.readingStatus": "Reading OCR status…",
  "settings.ocr.scale": "Max retry scale",
  "settings.ocr.scaleHint": "The first pass always uses 1×; this value only limits the maximum upscale used during low-quality fallback.",
  "settings.ocr.tesseract": "Tesseract",
  "settings.ocr.tesseractFallback": "Enable fallback recognition",
  "settings.ocr.title": "OCR Translation",
  "settings.proxy.bypass": "Bypass rules",
  "settings.proxy.bypassHint": "Separate multiple rules with semicolons; keep <local> and localhost for a local DeepLX service.",
  "settings.proxy.bypassPlaceholder": "<local>;localhost;127.0.0.1",
  "settings.proxy.mode": "Proxy mode",
  "settings.proxy.modeCustom": "Custom proxy",
  "settings.proxy.modeDirect": "Direct (no proxy)",
  "settings.proxy.modeSystem": "Follow system proxy",
  "settings.proxy.rules": "Proxy address",
  "settings.proxy.rulesHint": "Supports HTTP, HTTPS, SOCKS4, and SOCKS5, for example socks5://127.0.0.1:7890.",
  "settings.proxy.rulesPlaceholder": "http://127.0.0.1:7890",
  "settings.proxy.title": "Network Proxy",
  "settings.schemaVersion": "Settings schema version",
  "settings.service.hint": "Stopping the service exits the tray icon and selection translation; restart the app when you need it again.",
  "settings.service.stop": "Close and stop service",
  "settings.service.title": "Service Control",
  "settings.sourceLang.auto": "Auto Detect",
  "settings.speech.edge": "Edge online neural voice",
  "settings.speech.provider": "Speech engine",
  "settings.speech.system": "System voice (default)",
  "settings.speech.title": "Speech",
  "settings.tab.about": "About",
  "settings.tab.advanced": "Advanced",
  "settings.tab.ai": "AI Translation",
  "settings.tab.general": "General",
  "settings.tab.logs": "Logs",
  "settings.tab.ocr": "OCR",
  "settings.tab.translationServices": "Translation Services",
  "settings.themeMode.dark": "Always dark",
  "settings.themeMode.hint": "The theme is applied immediately to the popup, settings, screenshot tools, and web reader.",
  "settings.themeMode.label": "Theme mode",
  "settings.themeMode.light": "Always light",
  "settings.themeMode.system": "Follow system",
  "settings.themePreset.emerald.desc": "Fresh and natural",
  "settings.themePreset.emerald.name": "Emerald",
  "settings.themePreset.group": "Theme colors",
  "settings.themePreset.navy.desc": "Calm and understated",
  "settings.themePreset.navy.name": "Navy",
  "settings.themePreset.platinumBlack.desc": "Premium and minimal",
  "settings.themePreset.platinumBlack.name": "Platinum Black",
  "settings.themePreset.sakura.desc": "Soft and light",
  "settings.themePreset.sakura.name": "Sakura Pink",
  "settings.themePreset.sky.desc": "Clear and professional",
  "settings.themePreset.sky.name": "Sky Blue",
  "settings.titlebar": "Settings window title bar",
  "settings.trigger.autoHide": "Auto-hide result",
  "settings.trigger.autoHide.never": "Never (default)",
  "settings.trigger.autoHide.seconds15": "15 seconds",
  "settings.trigger.autoHide.seconds3": "3 seconds",
  "settings.trigger.autoHide.seconds5": "5 seconds",
  "settings.trigger.autoHide.seconds8": "8 seconds",
  "settings.trigger.doubleClick": "Double-click selection",
  "settings.trigger.doubleClickHint": "When disabled, double-click selection no longer shows the Translate button. Drag selection still follows the trigger mode above.",
  "settings.trigger.doubleClickLabel": "Show the Translate button when selecting by double-click",
  "settings.trigger.globalHotkey": "Global hotkey",
  "settings.trigger.manualHotkey": "Manual translation",
  "settings.trigger.webReaderHotkey": "Web reader",
  "settings.trigger.clearHotkey": "Clear",
  "settings.trigger.hotkeyRegistrationFailed": "Shortcut registration failed: {message}",
  "settings.trigger.hotkeyPlaceholder": "Click, then press a shortcut",
  "settings.trigger.mode.auto": "Open and translate automatically after selection",
  "settings.trigger.mode.button": "Show the Translate button after selection",
  "settings.trigger.mode.hotkey": "Open with hotkey only",
  "settings.trigger.modeLabel": "Trigger mode",
  "settings.trigger.selectionButton": "Selection button",
  "settings.trigger.selectionButtonHint": "When enabled, selection uses button trigger mode; when disabled, it uses hotkey-only mode. This stays in sync with Trigger mode and the tray menu.",
  "settings.trigger.selectionButtonLabel": "Show the Translate button automatically after selecting text",
  "settings.trigger.title": "Trigger and Popup",
  "settings.uiLocale.auto": "Follow system",
  "settings.uiLocale.enUS": "English",
  "settings.uiLocale.hint": "Applies immediately to all open windows and the tray menu.",
  "settings.uiLocale.label": "Interface language",
  "settings.uiLocale.title": "Interface language",
  "settings.uiLocale.zhCN": "Simplified Chinese",
  "settings.update.buildIdentity": "Build identity",
  "settings.update.cancelDownload": "Cancel download",
  "settings.update.check": "Check for updates",
  "settings.update.currentVersion": "Current version",
  "settings.update.downloadDmg": "Download and open DMG",
  "settings.update.installHint": "A manual macOS upgrade downloads and opens the DMG; you still confirm dragging the app into Applications.",
  "settings.update.latestVersion": "Latest version",
  "settings.update.notChecked": "Not checked yet",
  "settings.update.openRelease": "Open release page",
  "settings.update.readingStatus": "Reading update status…",
  "settings.update.removeQuarantine": "Remove macOS quarantine",
  "settings.update.title": "Version and Updates",
  "settings.web.concurrency": "Concurrent requests",
  "settings.web.concurrencyHint": "Higher concurrency translates long pages faster but increases momentary load on the provider and may trigger rate limits; use higher values only with a self-hosted or high-quota channel.",
  "settings.web.defaultMode": "Default view",
  "settings.web.enabled": "Enable web translation",
  "settings.web.enabledLabel": "Allow opening the built-in web translation reader",
  "settings.web.imageOcr": "Image text recognition",
  "settings.web.imageOcrHint": "When enabled, the reader reads image bytes through the current page session and falls back to a screenshot of the image region when needed. Images that fail recognition, are too small, or exceed the limit are skipped without affecting text translation. Images are processed locally, and OCR results are sent to the selected translation service only while translating the current page.",
  "settings.web.imageOcrLabel": "Run OCR on page images and translate the text inside them",
  "settings.web.imageOverlay": "Image translation display",
  "settings.web.maxBlocks": "Max text blocks",
  "settings.web.maxChars": "Max total characters",
  "settings.web.maxImages": "Max images per page",
  "settings.web.minImageSize": "Minimum image edge",
  "settings.web.modeBilingual": "Side by side",
  "settings.web.modeSource": "Original",
  "settings.web.modeTarget": "Translation",
  "settings.web.overlayBelow": "Caption below image",
  "settings.web.overlayOnImage": "Overlay on image",
  "settings.web.readHint": "The app reads the current page text only after you open the built-in reader and explicitly click Extract or Translate. It never reads pages already open in your system browser.",
  "settings.web.scope": "Translation scope",
  "settings.web.scopeAll": "All visible text",
  "settings.web.scopeBody": "Main content only",
  "settings.web.title": "Web Page Translation",
  "settings.windowTitle": "Selection Translator · Settings",
  "toast.copiedToClipboard": "Added to clipboard",
  "toast.savedToDisk": "Saved to disk",
  "popup.speechCompleted": "Reading finished",
  "popup.edgeSpeechCancelled": "Edge speech request cancelled",
  "popup.edgeSpeechRequesting": "Requesting Edge speech…",
  "popup.edgeSpeechPlaying": "Playing Edge speech…",
  "popup.autoDetect": "Auto detect",
  "popup.autoBilingual": "Auto Chinese-English",
  "popup.autoSelect": "Auto select",
  "popup.providerDisabled": "disabled",
  "popup.providerDisabledLabel": "{{provider}} (disabled)",
  "popup.providerPreferred": "Preferred translation API: {{provider}}",
  "popup.providerAutoActual": "Auto selected; actually using: {{provider}}",
  "popup.providerAutoActualShort": "Auto · {{provider}}",
  "popup.providerFallbackActual": "Preferred {{preferred}} is unavailable or circuit-broken; actually using: {{actual}}",
  "popup.providerPreferredActual": "Preferred and actually used: {{provider}}",
  "popup.speechStop": "Stop reading",
  "popup.speechUnavailable": "No translation to read aloud",
  "popup.speechEdgeHint": "Read the translation aloud with Edge online speech",
  "popup.speechSystemUnavailable": "Read translation aloud (system voice required)",
  "popup.speechRead": "Read translation aloud",
  "popup.speechStopped": "Reading stopped",
  "popup.edgeSpeechUnavailable": "Edge online speech is temporarily unavailable",
  "popup.edgeSpeechUnavailableWithError": "Edge online speech is temporarily unavailable: {{error}}. Switched to system voice.",
  "popup.ocrSystem": "System OCR",
  "popup.ocrEmpty": "No text recognized",
  "popup.ocrNoise": "Recognized text quality is too low (noise)",
  "popup.ocrPermission": "Screen Recording permission is missing; grant it in System Settings",
  "popup.ocrNoClipboardImage": "No image in the clipboard",
  "popup.ocrTimeout": "OCR timed out",
  "popup.ocrEngineUnavailable": "OCR engine unavailable",
  "popup.ocrRecognizing": "Recognizing text in the image…",
  "popup.translating": "Translating…",
  "popup.translationFailed": "Translation failed",
  "popup.translationPlaceholder": "The translation will appear here",
  "popup.translationRequestFailed": "Translation request failed. Try again.",
  "popup.languageSaveFailed": "Failed to save language settings",
  "popup.retranslationFailed": "Retranslation failed",
  "popup.providerSwitchFailed": "Failed to switch the translation API",
  "popup.copied": "Copied",
  "popup.unpinWindow": "Unpin window",
  "popup.pin": "Pin window",
  "popup.ocrCopied": "OCR content copied",
  "popup.translatingInto": "Translating into {{language}}…",
  "popup.providerPreferredApplied": "Now preferring {{provider}}",
  "popup.edgeAudioReceived": "Edge audio received ({{bytes}} bytes)",
  "popup.switchToSelection": "Switch to selection translation",
  "popup.validation.invalidSource": "Invalid source text format",
  "popup.validation.emptySource": "Enter the source text to translate",
  "popup.validation.sourceTooLong": "The source text cannot exceed {{max}} characters",
  "toast.windowTitle": "Screenshot Notification",
  "update.available": "Version {{version}} is available; download it to upgrade",
  "update.availableManual": "Version {{version}} is available; this environment requires a manual installation",
  "update.cancelled": "Download cancelled; click upgrade to continue",
  "update.checking": "Checking for updates…",
  "update.checksumMismatch": "; the release SHA256SUMS does not match the package, so upgrade again",
  "update.checksumMissing": "; the release is missing the SHA256SUMS checksum for this package, so upgrading is recommended",
  "update.checksumNeedsUpdateMismatch": "The SHA256SUMS checksum for this version does not match; upgrading is recommended",
  "update.checksumNeedsUpdateMissing": "This version has no SHA256SUMS checksum; upgrading is recommended",
  "update.checksumUnreachable": "; unable to read the release SHA256SUMS checksum, so verify the package source",
  "update.disabled": "Updates are not checked in the development environment",
  "update.downloaded": "Version {{version}} has been downloaded and will be installed after restart",
  "update.progress.downloaded": "Downloaded {{size}}",
  "update.downloading": "Downloading update… {{percent}}%",
  "update.downloadingInitial": "Downloading update…",
  "update.error.downloadInterrupted": "Update failed: the download connection was interrupted. The resume point was saved; click upgrade to continue.",
  "update.error.downloadTimeout": "Update failed: the download connection timed out. The resume point was saved; click upgrade to continue.",
  "update.error.generic": "Update failed: {{message}}",
  "update.error.missingManifest": "This GitHub Release is missing the update manifest {{manifest}}. Check again later or open the release page to install manually.",
  "update.error.networkInterrupted": "Update failed: the network connection was interrupted. Check your network or proxy settings and try again.",
  "update.error.networkTimeout": "Update failed: the network request timed out. Check your network or proxy settings and try again.",
  "update.error.networkUnavailable": "Update failed: cannot connect to the update server. Check your network or proxy settings and try again.",
  "update.downloadError.cancelled": "Download cancelled",
  "update.downloadError.networkInterrupted": "The network connection was interrupted",
  "update.downloadError.requestTimeout": "The segment request timed out",
  "update.downloadError.readTimeout": "The segment read timed out",
  "update.downloadError.writeFailed": "Failed to write the update temporary file",
  "update.downloadError.segmentFailed": "Segment download failed (bytes {{start}}-{{end}}): {{message}}",
  "update.downloadError.unknown": "Unknown error",
  "update.downloadError.lengthMismatch": "Update package length validation failed: expected {{expected}} bytes, got {{actual}} bytes",
  "update.downloadError.checksumMismatch": "Update package checksum validation failed",
  "update.downloadError.invalidUrl": "The DMG download URL is invalid",
  "update.downloadError.insecureUrl": "DMG downloads only support HTTPS URLs",
  "update.downloadError.notDmg": "The update download URL must point to a DMG file",
  "update.downloadError.redirectMissingLocation": "The DMG download redirect is missing a target URL",
  "update.downloadError.tooManyRedirects": "The DMG download had too many redirects",
  "update.downloadError.downloadHttpFailed": "DMG download failed (HTTP {{status}})",
  "update.downloadError.unknownStatus": "unknown status",
  "update.downloadError.integrityFailed": "Update package integrity validation failed; the downloaded file was deleted. Download it again or install manually from the release page",
  "update.downloadError.openFailed": "Unable to open the downloaded DMG: {{message}}",
  "update.error.signatureMismatch": "The update package signature is incompatible with this app. Manual installation is required: download the DMG, drag the app into Applications, and replace the old version.",
  "update.idle": "Not checked for updates yet",
  "update.integrityNoticeMissing": " The update manifest did not provide a checksum for this DMG, so the package was not verified.",
  "update.manualDmgDownloading": "Downloading the macOS DMG update…",
  "update.manualDownloaded": "The update package has been downloaded to Downloads and the DMG is open; drag “Selection Translator” into Applications to replace the old version, then click “Remove macOS Quarantine”.",
  "update.noDmgFallback": "The update manifest has no directly downloadable DMG; GitHub Release has been opened for manual installation",
  "update.notAvailable": "You are using the latest version",
  "update.notAvailableWithBuild": "You are using the latest build (build {{build}})",
  "update.openRelease": "GitHub Release has been opened; download the package for your platform and install it manually",
  "update.sameVersion.downloadAction": "a DMG is available for replacement installation",
  "update.sameVersion.message": "Found a new build of the same version {{version}} (current build {{localBuild}}, latest build {{remoteBuild}}); {{action}}",
  "update.sameVersion.releaseAction": "open GitHub Release to update manually",
  "webReader.address": "Web address",
  "webReader.addressPlaceholder": "Enter a web address, for example example.com",
  "webReader.back": "Back",
  "webReader.brand": "Selection Translator web translation",
  "webReader.contentArea": "Web page content area",
  "webReader.display": "Display",
  "webReader.displayMode": "Web page display mode",
  "webReader.forward": "Forward",
  "webReader.loadingProgress": "Web page loading progress",
  "webReader.mode.bilingual": "Bilingual",
  "webReader.mode.source": "Original",
  "webReader.mode.target": "Translation",
  "webReader.navigationToolbar": "Web translation navigation toolbar",
  "webReader.reload": "Reload",
  "webReader.titlebar": "Web translation window title bar",
  "webReader.translatePage": "Translate Page",
  "webReader.windowTitle": "Web Translation",
  "webReader.restore": "Restore",
  "webReader.maximize": "Maximize",
  "webReader.pageUpdated": "The page has new content. Existing translations were kept; click Translate again to fill in.",
  "webReader.loadingAndTranslating": "Translating while loading: {{done}} done / {{discovered}} discovered",
  "webReader.loadingPage": "Loading page…",
  "webReader.imageProgress": "images {{processed}}/{{candidates}}",
  "webReader.imageSkipped": ", {{count}} skipped",
  "webReader.imageFailed": ", {{count}} failed",
  "webReader.imageHintPrefix": ", ",
  "webReader.cacheHits": ", {{count}} cache hits",
  "webReader.failureCount": ", {{count}} failed",
  "webReader.cancelled": "Translation cancelled",
  "webReader.extracting": "Extracting page text…",
  "webReader.translatingProgress": "Translating: {{done}}/{{total}}",
  "webReader.continuedWithMismatch": "Translation continued; {{count}} items were not written back because the page changed. Existing translations were kept; click Translate again to fill in.",
  "webReader.partialResult": "Only part of the page was translated{{failed}}{{images}}; initial loading has finished, click Translate again to fill in.",
  "webReader.completedImagesPartial": "Translation complete; some images were not processed{{images}}",
  "webReader.completedInputOpen": "Translation complete; initial loading collection is still in progress{{images}}",
  "webReader.completed": "Translation complete{{images}}",
  "webReader.translationFailed": "Web page translation failed",
  "webReader.switchSkippedHint": ", {{count}} short text/interactive blocks were skipped by design",
  "webReader.switchedUnrendered": "Switched to bilingual view; {{count}} blocks were not aligned. Click Translate again to fill in.",
  "webReader.switchedMismatched": "Switched to bilingual view; {{count}} items were not aligned because the page changed. Click Translate again to fill in.",
  "webReader.currentBilingual": "Showing bilingual view",
  "webReader.partialContentChanged": "Some content changed; unaffected translations were kept. Click Translate again to fill in.",
  "webReader.showingSource": "Showing original",
  "webReader.showingTarget": "Showing translation",
  "webReader.switchModeFailed": "Failed to switch the web page display",
  "webReader.enterAddress": "Enter a web address",
  "webReader.invalidAddress": "Invalid web address",
  "lang.AR": "Arabic",
  "lang.BG": "Bulgarian",
  "lang.CS": "Czech",
  "lang.DA": "Danish",
  "lang.DE": "German",
  "lang.EL": "Greek",
  "lang.EN": "English",
  "lang.ES": "Spanish",
  "lang.ET": "Estonian",
  "lang.FI": "Finnish",
  "lang.FR": "French",
  "lang.HU": "Hungarian",
  "lang.ID": "Indonesian",
  "lang.IT": "Italian",
  "lang.JA": "Japanese",
  "lang.KO": "Korean",
  "lang.LT": "Lithuanian",
  "lang.LV": "Latvian",
  "lang.NL": "Dutch",
  "lang.PL": "Polish",
  "lang.PT": "Portuguese",
  "lang.RO": "Romanian",
  "lang.RU": "Russian",
  "lang.SK": "Slovak",
  "lang.SL": "Slovenian",
  "lang.SV": "Swedish",
  "lang.TR": "Turkish",
  "lang.UK": "Ukrainian",
  "lang.ZH": "Chinese",
  "provider.ai": "AI Translation",
  "provider.auto": "Auto Select",
  "provider.deeplx-public": "Public DeepLX",
  "provider.deeplx-self": "Self-hosted DeepLX",
  "provider.dingtalk": "DingTalk Translation",
  "provider.google": "Google Translate",
  "provider.microsoft": "Microsoft Translator",
  "provider.mymemory": "MyMemory Translation",
  "common.notApplicable": "N/A",
  "common.yes": "Yes",
  "common.no": "No",
  "notification.brand": "Selection Translator",
  "notification.install.subject": "[Selection Translator] First Install Notification - {{version}}",
  "notification.upgrade.subject": "[Selection Translator] Upgrade Notification - {{version}}",
  "notification.title": "Selection Translator - Install/Upgrade Event Notification",
  "notification.section.event": "Event Information",
  "notification.section.environment": "Runtime Environment",
  "notification.event.type": "Event type",
  "notification.event.install": "First install",
  "notification.event.upgrade": "Upgrade",
  "notification.previousVersion": "Previous version",
  "notification.previousVersion.none": "None (fresh install)",
  "notification.currentVersion": "Current version",
  "notification.eventTime": "Event time",
  "notification.platform": "Operating system",
  "notification.kernel": "Kernel",
  "notification.ip": "Public IP",
  "notification.location": "IP location",
  "notification.unknown": "Unknown",
  "notification.footer": "Note: This notification is an automated report. It records only device installation/upgrade activity and contains no user privacy data.",
  "notification.ipUnavailable": "Unable to obtain the public IP address",
  "usage.brand": "Selection Translator",
  "usage.subject": "[Selection Translator] Daily Usage Report - {{date}}",
  "usage.title": "Selection Translator - Daily Usage Report",
  "usage.section.environment": "Runtime Environment",
  "usage.section.daily": "Daily Usage Statistics",
  "usage.platform": "Operating system",
  "usage.kernel": "Kernel",
  "usage.appVersion": "App version",
  "usage.buildId": "Build ID",
  "usage.ip": "Public IP",
  "usage.location": "IP location",
  "usage.unknown": "Unknown",
  "usage.date": "Report date",
  "usage.noRecords": "No translation activity recorded for this day",
  "usage.channel.title": "Translations by method",
  "usage.provider.title": "Translations by provider",
  "usage.count": "{{count}} times",
  "usage.count.plural": { one: "{{count}} time", other: "{{count}} times" },
  "usage.footer": "Note: This report contains only aggregated usage counts, public IP address, and IP location. It does not contain any translated user text.",
  "usage.channel.hotkey": "Hotkey translation",
  "usage.channel.selection": "Selection translation",
  "usage.channel.screenshot": "Screenshot translation",
  "usage.channel.webpage": "Web page translation",
  "usage.provider.ai": "AI translation",
  "usage.provider.dingtalk": "DingTalk",
  "usage.provider.microsoft": "Microsoft",
  "usage.provider.google": "Google",
  "usage.provider.deeplx-self": "Self-hosted DeepLX",
  "update.items": {
    zero: "No items",
    one: "{{count}} item",
    other: "{{count}} items"
  },
  "common.restore": "Restore",
  "settings.saved": "Saved and applied",
  "settings.saveFailed": "Save failed: {{message}}",
  "settings.targetLang.auto": "Auto Chinese-English",
  "settings.trigger.hint.auto": "Opens the translation popup automatically after you select text; requires macOS Accessibility permission.",
  "settings.trigger.hint.button": "Shows the “Translate” button on every selection; the popup opens or updates only after you click it.",
  "settings.trigger.hint.hotkey": "Nothing pops up after selection; press the global shortcut configured below.",
  "settings.speech.hint.edge": "Requires network access and sends the spoken text to Microsoft online services; this free unofficial endpoint may break at any time, and failures fall back to system speech.",
  "settings.speech.hint.system": "Free and offline; voice quality depends on the voices installed in your operating system, and spoken text never leaves your device.",
  "settings.autoHide.custom": "Custom ({{ms}}ms)",
  "settings.ai.secretConfigured": "API Key is securely configured; leave blank to keep the current value",
  "settings.ai.apiKeyConfigured": "API Key configured",
  "settings.ai.modelsEmpty": "No models yet — refresh or enter one manually",
  "settings.ai.modelsNoMatch": "No matching model — you can type one manually",
  "settings.ai.modelsLoaded": "Loaded {{count}} models",
  "settings.ai.modelsUnsupported": "The current protocol does not support model listing",
  "settings.ai.modelsLoadFailed": "Failed to load the model list",
  "settings.ai.modelsLoading": "Loading model list…",
  "settings.ai.modelsLoadFailedManual": "Failed to load the model list; you can enter one manually",
  "settings.ai.checking": "Checking…",
  "settings.ai.checkFailed": "Check failed, please try again later",
  "settings.ai.saved": "AI configuration saved and applied",
  "settings.ai.saveFailed": "Failed to save AI configuration: {{message}}",
  "settings.ai.clearConfirm": "Clear the saved AI API Key? Protocols that require authentication will stop working until you configure it again.",
  "settings.ai.clearedHint": "API Key cleared; configure it again before checking",
  "settings.ai.clearedFlash": "AI API Key cleared",
  "settings.ai.clearFailed": "Clear failed: {{message}}",
  "settings.dingTalk.secretConfigured": "Secret is securely configured; leave blank to keep the current value",
  "settings.dingTalk.saved": "DingTalk configuration saved and applied",
  "settings.dingTalk.saveFailed": "Failed to save DingTalk configuration: {{message}}",
  "settings.dingTalk.clearConfirm": "Clear the saved DingTalk ClientSecret? DingTalk translation will be paused until you configure it again.",
  "settings.dingTalk.secretCleared": "Secret cleared; configure it again before checking",
  "settings.dingTalk.clearedFlash": "DingTalk ClientSecret cleared",
  "settings.dingTalk.clearFailed": "Clear failed: {{message}}",
  "settings.dingTalk.checking": "Checking…",
  "settings.dingTalk.checkFailed": "Check failed, please try again later",
  "settings.microsoft.enabledHint": "Enabled — checking current availability is recommended",
  "settings.microsoft.disabled": "Channel disabled",
  "settings.microsoft.saved": "Microsoft Translator enabled state saved and applied",
  "settings.microsoft.saveFailed": "Failed to save Microsoft Translator enabled state: {{message}}",
  "settings.microsoft.checking": "Checking…",
  "settings.microsoft.checkFailed": "Check failed, please try again later",
  "settings.deepLx.saved": "DeepLX configuration saved and applied",
  "settings.deepLx.saveFailed": "Failed to save DeepLX configuration: {{message}}",
  "settings.deepLx.statusSaveFailed": "✗ Failed to save configuration: {{message}}",
  "settings.deepLx.checking": "Checking…",
  "settings.deepLx.online": "Service online",
  "settings.deepLx.offline": "Unable to connect",
  "settings.deepLx.checkFailed": "✗ Check failed: {{message}}",
  "settings.deepLx.copied": "Command copied",
  "settings.service.stopConfirm": "Stopping the service quits the tray icon and selection translation. Start the app again when you need it. Stop now?",
  "settings.logs.resume": "Resume",
  "settings.logs.exportedTo": "Logs exported to {{path}}",
  "settings.diagnostics.expand": "Expand",
  "settings.diagnostics.dayTitle": "{{date}} ({{count}} total)",
  "settings.diagnostics.failureReasons": "Failure reasons",
  "settings.diagnostics.topApps": "Top 5 failing apps",
  "settings.diagnostics.empty": "No selection diagnostics for the last two days",
  "settings.diagnostics.exportedTo": "Diagnostics exported to {{path}}",
  "settings.diagnostics.entry.button": "Button",
  "settings.diagnostics.entry.hotkey": "Hotkey",
  "settings.diagnostics.entry.auto": "Auto",
  "settings.diagnostics.level.nativeRead": "Native read",
  "settings.diagnostics.level.copyPolled": "Copy polling",
  "settings.diagnostics.level.copyLate": "Stable hit",
  "settings.diagnostics.level.failed": "Failed",
  "settings.diagnostics.reason.empty": "Empty selection",
  "settings.diagnostics.reason.timeout": "Timeout",
  "settings.diagnostics.reason.unsupported": "Unsupported",
  "settings.diagnostics.reason.permission": "Permission",
  "settings.diagnostics.reason.unknown": "Unknown",
  "settings.ocr.engineSystemShort": "System OCR",
  "settings.ocr.availableEngines": "{{message}}; available engines: {{engines}}",
  "settings.ocr.noEngines": "None",
  "settings.update.restartToInstall": "Restart and upgrade now",
  "settings.update.openReleaseManual": "Open GitHub Release to update manually",
  "settings.update.redownloadDmg": "Download DMG again",
  "settings.update.downloadAndOpenDmg": "Download and open DMG",
  "settings.update.downloadAndInstall": "Download and install",
  "settings.update.hint.dev": "The development build never contacts the update service; verify auto-update with an official installer.",
  "settings.update.hint.sameVersionOpenRelease": "A new build of the same version is available; this platform cannot install it in-app, so open the GitHub Release and download it manually.",
  "settings.update.hint.sameVersionManualDmg": "A new build of the same version is available; clicking downloads and verifies the matching-architecture DMG, and you still confirm dragging it into Applications.",
  "settings.update.hint.openReleaseOnly": "This update must be downloaded manually from the GitHub Release and installed over the current version.",
  "settings.update.hint.manualDownloaded": "The update was downloaded to your Downloads folder and the DMG was opened; drag the app into Applications to replace the old version, then click “Remove macOS quarantine”.",
  "settings.update.hint.manualDownload": "Clicking upgrade downloads the update to your Downloads folder and opens the DMG automatically.",
  "settings.update.hint.automatic": "You confirm the download after a new version is detected; once downloaded you can restart and finish the upgrade.",
  "settings.update.checkFailed": "Update check failed: {{message}}",
  "settings.update.actionFailed": "Update action failed: {{message}}",
  "settings.update.cancelFailed": "Failed to cancel download: {{message}}",
  "settings.update.quarantineFailed": "Failed to remove quarantine: {{message}}",
  "settings.update.openReleaseFailed": "Unable to open the release page: {{message}}",
  "dialog.hiServices.title": "macOS selection service error",
  "dialog.hiServices.message": "The selection button did not appear or selection failed repeatedly",
  "dialog.hiServices.detail": "The macOS key-injection service (hiservices) may have failed, so simulated copy events cannot reach the foreground app. Click the button below to restart it; macOS will start it again automatically, which usually restores selection translation.",
  "dialog.hiServices.repair": "Repair Now",
  "dialog.hiServices.later": "Later",
  "dialog.hiServices.repaired": "The macOS key-injection service was restarted and the selection listener was refreshed. Please try selecting text again.",
  "dialog.hiServices.failed": "Automatic repair failed. Run sudo pkill -9 -f hiservices in Terminal, then try again.",
  "error.accessibilityPermission": "Accessibility permission is required. Enable this app in the system settings that opened, then try again.",
  "error.accessibilityPermissionAuto": "Accessibility permission is required for selection translation and automatic translation. Enable this app in System Settings (the development build appears as Electron), then restart.",
  "error.translationFailed": "Translation failed",
  "error.screenCaptureFailed": "Unable to capture the screen",
  "error.screenCaptureFailedDetail": "Unable to capture the screen: {{message}}",
  "error.screenCaptureTimeout": "Screen capture timed out. Please try again.",
  "error.screenRecordingPermission": "Screen Recording permission is required",
  "error.imageRequestTimeout": "Image request timed out",
  "error.imageRequestCancelled": "Image request cancelled",
  "error.imageCaptureCancelled": "Image capture cancelled",
  "error.noTranslatableText": "No translatable text was recognized",
  "error.noRecognizedText": "No text was recognized",
  "error.ocrFailed": "OCR recognition failed",
  "error.screenshotExpired": "The screenshot is no longer valid. Take a new screenshot.",
  "error.invalidSelection": "The selected area is invalid. Select an area again.",
  "error.copyImageFailed": "Failed to copy image",
  "error.saveImageFailed": "Failed to save image",
  "error.noClipboardImage": "There is no image on the clipboard",
  "error.invalidWebUrl": "Enter a valid web address",
  "error.invalidWebMode": "Invalid web translation display mode",
  "error.trayIconLoadFailed": "Unable to load the tray icon: {{message}}",
  "error.dockIconLoadFailed": "Unable to load the macOS Dock icon: {{message}}",
  "ocr.assetsReady": "{{name}} compatible model assets are ready; the PaddleOCR pipeline is available",
  "ocr.assetsRuntimeUnavailable": "{{name}} compatible model assets are ready, but the PaddleOCR runtime is currently unavailable",
  "ocr.assetsFallback": "{{message}}; system OCR or Tesseract will be preferred as a fallback",
  "selection.loadingReading": "Reading selected text…",
  "selection.loadingRecognizing": "Recognizing the screen area…",
  "selection.loadingTranslating": "Translating the recognized text…",
  "selection.loadingClipboardImage": "Recognizing the clipboard image…",
  "selection.captureFailure.imageOnly": "An image selection was detected; image translation is not supported yet",
  "selection.captureFailure.timeout": "Selection timed out. Try again, or make sure the selected content can be copied.",
  "selection.captureFailure.unsupported": "The current app does not support selection capture. Make sure the selected content can be copied.",
  "selection.captureFailure.permission": "Accessibility permission is required to read the selected text. Grant it and try again.",
  "selection.captureFailure.clipboardLocked": "The clipboard is busy. Close other clipboard tools and try again.",
  "selection.captureFailure.empty": "No selected text was detected. Select the text again and click “Translate”.",
  "screenshot.defaultFileNamePrefix": "screenshot",
  "screenshot.pngFilter": "PNG Image",
  "deepLx.dockerPlaceholder": "your-dl-session-value",
  "macQuarantine.unknownError": "Unknown error",
  "macQuarantine.unsupportedPlatform": "Removing the quarantine attribute is only supported on macOS",
  "macQuarantine.pathNotAllowed": "To avoid mistakes, only {{path}} can be processed",
  "macQuarantine.success": "Removed the macOS quarantine attribute from {{path}}",
  "macQuarantine.noAttribute": "The app does not have a quarantine attribute (com.apple.quarantine)",
  "macQuarantine.failed": "Failed to remove the quarantine attribute: {{message}}. You can run it manually: {{command}}"
});
const appEnUS = defineCatalog({
  "app.serviceNotInitialized.dingtalk": "The DingTalk configuration service is not initialized yet",
  "app.serviceNotInitialized.aiConfig": "The AI configuration service is not initialized yet",
  "app.serviceNotInitialized.deepLx": "The DeepLX configuration service is not initialized yet",
  "app.serviceNotInitialized.update": "The update service is not initialized yet",
  "app.serviceNotInitialized.webReader": "The web reader is not initialized yet",
  "app.serviceNotInitialized.deepLxCheck": "The DeepLX check service is not initialized yet",
  "app.serviceNotInitialized.aiModelDiscovery": "The AI model discovery service is not initialized yet",
  "app.serviceNotInitialized.aiCheck": "The AI check service is not initialized yet",
  "app.selectionListenerUnavailable": "The selection listener could not start; selection and double-click translation are unavailable, but hotkeys still work"
});
const aiEnUS = defineCatalog({
  "ai.check.incomplete": "AI configuration is incomplete. Enter a Base URL and model.",
  "ai.check.available": "AI translation configuration is available.",
  "ai.check.permission": "The AI application does not have sufficient permissions.",
  "ai.check.rateLimit": "AI requests are too frequent. Try again later.",
  "ai.check.serviceUnavailable": "The AI service is temporarily unavailable. Try again later.",
  "ai.credentials.secureStorageReadUnavailable": "The current system cannot use secure storage, so the AI credential cannot be read.",
  "ai.credentials.readFailed": "The saved AI credential could not be read. Configure it again.",
  "ai.credentials.secureStorageWriteUnavailable": "Secure storage is unavailable on this system. The AI credential cannot be saved.",
  "ai.error.authentication": "AI authentication failed. Check your API key.",
  "ai.error.rateLimit": "AI requests are rate limited. Try again later.",
  "ai.error.notFound": "The AI model does not exist or the path is incorrect.",
  "ai.error.serviceUnavailable": "The AI service is temporarily unavailable.",
  "ai.error.httpStatus": "The AI service returned an error (HTTP {{status}}).",
  "ai.error.timeout": "AI request timed out.",
  "ai.error.network": "AI network connection failed.",
  "ai.error.requestBuild": "Failed to build the AI request.",
  "ai.error.nonJsonResponse": "The AI service returned a non-JSON response.",
  "ai.error.responseParse": "Failed to parse the AI service response.",
  "ai.error.emptyTranslation": "AI returned an empty translation.",
  "ai.modelDiscovery.unsupported": "This service does not support model discovery. Enter a model name manually.",
  "ai.modelDiscovery.unsupportedResponse": "The model list response format is not supported.",
  "ai.modelDiscovery.parseFailed": "Failed to parse the model list.",
  "ai.modelDiscovery.authentication": "Model list authentication failed. Check your API key.",
  "ai.modelDiscovery.rateLimit": "Model list requests are too frequent. Try again later.",
  "ai.modelDiscovery.loadFailed": "Failed to load the model list."
});
const captureEnUS = defineCatalog({
  "capture.error.selectionOutOfBounds": "The selection is outside the current display",
  "capture.error.screenCaptureFailed": "Unable to capture the screen",
  "capture.error.screenRecordingPermissionRequired": "Screen Recording permission is required",
  "capture.error.unsupportedPlatform": "The current platform is not supported: {{platform}}",
  "capture.error.accessibilityPermissionRequired": "Accessibility permission is required to simulate copy",
  "capture.error.copySimulationFailed": "Failed to simulate copy: {{message}}",
  "capture.error.windowsOnlyGdi": "Native GDI screen capture is only available on Windows",
  "capture.error.gdiGetDcFailed": "GetDC failed: unable to obtain the screen device context",
  "capture.error.gdiCreateCompatibleDcFailed": "CreateCompatibleDC failed",
  "capture.error.gdiCreateCompatibleBitmapFailed": "CreateCompatibleBitmap failed",
  "capture.error.gdiBitBltFailed": "BitBlt failed",
  "capture.error.gdiGetDIBitsFailed": "GetDIBits failed: unable to retrieve pixel data",
  "capture.error.gdiBindingLoadFailed": "Failed to load the koffi binding (will retry automatically in {{interval}} ms): {{detail}}",
  "capture.error.gdiCaptureFailed": "GDI screen capture failed: {{message}}",
  "capture.error.gdiAndFallbackFailed": "Unable to capture the screen: GDI failed ({{gdiMessage}}); fallback failed ({{fallbackMessage}})",
  "capture.error.windowsCaptureFailed": "Unable to capture the screen: {{message}}",
  "capture.error.windowsHelperExit": "The helper executable exited with code {{exitCode}}: {{stderr}}",
  "capture.error.nativeReaderHelperMissing": "The windows-uia-reader helper executable is missing",
  "capture.error.exportRequestInvalid": "The image export request is invalid",
  "capture.error.exportActionInvalid": "The export action is invalid",
  "capture.error.exportRequestIdInvalid": "The export request ID is invalid",
  "capture.error.exportSessionInvalid": "The screenshot session is invalid",
  "capture.error.exportBoundsInvalid": "The export selection is invalid",
  "capture.error.exportDimensionsInvalid": "The export image dimensions are invalid",
  "capture.error.exportDataInvalid": "The export image data is invalid",
  "capture.error.exportPngRequired": "The export image must be in PNG format"
});
const deepLxEnUS = defineCatalog({
  "deepLx.check.notConfigured": "No address configured",
  "deepLx.check.summary": "{{online}}/{{total}} services online",
  "deepLx.check.timeout": "Connection timed out",
  "deepLx.check.network": "Network connection failed",
  "translate.error.tooLong": "A single translation supports up to {{max}} characters; please split the text first",
  "translate.error.allChannelsFailed": "All translation channels failed",
  "translate.error.unknown": "Unknown error",
  "translate.channel.cached": "Cache",
  "translate.channel.ai": "AI Translation",
  "translate.channel.dingtalk": "DingTalk Translation",
  "translate.channel.microsoft": "Microsoft Translator",
  "translate.channel.selfHostedDeepLx": "Self-hosted DeepLX",
  "translate.channel.selfHostedDeepLxIndexed": "Self-hosted DeepLX {{index}}",
  "translate.channel.publicDeepLx": "Public DeepLX",
  "translate.check.dingtalkIncomplete": "DingTalk configuration is incomplete",
  "translate.check.dingtalkAvailable": "DingTalk translation is online and available",
  "translate.check.microsoftAvailable": "Microsoft Translator is online and available",
  "translate.check.sampleText": "Hello",
  "translate.deepLx.rateLimited": "Rate limited (429)",
  "translate.google.blocked": "Blocked (non-JSON response)",
  "translate.google.empty": "Empty response",
  "translate.myMemory.quotaExceeded": "Free quota exhausted",
  "translate.myMemory.noResult": "No result"
});
const dingtalkEnUS = defineCatalog({
  "dingtalk.error.authentication": "DingTalk authentication failed",
  "dingtalk.error.permission": "The DingTalk app does not have permission to use text translation",
  "dingtalk.error.rateLimit": "Too many DingTalk API requests",
  "dingtalk.error.parameter": "Invalid DingTalk request parameters",
  "dingtalk.error.serviceUnavailable": "The DingTalk service is temporarily unavailable",
  "dingtalk.error.timeout": "DingTalk request timed out",
  "dingtalk.error.network": "Unable to connect to DingTalk",
  "dingtalk.error.configurationIncomplete": "DingTalk configuration is incomplete. Enter CorpId, ClientId, and ClientSecret.",
  "dingtalk.error.authenticationStatus": "DingTalk authentication failed. Check CorpId, ClientId, and ClientSecret.",
  "dingtalk.error.permissionStatus": "The DingTalk app does not have text translation permission",
  "dingtalk.error.rateLimitStatus": "Too many DingTalk API requests. Try again later.",
  "dingtalk.error.parameterStatus": "The DingTalk translation request parameters are not supported",
  "dingtalk.error.serviceStatus": "The DingTalk service is temporarily unavailable. Try again later.",
  "dingtalk.error.tokenResponseInvalid": "The DingTalk token response is invalid",
  "dingtalk.error.tokenResponseParse": "Unable to parse the DingTalk token response",
  "dingtalk.error.translationResponseEmpty": "The DingTalk translation response was empty",
  "dingtalk.error.translationResponseParse": "Unable to parse the DingTalk translation response",
  "dingtalk.credential.secureStorageUnavailableRead": "Secure storage is unavailable on this system, so the DingTalk credential cannot be read.",
  "dingtalk.credential.readFailed": "Unable to read the saved DingTalk credential. Configure it again.",
  "dingtalk.credential.secureStorageUnavailableSave": "Secure storage is unavailable on this system, so the DingTalk credential cannot be saved."
});
const microsoftEnUS = defineCatalog({
  "microsoft.error.authentication": "The Microsoft translation web session has expired",
  "microsoft.error.rateLimit": "Too many Microsoft translation API requests",
  "microsoft.error.parameter": "Invalid Microsoft translation request parameters",
  "microsoft.error.serviceUnavailable": "The Microsoft translation service is temporarily unavailable",
  "microsoft.error.timeout": "Microsoft translation request timed out",
  "microsoft.error.network": "Unable to connect to Microsoft translation",
  "microsoft.error.authenticationStatus": "Unable to obtain the Microsoft translation web session. Try again later.",
  "microsoft.error.rateLimitStatus": "Too many Microsoft translation API requests. Try again later.",
  "microsoft.error.parameterStatus": "The Microsoft translation request parameters are not supported",
  "microsoft.error.serviceStatus": "The Microsoft translation service is temporarily unavailable. Try again later.",
  "microsoft.error.textEmpty": "Microsoft translation text cannot be empty",
  "microsoft.error.responseEmpty": "The Microsoft translation response was empty",
  "microsoft.error.pageReadFailed": "Unable to read the Microsoft translation web page response",
  "microsoft.error.redirectInvalid": "The Microsoft translation web page redirect address is invalid",
  "microsoft.error.authParametersParse": "Unable to parse the Microsoft translation web page authentication parameters",
  "microsoft.error.authExpiryInvalid": "The Microsoft translation web page authentication expiry is invalid",
  "microsoft.error.responseParse": "Unable to parse the Microsoft translation response"
});
const ocrEnUS = defineCatalog({
  "ocr.model.gutenReady": "PP-OCRv4 compatible model assets are ready",
  "ocr.model.gutenIncomplete": "PP-OCRv4 compatible model assets are incomplete: {{files}}",
  "ocr.model.ppOcrV6Ready": "PP-OCRv6_tiny archived model assets are ready (disabled by default)",
  "ocr.model.ppOcrV6Incomplete": "PP-OCRv6_tiny archived model assets are incomplete: {{files}}",
  "ocr.dispatcher.availabilityCheckFailed": "{{engine}}: availability check failed",
  "ocr.dispatcher.engineUnavailable": "Unavailable (platform or model is not ready)",
  "ocr.dispatcher.invalidResult": "{{engine}}: recognition result is empty or appears garbled",
  "ocr.dispatcher.allEnginesUnavailable": "All OCR engines are unavailable: {{errors}}",
  "ocr.dispatcher.noTextRecognized": "No text was recognized by any OCR engine: {{errors}}",
  "ocr.error.requestMissingInput": "The OCR request is missing image bytes or a path",
  "ocr.error.requestCancelled": "The OCR request was cancelled",
  "ocr.error.invalidTimeout": "The OCR timeout must be a positive number",
  "ocr.error.recognizeTimeout": "OCR recognition timed out ({{timeout}}ms)",
  "ocr.error.paddleMissingInput": "PaddleOCR requires image input",
  "ocr.error.paddleTimeout": "PaddleOCR timed out",
  "ocr.error.paddleFailed": "PaddleOCR failed: {{message}}",
  "ocr.error.paddleRuntimeInitFailed": "PaddleOCR runtime initialization failed: {{message}}",
  "ocr.error.paddleFallbackMissingExecutable": "PaddleOCR-json executable was not found. Install it and make sure it is available in PATH.",
  "ocr.error.paddleFallbackMissingInput": "PaddleOCR-json requires image input",
  "ocr.error.paddleFallbackUnavailable": "PaddleOCR-json is unavailable",
  "ocr.error.paddleFallbackTimeout": "PaddleOCR-json timed out",
  "ocr.error.paddleFallbackFailed": "PaddleOCR-json failed: {{message}}",
  "ocr.error.visionMissingInput": "Vision OCR requires image input",
  "ocr.error.visionUnsupportedPlatform": "macOS Vision OCR is only available on macOS",
  "ocr.error.visionHelperMissing": "macOS Vision OCR helper is not installed",
  "ocr.error.visionHelperUnavailable": "macOS Vision OCR helper is unavailable: {{message}}",
  "ocr.error.visionPermissionRequired": "Screen Recording permission is required. Grant it in System Settings.",
  "ocr.error.visionPermissionMissing": "Screen Recording permission is missing",
  "ocr.error.visionTimeout": "Vision OCR timed out",
  "ocr.error.visionFailed": "macOS Vision OCR failed: {{message}}",
  "ocr.error.windowsUnsupportedPlatform": "Windows system OCR is only available on Windows",
  "ocr.error.windowsMissingInput": "Windows OCR requires image input",
  "ocr.error.windowsLanguagePackMissing": "The Windows OCR language pack is not installed",
  "ocr.error.windowsTimeout": "Windows OCR timed out",
  "ocr.error.windowsFailed": "Windows OCR failed: {{message}}",
  "ocr.error.tesseractMissingInput": "Tesseract OCR requires image input",
  "ocr.error.tesseractTimeout": "Tesseract OCR timed out",
  "ocr.error.tesseractModelDownloadFailed": "Failed to download the Tesseract language model. Check your network and try again.",
  "ocr.error.tesseractInterrupted": "Tesseract OCR was interrupted. Take a new screenshot and try again.",
  "ocr.error.tesseractFailed": "Tesseract OCR failed: {{message}}",
  "ocr.error.pngUnsupportedFilter": "Unsupported PNG filter type: {{filter}}",
  "ocr.error.pngInvalidSignature": "Invalid PNG file signature",
  "ocr.error.pngChunkLengthIncomplete": "Incomplete PNG chunk length",
  "ocr.error.pngChunkOutOfBounds": "PNG data chunk is out of bounds",
  "ocr.error.pngInterlacedUnsupported": "Interlaced PNG files are not supported",
  "ocr.error.pngInvalidDimensions": "Invalid PNG dimensions",
  "ocr.error.pngUnsupportedBitDepth": "Unsupported bit depth: {{bitDepth}}",
  "ocr.error.pngUnsupportedColorType": "Unsupported color type: {{colorType}}",
  "ocr.error.pngScanlineIncomplete": "PNG scanline data is incomplete",
  "ocr.error.pngEncodeInvalidImage": "Cannot encode an empty image or an image with incomplete data"
});
const speechEnUS = defineCatalog({
  "speech.error.emptyText": "Speech text is empty",
  "speech.error.cancelled": "Edge speech request was cancelled",
  "speech.error.connectionFailed": "Unable to connect to the Edge speech service",
  "speech.error.timeout": "Edge speech request timed out",
  "speech.error.noAudio": "The Edge speech service returned no audio",
  "speech.error.connectionClosed": "The Edge speech service connection was closed",
  "speech.error.proxyUnsupported": "The current proxy type does not support Edge online speech"
});
const rendererSpeechEnUS = defineCatalog({
  "rendererSpeech.error.noText": "No translation to read aloud",
  "rendererSpeech.error.unsupported": "Speech playback is not supported in this environment",
  "rendererSpeech.error.voiceListFailed": "Failed to read system voices. Check your system speech settings.",
  "rendererSpeech.error.noVoice": "No voice is available for the target language. Check your system speech settings.",
  "rendererSpeech.error.playFailed": "Speech playback failed. Please try again.",
  "rendererSpeech.edge.cancelled": "Edge speech request was cancelled",
  "rendererSpeech.edge.unavailable": "Edge online speech is temporarily unavailable",
  "rendererSpeech.edge.decodeFailed": "Edge audio decoding failed",
  "rendererSpeech.edge.noAudio": "Edge speech service returned no audio",
  "rendererSpeech.edge.playFailed": "Edge audio playback failed",
  "rendererSpeech.audio.playFailed": "Audio playback failed",
  "rendererSpeech.audio.playCancelled": "Audio playback was cancelled"
});
const webReaderEnUS = defineCatalog({
  "webReader.error.disabled": "Web page translation is disabled in settings",
  "webReader.error.pageChanged": "The web page changed. Extract it again.",
  "webReader.error.extractFirst": "Extract the current web page text first",
  "webReader.error.loadFailed": "Failed to load the web page: {{description}}",
  "webReader.error.notOpen": "The web reader is not open",
  "webReader.error.urlRequired": "Open an HTTP or HTTPS web page first",
  "webReader.error.onlyHttp": "The web reader supports only HTTP or HTTPS addresses",
  "webReader.error.invalidUrl": "Enter a valid web address",
  "webReader.error.extractionTimeout": "Web page text extraction timed out",
  "webReader.error.extractionFailed": "Failed to extract web page text. Check that the page has finished loading.",
  "webReader.error.documentNotReady": "The web page document is not ready yet. Try again shortly.",
  "webReader.error.rootNotReady": "The web page root element has not been created yet. Try again shortly.",
  "webReader.error.translationFailed": "Translation failed",
  "webReader.mainWindowTitle": "Selection Translator · Web Translation"
});
const enUSCatalog = defineCatalog({
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
});
const zhCNBase = defineCatalog({
  "app.name": "划词翻译",
  "app.startupFailed.message": "应用无法完成启动：{{message}}",
  "app.startupFailed.title": "划词翻译启动失败",
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.maximize": "最大化",
  "common.minimize": "最小化",
  "common.ok": "确定",
  "common.retry": "重试",
  "common.save": "保存",
  "common.unknownError": "未知错误",
  "common.windowControls": "窗口控制按钮",
  "dialog.exportDiagnostics.title": "导出取词诊断",
  "dialog.exportLogs.title": "导出日志",
  "dialog.installFromDiskImage.continue": "仍然运行",
  "dialog.installFromDiskImage.detail": "请先将“划词翻译”复制到“应用程序”文件夹，再从“应用程序”启动，避免重装后旧实例持续运行。",
  "dialog.installFromDiskImage.exit": "退出应用",
  "dialog.installFromDiskImage.message": "当前应用正在从磁盘镜像运行",
  "dialog.installFromDiskImage.title": "请先安装划词翻译",
  "dialog.quarantine.cancelled": "已取消解除 macOS 隔离属性",
  "dialog.quarantine.confirm": "已完成安装，继续",
  "dialog.quarantine.detail": "确认已完成覆盖安装后继续。此操作只处理 /Applications/划词翻译.app，不会调用 sudo，也不能修复代码签名不匹配。",
  "dialog.quarantine.message": "请先下载 DMG 并将“划词翻译”拖入“应用程序”覆盖旧版本",
  "dialog.quarantine.title": "确认解除 macOS 隔离属性",
  "dialog.selectionService.message": "划词按钮未出现或取词连续失败",
  "dialog.selectionService.title": "划词取词服务异常",
  "error.copyShortcutAsOcrHotkey": "Ctrl+C / Command+C 是系统复制快捷键，不能设为 OCR 快捷键",
  "error.copyShortcutAsTranslationHotkey": "Ctrl+C / Command+C 是系统复制快捷键，不能设为翻译快捷键",
  "error.shortcutConflictCopy": "Ctrl+C / Command+C 是系统复制快捷键，不能设为功能快捷键",
  "error.shortcutConflictDuplicate": "该快捷键已被其它功能使用",
  "error.shortcutOccupied": "快捷键被系统或其它应用占用，请更换",
  "error.shortcutInvalid": "快捷键格式无效，请重新录入",
  "error.dingTalkCredentialsUnavailable": "钉钉凭证无法安全读取，请重新配置",
  "error.edgeSpeechEmptyText": "朗读文本为空",
  "error.edgeSpeechUnavailable": "Edge 语音服务暂不可用",
  "error.openWebReader": "无法打开网页阅读器",
  "error.webTranslation": "网页翻译",
  "menu.autoBilingual": "自动中英互译",
  "menu.clipboardImageOcr": "剪贴板图片 OCR 翻译…",
  "menu.manualTranslation": "手动翻译…",
  "menu.openWebTranslation": "打开网页翻译…",
  "menu.quit": "退出",
  "menu.repairMacSelectionService": "修复 macOS 划词服务…",
  "menu.screenshotOcr": "截图 OCR 翻译…",
  "menu.settings": "设置",
  "menu.showSelectionButton": "划词后自动显示“译”按钮",
  "menu.sourceLanguage": "源语言",
  "menu.targetLanguage": "目标语言",
  "popup.chooseProvider": "选择首选翻译 API",
  "popup.clear": "清空",
  "popup.clearManualSource": "清空手动输入内容",
  "popup.copy": "复制",
  "popup.copyOcrContent": "复制 OCR 内容",
  "popup.copyTranslation": "复制译文",
  "popup.dragHandle.ariaLabel": "拖动翻译窗口",
  "popup.dragHandle.title": "拖动窗口",
  "popup.languageToolbar": "翻译语言工具栏",
  "popup.manualHint": "Enter / ⌘+Ctrl + Enter 翻译",
  "popup.manualMode": "切换手动翻译",
  "popup.manualPlaceholder": "输入或粘贴要翻译的文字",
  "popup.manualStale": "原文或设置已变化，请重新翻译。",
  "popup.manualTranslation": "手动翻译",
  "popup.ocrContent": "OCR 内容",
  "popup.ocrEngine": "OCR 引擎",
  "popup.openSettings": "打开设置",
  "popup.openWebReader": "打开网页翻译",
  "popup.pin": "固定窗口",
  "popup.selectionResult": "划词翻译结果",
  "popup.speakUnavailable": "没有可朗读的译文",
  "popup.statusActions": "翻译状态与操作",
  "popup.translate": "翻译",
  "popup.translateOriginal": "原文",
  "popup.translationApi": "翻译 API",
  "popup.translationResult": "译文",
  "selection.annotationColor": "标注颜色",
  "selection.annotationStyle": "标注样式",
  "selection.annotationText": "标注文字",
  "selection.annotationTools": "标注工具",
  "selection.boldText": "粗体文字",
  "selection.chooseAnnotationColor": "选择标注颜色",
  "selection.clearAnnotations": "清除标注",
  "selection.color.blue": "蓝色",
  "selection.color.green": "绿色",
  "selection.color.orange": "橙色",
  "selection.color.purple": "紫色",
  "selection.color.red": "红色",
  "selection.color.yellow": "黄色",
  "selection.copyImage": "复制图片",
  "selection.customColor": "自定义标注颜色",
  "selection.fontSize": "字号",
  "selection.mosaicBrushSize": "马赛克画笔大小",
  "selection.mosaicIntensity": "马赛克强度",
  "selection.mosaicLevel.high": "高",
  "selection.mosaicLevel.low": "低",
  "selection.mosaicLevel.medium": "中",
  "selection.ocrCapture": "OCR 截图选区",
  "selection.ocrResult": "OCR 结果",
  "selection.ocrSource": "OCR 原文",
  "selection.recognize": "识别文字",
  "selection.redo": "重做",
  "selection.redoAnnotation": "重做标注",
  "selection.resizeResult": "调整 OCR 结果区域大小",
  "selection.saveImage": "保存到磁盘",
  "selection.screenshotActions": "截图操作",
  "selection.strokeWidth": "线条粗细",
  "selection.tip": "拖动选择区域，可移动或调整大小，然后点击“识别文字”开始 OCR。按 Esc 取消。",
  "selection.tool.arrow": "箭头",
  "selection.tool.brush": "画笔",
  "selection.tool.ellipse": "椭圆",
  "selection.tool.mosaic": "马赛克",
  "selection.tool.rect": "矩形",
  "selection.tool.text": "文字",
  "selection.translate": "翻译",
  "selection.translateSelected": "翻译选中文字",
  "selection.undo": "撤销",
  "selection.undoAnnotation": "撤销标注",
  "selection.windowTitle": "翻译选中文字 / OCR 框选",
  "selection.recognizing": "正在识别选区文字…",
  "selection.recognizeComplete": "识别完成",
  "selection.recognizeCompleteWithEngine": "识别完成（{{engine}}）",
  "selection.noTextRecognized": "未识别到文字",
  "selection.recognizeFailed": "识别失败，请重试",
  "selection.copyingImage": "正在复制图片…",
  "selection.preparingSave": "正在准备保存…",
  "selection.screenshotNotReady": "截图尚未准备完成，请稍后重试",
  "selection.copyImageFailed": "复制图片失败",
  "selection.saveImageFailed": "保存图片失败",
  "selection.screenshotLoadFailed": "截图资源加载失败，请重新截图",
  "selection.tipLoading": "正在获取屏幕画面，可先拖拽选择区域，按 Esc 取消",
  "settings.about.author": "作者",
  "settings.about.email": "邮箱",
  "settings.about.project": "项目",
  "settings.about.projectHint": "划词翻译是一个支持 macOS、Windows 与 Linux 的桌面翻译工具。更新包来自项目公开的 GitHub Release。",
  "settings.ai.apiKey": "API Key",
  "settings.ai.apiKeyMissing": "API Key 未配置",
  "settings.ai.apiKeyPlaceholder": "留空可保留已配置的 Key",
  "settings.ai.availableModels": "可用模型",
  "settings.ai.baseUrl": "Base URL",
  "settings.ai.baseUrlPlaceholder": "例如 http://127.0.0.1:11434",
  "settings.ai.check": "检测配置",
  "settings.ai.clearKey": "清除 API Key",
  "settings.ai.enabled": "启用通道",
  "settings.ai.enabledLabel": "优先使用 AI 翻译",
  "settings.ai.expandModels": "展开模型列表",
  "settings.ai.hint": "使用本地或云端大语言模型进行划词翻译，支持 Ollama、OpenAI 兼容和 Claude Code（Anthropic）兼容 HTTP 协议。API Key 仅在本机安全保存，页面不会回显。",
  "settings.ai.model": "模型",
  "settings.ai.modelPlaceholder": "选择或手动输入模型名称",
  "settings.ai.modelsNotLoaded": "未加载模型列表",
  "settings.ai.notChecked": "未检测",
  "settings.ai.protocol": "协议",
  "settings.ai.protocolAria": "AI 协议",
  "settings.ai.protocolClaude": "Claude Code 兼容",
  "settings.ai.protocolOpenai": "OpenAI 兼容",
  "settings.ai.refreshModels": "刷新模型列表",
  "settings.ai.save": "保存 AI 配置",
  "settings.ai.title": "AI 翻译",
  "settings.appearance.title": "外观",
  "settings.autoSaveHint": "所有修改都会自动保存并立即生效",
  "settings.brand": "划词翻译设置",
  "settings.categories": "设置分类",
  "settings.channels.dingTalkDesc": "启用且配置完整时优先使用",
  "settings.channels.dingTalkName": "钉钉翻译",
  "settings.channels.googleDesc": "免费，部分网络需配置代理",
  "settings.channels.googleName": "Google",
  "settings.channels.hint": "默认按以下顺序依次尝试；也可在悬浮窗底部选择首选 API。首选 API 失败或熔断后会自动切换下一个，并保留首选设置供后续翻译继续优先使用。",
  "settings.channels.microsoftDesc": "免订阅配置，启用后在 DeepLX 等免费通道前使用",
  "settings.channels.microsoftName": "微软翻译",
  "settings.channels.myMemoryDesc": "免注册兜底，有免费额度限制",
  "settings.channels.myMemoryName": "MyMemory",
  "settings.channels.publicDesc": "免费，可能限流",
  "settings.channels.publicName": "公共 DeepLX",
  "settings.channels.selfHostedDesc": "可配置，最稳定（推荐）",
  "settings.channels.selfHostedName": "自建 DeepLX",
  "settings.channels.title": "翻译通道",
  "settings.deepLx.check": "检测是否在线",
  "settings.deepLx.copyCommand": "复制命令",
  "settings.deepLx.deployHint": "用 Docker 一键部署：把命令里的 dl_session 占位符替换为 DeepL 登录后的 dl_session Cookie，然后在终端执行。",
  "settings.deepLx.notChecked": "未检测",
  "settings.deepLx.openDoc": "打开部署文档",
  "settings.deepLx.save": "保存配置",
  "settings.deepLx.title": "自建 DeepLX",
  "settings.deepLx.url": "服务地址",
  "settings.deepLx.urlHint": "支持配置多个服务地址，请使用英文或中文逗号分隔；翻译时会轮询地址并在失败后自动切换。",
  "settings.deepLx.urlPlaceholder": "http://127.0.0.1:1189/translate, https://example.com/translate",
  "settings.diagnostics.collapse": "收起",
  "settings.diagnostics.export": "导出诊断",
  "settings.diagnostics.hint": "记录每次取词的命中级别、耗时与失败原因，仅保留近两天数据，不包含任何选中文字。",
  "settings.diagnostics.title": "取词诊断",
  "settings.dingTalk.check": "检测配置",
  "settings.dingTalk.clearSecret": "清除 Secret",
  "settings.dingTalk.clientId": "应用 ClientId",
  "settings.dingTalk.clientIdPlaceholder": "请输入应用 ClientId",
  "settings.dingTalk.clientSecret": "应用 ClientSecret",
  "settings.dingTalk.corpId": "企业 CorpId",
  "settings.dingTalk.corpIdPlaceholder": "请输入企业 CorpId",
  "settings.dingTalk.enabled": "启用通道",
  "settings.dingTalk.enabledLabel": "优先使用钉钉翻译",
  "settings.dingTalk.hint": "适用于已创建企业内部应用并开通 AI 文本翻译权限的账号。ClientSecret 仅在本机安全保存，页面不会回显。",
  "settings.dingTalk.notChecked": "未检测",
  "settings.dingTalk.save": "保存钉钉配置",
  "settings.dingTalk.secretMissing": "Secret 未配置",
  "settings.dingTalk.secretPlaceholder": "留空可保留已配置的 Secret",
  "settings.dingTalk.title": "钉钉翻译",
  "settings.language.title": "翻译语言",
  "settings.launch.autoLaunch": "开机自启动",
  "settings.launch.autoLaunchHint": "开启后应用会在登录系统时自动启动并常驻托盘；开发调试模式下不会写入系统登录项。",
  "settings.launch.autoLaunchLabel": "随系统启动时自动运行划词翻译",
  "settings.launch.dock": "Dock 栏",
  "settings.launch.dockHint": "仅 macOS 生效；点击 Dock 栏图标会直接进入设置页面。",
  "settings.launch.showDock": "显示 Dock 栏图标",
  "settings.launch.title": "应用外观与启动",
  "settings.logs.clear": "清空",
  "settings.logs.export": "导出",
  "settings.logs.filterAria": "日志级别过滤",
  "settings.logs.levelError": "错误",
  "settings.logs.levelInfo": "信息",
  "settings.logs.levelWarn": "警告",
  "settings.logs.pause": "暂停",
  "settings.logs.search": "搜索日志内容",
  "settings.microsoft.check": "检测可用性",
  "settings.microsoft.enabled": "启用通道",
  "settings.microsoft.enabledLabel": "在 DeepLX 等免费通道前使用微软翻译",
  "settings.microsoft.hint": "使用微软 Bing 在线翻译，无需配置 Azure 账号、订阅密钥或 Region，启用后即可参与自动翻译降级链路。",
  "settings.microsoft.notChecked": "未检测",
  "settings.microsoft.title": "微软翻译",
  "settings.microsoft.warning": "此通道依赖 Bing 网页翻译的临时参数，并非微软承诺稳定的公开开发者 API；接口可能因服务调整而失效，失败时应用会自动切换到后续通道。",
  "settings.ocr.assetLicense": "许可",
  "settings.ocr.assetModel": "模型",
  "settings.ocr.assetVersion": "版本",
  "settings.ocr.assetsTitle": "模型资产",
  "settings.ocr.engineAuto": "自动选择",
  "settings.ocr.enginePaddle": "仅 PaddleOCR",
  "settings.ocr.enginePreference": "引擎偏好",
  "settings.ocr.engineSystem": "仅系统 OCR",
  "settings.ocr.engineTesseract": "仅 Tesseract",
  "settings.ocr.hotkey": "截图快捷键",
  "settings.ocr.hotkeyPlaceholder": "点击后按下快捷键",
  "settings.ocr.lang": "识别语言",
  "settings.ocr.langAuto": "自动",
  "settings.ocr.loading": "读取中…",
  "settings.ocr.privacyHint": "截图和剪贴板图片只在主动触发时识别；本地 OCR 引擎不会上传图片。",
  "settings.ocr.readingStatus": "正在读取 OCR 状态…",
  "settings.ocr.scale": "最大尝试倍率",
  "settings.ocr.scaleHint": "首轮固定使用 1×；该值仅限制低质量回退时的放大上限。",
  "settings.ocr.tesseract": "Tesseract",
  "settings.ocr.tesseractFallback": "启用兜底识别",
  "settings.ocr.title": "OCR 翻译",
  "settings.proxy.bypass": "绕过规则",
  "settings.proxy.bypassHint": "多个规则使用分号分隔；本机 DeepLX 建议保留 <local> 和 localhost。",
  "settings.proxy.bypassPlaceholder": "<local>;localhost;127.0.0.1",
  "settings.proxy.mode": "代理模式",
  "settings.proxy.modeCustom": "自定义代理",
  "settings.proxy.modeDirect": "直连（不使用代理）",
  "settings.proxy.modeSystem": "跟随系统代理",
  "settings.proxy.rules": "代理地址",
  "settings.proxy.rulesHint": "支持 HTTP、HTTPS、SOCKS4、SOCKS5，例如 socks5://127.0.0.1:7890。",
  "settings.proxy.rulesPlaceholder": "http://127.0.0.1:7890",
  "settings.proxy.title": "网络代理",
  "settings.schemaVersion": "设置架构版本",
  "settings.service.hint": "停止后托盘图标和划词翻译功能都会退出，需要使用时请重新启动应用。",
  "settings.service.stop": "关闭并停止服务",
  "settings.service.title": "服务控制",
  "settings.sourceLang.auto": "自动检测",
  "settings.speech.edge": "Edge 在线神经网络语音",
  "settings.speech.provider": "语音引擎",
  "settings.speech.system": "系统内置语音（默认）",
  "settings.speech.title": "语音朗读",
  "settings.tab.about": "关于",
  "settings.tab.advanced": "高级",
  "settings.tab.ai": "AI 翻译",
  "settings.tab.general": "常规",
  "settings.tab.logs": "日志",
  "settings.tab.ocr": "OCR",
  "settings.tab.translationServices": "翻译服务",
  "settings.themeMode.dark": "始终深色",
  "settings.themeMode.hint": "主题会立即应用到弹窗、设置页、截图工具和网页阅读器。",
  "settings.themeMode.label": "主题模式",
  "settings.themeMode.light": "始终浅色",
  "settings.themeMode.system": "跟随系统",
  "settings.themePreset.emerald.desc": "清爽自然",
  "settings.themePreset.emerald.name": "祖母绿",
  "settings.themePreset.group": "主题配色",
  "settings.themePreset.navy.desc": "稳重低调",
  "settings.themePreset.navy.name": "藏青色",
  "settings.themePreset.platinumBlack.desc": "高级极简",
  "settings.themePreset.platinumBlack.name": "铂金黑",
  "settings.themePreset.sakura.desc": "柔和轻盈",
  "settings.themePreset.sakura.name": "樱花粉",
  "settings.themePreset.sky.desc": "清晰专业",
  "settings.themePreset.sky.name": "天空蓝",
  "settings.titlebar": "设置窗口标题栏",
  "settings.trigger.autoHide": "结果自动隐藏",
  "settings.trigger.autoHide.never": "不自动隐藏（默认）",
  "settings.trigger.autoHide.seconds15": "15 秒",
  "settings.trigger.autoHide.seconds3": "3 秒",
  "settings.trigger.autoHide.seconds5": "5 秒",
  "settings.trigger.autoHide.seconds8": "8 秒",
  "settings.trigger.doubleClick": "双击选词",
  "settings.trigger.doubleClickHint": "关闭后，双击选词不再显示“译”按钮；鼠标拖拽划词仍按上方触发方式处理。",
  "settings.trigger.doubleClickLabel": "双击选词显示“译”按钮",
  "settings.trigger.globalHotkey": "全局快捷键",
  "settings.trigger.manualHotkey": "手动翻译",
  "settings.trigger.webReaderHotkey": "网页阅读器",
  "settings.trigger.clearHotkey": "清除",
  "settings.trigger.hotkeyRegistrationFailed": "快捷键注册失败：{message}",
  "settings.trigger.hotkeyPlaceholder": "点击后按下快捷键",
  "settings.trigger.mode.auto": "划词后自动打开并翻译",
  "settings.trigger.mode.button": "划词后显示“译”按钮",
  "settings.trigger.mode.hotkey": "仅使用快捷键打开",
  "settings.trigger.modeLabel": "触发方式",
  "settings.trigger.selectionButton": "选区按钮",
  "settings.trigger.selectionButtonHint": "开启后切换为按钮触发；关闭后切换为仅快捷键。与上方“触发方式”以及托盘菜单开关保持同步。",
  "settings.trigger.selectionButtonLabel": "划词后自动显示“译”按钮",
  "settings.trigger.title": "触发与弹窗",
  "settings.uiLocale.auto": "跟随系统",
  "settings.uiLocale.enUS": "English",
  "settings.uiLocale.hint": "切换后立即应用到所有已打开的窗口和托盘菜单。",
  "settings.uiLocale.label": "界面语言",
  "settings.uiLocale.title": "界面语言",
  "settings.uiLocale.zhCN": "简体中文",
  "settings.update.buildIdentity": "构建标识",
  "settings.update.cancelDownload": "取消下载",
  "settings.update.check": "检查更新",
  "settings.update.currentVersion": "当前版本",
  "settings.update.downloadDmg": "下载并打开 DMG",
  "settings.update.installHint": "macOS 手动升级会下载并打开 DMG，仍由用户确认拖入“应用程序”。",
  "settings.update.latestVersion": "最新版本",
  "settings.update.notChecked": "尚未检查",
  "settings.update.openRelease": "打开发布页",
  "settings.update.readingStatus": "正在读取更新状态…",
  "settings.update.removeQuarantine": "解除 macOS 隔离属性",
  "settings.update.title": "版本与更新",
  "settings.web.concurrency": "并发请求数",
  "settings.web.concurrencyHint": "并发请求数越高，长网页翻译越快，但也会增加翻译服务商的瞬时压力，可能触发限流；建议自建或高配额通道使用较高数值。",
  "settings.web.defaultMode": "默认显示",
  "settings.web.enabled": "启用网页翻译",
  "settings.web.enabledLabel": "允许打开内置网页翻译阅读器",
  "settings.web.imageOcr": "图片文字识别",
  "settings.web.imageOcrHint": "开启后，阅读器会通过当前页面 Session 读取图片字节，必要时回退为图片区域截图；识别失败、尺寸过小或超过上限的图片会被跳过，不影响文本翻译。图片只在本机处理，OCR 结果仅在翻译当前页面时发送给所选翻译服务。",
  "settings.web.imageOcrLabel": "对页面图片执行 OCR 并翻译图片中的文字",
  "settings.web.imageOverlay": "图片译文展示",
  "settings.web.maxBlocks": "最大文本块数",
  "settings.web.maxChars": "最大总字数",
  "settings.web.maxImages": "单页最大图片数",
  "settings.web.minImageSize": "最小图片边长",
  "settings.web.modeBilingual": "对照",
  "settings.web.modeSource": "原文",
  "settings.web.modeTarget": "译文",
  "settings.web.overlayBelow": "图片下方说明",
  "settings.web.overlayOnImage": "叠加在图片上",
  "settings.web.readHint": "只有打开内置阅读器并显式点击提取/翻译后，应用才会读取当前页面文本。不会读取系统浏览器已打开的页面。",
  "settings.web.scope": "翻译范围",
  "settings.web.scopeAll": "全部可见文本",
  "settings.web.scopeBody": "仅正文",
  "settings.web.title": "网页全文翻译",
  "settings.windowTitle": "划词翻译 · 设置",
  "toast.copiedToClipboard": "已添加到剪贴板",
  "toast.savedToDisk": "已保存到本地",
  "popup.speechCompleted": "朗读完成",
  "popup.edgeSpeechCancelled": "Edge 语音请求已取消",
  "popup.edgeSpeechRequesting": "正在请求 Edge 语音…",
  "popup.edgeSpeechPlaying": "正在播放 Edge 语音…",
  "popup.autoDetect": "自动检测",
  "popup.autoBilingual": "自动中英互译",
  "popup.autoSelect": "自动选择",
  "popup.providerDisabled": "未启用",
  "popup.providerDisabledLabel": "{{provider}}（未启用）",
  "popup.providerPreferred": "首选翻译 API：{{provider}}",
  "popup.providerAutoActual": "自动选择，实际使用：{{provider}}",
  "popup.providerAutoActualShort": "自动 · {{provider}}",
  "popup.providerFallbackActual": "首选 {{preferred}} 已熔断或不可用，实际使用：{{actual}}",
  "popup.providerPreferredActual": "首选并实际使用：{{provider}}",
  "popup.speechStop": "停止朗读",
  "popup.speechUnavailable": "暂无可朗读的译文",
  "popup.speechEdgeHint": "使用 Edge 在线语音朗读译文",
  "popup.speechSystemUnavailable": "朗读译文（需要系统语音）",
  "popup.speechRead": "朗读译文",
  "popup.speechStopped": "已停止朗读",
  "popup.edgeSpeechUnavailable": "Edge 在线语音暂不可用",
  "popup.edgeSpeechUnavailableWithError": "Edge 在线语音暂不可用：{{error}}，已切换到系统语音",
  "popup.ocrSystem": "系统 OCR",
  "popup.ocrEmpty": "未识别到文字",
  "popup.ocrNoise": "识别文字质量过低（噪声）",
  "popup.ocrPermission": "缺少屏幕录制权限，请在系统设置中授权",
  "popup.ocrNoClipboardImage": "剪贴板中没有图片",
  "popup.ocrTimeout": "OCR 识别超时",
  "popup.ocrEngineUnavailable": "OCR 引擎不可用",
  "popup.ocrRecognizing": "正在识别图片文字…",
  "popup.translating": "正在翻译…",
  "popup.translationFailed": "翻译失败",
  "popup.translationPlaceholder": "翻译结果将显示在这里",
  "popup.translationRequestFailed": "翻译请求失败，请重试",
  "popup.languageSaveFailed": "语言设置保存失败",
  "popup.retranslationFailed": "重新翻译失败",
  "popup.providerSwitchFailed": "翻译 API 切换失败",
  "popup.copied": "已复制",
  "popup.unpinWindow": "取消固定弹窗",
  "popup.ocrCopied": "已复制 OCR 内容",
  "popup.translatingInto": "正在翻译为{{language}}…",
  "popup.providerPreferredApplied": "已优先使用{{provider}}",
  "popup.edgeAudioReceived": "已收到 Edge 音频（{{bytes}} 字节）",
  "popup.switchToSelection": "切换到划词翻译",
  "popup.validation.invalidSource": "原文格式无效",
  "popup.validation.emptySource": "请输入要翻译的原文",
  "popup.validation.sourceTooLong": "原文不能超过{{max}}个字符",
  "toast.windowTitle": "截图提示",
  "update.available": "发现新版本 {{version}}，下载后即可升级",
  "update.availableManual": "发现新版本 {{version}}，当前环境需要手动安装",
  "update.cancelled": "已取消下载，可重新点击升级继续",
  "update.checking": "正在检查更新…",
  "update.checksumMismatch": "；Release 的 SHA256SUMS 与安装包不一致，建议重新升级",
  "update.checksumMissing": "；Release 缺少当前安装包的 SHA256SUMS 校验值，建议升级",
  "update.checksumNeedsUpdateMismatch": "当前版本的 SHA256SUMS 校验值不一致，建议升级",
  "update.checksumNeedsUpdateMissing": "当前版本没有 SHA256SUMS 校验值，建议升级",
  "update.checksumUnreachable": "；无法读取 Release 的 SHA256SUMS 校验值，请确认安装包来源",
  "update.disabled": "开发环境不会检查更新",
  "update.downloaded": "版本 {{version}} 已下载，重启后完成升级",
  "update.progress.downloaded": "已下载 {{size}}",
  "update.downloading": "正在下载更新… {{percent}}%",
  "update.downloadingInitial": "正在下载更新…",
  "update.error.downloadInterrupted": "更新失败：下载连接中断，已保留断点，可重新点击升级继续",
  "update.error.downloadTimeout": "更新失败：下载连接超时，已保留断点，可重新点击升级继续",
  "update.error.generic": "更新失败：{{message}}",
  "update.error.missingManifest": "当前 GitHub Release 缺少自动更新清单 {{manifest}}，请稍后重新检查或打开发布页手动安装",
  "update.error.networkInterrupted": "更新失败：网络连接被中断，请检查网络或代理设置后重试",
  "update.error.networkTimeout": "更新失败：网络请求超时，请检查网络或代理设置后重试",
  "update.error.networkUnavailable": "更新失败：无法连接更新服务器，请检查网络或代理设置后重试",
  "update.downloadError.cancelled": "下载已取消",
  "update.downloadError.networkInterrupted": "网络连接被中断",
  "update.downloadError.requestTimeout": "分片请求超时",
  "update.downloadError.readTimeout": "分片读取超时",
  "update.downloadError.writeFailed": "写入更新临时文件失败",
  "update.downloadError.segmentFailed": "分片下载失败（字节 {{start}}-{{end}}）：{{message}}",
  "update.downloadError.unknown": "未知错误",
  "update.downloadError.lengthMismatch": "更新包长度校验失败，期望 {{expected}} 字节，实际 {{actual}} 字节",
  "update.downloadError.checksumMismatch": "更新包校验失败",
  "update.downloadError.invalidUrl": "DMG 下载地址格式无效",
  "update.downloadError.insecureUrl": "DMG 下载只支持 HTTPS 地址",
  "update.downloadError.notDmg": "更新下载地址必须是 DMG 文件",
  "update.downloadError.redirectMissingLocation": "DMG 下载重定向缺少目标地址",
  "update.downloadError.tooManyRedirects": "DMG 下载重定向次数过多",
  "update.downloadError.downloadHttpFailed": "DMG 下载失败（HTTP {{status}}）",
  "update.downloadError.unknownStatus": "未知状态",
  "update.downloadError.integrityFailed": "更新包完整性校验失败，已删除下载文件；请重新下载或从发布页手动安装",
  "update.downloadError.openFailed": "无法打开已下载的 DMG：{{message}}",
  "update.error.signatureMismatch": "更新包签名与当前应用不兼容，已改用手动安装；请下载 DMG，拖入“应用程序”并覆盖旧版本",
  "update.idle": "尚未检查更新",
  "update.integrityNoticeMissing": "；本次更新清单未提供该 DMG 的校验值，安装包未经完整性校验",
  "update.manualDmgDownloading": "正在下载 macOS DMG 更新包…",
  "update.manualDownloaded": "更新包已下载到“下载”文件夹并打开 DMG；请把“划词翻译”拖入“应用程序”覆盖旧版本，然后点击“解除 macOS 隔离属性”",
  "update.noDmgFallback": "当前更新清单没有可直接下载的 DMG，已打开 GitHub Release，请手动下载安装",
  "update.notAvailable": "当前已经是最新版本",
  "update.notAvailableWithBuild": "当前已经是最新构建（构建 {{build}}）",
  "update.openRelease": "已打开 GitHub Release，请手动下载对应平台的安装包覆盖安装",
  "update.sameVersion.downloadAction": "可下载 DMG 覆盖安装",
  "update.sameVersion.message": "发现同版本的新构建 {{version}}（当前构建 {{localBuild}}，最新构建 {{remoteBuild}}），{{action}}",
  "update.sameVersion.releaseAction": "请打开 GitHub Release 手动更新",
  "webReader.address": "网页地址",
  "webReader.addressPlaceholder": "输入网页地址，例如 example.com",
  "webReader.back": "后退",
  "webReader.brand": "划词翻译网页翻译",
  "webReader.contentArea": "网页内容区域",
  "webReader.display": "显示",
  "webReader.displayMode": "网页显示模式",
  "webReader.enterAddress": "输入网页地址",
  "webReader.forward": "前进",
  "webReader.loadingProgress": "网页加载进度",
  "webReader.mode.bilingual": "对照",
  "webReader.mode.source": "原文",
  "webReader.mode.target": "译文",
  "webReader.navigationToolbar": "网页翻译导航工具栏",
  "webReader.reload": "重新加载",
  "webReader.titlebar": "网页翻译窗口标题栏",
  "webReader.translatePage": "翻译网页",
  "webReader.windowTitle": "网页翻译",
  "webReader.restore": "还原",
  "webReader.maximize": "最大化",
  "webReader.pageUpdated": "页面有内容更新，已完成译文仍保留；可再次点击补译",
  "webReader.loadingAndTranslating": "正在边加载边翻译：已完成 {{done}} / 已发现 {{discovered}}",
  "webReader.loadingPage": "正在加载网页…",
  "webReader.imageProgress": "图片 {{processed}}/{{candidates}}",
  "webReader.imageSkipped": "，跳过 {{count}}",
  "webReader.imageFailed": "，失败 {{count}}",
  "webReader.imageHintPrefix": "，",
  "webReader.cacheHits": "，缓存命中 {{count}} 项",
  "webReader.failureCount": "，失败 {{count}} 项",
  "webReader.cancelled": "翻译已取消",
  "webReader.extracting": "正在提取网页文本…",
  "webReader.translatingProgress": "正在翻译：已完成 {{done}}/{{total}}",
  "webReader.continuedWithMismatch": "翻译已继续完成，{{count}} 项因页面变化暂未写回；已完成译文仍保留，可再次点击补译",
  "webReader.partialResult": "仅翻译了部分网页内容{{failed}}{{images}}；初始加载收集已结束，可再次点击补译",
  "webReader.completedImagesPartial": "翻译完成，图片部分未处理{{images}}",
  "webReader.completedInputOpen": "翻译完成，初始加载收集仍在进行{{images}}",
  "webReader.completed": "翻译完成{{images}}",
  "webReader.translationFailed": "网页翻译失败",
  "webReader.switchSkippedHint": "，另有 {{count}} 个短文本/交互块按设计跳过对照",
  "webReader.switchedUnrendered": "已切换对照显示，{{count}} 个块未对照；可再次点击补译",
  "webReader.switchedMismatched": "已切换对照显示，{{count}} 项因页面变化未对照；可再次点击补译",
  "webReader.currentBilingual": "当前显示对照",
  "webReader.partialContentChanged": "部分内容已变化，未受影响的译文仍保留；可再次点击补译",
  "webReader.showingSource": "当前显示原文",
  "webReader.showingTarget": "当前显示译文",
  "webReader.switchModeFailed": "切换网页显示失败",
  "webReader.invalidAddress": "网页地址无效",
  "lang.AR": "阿拉伯语",
  "lang.BG": "保加利亚语",
  "lang.CS": "捷克语",
  "lang.DA": "丹麦语",
  "lang.DE": "德语",
  "lang.EL": "希腊语",
  "lang.EN": "英语",
  "lang.ES": "西班牙语",
  "lang.ET": "爱沙尼亚语",
  "lang.FI": "芬兰语",
  "lang.FR": "法语",
  "lang.HU": "匈牙利语",
  "lang.ID": "印尼语",
  "lang.IT": "意大利语",
  "lang.JA": "日语",
  "lang.KO": "韩语",
  "lang.LT": "立陶宛语",
  "lang.LV": "拉脱维亚语",
  "lang.NL": "荷兰语",
  "lang.PL": "波兰语",
  "lang.PT": "葡萄牙语",
  "lang.RO": "罗马尼亚语",
  "lang.RU": "俄语",
  "lang.SK": "斯洛伐克语",
  "lang.SL": "斯洛文尼亚语",
  "lang.SV": "瑞典语",
  "lang.TR": "土耳其语",
  "lang.UK": "乌克兰语",
  "lang.ZH": "中文",
  "provider.ai": "AI 翻译",
  "provider.auto": "自动选择",
  "provider.deeplx-public": "公共 DeepLX",
  "provider.deeplx-self": "自建 DeepLX",
  "provider.dingtalk": "钉钉翻译",
  "provider.google": "Google 翻译",
  "provider.microsoft": "微软翻译",
  "provider.mymemory": "MyMemory 翻译",
  "common.notApplicable": "不适用",
  "common.yes": "是",
  "common.no": "否",
  "notification.brand": "划词翻译",
  "notification.install.subject": "【划词翻译】首次安装通知 - {{version}}",
  "notification.upgrade.subject": "【划词翻译】版本升级通知 - {{version}}",
  "notification.title": "划词翻译 - 安装/升级事件通知",
  "notification.section.event": "事件基础信息",
  "notification.section.environment": "运行环境信息",
  "notification.event.type": "事件类型",
  "notification.event.install": "首次安装",
  "notification.event.upgrade": "版本升级",
  "notification.previousVersion": "上一版本",
  "notification.previousVersion.none": "无（全新安装）",
  "notification.currentVersion": "当前版本",
  "notification.eventTime": "事件时间",
  "notification.platform": "操作系统",
  "notification.kernel": "内核版本",
  "notification.ip": "访问公网IP",
  "notification.location": "IP归属地",
  "notification.unknown": "未知",
  "notification.footer": "说明：本通知为自动化系统上报，仅记录设备安装/升级行为，无任何用户隐私数据",
  "notification.ipUnavailable": "无法获取公网 IP",
  "usage.brand": "划词翻译",
  "usage.subject": "【划词翻译】每日使用量统计报表 - {{date}}",
  "usage.title": "划词翻译 - 每日使用量统计日报",
  "usage.section.environment": "运行环境信息",
  "usage.section.daily": "每日使用数据统计",
  "usage.platform": "操作系统",
  "usage.kernel": "内核版本",
  "usage.appVersion": "应用版本",
  "usage.buildId": "构建编号",
  "usage.ip": "访问公网IP",
  "usage.location": "IP归属地",
  "usage.unknown": "未知",
  "usage.date": "统计日期",
  "usage.noRecords": "当日无翻译使用记录",
  "usage.channel.title": "翻译方式使用次数",
  "usage.provider.title": "翻译服务使用次数",
  "usage.count": "{{count}} 次",
  "usage.count.plural": { one: "{{count}} 次", other: "{{count}} 次" },
  "usage.footer": "说明：本报表为自动化统计数据，仅记录使用次数、访问公网IP与归属地，不含用户翻译文本",
  "usage.channel.hotkey": "快捷键翻译",
  "usage.channel.selection": "划词翻译",
  "usage.channel.screenshot": "截图翻译",
  "usage.channel.webpage": "网页翻译",
  "usage.provider.ai": "AI 翻译",
  "usage.provider.dingtalk": "钉钉",
  "usage.provider.microsoft": "微软",
  "usage.provider.google": "谷歌",
  "usage.provider.deeplx-self": "DeepLX 自建",
  "update.items": {
    one: "{{count}} 项",
    other: "{{count}} 项"
  },
  "common.restore": "还原",
  "settings.saved": "已保存并生效",
  "settings.saveFailed": "保存失败：{{message}}",
  "settings.targetLang.auto": "自动中英互译",
  "settings.trigger.hint.auto": "选中文字后自动打开翻译弹窗；需要 macOS 辅助功能权限。",
  "settings.trigger.hint.button": "每次划词都显示“译”按钮；只有点击按钮后才会打开或更新翻译弹窗。",
  "settings.trigger.hint.hotkey": "划词后不会自动弹出内容，需要按下下方配置的全局快捷键。",
  "settings.speech.hint.edge": "需要网络，朗读文本会发送到微软在线服务；该免费非官方接口可能随服务调整失效，失败时会自动回退系统语音。",
  "settings.speech.hint.system": "免费、无需网络，音质取决于操作系统已安装的语音；不会将朗读文本发送到在线服务。",
  "settings.autoHide.custom": "自定义 ({{ms}}ms)",
  "settings.ai.secretConfigured": "API Key 已安全配置；留空保存将保留原值",
  "settings.ai.apiKeyConfigured": "API Key 已配置",
  "settings.ai.modelsEmpty": "暂无模型，请刷新或手动输入",
  "settings.ai.modelsNoMatch": "无匹配模型，可直接手动输入",
  "settings.ai.modelsLoaded": "已加载 {{count}} 个模型",
  "settings.ai.modelsUnsupported": "当前协议不支持模型列表",
  "settings.ai.modelsLoadFailed": "模型列表加载失败",
  "settings.ai.modelsLoading": "加载模型列表中…",
  "settings.ai.modelsLoadFailedManual": "模型列表加载失败，可手动输入",
  "settings.ai.checking": "检测中…",
  "settings.ai.checkFailed": "检测失败，请稍后重试",
  "settings.ai.saved": "AI 配置已保存并生效",
  "settings.ai.saveFailed": "AI 配置保存失败：{{message}}",
  "settings.ai.clearConfirm": "确定清除已保存的 AI API Key 吗？清除后需要鉴权的协议将无法使用。",
  "settings.ai.clearedHint": "API Key 已清除，请重新配置后检测",
  "settings.ai.clearedFlash": "AI API Key 已清除",
  "settings.ai.clearFailed": "清除失败：{{message}}",
  "settings.dingTalk.secretConfigured": "Secret 已安全配置；留空保存将保留原值",
  "settings.dingTalk.saved": "钉钉配置已保存并生效",
  "settings.dingTalk.saveFailed": "钉钉配置保存失败：{{message}}",
  "settings.dingTalk.clearConfirm": "确定清除已保存的钉钉 ClientSecret 吗？清除后钉钉翻译将暂停使用。",
  "settings.dingTalk.secretCleared": "Secret 已清除，请重新配置后检测",
  "settings.dingTalk.clearedFlash": "钉钉 ClientSecret 已清除",
  "settings.dingTalk.clearFailed": "清除失败：{{message}}",
  "settings.dingTalk.checking": "检测中…",
  "settings.dingTalk.checkFailed": "检测失败，请稍后重试",
  "settings.microsoft.enabledHint": "已启用，建议检测当前可用性",
  "settings.microsoft.disabled": "通道已关闭",
  "settings.microsoft.saved": "微软翻译启用状态已保存并生效",
  "settings.microsoft.saveFailed": "微软翻译启用状态保存失败：{{message}}",
  "settings.microsoft.checking": "检测中…",
  "settings.microsoft.checkFailed": "检测失败，请稍后重试",
  "settings.deepLx.saved": "DeepLX 配置已保存并生效",
  "settings.deepLx.saveFailed": "DeepLX 配置保存失败：{{message}}",
  "settings.deepLx.statusSaveFailed": "✗ 配置保存失败：{{message}}",
  "settings.deepLx.checking": "检测中…",
  "settings.deepLx.online": "服务在线",
  "settings.deepLx.offline": "无法连接",
  "settings.deepLx.checkFailed": "✗ 检测失败：{{message}}",
  "settings.deepLx.copied": "已复制命令",
  "settings.service.stopConfirm": "停止服务后，托盘图标和划词翻译功能都会退出。需要使用时请重新启动应用。确定停止吗？",
  "settings.logs.resume": "恢复",
  "settings.logs.exportedTo": "日志已导出到 {{path}}",
  "settings.diagnostics.expand": "展开",
  "settings.diagnostics.dayTitle": "{{date}}（共 {{count}} 次）",
  "settings.diagnostics.failureReasons": "失败原因",
  "settings.diagnostics.topApps": "失败应用 Top 5",
  "settings.diagnostics.empty": "近两天暂无取词诊断记录",
  "settings.diagnostics.exportedTo": "诊断已导出到 {{path}}",
  "settings.diagnostics.entry.button": "按钮",
  "settings.diagnostics.entry.hotkey": "快捷键",
  "settings.diagnostics.entry.auto": "自动",
  "settings.diagnostics.level.nativeRead": "原生直读",
  "settings.diagnostics.level.copyPolled": "复制轮询",
  "settings.diagnostics.level.copyLate": "稳定期命中",
  "settings.diagnostics.level.failed": "失败",
  "settings.diagnostics.reason.empty": "空选区",
  "settings.diagnostics.reason.timeout": "超时",
  "settings.diagnostics.reason.unsupported": "不支持",
  "settings.diagnostics.reason.permission": "权限",
  "settings.diagnostics.reason.unknown": "未知",
  "settings.ocr.engineSystemShort": "系统 OCR",
  "settings.ocr.availableEngines": "{{message}}；可用引擎：{{engines}}",
  "settings.ocr.noEngines": "暂无",
  "settings.update.restartToInstall": "立即重启升级",
  "settings.update.openReleaseManual": "打开 GitHub Release 手动更新",
  "settings.update.redownloadDmg": "重新下载 DMG",
  "settings.update.downloadAndOpenDmg": "下载并打开 DMG",
  "settings.update.downloadAndInstall": "下载并安装",
  "settings.update.hint.dev": "开发环境不会访问更新服务，请使用正式安装包验证自动更新。",
  "settings.update.hint.sameVersionOpenRelease": "发现同版本的新构建；当前平台不支持应用内自动安装，请打开 GitHub Release 手动下载覆盖安装。",
  "settings.update.hint.sameVersionManualDmg": "发现同版本的新构建；点击后会下载并校验对应架构的 DMG，仍由你确认拖入“应用程序”覆盖旧版本。",
  "settings.update.hint.openReleaseOnly": "当前更新需要在 GitHub Release 手动下载安装包并覆盖安装。",
  "settings.update.hint.manualDownloaded": "更新包已下载到“下载”文件夹并打开 DMG；请手动拖入“应用程序”覆盖旧版本，再点击“解除 macOS 隔离属性”。",
  "settings.update.hint.manualDownload": "点击升级后，更新包会下载到“下载”文件夹并自动打开 DMG。",
  "settings.update.hint.automatic": "检测到新版本后由你确认下载；下载完成后可立即重启并完成升级。",
  "settings.update.checkFailed": "检查更新失败：{{message}}",
  "settings.update.actionFailed": "更新操作失败：{{message}}",
  "settings.update.cancelFailed": "取消下载失败：{{message}}",
  "settings.update.quarantineFailed": "解除隔离属性失败：{{message}}",
  "settings.update.openReleaseFailed": "无法打开发布页：{{message}}",
  "dialog.hiServices.title": "划词取词服务异常",
  "dialog.hiServices.message": "划词按钮未出现或取词连续失败",
  "dialog.hiServices.detail": "检测到 macOS 的按键注入服务（hiservices）可能已故障，导致模拟复制无法送达前台应用。点击下方按钮可立即重启该服务，系统会自动重新拉起，通常可恢复划词翻译。",
  "dialog.hiServices.repair": "一键修复",
  "dialog.hiServices.later": "稍后",
  "dialog.hiServices.repaired": "已重启系统按键注入服务并刷新划词监听，请再划词试一次。",
  "dialog.hiServices.failed": "自动修复失败，请在终端执行 sudo pkill -9 -f hiservices 后重试。",
  "error.accessibilityPermission": "需要「辅助功能」权限。请在弹出的系统设置中勾选本应用后重试。",
  "error.accessibilityPermissionAuto": "需要「辅助功能」权限才能划词取词与自动翻译。请在系统设置中勾选本应用（开发模式为 Electron）后重启。",
  "error.translationFailed": "翻译失败",
  "error.screenCaptureFailed": "无法获取屏幕截图",
  "error.screenCaptureFailedDetail": "无法获取屏幕截图: {{message}}",
  "error.screenCaptureTimeout": "屏幕采集超时，请重试",
  "error.screenRecordingPermission": "需要屏幕录制权限",
  "error.imageRequestTimeout": "图片请求超时",
  "error.imageRequestCancelled": "图片请求已取消",
  "error.imageCaptureCancelled": "图片截图已取消",
  "error.noTranslatableText": "未识别到可翻译文字",
  "error.noRecognizedText": "未识别到文字",
  "error.ocrFailed": "OCR 识别失败",
  "error.screenshotExpired": "截图已失效，请重新截图",
  "error.invalidSelection": "选区无效，请重新框选",
  "error.copyImageFailed": "复制图片失败",
  "error.saveImageFailed": "保存图片失败",
  "error.noClipboardImage": "剪贴板中没有图片",
  "error.invalidWebUrl": "请输入有效的网页地址",
  "error.invalidWebMode": "网页展示模式无效",
  "error.trayIconLoadFailed": "无法加载托盘图标: {{message}}",
  "error.dockIconLoadFailed": "无法加载 macOS Dock 图标: {{message}}",
  "ocr.assetsReady": "{{name}} 兼容模型资产已就绪，PaddleOCR 主链路可用",
  "ocr.assetsRuntimeUnavailable": "{{name}} 兼容模型资产已就绪，但 PaddleOCR runtime 暂不可用",
  "ocr.assetsFallback": "{{message}}，将优先使用系统 OCR 或 Tesseract 兜底",
  "selection.loadingReading": "正在读取选中文字…",
  "selection.loadingRecognizing": "正在识别屏幕区域…",
  "selection.loadingTranslating": "正在翻译识别结果…",
  "selection.loadingClipboardImage": "正在识别剪贴板图片…",
  "selection.captureFailure.imageOnly": "已识别到图片选区，暂不支持图片翻译",
  "selection.captureFailure.timeout": "取词超时，请重试或确认所选内容可复制",
  "selection.captureFailure.unsupported": "当前应用不支持划词取词，请确认所选内容可复制",
  "selection.captureFailure.permission": "需要「辅助功能」权限才能读取选中文字，请授权后重试",
  "selection.captureFailure.clipboardLocked": "剪贴板被占用，请关闭其他剪贴板工具后重试",
  "selection.captureFailure.empty": "未检测到选中文字，请重新划词后点击“译”按钮",
  "screenshot.defaultFileNamePrefix": "截图",
  "screenshot.pngFilter": "PNG 图片",
  "deepLx.dockerPlaceholder": "你的dl_session值",
  "macQuarantine.unknownError": "未知错误",
  "macQuarantine.unsupportedPlatform": "仅 macOS 支持解除应用隔离属性",
  "macQuarantine.pathNotAllowed": "为避免误操作，只允许处理 {{path}}",
  "macQuarantine.success": "已解除 {{path}} 的 macOS 隔离属性",
  "macQuarantine.noAttribute": "应用本来就没有隔离属性（com.apple.quarantine）",
  "macQuarantine.failed": "解除应用隔离属性失败：{{message}}。可手动执行：{{command}}"
});
const appZhCN = defineCatalog({
  "app.serviceNotInitialized.dingtalk": "钉钉配置服务尚未初始化",
  "app.serviceNotInitialized.aiConfig": "AI 配置服务尚未初始化",
  "app.serviceNotInitialized.deepLx": "DeepLX 配置服务尚未初始化",
  "app.serviceNotInitialized.update": "自动更新服务尚未初始化",
  "app.serviceNotInitialized.webReader": "网页阅读器尚未初始化",
  "app.serviceNotInitialized.deepLxCheck": "DeepLX 检测服务尚未初始化",
  "app.serviceNotInitialized.aiModelDiscovery": "AI 模型发现服务尚未初始化",
  "app.serviceNotInitialized.aiCheck": "AI 检测服务尚未初始化",
  "app.selectionListenerUnavailable": "划词监听未能启动，划词与双击将不可用，快捷键仍可使用"
});
const aiZhCN = defineCatalog({
  "ai.check.incomplete": "AI 配置不完整，请填写 Base URL 和模型",
  "ai.check.available": "AI 翻译配置可用",
  "ai.check.permission": "AI 应用权限不足",
  "ai.check.rateLimit": "AI 接口请求过于频繁，请稍后重试",
  "ai.check.serviceUnavailable": "AI 服务暂时不可用，请稍后重试",
  "ai.credentials.secureStorageReadUnavailable": "当前系统无法使用安全存储，无法读取 AI 凭证",
  "ai.credentials.readFailed": "无法读取已保存的 AI 凭证，请重新配置",
  "ai.credentials.secureStorageWriteUnavailable": "当前系统安全存储不可用，无法保存 AI 凭证",
  "ai.error.authentication": "AI 鉴权失败，请检查 API Key",
  "ai.error.rateLimit": "AI 接口请求限流，请稍后重试",
  "ai.error.notFound": "AI 模型不存在或路径错误",
  "ai.error.serviceUnavailable": "AI 服务暂时不可用",
  "ai.error.httpStatus": "AI 服务返回错误（HTTP {{status}}）",
  "ai.error.timeout": "AI 请求超时",
  "ai.error.network": "AI 网络连接失败",
  "ai.error.requestBuild": "AI 请求构造失败",
  "ai.error.nonJsonResponse": "AI 服务返回非 JSON 响应",
  "ai.error.responseParse": "AI 服务响应解析失败",
  "ai.error.emptyTranslation": "AI 返回译文为空",
  "ai.modelDiscovery.unsupported": "当前服务不支持模型列表，请手动输入模型名称",
  "ai.modelDiscovery.unsupportedResponse": "模型列表响应格式不受支持",
  "ai.modelDiscovery.parseFailed": "模型列表解析失败",
  "ai.modelDiscovery.authentication": "模型列表鉴权失败，请检查 API Key",
  "ai.modelDiscovery.rateLimit": "模型列表请求过于频繁，请稍后重试",
  "ai.modelDiscovery.loadFailed": "模型列表加载失败"
});
const captureZhCN = defineCatalog({
  "capture.error.selectionOutOfBounds": "选区不在当前屏幕内",
  "capture.error.screenCaptureFailed": "无法获取屏幕截图",
  "capture.error.screenRecordingPermissionRequired": "需要屏幕录制权限",
  "capture.error.unsupportedPlatform": "暂不支持当前平台：{{platform}}",
  "capture.error.accessibilityPermissionRequired": "需要「辅助功能」权限才能模拟复制",
  "capture.error.copySimulationFailed": "模拟复制失败: {{message}}",
  "capture.error.windowsOnlyGdi": "仅 Windows 支持 GDI 原生截屏",
  "capture.error.gdiGetDcFailed": "GetDC 失败：无法获取屏幕设备上下文",
  "capture.error.gdiCreateCompatibleDcFailed": "CreateCompatibleDC 失败",
  "capture.error.gdiCreateCompatibleBitmapFailed": "CreateCompatibleBitmap 失败",
  "capture.error.gdiBitBltFailed": "BitBlt 失败",
  "capture.error.gdiGetDIBitsFailed": "GetDIBits 失败：无法获取像素数据",
  "capture.error.gdiBindingLoadFailed": "koffi 绑定加载失败（将在 {{interval}} 毫秒后自动重试）: {{detail}}",
  "capture.error.gdiCaptureFailed": "GDI 截屏失败: {{message}}",
  "capture.error.gdiAndFallbackFailed": "无法获取屏幕截图: GDI 失败（{{gdiMessage}}）；回退失败（{{fallbackMessage}}）",
  "capture.error.windowsCaptureFailed": "无法获取屏幕截图: {{message}}",
  "capture.error.windowsHelperExit": "helper exe 退出码 {{exitCode}}: {{stderr}}",
  "capture.error.nativeReaderHelperMissing": "缺少 windows-uia-reader helper 可执行文件",
  "capture.error.exportRequestInvalid": "导出图片请求无效",
  "capture.error.exportActionInvalid": "导出动作类型无效",
  "capture.error.exportRequestIdInvalid": "导出请求 ID 无效",
  "capture.error.exportSessionInvalid": "截图会话无效",
  "capture.error.exportBoundsInvalid": "导出选区无效",
  "capture.error.exportDimensionsInvalid": "导出图片尺寸无效",
  "capture.error.exportDataInvalid": "导出图片数据无效",
  "capture.error.exportPngRequired": "导出图片必须是 PNG 格式"
});
const deepLxZhCN = defineCatalog({
  "deepLx.check.notConfigured": "未配置地址",
  "deepLx.check.summary": "{{online}}/{{total}} 个服务在线",
  "deepLx.check.timeout": "连接超时",
  "deepLx.check.network": "网络连接失败",
  "translate.error.tooLong": "单次翻译最多支持 {{max}} 个字符，请先分段",
  "translate.error.allChannelsFailed": "所有翻译通道均失败",
  "translate.error.unknown": "未知错误",
  "translate.channel.cached": "缓存",
  "translate.channel.ai": "AI 翻译",
  "translate.channel.dingtalk": "钉钉翻译",
  "translate.channel.microsoft": "微软翻译",
  "translate.channel.selfHostedDeepLx": "自建 DeepLX",
  "translate.channel.selfHostedDeepLxIndexed": "自建 DeepLX {{index}}",
  "translate.channel.publicDeepLx": "公共 DeepLX",
  "translate.check.dingtalkIncomplete": "钉钉配置不完整",
  "translate.check.dingtalkAvailable": "钉钉翻译在线且可用",
  "translate.check.microsoftAvailable": "微软翻译在线且可用",
  "translate.check.sampleText": "你好",
  "translate.deepLx.rateLimited": "限流 (429)",
  "translate.google.blocked": "被拦截（非 JSON 响应）",
  "translate.google.empty": "返回为空",
  "translate.myMemory.quotaExceeded": "免费额度已用完",
  "translate.myMemory.noResult": "无结果"
});
const dingtalkZhCN = defineCatalog({
  "dingtalk.error.authentication": "钉钉鉴权失败",
  "dingtalk.error.permission": "钉钉应用权限不足",
  "dingtalk.error.rateLimit": "钉钉接口请求过于频繁",
  "dingtalk.error.parameter": "钉钉请求参数无效",
  "dingtalk.error.serviceUnavailable": "钉钉服务暂时不可用",
  "dingtalk.error.timeout": "钉钉请求超时",
  "dingtalk.error.network": "钉钉网络连接失败",
  "dingtalk.error.configurationIncomplete": "钉钉配置不完整，请填写 CorpId、ClientId 和 ClientSecret",
  "dingtalk.error.authenticationStatus": "钉钉鉴权失败，请检查 CorpId、ClientId 和 ClientSecret",
  "dingtalk.error.permissionStatus": "钉钉应用未获得文本翻译权限",
  "dingtalk.error.rateLimitStatus": "钉钉接口请求过于频繁，请稍后重试",
  "dingtalk.error.parameterStatus": "钉钉翻译请求参数不受支持",
  "dingtalk.error.serviceStatus": "钉钉服务暂时不可用，请稍后重试",
  "dingtalk.error.tokenResponseInvalid": "钉钉 Token 响应格式无效",
  "dingtalk.error.tokenResponseParse": "钉钉 Token 响应无法解析",
  "dingtalk.error.translationResponseEmpty": "钉钉翻译响应为空",
  "dingtalk.error.translationResponseParse": "钉钉翻译响应无法解析",
  "dingtalk.credential.secureStorageUnavailableRead": "当前系统无法使用安全存储，无法读取钉钉凭证",
  "dingtalk.credential.readFailed": "无法读取已保存的钉钉凭证，请重新配置",
  "dingtalk.credential.secureStorageUnavailableSave": "当前系统安全存储不可用，无法保存钉钉凭证"
});
const microsoftZhCN = defineCatalog({
  "microsoft.error.authentication": "微软翻译网页会话已失效",
  "microsoft.error.rateLimit": "微软翻译接口请求过于频繁",
  "microsoft.error.parameter": "微软翻译请求参数无效",
  "microsoft.error.serviceUnavailable": "微软翻译服务暂时不可用",
  "microsoft.error.timeout": "微软翻译请求超时",
  "microsoft.error.network": "微软翻译网络连接失败",
  "microsoft.error.authenticationStatus": "微软翻译网页会话获取失败，请稍后重试",
  "microsoft.error.rateLimitStatus": "微软翻译接口请求过于频繁，请稍后重试",
  "microsoft.error.parameterStatus": "微软翻译请求参数不受支持",
  "microsoft.error.serviceStatus": "微软翻译服务暂时不可用，请稍后重试",
  "microsoft.error.textEmpty": "微软翻译文本不能为空",
  "microsoft.error.responseEmpty": "微软翻译响应为空",
  "microsoft.error.pageReadFailed": "微软翻译网页响应无法读取",
  "microsoft.error.redirectInvalid": "微软翻译网页重定向地址无效",
  "microsoft.error.authParametersParse": "微软翻译网页鉴权参数无法解析",
  "microsoft.error.authExpiryInvalid": "微软翻译网页鉴权有效期无效",
  "microsoft.error.responseParse": "微软翻译响应无法解析"
});
const ocrZhCN = defineCatalog({
  "ocr.model.gutenReady": "PP-OCRv4 兼容模型资产已就绪",
  "ocr.model.gutenIncomplete": "PP-OCRv4 兼容模型资产不完整：{{files}}",
  "ocr.model.ppOcrV6Ready": "PP-OCRv6_tiny 留档模型资产已就绪（默认不启用）",
  "ocr.model.ppOcrV6Incomplete": "PP-OCRv6_tiny 留档模型资产不完整：{{files}}",
  "ocr.dispatcher.availabilityCheckFailed": "{{engine}}: 可用性检测失败",
  "ocr.dispatcher.engineUnavailable": "不可用（平台或模型未就绪）",
  "ocr.dispatcher.invalidResult": "{{engine}}: 识别结果为空或疑似乱码",
  "ocr.dispatcher.allEnginesUnavailable": "所有 OCR 引擎均不可用: {{errors}}",
  "ocr.dispatcher.noTextRecognized": "所有 OCR 引擎均未识别到文字: {{errors}}",
  "ocr.error.requestMissingInput": "OCR 请求缺少图片字节或路径",
  "ocr.error.requestCancelled": "OCR 请求已取消",
  "ocr.error.invalidTimeout": "OCR 超时时间必须为正数",
  "ocr.error.recognizeTimeout": "OCR 识别超时（{{timeout}}ms）",
  "ocr.error.paddleMissingInput": "PaddleOCR 缺少图片输入",
  "ocr.error.paddleTimeout": "PaddleOCR 超时",
  "ocr.error.paddleFailed": "PaddleOCR 执行失败: {{message}}",
  "ocr.error.paddleRuntimeInitFailed": "PaddleOCR runtime 初始化失败: {{message}}",
  "ocr.error.paddleFallbackMissingExecutable": "PaddleOCR-json 可执行文件未找到，请先安装并确保在 PATH 中",
  "ocr.error.paddleFallbackMissingInput": "PaddleOCR-json 缺少图片输入",
  "ocr.error.paddleFallbackUnavailable": "PaddleOCR-json 不可用",
  "ocr.error.paddleFallbackTimeout": "PaddleOCR-json 超时",
  "ocr.error.paddleFallbackFailed": "PaddleOCR-json 执行失败: {{message}}",
  "ocr.error.visionMissingInput": "Vision OCR 缺少图片输入",
  "ocr.error.visionUnsupportedPlatform": "macOS Vision OCR 仅在 macOS 上可用",
  "ocr.error.visionHelperMissing": "macOS Vision OCR helper 未安装",
  "ocr.error.visionHelperUnavailable": "macOS Vision OCR helper 不可用: {{message}}",
  "ocr.error.visionPermissionRequired": "屏幕录制权限缺失，请在系统设置中授权",
  "ocr.error.visionPermissionMissing": "屏幕录制权限缺失",
  "ocr.error.visionTimeout": "Vision OCR 超时",
  "ocr.error.visionFailed": "macOS Vision OCR 执行失败: {{message}}",
  "ocr.error.windowsUnsupportedPlatform": "Windows 系统 OCR 仅在 Windows 上可用",
  "ocr.error.windowsMissingInput": "Windows OCR 缺少图片输入",
  "ocr.error.windowsLanguagePackMissing": "Windows OCR 语言包未安装",
  "ocr.error.windowsTimeout": "Windows OCR 超时",
  "ocr.error.windowsFailed": "Windows OCR 执行失败: {{message}}",
  "ocr.error.tesseractMissingInput": "Tesseract OCR 缺少图片输入",
  "ocr.error.tesseractTimeout": "Tesseract OCR 超时",
  "ocr.error.tesseractModelDownloadFailed": "Tesseract 语言模型下载失败，请检查网络后重试",
  "ocr.error.tesseractInterrupted": "Tesseract OCR 已中断，请重新截图识别",
  "ocr.error.tesseractFailed": "Tesseract OCR 执行失败: {{message}}",
  "ocr.error.pngUnsupportedFilter": "不支持的 PNG 滤镜类型：{{filter}}",
  "ocr.error.pngInvalidSignature": "不是合法的 PNG 文件签名",
  "ocr.error.pngChunkLengthIncomplete": "PNG 块长度不完整",
  "ocr.error.pngChunkOutOfBounds": "PNG 数据块越界",
  "ocr.error.pngInterlacedUnsupported": "不支持隔行扫描的 PNG",
  "ocr.error.pngInvalidDimensions": "PNG 尺寸非法",
  "ocr.error.pngUnsupportedBitDepth": "不支持的位深度：{{bitDepth}}",
  "ocr.error.pngUnsupportedColorType": "不支持的颜色类型：{{colorType}}",
  "ocr.error.pngScanlineIncomplete": "PNG 扫描线数据不完整",
  "ocr.error.pngEncodeInvalidImage": "无法编码空图像或数据不完整的图像"
});
const speechZhCN = defineCatalog({
  "speech.error.emptyText": "朗读文本为空",
  "speech.error.cancelled": "Edge 语音请求已取消",
  "speech.error.connectionFailed": "Edge 语音服务连接失败",
  "speech.error.timeout": "Edge 语音请求超时",
  "speech.error.noAudio": "Edge 语音服务未返回音频",
  "speech.error.connectionClosed": "Edge 语音服务连接已关闭",
  "speech.error.proxyUnsupported": "当前代理类型不支持 Edge 在线语音"
});
const rendererSpeechZhCN = defineCatalog({
  "rendererSpeech.error.noText": "暂无可朗读的译文",
  "rendererSpeech.error.unsupported": "当前环境不支持语音播放",
  "rendererSpeech.error.voiceListFailed": "读取系统语音失败，请检查系统语音设置",
  "rendererSpeech.error.noVoice": "当前系统没有可用语音，请检查系统语音设置",
  "rendererSpeech.error.playFailed": "语音播放失败，请重试",
  "rendererSpeech.edge.cancelled": "Edge 语音请求已取消",
  "rendererSpeech.edge.unavailable": "Edge 在线语音暂不可用",
  "rendererSpeech.edge.decodeFailed": "Edge 音频解码失败",
  "rendererSpeech.edge.noAudio": "Edge 语音服务未返回音频",
  "rendererSpeech.edge.playFailed": "Edge 音频播放失败",
  "rendererSpeech.audio.playFailed": "音频播放失败",
  "rendererSpeech.audio.playCancelled": "音频播放已取消"
});
const webReaderZhCN = defineCatalog({
  "webReader.error.disabled": "网页全文翻译已在设置中关闭",
  "webReader.error.pageChanged": "网页已变化，请重新提取",
  "webReader.error.extractFirst": "请先提取当前网页文本",
  "webReader.error.loadFailed": "网页加载失败：{{description}}",
  "webReader.error.notOpen": "网页阅读器尚未打开",
  "webReader.error.urlRequired": "请先打开一个 HTTP 或 HTTPS 网页",
  "webReader.error.onlyHttp": "网页阅读器仅支持 HTTP 或 HTTPS 地址",
  "webReader.error.invalidUrl": "请输入有效的网页地址",
  "webReader.error.extractionTimeout": "网页文本提取超时",
  "webReader.error.extractionFailed": "网页文本提取失败，请检查页面是否已加载完成",
  "webReader.error.documentNotReady": "网页主文档尚未准备好，请稍候再试",
  "webReader.error.rootNotReady": "网页根节点尚未创建，请稍候再试",
  "webReader.error.translationFailed": "翻译失败",
  "webReader.mainWindowTitle": "划词翻译 · 网页翻译"
});
const zhCNCatalog = defineCatalog({
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
});
const CATALOGS = {
  "zh-CN": zhCNCatalog,
  "en-US": enUSCatalog
};
function interpolate(template, params = {}) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (placeholder, name) => {
    const value = params[name];
    return value === void 0 ? placeholder : String(value);
  });
}
function selectPluralForm(forms, count) {
  if (count === 0 && forms.zero !== void 0) return forms.zero;
  if (count === 1) return forms.one;
  return forms.other;
}
function findValue(locale, key) {
  return CATALOGS[locale]?.[key] ?? CATALOGS[DEFAULT_LOCALE][key];
}
function createTranslator(locale) {
  const currentLocale = CATALOGS[locale] ? locale : DEFAULT_LOCALE;
  return {
    locale: currentLocale,
    t(key, params) {
      const value = findValue(currentLocale, key);
      if (typeof value === "string") return interpolate(value, params);
      if (value) return interpolate(selectPluralForm(value, Number(params?.count ?? 0)), params);
      return key;
    },
    plural(key, count, params) {
      const value = findValue(currentLocale, key);
      const mergedParams = { ...params, count };
      if (typeof value === "string") return interpolate(value, mergedParams);
      if (value) return interpolate(selectPluralForm(value, count), mergedParams);
      return key;
    },
    has(key) {
      return findValue(currentLocale, key) !== void 0;
    }
  };
}
const TRANSLATION_PROVIDERS = [
  { id: "ai", label: "AI Translation" },
  { id: "dingtalk", label: "DingTalk" },
  { id: "microsoft", label: "Microsoft Translator" },
  { id: "deeplx-self", label: "Self-hosted DeepLX" },
  { id: "deeplx-public", label: "Public DeepLX" },
  { id: "google", label: "Google Translate" },
  { id: "mymemory", label: "MyMemory" }
];
function isTranslationProviderPreference(value) {
  return value === "auto" || TRANSLATION_PROVIDERS.some((provider) => provider.id === value);
}
function createWebTextUnitKey(unit) {
  return JSON.stringify([
    unit.anchor.parentSelector,
    unit.anchor.textNodeIndex,
    unit.anchor.shadowPath ?? [],
    unit.anchor.semanticAttribute ?? "",
    unit.anchor.sourceFingerprint,
    unit.sourceText
  ]);
}
function isWebImageKind(value) {
  return value === "img" || value === "canvas" || value === "background";
}
function isWebImageOverlayPlacement(value) {
  return value === "below" || value === "overlay";
}
const BLOCK_TAGS = /* @__PURE__ */ new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "button",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul"
]);
const IGNORED_TAGS = /* @__PURE__ */ new Set(["script", "style", "template", "svg", "noscript", "canvas"]);
function normalizeWebText(value) {
  return value.replace(/\s+/gu, " ").trim();
}
function shortHash$1(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function escapeCssAttribute(value) {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}
function formatWebElementPath(elementPath) {
  return elementPath.map((segment) => {
    const tag = segment.tag.toLowerCase();
    return tag === "html" || tag === "body" ? tag : `${tag}:nth-child(${Math.max(1, segment.index)})`;
  }).join(" > ");
}
function createWebTextAnchor(input) {
  const selector = input.id ? `[id="${escapeCssAttribute(input.id)}"]` : input.testId ? `[data-testid="${escapeCssAttribute(input.testId)}"]` : formatWebElementPath(input.elementPath);
  return {
    selector,
    ...input.rect ? { rect: { ...input.rect } } : {},
    textFingerprint: shortHash$1(normalizeWebText(input.text ?? ""))
  };
}
function createWebTextNodeAnchor(input) {
  return {
    parentSelector: input.parentSelector,
    textNodeIndex: Math.max(0, Math.floor(input.textNodeIndex)),
    sourceFingerprint: shortHash$1(input.sourceText),
    ...input.shadowPath !== void 0 ? { shadowPath: [...input.shadowPath] } : {},
    ...input.semanticAttribute ? { semanticAttribute: input.semanticAttribute } : {}
  };
}
function blockTypeForTag(tag, roles) {
  if (/^h[1-6]$/u.test(tag)) return "heading";
  if (tag === "p" || tag === "blockquote" || tag === "pre") return "paragraph";
  if (tag === "li" || tag === "dt" || tag === "dd") return "list-item";
  if (tag === "button") return "button";
  if (tag === "nav" || roles.includes("navigation") || roles.includes("menu")) return "navigation";
  if (tag === "footer" || roles.includes("contentinfo")) return "footer";
  return "other";
}
function collectInlineText(node2) {
  let rawText = "";
  let linkTextLength = 0;
  function visit(current, insideLink, root) {
    if (current.visible === false) return;
    if (current.kind === "text") {
      const value = current.text ?? "";
      rawText += value;
      if (insideLink) linkTextLength += normalizeWebText(value).length;
      return;
    }
    const tag = (current.tag ?? "").toLowerCase();
    if (IGNORED_TAGS.has(tag) || !root && BLOCK_TAGS.has(tag)) return;
    const linked = insideLink || tag === "a";
    for (const child of current.children) visit(child, linked, false);
  }
  visit(node2, false, true);
  return { rawText, linkTextLength };
}
function classifyWebTextBlock(input) {
  const tags = input.ancestorTags.map((tag) => tag.toLowerCase());
  const roles = input.ancestorRoles.map((role) => role.toLowerCase());
  const length = normalizeWebText(input.text).length;
  const linkDensity = input.linkTextLength / Math.max(1, length);
  let score = 0;
  if (tags.some((tag) => tag === "main" || tag === "article" || tag === "p")) score += 3;
  if (roles.includes("main") || roles.includes("article")) score += 3;
  if (input.type === "heading" || input.type === "paragraph") score += 2;
  if (length >= 20) score += 2;
  if (length >= 80) score += 1;
  if (input.textDensity >= 0.65) score += 1;
  if (tags.some((tag) => tag === "nav" || tag === "aside" || tag === "footer" || tag === "header")) score -= 3;
  if (roles.some((role) => role === "navigation" || role === "menu" || role === "banner" || role === "contentinfo")) score -= 4;
  if (input.type === "button" || input.type === "navigation" || input.type === "footer") score -= 3;
  if (length < 12) score -= 2;
  if (linkDensity >= 0.5) score -= 3;
  if (input.textDensity < 0.4) score -= 2;
  return score >= 2 ? "body" : "isolated";
}
function extractWebTextBlocks(snapshot, pageMeta) {
  const blocks = [];
  const units = [];
  function visit(node2, path, ancestorTags, ancestorRoles) {
    if (node2.visible === false || node2.kind !== "element") return;
    const tag = (node2.tag ?? "div").toLowerCase();
    if (IGNORED_TAGS.has(tag)) return;
    const roles = node2.role ? [...ancestorRoles, node2.role.toLowerCase()] : ancestorRoles;
    const tags = [...ancestorTags, tag];
    for (const semantic of node2.semanticTexts ?? []) {
      const sourceText = semantic.text;
      const text = normalizeWebText(sourceText);
      if (!text) continue;
      const parentSelector = node2.shadowPath !== void 0 ? node2.shadowHostSelector : node2.selector ?? (node2.id ? `[id="${escapeCssAttribute(node2.id)}"]` : void 0);
      if (!parentSelector) continue;
      const type = tag === "button" ? "button" : "other";
      const blockId = `web-${shortHash$1(`${parentSelector}|${semantic.attribute}|${text}|${blocks.length}`)}`;
      blocks.push({
        id: blockId,
        text,
        type,
        category: "isolated",
        anchor: {
          selector: parentSelector,
          ...node2.rect ? { rect: { ...node2.rect } } : {},
          textFingerprint: shortHash$1(text)
        },
        ancestorTags: tags,
        ancestorRoles: roles,
        linkTextLength: 0,
        textDensity: text.length / Math.max(1, sourceText.length),
        ...pageMeta.langHint ? { language: pageMeta.langHint } : {}
      });
      units.push({
        id: `${blockId}:unit-${units.length}`,
        blockId,
        sourceText,
        text,
        anchor: createWebTextNodeAnchor({
          parentSelector,
          textNodeIndex: 0,
          sourceText,
          ...node2.shadowPath !== void 0 ? { shadowPath: node2.shadowPath } : {},
          semanticAttribute: semantic.attribute
        }),
        category: "isolated",
        ...pageMeta.langHint ? { language: pageMeta.langHint } : {}
      });
    }
    if (BLOCK_TAGS.has(tag)) {
      const collected = collectInlineText(node2);
      const normalized = normalizeWebText(collected.rawText);
      if (normalized) {
        const type = blockTypeForTag(tag, roles);
        const textDensity = normalizeWebText(collected.rawText).length / Math.max(1, collected.rawText.length);
        const anchor = createWebTextAnchor({
          id: node2.id,
          testId: node2.testId,
          elementPath: path,
          rect: node2.rect,
          text: normalized
        });
        const category = classifyWebTextBlock({
          text: normalized,
          type,
          ancestorTags: tags,
          ancestorRoles: roles,
          linkTextLength: collected.linkTextLength,
          textDensity
        });
        const blockId = `web-${shortHash$1(`${anchor.selector}|${normalized}|${blocks.length}`)}`;
        blocks.push({
          id: blockId,
          text: normalized,
          type,
          category,
          anchor,
          ancestorTags: tags,
          ancestorRoles: roles,
          linkTextLength: collected.linkTextLength,
          textDensity,
          ...pageMeta.langHint ? { language: pageMeta.langHint } : {}
        });
        const collectUnits = (current, currentPath, parentSelector, shadowPath, root) => {
          if (current.visible === false) return;
          if (current.kind === "text") {
            const sourceText = current.text ?? "";
            const text = normalizeWebText(sourceText);
            if (!text) return;
            const nodeAnchor = createWebTextNodeAnchor({
              parentSelector,
              textNodeIndex: current.textNodeIndex ?? 0,
              sourceText,
              ...shadowPath !== void 0 ? { shadowPath } : {}
            });
            units.push({
              id: `${blockId}:unit-${units.length}`,
              blockId,
              sourceText,
              text,
              anchor: nodeAnchor,
              category,
              ...pageMeta.langHint ? { language: pageMeta.langHint } : {}
            });
            return;
          }
          const childTag = (current.tag ?? "").toLowerCase();
          if (!root && (IGNORED_TAGS.has(childTag) || BLOCK_TAGS.has(childTag))) return;
          const contentParentSelector = current.shadowRoot ? current.shadowHostSelector ?? current.selector ?? parentSelector : current.shadowPath !== void 0 ? current.shadowHostSelector ?? parentSelector : current.selector ?? parentSelector;
          const contentShadowPath = current.shadowRoot ? [] : current.shadowPath !== void 0 ? current.shadowPath : shadowPath;
          let elementIndex2 = 0;
          for (const child of current.children) {
            if (child.kind === "element") {
              elementIndex2 += 1;
              const childPath = [...currentPath, { tag: (child.tag ?? "div").toLowerCase(), index: elementIndex2 }];
              const childSelector = child.shadowPath !== void 0 ? child.shadowHostSelector ?? contentParentSelector : child.selector ?? formatWebElementPath(childPath);
              collectUnits(
                child,
                childPath,
                childSelector,
                child.shadowPath !== void 0 ? child.shadowPath : contentShadowPath,
                false
              );
            } else {
              collectUnits(child, currentPath, contentParentSelector, contentShadowPath, false);
            }
          }
        };
        collectUnits(
          node2,
          path,
          node2.shadowPath !== void 0 ? node2.shadowHostSelector ?? anchor.selector : node2.selector ?? anchor.selector,
          node2.shadowPath,
          true
        );
      }
    }
    let elementIndex = 0;
    for (const child of node2.children) {
      if (child.kind !== "element") continue;
      elementIndex += 1;
      const childTag = (child.tag ?? "div").toLowerCase();
      visit(child, [...path, { tag: childTag, index: elementIndex }], tags, roles);
    }
  }
  const rootTag = (snapshot.tag ?? "body").toLowerCase();
  visit(snapshot, [{ tag: rootTag, index: 1 }], [], []);
  return { blocks, units, pageMeta: { ...pageMeta } };
}
const SETTINGS_SCHEMA_VERSION = 20;
const DEFAULT_SETTINGS = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  uiLocale: "auto",
  themePreset: "sky",
  themeMode: "system",
  targetLang: "auto",
  sourceLang: "auto",
  hotkey: "Alt+T",
  manualTranslationHotkey: "Alt+M",
  webReaderHotkey: "Alt+P",
  autoHideMs: 0,
  deepLxUrl: "",
  triggerMode: "button",
  doubleClickSelectionButtonEnabled: true,
  showDockIcon: false,
  autoLaunch: false,
  proxyMode: "system",
  proxyRules: "",
  proxyBypassRules: "<local>;localhost;127.0.0.1",
  dingTalkEnabled: false,
  dingTalkCorpId: "",
  dingTalkClientId: "",
  dingTalkSecretConfigured: false,
  microsoftEnabled: false,
  aiEnabled: false,
  aiProtocol: "ollama",
  aiBaseUrl: DEFAULT_AI_BASE_URL,
  aiModel: "",
  aiApiKeyConfigured: false,
  preferredTranslationProvider: "auto",
  speechProvider: "system",
  ocrEnginePreference: "auto",
  ocrHotkey: "Alt+O",
  ocrLang: "auto",
  ocrScale: 1,
  ocrTesseractEnabled: true,
  webTranslationEnabled: true,
  webTranslationScope: "all",
  webTranslationMaxBlocks: 1e3,
  webTranslationMaxChars: 5e5,
  webTranslationConcurrency: 3,
  webTranslationDefaultMode: "target",
  webTranslationImageOcrEnabled: true,
  webTranslationImageOcrMaxImages: 30,
  webTranslationImageOcrMinSize: 64,
  webTranslationImageOcrOverlay: "below"
};
function isThemePreset(value) {
  return value === "sakura" || value === "emerald" || value === "sky" || value === "navy" || value === "platinum-black";
}
function isThemeMode(value) {
  return value === "system" || value === "light" || value === "dark";
}
function isTriggerMode(value) {
  return value === "auto" || value === "button" || value === "hotkey";
}
function isProxyMode(value) {
  return value === "system" || value === "direct" || value === "custom";
}
function isSpeechProvider(value) {
  return value === "system" || value === "edge";
}
function isWebTranslationScope(value) {
  return value === "body" || value === "all";
}
function isWebTranslationMode$1(value) {
  return value === "source" || value === "target" || value === "bilingual";
}
function normalizeWebLimit(value, fallback, maximum, minimum = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(numeric)));
}
function normalizeAiBaseUrl$1(baseUrl) {
  return baseUrl.replace(/\/+$/u, "");
}
function normalizeShortcutSetting(value, fallback) {
  if (value === void 0) return fallback;
  if (typeof value !== "string") return fallback;
  return value.trim();
}
function normalizeSettings(rawSettings = {}) {
  const schemaVersion = Number(rawSettings.schemaVersion ?? 1);
  const merged = { ...DEFAULT_SETTINGS, ...rawSettings };
  let triggerMode = isTriggerMode(rawSettings.triggerMode) ? rawSettings.triggerMode : rawSettings.autoTrigger ? "auto" : "button";
  if (schemaVersion < 4) triggerMode = "button";
  const webTranslationMaxBlocks = schemaVersion < 15 && (rawSettings.webTranslationMaxBlocks === void 0 || Number(rawSettings.webTranslationMaxBlocks) === 300) ? DEFAULT_SETTINGS.webTranslationMaxBlocks : normalizeWebLimit(merged.webTranslationMaxBlocks, DEFAULT_SETTINGS.webTranslationMaxBlocks, 5e3);
  const webTranslationMaxChars = schemaVersion < 15 && (rawSettings.webTranslationMaxChars === void 0 || Number(rawSettings.webTranslationMaxChars) === 2e5) ? DEFAULT_SETTINGS.webTranslationMaxChars : normalizeWebLimit(merged.webTranslationMaxChars, DEFAULT_SETTINGS.webTranslationMaxChars, 2e6);
  const webTranslationConcurrency = Number.isFinite(Number(merged.webTranslationConcurrency)) ? Math.min(8, Math.max(1, Math.floor(Number(merged.webTranslationConcurrency)))) : DEFAULT_SETTINGS.webTranslationConcurrency;
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    // 第二十版新增界面语言设置；缺失或非法值统一回退到跟随系统。
    uiLocale: normalizeUiLocale(rawSettings.uiLocale),
    themePreset: isThemePreset(rawSettings.themePreset) ? rawSettings.themePreset : DEFAULT_SETTINGS.themePreset,
    themeMode: isThemeMode(rawSettings.themeMode) ? rawSettings.themeMode : DEFAULT_SETTINGS.themeMode,
    targetLang: schemaVersion < 2 ? "auto" : String(merged.targetLang || "auto"),
    sourceLang: String(merged.sourceLang || "auto"),
    hotkey: String(merged.hotkey || ""),
    // 新增两个独立全局快捷键：缺失时补默认值，显式清空必须原样保留。
    manualTranslationHotkey: normalizeShortcutSetting(
      rawSettings.manualTranslationHotkey,
      DEFAULT_SETTINGS.manualTranslationHotkey
    ),
    webReaderHotkey: normalizeShortcutSetting(
      rawSettings.webReaderHotkey,
      DEFAULT_SETTINGS.webReaderHotkey
    ),
    autoHideMs: schemaVersion < 2 ? 0 : Math.max(0, Number(merged.autoHideMs) || 0),
    deepLxUrl: String(merged.deepLxUrl || "").trim(),
    triggerMode,
    doubleClickSelectionButtonEnabled: merged.doubleClickSelectionButtonEnabled !== false,
    showDockIcon: rawSettings.showDockIcon === true,
    autoLaunch: rawSettings.autoLaunch === true,
    proxyMode: isProxyMode(rawSettings.proxyMode) ? rawSettings.proxyMode : "system",
    proxyRules: String(merged.proxyRules || "").trim(),
    proxyBypassRules: String(merged.proxyBypassRules || "").trim(),
    dingTalkEnabled: rawSettings.dingTalkEnabled === true,
    dingTalkCorpId: String(merged.dingTalkCorpId || "").trim(),
    dingTalkClientId: String(merged.dingTalkClientId || "").trim(),
    dingTalkSecretConfigured: rawSettings.dingTalkSecretConfigured === true,
    microsoftEnabled: rawSettings.microsoftEnabled === true,
    preferredTranslationProvider: isTranslationProviderPreference(
      rawSettings.preferredTranslationProvider
    ) ? rawSettings.preferredTranslationProvider : "auto",
    aiEnabled: rawSettings.aiEnabled === true,
    aiProtocol: isAiProtocol(rawSettings.aiProtocol) ? rawSettings.aiProtocol : "ollama",
    aiBaseUrl: normalizeAiBaseUrl$1(rawSettings.aiBaseUrl === void 0 ? DEFAULT_AI_BASE_URL : String(merged.aiBaseUrl || "").trim()),
    aiModel: String(merged.aiModel || "").trim(),
    aiApiKeyConfigured: rawSettings.aiApiKeyConfigured === true,
    speechProvider: isSpeechProvider(rawSettings.speechProvider) ? rawSettings.speechProvider : "system",
    ocrEnginePreference: isOcrEnginePreference(merged.ocrEnginePreference) ? merged.ocrEnginePreference : "auto",
    ocrHotkey: String(merged.ocrHotkey || "").trim(),
    ocrLang: String(merged.ocrLang || "auto").trim(),
    ocrScale: normalizeOcrScale$1(merged.ocrScale),
    ocrTesseractEnabled: merged.ocrTesseractEnabled !== false,
    webTranslationEnabled: merged.webTranslationEnabled !== false,
    // 第十四版将网页翻译默认范围扩展为全部可见文本，修复导航、按钮和标签遗漏。
    webTranslationScope: schemaVersion < 14 ? "all" : isWebTranslationScope(merged.webTranslationScope) ? merged.webTranslationScope : "all",
    webTranslationMaxBlocks,
    webTranslationMaxChars,
    webTranslationConcurrency,
    // 第十八版把“对照”作为合法模式；更早版本的 bilingual 来自已废弃的侧栏双语语义，迁移为 target。
    webTranslationDefaultMode: schemaVersion < 18 && merged.webTranslationDefaultMode === "bilingual" ? "target" : isWebTranslationMode$1(merged.webTranslationDefaultMode) ? merged.webTranslationDefaultMode : "target",
    // 第十九版新增图片 OCR；仅缺失时使用默认值，用户显式关闭必须保留。
    webTranslationImageOcrEnabled: merged.webTranslationImageOcrEnabled !== false,
    webTranslationImageOcrMaxImages: normalizeWebLimit(
      merged.webTranslationImageOcrMaxImages,
      DEFAULT_SETTINGS.webTranslationImageOcrMaxImages,
      200
    ),
    webTranslationImageOcrMinSize: normalizeWebLimit(
      merged.webTranslationImageOcrMinSize,
      DEFAULT_SETTINGS.webTranslationImageOcrMinSize,
      1024,
      16
    ),
    webTranslationImageOcrOverlay: isWebImageOverlayPlacement(merged.webTranslationImageOcrOverlay) ? merged.webTranslationImageOcrOverlay : "below"
  };
}
let cache = { ...DEFAULT_SETTINGS };
function filePath() {
  return node_path.join(electron.app.getPath("userData"), "settings.json");
}
function persistSettings(settings) {
  const path = filePath();
  const temporaryPath = `${path}.tmp`;
  node_fs.mkdirSync(node_path.dirname(path), { recursive: true });
  node_fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2));
  node_fs.renameSync(temporaryPath, path);
  console.log(`[settings] 已保存到 ${path}`);
}
function getSettings() {
  return cache;
}
function loadSettings() {
  try {
    const path = filePath();
    if (node_fs.existsSync(path)) {
      const raw = JSON.parse(node_fs.readFileSync(path, "utf-8"));
      cache = normalizeSettings(raw);
      if (raw.schemaVersion !== cache.schemaVersion) {
        try {
          persistSettings(cache);
        } catch (error2) {
          console.error("[settings] 迁移后的配置保存失败:", error2.message);
        }
      }
    } else {
      cache = { ...DEFAULT_SETTINGS };
    }
  } catch (error2) {
    console.error("[settings] 读取配置失败，使用默认值:", error2.message);
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}
function saveSettings(patch) {
  const candidate = normalizeSettings({ ...cache, ...patch });
  persistSettings(candidate);
  cache = candidate;
  return cache;
}
const PUBLIC_IP_URLS = [
  "https://api.ipify.org",
  "https://ipv4.icanhazip.com",
  "https://api.my-ip.io/v4/ip"
];
const IP_LOCATION_URLS = [
  // 百度 IP 查询：单字段 location，例如「江苏省南京市 电信」
  (ip) => `https://opendata.baidu.com/api.php?query=${encodeURIComponent(ip)}&co=&resource_id=6006&oe=utf8`,
  // ip-api 免费版仅提供 HTTP，中文字段拆分为国家/省/市/运营商
  (ip) => `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,country,regionName,city,isp`,
  (ip) => `https://ipwho.is/${encodeURIComponent(ip)}`
];
const IPV4_PATTERN = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
const IPV6_PATTERN = /^(?=.*:)[0-9a-f:]+$/iu;
const PUBLIC_IP_TIMEOUT_MS = 5e3;
const IP_LOCATION_TIMEOUT_MS = 5e3;
function isValidIpAddress(value) {
  return IPV4_PATTERN.test(value) || IPV6_PATTERN.test(value);
}
async function resolvePublicIpAddress(fetchImpl = globalThis.fetch) {
  for (const url of PUBLIC_IP_URLS) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS) });
      if (!response.ok) continue;
      const value = (await response.text()).trim();
      if (IPV4_PATTERN.test(value)) return value;
    } catch {
    }
  }
  return null;
}
function firstText(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}
function formatIpLocation(payload) {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload;
  if (Array.isArray(raw.data)) {
    for (const item of raw.data) {
      const location = firstText(item?.location);
      if (location) return location;
    }
    return null;
  }
  if (raw.status === "fail") return null;
  if (raw.success === false) return null;
  const connection = raw.connection ?? {};
  const country = firstText(raw.country, raw.country_name);
  const region = firstText(raw.region, raw.regionName);
  const city = firstText(raw.city);
  const isp = firstText(connection.isp, connection.org, raw.org, raw.isp);
  const parts = [];
  for (const part of [country, region, city, isp]) {
    if (part && parts[parts.length - 1] !== part) parts.push(part);
  }
  return parts.length ? parts.join(" ") : null;
}
async function resolveIpLocation(ip, fetchImpl = globalThis.fetch) {
  if (!isValidIpAddress(ip)) return null;
  for (const buildUrl of IP_LOCATION_URLS) {
    try {
      const response = await fetchImpl(buildUrl(ip), {
        signal: AbortSignal.timeout(IP_LOCATION_TIMEOUT_MS)
      });
      if (!response.ok) continue;
      const location = formatIpLocation(await response.json());
      if (location) return location;
    } catch {
    }
  }
  return null;
}
function localeToIntlTag(locale) {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}
function localeFieldSeparator(locale) {
  return locale === "zh-CN" ? "：" : ": ";
}
function formatLocaleDateTime(date, locale = DEFAULT_LOCALE, options = { dateStyle: "medium", timeStyle: "long" }) {
  return new Intl.DateTimeFormat(localeToIntlTag(locale), options).format(date);
}
function formatLocaleDate(date, locale = DEFAULT_LOCALE) {
  return formatLocaleDateTime(date, locale, { dateStyle: "medium" });
}
function detectMainProcessLocale() {
  let uiLocale = "auto";
  try {
    const settings = require("./settings");
    uiLocale = settings.getSettings().uiLocale;
  } catch {
  }
  return resolveLocale(uiLocale, collectMainProcessLocaleCandidates());
}
function collectMainProcessLocaleCandidates() {
  try {
    const { app } = require("electron");
    return [
      ...app.getPreferredSystemLanguages(),
      app.getSystemLocale(),
      app.getLocale(),
      process.env.LANG,
      process.env.LC_ALL,
      process.env.LC_MESSAGES
    ];
  } catch {
    return [process.env.LANG, process.env.LC_ALL, process.env.LC_MESSAGES];
  }
}
function localToday$1() {
  const now = /* @__PURE__ */ new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
class UsageStatsStore {
  filePath;
  today;
  data;
  /**
   * 创建统计存储并加载磁盘数据；文件损坏时静默重建为空结构。
   * @param options 存储构造选项。
   * @author zhenghq
   */
  constructor(options) {
    this.filePath = options.filePath;
    this.today = options.today ?? localToday$1;
    this.data = this.load();
  }
  /**
   * 记录一次使用，并按两天滚动规则清理过期桶后持久化。
   * @param channel 触发渠道。
   * @param provider 翻译服务提供方标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  recordUsage(channel, provider) {
    const today = this.today();
    const bucket = this.data.days[today] ?? { channels: {}, providers: {} };
    bucket.channels[channel] = (bucket.channels[channel] ?? 0) + 1;
    bucket.providers[provider] = (bucket.providers[provider] ?? 0) + 1;
    this.data.days[today] = bucket;
    this.prune(today);
    this.persist();
  }
  /**
   * 判断当天是否尚未发送过统计上报。
   * @returns 当天未发送时返回 true。
   * @author zhenghq
   */
  shouldReportToday() {
    return this.data.report.lastSentDate !== this.today();
  }
  /**
   * 写入当天已发送标记并持久化，防止当天重复发送。
   * @param date 发送成功的日期（YYYY-MM-DD）。
   * @returns 无返回值。
   * @author zhenghq
   */
  markReportSent(date) {
    this.data.report.lastSentDate = date;
    this.persist();
  }
  /**
   * 获取当前统计快照（只读副本）。
   * @returns 统计数据深拷贝。
   * @author zhenghq
   */
  snapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }
  /**
   * 从磁盘加载统计数据，非法内容静默重建为空结构。
   * @returns 统计数据。
   * @author zhenghq
   */
  load() {
    try {
      if (node_fs.existsSync(this.filePath)) {
        const raw = JSON.parse(node_fs.readFileSync(this.filePath, "utf-8"));
        if (raw && typeof raw === "object" && raw.days && typeof raw.days === "object") {
          return {
            days: raw.days,
            report: { lastSentDate: raw.report?.lastSentDate ?? null }
          };
        }
      }
    } catch {
    }
    return { days: {}, report: { lastSentDate: null } };
  }
  /**
   * 丢弃早于前一天的日期桶。
   * @param today 当天日期（YYYY-MM-DD）。
   * @returns 无返回值。
   * @author zhenghq
   */
  prune(today) {
    const cutoff = /* @__PURE__ */ new Date(`${today}T00:00:00`);
    cutoff.setDate(cutoff.getDate() - 1);
    const month = String(cutoff.getMonth() + 1).padStart(2, "0");
    const day = String(cutoff.getDate()).padStart(2, "0");
    const earliest = `${cutoff.getFullYear()}-${month}-${day}`;
    for (const key of Object.keys(this.data.days)) {
      if (key < earliest) delete this.data.days[key];
    }
  }
  /**
   * 原子写入统计文件；写失败静默忽略，避免影响翻译主流程。
   * @returns 无返回值。
   * @author zhenghq
   */
  persist() {
    try {
      const temporaryPath = `${this.filePath}.tmp`;
      node_fs.mkdirSync(node_path.dirname(this.filePath), { recursive: true });
      node_fs.writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2));
      node_fs.renameSync(temporaryPath, this.filePath);
    } catch {
    }
  }
}
const CHANNEL_KEYS = {
  hotkey: "usage.channel.hotkey",
  selection: "usage.channel.selection",
  screenshot: "usage.channel.screenshot",
  webpage: "usage.channel.webpage"
};
const PROVIDER_KEYS = {
  ai: "usage.provider.ai",
  dingtalk: "usage.provider.dingtalk",
  microsoft: "usage.provider.microsoft",
  google: "usage.provider.google",
  "deeplx-self": "usage.provider.deeplx-self"
};
function resolveUsageTranslator(options) {
  if (options.translator) return options.translator;
  if (options.locale) return createTranslator(options.locale);
  return createTranslator("zh-CN");
}
function formatReportDate(dateText, locale) {
  const date = /* @__PURE__ */ new Date(`${dateText}T00:00:00`);
  return Number.isNaN(date.getTime()) ? dateText : formatLocaleDate(date, locale);
}
function previousDate(today) {
  const date = /* @__PURE__ */ new Date(`${today}T00:00:00`);
  date.setDate(date.getDate() - 1);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
function buildReportBody(stats, environment, today, yesterday, network = {}, translatorOrLocale) {
  const translator = typeof translatorOrLocale === "string" ? createTranslator(translatorOrLocale) : translatorOrLocale ?? createTranslator("zh-CN");
  const separator = localeFieldSeparator(translator.locale);
  const DIVIDER = "============================================================";
  const SUB_DIVIDER = "------------------------------------------------------------";
  const lines = [
    "",
    DIVIDER,
    `                ${translator.t("usage.title")}`,
    DIVIDER,
    "",
    `【 ${translator.t("usage.section.environment")} 】`,
    SUB_DIVIDER,
    `  💻 ${translator.t("usage.platform")}${separator}${environment.platform} (${translator.t("usage.kernel")}${separator}${environment.osRelease})`,
    `  📦 ${translator.t("usage.appVersion")}${separator}${environment.appVersion}`,
    `  🔖 ${translator.t("usage.buildId")}${separator}${environment.buildId}`,
    `  🌐 ${translator.t("usage.ip")}${separator}${network.ip || translator.t("usage.unknown")}`,
    `  📍 ${translator.t("usage.location")}${separator}${network.location || translator.t("usage.unknown")}`,
    "",
    DIVIDER,
    `【 ${translator.t("usage.section.daily")} 】`,
    DIVIDER,
    ""
  ];
  for (const date of [yesterday, today]) {
    const bucket = stats.days[date];
    lines.push(`📅 ${translator.t("usage.date")}${separator}${formatReportDate(date, translator.locale)}`);
    lines.push(SUB_DIVIDER);
    if (!bucket) {
      lines.push(`  ✅ ${translator.t("usage.noRecords")}`);
      lines.push("");
      continue;
    }
    lines.push(`  📝 ${translator.t("usage.channel.title")}${separator}`);
    for (const [channel, count] of Object.entries(bucket.channels)) {
      const channelKey = CHANNEL_KEYS[channel];
      const channelLabel = channelKey ? translator.t(channelKey) : channel;
      lines.push(`    • ${channelLabel}${separator}${translator.plural("usage.count.plural", count)}`);
    }
    lines.push("");
    lines.push(`  🔧 ${translator.t("usage.provider.title")}${separator}`);
    for (const [provider, count] of Object.entries(bucket.providers)) {
      const providerKey = PROVIDER_KEYS[provider];
      const providerLabel = providerKey ? translator.t(providerKey) : provider;
      lines.push(`    • ${providerLabel}${separator}${translator.plural("usage.count.plural", count)}`);
    }
    lines.push("");
  }
  lines.push(DIVIDER);
  lines.push(`  ${translator.t("usage.footer")}`);
  lines.push(DIVIDER);
  lines.push("");
  return lines.join("\n");
}
async function sendUsageReport(options) {
  const { config, stats, environment, network, today, yesterday } = options;
  if (!config.smtpUser || !config.smtpPass || !config.reportTo) return false;
  try {
    const translator = resolveUsageTranslator(options);
    const transporter = options.transporter ?? (options.createTransporter ?? defaultCreateTransporter)(config);
    await transporter.sendMail({
      from: `"${translator.t("usage.brand")}" <${config.smtpUser}>`,
      to: config.reportTo,
      subject: translator.t("usage.subject", { date: formatReportDate(today, translator.locale) }),
      text: buildReportBody(stats, environment, today, yesterday, network, translator)
    });
    return true;
  } catch {
    return false;
  }
}
function defaultCreateTransporter(config) {
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport({
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    auth: { user: config.smtpUser, pass: config.smtpPass },
    connectionTimeout: 15e3,
    socketTimeout: 2e4
  });
}
function loadReportConfig() {
  const empty = { smtpUser: "", smtpPass: "", reportTo: "" };
  try {
    const { app } = require("electron");
    const candidates = [
      node_path.join(app.getAppPath(), "build/usage-report-config.json"),
      node_path.join(process.cwd(), "build/usage-report-config.json")
    ];
    for (const path of candidates) {
      if (node_fs.existsSync(path)) {
        const raw = JSON.parse(node_fs.readFileSync(path, "utf-8"));
        return {
          smtpUser: raw.smtpUser ?? "",
          smtpPass: raw.smtpPass ?? "",
          reportTo: raw.reportTo ?? ""
        };
      }
    }
  } catch {
  }
  return empty;
}
function loadBuildId() {
  try {
    const { app } = require("electron");
    const candidates = [
      node_path.join(app.getAppPath(), "build/build-info.json"),
      node_path.join(process.cwd(), "build/build-info.json")
    ];
    for (const path of candidates) {
      if (node_fs.existsSync(path)) {
        const raw = JSON.parse(node_fs.readFileSync(path, "utf-8"));
        if (raw.buildId) return raw.buildId;
      }
    }
  } catch {
  }
  return "unknown";
}
let store = null;
let hotkeyWindowUntil = 0;
function getStore() {
  if (!store) {
    const { app } = require("electron");
    store = new UsageStatsStore({
      filePath: node_path.join(app.getPath("userData"), "usage-stats.json")
    });
  }
  return store;
}
async function maybeSendUsageReport() {
  try {
    const statsStore = getStore();
    if (!statsStore.shouldReportToday()) return;
    const config = loadReportConfig();
    if (!config.smtpUser || !config.smtpPass || !config.reportTo) return;
    const today = /* @__PURE__ */ new Date();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    const todayString = `${today.getFullYear()}-${month}-${day}`;
    const ip = await resolvePublicIpAddress();
    const translator = createTranslator(detectMainProcessLocale());
    const ok = await sendUsageReport({
      config,
      stats: statsStore.snapshot(),
      environment: {
        platform: process.platform,
        osRelease: node_os.release(),
        appVersion: require("electron").app.getVersion(),
        buildId: loadBuildId()
      },
      network: { ip, location: ip ? await resolveIpLocation(ip) : null },
      today: todayString,
      yesterday: previousDate(todayString),
      translator
    });
    if (ok) statsStore.markReportSent(todayString);
  } catch {
  }
}
function markHotkeyTrigger(windowMs = 1e4) {
  hotkeyWindowUntil = Date.now() + windowMs;
}
function recordTranslationUsage(origin, provider) {
  try {
    let channel = "selection";
    if (origin === "ocr") {
      channel = "screenshot";
    } else if (Date.now() < hotkeyWindowUntil) {
      channel = "hotkey";
      hotkeyWindowUntil = 0;
    }
    getStore().recordUsage(channel, provider ?? "unknown");
    void maybeSendUsageReport();
  } catch {
  }
}
function recordWebPageUsage(provider) {
  try {
    getStore().recordUsage("webpage", provider ?? "unknown");
    void maybeSendUsageReport();
  } catch {
  }
}
function loadInstallNotificationConfig(options) {
  for (const directory of Array.from(new Set(options.getDirectories()))) {
    const configPath = node_path.join(directory, "usage-report-config.json");
    if (options.exists(configPath)) {
      return { config: options.readConfig(configPath), configPath };
    }
  }
  return { config: { smtpUser: "", smtpPass: "", reportTo: "" }, configPath: null };
}
function formatInstallEventTime(now = /* @__PURE__ */ new Date(), locale = "zh-CN") {
  return formatLocaleDateTime(now, locale, {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone: "Asia/Shanghai"
  });
}
function resolveNotificationTranslator(options) {
  if (options.translator) return options.translator;
  if (options.locale) return createTranslator(options.locale);
  return createTranslator("zh-CN");
}
function detectInstallEvent(record, currentVersion) {
  if (!record) {
    return { type: "install", previousVersion: null, currentVersion };
  }
  if (record.version === currentVersion) return null;
  return { type: "upgrade", previousVersion: record.version, currentVersion };
}
function buildInstallEventBody(event, context, translatorOrLocale) {
  const translator = typeof translatorOrLocale === "string" ? createTranslator(translatorOrLocale) : translatorOrLocale ?? createTranslator("zh-CN");
  const separator = localeFieldSeparator(translator.locale);
  const DIVIDER = "============================================================";
  const SUB_DIVIDER = "------------------------------------------------------------";
  const eventType = translator.t(event.type === "install" ? "notification.event.install" : "notification.event.upgrade");
  const lines = [
    "",
    DIVIDER,
    `                ${translator.t("notification.title")}`,
    DIVIDER,
    "",
    `【 ${translator.t("notification.section.event")} 】`,
    SUB_DIVIDER,
    `  📌 ${translator.t("notification.event.type")}${separator}${eventType}`,
    `  🔙 ${translator.t("notification.previousVersion")}${separator}${event.previousVersion ?? translator.t("notification.previousVersion.none")}`,
    `  ✅ ${translator.t("notification.currentVersion")}${separator}${event.currentVersion}`,
    `  🕒 ${translator.t("notification.eventTime")}${separator}${context.eventTime}`,
    "",
    `【 ${translator.t("notification.section.environment")} 】`,
    SUB_DIVIDER,
    `  💻 ${translator.t("notification.platform")}${separator}${context.platform} (${translator.t("notification.kernel")}${separator}${context.osRelease})`,
    `  🌐 ${translator.t("notification.ip")}${separator}${context.ip}`,
    `  📍 ${translator.t("notification.location")}${separator}${context.location || translator.t("notification.unknown")}`,
    "",
    DIVIDER,
    `  ${translator.t("notification.footer")}`,
    DIVIDER,
    ""
  ];
  return lines.join("\n");
}
function defaultFilePath() {
  const electron2 = require("electron");
  return `${electron2.app.getPath("userData")}/install-events.json`;
}
function readRecord(path) {
  if (!node_fs.existsSync(path)) return null;
  try {
    const raw = JSON.parse(node_fs.readFileSync(path, "utf8"));
    if (typeof raw.version === "string" && raw.version && typeof raw.confirmedAt === "string") {
      return { version: raw.version, confirmedAt: raw.confirmedAt };
    }
  } catch {
  }
  return null;
}
function writeRecord(path, record) {
  const temporaryPath = `${path}.tmp`;
  node_fs.mkdirSync(node_path.dirname(path), { recursive: true });
  node_fs.writeFileSync(temporaryPath, JSON.stringify(record, null, 2));
  node_fs.renameSync(temporaryPath, path);
}
function createInstallEventService(options) {
  const path = options.filePath ?? defaultFilePath();
  const translator = resolveNotificationTranslator(options);
  const fetchIp = options.fetchIp ?? (async () => {
    try {
      return await resolvePublicIpAddress();
    } catch {
      return null;
    }
  });
  const fetchLocation = options.fetchLocation ?? (async (ip) => {
    try {
      return await resolveIpLocation(ip);
    } catch {
      return null;
    }
  });
  return {
    /**
     * 读取当前事件确认记录。
     * @returns 已确认记录或 null。
     * @author zhenghq
     */
    readRecord() {
      return readRecord(path);
    },
    /**
     * 判定并发送当前启动事件；成功后确认当前版本。
     * @param currentVersion 当前应用版本。
     * @returns 发送成功返回 true；无事件返回 false。
     * @author zhenghq
     */
    async processLaunch(currentVersion) {
      const event = detectInstallEvent(readRecord(path), currentVersion);
      if (!event) return false;
      const ip = await fetchIp();
      if (!ip) throw new Error(translator.t("notification.ipUnavailable"));
      const location = await fetchLocation(ip);
      const transporter = options.transporter ?? require("nodemailer").createTransport({
        host: "smtp.qq.com",
        port: 465,
        secure: true,
        auth: { user: options.config.smtpUser, pass: options.config.smtpPass },
        connectionTimeout: 15e3,
        socketTimeout: 2e4
      });
      try {
        await transporter.sendMail({
          from: `"${translator.t("notification.brand")}" <${options.config.smtpUser}>`,
          to: options.config.reportTo,
          subject: translator.t(event.type === "install" ? "notification.install.subject" : "notification.upgrade.subject", { version: event.currentVersion }),
          text: buildInstallEventBody(event, { ...options.environment, ip, location }, translator)
        });
      } catch (error2) {
        throw error2;
      }
      writeRecord(path, {
        version: currentVersion,
        confirmedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      return true;
    }
  };
}
async function maybeSendInstallUpgradeNotification() {
  try {
    const electron2 = require("electron");
    const translator = createTranslator(detectMainProcessLocale());
    const { config, configPath: resolvedConfigPath } = loadInstallNotificationConfig({
      getDirectories: () => [
        node_path.join(electron2.app.getAppPath(), "build"),
        electron2.app.getAppPath(),
        node_path.join(process.cwd(), "build"),
        process.cwd()
      ],
      exists: node_fs.existsSync,
      readConfig: (path) => JSON.parse(node_fs.readFileSync(path, "utf8"))
    });
    if (!resolvedConfigPath) return false;
    if (!config.smtpUser || !config.smtpPass || !config.reportTo) return false;
    const eventTime = formatInstallEventTime(/* @__PURE__ */ new Date(), translator.locale);
    const service = createInstallEventService({
      config,
      environment: {
        platform: process.platform,
        osRelease: node_os.release(),
        eventTime
      },
      translator
    });
    return await service.processLaunch(electron2.app.getVersion());
  } catch {
    return false;
  }
}
const MESSAGE_MAX_LENGTH = 2048;
const LOG_BUFFER_CAPACITY = 2e3;
function serializeValue(value) {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return node_util.inspect(value, { depth: 4, breakLength: 120 });
  } catch {
    return String(value);
  }
}
function formatLogMessage(args) {
  const message = args.map(serializeValue).join(" ");
  return message.length > MESSAGE_MAX_LENGTH ? `${message.slice(0, MESSAGE_MAX_LENGTH)}…` : message;
}
function parseLogFileDate(fileName2) {
  const match = /^main-(\d{4}-\d{2}-\d{2})\.log$/u.exec(fileName2);
  return match ? match[1] : null;
}
function currentLogDate(now = /* @__PURE__ */ new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function createAppLogger(options) {
  const { logDir, hookConsole = true, now = () => /* @__PURE__ */ new Date() } = options;
  const buffer = [];
  const listeners = /* @__PURE__ */ new Set();
  let currentDate = currentLogDate(now());
  let fileDisabled = false;
  let pending = [];
  let flushScheduled = false;
  function ensureStream() {
    const today = currentLogDate(now());
    if (today === currentDate && !fileDisabled) return;
    currentDate = today;
    if (fileDisabled) return;
    try {
      node_fs.mkdirSync(logDir, { recursive: true });
    } catch {
      fileDisabled = true;
    }
  }
  function cleanupOldLogs() {
    try {
      const today = currentLogDate(now());
      for (const file of node_fs.readdirSync(logDir)) {
        const date = parseLogFileDate(file);
        if (date !== null && date < today) node_fs.rmSync(node_path.join(logDir, file), { force: true });
      }
    } catch {
    }
  }
  function flushPending() {
    flushScheduled = false;
    if (pending.length === 0 || listeners.size === 0) {
      pending = [];
      return;
    }
    const batch = pending;
    pending = [];
    for (const listener of listeners) listener(batch);
  }
  try {
    node_fs.mkdirSync(logDir, { recursive: true });
  } catch {
    fileDisabled = true;
  }
  cleanupOldLogs();
  ensureStream();
  const logger = {
    append(level, args, scope = "main") {
      const entry = {
        ts: now().toISOString(),
        level,
        scope,
        message: formatLogMessage(args)
      };
      buffer.push(entry);
      if (buffer.length > LOG_BUFFER_CAPACITY) buffer.shift();
      ensureStream();
      try {
        if (!fileDisabled) {
          node_fs.appendFileSync(
            node_path.join(logDir, `main-${currentDate}.log`),
            `[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}
`,
            "utf8"
          );
        }
      } catch {
        fileDisabled = true;
      }
      if (listeners.size > 0) {
        pending.push(entry);
        if (!flushScheduled) {
          flushScheduled = true;
          queueMicrotask(flushPending);
        }
      }
      return entry;
    },
    getHistory() {
      return buffer.slice();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getLogFilePath() {
      return node_path.join(logDir, `main-${currentDate}.log`);
    },
    dispose() {
      listeners.clear();
      restoreConsole();
    }
  };
  const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };
  function restoreConsole() {
    if (!hookConsole) return;
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
  if (hookConsole) {
    console.log = (...args) => {
      logger.append("log", args);
      originalConsole.log(...args);
    };
    console.info = (...args) => {
      logger.append("info", args);
      originalConsole.info(...args);
    };
    console.warn = (...args) => {
      logger.append("warn", args);
      originalConsole.warn(...args);
    };
    console.error = (...args) => {
      logger.append("error", args);
      originalConsole.error(...args);
    };
  }
  return logger;
}
let currentTranslator = createTranslator("en-US");
function setMainMessageTranslator(translator) {
  currentTranslator = translator;
}
function translateMain(key, params) {
  return currentTranslator.t(key, params);
}
function createMainI18nRuntime(options) {
  const listeners = /* @__PURE__ */ new Set();
  let locale = resolveLocale(
    options.getUiLocale(),
    collectLocaleCandidates(options.localeSources)
  );
  let translator = createTranslator(locale);
  setMainMessageTranslator(translator);
  function notify(nextLocale) {
    options.onLocaleChanged?.(nextLocale);
    for (const listener of listeners) listener(nextLocale);
  }
  return {
    get locale() {
      return locale;
    },
    get translator() {
      return translator;
    },
    refresh() {
      const nextLocale = resolveLocale(
        options.getUiLocale(),
        collectLocaleCandidates(options.localeSources)
      );
      if (nextLocale === locale) return locale;
      locale = nextLocale;
      translator = createTranslator(locale);
      setMainMessageTranslator(translator);
      notify(locale);
      return locale;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
function collectLocaleCandidates(sources = {}) {
  const env = sources.env ?? {};
  return [
    ...sources.preferredSystemLanguages ?? [],
    sources.systemLocale,
    sources.appLocale,
    env.LANG,
    env.LC_ALL,
    env.LC_MESSAGES
  ];
}
const SYNTHETIC_COPY_OBSERVATION_TIMEOUT_MS = 120;
function hasClipboardCaptureCompleted(currentText, hasImage, sentinel) {
  return hasImage || Boolean(currentText && currentText !== sentinel);
}
function resolveCapturedClipboardState(polled, settled, sentinel) {
  const normalize = (state, status) => ({
    text: state.text && state.text !== sentinel ? state.text : "",
    hasImage: state.hasImage,
    status
  });
  if (hasClipboardCaptureCompleted(polled.text, polled.hasImage, sentinel)) {
    return normalize(polled, "polled");
  }
  if (hasClipboardCaptureCompleted(settled.text, settled.hasImage, sentinel)) {
    return normalize(settled, "late");
  }
  return { text: "", hasImage: false, status: "timeout" };
}
function isCopyShortcut(accelerator) {
  const normalized = accelerator.replace(/\s+/gu, "").toLowerCase();
  const parts = normalized.split("+");
  if (parts.length !== 2 || !parts.includes("c")) return false;
  const modifier = parts.find((part) => part !== "c") ?? "";
  return (/* @__PURE__ */ new Set([
    "ctrl",
    "control",
    "cmd",
    "command",
    "commandorcontrol",
    "cmdorctrl"
  ])).has(modifier);
}
function shouldRestoreClipboard(externalCopyObserved, currentText, sentinel, currentHasImage = false, capturedText) {
  if (!hasClipboardCaptureCompleted(currentText, currentHasImage, sentinel)) return true;
  if (externalCopyObserved) return false;
  if (capturedText !== void 0 && !currentHasImage && currentText !== capturedText) return false;
  return true;
}
function shouldRestoreClipboardAfterAbort(externalCopyObserved) {
  return !externalCopyObserved;
}
class CopyShortcutGuard {
  externalCopyVersion = 0;
  nextExpectationId = 0;
  pendingSyntheticCopies = /* @__PURE__ */ new Map();
  /**
   * 返回当前用户复制事件版本号。
   * @returns 当前用户复制事件版本号。
   * @author zhenghq
   */
  getExternalCopyVersion() {
    return this.externalCopyVersion;
  }
  /**
   * 标记即将发送一次内部模拟复制按键，供全局键盘监听排除该事件。
   * @returns 可用于结束本次观测窗口的句柄。
   * @author zhenghq
   */
  expectSyntheticCopyShortcut() {
    const expectationId = ++this.nextExpectationId;
    const pending = { observed: false };
    this.pendingSyntheticCopies.set(expectationId, pending);
    return {
      finish: async () => {
        const active = this.pendingSyntheticCopies.get(expectationId);
        if (!active) return;
        if (active.observed) {
          this.pendingSyntheticCopies.delete(expectationId);
          return;
        }
        if (!active.finishPromise) {
          active.finishPromise = new Promise((resolve) => {
            active.resolveFinish = resolve;
            active.timeout = setTimeout(() => {
              this.pendingSyntheticCopies.delete(expectationId);
              resolve();
            }, SYNTHETIC_COPY_OBSERVATION_TIMEOUT_MS);
          });
        }
        await active.finishPromise;
      }
    };
  }
  /**
   * 记录一次全局复制快捷键；优先消费内部模拟事件，否则记为用户主动复制。
   * @returns 用户主动复制返回 true，内部模拟复制返回 false。
   * @author zhenghq
   */
  observeCopyShortcut() {
    const syntheticEntry = [...this.pendingSyntheticCopies.entries()].find(([, pending]) => !pending.observed);
    if (syntheticEntry) {
      const [expectationId, pending] = syntheticEntry;
      pending.observed = true;
      if (pending.timeout) clearTimeout(pending.timeout);
      if (pending.resolveFinish) {
        this.pendingSyntheticCopies.delete(expectationId);
        pending.resolveFinish();
      }
      return false;
    }
    this.externalCopyVersion += 1;
    return true;
  }
  /**
   * 判断指定版本之后是否发生过用户主动复制。
   * @param version 取词开始前记录的用户复制事件版本号。
   * @returns 指定版本之后是否发生过用户主动复制。
   * @author zhenghq
   */
  hasExternalCopySince(version) {
    return this.externalCopyVersion !== version;
  }
}
class SelectionInteractionController {
  state = "idle";
  token = 0;
  /**
   * 开始展示选区按钮并创建新一轮交互 token。
   * @returns 新建的交互 token。
   * @author zhenghq
   */
  showButton() {
    this.token += 1;
    this.state = "button-visible";
    return this.token;
  }
  /**
   * 取得按钮取词流程的唯一所有权。
   * @returns 当前 token；状态不允许开始取词时返回 null。
   * @author zhenghq
   */
  beginButtonCapture() {
    if (this.state !== "button-visible") return null;
    this.state = "capturing";
    return this.token;
  }
  /**
   * 开始一次自动翻译流程并创建新的交互 token。
   * @returns 新建的交互 token。
   * @author zhenghq
   */
  beginTranslation() {
    this.token += 1;
    this.state = "translating";
    return this.token;
  }
  /**
   * 开始 OCR 框选交互并创建新的交互 token。
   * @returns 新建的交互 token。
   * @author zhenghq
   */
  beginOcrSelection() {
    this.token += 1;
    this.state = "ocr-selecting";
    return this.token;
  }
  /**
   * 判断指定 token 是否仍拥有当前交互流程。
   * @param token 待检查的交互 token。
   * @returns token 仍有效时返回 true。
   * @author zhenghq
   */
  isCurrent(token) {
    return token === this.token;
  }
  /**
   * 将当前 token 转换到指定状态。
   * @param token 当前流程 token。
   * @param state 目标状态。
   * @returns 转换成功时返回 true。
   * @author zhenghq
   */
  transition(token, state) {
    if (!this.isCurrent(token)) return false;
    this.state = state;
    return true;
  }
  /**
   * 释放当前 token 的流程所有权并回到空闲状态。
   * @param token 待释放的流程 token。
   * @returns 释放成功时返回 true。
   * @author zhenghq
   */
  release(token) {
    if (!this.isCurrent(token)) return false;
    this.state = "idle";
    return true;
  }
  /**
   * 使当前流程失效并回到空闲状态。
   * @returns 新的失效 token。
   * @author zhenghq
   */
  invalidate() {
    this.token += 1;
    this.state = "idle";
    return this.token;
  }
  /**
   * 使普通选区流程失效，但不打断当前独占鼠标事件的 OCR 框选流程。
   * @returns 普通流程被失效时返回新 token；OCR 正在进行时返回 null。
   * @author zhenghq
   */
  invalidateSelectionFlow() {
    if (this.state === "ocr-selecting") return null;
    return this.invalidate();
  }
  /**
   * 返回当前选区交互状态快照。
   * @returns 当前状态和 token。
   * @author zhenghq
   */
  snapshot() {
    return { state: this.state, token: this.token };
  }
}
function classifySelectionPointerDown(context) {
  if (context.ocrActive || context.selectionButtonHit) return "consume";
  if (context.popupHit || context.focusedOwnWindowHit) return "ignore";
  return "track";
}
function resolvePointerDownTracking(result, point, observedAt, hasModifier) {
  if (result !== "track") return { downAt: null, modifiersHeld: false };
  if (hasModifier) return { downAt: null, modifiersHeld: true };
  return {
    downAt: { x: point.x, y: point.y, time: observedAt },
    modifiersHeld: false
  };
}
function resetPointerTrackingForWindowBlur(state, windowBounds) {
  if (!state.downAt || !isPointInsideBounds(state.downAt, windowBounds)) return state;
  return { downAt: null, modifiersHeld: false };
}
function canTreatActivateAsDockLaunch(context) {
  const now = context.now ?? Date.now();
  const checks = {
    selectionInteractionActive: context.interactionState !== "idle",
    selectionButtonVisible: context.selectionButtonVisible,
    popupVisible: context.popupVisible,
    hiServicesRepairRunning: context.hiServicesRepairRunning,
    ocrVisible: context.ocrVisible,
    listenerPausedForOcr: context.listenerPausedForOcr,
    selectionActivationSuppressed: Boolean(
      context.selectionActivationSuppressUntil && context.selectionActivationSuppressUntil > now
    )
  };
  const blockers = [
    [checks.selectionInteractionActive, "selection-interaction-active"],
    [checks.selectionButtonVisible, "selection-button-visible"],
    [checks.popupVisible, "translation-popup-visible"],
    [checks.hiServicesRepairRunning, "hiservices-repair-running"],
    [checks.ocrVisible, "ocr-selection-visible"],
    [checks.listenerPausedForOcr, "ocr-listener-paused"],
    [checks.selectionActivationSuppressed, "selection-activation-suppressed"]
  ];
  const blocked = blockers.find(([active]) => active);
  return blocked ? { allowed: false, reason: blocked[1], checks } : { allowed: true, checks };
}
const DOUBLE_CLICK_MAX_INTERVAL_MS = 250;
const DOUBLE_CLICK_MAX_DRIFT_PX = 12;
const CLICK_MAX_SELF_TRAVEL_PX = 4;
function isPrimaryMouseButton(button) {
  if (button === void 0 || button === null) return true;
  return button === 1;
}
function normalizeReportedClicks(clicks) {
  if (clicks === void 0 || clicks === null) return 1;
  if (!Number.isFinite(clicks) || clicks <= 1) return 1;
  return Math.max(2, Math.trunc(clicks));
}
function resolveDoubleClickSequence(previous, current) {
  const sample = {
    button: current.button,
    travel: current.travel,
    x: current.x,
    y: current.y,
    time: current.time
  };
  if (!(current.travel <= CLICK_MAX_SELF_TRAVEL_PX)) return { clicks: 1, sample: null };
  if (!previous) return { clicks: 1, sample };
  if (!isPrimaryMouseButton(previous.button) || !isPrimaryMouseButton(current.button)) {
    return { clicks: 1, sample };
  }
  if (!(previous.travel <= CLICK_MAX_SELF_TRAVEL_PX)) return { clicks: 1, sample };
  const interval = current.time - previous.time;
  if (!(interval >= 0) || interval >= DOUBLE_CLICK_MAX_INTERVAL_MS) return { clicks: 1, sample };
  const dx = current.x - previous.x;
  const dy = current.y - previous.y;
  if (Math.sqrt(dx * dx + dy * dy) > DOUBLE_CLICK_MAX_DRIFT_PX) return { clicks: 1, sample };
  return { clicks: 2, sample };
}
function createObservedPointerSample(point, observedAt) {
  return { x: point.x, y: point.y, time: observedAt };
}
const WINDOWS_POINTER_DRIFT_TOLERANCE = 24;
function resolveWindowsPointerPoint(rawPoint, convertedPoint, cursorPoint) {
  const rawDx = rawPoint.x - cursorPoint.x;
  const rawDy = rawPoint.y - cursorPoint.y;
  const rawDrift = Math.sqrt(rawDx * rawDx + rawDy * rawDy);
  const convertedDx = convertedPoint.x - cursorPoint.x;
  const convertedDy = convertedPoint.y - cursorPoint.y;
  const convertedDrift = Math.sqrt(convertedDx * convertedDx + convertedDy * convertedDy);
  const candidate = rawDrift <= convertedDrift ? { point: rawPoint, drift: rawDrift } : { point: convertedPoint, drift: convertedDrift };
  return candidate.drift <= WINDOWS_POINTER_DRIFT_TOLERANCE ? candidate.point : cursorPoint;
}
function isPointInsideBounds(point, bounds) {
  if (!bounds) return false;
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}
function isSelectionGestureInsideOwnWindows(gesture, windowBounds) {
  return windowBounds.some(
    (bounds) => isPointInsideBounds(gesture.start, bounds) || isPointInsideBounds(gesture.end, bounds)
  );
}
function resolveSelectionCaptureFailureMessage(reason, hasImage = false, locale = "en-US") {
  const translator = typeof locale === "string" ? createTranslator(locale) : locale;
  if (hasImage) return translator.t("selection.captureFailure.imageOnly");
  switch (reason) {
    case "timeout":
      return translator.t("selection.captureFailure.timeout");
    case "unsupported":
      return translator.t("selection.captureFailure.unsupported");
    case "permission":
      return translator.t("selection.captureFailure.permission");
    case "clipboard-locked":
      return translator.t("selection.captureFailure.clipboardLocked");
    case "empty":
    default:
      return translator.t("selection.captureFailure.empty");
  }
}
function getSelectionGesture(start, end, clicks = 1) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return {
    start,
    end,
    distance: Math.sqrt(dx * dx + dy * dy),
    durationMs: Math.max(0, end.time - start.time),
    clicks: normalizeReportedClicks(clicks),
    anchor: {
      x: Math.max(start.x, end.x),
      y: Math.min(start.y, end.y)
    }
  };
}
function shouldTriggerSelectionGesture(gesture, clicks, options) {
  if (clicks >= 2) return true;
  if (gesture.distance < options.minDragDistance) return false;
  return gesture.durationMs >= options.minHoldMs && gesture.durationMs <= options.maxHoldMs;
}
function parseNativeSelectionReadOutput(output) {
  const raw = String(output ?? "");
  const normalized = raw.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return { status: "unknown", text: "" };
  const lines = normalized.split("\n");
  const status = (lines[0] ?? "").trim().toUpperCase();
  const text = lines.slice(1).join("\n").trim();
  if (status === "PRESENT") {
    return text ? { status: "present", text } : { status: "empty", text: "" };
  }
  if (status === "EMPTY") return { status: "empty", text: "" };
  if (status === "UNKNOWN") return { status: "unknown", text: "" };
  return { status: "unknown", text: "" };
}
function classifyMacosAxHelperStatus(output) {
  const firstLine = String(output ?? "").replace(/\r\n?/gu, "\n").trim().split("\n")[0]?.trim().toUpperCase();
  if (firstLine === "PRESENT") return "PRESENT";
  if (firstLine === "EMPTY") return "EMPTY";
  if (firstLine === "PERMISSION") return "PERMISSION";
  return "UNKNOWN";
}
function decideSelectionAction(popupVisible, triggerMode) {
  if (triggerMode === "hotkey") return "ignore";
  if (triggerMode === "auto") return "translate";
  return "show-button";
}
function isChineseText(text) {
  const chineseCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latinCount = (text.match(/[A-Za-z]/g) ?? []).length;
  return chineseCount > 0 && chineseCount >= latinCount;
}
function resolveLanguagePair(text, sourcePreference, targetPreference) {
  const sourceLang = sourcePreference || "auto";
  if (targetPreference && targetPreference.toLowerCase() !== "auto") {
    return { sourceLang, targetLang: targetPreference.toUpperCase() };
  }
  const sourceIsChinese = sourceLang.toUpperCase() === "ZH" || sourceLang.toLowerCase() === "auto" && isChineseText(text);
  return {
    sourceLang,
    targetLang: sourceIsChinese ? "EN" : "ZH"
  };
}
const copyShortcutGuard = new CopyShortcutGuard();
function detachAutoTriggerHookListeners(hook, listeners) {
  hook.off("mousedown", listeners.mousedown);
  hook.off("mouseup", listeners.mouseup);
  hook.off("keydown", listeners.keydown);
}
function startAutoTriggerLifecycle(options) {
  const { hook, listeners } = options;
  hook.on("mousedown", listeners.mousedown);
  hook.on("mouseup", listeners.mouseup);
  hook.on("keydown", listeners.keydown);
  try {
    hook.start();
    return true;
  } catch (error2) {
    detachAutoTriggerHookListeners(hook, listeners);
    options.clearCallbackState();
    options.logFailure(error2);
    return false;
  }
}
const DEFAULTS = {
  minDragDistance: 4,
  minHoldMs: 20,
  maxHoldMs: 1e4
};
let running = false;
let callback = null;
let pointerDownCallback = null;
let copyShortcutCallback = null;
let pasteShortcutCallback = null;
let downAt = null;
let modifiersHeld = false;
let lastPrimaryMouseUp = null;
const autoTriggerHook = uiohookNapi.uIOhook;
function resolveMousePoint(e) {
  const point = { x: e.x, y: e.y };
  if (process.platform !== "win32") return point;
  return resolveWindowsPointerPoint(
    point,
    electron.screen.screenToDipPoint(point),
    electron.screen.getCursorScreenPoint()
  );
}
function describeModifiers(e) {
  const parts = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.metaKey) parts.push("meta");
  return parts.length > 0 ? parts.join("+") : "none";
}
function onMouseDown(e) {
  const point = resolveMousePoint(e);
  describeModifiers(e);
  let result = "track";
  try {
    result = pointerDownCallback?.(point, e.button) ?? "track";
  } catch (error2) {
    result = "ignore";
    console.warn("[autoTrigger] 鼠标按下分类异常，本次事件已忽略:", error2);
  }
  if (!isPrimaryMouseButton(e.button)) {
    resetPrimaryClickState();
    modifiersHeld = false;
    downAt = null;
    return;
  }
  const tracking = resolvePointerDownTracking(
    result,
    point,
    Date.now(),
    e.ctrlKey || e.altKey || e.metaKey
  );
  modifiersHeld = tracking.modifiersHeld;
  downAt = tracking.downAt;
}
function resetPrimaryClickState() {
  lastPrimaryMouseUp = null;
}
function onMouseUp(e) {
  const start = downAt;
  downAt = null;
  const heldModifiers = modifiersHeld;
  modifiersHeld = false;
  if (!isPrimaryMouseButton(e.button)) {
    resetPrimaryClickState();
    return;
  }
  if (heldModifiers || !start || !callback) {
    resetPrimaryClickState();
    return;
  }
  const end = createObservedPointerSample(resolveMousePoint(e), Date.now());
  const dragDx = end.x - start.x;
  const dragDy = end.y - start.y;
  const sequence = resolveDoubleClickSequence(lastPrimaryMouseUp, {
    button: e.button,
    travel: Math.sqrt(dragDx * dragDx + dragDy * dragDy),
    x: end.x,
    y: end.y,
    time: end.time
  });
  lastPrimaryMouseUp = sequence.sample;
  const clicks = sequence.clicks;
  const gesture = getSelectionGesture(start, end, clicks);
  if (!shouldTriggerSelectionGesture(gesture, clicks, DEFAULTS)) return;
  console.log(
    `[autoTrigger] 检测到选区 clicks=${clicks} distance=${Math.round(gesture.distance)} duration=${gesture.durationMs}ms button=${e.button ?? 1}`
  );
  callback(gesture);
}
function onKeyDown(e) {
  const hasPrimaryModifier = e.ctrlKey || e.metaKey;
  if (!hasPrimaryModifier || e.altKey || e.shiftKey) return;
  if (e.keycode === uiohookNapi.UiohookKey.C) {
    if (copyShortcutGuard.observeCopyShortcut()) copyShortcutCallback?.();
    return;
  }
  if (e.keycode === uiohookNapi.UiohookKey.V) {
    pasteShortcutCallback?.();
    return;
  }
}
function detachHookListeners() {
  detachAutoTriggerHookListeners(autoTriggerHook, getHookListeners());
}
function getHookListeners() {
  return {
    mousedown: onMouseDown,
    mouseup: onMouseUp,
    keydown: onKeyDown
  };
}
function clearAutoTriggerCallbacks() {
  callback = null;
  pointerDownCallback = null;
  copyShortcutCallback = null;
  pasteShortcutCallback = null;
}
function startAutoTrigger(cb, onPointerDown, onCopyShortcut, onPasteShortcut) {
  stopAutoTrigger();
  callback = cb;
  pointerDownCallback = onPointerDown ?? null;
  copyShortcutCallback = onCopyShortcut ?? null;
  pasteShortcutCallback = onPasteShortcut ?? null;
  const started = startAutoTriggerLifecycle({
    hook: autoTriggerHook,
    listeners: getHookListeners(),
    clearCallbackState: clearAutoTriggerCallbacks,
    logFailure: (error2) => {
      console.warn("[selection-translator] 划词监听启动失败:", error2.message);
    }
  });
  running = started;
  if (started) {
    console.log("[autoTrigger] 划词监听已启动");
    return true;
  }
  return false;
}
function stopAutoTrigger() {
  detachHookListeners();
  if (running) {
    try {
      uiohookNapi.uIOhook.stop();
    } catch {
    }
  }
  running = false;
  clearAutoTriggerCallbacks();
  downAt = null;
  modifiersHeld = false;
  resetPrimaryClickState();
}
function resetAutoTriggerPointerState(blurredWindowBounds) {
  resetPrimaryClickState();
  if (!blurredWindowBounds) {
    downAt = null;
    modifiersHeld = false;
    return;
  }
  const previousStart = downAt;
  const next = resetPointerTrackingForWindowBlur(
    { downAt, modifiersHeld },
    blurredWindowBounds
  );
  downAt = next.downAt;
  modifiersHeld = next.modifiersHeld;
  if (!previousStart) return;
  console.log(
    next.downAt ? "[autoTrigger] 设置窗口失焦发生在外部 mousedown 之后，保留当前划词起点" : "[autoTrigger] 设置窗口失焦，清理窗口内遗留的鼠标按下状态"
  );
}
function isAutoTriggerRunning() {
  return running;
}
function parseMacosAxReaderWindowDiagnostic(stderr) {
  const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : "";
  const match = text.match(/(?:^|\n)\s*WINDOW\s+(exact|fallback|failed)\s+count=(\d+)\s*(?:\n|$)/u);
  if (!match) return {};
  const count = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(count) || count < 0) return {};
  if (match[1] === "exact") {
    return { windowLocate: "exact", windowCount: count, windowMatched: true };
  }
  if (match[1] === "fallback") {
    return { windowLocate: "app-fallback", windowCount: count, windowMatched: false };
  }
  return { windowLocate: "failed", windowCount: count, windowMatched: false };
}
function resolveSelectionCaptureStrategy(platform) {
  if (platform === "darwin") return "macos-command-copy";
  if (platform === "win32") return "windows-control-copy";
  if (platform === "linux") return "linux-primary-selection";
  return "unsupported";
}
function getSelectionCapturePlan(platform) {
  if (platform === "darwin") {
    return {
      nativeRead: "macos-accessibility",
      supportsNativeRead: true,
      copyFallback: true
    };
  }
  if (platform === "win32") {
    return {
      nativeRead: "windows-uia",
      supportsNativeRead: true,
      copyFallback: true
    };
  }
  if (platform === "linux") {
    return {
      nativeRead: "linux-primary-selection",
      supportsNativeRead: true,
      copyFallback: false
    };
  }
  return {
    nativeRead: "unsupported",
    supportsNativeRead: false,
    copyFallback: false
  };
}
function shouldPrefetchSelectionForButton(platform) {
  return true;
}
function encodeNativeReaderRequest(request) {
  return JSON.stringify(request) + "\n";
}
function parseNativeReaderResponseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const raw = JSON.parse(trimmed);
    if (typeof raw.id !== "number") return null;
    if (raw.status !== "present" && raw.status !== "empty" && raw.status !== "unknown") {
      return null;
    }
    const response = { id: raw.id, status: raw.status };
    if (typeof raw.text === "string") response.text = raw.text;
    if (typeof raw.reason === "string") response.reason = raw.reason;
    return response;
  } catch {
    return null;
  }
}
const NATIVE_READER_REQUEST_TIMEOUT_MS = 1500;
class NativeReaderRequestMatcher {
  pending = /* @__PURE__ */ new Map();
  /** 当前待定请求数量。 */
  get pendingCount() {
    return this.pending.size;
  }
  /**
   * 登记一个待定请求，返回等待其响应的 Promise。
   * @param id 请求标识。
   * @param timeoutMs 超时时间（毫秒）；超时后以 timeout 错误拒绝。
   * @returns 等待配对的 Promise。
   * @author zhenghq
   */
  track(id, timeoutMs = NATIVE_READER_REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`native reader request ${id} timeout`));
      }, timeoutMs);
      this.pending.set(id, entry);
    });
  }
  /**
   * 用 helper 的一行响应配对待定请求；未知 id 直接忽略。
   * @param response 已解析的 helper 响应。
   * @returns 无返回值。
   * @author zhenghq
   */
  resolve(response) {
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    if (entry.timer) clearTimeout(entry.timer);
    const result = { status: response.status };
    if (response.text !== void 0) result.text = response.text;
    if (response.reason !== void 0) result.reason = response.reason;
    entry.resolve(result);
  }
  /**
   * helper 崩溃或退出时拒绝全部待定请求。
   * @param error 拒绝原因。
   * @returns 无返回值。
   * @author zhenghq
   */
  rejectAll(error2) {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error2);
    }
    this.pending.clear();
  }
}
const NATIVE_READER_RESTART_AFTER_TIMEOUTS = 3;
const NATIVE_READER_IDLE_TIMEOUT_MS = 5 * 60 * 1e3;
function resolveWindowsUiaReaderPath(resourcesPath) {
  const candidates = [
    resourcesPath ? node_path.join(resourcesPath, "windows-uia-reader.exe") : null,
    node_path.join(__dirname, "..", "..", "helpers", "windows-uia-reader", "windows-uia-reader.exe"),
    node_path.join(process.cwd(), "helpers", "windows-uia-reader", "windows-uia-reader.exe")
  ].filter((candidate) => Boolean(candidate));
  return candidates.find((candidate) => node_fs.existsSync(candidate)) ?? null;
}
function resolveMacosAxReaderPath(options) {
  const fileExists = options?.fileExists ?? node_fs.existsSync;
  const cwd = options?.cwd ?? process.cwd();
  const resourcesPath = options?.resourcesPath;
  const candidates = [
    resourcesPath ? node_path.join(resourcesPath, "macos-ax-reader") : null,
    node_path.join(cwd, "build", "macos-ax-reader")
  ].filter((candidate) => Boolean(candidate));
  return candidates.find((candidate) => fileExists(candidate)) ?? null;
}
class NativeReaderHost {
  child = null;
  /** 标记下一次 exit 为宿主主动终止（重启/空闲回收），不触发会话禁用。 */
  suppressNextExit = false;
  matcher = new NativeReaderRequestMatcher();
  nextRequestId = 1;
  stdoutBuffer = "";
  consecutiveTimeouts = 0;
  /** 哨兵 -1 表示尚未发生过任何活动，避免与 now() 返回 0 冲突。 */
  lastActivityAt = -1;
  disabled = false;
  restarting = null;
  spawnFn;
  requestTimeoutMs;
  restartAfterTimeouts;
  idleTimeoutMs;
  now;
  /**
   * 创建 helper 宿主；进程惰性启动，首次请求时才拉起。
   * @param options 依赖注入配置。
   * @author zhenghq
   */
  constructor(options = {}) {
    this.spawnFn = options.spawn ?? (() => defaultSpawnWindowsUiaReader());
    this.requestTimeoutMs = options.requestTimeoutMs ?? NATIVE_READER_REQUEST_TIMEOUT_MS;
    this.restartAfterTimeouts = options.restartAfterTimeouts ?? NATIVE_READER_RESTART_AFTER_TIMEOUTS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? NATIVE_READER_IDLE_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }
  /**
   * 向 helper 发起一次选区直读。
   * @returns 直读结果；helper 不可用或被禁用时返回 unknown 并带降级原因。
   * @author zhenghq
   */
  async readSelection() {
    if (this.disabled) {
      return { status: "unknown", reason: "helper-disabled" };
    }
    const child = await this.ensureChild();
    if (!child) {
      return { status: "unknown", reason: "helper-disabled" };
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const pending = this.matcher.track(id, this.requestTimeoutMs);
    try {
      child.stdin?.write(encodeNativeReaderRequest({ id, method: "readSelection" }));
    } catch (error2) {
      this.matcher.rejectAll(error2 instanceof Error ? error2 : new Error(String(error2)));
    }
    try {
      const result = await pending;
      this.consecutiveTimeouts = 0;
      this.lastActivityAt = this.now();
      return result;
    } catch (error2) {
      this.lastActivityAt = this.now();
      if (error2 instanceof Error && /timeout/iu.test(error2.message)) {
        this.consecutiveTimeouts += 1;
        if (this.consecutiveTimeouts >= this.restartAfterTimeouts) {
          await this.restart();
        }
      }
      throw error2;
    }
  }
  /**
   * 释放宿主：终止 helper 进程并拒绝全部待定请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose() {
    this.killChild();
    this.matcher.rejectAll(new Error("native reader host disposed"));
    this.disabled = true;
  }
  /**
   * 确保 helper 进程可用：空闲超时先退出旧进程，必要时惰性启动。
   * @returns 可用的子进程；重启失败或禁用后返回 null。
   * @author zhenghq
   */
  async ensureChild() {
    if (this.disabled) return null;
    if (this.child && this.idleTimeoutMs > 0 && this.lastActivityAt >= 0 && this.now() - this.lastActivityAt > this.idleTimeoutMs) {
      this.killChild();
    }
    if (this.child) return this.child;
    return this.spawnChild();
  }
  /**
   * 启动新的 helper 进程并接管其 stdout 响应流。
   * @returns 启动成功的子进程；启动即失败时禁用宿主并返回 null。
   * @author zhenghq
   */
  spawnChild() {
    let child;
    try {
      child = this.spawnFn();
    } catch {
      this.disabled = true;
      return null;
    }
    let crashed = false;
    child.on("error", () => {
      crashed = true;
    });
    child.on("exit", () => {
      crashed = true;
      if (this.child === child) {
        this.child = null;
        if (!this.suppressNextExit) {
          this.disabled = true;
        }
        this.suppressNextExit = false;
      }
      this.matcher.rejectAll(new Error("native reader helper exited"));
    });
    child.stdout?.on("data", (chunk) => this.handleStdout(chunk));
    this.child = child;
    this.lastActivityAt = this.now();
    if (crashed) {
      this.child = null;
      this.disabled = true;
      return null;
    }
    return child;
  }
  /**
   * 处理 helper stdout 数据：按行切分并配对响应。
   * @param chunk stdout 数据块。
   * @returns 无返回值。
   * @author zhenghq
   */
  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString("utf8");
    const lines = this.stdoutBuffer.split(/\r?\n/u);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const response = parseNativeReaderResponseLine(line);
      if (response) this.matcher.resolve(response);
    }
  }
  /**
   * 重启 helper：终止旧进程后重新启动；失败时本次会话禁用。
   * @returns 重启是否成功。
   * @author zhenghq
   */
  async restart() {
    this.restarting ??= (async () => {
      this.consecutiveTimeouts = 0;
      this.killChild();
      const child = this.spawnChild();
      return child !== null;
    })();
    try {
      return await this.restarting;
    } finally {
      this.restarting = null;
    }
  }
  /**
   * 终止当前 helper 进程（若存在）。
   * @returns 无返回值。
   * @author zhenghq
   */
  killChild() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    this.suppressNextExit = true;
    this.lastActivityAt = -1;
    try {
      child.kill();
    } catch {
    }
  }
}
function defaultSpawnWindowsUiaReader() {
  const resourcesPath = process.resourcesPath;
  const helperPath = resolveWindowsUiaReaderPath(resourcesPath);
  if (!helperPath) {
    throw new Error(translateMain("capture.error.nativeReaderHelperMissing"));
  }
  const child = node_child_process.spawn(helperPath, [], { windowsHide: true });
  return {
    stdin: child.stdin,
    stdout: child.stdout ? { on: (event, listener) => child.stdout.on(event, listener) } : null,
    kill: () => child.kill(),
    on: (event, listener) => child.on(event, listener)
  };
}
const WINDOWS_HOTKEY_RELEASE_DELAY_MS = 300;
function resolveHotkeyCaptureDelay(platform) {
  return platform === "win32" ? WINDOWS_HOTKEY_RELEASE_DELAY_MS : 0;
}
const COPY_INJECTION_RETRY_DELAY_MS = 160;
const COPY_INJECTION_MAX_RETRIES = 1;
function resolveHotkeyModifiers(accelerator, platform) {
  const found = /* @__PURE__ */ new Set();
  for (const rawPart of accelerator.split("+")) {
    const part = rawPart.trim().toLowerCase();
    if (!part) continue;
    if (part === "control" || part === "ctrl") found.add("control");
    else if (part === "alt" || part === "option" || part === "altgr") found.add("alt");
    else if (part === "shift") found.add("shift");
    else if (part === "command" || part === "cmd" || part === "super" || part === "meta") {
      found.add("meta");
    } else if (part === "commandorcontrol" || part === "cmdorctrl") {
      found.add(platform === "darwin" ? "meta" : "control");
    }
  }
  const order = ["control", "alt", "shift", "meta"];
  return order.filter((modifier) => found.has(modifier));
}
function shouldReleaseHotkeyModifiersBeforeCopy(platform) {
  return platform === "win32";
}
function shouldRetryCopyInjection(elapsedMs, attempts, maxRetries = COPY_INJECTION_MAX_RETRIES) {
  if (attempts <= 0) return false;
  if (attempts > maxRetries) return false;
  return elapsedMs >= COPY_INJECTION_RETRY_DELAY_MS * attempts;
}
const COPY_FALLBACK_MAX_RETRIES = 1;
const COPY_FALLBACK_RETRY_TIMEOUT_MS = 500;
function resolveCopyRetryPlan(input) {
  if (input.aborted) return { retry: false, retryTimeoutMs: 0 };
  if (input.externalCopyObserved) return { retry: false, retryTimeoutMs: 0 };
  if (input.attempts <= 0) return { retry: false, retryTimeoutMs: 0 };
  if (input.retries >= COPY_FALLBACK_MAX_RETRIES) return { retry: false, retryTimeoutMs: 0 };
  if (input.elapsedMs < input.timeoutMs) return { retry: false, retryTimeoutMs: 0 };
  return { retry: true, retryTimeoutMs: COPY_FALLBACK_RETRY_TIMEOUT_MS };
}
const WL_PASTE_TIMEOUT_MS = 800;
function isWaylandSession(env) {
  const sessionType = (env.XDG_SESSION_TYPE ?? "").trim().toLowerCase();
  if (sessionType === "wayland") return true;
  return Boolean(env.WAYLAND_DISPLAY && env.WAYLAND_DISPLAY.trim());
}
function shouldUseWlPasteForLinux(platform, env) {
  return platform === "linux" && isWaylandSession(env);
}
function resolveWlPasteReadOutcome(input) {
  if (!input.text.trim()) return { kind: "fallback" };
  return { kind: "text", text: input.text };
}
const DIAGNOSTIC_DAY_RECORD_LIMIT = 2e3;
const DIAGNOSTIC_TOP_APP_LIMIT = 5;
const CAPTURE_DIAGNOSTIC_WHITELIST = [
  "at",
  "entry",
  "platform",
  "level",
  "reason",
  "elapsedMs",
  "app",
  "windowLocate",
  "windowCount",
  "windowMatched"
];
const VALID_REASONS = [
  "empty",
  "timeout",
  "unsupported",
  "permission",
  "clipboard-locked",
  "unknown"
];
const VALID_LEVELS = [
  "native-read",
  "copy-polled",
  "copy-late",
  "failed"
];
const VALID_WINDOW_LOCATE = [
  "exact",
  "app-fallback",
  "failed"
];
function normalizeAppIdentifier(value) {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  if (!trimmed) return "unknown";
  const basename = trimmed.split(/[\\/]/u).pop() ?? trimmed;
  const withoutExe = basename.replace(/\.exe$/iu, "");
  return withoutExe.toLowerCase() || "unknown";
}
function resolveDiagnosticReason(value) {
  if (typeof value !== "string") return void 0;
  const normalized = value.trim().toLowerCase();
  return VALID_REASONS.includes(normalized) ? normalized : void 0;
}
function resolveDiagnosticLevel(value) {
  if (typeof value !== "string") return "failed";
  const normalized = value.trim().toLowerCase();
  return VALID_LEVELS.includes(normalized) ? normalized : "failed";
}
function resolveDiagnosticWindowLocate(value) {
  if (typeof value !== "string") return void 0;
  const normalized = value.trim().toLowerCase();
  return VALID_WINDOW_LOCATE.includes(normalized) ? normalized : void 0;
}
function buildCaptureDiagnosticRecord(input) {
  const record = {
    at: input.at,
    entry: input.entry,
    platform: input.platform,
    level: resolveDiagnosticLevel(input.level),
    reason: input.level === "failed" ? resolveDiagnosticReason(input.reason) : void 0,
    elapsedMs: input.elapsedMs,
    app: normalizeAppIdentifier(input.app)
  };
  const windowLocate = resolveDiagnosticWindowLocate(input.windowLocate);
  if (windowLocate) record.windowLocate = windowLocate;
  if (typeof input.windowCount === "number" && Number.isInteger(input.windowCount) && input.windowCount >= 0) {
    record.windowCount = input.windowCount;
  }
  if (typeof input.windowMatched === "boolean") record.windowMatched = input.windowMatched;
  return record;
}
function getDiagnosticDaySummary(records) {
  const byEntry = {};
  const byLevel = {};
  const byReason = {};
  const appCounts = /* @__PURE__ */ new Map();
  for (const record of records) {
    byEntry[record.entry] = (byEntry[record.entry] ?? 0) + 1;
    byLevel[record.level] = (byLevel[record.level] ?? 0) + 1;
    if (record.level === "failed" && record.reason) {
      byReason[record.reason] = (byReason[record.reason] ?? 0) + 1;
    }
    if (record.level === "failed" && record.app) {
      appCounts.set(record.app, (appCounts.get(record.app) ?? 0) + 1);
    }
  }
  const topApps = [...appCounts.entries()].map(([app, count]) => ({ app, count })).sort((a, b) => b.count - a.count).slice(0, DIAGNOSTIC_TOP_APP_LIMIT);
  return {
    total: records.length,
    byEntry,
    byLevel,
    byReason,
    topApps
  };
}
function pruneDiagnosticDays(days, today) {
  const cutoff = /* @__PURE__ */ new Date(`${today}T00:00:00`);
  cutoff.setDate(cutoff.getDate() - 1);
  const month = String(cutoff.getMonth() + 1).padStart(2, "0");
  const day = String(cutoff.getDate()).padStart(2, "0");
  const earliest = `${cutoff.getFullYear()}-${month}-${day}`;
  const result = {};
  for (const [key, bucket] of Object.entries(days)) {
    if (key >= earliest) result[key] = bucket;
  }
  return result;
}
function appendDiagnosticRecord(day, record) {
  const records = [...day.records, record];
  const trimmed = records.length > DIAGNOSTIC_DAY_RECORD_LIMIT ? records.slice(-DIAGNOSTIC_DAY_RECORD_LIMIT) : records;
  return {
    records: trimmed,
    summary: getDiagnosticDaySummary(records)
  };
}
function containsPoint(bounds, point) {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}
function createWindowTitleFingerprint(title) {
  if (typeof title !== "string" || !title.trim()) return "";
  return node_crypto.createHash("sha256").update(title.trim()).digest("hex").slice(0, 12);
}
function boundsEqual(left, right) {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
function isTargetableWindow(window2, pid) {
  return window2.pid === pid && window2.layer === 0 && window2.bounds.width > 0 && window2.bounds.height > 0;
}
function resolveWindowBySnapshot(windows, snapshot, pid) {
  const candidates = windows.filter((window2) => isTargetableWindow(window2, pid));
  if (snapshot.windowNumber !== void 0) {
    const matchedByNumber = candidates.find((window2) => window2.windowNumber === snapshot.windowNumber);
    if (matchedByNumber) return matchedByNumber;
  }
  if (snapshot.bounds) {
    return candidates.find(
      (window2) => boundsEqual(window2.bounds, snapshot.bounds) && (!snapshot.titleFingerprint || createWindowTitleFingerprint(window2.title) === snapshot.titleFingerprint)
    ) ?? null;
  }
  return null;
}
function resolveWindowByPoint(windows, point, pid) {
  return windows.filter((window2) => isTargetableWindow(window2, pid) && containsPoint(window2.bounds, point)).sort((left, right) => {
    const leftArea = left.bounds.width * left.bounds.height;
    const rightArea = right.bounds.width * right.bounds.height;
    return leftArea - rightArea || right.windowNumber - left.windowNumber;
  })[0] ?? null;
}
function resolveTargetWindow(options) {
  const { windows, pid, point, snapshot } = options;
  if (snapshot) return resolveWindowBySnapshot(windows, snapshot, pid);
  if (point) return resolveWindowByPoint(windows, point, pid);
  return null;
}
function resolveWindowCaptureTarget(options) {
  if (options.windows === null) {
    return {
      windowCount: void 0,
      windowMatched: false,
      window: null,
      outcome: "failed"
    };
  }
  const windowCount = options.windows.filter((window22) => isTargetableWindow(window22, options.pid)).length;
  const window2 = resolveTargetWindow({ ...options, windows: options.windows });
  const windowMatched = window2 !== null;
  return {
    windowCount,
    windowMatched,
    window: window2,
    outcome: resolveWindowLocateOutcome({
      hasWindow: options.snapshot !== void 0,
      exactMatched: windowMatched
    })
  };
}
function buildFrontmostWindowSnapshot(options) {
  const snapshot = {
    bundleId: normalizeAppIdentifier(options.bundleId),
    pid: options.pid,
    capturedAt: options.capturedAt
  };
  if (!options.window || options.window.pid !== options.pid || options.window.layer !== 0) {
    return snapshot;
  }
  snapshot.windowNumber = options.window.windowNumber;
  snapshot.bounds = { ...options.window.bounds };
  const fingerprint = createWindowTitleFingerprint(options.window.title);
  if (fingerprint) snapshot.titleFingerprint = fingerprint;
  return snapshot;
}
function resolveWindowLocateOutcome(options) {
  if (options.exactMatched) return "exact";
  return options.hasWindow ? "failed" : "app-fallback";
}
const execFileP$4 = node_util.promisify(node_child_process.execFile);
const MACOS_WINDOW_ENUMERATION_TIMEOUT_MS = 200;
const MACOS_WINDOW_ACTIVATION_TIMEOUT_MS = 200;
const MACOS_WINDOW_ACTIVATION_POLL_MS = 16;
function resolveMacosWindowHelperPath(options) {
  const fileExists = options?.fileExists ?? node_fs.existsSync;
  const cwd = options?.cwd ?? process.cwd();
  const candidates = [
    options?.resourcesPath ? node_path.join(options.resourcesPath, "macos-window-helper") : null,
    node_path.join(cwd, "build", "macos-window-helper")
  ].filter((candidate) => Boolean(candidate));
  return candidates.find(fileExists) ?? null;
}
async function runWindowHelper(args) {
  const helperPath = resolveMacosWindowHelperPath({
    resourcesPath: typeof process.resourcesPath === "string" && process.resourcesPath ? process.resourcesPath : void 0
  });
  if (!helperPath) return null;
  const timeout = args[0] === "list" ? MACOS_WINDOW_ENUMERATION_TIMEOUT_MS : MACOS_WINDOW_ACTIVATION_TIMEOUT_MS;
  try {
    const { stdout } = await execFileP$4(helperPath, args, {
      timeout
    });
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function parseWindowInfo(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  const bounds = record.bounds;
  if (!bounds || typeof bounds !== "object") return null;
  const b = bounds;
  const pid = record.pid;
  const windowNumber = record.windowNumber;
  const layer = record.layer;
  const title = record.title;
  if (typeof pid !== "number" || typeof windowNumber !== "number" || typeof layer !== "number") return null;
  if (typeof b.x !== "number" || typeof b.y !== "number" || typeof b.width !== "number" || typeof b.height !== "number") return null;
  return {
    pid,
    windowNumber,
    layer,
    title: typeof title === "string" ? title : "",
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height }
  };
}
async function enumerateMacosWindows(pid) {
  const result = await runWindowHelper(["list", String(pid)]);
  const windows = result?.windows;
  if (!result || result.ok !== true || !Array.isArray(windows)) {
    throw new Error("macos-window-enumeration-failed");
  }
  const parsedWindows = windows.map(parseWindowInfo).filter((window2) => Boolean(window2));
  const frontmostWindowNumber = typeof result.frontmostWindowNumber === "number" ? result.frontmostWindowNumber : void 0;
  const frontmostPid = typeof result.frontmostPid === "number" ? result.frontmostPid : void 0;
  return {
    windows: parsedWindows,
    ...frontmostWindowNumber === void 0 ? {} : { frontmostWindowNumber },
    ...frontmostPid === void 0 ? {} : { frontmostPid }
  };
}
async function raiseMacosWindow(pid, windowNumber) {
  const result = await runWindowHelper(["raise", String(pid), String(windowNumber)]);
  return result?.raised === true;
}
async function readFocusedMacosWindowNumber(pid) {
  const result = await runWindowHelper(["focused", String(pid)]);
  return typeof result?.windowNumber === "number" ? result.windowNumber : null;
}
async function readFrontmostMacosWindowNumber(pid) {
  const result = await runWindowHelper(["list", String(pid)]);
  return typeof result?.frontmostWindowNumber === "number" ? result.frontmostWindowNumber : null;
}
const defaultDeps = {
  enumerateWindows: enumerateMacosWindows,
  readFrontmostWindowNumber: () => readFrontmostMacosWindowNumber(process.pid),
  raiseWindow: raiseMacosWindow,
  readFocusedWindowNumber: readFocusedMacosWindowNumber,
  openApplication: (bundleId) => {
    node_child_process.execFile("open", ["-b", bundleId], () => {
    });
    return true;
  },
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  now: Date.now,
  sleep: (ms2) => new Promise((resolve) => setTimeout(resolve, ms2))
};
async function activateMacosWindowSnapshot(snapshot, deps = defaultDeps) {
  if (!snapshot || !deps.isProcessAlive(snapshot.pid)) {
    return { activated: false, outcome: "app-fallback", windowMatched: false };
  }
  if (snapshot.windowNumber === void 0 && !snapshot.bounds) {
    return {
      activated: deps.openApplication(snapshot.bundleId),
      outcome: "app-fallback",
      windowMatched: false
    };
  }
  let windowList;
  try {
    windowList = await deps.enumerateWindows(snapshot.pid);
  } catch {
    windowList = null;
  }
  if (windowList === null) {
    return {
      activated: deps.openApplication(snapshot.bundleId),
      outcome: "failed",
      windowMatched: false
    };
  }
  const windows = windowList.windows;
  const windowCount = windows.filter((window2) => window2.pid === snapshot.pid && window2.layer === 0).length;
  const target = resolveTargetWindow({ windows, pid: snapshot.pid, snapshot });
  if (!target) {
    return {
      activated: deps.openApplication(snapshot.bundleId),
      outcome: "failed",
      windowCount,
      windowMatched: false
    };
  }
  if (windowCount <= 1) {
    return {
      activated: deps.openApplication(snapshot.bundleId),
      outcome: "app-fallback",
      windowCount,
      windowMatched: false
    };
  }
  const frontmostWindowNumber = windowList.frontmostPid === snapshot.pid ? windowList.frontmostWindowNumber ?? await deps.readFrontmostWindowNumber() : null;
  if (frontmostWindowNumber === target.windowNumber) {
    return {
      activated: true,
      outcome: "exact",
      windowCount,
      windowMatched: true
    };
  }
  const focusedWindowNumber = await deps.readFocusedWindowNumber(snapshot.pid);
  if (focusedWindowNumber === target.windowNumber) {
    return {
      activated: true,
      outcome: "exact",
      windowCount,
      windowMatched: true
    };
  }
  const raised = await deps.raiseWindow(snapshot.pid, target.windowNumber);
  if (raised) {
    const deadline = deps.now() + MACOS_WINDOW_ACTIVATION_TIMEOUT_MS;
    while (deps.now() <= deadline) {
      const [frontmostAfterRaise, focusedAfterRaise] = await Promise.all([
        deps.readFrontmostWindowNumber(),
        deps.readFocusedWindowNumber(snapshot.pid)
      ]);
      if (frontmostAfterRaise === target.windowNumber || focusedAfterRaise === target.windowNumber) {
        return {
          activated: true,
          outcome: resolveWindowLocateOutcome({ hasWindow: true, exactMatched: true }),
          windowCount,
          windowMatched: true
        };
      }
      if (deps.now() >= deadline) break;
      await deps.sleep(MACOS_WINDOW_ACTIVATION_POLL_MS);
    }
  }
  return {
    activated: deps.openApplication(snapshot.bundleId),
    outcome: "failed",
    windowCount,
    windowMatched: true
  };
}
const execFileP$3 = node_util.promisify(node_child_process.execFile);
const sleep$1 = (ms2) => new Promise((r) => setTimeout(r, ms2));
const CLIPBOARD_STABILITY_DELAY_MS = 120;
const SELECTION_INSPECTION_TIMEOUT_MS = 1500;
const NATIVE_SELECTION_RETRY_COUNT = 2;
const NATIVE_SELECTION_RETRY_DELAY_MS = 40;
const MACOS_COPY_SCRIPT_TIMEOUT_MS = 2e3;
const MACOS_COMMAND_PRESERVE_WINDOW_MS = 500;
const MODIFIER_RELEASE_SETTLE_MS = 24;
const WM_COPY_TIMEOUT_MS = 500;
const SENTINEL_VERIFY_RETRY_COUNT = 1;
function toWindowSnapshot(context) {
  if (!context?.bundleId || context.pid === void 0) return null;
  return {
    bundleId: context.bundleId,
    pid: context.pid,
    windowNumber: context.windowNumber,
    bounds: context.bounds,
    titleFingerprint: context.titleFingerprint,
    capturedAt: Date.now()
  };
}
async function activateWindowBeforeCopy(context) {
  if (process.platform !== "darwin") return null;
  if (context?.windowActivationSettled) {
    console.log("[capture] window-activate skipped=entry-settled");
    return null;
  }
  const snapshot = toWindowSnapshot(context);
  if (!snapshot) return null;
  try {
    const result = await activateMacosWindowSnapshot(snapshot);
    console.log(
      `[capture] window-activate outcome=${result.outcome} windowCount=${result.windowCount ?? "unknown"} windowMatched=${result.windowMatched}`
    );
    return result;
  } catch {
    console.log("[capture] window-activate outcome=failed windowCount=unknown windowMatched=false");
    return null;
  }
}
let windowsReaderHost = null;
function getWindowsReaderHost() {
  if (process.platform !== "win32") return null;
  if (windowsReaderHost) return windowsReaderHost;
  const helperPath = resolveWindowsUiaReaderPath(process.resourcesPath);
  if (!helperPath) return null;
  windowsReaderHost = new NativeReaderHost();
  return windowsReaderHost;
}
function convertHelperResult(result) {
  return {
    status: result.status,
    text: result.text ?? "",
    reason: result.reason
  };
}
function withWindowDiagnostics(native, context) {
  const hasWindowContext = context?.windowNumber !== void 0 || context?.bounds !== void 0;
  if (native.windowLocate !== void 0 || !hasWindowContext) return native;
  return {
    ...native,
    windowLocate: "app-fallback",
    windowMatched: false
  };
}
async function readSelectionViaMacosHelper(signal, windowNumber, pid) {
  const helperPath = resolveMacosAxReaderPath({
    resourcesPath: typeof process.resourcesPath === "string" && process.resourcesPath ? process.resourcesPath : void 0
  });
  if (!helperPath) {
    console.log("[capture] macos-ax-helper status=UNAVAILABLE elapsedMs=0 fallback=true reason=helper-missing");
    return null;
  }
  const startedAt = Date.now();
  try {
    const args = windowNumber === void 0 ? [] : pid === void 0 ? [String(windowNumber)] : [String(windowNumber), String(pid)];
    const { stdout, stderr } = await execFileP$3(
      helperPath,
      args,
      { timeout: SELECTION_INSPECTION_TIMEOUT_MS, signal }
    );
    const windowDiagnostics = parseMacosAxReaderWindowDiagnostic(stderr);
    console.log(
      `[capture] macos-ax-helper status=${classifyMacosAxHelperStatus(stdout)} elapsedMs=${Date.now() - startedAt} fallback=false windowLocate=${windowDiagnostics.windowLocate ?? "unknown"} windowCount=${windowDiagnostics.windowCount ?? "unknown"} windowMatched=${windowDiagnostics.windowMatched ?? "unknown"}`
    );
    return {
      ...parseNativeSelectionReadOutput(stdout),
      ...windowDiagnostics
    };
  } catch (error2) {
    console.log(
      `[capture] macos-ax-helper status=UNKNOWN elapsedMs=${Date.now() - startedAt} fallback=true reason=${signal?.aborted ? "aborted" : "helper-error"}`
    );
    return null;
  }
}
async function readSelectionViaWindowsHelper(signal) {
  const host = getWindowsReaderHost();
  if (!host) return null;
  try {
    const result = await host.readSelection();
    return convertHelperResult(result);
  } catch {
    return null;
  }
}
const MODIFIER_KEYCODES = {
  control: [uiohookNapi.UiohookKey.Ctrl, uiohookNapi.UiohookKey.CtrlRight],
  alt: [uiohookNapi.UiohookKey.Alt, uiohookNapi.UiohookKey.AltRight],
  shift: [uiohookNapi.UiohookKey.Shift, uiohookNapi.UiohookKey.ShiftRight],
  meta: [uiohookNapi.UiohookKey.Meta, uiohookNapi.UiohookKey.MetaRight]
};
let pendingCopyModifierRelease = [];
let pendingMacOSCommandWasDownUntil = 0;
const MACOS_SELECTION_PRESENCE = [
  'tell application "System Events"',
  "try",
  "set frontProcess to first application process whose frontmost is true",
  'set focusedElement to value of attribute "AXFocusedUIElement" of frontProcess',
  'set selectedText to value of attribute "AXSelectedText" of focusedElement',
  'if selectedText is missing value then return "UNKNOWN"',
  'if (selectedText as text) is "" then return "EMPTY"',
  'return "PRESENT\n" & (selectedText as text)',
  "on error",
  'return "UNKNOWN"',
  "end try",
  "end tell"
].join("\n");
const WINDOWS_SELECTION_PRESENCE = [
  "Add-Type -AssemblyName UIAutomationClient;",
  "$element = [System.Windows.Automation.AutomationElement]::FocusedElement;",
  "if ($null -eq $element) { Write-Output 'UNKNOWN'; exit }",
  "$pattern = $null;",
  "if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { Write-Output 'UNKNOWN'; exit }",
  "$ranges = ([System.Windows.Automation.TextPattern]$pattern).GetSelection();",
  "if ($null -eq $ranges -or $ranges.Count -eq 0) { Write-Output 'EMPTY'; exit }",
  "$text = ($ranges | ForEach-Object { $_.GetText(-1) }) -join '';",
  "if ([string]::IsNullOrWhiteSpace($text)) { Write-Output 'EMPTY' } else { Write-Output ('PRESENT' + [char]10 + $text) }"
].join(" ");
class PermissionError extends Error {
}
let wlPasteUnavailableLogged = false;
async function readLinuxSelectionByNative(signal) {
  if (shouldUseWlPasteForLinux(process.platform, process.env)) {
    try {
      const { stdout } = await execFileP$3(
        "wl-paste",
        ["--primary", "--no-newline"],
        { timeout: WL_PASTE_TIMEOUT_MS, signal }
      );
      const outcome = resolveWlPasteReadOutcome({ ok: true, text: stdout });
      if (outcome.kind === "text") return outcome.text;
    } catch (error2) {
      const code = error2.code;
      if (code === "ENOENT" && !wlPasteUnavailableLogged) {
        wlPasteUnavailableLogged = true;
        console.warn(
          "[capture] wl-paste 不可用：Wayland 会话建议安装 wl-clipboard 以支持原生应用划词取词"
        );
      }
    }
  }
  return electron.clipboard.readText("selection");
}
async function readSelectionByNative(signal, context) {
  try {
    if (signal?.aborted) return { status: "unknown", text: "", reason: "unknown" };
    if (process.platform === "linux") {
      const text = await readLinuxSelectionByNative(signal);
      return text.trim() ? { status: "present", text } : { status: "empty", text: "" };
    }
    if (process.platform === "darwin") {
      const helperResult = await readSelectionViaMacosHelper(
        signal,
        context?.windowNumber,
        context?.pid
      );
      if (helperResult) return withWindowDiagnostics(helperResult, context);
      const { stdout } = await execFileP$3(
        "osascript",
        ["-e", MACOS_SELECTION_PRESENCE],
        { timeout: SELECTION_INSPECTION_TIMEOUT_MS, signal }
      );
      return withWindowDiagnostics(parseNativeSelectionReadOutput(stdout), context);
    }
    if (process.platform === "win32") {
      const helperResult = await readSelectionViaWindowsHelper(signal);
      if (helperResult) return helperResult;
      const { stdout } = await execFileP$3("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        WINDOWS_SELECTION_PRESENCE
      ], {
        timeout: SELECTION_INSPECTION_TIMEOUT_MS,
        signal,
        windowsHide: true
      });
      return parseNativeSelectionReadOutput(stdout);
    }
  } catch {
    return { status: "unknown", text: "", reason: "unknown" };
  }
  return { status: "unknown", text: "", reason: "unknown" };
}
async function readSelectionByNativeWithRetry(signal, context) {
  let result = await readSelectionByNative(signal, context);
  for (let attempt = 1; attempt < NATIVE_SELECTION_RETRY_COUNT; attempt += 1) {
    if (signal?.aborted || result.status === "present" && result.text.trim()) return result;
    await sleep$1(NATIVE_SELECTION_RETRY_DELAY_MS);
    if (signal?.aborted) return result;
    result = await readSelectionByNative(signal, context);
  }
  return result;
}
async function checkAccessibilityPermission() {
  const strategy = resolveSelectionCaptureStrategy(process.platform);
  if (strategy === "macos-command-copy") {
    return electron.systemPreferences.isTrustedAccessibilityClient(true);
  }
  return strategy !== "unsupported";
}
function setPendingCopyModifierRelease(modifiers) {
  pendingCopyModifierRelease = shouldReleaseHotkeyModifiersBeforeCopy(process.platform) ? [...modifiers] : [];
}
function setPendingMacOSCommandWasDown(wasDown) {
  pendingMacOSCommandWasDownUntil = wasDown ? Date.now() + MACOS_COMMAND_PRESERVE_WINDOW_MS : 0;
}
async function releasePendingCopyModifiers() {
  const modifiers = pendingCopyModifierRelease;
  pendingCopyModifierRelease = [];
  if (modifiers.length === 0) return;
  for (const modifier of modifiers) {
    for (const keycode of MODIFIER_KEYCODES[modifier]) {
      try {
        uiohookNapi.uIOhook.keyToggle(keycode, "up");
      } catch {
      }
    }
  }
  console.log(`[capture] modifier-release keys=${modifiers.join(",")}`);
  await sleep$1(MODIFIER_RELEASE_SETTLE_MS);
}
const JXA_COPY = [
  "ObjC.import('CoreGraphics');",
  "var s=$.CGEventSourceCreate($.kCGEventSourceStateCombinedSessionState);",
  "var env=$.NSProcessInfo.processInfo.environment;",
  "var commandWasDown=env.objectForKey('commandWasDown')&&env.objectForKey('commandWasDown').js==='1';",
  "if(!commandWasDown){",
  "var commandDown=$.CGEventCreateKeyboardEvent(s,55,true);",
  "$.CGEventSetFlags(commandDown,$.kCGEventFlagMaskCommand);",
  "$.CGEventPost($.kCGHIDEventTap,commandDown);",
  "}",
  "var d=$.CGEventCreateKeyboardEvent(s,8,true);",
  "$.CGEventSetFlags(d,$.kCGEventFlagMaskCommand);",
  "$.CGEventPost($.kCGHIDEventTap,d);",
  "var u=$.CGEventCreateKeyboardEvent(s,8,false);",
  "$.CGEventSetFlags(u,$.kCGEventFlagMaskCommand);",
  "$.CGEventPost($.kCGHIDEventTap,u);",
  "if(!commandWasDown){",
  "var commandUp=$.CGEventCreateKeyboardEvent(s,55,false);",
  "$.CGEventSetFlags(commandUp,0);",
  "$.CGEventPost($.kCGHIDEventTap,commandUp);",
  "}"
].join("");
function isMacOSCommandKeyDown() {
  return Date.now() <= pendingMacOSCommandWasDownUntil;
}
async function tryWmCopyPoll(signal, timeoutMs, sentinel) {
  if (process.platform !== "win32") return null;
  try {
    const psScript = [
      "Add-Type -AssemblyName UIAutomationClient",
      "$element = [System.Windows.Automation.AutomationElement]::FocusedElement",
      "if ($null -eq $element) { exit 1 }",
      "$hwnd = [IntPtr]::Zero",
      "try { $hwnd = [IntPtr]::new($element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty)) } catch {}",
      "if ($hwnd -eq [IntPtr]::Zero) { exit 1 }",
      "[User32]::SendMessageTimeout($hwnd, 0x0301, [IntPtr]::Zero, [IntPtr]::Zero, 0x0001, 500, [ref]([IntPtr]::Zero)) | Out-Null",
      'Add-Type -Namespace User32 -Name User32 -MemberDefinition "[DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, ref IntPtr lpdwResult);"'
    ].join("\n");
    await execFileP$3("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      psScript
    ], { timeout: WM_COPY_TIMEOUT_MS, windowsHide: true, signal });
    const start = Date.now();
    while (!signal?.aborted && Date.now() - start < timeoutMs) {
      const current = electron.clipboard.readText();
      if (current !== sentinel && current.trim()) return current;
      await sleep$1(40);
    }
  } catch {
  }
  return null;
}
async function simulateCopy() {
  const strategy = resolveSelectionCaptureStrategy(process.platform);
  if (strategy === "linux-primary-selection") return;
  if (strategy === "unsupported") {
    throw new Error(translateMain("capture.error.unsupportedPlatform", { platform: process.platform }));
  }
  try {
    if (strategy === "macos-command-copy") {
      const commandWasDown = isMacOSCommandKeyDown();
      await execFileP$3(
        "osascript",
        ["-l", "JavaScript", "-e", JXA_COPY],
        {
          env: { ...process.env, commandWasDown: commandWasDown ? "1" : "0" },
          timeout: MACOS_COPY_SCRIPT_TIMEOUT_MS
        }
      );
    } else {
      await releasePendingCopyModifiers();
      uiohookNapi.uIOhook.keyTap(uiohookNapi.UiohookKey.C, [uiohookNapi.UiohookKey.Ctrl]);
    }
  } catch (e) {
    const err = e;
    const msg = String(err?.stderr ?? err?.message ?? err);
    if (/assistive|not allowed|-25211|-1719|1002/i.test(msg)) {
      throw new PermissionError(translateMain("capture.error.accessibilityPermissionRequired"));
    }
    throw new Error(translateMain("capture.error.copySimulationFailed", { message: msg }));
  }
}
async function captureByCopy(signal, timeoutMs = 800, context) {
  const captureStartedAt = Date.now();
  const windowActivation = await activateWindowBeforeCopy(context);
  if (signal?.aborted) return { text: "" };
  const originalImage = electron.clipboard.readImage();
  const hadImage = !originalImage.isEmpty();
  const originalText = electron.clipboard.readText();
  const externalCopyVersion = copyShortcutGuard.getExternalCopyVersion();
  const restoreOriginalClipboard = () => {
    if (hadImage) electron.clipboard.writeImage(originalImage);
    else electron.clipboard.writeText(originalText);
  };
  const handleAbort = () => {
    if (shouldRestoreClipboardAfterAbort(
      copyShortcutGuard.hasExternalCopySince(externalCopyVersion)
    )) {
      restoreOriginalClipboard();
    }
  };
  if (signal?.aborted) return { text: "" };
  if (resolveSelectionCaptureStrategy(process.platform) === "linux-primary-selection") {
    const text2 = electron.clipboard.readText("selection");
    console.log(
      `[capture] copy-finish platform=${process.platform} status=${text2.trim() ? "text" : "empty"} textLength=${text2.length} elapsedMs=${Date.now() - captureStartedAt}`
    );
    return text2.trim() ? { text: text2, diagnostics: { level: "native-read" } } : { text: "", reason: "empty", diagnostics: { level: "failed", reason: "empty" } };
  }
  console.log(`[capture] copy-start platform=${process.platform} timeoutMs=${timeoutMs}`);
  signal?.addEventListener("abort", handleAbort, { once: true });
  const sentinel = `__SELECTION_TRANSLATOR_SENTINEL_${Date.now()}__`;
  electron.clipboard.clear();
  electron.clipboard.writeText(sentinel);
  const verifySentinelWrite = () => {
    for (let attempt = 0; attempt <= SENTINEL_VERIFY_RETRY_COUNT; attempt += 1) {
      const readback = electron.clipboard.readText();
      if (readback === sentinel) return null;
      if (attempt < SENTINEL_VERIFY_RETRY_COUNT) {
        electron.clipboard.clear();
        electron.clipboard.writeText(sentinel);
      }
    }
    console.log(`[capture] clipboard-locked sentinel-readback-mismatch elapsedMs=${Date.now() - captureStartedAt}`);
    restoreOriginalClipboard();
    return {
      text: "",
      reason: "clipboard-locked",
      diagnostics: { level: "failed", reason: "clipboard-locked" }
    };
  };
  const sentinelFailure = verifySentinelWrite();
  if (sentinelFailure) return sentinelFailure;
  let text = "";
  let hasImage = false;
  let captureStatus = "timeout";
  let copyAttempts = 0;
  let copyRetries = 0;
  const injectCopyShortcut = async () => {
    const sendCopyShortcut = async (observed) => {
      try {
        await simulateCopy();
        copyAttempts += 1;
        console.log(
          `[capture] copy-shortcut-sent attempt=${copyAttempts} observed=${observed} elapsedMs=${Date.now() - captureStartedAt}`
        );
      } catch (error2) {
        console.warn(
          `[capture] copy-shortcut-failed error=${error2 instanceof Error ? error2.name : "unknown"} elapsedMs=${Date.now() - captureStartedAt}`
        );
        throw error2;
      }
    };
    const shouldObserveSyntheticCopy = isAutoTriggerRunning();
    if (!shouldObserveSyntheticCopy) {
      await sendCopyShortcut(false);
      return;
    }
    const expectation = copyShortcutGuard.expectSyntheticCopyShortcut();
    try {
      await sendCopyShortcut(true);
    } finally {
      await expectation.finish();
    }
  };
  try {
    if (process.platform === "win32") {
      const wmCopyText = await tryWmCopyPoll(signal, WM_COPY_TIMEOUT_MS, sentinel);
      if (wmCopyText && wmCopyText.trim()) {
        console.log(`[capture] wm-copy-hit textLength=${wmCopyText.length} elapsedMs=${Date.now() - captureStartedAt}`);
        text = wmCopyText;
      }
    }
    if (!text) {
      const pollForCapture = async (pollTimeoutMs) => {
        const start = Date.now();
        while (!signal?.aborted && Date.now() - start < pollTimeoutMs) {
          text = electron.clipboard.readText();
          hasImage = !electron.clipboard.readImage().isEmpty();
          if (hasClipboardCaptureCompleted(text, hasImage, sentinel)) return;
          if (shouldRetryCopyInjection(Date.now() - start, copyAttempts)) {
            console.log(`[capture] copy-retry elapsedMs=${Date.now() - captureStartedAt}`);
            await injectCopyShortcut();
            continue;
          }
          await sleep$1(40);
        }
      };
      await injectCopyShortcut();
      await pollForCapture(timeoutMs);
      if (!hasClipboardCaptureCompleted(text, hasImage, sentinel)) {
        const plan = resolveCopyRetryPlan({
          attempts: copyAttempts,
          retries: copyRetries,
          elapsedMs: Date.now() - captureStartedAt,
          timeoutMs,
          aborted: Boolean(signal?.aborted),
          externalCopyObserved: copyShortcutGuard.hasExternalCopySince(externalCopyVersion)
        });
        if (plan.retry) {
          copyRetries += 1;
          console.log(
            `[capture] copy-fallback-retry retry=${copyRetries} timeoutMs=${plan.retryTimeoutMs} elapsedMs=${Date.now() - captureStartedAt}`
          );
          electron.clipboard.clear();
          electron.clipboard.writeText(sentinel);
          const retrySentinelFailure = verifySentinelWrite();
          if (retrySentinelFailure) return retrySentinelFailure;
          await injectCopyShortcut();
          await pollForCapture(plan.retryTimeoutMs);
        }
      }
    }
  } finally {
    try {
      if (!signal?.aborted) {
        await sleep$1(CLIPBOARD_STABILITY_DELAY_MS);
      }
      if (signal?.aborted) {
        if (shouldRestoreClipboardAfterAbort(
          copyShortcutGuard.hasExternalCopySince(externalCopyVersion)
        )) {
          restoreOriginalClipboard();
        }
      } else {
        const externalCopyObserved = copyShortcutGuard.hasExternalCopySince(externalCopyVersion);
        const currentText = electron.clipboard.readText();
        const currentHasImage = !electron.clipboard.readImage().isEmpty();
        const resolved = resolveCapturedClipboardState(
          { text, hasImage },
          { text: currentText, hasImage: currentHasImage },
          sentinel
        );
        text = resolved.text;
        hasImage = resolved.hasImage;
        captureStatus = resolved.status;
        if (shouldRestoreClipboard(
          externalCopyObserved,
          currentText,
          sentinel,
          currentHasImage,
          text
        )) {
          restoreOriginalClipboard();
        }
      }
    } finally {
      signal?.removeEventListener("abort", handleAbort);
    }
  }
  if (signal?.aborted) {
    console.log(`[capture] copy-finish status=aborted elapsedMs=${Date.now() - captureStartedAt}`);
    return { text: "" };
  }
  if (hasImage) {
    console.log(
      `[capture] copy-finish status=${captureStatus === "late" ? "image-late" : "image"} elapsedMs=${Date.now() - captureStartedAt}`
    );
    const level2 = captureStatus === "late" ? "copy-late" : "copy-polled";
    return {
      text: "",
      hasImage: true,
      diagnostics: {
        level: level2,
        windowLocate: windowActivation?.outcome,
        windowCount: windowActivation?.windowCount,
        windowMatched: windowActivation?.windowMatched
      }
    };
  }
  if (!text) {
    console.log(
      `[capture] copy-finish status=timeout attempts=${copyAttempts} retries=${copyRetries} elapsedMs=${Date.now() - captureStartedAt}`
    );
    return {
      text: "",
      reason: "timeout",
      diagnostics: {
        level: "failed",
        reason: "timeout",
        windowLocate: windowActivation?.outcome,
        windowCount: windowActivation?.windowCount,
        windowMatched: windowActivation?.windowMatched
      }
    };
  }
  console.log(
    `[capture] copy-finish status=${captureStatus === "late" ? "text-late" : "text"} textLength=${text.length} elapsedMs=${Date.now() - captureStartedAt}`
  );
  const level = captureStatus === "late" ? "copy-late" : "copy-polled";
  return {
    text,
    diagnostics: {
      level,
      windowLocate: windowActivation?.outcome,
      windowCount: windowActivation?.windowCount,
      windowMatched: windowActivation?.windowMatched
    }
  };
}
async function captureSelectionByNativeOnly(signal, context) {
  if (signal?.aborted) return { text: "" };
  const native = await readSelectionByNativeWithRetry(signal, context);
  if (native.status === "present" && native.text.trim()) {
    return {
      text: native.text,
      diagnostics: {
        level: "native-read",
        windowLocate: native.windowLocate,
        windowCount: native.windowCount,
        windowMatched: native.windowMatched
      }
    };
  }
  const reason = native.status === "empty" ? "empty" : "unsupported";
  return {
    text: "",
    reason,
    diagnostics: {
      level: "failed",
      reason,
      windowLocate: native.windowLocate ?? (context?.windowNumber === void 0 ? "app-fallback" : "failed"),
      windowCount: native.windowCount,
      windowMatched: native.windowMatched ?? false
    }
  };
}
async function captureSelectionAfterButtonClick(signal, timeoutMs = 800, context) {
  if (signal?.aborted) return { text: "" };
  const resolvedContext = typeof timeoutMs === "number" ? context : timeoutMs;
  const resolvedTimeoutMs = typeof timeoutMs === "number" ? timeoutMs : timeoutMs.timeoutMs ?? 800;
  const plan = getSelectionCapturePlan(process.platform);
  console.log(
    `[capture] button-capture-start platform=${process.platform} copyFallback=${plan.copyFallback}`
  );
  if (plan.copyFallback) {
    return captureByCopy(signal, resolvedTimeoutMs, resolvedContext);
  }
  if (plan.supportsNativeRead) {
    return captureSelectionByNativeOnly(signal, resolvedContext);
  }
  return { text: "", reason: "unsupported", diagnostics: { level: "failed", reason: "unsupported" } };
}
async function captureSelection(signal, timeoutMs = 800, context) {
  if (signal?.aborted) return { text: "" };
  const resolvedContext = typeof timeoutMs === "number" ? context : timeoutMs;
  const resolvedTimeoutMs = typeof timeoutMs === "number" ? timeoutMs : timeoutMs.timeoutMs ?? 800;
  const plan = getSelectionCapturePlan(process.platform);
  if (plan.supportsNativeRead) {
    const native = await readSelectionByNative(signal, resolvedContext);
    if (native.status === "present" && native.text.trim()) {
      return {
        text: native.text,
        diagnostics: {
          level: "native-read",
          windowLocate: native.windowLocate,
          windowCount: native.windowCount,
          windowMatched: native.windowMatched
        }
      };
    }
    if (plan.copyFallback) {
      return captureByCopy(signal, resolvedTimeoutMs, resolvedContext);
    }
    const reason = native.status === "empty" ? "empty" : "unsupported";
    return {
      text: "",
      reason,
      diagnostics: {
        level: "failed",
        reason,
        windowLocate: native.windowLocate ?? (resolvedContext?.windowNumber === void 0 ? "app-fallback" : "failed"),
        windowCount: native.windowCount,
        windowMatched: native.windowMatched ?? false
      }
    };
  }
  if (plan.copyFallback) {
    return captureByCopy(signal, resolvedTimeoutMs, resolvedContext);
  }
  return { text: "", reason: "unsupported", diagnostics: { level: "failed", reason: "unsupported" } };
}
function hasScreenRecordingPermission() {
  if (process.platform !== "darwin") return true;
  return electron.systemPreferences.getMediaAccessStatus("screen") === "granted";
}
const execFileP$2 = node_util.promisify(node_child_process.execFile);
const FRONTMOST_APP_QUERY_TIMEOUT_MS = 500;
function localToday() {
  const now = /* @__PURE__ */ new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
async function queryMacOSFrontmostApp() {
  const script = [
    'tell application "System Events"',
    "set frontProcess to first application process whose frontmost is true",
    "try",
    "return bundle identifier of frontProcess",
    "on error",
    "return name of frontProcess",
    "end try",
    "end tell"
  ].join("\n");
  const { stdout } = await execFileP$2("osascript", ["-e", script], {
    timeout: FRONTMOST_APP_QUERY_TIMEOUT_MS
  });
  return stdout.trim();
}
async function queryWindowsFrontmostApp() {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$handle = [System.Windows.Forms.Form]::ActiveForm;",
    "if ($null -eq $handle) {",
    `  $hwnd = (Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' -Name Win32 -PassThru)::GetForegroundWindow();`,
    "} else { $hwnd = $handle.Handle }",
    "$process = Get-Process | Where-Object { $_.MainWindowHandle -eq $hwnd } | Select-Object -First 1;",
    "if ($null -eq $process) { Write-Output 'unknown' } else { Write-Output $process.ProcessName }"
  ].join(" ");
  const { stdout } = await execFileP$2("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-Command",
    script
  ], {
    timeout: FRONTMOST_APP_QUERY_TIMEOUT_MS,
    windowsHide: true
  });
  return stdout.trim();
}
async function queryFrontmostApp() {
  try {
    if (process.platform === "darwin") {
      const raw = await queryMacOSFrontmostApp();
      return { app: normalizeAppIdentifier(raw) };
    }
    if (process.platform === "win32") {
      const raw = await queryWindowsFrontmostApp();
      return { app: normalizeAppIdentifier(raw) };
    }
    return { app: "unknown" };
  } catch {
    return { app: "unknown" };
  }
}
class CaptureDiagnosticsStore {
  filePath;
  today;
  data;
  /**
   * 创建诊断存储并加载磁盘数据；文件损坏时静默重建为空结构。
   * @param options 存储构造选项。
   * @author zhenghq
   */
  constructor(options) {
    this.filePath = options.filePath;
    this.today = options.today ?? localToday;
    this.data = this.load();
  }
  /**
   * 记录一条取词诊断，并按两天滚动规则清理过期桶后持久化。
   * @param record 诊断记录。
   * @returns 无返回值。
   * @author zhenghq
   */
  record(record) {
    const today = this.today();
    const bucket = this.data.days[today] ?? { records: [] };
    this.data.days[today] = appendDiagnosticRecord(bucket, record);
    this.data.days = pruneDiagnosticDays(this.data.days, today);
    this.persist();
  }
  /**
   * 获取当前诊断数据快照（只读副本）。
   * @returns 诊断数据深拷贝。
   * @author zhenghq
   */
  snapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }
  /**
   * 获取近两天聚合摘要，供设置页展示。
   * @returns 两天聚合摘要。
   * @author zhenghq
   */
  getSummary() {
    return { days: this.data.days };
  }
  /**
   * 获取导出数据：两天聚合与原始样本。
   * 原始样本逐字段按白名单重建，避免旧版本或损坏文件中的窗口标题、
   * 选区文本与剪贴板内容随导出泄漏；每个日期桶只保留最近固定数量样本。
   * @returns 导出用诊断数据。
   * @author zhenghq
   */
  getExportData() {
    const days = {};
    for (const [day, bucket] of Object.entries(this.data.days)) {
      const records = Array.isArray(bucket.records) ? bucket.records.slice(-200).map((record) => {
        const filtered = {};
        for (const field of CAPTURE_DIAGNOSTIC_WHITELIST) {
          if (record[field] !== void 0) {
            filtered[field] = record[field];
          }
        }
        return filtered;
      }) : [];
      days[day] = {
        records,
        summary: bucket.summary
      };
    }
    return { days };
  }
  /**
   * 从磁盘加载诊断数据，非法内容静默重建为空结构。
   * @returns 诊断数据。
   * @author zhenghq
   */
  load() {
    try {
      if (node_fs.existsSync(this.filePath)) {
        const raw = JSON.parse(node_fs.readFileSync(this.filePath, "utf-8"));
        if (raw && typeof raw === "object" && raw.days && typeof raw.days === "object") {
          return { days: raw.days };
        }
      }
    } catch {
    }
    return { days: {} };
  }
  /**
   * 原子写入诊断文件；写失败静默忽略，避免影响取词主流程。
   * @returns 无返回值。
   * @author zhenghq
   */
  persist() {
    try {
      const temporaryPath = `${this.filePath}.tmp`;
      node_fs.mkdirSync(node_path.dirname(this.filePath), { recursive: true });
      node_fs.writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2));
      node_fs.renameSync(temporaryPath, this.filePath);
    } catch {
    }
  }
}
let defaultStore = null;
function resolveUserDataPath() {
  const require$1 = node_module.createRequire(require("url").pathToFileURL(__filename).href);
  const { app } = require$1("electron");
  return app.getPath("userData");
}
function getCaptureDiagnosticsStore() {
  if (!defaultStore) {
    defaultStore = new CaptureDiagnosticsStore({
      filePath: `${resolveUserDataPath()}/capture-diagnostics.json`
    });
  }
  return defaultStore;
}
function recordCaptureDiagnostic(input) {
  getCaptureDiagnosticsStore().record(buildCaptureDiagnosticRecord(input));
}
class DingTalkError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.kind = kind;
    this.name = "DingTalkError";
    this.authenticationInvalid = options.authenticationInvalid === true;
  }
  authenticationInvalid;
}
const AUTHENTICATION_CODES = /* @__PURE__ */ new Set([40001, 40002, 40014, 42001]);
const PERMISSION_CODES = /* @__PURE__ */ new Set([43004, 50001, 60011, 60020]);
const RATE_LIMIT_CODES = /* @__PURE__ */ new Set([88, 90018, 130101]);
const PARAMETER_CODES = /* @__PURE__ */ new Set([40003, 40004, 40035]);
function createDingTalkResponseError(status, errorCode) {
  if (status === 401 || AUTHENTICATION_CODES.has(errorCode ?? -1)) {
    return new DingTalkError("authentication", translateMain("dingtalk.error.authentication"), {
      authenticationInvalid: AUTHENTICATION_CODES.has(errorCode ?? -1)
    });
  }
  if (status === 403 || PERMISSION_CODES.has(errorCode ?? -1)) {
    return new DingTalkError("permission", translateMain("dingtalk.error.permission"));
  }
  if (status === 429 || RATE_LIMIT_CODES.has(errorCode ?? -1)) {
    return new DingTalkError("rate-limit", translateMain("dingtalk.error.rateLimit"));
  }
  if (status === 400 || PARAMETER_CODES.has(errorCode ?? -1)) {
    return new DingTalkError("parameter", translateMain("dingtalk.error.parameter"));
  }
  return new DingTalkError("service", translateMain("dingtalk.error.serviceUnavailable"));
}
function normalizeDingTalkNetworkError(error2) {
  if (error2 instanceof DingTalkError) return error2;
  const name = error2 instanceof Error ? error2.name : "";
  const timeout = name === "AbortError" || name === "TimeoutError";
  return new DingTalkError(
    "network",
    translateMain(timeout ? "dingtalk.error.timeout" : "dingtalk.error.network"),
    {
      cause: error2
    }
  );
}
function toDingTalkCheckStatus(error2) {
  const normalized = error2 instanceof DingTalkError ? error2 : normalizeDingTalkNetworkError(error2);
  switch (normalized.kind) {
    case "configuration":
      return {
        ok: false,
        code: "incomplete",
        message: translateMain("dingtalk.error.configurationIncomplete")
      };
    case "authentication":
      return {
        ok: false,
        code: "authentication",
        message: translateMain("dingtalk.error.authenticationStatus")
      };
    case "permission":
      return {
        ok: false,
        code: "permission",
        message: translateMain("dingtalk.error.permissionStatus")
      };
    case "rate-limit":
      return {
        ok: false,
        code: "rate-limit",
        message: translateMain("dingtalk.error.rateLimitStatus")
      };
    case "parameter":
      return {
        ok: false,
        code: "parameter",
        message: translateMain("dingtalk.error.parameterStatus")
      };
    case "network":
      return { ok: false, code: "network", message: normalized.message };
    default:
      return {
        ok: false,
        code: "service",
        message: translateMain("dingtalk.error.serviceStatus")
      };
  }
}
const SUPPORTED_LANGUAGES = /* @__PURE__ */ new Set([
  "zh",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "it",
  "ru",
  "id",
  "vi",
  "th",
  "ar",
  "tr"
]);
function normalizeDingTalkLanguage(language) {
  const normalized = language.trim().toLowerCase().split("-")[0];
  if (!normalized || normalized === "auto") return null;
  return SUPPORTED_LANGUAGES.has(normalized) ? normalized : null;
}
function resolveDingTalkLanguagePair(text, sourceLanguage, targetLanguage) {
  const target = normalizeDingTalkLanguage(targetLanguage);
  if (!target) return { supported: false };
  let source = normalizeDingTalkLanguage(sourceLanguage);
  if (sourceLanguage.trim().toLowerCase() === "auto") {
    if (target === "en") source = "zh";
    else if (target === "zh") source = "en";
    else return { supported: false };
  }
  if (!source || source === target) return { supported: false };
  return { supported: true, sourceLanguage: source, targetLanguage: target };
}
async function runDingTalkRequestWithTimeout(timeoutMs, request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
class DingTalkTokenManager {
  constructor(options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 5e3;
    this.refreshWindowMs = options.refreshWindowMs ?? 6e4;
  }
  now;
  timeoutMs;
  refreshWindowMs;
  cachedToken = null;
  expiresAt = 0;
  credentialKey = "";
  inFlight = null;
  generation = 0;
  /**
   * 获取当前配置对应的有效 Token，并合并同时发生的请求。
   * @param credentials 当前主进程凭证快照。
   * @returns 可用于钉钉翻译接口的 AccessToken。
   * @author zhenghq
   */
  async getToken(credentials) {
    const key = this.createCredentialKey(credentials);
    if (this.credentialKey && this.credentialKey !== key) this.reset();
    this.credentialKey = key;
    if (this.cachedToken && this.now() < this.expiresAt - this.refreshWindowMs) {
      return this.cachedToken;
    }
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const request = this.requestToken(credentials, key, generation);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = null;
    }
  }
  /**
   * 清除缓存 Token、到期时间和进行中的请求引用。
   * @returns 无返回值。
   * @author zhenghq
   */
  reset() {
    this.cachedToken = null;
    this.expiresAt = 0;
    this.credentialKey = "";
    this.inFlight = null;
    this.generation += 1;
  }
  /**
   * 调用 OAuth2 接口并在当前配置世代仍有效时缓存 Token。
   * @param credentials 当前凭证快照。
   * @param key 当前凭证内存键。
   * @param generation 请求开始时的配置世代。
   * @returns 新获取的 AccessToken。
   * @author zhenghq
   */
  async requestToken(credentials, key, generation) {
    try {
      return await runDingTalkRequestWithTimeout(this.timeoutMs, async (signal) => {
        const url = `https://api.dingtalk.com/v1.0/oauth2/${encodeURIComponent(credentials.corpId)}/token`;
        const response = await this.options.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            grant_type: "client_credentials"
          }),
          signal
        });
        const payload = await this.readResponse(response);
        if (!response.ok) {
          const code = typeof payload.code === "number" ? payload.code : void 0;
          throw createDingTalkResponseError(response.status, code);
        }
        const token = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
        const expiresIn = Number(payload.expires_in);
        if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
          throw new DingTalkError("service", translateMain("dingtalk.error.tokenResponseInvalid"));
        }
        if (generation === this.generation && key === this.credentialKey) {
          this.cachedToken = token;
          this.expiresAt = this.now() + expiresIn * 1e3;
        }
        return token;
      });
    } catch (error2) {
      throw normalizeDingTalkNetworkError(error2);
    }
  }
  /**
   * 安全解析 Token JSON 响应，解析失败时返回服务错误。
   * @param response Token 接口响应。
   * @returns Token 响应对象。
   * @author zhenghq
   */
  async readResponse(response) {
    try {
      return await response.json();
    } catch (error2) {
      throw new DingTalkError(
        "service",
        translateMain("dingtalk.error.tokenResponseParse"),
        { cause: error2 }
      );
    }
  }
  /**
   * 创建只保留在主进程内存中的凭证比较键。
   * @param credentials 当前凭证快照。
   * @returns 用于判断配置是否变化的内存键。
   * @author zhenghq
   */
  createCredentialKey(credentials) {
    return `${credentials.corpId}\0${credentials.clientId}\0${credentials.clientSecret}`;
  }
}
class DingTalkTranslationClient {
  constructor(options) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 6e3;
  }
  timeoutMs;
  /**
   * 翻译文本，首次请求明确鉴权失效时刷新 Token 后重试一次。
   * @param text 待翻译文本。
   * @param pair 已验证受支持的钉钉语言对。
   * @param credentials 当前主进程凭证快照。
   * @returns 钉钉翻译结果。
   * @author zhenghq
   */
  async translate(text, pair, credentials) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.options.tokenManager.getToken(credentials);
      try {
        return await this.requestTranslation(text, pair, token);
      } catch (error2) {
        const normalized = normalizeDingTalkNetworkError(error2);
        if (attempt === 0 && normalized.authenticationInvalid) {
          this.options.tokenManager.reset();
          continue;
        }
        throw normalized;
      }
    }
    throw new DingTalkError("authentication", translateMain("dingtalk.error.authentication"));
  }
  /**
   * 清除客户端持有的 Token 运行时状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  reset() {
    this.options.tokenManager.reset();
  }
  /**
   * 使用指定 Token 发送一次 TOPAPI 文本翻译请求。
   * @param text 待翻译文本。
   * @param pair 已验证的语言对。
   * @param token 当前 AccessToken。
   * @returns 单次翻译结果。
   * @author zhenghq
   */
  async requestTranslation(text, pair, token) {
    return runDingTalkRequestWithTimeout(this.timeoutMs, async (signal) => {
      const url = `https://oapi.dingtalk.com/topapi/ai/mt/translate?access_token=${encodeURIComponent(token)}`;
      const response = await this.options.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: text,
          source_language: pair.sourceLanguage,
          target_language: pair.targetLanguage
        }),
        signal
      });
      const payload = await this.readResponse(response);
      const errorCode = Number(payload.errcode);
      if (!response.ok || !Number.isFinite(errorCode) || errorCode !== 0) {
        throw createDingTalkResponseError(
          response.status,
          Number.isFinite(errorCode) ? errorCode : void 0
        );
      }
      const translation = typeof payload.result === "string" ? payload.result.trim() : "";
      if (!translation) {
        throw new DingTalkError("service", translateMain("dingtalk.error.translationResponseEmpty"));
      }
      return {
        translation,
        detectedLang: pair.sourceLanguage.toUpperCase()
      };
    });
  }
  /**
   * 安全解析翻译 JSON 响应，禁止将原始响应或 URL 放入错误消息。
   * @param response 钉钉翻译接口响应。
   * @returns 解析后的响应对象。
   * @author zhenghq
   */
  async readResponse(response) {
    try {
      return await response.json();
    } catch (error2) {
      throw new DingTalkError(
        "service",
        translateMain("dingtalk.error.translationResponseParse"),
        { cause: error2 }
      );
    }
  }
}
class MicrosoftError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.kind = kind;
    this.name = "MicrosoftError";
  }
}
function createMicrosoftResponseError(status) {
  if (status === 401 || status === 403) {
    return new MicrosoftError("authentication", translateMain("microsoft.error.authentication"));
  }
  if (status === 429) {
    return new MicrosoftError("rate-limit", translateMain("microsoft.error.rateLimit"));
  }
  if (status === 400) {
    return new MicrosoftError("parameter", translateMain("microsoft.error.parameter"));
  }
  return new MicrosoftError("service", translateMain("microsoft.error.serviceUnavailable"));
}
function normalizeMicrosoftNetworkError(error2) {
  if (error2 instanceof MicrosoftError) return error2;
  const name = error2 instanceof Error ? error2.name : "";
  const timeout = name === "AbortError" || name === "TimeoutError";
  return new MicrosoftError(
    "network",
    translateMain(timeout ? "microsoft.error.timeout" : "microsoft.error.network"),
    { cause: error2 }
  );
}
function toMicrosoftCheckStatus(error2) {
  const normalized = error2 instanceof MicrosoftError ? error2 : normalizeMicrosoftNetworkError(error2);
  switch (normalized.kind) {
    case "authentication":
      return {
        ok: false,
        code: "authentication",
        message: translateMain("microsoft.error.authenticationStatus")
      };
    case "rate-limit":
      return {
        ok: false,
        code: "rate-limit",
        message: translateMain("microsoft.error.rateLimitStatus")
      };
    case "parameter":
      return {
        ok: false,
        code: "parameter",
        message: translateMain("microsoft.error.parameterStatus")
      };
    case "network":
      return { ok: false, code: "network", message: normalized.message };
    default:
      return {
        ok: false,
        code: "service",
        message: translateMain("microsoft.error.serviceStatus")
      };
  }
}
const MICROSOFT_LANGUAGE_CODES = {
  ZH: "zh-Hans",
  EN: "en",
  JA: "ja",
  KO: "ko",
  FR: "fr",
  DE: "de",
  ES: "es",
  PT: "pt",
  IT: "it",
  NL: "nl",
  PL: "pl",
  RU: "ru",
  TR: "tr",
  ID: "id",
  UK: "uk",
  AR: "ar",
  SV: "sv",
  DA: "da",
  CS: "cs",
  EL: "el",
  FI: "fi",
  HU: "hu",
  RO: "ro",
  SK: "sk",
  BG: "bg",
  LT: "lt",
  LV: "lv",
  ET: "et",
  SL: "sl"
};
function normalizeMicrosoftLanguage(language) {
  return MICROSOFT_LANGUAGE_CODES[language.trim().toUpperCase()] ?? null;
}
function resolveMicrosoftLanguagePair(sourceLanguage, targetLanguage) {
  const target = normalizeMicrosoftLanguage(targetLanguage);
  if (!target) return { supported: false };
  if (sourceLanguage.trim().toLowerCase() === "auto") {
    return { supported: true, targetLanguage: target };
  }
  const source = normalizeMicrosoftLanguage(sourceLanguage);
  if (!source || source === target) return { supported: false };
  return { supported: true, sourceLanguage: source, targetLanguage: target };
}
const BING_TRANSLATOR_PAGE = "https://www.bing.com/translator";
const AUTH_EXPIRY_SAFETY_MARGIN_MS = 6e4;
const MAX_CHARS_PER_REQUEST = 1e3;
const EDGE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0";
class MicrosoftTranslationClient {
  constructor(options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 6e3;
  }
  now;
  timeoutMs;
  cachedAuthentication = null;
  authenticationPromise = null;
  /**
   * 翻译文本；网页会话失效时清理鉴权并自动重试一次。
   * @param text 待翻译文本。
   * @param pair 已验证受支持的微软语言对。
   * @returns 微软翻译结果。
   * @author zhenghq
   */
  async translate(text, pair) {
    try {
      return await this.translateChunks(text, pair);
    } catch (error2) {
      const normalized = normalizeMicrosoftNetworkError(error2);
      if (normalized.kind !== "authentication") throw normalized;
      this.reset();
      try {
        return await this.translateChunks(text, pair);
      } catch (retryError) {
        throw normalizeMicrosoftNetworkError(retryError);
      }
    }
  }
  /**
   * 清理已缓存的 Bing 页面鉴权和并发获取状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  reset() {
    this.cachedAuthentication = null;
    this.authenticationPromise = null;
  }
  /**
   * 将长文本拆成最多 1000 字符的分块并发翻译，再按原顺序合并结果。
   * @param text 待翻译文本。
   * @param pair 已验证的语言对。
   * @returns 合并后的翻译结果。
   * @author zhenghq
   */
  async translateChunks(text, pair) {
    const chunks = this.splitText(text);
    if (chunks.length === 0) {
      throw new MicrosoftError("parameter", translateMain("microsoft.error.textEmpty"));
    }
    const results = await Promise.all(chunks.map((chunk) => this.requestTranslation(chunk, pair)));
    const translation = results.map((result) => result.translation).join("");
    if (!translation) {
      throw new MicrosoftError("service", translateMain("microsoft.error.responseEmpty"));
    }
    return {
      translation,
      detectedLang: results.find((result) => result.detectedLang)?.detectedLang
    };
  }
  /**
   * 按 Bing 单次请求上限切分文本，并保留全部原始字符。
   * @param text 待切分文本。
   * @returns 按原顺序排列的非空文本分块。
   * @author zhenghq
   */
  splitText(text) {
    const chunks = [];
    for (let start = 0; start < text.length; start += MAX_CHARS_PER_REQUEST) {
      chunks.push(text.slice(start, start + MAX_CHARS_PER_REQUEST));
    }
    return chunks;
  }
  /**
   * 获取仍在安全有效期内的 Bing 页面鉴权，并合并并发获取请求。
   * @returns 可用于翻译表单的短期鉴权参数。
   * @author zhenghq
   */
  getAuthentication() {
    if (this.cachedAuthentication && this.cachedAuthentication.expiresAt > this.now()) {
      return Promise.resolve(this.cachedAuthentication);
    }
    if (this.authenticationPromise) return this.authenticationPromise;
    this.authenticationPromise = this.loadAuthentication().then((authentication) => {
      this.cachedAuthentication = authentication;
      return authentication;
    }).finally(() => {
      this.authenticationPromise = null;
    });
    return this.authenticationPromise;
  }
  /**
   * 请求 Bing 翻译网页并解析短期防滥用参数。
   * @returns 带本地安全失效时间的鉴权参数。
   * @author zhenghq
   */
  async loadAuthentication() {
    const response = await this.fetchWithTimeout(BING_TRANSLATOR_PAGE, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": EDGE_USER_AGENT
      }
    });
    if (!response.ok) throw createMicrosoftResponseError(response.status);
    let html;
    try {
      html = await response.text();
    } catch (error2) {
      throw new MicrosoftError(
        "service",
        translateMain("microsoft.error.pageReadFailed"),
        { cause: error2 }
      );
    }
    const pageContext = this.resolvePageContext(response.url);
    return this.parseAuthentication(html, pageContext);
  }
  /**
   * 解析跟随重定向后的 Bing 区域站点，并阻止向非 Bing 域名发送临时参数。
   * @param responseUrl fetch 最终响应地址；测试响应可能为空。
   * @returns 规范化后的 Bing 来源和翻译页面地址。
   * @author zhenghq
   */
  resolvePageContext(responseUrl) {
    let parsed;
    try {
      parsed = new URL(responseUrl || BING_TRANSLATOR_PAGE);
    } catch {
      throw new MicrosoftError("service", translateMain("microsoft.error.redirectInvalid"));
    }
    const hostname = parsed.hostname.toLowerCase();
    const trustedHost = hostname === "bing.com" || hostname.endsWith(".bing.com");
    if (parsed.protocol !== "https:" || !trustedHost) {
      throw new MicrosoftError("service", translateMain("microsoft.error.redirectInvalid"));
    }
    return {
      origin: parsed.origin,
      pageUrl: new URL("/translator", parsed.origin).toString()
    };
  }
  /**
   * 从 Bing 翻译网页 HTML 中提取 Key、Token、TTL、IG 和 IID。
   * @param html Bing 翻译网页 HTML。
   * @param pageContext 实际 Bing 区域站点上下文。
   * @returns 可缓存的短期鉴权参数。
   * @author zhenghq
   */
  parseAuthentication(html, pageContext) {
    const prevention = /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*\]/u.exec(html);
    const ig = /IG\s*:\s*"([A-Fa-f0-9]+)"/u.exec(html)?.[1];
    const iid = /data-iid\s*=\s*"([^"]+)"/u.exec(html)?.[1];
    if (!prevention || !ig || !iid) {
      throw new MicrosoftError(
        "service",
        translateMain("microsoft.error.authParametersParse")
      );
    }
    const ttlMs = Number(prevention[3]);
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new MicrosoftError("service", translateMain("microsoft.error.authExpiryInvalid"));
    }
    return {
      ...pageContext,
      ig,
      iid,
      key: prevention[1],
      token: prevention[2],
      expiresAt: this.now() + Math.max(0, ttlMs - AUTH_EXPIRY_SAFETY_MARGIN_MS)
    };
  }
  /**
   * 使用短期网页鉴权发送一次 Bing 表单翻译请求。
   * @param text 不超过 1000 字符的待翻译分块。
   * @param pair 已验证的语言对。
   * @returns 单个分块的翻译结果。
   * @author zhenghq
   */
  async requestTranslation(text, pair) {
    const authentication = await this.getAuthentication();
    const query = new URLSearchParams({
      isVertical: "1",
      IG: authentication.ig,
      IID: authentication.iid
    });
    const form = new URLSearchParams({
      text,
      fromLang: pair.sourceLanguage ?? "auto-detect",
      to: pair.targetLanguage,
      token: authentication.token,
      key: authentication.key
    });
    const endpoint = new URL("/ttranslatev3", authentication.origin);
    endpoint.search = query.toString();
    const response = await this.fetchWithTimeout(endpoint.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: authentication.origin,
        Referer: authentication.pageUrl,
        "User-Agent": EDGE_USER_AGENT
      },
      body: form.toString()
    });
    if (!response.ok) throw createMicrosoftResponseError(response.status);
    return this.readResponse(response, pair);
  }
  /**
   * 使用应用翻译网络会话发送带超时的 Bing 请求。
   * @param url 请求地址。
   * @param init 请求参数。
   * @returns 网络响应。
   * @author zhenghq
   */
  async fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.options.fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * 安全解析 Bing 翻译 JSON 响应，禁止将原始响应放入错误消息。
   * @param response Bing 翻译接口响应。
   * @param pair 本次请求语言对，用于显式源语言的统一回显。
   * @returns 解析后的统一翻译结果。
   * @author zhenghq
   */
  async readResponse(response, pair) {
    let payload;
    try {
      payload = await response.json();
    } catch (error2) {
      throw new MicrosoftError(
        "service",
        translateMain("microsoft.error.responseParse"),
        { cause: error2 }
      );
    }
    const item = Array.isArray(payload) ? payload[0] : void 0;
    const translation = typeof item?.translations?.[0]?.text === "string" ? item.translations[0].text : "";
    if (!translation) {
      throw new MicrosoftError("service", translateMain("microsoft.error.responseEmpty"));
    }
    const detected = typeof item?.detectedLanguage?.language === "string" ? item.detectedLanguage.language : pair.sourceLanguage;
    return {
      translation,
      detectedLang: detected ? this.normalizeDetectedLanguage(detected) : void 0
    };
  }
  /**
   * 规范化微软语言代码为应用内部展示代码。
   * @param language Bing 在线翻译返回或请求使用的语言代码。
   * @returns 应用内部大写语言代码。
   * @author zhenghq
   */
  normalizeDetectedLanguage(language) {
    const normalized = language.toLowerCase();
    if (normalized.startsWith("zh")) return "ZH";
    return normalized.split("-")[0].toUpperCase();
  }
}
class AiError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.kind = kind;
    this.name = "AiError";
  }
}
function createAiResponseError(status) {
  if (status === 401 || status === 403) return new AiError("authentication", translateMain("ai.error.authentication"));
  if (status === 429) return new AiError("rate-limit", translateMain("ai.error.rateLimit"));
  if (status === 404) return new AiError("not-found", translateMain("ai.error.notFound"));
  if (status >= 500) return new AiError("service", translateMain("ai.error.serviceUnavailable"));
  return new AiError("service", translateMain("ai.error.httpStatus", { status }));
}
function normalizeAiNetworkError(error2) {
  if (error2 instanceof AiError) return error2;
  const name = error2 instanceof Error ? error2.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return new AiError("timeout", translateMain("ai.error.timeout"), { cause: error2 });
  }
  return new AiError("network", translateMain("ai.error.network"), { cause: error2 });
}
const REASONING_BLOCK = /<\s*(think|thinking|reasoning|scratchpad)\s*>[\s\S]*?<\s*\/\s*\1\s*>/giu;
const WRAPPING_CODE_FENCE = /^```[A-Za-z0-9_+-]*\s*\n([\s\S]*?)\n?```$/u;
const TRANSLATION_LABEL = /^(?:译文|翻译结果|翻译|Translation|Translated(?:\s+text)?|Output)\s*[:：]\s*/iu;
const TOOL_CALL_NOISE = new RegExp(
  [
    "(?:\\b(?:search|web_search|browse|browser|open|click|fetch|tool|tool_call|function_call|functions?\\.[\\w.]+)",
    `\\s*\\((?:"[^"]*"|'[^']*'|[^()]*)\\)\\s*)`,
    "(?:[A-Za-z_][\\w-]*\\s*\\|\\s*)*",
    "(?:translate\\s+(?:phrase|sentence|word|words|text|paragraph|line|segment)?\\s*)?"
  ].join(""),
  "giu"
);
const DIRECTIVE_LINE_NOISE = /^(?:[A-Za-z_][\w-]*\s*\|\s*)*translate\s+(?:phrase|sentence|word|words|text|paragraph|line|segment)\s*$/iu;
function sanitizeAiTranslation(raw) {
  let text = String(raw ?? "").replace(/\r\n?/gu, "\n");
  if (!text.trim()) return "";
  text = text.replace(REASONING_BLOCK, "");
  const fenced = text.trim().match(WRAPPING_CODE_FENCE);
  if (fenced) text = fenced[1];
  const lines = [];
  for (const line of text.split("\n")) {
    const stripped = line.replace(TOOL_CALL_NOISE, "").trim();
    const isNoiseOnlyLine = stripped !== line.trim() && stripped === "";
    if (isNoiseOnlyLine) continue;
    if (DIRECTIVE_LINE_NOISE.test(stripped)) continue;
    lines.push(stripped);
  }
  return lines.join("\n").replace(TRANSLATION_LABEL, "").trim();
}
function normalizeAiBaseUrl(baseUrl) {
  return baseUrl.trim().replace(/\/+$/u, "");
}
function buildTranslationSystemPrompt(sourceLang, targetLang) {
  return [
    "你是一个专业翻译引擎，请将用户输入的文本从",
    sourceLang,
    "翻译为",
    targetLang,
    "，只输出译文，保留换行和基本格式，不要输出解释、思考过程、工具调用、Markdown 代码块或额外引号。",
    "若原文包含形如 [[[ST-SEG-数字]]] 的分段标记，必须原样保留这些标记，不得翻译、改写、增删或调整其顺序。"
  ].join("");
}
function buildAiTranslationRequest(input) {
  const baseUrl = normalizeAiBaseUrl(input.baseUrl);
  const stream = input.stream === true;
  const systemPrompt = buildTranslationSystemPrompt(input.sourceLang, input.targetLang);
  const headers = /* @__PURE__ */ new Map([["Content-Type", "application/json"]]);
  switch (input.protocol) {
    case "ollama": {
      const body = JSON.stringify({
        model: input.model,
        stream,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input.text }
        ]
      });
      return { method: "POST", url: `${baseUrl}/api/chat`, headers, body };
    }
    case "openai": {
      if (input.apiKey) headers.set("Authorization", `Bearer ${input.apiKey}`);
      const body = JSON.stringify({
        model: input.model,
        stream,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input.text }
        ]
      });
      return { method: "POST", url: `${baseUrl}/chat/completions`, headers, body };
    }
    case "claude-code": {
      if (input.apiKey) headers.set("x-api-key", input.apiKey);
      headers.set("anthropic-version", "2023-06-01");
      const body = JSON.stringify({
        model: input.model,
        max_tokens: 1024,
        stream,
        system: systemPrompt,
        messages: [
          { role: "user", content: input.text }
        ]
      });
      return { method: "POST", url: `${baseUrl}/v1/messages`, headers, body };
    }
    default: {
      throw new Error(`不支持的 AI 协议：${input.protocol}`);
    }
  }
}
function extractAiTranslation(protocol, data) {
  return extractTranslation(protocol, data);
}
function extractTranslation(protocol, data) {
  return sanitizeAiTranslation(extractRawTranslation(protocol, data));
}
function extractRawTranslation(protocol, data) {
  switch (protocol) {
    case "ollama": {
      const message = data.message;
      return String(message?.content ?? "").trim();
    }
    case "openai": {
      const choices = data.choices;
      return String(choices?.[0]?.message?.content ?? "").trim();
    }
    case "claude-code": {
      const content = data.content;
      if (!Array.isArray(content)) return "";
      return content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => String(block.text)).join("").trim();
    }
    default:
      return "";
  }
}
function createAiStreamParser(protocol) {
  if (protocol === "ollama") return new OllamaLineStreamParser();
  if (protocol === "claude-code") return new SseStreamParser("claude-code");
  return new SseStreamParser("openai");
}
function extractStreamDelta(protocol, data) {
  if (data.error) {
    throw new AiError("service", translateMain("ai.error.serviceUnavailable"));
  }
  if (protocol === "openai") {
    const choices = data.choices;
    return String(choices?.[0]?.delta?.content ?? "");
  }
  if (protocol === "claude-code") {
    if (data.type === "error") {
      throw new AiError("service", translateMain("ai.error.serviceUnavailable"));
    }
    if (data.type !== "content_block_delta") return "";
    const delta = data.delta;
    if (delta?.type !== "text_delta") return "";
    return String(delta.text ?? "");
  }
  return "";
}
class SseStreamParser {
  constructor(protocol) {
    this.protocol = protocol;
  }
  buffer = "";
  done = false;
  /**
   * 追加网络分片，按空行切分完整 SSE 事件并解析文本增量。
   * @param chunk 网络分片文本。
   * @returns 本次解析出的文本增量。
   * @author zhenghq
   */
  push(chunk) {
    if (this.done) return [];
    this.buffer += chunk;
    const deltas = [];
    let separator = this.buffer.search(/\r?\n\r?\n/u);
    while (separator >= 0) {
      const rawEvent = this.buffer.slice(0, separator);
      const separatorLength = this.buffer[separator] === "\r" ? 4 : 2;
      this.buffer = this.buffer.slice(separator + separatorLength);
      const delta = this.parseEvent(rawEvent);
      if (delta) deltas.push(delta);
      separator = this.buffer.search(/\r?\n\r?\n/u);
    }
    return deltas;
  }
  /**
   * 冲刷末尾尚未以空行结束的 SSE 事件。
   * @returns 剩余文本增量。
   * @author zhenghq
   */
  finish() {
    if (this.done || !this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const rawEvent = this.buffer;
    this.buffer = "";
    const delta = this.parseEvent(rawEvent);
    return delta ? [delta] : [];
  }
  /**
   * 解析单个 SSE 事件的所有 data 行。
   * @param rawEvent 不含事件分隔符的事件文本。
   * @returns 事件中的文本增量。
   * @author zhenghq
   */
  parseEvent(rawEvent) {
    const dataLines = rawEvent.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return "";
    const payload = dataLines.join("\n").trim();
    if (!payload) return "";
    if (payload === "[DONE]") {
      this.done = true;
      return "";
    }
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return "";
    }
    return extractStreamDelta(this.protocol, data);
  }
}
class OllamaLineStreamParser {
  buffer = "";
  done = false;
  /**
   * 追加网络分片，按换行切分完整 JSON 行并解析文本增量。
   * @param chunk 网络分片文本。
   * @returns 本次解析出的文本增量。
   * @author zhenghq
   */
  push(chunk) {
    if (this.done) return [];
    this.buffer += chunk;
    const deltas = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      const delta = this.parseLine(line);
      if (delta) deltas.push(delta);
      newline = this.buffer.indexOf("\n");
    }
    return deltas;
  }
  /**
   * 冲刷末尾没有换行的 JSON 行。
   * @returns 剩余文本增量。
   * @author zhenghq
   */
  finish() {
    if (this.done || !this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const line = this.buffer.trim();
    this.buffer = "";
    const delta = this.parseLine(line);
    return delta ? [delta] : [];
  }
  /**
   * 解析单行 Ollama JSON。
   * @param line 去掉首尾空白的 JSON 行。
   * @returns 文本增量。
   * @author zhenghq
   */
  parseLine(line) {
    if (!line || this.done) return "";
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      return "";
    }
    if (data.error) {
      throw new AiError("service", translateMain("ai.error.serviceUnavailable"));
    }
    if (data.done === true) this.done = true;
    const message = data.message;
    return String(message?.content ?? "");
  }
}
const TOOL_KEYWORDS = [
  "search",
  "web_search",
  "browse",
  "browser",
  "open",
  "click",
  "fetch",
  "tool",
  "tool_call",
  "function_call",
  "function",
  "functions"
];
const TRANSLATION_LABELS = [
  "译文：",
  "译文:",
  "翻译结果：",
  "翻译结果:",
  "翻译：",
  "翻译:",
  "Translation:",
  "Translated text:",
  "Output:"
];
function findUnstableStart(raw) {
  const candidates = [];
  const partialTag = findPartialReasoningTagStart(raw);
  if (partialTag !== null) candidates.push(partialTag);
  const reasoning = findUnclosedReasoningStart(raw);
  if (reasoning !== null) candidates.push(reasoning);
  const fence = findUnclosedFenceStart(raw);
  if (fence !== null) candidates.push(fence);
  const label = findPartialTranslationLabelStart(raw);
  if (label !== null) candidates.push(label);
  const tool = findPartialToolCallStart(raw);
  if (tool !== null) candidates.push(tool);
  if (candidates.length === 0) return raw.length;
  return Math.min(...candidates);
}
function findPartialReasoningTagStart(raw) {
  const lastLt = raw.lastIndexOf("<");
  if (lastLt < 0 || raw.indexOf(">", lastLt) >= 0) return null;
  const partial = raw.slice(lastLt).toLowerCase();
  const isPrefix = ["think", "thinking", "reasoning", "scratchpad"].some(
    (name) => `<${name}`.startsWith(partial)
  );
  return isPrefix ? lastLt : null;
}
function findUnclosedReasoningStart(raw) {
  const pattern = /<\s*(\/?)\s*(think|thinking|reasoning|scratchpad)\s*>/giu;
  let openStart = null;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    if (match[1] === "/") {
      if (openStart !== null) openStart = null;
    } else {
      openStart = match.index;
    }
  }
  return openStart;
}
function findUnclosedFenceStart(raw) {
  const start = raw.search(/\S/u);
  if (start < 0 || raw.slice(start, start + 3) !== "```") return null;
  const fences = raw.match(/```/gu);
  const count = fences?.length ?? 0;
  return count % 2 === 1 ? start : null;
}
function findPartialTranslationLabelStart(raw) {
  const start = raw.search(/\S/u);
  if (start < 0) return null;
  const rest = raw.slice(start);
  const normalized = rest.toLowerCase();
  const isPrefix = TRANSLATION_LABELS.some((label) => {
    const lower = label.toLowerCase();
    return rest.length < label.length && lower.startsWith(normalized);
  });
  return isPrefix ? start : null;
}
function findPartialToolCallStart(raw) {
  const lineStart = raw.lastIndexOf("\n") + 1;
  const line = raw.slice(lineStart);
  const trimmed = line.trimStart();
  if (!trimmed) return null;
  const offset = lineStart + (line.length - trimmed.length);
  const trailing = /([A-Za-z_][\w.]*)$/u.exec(trimmed);
  if (trailing) {
    const token = trailing[1].toLowerCase();
    if (TOOL_KEYWORDS.some((keyword) => keyword.startsWith(token))) {
      return offset + trailing.index;
    }
  }
  const keywordPattern = new RegExp(`\\b(?:${TOOL_KEYWORDS.join("|")})\\s*\\(`, "iu");
  const open = keywordPattern.exec(trimmed);
  if (open && !hasBalancedParenthesis(trimmed, open.index + open[0].length - 1)) {
    return offset + open.index;
  }
  if (/\|\s*[A-Za-z_-]*$/u.test(trimmed)) {
    return offset;
  }
  return null;
}
function hasBalancedParenthesis(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return true;
    }
  }
  return false;
}
class AiTranslationStreamSanitizer {
  raw = "";
  emitted = "";
  /**
   * 追加一段原始流式文本并返回新增的安全译文片段。
   * @param chunk 原始流式文本片段。
   * @returns 本次可以安全展示的新增译文；尚未稳定时返回空字符串。
   * @author zhenghq
   */
  push(chunk) {
    this.raw += chunk;
    return this.flushStable();
  }
  /**
   * 结束流式输入并返回完整最终清洗译文，供界面校正、缓存和复制使用。
   * @returns 完整最终清洗译文。
   * @author zhenghq
   */
  finish() {
    const cleaned = sanitizeAiTranslation(this.raw);
    this.emitted = cleaned;
    return cleaned;
  }
  /**
   * 计算并返回当前已经稳定的新增译文。
   * @returns 新增译文片段。
   * @author zhenghq
   */
  flushStable() {
    const stableRaw = this.raw.slice(0, findUnstableStart(this.raw));
    const cleaned = sanitizeAiTranslation(stableRaw);
    if (!cleaned.startsWith(this.emitted)) {
      this.emitted = cleaned;
      return cleaned;
    }
    const delta = cleaned.slice(this.emitted.length);
    this.emitted = cleaned;
    return delta;
  }
}
class AiTranslationClient {
  constructor(options) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 2e4;
  }
  timeoutMs;
  /**
    * 执行一次非流式 AI 翻译请求并返回统一译文。
  * @param input 协议、Base URL、模型、凭证和语言信息。
  * @returns 去除首尾空白后的译文。
  * @author zhenghq
    */
  async translate(input) {
    const built = this.buildRequest(input, false);
    const headers = {};
    built.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortPromise = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new AiError("timeout", translateMain("ai.error.timeout")));
      });
    });
    let response;
    try {
      response = await Promise.race([
        this.options.fetch(built.url, {
          method: built.method,
          headers,
          body: built.body,
          signal: controller.signal
        }),
        abortPromise
      ]);
    } catch (error2) {
      clearTimeout(timer);
      throw normalizeAiNetworkError(error2);
    }
    clearTimeout(timer);
    if (!response.ok) {
      throw createAiResponseError(response.status);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      throw new AiError("service", translateMain("ai.error.nonJsonResponse"));
    }
    let data;
    try {
      data = await response.json();
    } catch (error2) {
      throw new AiError("service", translateMain("ai.error.responseParse"), { cause: error2 });
    }
    const translation = extractAiTranslation(input.protocol, data);
    if (!translation) {
      throw new AiError("service", translateMain("ai.error.emptyTranslation"));
    }
    return translation;
  }
  /**
   * 执行一次真实流式 AI 翻译请求，按安全片段回调并在结束时返回最终清洗译文。
   * @param input 协议、Base URL、模型、凭证和语言信息。
   * @param options 增量回调与取消信号。
   * @returns 最终清洗后的完整译文。
   * @author zhenghq
   */
  async stream(input, options) {
    const built = this.buildRequest(input, true);
    const headers = {};
    built.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    let response;
    try {
      response = await this.options.fetch(built.url, {
        method: built.method,
        headers,
        body: built.body,
        signal: controller.signal
      });
    } catch (error2) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
      throw normalizeAiNetworkError(error2);
    }
    if (!response.ok) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
      throw createAiResponseError(response.status);
    }
    if (!response.body) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
      throw new AiError("service", translateMain("ai.error.emptyTranslation"));
    }
    const parser = createAiStreamParser(input.protocol);
    const sanitizer = new AiTranslationStreamSanitizer();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let finalTranslation = "";
    try {
      while (true) {
        if (controller.signal.aborted) throw new AiError("timeout", translateMain("ai.error.timeout"));
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const rawDelta of parser.push(text)) {
          const safe = sanitizer.push(rawDelta);
          if (safe) {
            finalTranslation += safe;
            options.onDelta(safe);
          }
        }
      }
      for (const rawDelta of parser.finish()) {
        const safe = sanitizer.push(rawDelta);
        if (safe) {
          finalTranslation += safe;
          options.onDelta(safe);
        }
      }
      finalTranslation = sanitizer.finish();
    } catch (error2) {
      throw normalizeAiNetworkError(error2);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
    if (!finalTranslation) {
      throw new AiError("service", translateMain("ai.error.emptyTranslation"));
    }
    return finalTranslation;
  }
  /**
   * 构造协议请求并统一转换构造错误。
   * @param input 协议、Base URL、模型、凭证和语言信息。
   * @param stream 是否构造流式请求。
   * @returns 可供网络请求使用的统一请求结构。
   * @author zhenghq
   */
  buildRequest(input, stream) {
    try {
      return buildAiTranslationRequest({
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: input.apiKey,
        text: input.text,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        stream
      });
    } catch (error2) {
      throw new AiError("service", translateMain("ai.error.requestBuild"), { cause: error2 });
    }
  }
  /**
    * 规范化 Base URL，供外部复用。
  * @param baseUrl 原始 Base URL。
  * @returns 规范化后的 Base URL。
  * @author zhenghq
    */
  normalizeBaseUrl(baseUrl) {
    return normalizeAiBaseUrl(baseUrl);
  }
}
class BoundedLruCache {
  entries = /* @__PURE__ */ new Map();
  maxEntries;
  maxBytes;
  sizeOf;
  bytes = 0;
  /**
   * 创建有界 LRU 缓存。
   * @param options 条目上限、容量上限和估算函数。
   * @author zhenghq
   */
  constructor(options) {
    this.maxEntries = Math.max(0, Math.floor(options.maxEntries));
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes));
    this.sizeOf = options.sizeOf;
  }
  /**
   * 返回当前缓存条目数。
   * @returns 当前条目数。
   * @author zhenghq
   */
  get size() {
    return this.entries.size;
  }
  /**
   * 返回当前估算容量。
   * @returns 当前估算字节数。
   * @author zhenghq
   */
  get estimatedBytes() {
    return this.bytes;
  }
  /**
   * 读取缓存并刷新最近使用顺序。
   * @param key 缓存键。
   * @returns 命中的缓存值，未命中时返回 undefined。
   * @author zhenghq
   */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return void 0;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  /**
   * 判断缓存键是否存在但不改变最近使用顺序。
   * @param key 缓存键。
   * @returns 缓存键是否存在。
   * @author zhenghq
   */
  has(key) {
    return this.entries.has(key);
  }
  /**
   * 写入缓存并淘汰最久未使用条目。
   * @param key 缓存键。
   * @param value 缓存值。
   * @returns 当前值是否成功保留在缓存中。
   * @author zhenghq
   */
  set(key, value) {
    this.delete(key);
    const bytes = Math.max(0, Math.ceil(this.sizeOf(key, value)));
    if (this.maxEntries === 0 || this.maxBytes === 0 || bytes > this.maxBytes) return false;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    this.trim();
    return this.entries.has(key);
  }
  /**
   * 删除指定缓存条目。
   * @param key 缓存键。
   * @returns 是否删除了已有条目。
   * @author zhenghq
   */
  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    return true;
  }
  /**
   * 清空全部缓存条目。
   * @returns 无返回值。
   * @author zhenghq
   */
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
  /**
   * 按从最久未使用到最近使用的顺序返回缓存键。
   * @returns 缓存键数组。
   * @author zhenghq
   */
  keys() {
    return Array.from(this.entries.keys());
  }
  /**
   * 淘汰超过条目数或容量限制的最旧条目。
   * @returns 无返回值。
   * @author zhenghq
   */
  trim() {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === void 0) return;
      this.delete(oldest);
    }
  }
}
const PUBLIC_DEEPLX = "https://api.deeplx.org/mRZmM06yhhNJw55Vx87G2CuVvw0FYNtaOAkzo5UQVYI/translate";
const GOOGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";
const DINGTALK_CHANNEL = "dingtalk";
const MICROSOFT_CHANNEL = "microsoft";
const AI_CHANNEL = "ai";
const MAX_CHARS = 5e3;
const GOOGLE_MAX_CHARS = 2e3;
const MYMEMORY_MAX_CHARS = 500;
function parseDeepLxUrls(value) {
  return [...new Set(value.split(/[,，]/u).map((url) => url.trim()).filter(Boolean))];
}
function estimateCachedTranslationBytes(key, value) {
  return (key.length + value.translation.length + (value.detectedLang?.length ?? 0) + value.provider.length + value.channel.length) * 2;
}
class TranslationRuntime {
  constructor(options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    const tokenManager = new DingTalkTokenManager({ fetch: options.fetch, now: this.now });
    this.dingTalkClient = new DingTalkTranslationClient({
      fetch: options.fetch,
      tokenManager
    });
    this.microsoftClient = new MicrosoftTranslationClient({ fetch: options.fetch, now: this.now });
    this.aiClient = new AiTranslationClient({ fetch: options.fetch });
  }
  cache = new BoundedLruCache({
    maxEntries: 5e4,
    maxBytes: 50 * 1024 * 1024,
    sizeOf: estimateCachedTranslationBytes
  });
  breaker = /* @__PURE__ */ new Map();
  now;
  dingTalkClient;
  microsoftClient;
  aiClient;
  deepLxRoundRobinIndex = 0;
  /**
   * 按用户首选 API、默认顺序执行翻译并自动降级。
   * @param text 待翻译文本。
   * @param settings 当前公开设置快照。
   * @param dingTalkCredentials 主进程解密后的钉钉凭证快照。
   * @param aiApiKey 主进程解密后的 AI API Key。
   * @returns 首个成功通道的统一翻译结果。
   * @author zhenghq
   */
  async translate(text, settings, dingTalkCredentials = null, aiApiKey = null) {
    if (text.length > MAX_CHARS) {
      throw new Error(translateMain("translate.error.tooLong", { max: MAX_CHARS }));
    }
    const input = text;
    const key = this.cacheKey(
      input,
      settings.sourceLang,
      settings.targetLang,
      settings.preferredTranslationProvider,
      settings.aiEnabled,
      settings.aiProtocol,
      settings.aiBaseUrl,
      settings.aiModel
    );
    const hit = this.cache.get(key);
    if (hit) return { ...hit, channel: translateMain("translate.channel.cached") };
    const channels = this.createChannels(input, settings, dingTalkCredentials, aiApiKey);
    let lastError = translateMain("translate.error.allChannelsFailed");
    for (const channel of channels) {
      if (input.length > channel.maxChars) {
        console.warn(`[translate] 跳过 ${channel.name}（输入超过 ${channel.maxChars} 字符）`);
        continue;
      }
      if (this.isTripped(channel.breakerKey)) {
        console.warn(`[translate] 跳过 ${channel.name}（熔断中）`);
        continue;
      }
      try {
        const output = await channel.run();
        this.resetBreaker(channel.breakerKey);
        const successful = {
          ...output,
          channel: channel.name,
          provider: channel.id
        };
        if (settings.preferredTranslationProvider === "auto" || settings.preferredTranslationProvider === channel.id) {
          this.cache.set(key, successful);
        }
        console.log(`[translate] 成功，通道 = ${channel.name}`);
        return successful;
      } catch (error2) {
        const message = error2 instanceof Error ? error2.message : translateMain("translate.error.unknown");
        lastError = `${channel.name}: ${message}`;
        this.trip(channel.breakerKey, channel.cooldownMs);
        console.warn(`[translate] ${lastError}`);
      }
    }
    throw new Error(lastError);
  }
  /**
   * 按多通道顺序执行翻译，AI 通道使用真实流式回调；其它通道返回完整结果。
   * 首个安全片段出现前允许继续降级，出现后失败则保留已展示内容并停止降级。
   * @param text 待翻译文本。
   * @param settings 当前公开设置快照。
   * @param dingTalkCredentials 主进程解密后的钉钉凭证快照。
   * @param aiApiKey 主进程解密后的 AI API Key。
   * @param options 增量回调与取消信号。
   * @returns 首个成功通道的统一翻译结果。
   * @author zhenghq
   */
  async translateStream(text, settings, dingTalkCredentials, aiApiKey, options) {
    if (text.length > MAX_CHARS) {
      throw new Error(translateMain("translate.error.tooLong", { max: MAX_CHARS }));
    }
    const input = text;
    const key = this.cacheKey(
      input,
      settings.sourceLang,
      settings.targetLang,
      settings.preferredTranslationProvider,
      settings.aiEnabled,
      settings.aiProtocol,
      settings.aiBaseUrl,
      settings.aiModel
    );
    const hit = this.cache.get(key);
    if (hit) return { ...hit, channel: translateMain("translate.channel.cached") };
    const channels = this.createChannels(input, settings, dingTalkCredentials, aiApiKey);
    let lastError = translateMain("translate.error.allChannelsFailed");
    for (const channel of channels) {
      if (input.length > channel.maxChars) continue;
      if (this.isTripped(channel.breakerKey)) continue;
      let visibleDeltaCount = 0;
      try {
        const output = channel.id === "ai" ? await this.aiStreamChannel(text, settings, aiApiKey, (delta) => {
          visibleDeltaCount += 1;
          options.onDelta(delta);
        }, options.signal) : await channel.run();
        this.resetBreaker(channel.breakerKey);
        const successful = {
          ...output,
          channel: channel.name,
          provider: channel.id
        };
        if (settings.preferredTranslationProvider === "auto" || settings.preferredTranslationProvider === channel.id) {
          this.cache.set(key, successful);
        }
        return successful;
      } catch (error2) {
        const message = error2 instanceof Error ? error2.message : translateMain("translate.error.unknown");
        lastError = `${channel.name}: ${message}`;
        this.trip(channel.breakerKey, channel.cooldownMs);
        if (visibleDeltaCount > 0) throw error2;
      }
    }
    throw new Error(lastError);
  }
  /**
   * 不经过普通翻译缓存检测钉钉 Token 和文本翻译链路。
   * @param credentials 当前主进程凭证快照。
   * @returns 设置页可展示的结构化脱敏状态。
   * @author zhenghq
   */
  async checkDingTalk(credentials) {
    if (!credentials) {
      return toDingTalkCheckStatus(new DingTalkError("configuration", translateMain("translate.check.dingtalkIncomplete")));
    }
    try {
      await this.dingTalkClient.translate(translateMain("translate.check.sampleText"), {
        supported: true,
        sourceLanguage: "zh",
        targetLanguage: "en"
      }, credentials);
      return { ok: true, code: "available", message: translateMain("translate.check.dingtalkAvailable") };
    } catch (error2) {
      return toDingTalkCheckStatus(error2);
    }
  }
  /**
   * 不经过普通翻译结果缓存检测免订阅微软文本翻译链路。
   * @returns 设置页可展示的结构化脱敏状态。
   * @author zhenghq
   */
  async checkMicrosoft() {
    try {
      await this.microsoftClient.translate(translateMain("translate.check.sampleText"), {
        supported: true,
        sourceLanguage: "zh-Hans",
        targetLanguage: "en"
      });
      return { ok: true, code: "available", message: translateMain("translate.check.microsoftAvailable") };
    } catch (error2) {
      return toMicrosoftCheckStatus(error2);
    }
  }
  /**
   * 在微软启用状态变化后清理结果缓存、网页鉴权和微软熔断状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  resetMicrosoftRuntime() {
    this.cache.clear();
    this.microsoftClient.reset();
    this.resetBreaker(MICROSOFT_CHANNEL);
  }
  /**
   * 在钉钉配置变化后清理全部结果缓存、Token/Promise 和钉钉熔断状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  resetDingTalkRuntime() {
    this.cache.clear();
    this.dingTalkClient.reset();
    this.resetBreaker(DINGTALK_CHANNEL);
  }
  /**
   * 在 DeepLX 地址变化后清理缓存、轮询位置及全部自建地址熔断。
   * @returns 无返回值。
   * @author zhenghq
   */
  resetDeepLxRuntime() {
    this.cache.clear();
    this.deepLxRoundRobinIndex = 0;
    for (const key of this.breaker.keys()) {
      if (key.startsWith("deeplx-self:")) this.breaker.delete(key);
    }
  }
  /**
   * 根据配置和语言对构建本次翻译通道列表。
   * @param text 已截断的待翻译文本。
   * @param settings 当前公开设置。
   * @param dingTalkCredentials 当前主进程钉钉凭证快照。
   * @param aiApiKey 当前主进程 AI API Key 快照。
   * @returns 按优先级排列的翻译通道。
   * @author zhenghq
   */
  createChannels(text, settings, dingTalkCredentials, aiApiKey) {
    const channels = [];
    if (settings.aiEnabled && settings.aiBaseUrl.trim() && settings.aiModel.trim()) {
      channels.push({
        id: "ai",
        name: translateMain("translate.channel.ai"),
        breakerKey: AI_CHANNEL,
        cooldownMs: 6e4,
        maxChars: MAX_CHARS,
        run: () => this.aiChannel(text, settings, aiApiKey)
      });
    }
    if (settings.dingTalkEnabled && settings.dingTalkCorpId && settings.dingTalkClientId && settings.dingTalkSecretConfigured && dingTalkCredentials) {
      const pair = resolveDingTalkLanguagePair(text, settings.sourceLang, settings.targetLang);
      if (pair.supported) {
        channels.push({
          id: "dingtalk",
          name: translateMain("translate.channel.dingtalk"),
          breakerKey: DINGTALK_CHANNEL,
          cooldownMs: 6e4,
          maxChars: MAX_CHARS,
          run: () => this.dingTalkClient.translate(text, pair, dingTalkCredentials)
        });
      }
    }
    if (settings.microsoftEnabled) {
      const pair = resolveMicrosoftLanguagePair(settings.sourceLang, settings.targetLang);
      if (pair.supported) {
        channels.push({
          id: "microsoft",
          name: translateMain("translate.channel.microsoft"),
          breakerKey: MICROSOFT_CHANNEL,
          cooldownMs: 6e4,
          maxChars: MAX_CHARS,
          run: () => this.microsoftClient.translate(text, pair)
        });
      }
    }
    const selfHosts = parseDeepLxUrls(settings.deepLxUrl);
    if (selfHosts.length > 0) {
      const start = this.deepLxRoundRobinIndex % selfHosts.length;
      this.deepLxRoundRobinIndex = (this.deepLxRoundRobinIndex + 1) % selfHosts.length;
      const orderedHosts = [...selfHosts.slice(start), ...selfHosts.slice(0, start)];
      orderedHosts.forEach((selfHost, index) => {
        channels.push({
          id: "deeplx-self",
          name: selfHosts.length === 1 ? translateMain("translate.channel.selfHostedDeepLx") : translateMain("translate.channel.selfHostedDeepLxIndexed", { index: index + 1 }),
          breakerKey: `deeplx-self:${selfHost}`,
          cooldownMs: 15e3,
          maxChars: MAX_CHARS,
          run: () => this.deepLxChannel(selfHost, text, settings, 2500)
        });
      });
    }
    channels.push({
      id: "deeplx-public",
      name: translateMain("translate.channel.publicDeepLx"),
      breakerKey: "deeplx-public",
      cooldownMs: 12e4,
      maxChars: MAX_CHARS,
      run: () => this.deepLxChannel(PUBLIC_DEEPLX, text, settings, 3e3)
    });
    channels.push({
      id: "google",
      name: "Google",
      breakerKey: "Google",
      cooldownMs: 6e4,
      maxChars: GOOGLE_MAX_CHARS,
      run: () => this.googleChannel(text, settings)
    });
    channels.push({
      id: "mymemory",
      name: "MyMemory",
      breakerKey: "MyMemory",
      cooldownMs: 6e4,
      maxChars: MYMEMORY_MAX_CHARS,
      run: () => this.myMemoryChannel(text, settings)
    });
    const preferred = settings.preferredTranslationProvider;
    if (preferred === "auto") return channels;
    const preferredChannels = channels.filter((channel) => channel.id === preferred);
    if (preferredChannels.length === 0 || channels[0]?.id === preferred) return channels;
    return [...preferredChannels, ...channels.filter((channel) => channel.id !== preferred)];
  }
  /**
    * 执行 AI 翻译请求，主进程从安全存储读取 API Key。
  * @param text 待翻译文本。
  * @param settings 当前公开设置。
  * @param apiKey 主进程解密后的 AI API Key。
  * @returns AI 翻译结果。
  * @author zhenghq
    */
  async aiChannel(text, settings, apiKey) {
    const translation = await this.aiClient.translate({
      protocol: settings.aiProtocol,
      baseUrl: settings.aiBaseUrl,
      model: settings.aiModel,
      apiKey,
      text,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang
    });
    return { translation, provider: "ai" };
  }
  /**
   * 执行 AI 流式翻译请求并返回最终清洗译文。
   * @param text 待翻译文本。
   * @param settings 当前公开设置。
   * @param apiKey 主进程解密后的 AI API Key。
   * @param onDelta 安全增量回调。
   * @param signal 可选外部取消信号。
   * @returns AI 翻译结果。
   * @author zhenghq
   */
  async aiStreamChannel(text, settings, apiKey, onDelta, signal) {
    const translation = await this.aiClient.stream({
      protocol: settings.aiProtocol,
      baseUrl: settings.aiBaseUrl,
      model: settings.aiModel,
      apiKey,
      text,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang
    }, { onDelta, signal });
    return { translation, provider: "ai" };
  }
  /**
    * 在 AI 配置变化后清理全部结果缓存、AI 模型缓存和 AI 熔断状态。
  * @returns 无返回值。
  * @author zhenghq
    */
  resetAiRuntime() {
    this.cache.clear();
    this.resetBreaker(AI_CHANNEL);
  }
  /**
   * 使用已配置代理的翻译网络会话发送带超时请求。
   * @param url 请求地址。
   * @param init 请求参数。
   * @param timeoutMs 超时时间（毫秒）。
   * @returns 网络响应。
   * @author zhenghq
   */
  fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return this.options.fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  }
  /**
   * 执行公共或自建 DeepLX 翻译。
   * @param baseUrl DeepLX 翻译地址。
   * @param text 待翻译文本。
   * @param settings 当前语言设置。
   * @param timeoutMs 请求超时时间。
   * @returns DeepLX 翻译结果。
   * @author zhenghq
   */
  async deepLxChannel(baseUrl, text, settings, timeoutMs) {
    const response = await this.fetchWithTimeout(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        source_lang: settings.sourceLang,
        target_lang: settings.targetLang
      })
    }, timeoutMs);
    const json = await response.json();
    if (json.code === 200 && json.data) {
      return { translation: json.data, detectedLang: json.source_lang || void 0 };
    }
    throw new Error(json.code === 429 ? translateMain("translate.deepLx.rateLimited") : json.message || `HTTP ${response.status}`);
  }
  /**
   * 执行 Google 非官方翻译接口请求。
   * @param text 待翻译文本。
   * @param settings 当前语言设置。
   * @returns Google 翻译结果。
   * @author zhenghq
   */
  async googleChannel(text, settings) {
    const target = this.toIsoLang(settings.targetLang);
    const source = settings.sourceLang === "auto" ? "auto" : this.toIsoLang(settings.sourceLang);
    const url = `${GOOGLE_ENDPOINT}?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
    const response = await this.fetchWithTimeout(url, { method: "GET" }, 3500);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) throw new Error(translateMain("translate.google.blocked"));
    const data = await response.json();
    const segments = Array.isArray(data?.[0]) ? data[0] : [];
    const translation = segments.map((segment) => segment?.[0] ? String(segment[0]) : "").join("").trim();
    if (!translation) throw new Error(translateMain("translate.google.empty"));
    const detected = data?.[2] ? String(data[2]) : "";
    return { translation, detectedLang: this.normalizeDetected(detected) };
  }
  /**
   * 执行 MyMemory 免费兜底翻译请求。
   * @param text 待翻译文本。
   * @param settings 当前语言设置。
   * @returns MyMemory 翻译结果。
   * @author zhenghq
   */
  async myMemoryChannel(text, settings) {
    const target = this.toIsoLang(settings.targetLang);
    const source = settings.sourceLang === "auto" ? "Autodetect" : this.toIsoLang(settings.sourceLang);
    const url = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(
      `${source}|${target}`
    )}&mt=1`;
    const response = await this.fetchWithTimeout(url, { method: "GET" }, 6e3);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.quotaFinished) throw new Error(translateMain("translate.myMemory.quotaExceeded"));
    const translation = data.responseData?.translatedText?.trim();
    if (!translation) throw new Error(data.responseDetails || translateMain("translate.myMemory.noResult"));
    const detected = data.responseData?.detectedLanguage || data.matches?.[0]?.source;
    return {
      translation,
      detectedLang: detected ? this.normalizeDetected(detected) : void 0
    };
  }
  /**
   * 创建普通翻译结果缓存键。
   * @param text 待翻译文本。
   * @param source 源语言。
   * @param target 目标语言。
   * @param preferredProvider 用户选择的首选翻译 API。
   * @returns 缓存键。
   * @author zhenghq
   */
  cacheKey(text, source, target, preferredProvider, aiEnabled, aiProtocol, aiBaseUrl, aiModel) {
    return `${preferredProvider}|${source}|${target}|${aiEnabled ? `ai:${aiProtocol}:${aiBaseUrl}:${aiModel}` : "ai:off"}|${text}`;
  }
  /**
   * 将内部语言代码转换为 Google/MyMemory 使用的 ISO 代码。
   * @param code 内部语言代码。
   * @returns 外部接口语言代码。
   * @author zhenghq
   */
  toIsoLang(code) {
    const normalized = code.toUpperCase();
    return normalized === "ZH" ? "zh-CN" : normalized.toLowerCase();
  }
  /**
   * 规范化外部接口返回的检测语言。
   * @param detected 外部检测语言代码。
   * @returns 应用内部大写语言代码。
   * @author zhenghq
   */
  normalizeDetected(detected) {
    const normalized = detected.toLowerCase();
    if (normalized.startsWith("zh")) return "ZH";
    return normalized.split("-")[0].toUpperCase();
  }
  /**
   * 判断通道当前是否处于熔断冷却期。
   * @param name 通道名称。
   * @returns 是否应跳过该通道。
   * @author zhenghq
   */
  isTripped(name) {
    const until = this.breaker.get(name);
    return until != null && this.now() < until;
  }
  /**
   * 将失败通道置于指定时长的熔断冷却期。
   * @param name 通道名称。
   * @param cooldownMs 冷却毫秒数。
   * @returns 无返回值。
   * @author zhenghq
   */
  trip(name, cooldownMs) {
    this.breaker.set(name, this.now() + cooldownMs);
  }
  /**
   * 清除指定通道的熔断状态。
   * @param name 通道名称。
   * @returns 无返回值。
   * @author zhenghq
   */
  resetBreaker(name) {
    this.breaker.delete(name);
  }
}
let defaultRuntime = new TranslationRuntime({
  fetch: (input, init) => globalThis.fetch(input, init)
});
function configureTranslationFetch(fetch) {
  defaultRuntime = new TranslationRuntime({ fetch });
}
function translate(text, settings, dingTalkCredentials = null, aiApiKey = null) {
  return defaultRuntime.translate(text, settings, dingTalkCredentials, aiApiKey);
}
function translateStream(text, settings, dingTalkCredentials, aiApiKey, options) {
  return defaultRuntime.translateStream(text, settings, dingTalkCredentials, aiApiKey, options);
}
function resetDeepLxTranslationRuntime() {
  defaultRuntime.resetDeepLxRuntime();
}
function checkDingTalk$1(credentials) {
  return defaultRuntime.checkDingTalk(credentials);
}
function resetDingTalkTranslationRuntime() {
  defaultRuntime.resetDingTalkRuntime();
}
function checkMicrosoft$1() {
  return defaultRuntime.checkMicrosoft();
}
function resetMicrosoftTranslationRuntime() {
  defaultRuntime.resetMicrosoftRuntime();
}
function resetAiTranslationRuntime() {
  defaultRuntime.resetAiRuntime();
}
function buildProxyConfig(settings) {
  if (settings.proxyMode === "direct") return { mode: "direct" };
  if (settings.proxyMode === "system") return { mode: "system" };
  return {
    mode: "fixed_servers",
    proxyRules: settings.proxyRules.trim(),
    proxyBypassRules: settings.proxyBypassRules.trim()
  };
}
function edgeSpeechProxyUrl(proxyResult) {
  const entries = proxyResult.split(";").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (/^DIRECT$/iu.test(entry)) return null;
    const match = /^(PROXY|HTTPS?)\s+(.+)$/iu.exec(entry);
    if (!match) continue;
    const scheme = match[1].toUpperCase() === "HTTPS" ? "https" : "http";
    return `${scheme}://${match[2]}`;
  }
  return entries.length === 0 ? null : void 0;
}
async function applyProxyToSessions(sessions, config) {
  for (const currentSession of sessions) {
    try {
      await currentSession.setProxy(config);
      await currentSession.closeAllConnections();
    } catch (error2) {
      console.warn("[network] 会话代理应用失败:", error2.message);
    }
  }
}
let translationSession = null;
let updateDownloadSession = null;
function getTranslationSession() {
  if (!translationSession) {
    translationSession = electron.session.fromPartition("translation-network");
  }
  return translationSession;
}
function getUpdateDownloadSession() {
  if (!updateDownloadSession) {
    updateDownloadSession = electron.session.fromPartition("electron-updater");
  }
  return updateDownloadSession;
}
async function applyTranslationProxy(settings) {
  await applyProxyToSessions(
    [getTranslationSession(), getUpdateDownloadSession()],
    buildProxyConfig(settings)
  );
  console.log("[network] 代理模式已应用:", settings.proxyMode);
}
function translationFetch(input, init) {
  return getTranslationSession().fetch(input, init);
}
function updateDownloadFetch(input, init) {
  return getUpdateDownloadSession().fetch(input, init);
}
async function createTranslationWebSocket(url, headers) {
  const proxyResult = await getTranslationSession().resolveProxy(url.replace(/^wss:/u, "https:"));
  const proxyUrl = edgeSpeechProxyUrl(proxyResult);
  if (proxyUrl === void 0) throw new Error(translateMain("speech.error.proxyUnsupported"));
  const dispatcher = proxyUrl ? new undici.ProxyAgent(proxyUrl) : null;
  const socket = new undici.WebSocket(url, dispatcher ? { dispatcher, headers } : { headers });
  socket.binaryType = "arraybuffer";
  return {
    get readyState() {
      return socket.readyState;
    },
    get binaryType() {
      return socket.binaryType;
    },
    set binaryType(value) {
      socket.binaryType = value === "arraybuffer" ? "arraybuffer" : "blob";
    },
    get onopen() {
      return socket.onopen;
    },
    set onopen(handler) {
      socket.onopen = handler;
    },
    get onmessage() {
      return socket.onmessage;
    },
    set onmessage(handler) {
      socket.onmessage = handler;
    },
    get onerror() {
      return socket.onerror;
    },
    set onerror(handler) {
      socket.onerror = handler;
    },
    get onclose() {
      return socket.onclose;
    },
    set onclose(handler) {
      socket.onclose = handler;
    },
    send(data) {
      socket.send(data);
    },
    close() {
      socket.close();
    },
    dispose() {
      if (dispatcher) void dispatcher.close();
    }
  };
}
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_BASE_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_GEC_VERSION = "1-143.0.3650.75";
const EDGE_BROWSER_MAJOR_VERSION = "143";
const DEFAULT_TIMEOUT_MS = 2e4;
const EDGE_VOICE_BY_LANGUAGE = {
  zh: "zh-CN-XiaoxiaoNeural",
  en: "en-US-JennyNeural",
  ja: "ja-JP-NanamiNeural",
  ko: "ko-KR-SunHiNeural",
  fr: "fr-FR-DeniseNeural",
  de: "de-DE-KatjaNeural",
  es: "es-ES-ElviraNeural"
};
function edgeVoiceForLanguage(language) {
  const prefix = language.trim().toLowerCase().split("-")[0];
  return EDGE_VOICE_BY_LANGUAGE[prefix] ?? EDGE_VOICE_BY_LANGUAGE.en;
}
function edgeVoiceToSsmlName(voice) {
  const match = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/u.exec(voice);
  if (!match) return voice;
  const [, language, baseRegion, regionalName] = match;
  const separatorIndex = regionalName.indexOf("-");
  const region = separatorIndex >= 0 ? `${baseRegion}-${regionalName.slice(0, separatorIndex)}` : baseRegion;
  const name = separatorIndex >= 0 ? regionalName.slice(separatorIndex + 1) : regionalName;
  return `Microsoft Server Speech Text to Speech Voice (${language}-${region}, ${name})`;
}
function escapeSsmlText(text) {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}
function buildEdgeSpeechSsml(text, language) {
  const voice = edgeVoiceToSsmlName(edgeVoiceForLanguage(language));
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}"><prosody rate="+0%" volume="+0%" pitch="+0Hz">${escapeSsmlText(text)}</prosody></voice></speak>`;
}
function edgeTimestamp(date) {
  return date.toUTCString().replace(", ", " ").replace(" GMT", " GMT+0000 (Coordinated Universal Time)");
}
function generateSecMsGec(date) {
  const windowsSeconds = Math.floor(date.getTime() / 1e3) + 11644473600;
  const roundedTicks = Math.floor(windowsSeconds / 300) * 300 * 1e7;
  return node_crypto.createHash("sha256").update(`${roundedTicks}${TRUSTED_CLIENT_TOKEN}`, "ascii").digest("hex").toUpperCase();
}
function defaultConnectionId() {
  return node_crypto.randomBytes(16).toString("hex");
}
function defaultMuid() {
  return node_crypto.randomBytes(16).toString("hex").toUpperCase();
}
function buildEdgeSocketHeaders(muid) {
  return {
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_BROWSER_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${EDGE_BROWSER_MAJOR_VERSION}.0.0.0`,
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    Cookie: `muid=${muid};`
  };
}
function buildEdgeSocketUrl(date, connectionId) {
  const params = new URLSearchParams({
    TrustedClientToken: TRUSTED_CLIENT_TOKEN,
    ConnectionId: connectionId,
    "Sec-MS-GEC": generateSecMsGec(date),
    "Sec-MS-GEC-Version": EDGE_GEC_VERSION
  });
  return `${EDGE_BASE_URL}?${params.toString()}`;
}
function edgeCommand(path, body, contentType, requestId, timestamp) {
  const requestHeader = path === "ssml" ? `X-RequestId:${requestId}\r
` : "";
  return `${requestHeader}Content-Type:${contentType}\r
X-Timestamp:${timestamp}Z\r
Path:${path}\r
\r
${body}`;
}
function parseAudioFrame(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.byteLength < 2) return null;
  const headerLength = bytes[0] << 8 | bytes[1];
  if (headerLength + 2 > bytes.byteLength) return null;
  const header = new TextDecoder().decode(bytes.slice(2, 2 + headerLength));
  if (!/(?:^|\r\n)Path:audio(?:\r\n|$)/u.test(header)) return null;
  const contentType = /(?:^|\r\n)Content-Type:([^\r\n]+)/u.exec(header)?.[1]?.trim();
  if (contentType && contentType !== "audio/mpeg") return null;
  return bytes.slice(2 + headerLength);
}
function createEdgeSpeechClient(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const connectionId = options.connectionId ?? defaultConnectionId;
  const muid = options.muid ?? defaultMuid;
  const socketFactory = options.socketFactory ?? ((url, _headers) => {
    const socket = new globalThis.WebSocket(url);
    socket.binaryType = "arraybuffer";
    return socket;
  });
  async function synthesize(text, language, signal) {
    if (!text.trim()) return { ok: false, error: translateMain("speech.error.emptyText") };
    if (signal?.aborted) return { ok: false, error: translateMain("speech.error.cancelled") };
    const currentDate = now();
    console.log("[edge-speech] WebSocket 请求开始", {
      language,
      textLength: text.trim().length
    });
    let socket;
    try {
      const socketResult = socketFactory(
        buildEdgeSocketUrl(currentDate, connectionId()),
        buildEdgeSocketHeaders(muid())
      );
      socket = socketResult instanceof Promise ? await socketResult : socketResult;
    } catch {
      console.error("[edge-speech] WebSocket 创建失败");
      return { ok: false, error: translateMain("speech.error.connectionFailed") };
    }
    const requestId = node_crypto.randomBytes(16).toString("hex");
    const timestamp = edgeTimestamp(currentDate);
    const chunks = [];
    let timer = null;
    let settled = false;
    return await new Promise((resolve) => {
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState < 2) socket.close();
        socket.dispose?.();
        console.log("[edge-speech] WebSocket 请求结束", {
          ok: result.ok,
          audioBytes: result.audio?.byteLength ?? 0,
          error: result.error
        });
        resolve(result);
      };
      const abort = () => finish({ ok: false, error: translateMain("speech.error.cancelled") });
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish({ ok: false, error: translateMain("speech.error.timeout") }), timeoutMs);
      socket.onopen = () => {
        console.log("[edge-speech] WebSocket 已连接，发送 speech.config 和 ssml");
        socket.send(edgeCommand(
          "speech.config",
          '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}',
          "application/json; charset=utf-8",
          requestId,
          timestamp
        ));
        socket.send(edgeCommand(
          "ssml",
          buildEdgeSpeechSsml(text, language),
          "application/ssml+xml",
          requestId,
          timestamp
        ));
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          if (/(?:^|\r\n)Path:turn\.end(?:\r\n|$)/u.test(event.data)) {
            const audio2 = chunks.length > 0 ? concatBytes(chunks) : new Uint8Array();
            finish(audio2.length > 0 ? { ok: true, audio: audio2, mimeType: "audio/mpeg" } : { ok: false, error: translateMain("speech.error.noAudio") });
          }
          return;
        }
        const audio = parseAudioFrame(event.data);
        if (audio && audio.length > 0) chunks.push(audio);
      };
      socket.onerror = () => finish({ ok: false, error: translateMain("speech.error.connectionFailed") });
      socket.onclose = () => {
        if (!settled) finish(chunks.length > 0 ? { ok: true, audio: concatBytes(chunks), mimeType: "audio/mpeg" } : { ok: false, error: translateMain("speech.error.connectionClosed") });
      };
    });
  }
  return { synthesize };
}
function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
const POPUP_AUTO_SIZE_LIMITS = {
  minWidth: 520,
  minHeight: 320,
  maxWidth: 720,
  maxHeight: 640
};
function isPopupAutoSizeRequest(value) {
  if (!value || typeof value !== "object") return false;
  const size = value;
  return typeof size.width === "number" && typeof size.height === "number" && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}
function clampToRange(value, min, max) {
  const lower = Math.min(min, max);
  return Math.max(lower, Math.min(value, max));
}
function resolvePopupAutoSize(size, workArea, options) {
  const edgeGap = options?.edgeGap;
  const availableWidth = Math.max(0, workArea.width - edgeGap * 2);
  const availableHeight = Math.max(0, workArea.height - edgeGap * 2);
  const maxWidth = Math.min(POPUP_AUTO_SIZE_LIMITS.maxWidth, availableWidth);
  const maxHeight = Math.min(POPUP_AUTO_SIZE_LIMITS.maxHeight, availableHeight);
  return {
    width: Math.round(clampToRange(size.width, POPUP_AUTO_SIZE_LIMITS.minWidth, maxWidth)),
    height: Math.round(clampToRange(size.height, POPUP_AUTO_SIZE_LIMITS.minHeight, maxHeight))
  };
}
function resolvePopupResizeBounds(bounds, size, workArea) {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  return {
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, maxX))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, maxY))),
    width,
    height
  };
}
function shouldDismissPopupOnBlur(pinned2, restoringForeground = false) {
  if (restoringForeground) return false;
  return !pinned2;
}
const POPUP_DRAG_REGION_HEIGHT = 32;
function isPointInPopupDragRegion(point, bounds) {
  const right = bounds.x + bounds.width;
  const dragRegionBottom = Math.min(
    bounds.y + bounds.height,
    bounds.y + POPUP_DRAG_REGION_HEIGHT
  );
  return point.x >= bounds.x && point.x <= right && point.y >= bounds.y && point.y <= dragRegionBottom;
}
const ALL_WORKSPACES_VISIBILITY_OPTIONS = {
  /** 允许窗口显示在其它应用的全屏窗口之上。 */
  visibleOnFullScreen: true,
  /** 跳过会隐藏窗口与 Dock 图标的进程类型转换。 */
  skipTransformProcessType: true
};
const CANDIDATE_ACTIONS = [
  "dock-show-sync-before",
  "dock-show-sync-after",
  "dock-show-delayed",
  "settings-activate-entry",
  "settings-reuse-raise",
  "popup-show",
  "popup-show-inactive",
  "popup-hide",
  "selection-button-show-inactive",
  "selection-button-hide"
];
const ACTIVATE_DIAGNOSTIC_PREFIX = "[activate-diagnostics]";
const MAX_STACK_FRAMES = 12;
const SENSITIVE_FIELD_PATTERN = /selectedtext|clipboard|windowtitle|selectiontext|windowtitle|title/iu;
function captureSyncStack(maxFrames = MAX_STACK_FRAMES) {
  const stack = new Error().stack;
  if (!stack) return "";
  const lines = stack.split("\n");
  const header = lines[0] ?? "Error";
  const frames = lines.slice(1, Math.max(1, maxFrames + 1));
  return [header, ...frames].join("\n");
}
function createActivateSourceRecord(input) {
  if (!Number.isFinite(input.timestampMs)) {
    return { ok: false, error: "invalid-timestamp" };
  }
  if (input.decision !== "allow" && input.decision !== "ignore") {
    return { ok: false, error: "invalid-decision" };
  }
  if (!input.stack || input.stack.trim() === "") {
    return { ok: false, error: "missing-stack" };
  }
  if (input.decision === "ignore" && !input.reason) {
    return { ok: false, error: "missing-reason" };
  }
  if (input.event && containsSensitiveField(input.event)) {
    return { ok: false, error: "sensitive-field" };
  }
  const event = snapshotEvent(input.event);
  return {
    ok: true,
    record: {
      kind: "activate",
      timestampMs: input.timestampMs,
      decision: input.decision,
      ...input.decision === "ignore" ? { reason: input.reason } : {},
      stack: input.stack,
      ...event ? { event } : {}
    }
  };
}
function createCandidateProbeRecord(input) {
  if (!Number.isFinite(input.timestampMs)) {
    return { ok: false, error: "invalid-timestamp" };
  }
  if (!CANDIDATE_ACTIONS.includes(input.action)) {
    return { ok: false, error: "invalid-action" };
  }
  if (typeof input.windowVisible !== "boolean") {
    return { ok: false, error: "invalid-window-visible" };
  }
  return {
    ok: true,
    record: {
      kind: "candidate",
      timestampMs: input.timestampMs,
      action: input.action,
      windowVisible: input.windowVisible
    }
  };
}
function formatActivateDiagnosticLog(record) {
  return `${ACTIVATE_DIAGNOSTIC_PREFIX} ${JSON.stringify(record)}`;
}
function logCandidateProbe(action, windowVisible, timestampMs = Date.now()) {
  try {
    const result = createCandidateProbeRecord({ timestampMs, action, windowVisible });
    if (result.ok) {
      console.log(formatActivateDiagnosticLog(result.record));
    }
  } catch {
  }
}
function containsSensitiveField(event) {
  return Object.keys(event).some((key) => SENSITIVE_FIELD_PATTERN.test(key));
}
function snapshotEvent(event) {
  if (!event) return void 0;
  const snapshot = {};
  if (typeof event["hasVisibleWindows"] === "boolean") {
    snapshot.hasVisibleWindows = event["hasVisibleWindows"];
  }
  return Object.keys(snapshot).length > 0 ? snapshot : void 0;
}
const BUTTON_SIZE = 36;
const EDGE_GAP = 8;
let win$1 = null;
let rendererReady = false;
let pendingAnchor = null;
let onInternalWindowHiddenCallback = null;
function notifyInternalWindowHidden() {
  onInternalWindowHiddenCallback?.();
}
function showReadySelectionButton(anchor) {
  if (!win$1 || !rendererReady) return;
  const display = electron.screen.getDisplayNearestPoint(anchor);
  const workArea = display.workArea;
  const preferredX = anchor.x + 6;
  const preferredY = anchor.y - BUTTON_SIZE - 4;
  const x = Math.max(
    workArea.x + EDGE_GAP,
    Math.min(preferredX, workArea.x + workArea.width - BUTTON_SIZE - EDGE_GAP)
  );
  const y = Math.max(
    workArea.y + EDGE_GAP,
    Math.min(preferredY, workArea.y + workArea.height - BUTTON_SIZE - EDGE_GAP)
  );
  win$1.setPosition(Math.round(x), Math.round(y));
  logCandidateProbe("selection-button-show-inactive", win$1.isVisible());
  win$1.showInactive();
  win$1.setAlwaysOnTop(true, "pop-up-menu");
  win$1.moveTop();
}
function createSelectionButton(preloadPath, onInternalWindowHidden) {
  rendererReady = false;
  pendingAnchor = null;
  onInternalWindowHiddenCallback = onInternalWindowHidden ?? null;
  win$1 = new electron.BrowserWindow({
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // macOS 上使用 nonactivating panel：点击“译”按钮不应激活整个应用，
    // 否则系统会把同应用内可聚焦的可见设置页提升为 key window 带到最前。
    // 按钮本就 focusable:false + showInactive()，panel 只补齐“不激活应用”语义。
    ...process.platform === "darwin" ? { type: "panel" } : {},
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win$1.setAlwaysOnTop(true, "pop-up-menu");
  win$1.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS);
  win$1.webContents.once("did-finish-load", () => {
    rendererReady = true;
    if (pendingAnchor) showReadySelectionButton(pendingAnchor);
  });
  win$1.on("closed", () => {
    win$1 = null;
    rendererReady = false;
    pendingAnchor = null;
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    win$1.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/selection.html`);
  } else {
    win$1.loadFile(node_path.join(__dirname, "../renderer/selection.html"));
  }
  win$1.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return win$1;
}
function showSelectionButton(anchor) {
  if (!win$1) return;
  pendingAnchor = anchor;
  showReadySelectionButton(anchor);
}
function hideSelectionButton() {
  pendingAnchor = null;
  const wasVisible = Boolean(win$1?.isVisible());
  logCandidateProbe("selection-button-hide", wasVisible);
  win$1?.hide();
  if (wasVisible) notifyInternalWindowHidden();
}
function isSelectionButtonVisible() {
  return Boolean(win$1?.isVisible());
}
function isPointInsideSelectionButton(point) {
  if (!win$1?.isVisible()) return false;
  const bounds = win$1.getBounds();
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}
const execFileP$1 = node_util.promisify(node_child_process.execFile);
const FRONTMOST_APP_SNAPSHOT_TIMEOUT_MS = 500;
const FRONT_RETURN_POLL_INTERVAL_MS = 16;
const FRONT_RETURN_TIMEOUT_MS = 200;
const FRONT_DIAGNOSTIC_PREFIX = "[macForeground]";
function logFrontDiagnostic(message) {
  console.log(`${FRONT_DIAGNOSTIC_PREFIX} ${message}`);
}
function hasWindowLocator(snapshot) {
  return Boolean(snapshot && (snapshot.windowNumber !== void 0 || snapshot.bounds));
}
function toFrontmostWindowSnapshot(snapshot) {
  return {
    ...snapshot,
    capturedAt: snapshot.capturedAt ?? Date.now()
  };
}
let macAppActive = false;
if (process.platform === "darwin") {
  electron.app.on("did-become-active", () => {
    macAppActive = true;
  });
  electron.app.on("did-resign-active", () => {
    macAppActive = false;
  });
}
function isMacAppActiveByEvents() {
  return macAppActive;
}
function isOwnWindowHoldingKeyWindow() {
  if (process.platform !== "darwin") return false;
  const focused = electron.BrowserWindow.getFocusedWindow();
  const ownWindowFocused = Boolean(focused && !focused.isDestroyed() && focused.isVisible());
  if (ownWindowFocused) return true;
  return isMacAppActiveByEvents();
}
async function handBackKeyWindowToFrontmostApp() {
  if (process.platform !== "darwin") return false;
  const focusedBefore = electron.BrowserWindow.getFocusedWindow();
  const ownWindowFocusedBefore = Boolean(
    focusedBefore && !focusedBefore.isDestroyed() && focusedBefore.isVisible()
  );
  const appActiveBefore = isMacAppActiveByEvents();
  const target = pendingReturnApp;
  if (!ownWindowFocusedBefore && !appActiveBefore && !target) return false;
  let activationOutcome;
  if (target && isProcessAlive(target.pid)) {
    const activation = hasWindowLocator(target) ? await activateMacosWindowSnapshot(toFrontmostWindowSnapshot(target)) : null;
    activationOutcome = activation?.outcome;
    const activated = activation ? activation.activated : activateFrontmostApp(target);
    if (!activated) {
      logFrontDiagnostic(`取词前无法激活源应用，退化为 blur：bundleId=${target.bundleId}`);
    } else {
      logFrontDiagnostic(
        hasWindowLocator(target) ? `取词前开始精确交还 key window：bundleId=${target.bundleId} pid=${target.pid} windowLocate=${activationOutcome}` : `取词前开始精确交还 key window：open -b ${target.bundleId} pid=${target.pid}`
      );
      if (!ownWindowFocusedBefore) {
        logFrontDiagnostic(`取词前精确交还 key window 成功：bundleId=${target.bundleId}`);
        return true;
      }
      const handedBack = await new Promise((resolve) => {
        let finished = false;
        const finish = (confirmed) => {
          if (finished) return;
          finished = true;
          resolve(confirmed);
        };
        const deadline = Date.now() + FRONT_RETURN_TIMEOUT_MS;
        const poll = () => {
          const focused = electron.BrowserWindow.getFocusedWindow();
          const ownWindowFocused = Boolean(
            focused && !focused.isDestroyed() && focused.isVisible()
          );
          const appHandedBack = !appActiveBefore || !isMacAppActiveByEvents();
          if (!ownWindowFocused && appHandedBack) {
            finish(true);
            return;
          }
          if (Date.now() >= deadline) {
            finish(false);
            return;
          }
          setTimeout(poll, FRONT_RETURN_POLL_INTERVAL_MS);
        };
        poll();
      });
      if (handedBack) {
        logFrontDiagnostic(`取词前精确交还 key window 成功：bundleId=${target.bundleId}`);
        return true;
      }
      logFrontDiagnostic(`取词前精确交还 key window 超时，退化为 blur：bundleId=${target.bundleId}`);
    }
  } else if (target) {
    logFrontDiagnostic(`取词前无法激活源应用，退化为 blur：bundleId=${target.bundleId}`);
  } else {
    logFrontDiagnostic("取词前没有源应用记录，退化为 blur 自有 key window");
  }
  const focusedNow = electron.BrowserWindow.getFocusedWindow();
  if (focusedNow && !focusedNow.isDestroyed() && focusedNow.isVisible()) {
    focusedNow.blur();
  }
  const focusedAfter = electron.BrowserWindow.getFocusedWindow();
  return !focusedAfter || focusedAfter.isDestroyed() || !focusedAfter.isVisible();
}
function parseFrontmostAppSnapshot(output, selfPid) {
  const bundleId = /bundleID="([^"]+)"/u.exec(output)?.[1];
  const pid = Number(/pid = (\d+)/u.exec(output)?.[1]);
  if (!bundleId || !Number.isInteger(pid) || pid <= 0) return null;
  if (pid === selfPid) return null;
  return { bundleId, pid };
}
async function readFrontmostAppSnapshot() {
  try {
    const { stdout: frontStdout } = await execFileP$1("lsappinfo", ["front"], {
      timeout: FRONTMOST_APP_SNAPSHOT_TIMEOUT_MS
    });
    const asn = frontStdout.trim();
    if (!asn) return null;
    const { stdout: infoStdout } = await execFileP$1("lsappinfo", ["info", asn], {
      timeout: FRONTMOST_APP_SNAPSHOT_TIMEOUT_MS
    });
    return parseFrontmostAppSnapshot(infoStdout, process.pid);
  } catch {
    return null;
  }
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error2) {
    return error2.code === "EPERM";
  }
}
function activateFrontmostApp(snapshot) {
  if (!snapshot || !isProcessAlive(snapshot.pid)) return false;
  node_child_process.execFile("open", ["-b", snapshot.bundleId], () => {
  });
  return true;
}
async function activateFrontmostSnapshot(snapshot) {
  if (!isProcessAlive(snapshot.pid)) return false;
  if (!hasWindowLocator(snapshot)) return activateFrontmostApp(snapshot);
  const result = await activateMacosWindowSnapshot(toFrontmostWindowSnapshot(snapshot));
  return result.activated;
}
let pendingReturnApp = null;
let frontmostRecordRequestId = 0;
function rememberFrontmostApp(snapshot) {
  if (process.platform !== "darwin" || !snapshot) return;
  frontmostRecordRequestId += 1;
  pendingReturnApp = snapshot;
}
async function rememberFrontmostAppIfInactiveAsync() {
  if (process.platform !== "darwin") return;
  const requestId = ++frontmostRecordRequestId;
  const snapshot = await readFrontmostAppSnapshot();
  if (!snapshot) return;
  if (requestId !== frontmostRecordRequestId) return;
  rememberFrontmostApp(snapshot);
  logFrontDiagnostic(`记录源应用 bundleId=${snapshot.bundleId} pid=${snapshot.pid}`);
}
async function rememberFrontmostWindowAtPoint(point) {
  if (process.platform !== "darwin") return null;
  const requestId = ++frontmostRecordRequestId;
  const appSnapshot = await readFrontmostAppSnapshot();
  if (!appSnapshot || requestId !== frontmostRecordRequestId) return null;
  let windowList;
  try {
    windowList = await enumerateMacosWindows(appSnapshot.pid);
  } catch {
    windowList = null;
  }
  if (requestId !== frontmostRecordRequestId) return null;
  const target = resolveWindowCaptureTarget({
    windows: windowList?.windows ?? null,
    pid: appSnapshot.pid,
    point
  });
  const snapshot = buildFrontmostWindowSnapshot({
    bundleId: appSnapshot.bundleId,
    pid: appSnapshot.pid,
    window: target.window,
    capturedAt: Date.now()
  });
  pendingReturnApp = snapshot;
  logFrontDiagnostic(
    `记录源窗口 bundleId=${snapshot.bundleId} pid=${snapshot.pid} windowLocate=${target.outcome} windowCount=${target.windowCount ?? "unknown"} windowMatched=${target.windowMatched}`
  );
  return {
    snapshot,
    windowLocate: target.outcome,
    windowCount: target.windowCount,
    windowMatched: target.windowMatched
  };
}
function forgetFrontmostApp() {
  frontmostRecordRequestId += 1;
  pendingReturnApp = null;
}
function handBackFrontmostThen(keyWindow, run, onHandBackFailed, keyWindowIsPopup = false) {
  const fallback = onHandBackFailed ?? run;
  if (process.platform !== "darwin") {
    run();
    return;
  }
  const focused = electron.BrowserWindow.getFocusedWindow();
  if (focused === null) {
    if (keyWindowIsPopup && isMacAppActiveByEvents()) {
      logFrontDiagnostic("弹窗隐藏前检测到本应用仍最前，继续交还前台");
    } else {
      if (isMacAppActiveByEvents()) {
        run();
        logFrontDiagnostic("跳过交还：原生对话框持有 key window，保留记录");
        return;
      }
      const discarded = pendingReturnApp;
      forgetFrontmostApp();
      run();
      if (discarded) {
        logFrontDiagnostic(
          `跳过交还：应用已不在最前，丢弃过期记录 bundleId=${discarded.bundleId}`
        );
      }
      return;
    }
  }
  const popupNeedsHandBack = keyWindowIsPopup && isMacAppActiveByEvents();
  if (!popupNeedsHandBack && (!keyWindow || keyWindow.isDestroyed() || focused !== keyWindow)) {
    logFrontDiagnostic("跳过交还：即将隐藏的窗口不是当前 key window");
    run();
    return;
  }
  const target = pendingReturnApp;
  pendingReturnApp = null;
  if (!target || !isProcessAlive(target.pid)) {
    logFrontDiagnostic(
      `交还退化为安全让出：${target ? `目标应用已退出 pid=${target.pid}` : "没有可交还的源应用记录"}`
    );
    fallback();
    return;
  }
  let finished = false;
  const startedAt = Date.now();
  const finish = (handedBack) => {
    if (finished) return;
    finished = true;
    if (handedBack) {
      logFrontDiagnostic(
        `精确交还成功：bundleId=${target.bundleId} 耗时 ${Date.now() - startedAt}ms`
      );
      run();
      return;
    }
    logFrontDiagnostic(
      `交还退化为安全让出：激活源应用 bundleId=${target.bundleId} 未在 ${FRONT_RETURN_TIMEOUT_MS}ms 内确认失活`
    );
    fallback();
  };
  let deadline = Date.now() + FRONT_RETURN_TIMEOUT_MS;
  const pollDeactivated = () => {
    if (!isMacAppActiveByEvents()) {
      finish(true);
      return;
    }
    if (electron.BrowserWindow.getFocusedWindow() === null) {
      finish(true);
      return;
    }
    if (Date.now() >= deadline) {
      finish(false);
      return;
    }
    setTimeout(pollDeactivated, FRONT_RETURN_POLL_INTERVAL_MS);
  };
  void activateFrontmostSnapshot(target).then((activated) => {
    if (!activated) {
      finish(false);
      return;
    }
    setTimeout(() => finish(false), FRONT_RETURN_TIMEOUT_MS);
    deadline = Date.now() + FRONT_RETURN_TIMEOUT_MS;
    logFrontDiagnostic(
      hasWindowLocator(target) ? `开始精确交还：bundleId=${target.bundleId} pid=${target.pid} windowLocate=exact` : `开始精确交还：open -b ${target.bundleId} pid=${target.pid}`
    );
    pollDeactivated();
  }).catch(() => finish(false));
}
const WIN32_FOREGROUND_PROTOTYPES = {
  GetForegroundWindow: "void * __stdcall GetForegroundWindow()",
  SetForegroundWindow: "bool __stdcall SetForegroundWindow(void *hwnd)",
  IsWindow: "bool __stdcall IsWindow(void *hwnd)"
};
function loadForegroundBindings(loadKoffi) {
  try {
    const koffi = loadKoffi ? loadKoffi() : require("koffi");
    const user32 = koffi.load("user32.dll");
    const GetForegroundWindow = user32.func(WIN32_FOREGROUND_PROTOTYPES.GetForegroundWindow);
    const SetForegroundWindow = user32.func(WIN32_FOREGROUND_PROTOTYPES.SetForegroundWindow);
    const IsWindow = user32.func(WIN32_FOREGROUND_PROTOTYPES.IsWindow);
    return {
      getForegroundWindow: () => GetForegroundWindow(),
      setForegroundWindow: (handle) => Boolean(SetForegroundWindow(handle)),
      isWindow: (handle) => Boolean(IsWindow(handle))
    };
  } catch (error2) {
    console.warn(
      `[foreground] user32 绑定不可用，跳过前台焦点恢复: ${error2 instanceof Error ? error2.message : String(error2)}`
    );
    return null;
  }
}
function createWindowsForegroundTracker(options) {
  if (options.platform !== "win32") {
    return { remember: () => false, restore: () => false };
  }
  let bindings = options.bindings;
  let bindingFailed = false;
  let rememberedWindow = null;
  const ensureBindings = () => {
    if (bindings) return bindings;
    if (bindingFailed) return null;
    bindings = loadForegroundBindings(options.loadKoffi);
    if (!bindings) bindingFailed = true;
    return bindings;
  };
  return {
    /**
     * 记录当前前台窗口，弹窗激活前调用。
     * @returns 成功记录到有效窗口时返回 true。
     * @author zhenghq
     */
    remember() {
      const api = ensureBindings();
      if (!api) return false;
      try {
        const handle = api.getForegroundWindow();
        if (!handle) return false;
        rememberedWindow = handle;
        return true;
      } catch {
        return false;
      }
    },
    /**
     * 把焦点交还给记录的源应用窗口，并清空记录避免重复抢焦点。
     * @returns 成功交还时返回 true。
     * @author zhenghq
     */
    restore() {
      const handle = rememberedWindow;
      rememberedWindow = null;
      if (!handle) return false;
      const api = ensureBindings();
      if (!api) return false;
      try {
        if (!api.isWindow(handle)) return false;
        return api.setForegroundWindow(handle);
      } catch {
        return false;
      }
    }
  };
}
const WINDOW_EDGE_GAP = 8;
const CURSOR_GAP = 16;
const EXTERNAL_POINTER_DISMISS_SUPPRESS_MS = 1e3;
const EXTERNAL_POINTER_DISMISS_SUPPRESS_RADIUS = 48;
let win = null;
let hideTimer = null;
let closeVersion = 0;
let pinned = false;
let currentAutoHideMs = 0;
let shownInactive = false;
let settingsOpenGuardActive = false;
let selectionCaptureLoading = false;
let suppressExternalPointerDismissUntil = 0;
let suppressExternalPointerDismissOrigin = null;
let onInternalWindowShown = null;
const foregroundTracker = createWindowsForegroundTracker({ platform: process.platform });
const pendingPayloads = [];
function createPopup(preloadPath, onWindowShown) {
  shownInactive = false;
  settingsOpenGuardActive = false;
  selectionCaptureLoading = false;
  suppressExternalPointerDismissUntil = 0;
  suppressExternalPointerDismissOrigin = null;
  onInternalWindowShown = onWindowShown ?? null;
  win = new electron.BrowserWindow({
    width: 520,
    height: 360,
    minWidth: 520,
    minHeight: 320,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // macOS 上使用 nonactivating panel：show()/focus() 只让弹窗自身成为 key window，
    // 不激活整个应用，从而避免把同应用其它可见窗口一起带到最前。
    ...process.platform === "darwin" ? { type: "panel" } : {},
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Edge 音频需要先等待网络合成，播放调用会晚于用户点击，不能依赖已失效的手势授权。
      autoplayPolicy: "no-user-gesture-required"
    }
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS);
  win.webContents.setAudioMuted(false);
  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(node_path.join(__dirname, "../renderer/index.html"));
  }
  win.on("blur", handlePopupBlur);
  win.on("focus", handlePopupFocus);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return win;
}
function notifyInternalWindowShown() {
  onInternalWindowShown?.();
}
function handlePopupFocus() {
  shownInactive = false;
  notifyInternalWindowShown();
}
function handlePopupBlur() {
  if (!win?.isVisible()) return;
  if (settingsOpenGuardActive) return;
  const cursorInsideDragRegion = isPointInPopupDragRegion(
    electron.screen.getCursorScreenPoint(),
    win.getBounds()
  );
  if (cursorInsideDragRegion) return;
  if (shownInactive) return;
  if (selectionCaptureLoading) return;
  if (shouldDismissPopupOnBlur(pinned, false)) {
    hidePopup(true, "blur");
  }
}
function beginPopupSettingsOpenGuard() {
  settingsOpenGuardActive = true;
}
function endPopupSettingsOpenGuard() {
  settingsOpenGuardActive = false;
}
function isPopupSettingsOpenGuardActive() {
  return settingsOpenGuardActive;
}
function suppressExternalPointerDismissForButtonClick(origin) {
  suppressExternalPointerDismissUntil = Date.now() + EXTERNAL_POINTER_DISMISS_SUPPRESS_MS;
  suppressExternalPointerDismissOrigin = origin ?? null;
}
function positionNearAnchor(anchor) {
  if (!win) return;
  const point = anchor ?? electron.screen.getCursorScreenPoint();
  const display = electron.screen.getDisplayNearestPoint(point);
  const workArea = display.workArea;
  const [width, height] = win.getSize();
  let x = point.x + CURSOR_GAP;
  let y = point.y + CURSOR_GAP;
  if (x + width > workArea.x + workArea.width) x = point.x - width - CURSOR_GAP;
  if (y + height > workArea.y + workArea.height) y = point.y - height - CURSOR_GAP;
  x = Math.max(
    workArea.x + WINDOW_EDGE_GAP,
    Math.min(x, workArea.x + workArea.width - width - WINDOW_EDGE_GAP)
  );
  y = Math.max(
    workArea.y + WINDOW_EDGE_GAP,
    Math.min(y, workArea.y + workArea.height - height - WINDOW_EDGE_GAP)
  );
  win.setPosition(Math.round(x), Math.round(y));
}
function resizePopup(size) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const display = electron.screen.getDisplayMatching(bounds);
  const resolved = resolvePopupAutoSize(size, display.workArea, { edgeGap: WINDOW_EDGE_GAP });
  const next = resolvePopupResizeBounds(bounds, resolved, display.workArea);
  if (next.width === bounds.width && next.height === bounds.height && next.x === bounds.x && next.y === bounds.y) {
    return;
  }
  win.setBounds(next);
}
function deliverPopupPayload(payload) {
  if (!win) return;
  if (win.webContents.isLoadingMainFrame()) {
    pendingPayloads.push(payload);
    if (pendingPayloads.length === 1) {
      win.webContents.once("did-finish-load", () => {
        if (!win) return;
        const queued = pendingPayloads.splice(0);
        for (const item of queued) win.webContents.send("translate:result", item);
        win.webContents.send("popup:pinned", pinned);
      });
    }
    return;
  }
  win.webContents.send("translate:result", payload);
  win.webContents.send("popup:pinned", pinned);
}
function sendPopupDelta(payload) {
  if (!win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) return;
  win.webContents.send("translate:delta", payload);
}
function showPopup(payload, autoHideMs, anchor, activate = true) {
  if (!win) return;
  currentAutoHideMs = Math.max(0, autoHideMs);
  selectionCaptureLoading = payload.origin === "selection" && payload.loading === true;
  const alreadyVisible = win.isVisible();
  deliverPopupPayload(payload);
  if (payload.origin !== "manual") {
    win.webContents.send("popup:selection-mode");
  }
  if (!alreadyVisible) {
    positionNearAnchor(anchor);
    if (activate) foregroundTracker.remember();
    logCandidateProbe(activate ? "popup-show" : "popup-show-inactive", alreadyVisible);
    activate ? win.show() : win.showInactive();
    shownInactive = !activate;
  } else if (activate && shownInactive) {
    foregroundTracker.remember();
    logCandidateProbe("popup-show", alreadyVisible);
    win.show();
    shownInactive = false;
  } else if (!activate && !shownInactive && alreadyVisible) {
    logCandidateProbe("popup-show-inactive", alreadyVisible);
    win.showInactive();
    shownInactive = true;
  }
  notifyInternalWindowShown();
  scheduleHide(autoHideMs);
}
function showManualTranslationPopup() {
  if (!win) return;
  selectionCaptureLoading = false;
  currentAutoHideMs = 0;
  clearHide();
  const alreadyVisible = win.isVisible();
  if (!alreadyVisible) {
    positionNearAnchor();
    win.show();
  } else {
    win.focus();
  }
  shownInactive = false;
  win.webContents.send("popup:pinned", pinned);
  notifyInternalWindowShown();
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once("did-finish-load", () => {
      win?.webContents.send("manual-translate:open");
    });
  } else {
    win.webContents.send("manual-translate:open");
  }
}
function dismissPopupOnExternalPointerDown(point) {
  if (!isPopupVisible()) return false;
  if (pinned || isSuppressedExternalPointerDismiss(point)) return false;
  console.log("[popup] 外部点击主动关闭弹窗并归还前台");
  hidePopup(true, "external-pointer");
  return true;
}
function isSuppressedExternalPointerDismiss(point) {
  if (Date.now() > suppressExternalPointerDismissUntil) return false;
  const origin = suppressExternalPointerDismissOrigin;
  if (!point || !origin) return true;
  return Math.abs(point.x - origin.x) <= EXTERNAL_POINTER_DISMISS_SUPPRESS_RADIUS && Math.abs(point.y - origin.y) <= EXTERNAL_POINTER_DISMISS_SUPPRESS_RADIUS;
}
function hidePopup(handBackFrontmost = true, reason = "unknown") {
  console.log(`[popup] hide reason=${reason}`);
  clearHide();
  closeVersion += 1;
  pinned = false;
  selectionCaptureLoading = false;
  suppressExternalPointerDismissUntil = 0;
  suppressExternalPointerDismissOrigin = null;
  win?.webContents.send("popup:pinned", false);
  if (!win || win.isDestroyed()) return;
  const run = () => {
    shownInactive = false;
    logCandidateProbe("popup-hide", Boolean(win && !win.isDestroyed() && win.isVisible()));
    win?.hide();
    notifyInternalWindowShown();
  };
  if (process.platform === "darwin" && handBackFrontmost) {
    handBackFrontmostThen(win, run, void 0, true);
    return;
  }
  if (process.platform === "win32" && !shownInactive) {
    foregroundTracker.restore();
  }
  run();
}
function hidePopupForInternalWindowSwitch() {
  hidePopup(false, "internal-window-switch");
}
function setPopupPinned(value) {
  pinned = value;
  if (pinned) {
    clearHide();
  } else if (win?.isVisible()) {
    scheduleHide(currentAutoHideMs);
  }
  win?.webContents.send("popup:pinned", pinned);
}
function isPopupPinned() {
  return pinned;
}
function isPopupVisible() {
  return Boolean(win?.isVisible());
}
function isPopupActivated() {
  return Boolean(win?.isVisible()) && !shownInactive;
}
function isPopupHoldingKeyWindow() {
  return Boolean(win && !win.isDestroyed() && win.isVisible() && win.isFocused());
}
function deactivatePopupForCapture() {
  if (process.platform !== "win32" && process.platform !== "darwin") return false;
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  if (process.platform === "darwin") {
    if (!win.isFocused()) return false;
    shownInactive = true;
    win.blur();
    if (win.isFocused()) win.showInactive();
    return true;
  }
  if (shownInactive) return false;
  shownInactive = true;
  const restored = foregroundTracker.restore();
  if (!restored) win.blur();
  return true;
}
function getPopupCloseVersion() {
  return closeVersion;
}
function isPointInsidePopup(point) {
  const target = win;
  if (!target || !isPopupVisible()) return false;
  const bounds = target.getBounds();
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}
function scheduleHide(milliseconds) {
  clearHide();
  if (!pinned && milliseconds > 0) {
    hideTimer = setTimeout(() => hidePopup(true, "auto-hide"), milliseconds);
  }
}
function clearHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}
class SelectionListenerController {
  /**
   * 创建监听生命周期控制器。
   * @param options 启停钩子和日志依赖。
   * @author zhenghq
   */
  constructor(options) {
    this.options = options;
  }
  mode = "hotkey";
  pauseReasons = /* @__PURE__ */ new Set();
  running = false;
  /**
   * 更新触发模式并刷新监听目标状态。
   * @param mode 当前触发模式。
   * @returns 无返回值。
   * @author zhenghq
   */
  setMode(mode) {
    const changed = this.mode !== mode;
    this.mode = mode;
    if (changed) this.logState(`模式切换为 ${mode}`);
    this.refresh();
  }
  /**
   * 增加监听暂停原因并刷新实际状态。
   * @param reason 暂停原因。
   * @returns 无返回值。
   * @author zhenghq
   */
  pause(reason) {
    const wasPaused = this.pauseReasons.has(reason);
    this.pauseReasons.add(reason);
    if (!wasPaused) {
      this.logState(`新增暂停原因 ${reason}`);
      this.refresh();
    }
  }
  /**
   * 移除监听暂停原因并刷新实际状态。
   * @param reason 暂停原因。
   * @returns 无返回值。
   * @author zhenghq
   */
  resume(reason) {
    if (!this.pauseReasons.delete(reason)) return;
    this.logState(`移除暂停原因 ${reason}`);
    this.refresh();
  }
  /**
   * 根据期望状态重新计算并应用监听目标。
   * @returns 无返回值。
   * @author zhenghq
   */
  refresh() {
    const shouldRun = this.mode !== "hotkey" && this.pauseReasons.size === 0;
    if (shouldRun) {
      if (!this.running) this.start();
      return;
    }
    if (this.running) this.options.stop();
    this.running = false;
  }
  /**
   * 强制重建当前应运行的全局划词监听，用于系统辅助功能服务恢复后重新挂接钩子。
   * 快捷键模式或暂停状态下只刷新目标状态，不会错误启动监听。
   * @returns 无返回值。
   * @author zhenghq
   */
  restart() {
    this.logState("请求重启划词监听");
    if (this.running) this.options.stop();
    this.running = false;
    this.refresh();
  }
  /**
   * 停止监听并记录关闭暂停原因。
   * @returns 无返回值。
   * @author zhenghq
   */
  stop() {
    this.pauseReasons.add("shutdown");
    this.logState("停止划词监听");
    if (this.running) this.options.stop();
    this.running = false;
  }
  /**
   * 返回 OCR 是否暂停了普通划词监听。
   * @returns 存在 OCR 暂停原因时返回 true。
   * @author zhenghq
   */
  isPausedForOcr() {
    return this.pauseReasons.has("ocr");
  }
  /**
   * 返回全局钩子实际运行状态。
   * @returns 钩子正在运行时返回 true。
   * @author zhenghq
   */
  isRunning() {
    return this.running;
  }
  /**
   * 启动一次全局划词监听并保留失败后的可重试状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  start() {
    const started = this.options.start();
    this.running = started;
    this.logState(started ? "划词监听已启动" : "划词监听启动失败");
    if (!started) this.options.log?.("[selectionListener] 全局划词监听启动失败，后续 refresh 可重试");
  }
  /**
   * 输出监听期望状态与暂停原因快照，便于排查划词无响应时的监听生命周期。
   * @param action 本次状态变更描述。
   * @returns 无返回值。
   * @author zhenghq
   */
  logState(action) {
    const reasons = [...this.pauseReasons];
    this.options.log?.(
      `[selectionListener] ${action} mode=${this.mode} running=${this.running} pauseReasons=[${reasons.join(",")}]`
    );
  }
}
const stateListenerCleanups = /* @__PURE__ */ new WeakMap();
function resolveAllowedWindow(event, isAllowedWindow) {
  if (event.sender.isDestroyed()) return null;
  const window2 = electron.BrowserWindow.fromWebContents(event.sender);
  if (!window2 || window2.isDestroyed() || !isAllowedWindow(window2)) return null;
  return window2;
}
function bindMaximizedState(window2) {
  const webContents = window2.webContents;
  if (stateListenerCleanups.has(webContents)) return;
  const sendState = () => {
    if (window2.isDestroyed() || webContents.isDestroyed()) return;
    webContents.send("window:maximized-changed", window2.isMaximized());
  };
  const cleanup = () => {
    window2.removeListener("maximize", sendState);
    window2.removeListener("unmaximize", sendState);
    window2.removeListener("closed", cleanup);
    webContents.removeListener("destroyed", cleanup);
    stateListenerCleanups.delete(webContents);
  };
  stateListenerCleanups.set(webContents, cleanup);
  window2.on("maximize", sendState);
  window2.on("unmaximize", sendState);
  window2.on("closed", cleanup);
  webContents.on("destroyed", cleanup);
}
function registerWindowControls(options) {
  const resolveWindow = (event) => {
    const window2 = resolveAllowedWindow(event, options.isAllowedWindow);
    if (window2) bindMaximizedState(window2);
    return window2;
  };
  electron.ipcMain.on("window:minimize", (event) => {
    resolveWindow(event)?.minimize();
  });
  electron.ipcMain.on("window:toggle-maximize", (event) => {
    const window2 = resolveWindow(event);
    if (!window2) return;
    if (window2.isMaximized()) window2.unmaximize();
    else window2.maximize();
  });
  electron.ipcMain.on("window:close", (event) => {
    const window2 = resolveWindow(event);
    if (!window2) return;
    const closeWindow = options.closeWindow;
    if (closeWindow) {
      closeWindow(window2);
      return;
    }
    window2.close();
  });
  electron.ipcMain.handle("window:is-maximized", (event) => resolveWindow(event)?.isMaximized() ?? false);
}
const LANGUAGES = [
  { code: "ZH", label: "Chinese" },
  { code: "EN", label: "English" },
  { code: "JA", label: "Japanese" },
  { code: "KO", label: "Korean" },
  { code: "FR", label: "French" },
  { code: "DE", label: "German" },
  { code: "ES", label: "Spanish" },
  { code: "PT", label: "Portuguese" },
  { code: "IT", label: "Italian" },
  { code: "NL", label: "Dutch" },
  { code: "PL", label: "Polish" },
  { code: "RU", label: "Russian" },
  { code: "TR", label: "Turkish" },
  { code: "ID", label: "Indonesian" },
  { code: "UK", label: "Ukrainian" },
  { code: "AR", label: "Arabic" },
  { code: "SV", label: "Swedish" },
  { code: "DA", label: "Danish" },
  { code: "CS", label: "Czech" },
  { code: "EL", label: "Greek" },
  { code: "FI", label: "Finnish" },
  { code: "HU", label: "Hungarian" },
  { code: "RO", label: "Romanian" },
  { code: "SK", label: "Slovak" },
  { code: "BG", label: "Bulgarian" },
  { code: "LT", label: "Lithuanian" },
  { code: "LV", label: "Latvian" },
  { code: "ET", label: "Estonian" },
  { code: "SL", label: "Slovenian" }
];
const SHORTCUT_IDS = [
  "hotkey",
  "ocrHotkey",
  "manualTranslationHotkey",
  "webReaderHotkey"
];
function normalizeAccelerator(accelerator) {
  const parts = accelerator.trim().split("+").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (parts.length <= 1) return parts.join("+");
  return [parts[0], ...parts.slice(1).sort()].join("+");
}
function findShortcutConflict(id, accelerator, settings) {
  const normalized = accelerator.trim();
  if (!normalized) return null;
  if (isCopyShortcut(normalized)) return { kind: "copy" };
  const candidate = normalizeAccelerator(normalized);
  for (const owner of SHORTCUT_IDS) {
    if (owner === id) continue;
    const other = String(settings[owner] ?? "").trim();
    if (other && normalizeAccelerator(other) === candidate) {
      return { kind: "duplicate", owner };
    }
  }
  return null;
}
function collectShortcutRegistrationStates(settings, deps) {
  deps.unregisterAll();
  return SHORTCUT_IDS.map((id) => {
    const accelerator = String(settings[id] ?? "").trim();
    if (!accelerator) {
      return { id, accelerator: "", status: "skipped" };
    }
    if (isCopyShortcut(accelerator)) {
      return { id, accelerator, status: "invalid", message: "system-copy" };
    }
    try {
      if (deps.register(accelerator)) {
        return { id, accelerator, status: "registered" };
      }
      return { id, accelerator, status: "occupied" };
    } catch (error2) {
      return {
        id,
        accelerator,
        status: "invalid",
        message: error2 instanceof Error ? error2.message : "invalid"
      };
    }
  });
}
const POPUP_FOREGROUND_RESTORE_SETTLE_MS = 60;
function shouldRestoreForegroundBeforeCapture(platform, popupActivated) {
  if (platform === "win32") return popupActivated;
  if (platform === "darwin") return popupActivated;
  return false;
}
function shouldActivatePopupForCaptureFailure(platform) {
  return platform !== "darwin";
}
function resolveOwnWindowExclusion(appFrontmost, candidates) {
  if (!appFrontmost) return [];
  return candidates.filter((candidate) => candidate.focused && candidate.bounds !== null);
}
function resolveAppFrontmostForExclusion(platform, macAppActiveByEvents) {
  if (platform !== "darwin") return true;
  return macAppActiveByEvents;
}
function findOwnWindowHit(point, windows) {
  return windows.find((candidate) => isPointInsideBounds(point, candidate.bounds)) ?? null;
}
const LIST_LINE_PATTERN = /^(?:[-*+•]\s+|\d+[.)]\s+)/u;
const BLOCK_LINE_PATTERN = /^(?:#{1,6}\s+|>\s+|```|~~~|\|)/u;
const INDENTED_CODE_PATTERN = /^(?:\t| {4,})\S/u;
const CJK_CHARACTER_PATTERN = /[\u2e80-\u9fff\uf900-\ufaff]/u;
const NO_SPACE_AFTER_PATTERN = /[(\[{“‘/\-‐‑–—]$/u;
const NO_SPACE_BEFORE_PATTERN = /^[,.;:!?，。！？；：、)\]}”’]/u;
const SENTENCE_END_PATTERN = /[.!?。！？]["'”’）)\]}]*$/u;
const WINDOWS_LINE_BREAK_MARKER = "";
const STRONG_CODE_KEYWORD_PATTERN = /\b(?:function|const|let|var|import|export|class|extends|def|public|private|protected|static|void|package|namespace|struct|enum|interface|impl|fn|func|async|await|yield)\b/u;
const WEAK_CODE_KEYWORD_PATTERN = /\b(?:return|if|else|elif|for|while|switch|case|default|break|continue|new|try|catch|finally|throw|using|with)\b/u;
const SQL_KEYWORD_PATTERN = /^\s*(?:SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|JOIN|GROUP|ORDER|HAVING|LIMIT|OFFSET|VALUES|UNION|DISTINCT|TABLE|INDEX|CASE|WHEN)\b/u;
const SQL_CONTEXT_PATTERN = /[,=*()\d]/u;
const LOG_LEVEL_PATTERN = /\b(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|VERBOSE)\b/iu;
const BRACKETED_LOG_LEVEL_PATTERN = /^\s*\[(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|VERBOSE)\]/iu;
const PREFIXED_LOG_LEVEL_PATTERN = /^\s*(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|VERBOSE)\b\s*[:|-]/iu;
const LOG_LEVEL_WITH_CONTEXT_PATTERN = /^\s*(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|VERBOSE)\b\s+(?:\[|\d+\s+---)/iu;
const LOG_TIMESTAMP_PATTERN = /^\s*\[?(?:\d{4}[-/]\d{2}[-/]\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,9})?)\]?/iu;
const LOG_MODULE_PREFIX_PATTERN = /^\s*\[[a-z][A-Za-z0-9.-]*\]\s+\S/u;
function classifySelectedLine(rawLine) {
  const trimmedLine = rawLine.trim();
  if (LIST_LINE_PATTERN.test(trimmedLine)) return "list";
  if (BLOCK_LINE_PATTERN.test(trimmedLine) || INDENTED_CODE_PATTERN.test(rawLine)) return "block";
  return "prose";
}
function resolveSoftLineSeparator(leftLine, rightLine) {
  const leftCharacter = leftLine.at(-1) ?? "";
  const rightCharacter = rightLine.at(0) ?? "";
  if (!leftCharacter || !rightCharacter) return "";
  if (CJK_CHARACTER_PATTERN.test(leftCharacter) && CJK_CHARACTER_PATTERN.test(rightCharacter)) {
    return "";
  }
  if (NO_SPACE_AFTER_PATTERN.test(leftCharacter) || NO_SPACE_BEFORE_PATTERN.test(rightCharacter)) {
    return "";
  }
  return " ";
}
function endsCompleteSentence(line) {
  return SENTENCE_END_PATTERN.test(line);
}
function isCodeLikeLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return false;
  if (/^[{}();,[\]]+$/u.test(line)) return true;
  if (/[{}]/u.test(line)) return true;
  if (/(?:=>|->|::|==|!=|<=|>=|&&|\|\||\+=|-=|\*=|\/=|\+\+|--)/u.test(line)) return true;
  if (/\/\/|\/\*|\*\/|^#\s|^<!--/u.test(line)) return true;
  if (/^<\/?[A-Za-z][\w:-]*(?:\s[^>]*)?\/?>$/u.test(line)) return true;
  if (STRONG_CODE_KEYWORD_PATTERN.test(line)) return true;
  if (WEAK_CODE_KEYWORD_PATTERN.test(line) && /[();:{}]/u.test(line)) return true;
  if (SQL_KEYWORD_PATTERN.test(line) && SQL_CONTEXT_PATTERN.test(line)) return true;
  if (/^["'][\w.$-]+["']\s*:/u.test(line)) return true;
  if (/^\s*[A-Za-z_$][\w$.\[\]]*\s*=\s*[^=]/u.test(line)) return true;
  if (/^[A-Za-z_$][\w$.<>\[\]]*\s+[A-Za-z_$][\w$]*\s*=\s*[^=]/u.test(line)) return true;
  if (/^[A-Za-z_$][\w$.]*\s*\([^)]*\)\s*[;{]?\s*$/u.test(line)) return true;
  return false;
}
function looksLikeCodeSelection(lines) {
  const meaningfulLines = lines.filter((line) => line.trim().length > 0);
  if (meaningfulLines.length < 2) return false;
  const codeLineCount = meaningfulLines.filter(isCodeLikeLine).length;
  return codeLineCount >= 2 && codeLineCount / meaningfulLines.length >= 0.5;
}
function isLogLikeLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return false;
  if (BRACKETED_LOG_LEVEL_PATTERN.test(line)) return true;
  if (PREFIXED_LOG_LEVEL_PATTERN.test(line)) return true;
  if (LOG_LEVEL_WITH_CONTEXT_PATTERN.test(line)) return true;
  if (LOG_MODULE_PREFIX_PATTERN.test(line)) return true;
  return LOG_TIMESTAMP_PATTERN.test(line) && LOG_LEVEL_PATTERN.test(line);
}
function looksLikeLogSelection(lines) {
  const meaningfulLines = lines.filter((line) => line.trim().length > 0);
  if (meaningfulLines.length < 2) return false;
  const logLineCount = meaningfulLines.filter(isLogLikeLine).length;
  return logLineCount >= 2 && logLineCount / meaningfulLines.length >= 0.5;
}
function normalizeSelectedText(text) {
  const normalizedText = String(text ?? "").replace(/\u00ad/gu, "").replace(/\u00a0/gu, " ").trim().replace(/\r\n/gu, `${WINDOWS_LINE_BREAK_MARKER}
`).replace(/\r|[\u2028\u2029]/gu, "\n");
  if (!normalizedText.includes("\n")) return normalizedText;
  const candidateText = normalizedText.split(WINDOWS_LINE_BREAK_MARKER).join("");
  const candidateLines = candidateText.split("\n");
  if (looksLikeCodeSelection(candidateLines) || looksLikeLogSelection(candidateLines)) {
    return candidateText.split("\n").map((line) => line.replace(/[ \t]+$/u, "")).join("\n");
  }
  const lines = normalizedText.split("\n");
  let result = "";
  let previousRawLine = "";
  let previousLineEndsWithWindowsBreak = false;
  let paragraphBreakPending = false;
  for (const rawLine of lines) {
    const lineEndsWithWindowsBreak = rawLine.endsWith(WINDOWS_LINE_BREAK_MARKER);
    const contentRawLine = lineEndsWithWindowsBreak ? rawLine.slice(0, -WINDOWS_LINE_BREAK_MARKER.length) : rawLine;
    const line = contentRawLine.trim();
    if (!line) {
      if (result) paragraphBreakPending = true;
      continue;
    }
    if (!result) {
      result = line;
    } else if (paragraphBreakPending) {
      result += `

${line}`;
    } else {
      const previousKind = classifySelectedLine(previousRawLine);
      const currentKind = classifySelectedLine(contentRawLine);
      const preserveLineBreak = previousLineEndsWithWindowsBreak || currentKind !== "prose" || previousKind === "block" || previousKind === "prose" && endsCompleteSentence(previousRawLine.trim());
      result += preserveLineBreak ? `
${line}` : `${resolveSoftLineSeparator(previousRawLine.trim(), line)}${line}`;
    }
    previousRawLine = contentRawLine;
    previousLineEndsWithWindowsBreak = lineEndsWithWindowsBreak;
    paragraphBreakPending = false;
  }
  return result;
}
const PREPARED_PREFETCH_WAIT_MS = 60;
function waitForCaptureDelay(delayMs, signal) {
  if (delayMs <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(finish, delayMs);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
function waitForPendingPreparation(pending, waitMs) {
  if (waitMs <= 0) return Promise.resolve({ settled: false, result: null });
  return new Promise((resolve) => {
    let finished = false;
    const startedAt = performance.now();
    let timer;
    const onTimeout = () => {
      if (finished) return;
      const remaining = waitMs - (performance.now() - startedAt);
      if (remaining > 0) {
        timer = setTimeout(onTimeout, remaining);
        return;
      }
      finished = true;
      resolve({ settled: false, result: null });
    };
    timer = setTimeout(onTimeout, waitMs);
    void pending.then(
      (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ settled: true, result });
      },
      () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ settled: true, result: null });
      }
    );
  });
}
class SelectionCaptureCoordinator {
  /**
   * 创建选中文字捕获协调器。
   * @param captureSelection 实际执行系统取词的异步函数。
   * @param prefetchSelection 按钮显示期间执行只读预取的异步函数；不注入复制键、不写剪贴板。
   * @param buttonCaptureSelection 点击“译”按钮后执行的专用取词函数；macOS/Windows 优先复制，避免再次等待原生直读。
   * @param options 可选配置。
   * @author zhenghq
   */
  constructor(captureSelection2, prefetchSelection, buttonCaptureSelection, options) {
    this.captureSelection = captureSelection2;
    this.prefetchSelection = prefetchSelection;
    this.buttonCaptureSelection = buttonCaptureSelection;
    this.options = options;
  }
  latestRequestId = 0;
  captureChain = Promise.resolve();
  preparedSelection = null;
  pendingPreparation = null;
  activeCaptureController = null;
  currentEntry;
  windowContext;
  /**
   * 标记下一次取词的入口类型，供诊断记录使用。
   * @param entry 入口类型：button / hotkey / auto。
   * @returns 无返回值。
   * @author zhenghq
   */
  markEntry(entry) {
    this.currentEntry = entry;
  }
  /**
   * 设置后续取词使用的源窗口上下文。
   * 传入 undefined 可显式清除上一轮窗口信息，避免窗口已失效时继续使用旧快照。
   * @param context 源窗口上下文；缺失时退化为应用级取词。
   * @returns 无返回值。
   * @author zhenghq
   */
  setWindowContext(context) {
    this.windowContext = context ? { ...context } : void 0;
  }
  /**
   * 在显示“译”按钮后后台捕获当前选中文字，并缓存结果供按钮点击时消费。
   * @param anchor 当前选区右上角锚点。
   * @param delayMs 开始系统取词前等待选区稳定的时长（毫秒）。
   * @returns 当前请求的捕获结果；如果请求已被更新则返回 null。
   * @author zhenghq
   */
  prepare(anchor, delayMs = 0) {
    this.preparedSelection = null;
    const pending = this.enqueue(anchor, true, delayMs, true);
    this.pendingPreparation = pending;
    void pending.then(() => {
      if (this.pendingPreparation === pending) this.pendingPreparation = null;
    });
    return pending;
  }
  /**
   * 捕获一次需要立即翻译的选中文字。
   * @param anchor 翻译弹窗使用的选区锚点。
   * @returns 当前请求的捕获结果；如果请求已被更新则返回 null。
   * @author zhenghq
   */
  capture(anchor) {
    this.preparedSelection = null;
    return this.enqueue(anchor, false, 0);
  }
  /**
   * 直接执行复制取词，跳过可能耗时的原生直读，供 Windows 全局快捷键使用。
   * @param anchor 翻译弹窗使用的选区锚点。
   * @returns 当前请求的捕获结果；如果请求已被更新则返回 null。
   * @author zhenghq
   */
  captureDirect(anchor) {
    this.preparedSelection = null;
    return this.enqueue(anchor, false, 0, false, true);
  }
  /**
   * 取消仍在进行的只读预取，并执行点击按钮专用取词，避免 AX/UIA 直读超时让选区过期。
   * @param anchor 翻译弹窗使用的选区锚点。
   * @returns 当前请求的捕获结果；如果请求已被更新则返回 null。
   * @author zhenghq
   */
  captureFromButton(anchor) {
    this.preparedSelection = null;
    this.pendingPreparation = null;
    return this.enqueue(anchor, false, 0, false, true);
  }
  /**
   * 消费按钮显示后已经缓存的选中文字，避免点击按钮后选区失效。
   * @returns 已缓存的捕获结果；没有可用缓存时返回 null。
   * @author zhenghq
   */
  consumePrepared() {
    const result = this.preparedSelection;
    this.preparedSelection = null;
    return result;
  }
  /**
   * 消费已经完成的预取结果；预取仍在执行时等待其完成，确保快速点击不会中止原选区取词。
   * @returns 当前预取结果；没有可消费结果或已被其他点击消费时返回 null。
   * @author zhenghq
   */
  async consumePreparedOrWait() {
    const prepared = this.consumePrepared();
    if (prepared) return prepared;
    const pending = this.pendingPreparation;
    if (!pending) return null;
    await pending;
    return this.consumePrepared();
  }
  /**
   * 在有界时间内消费只读预取结果，避免快速点击“译”按钮时丢弃即将完成的原生取词。
   * 已完成且含文本的缓存立即命中；预取仍在进行时最多等待 waitMs，超时后仅返回未命中，
   * 由调用方继续执行按钮专用取词，等待过程不会取消预取也不会无界阻塞按钮点击。
   * @param waitMs 允许等待进行中预取的最长时间（毫秒），默认 PREPARED_PREFETCH_WAIT_MS。
   * @returns 本次消费的判定状态、命中的预取结果与实际等待耗时。
   * @author zhenghq
   */
  async consumePreparedBounded(waitMs = PREPARED_PREFETCH_WAIT_MS) {
    const startedAt = performance.now();
    const requestId = this.latestRequestId;
    const prepared = this.consumePrepared();
    if (prepared?.text) return { status: "hit", result: prepared, waitedMs: 0 };
    if (prepared) return { status: "empty", result: null, waitedMs: 0 };
    const pending = this.pendingPreparation;
    if (!pending) return { status: "absent", result: null, waitedMs: 0 };
    const { settled } = await waitForPendingPreparation(pending, waitMs);
    const waitedMs = performance.now() - startedAt;
    if (requestId !== this.latestRequestId) {
      this.preparedSelection = null;
      return { status: "stale", result: null, waitedMs };
    }
    const late = this.consumePrepared();
    if (late?.text) return { status: "hit", result: late, waitedMs };
    if (settled) return { status: late ? "empty" : "absent", result: null, waitedMs };
    return { status: "timeout", result: null, waitedMs };
  }
  /**
   * 使当前及尚未完成的选区捕获请求失效。
   * @returns 无返回值。
   * @author zhenghq
   */
  invalidate() {
    this.latestRequestId += 1;
    this.preparedSelection = null;
    this.pendingPreparation = null;
    this.abortActiveCapture();
  }
  /**
   * 中止正在进行的系统取词，让粘贴或外部点击可以立即取回原剪贴板。
   * @returns 无返回值。
   * @author zhenghq
   */
  abortActiveCapture() {
    this.activeCaptureController?.abort();
    this.activeCaptureController = null;
  }
  /**
   * 将取词请求串行排队，并只保留最新一次请求的结果。
   * @param anchor 当前请求的选区锚点。
   * @param prepare 是否把捕获结果保存为按钮点击时使用的缓存。
   * @param delayMs 开始系统取词前等待选区稳定的时长（毫秒）。
   * @param usePrefetch 是否使用按钮显示期间的只读预取函数。
   * @param useButtonCapture 是否使用点击“译”按钮后的专用取词函数。
   * @returns 排队后的取词 Promise。
   * @author zhenghq
   */
  enqueue(anchor, prepare, delayMs, usePrefetch = false, useButtonCapture = false) {
    const requestId = ++this.latestRequestId;
    const windowContext = this.windowContext ? { ...this.windowContext } : void 0;
    this.abortActiveCapture();
    const task = this.captureChain.catch(() => void 0).then(async () => {
      if (requestId !== this.latestRequestId) return null;
      const controller = new AbortController();
      this.activeCaptureController = controller;
      let outcome = { text: "" };
      let error2;
      const captureStartedAt = Date.now();
      try {
        await waitForCaptureDelay(delayMs, controller.signal);
        if (controller.signal.aborted || requestId !== this.latestRequestId) return null;
        const capture = usePrefetch && this.prefetchSelection ? this.prefetchSelection : useButtonCapture && this.buttonCaptureSelection ? this.buttonCaptureSelection : this.captureSelection;
        const raw = await capture(controller.signal, windowContext);
        if (typeof raw === "string") {
          outcome = { text: normalizeSelectedText(raw) };
        } else {
          outcome = {
            text: normalizeSelectedText(raw?.text ?? ""),
            reason: raw?.reason,
            hasImage: Boolean(raw?.hasImage),
            diagnostics: raw?.diagnostics
          };
        }
      } catch (cause) {
        error2 = cause instanceof Error ? cause : new Error(String(cause));
      } finally {
        if (this.activeCaptureController === controller) {
          this.activeCaptureController = null;
        }
      }
      if (requestId !== this.latestRequestId || controller.signal.aborted) return null;
      const result = { text: outcome.text };
      if (outcome.reason) result.reason = outcome.reason;
      if (outcome.hasImage) result.hasImage = true;
      if (outcome.diagnostics) result.diagnostics = outcome.diagnostics;
      if (anchor) result.anchor = anchor;
      if (error2) result.error = error2;
      if (prepare) this.preparedSelection = result;
      if (!usePrefetch && this.options?.onDiagnostic) {
        const level = outcome.diagnostics?.level ?? (outcome.text ? "native-read" : "failed");
        this.options.onDiagnostic({
          at: Date.now(),
          entry: this.currentEntry,
          platform: process.platform,
          level,
          reason: outcome.diagnostics?.reason ?? outcome.reason,
          elapsedMs: Date.now() - captureStartedAt,
          app: "unknown",
          windowLocate: outcome.diagnostics?.windowLocate,
          windowCount: outcome.diagnostics?.windowCount,
          windowMatched: outcome.diagnostics?.windowMatched
        });
      }
      return result;
    });
    this.captureChain = task.then(() => void 0);
    return task;
  }
}
const CONSECUTIVE_TIMEOUT_THRESHOLD = 2;
const TIMEOUT_RESET_WINDOW_MS = 6e4;
let consecutiveTimeouts = 0;
let lastTimeoutAt = 0;
function recordCaptureOutcome(outcome, platform = process.platform, now = Date.now()) {
  if (platform !== "darwin") return false;
  if (outcome.text.trim()) {
    consecutiveTimeouts = 0;
    lastTimeoutAt = 0;
    return false;
  }
  if (outcome.reason !== "timeout") return false;
  if (now - lastTimeoutAt > TIMEOUT_RESET_WINDOW_MS) consecutiveTimeouts = 0;
  lastTimeoutAt = now;
  consecutiveTimeouts += 1;
  return consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_THRESHOLD;
}
function resetCopyTimeoutTracker() {
  consecutiveTimeouts = 0;
  lastTimeoutAt = 0;
}
function validateManualTranslationText(value, locale = "zh-CN") {
  const translator = typeof locale === "string" ? createTranslator(locale) : locale;
  if (typeof value !== "string") return translator.t("popup.validation.invalidSource");
  if (!value.trim()) return translator.t("popup.validation.emptySource");
  if (value.length > MANUAL_TRANSLATION_MAX_CHARS) {
    return translator.t("popup.validation.sourceTooLong", { max: MANUAL_TRANSLATION_MAX_CHARS });
  }
  return null;
}
const defaultFileAdapter = {
  exists: node_fs.existsSync,
  read: (path) => node_fs.readFileSync(path, "utf8"),
  mkdir: (path) => node_fs.mkdirSync(path, { recursive: true }),
  write: (path, content) => node_fs.writeFileSync(path, content, { mode: 384 }),
  rename: node_fs.renameSync,
  unlink: node_fs.unlinkSync
};
class DingTalkCredentialStore {
  constructor(path, safeStorage, files = defaultFileAdapter) {
    this.path = path;
    this.safeStorage = safeStorage;
    this.files = files;
    this.temporaryPath = `${path}.tmp`;
  }
  temporaryPath;
  /**
   * 读取并解密 ClientSecret，读取异常只返回脱敏错误。
   * @returns 凭证配置状态和主进程内部 Secret。
   * @author zhenghq
   */
  readSecret() {
    if (!this.files.exists(this.path)) return { configured: false, secret: null };
    if (!this.safeStorage.isEncryptionAvailable()) {
      return {
        configured: false,
        secret: null,
        error: translateMain("dingtalk.credential.secureStorageUnavailableRead")
      };
    }
    try {
      const raw = JSON.parse(this.files.read(this.path));
      if (raw.version !== 1 || typeof raw.dingTalkClientSecret !== "string" || !raw.dingTalkClientSecret) {
        throw new Error("invalid credential file");
      }
      const ciphertext = Buffer.from(raw.dingTalkClientSecret, "base64");
      const secret = this.safeStorage.decryptString(ciphertext);
      if (!secret) throw new Error("empty secret");
      return { configured: true, secret };
    } catch {
      return {
        configured: false,
        secret: null,
        error: translateMain("dingtalk.credential.readFailed")
      };
    }
  }
  /**
   * 加密并原子写入新的 ClientSecret；空值不会覆盖旧凭证。
   * @param secret 待保存的 ClientSecret。
   * @returns 无返回值。
   * @author zhenghq
   */
  saveSecret(secret) {
    const normalized = secret.trim();
    if (!normalized) return;
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error(translateMain("dingtalk.credential.secureStorageUnavailableSave"));
    }
    const ciphertext = this.safeStorage.encryptString(normalized).toString("base64");
    const payload = { version: 1, dingTalkClientSecret: ciphertext };
    this.files.mkdir(node_path.dirname(this.path));
    this.files.write(this.temporaryPath, JSON.stringify(payload));
    this.files.rename(this.temporaryPath, this.path);
  }
  /**
   * 显式删除持久化的 ClientSecret。
   * @returns 无返回值。
   * @author zhenghq
   */
  clearSecret() {
    if (this.files.exists(this.path)) this.files.unlink(this.path);
    if (this.files.exists(this.temporaryPath)) this.files.unlink(this.temporaryPath);
  }
}
class DingTalkConfigurationService {
  constructor(dependencies) {
    this.dependencies = dependencies;
  }
  secret = null;
  credentialError;
  /**
   * 加载安全凭证并同步公开的已配置标记。
   * @returns 同步后的公开设置。
   * @author zhenghq
   */
  initialize() {
    const loaded = this.dependencies.credentialStore.readSecret();
    this.secret = loaded.secret;
    this.credentialError = loaded.error;
    const settings = this.dependencies.getSettings();
    if (settings.dingTalkSecretConfigured === loaded.configured) return settings;
    return this.dependencies.saveSettings({ dingTalkSecretConfigured: loaded.configured });
  }
  /**
   * 应用钉钉配置补丁；空 Secret 保留旧值，失败时回滚已写入的凭证。
   * @param patch 钉钉启用状态、标识字段和可选新 Secret。
   * @returns 保存成功后的脱敏公开设置。
   * @author zhenghq
   */
  applyPatch(patch) {
    const previousSettings = this.dependencies.getSettings();
    const previousSecret = this.secret;
    const submittedSecret = typeof patch.clientSecret === "string" ? patch.clientSecret.trim() : "";
    const nextSecret = submittedSecret || previousSecret;
    const secretChanged = Boolean(submittedSecret) && submittedSecret !== previousSecret;
    const nextPatch = {
      dingTalkEnabled: typeof patch.enabled === "boolean" ? patch.enabled : previousSettings.dingTalkEnabled,
      dingTalkCorpId: patch.corpId === void 0 ? previousSettings.dingTalkCorpId : patch.corpId.trim(),
      dingTalkClientId: patch.clientId === void 0 ? previousSettings.dingTalkClientId : patch.clientId.trim(),
      dingTalkSecretConfigured: nextSecret != null
    };
    const configurationChanged = secretChanged || nextPatch.dingTalkEnabled !== previousSettings.dingTalkEnabled || nextPatch.dingTalkCorpId !== previousSettings.dingTalkCorpId || nextPatch.dingTalkClientId !== previousSettings.dingTalkClientId;
    if (secretChanged) this.dependencies.credentialStore.saveSecret(submittedSecret);
    let settings;
    try {
      settings = this.dependencies.saveSettings(nextPatch);
    } catch (error2) {
      if (secretChanged) this.restoreSecret(previousSecret);
      throw error2;
    }
    this.secret = nextSecret;
    this.credentialError = void 0;
    if (configurationChanged) this.dependencies.resetTranslationRuntime?.();
    this.dependencies.onSettingsChanged?.(settings);
    return settings;
  }
  /**
   * 显式清除 ClientSecret，并在公开设置保存失败时恢复旧凭证。
   * @returns 清除后的脱敏公开设置。
   * @author zhenghq
   */
  clearSecret() {
    const previousSettings = this.dependencies.getSettings();
    const previousSecret = this.secret;
    this.dependencies.credentialStore.clearSecret();
    let settings;
    try {
      settings = this.dependencies.saveSettings({ dingTalkSecretConfigured: false });
    } catch (error2) {
      this.restoreSecret(previousSecret);
      throw error2;
    }
    this.secret = null;
    this.credentialError = void 0;
    if (previousSecret != null || previousSettings.dingTalkSecretConfigured) {
      this.dependencies.resetTranslationRuntime?.();
    }
    this.dependencies.onSettingsChanged?.(settings);
    return settings;
  }
  /**
   * 获取当前请求使用的主进程凭证快照，可选择是否要求启用开关已开启。
   * @param requireEnabled 是否要求钉钉启用开关为开启状态。
   * @returns 配置完整时的凭证快照，否则返回 null。
   * @author zhenghq
   */
  getCredentialsSnapshot(requireEnabled = true) {
    const settings = this.dependencies.getSettings();
    if (requireEnabled && !settings.dingTalkEnabled) return null;
    if (!settings.dingTalkCorpId || !settings.dingTalkClientId || !this.secret) return null;
    return {
      corpId: settings.dingTalkCorpId,
      clientId: settings.dingTalkClientId,
      clientSecret: this.secret
    };
  }
  /**
   * 返回读取安全凭证时产生的脱敏错误。
   * @returns 脱敏凭证错误，未发生错误时为 undefined。
   * @author zhenghq
   */
  getCredentialError() {
    return this.credentialError;
  }
  /**
   * 将凭证存储恢复到指定 Secret，用于配置事务失败回滚。
   * @param secret 需要恢复的旧 Secret；null 表示恢复为未配置。
   * @returns 无返回值。
   * @author zhenghq
   */
  restoreSecret(secret) {
    try {
      if (secret == null) this.dependencies.credentialStore.clearSecret();
      else this.dependencies.credentialStore.saveSecret(secret);
    } catch {
    }
  }
}
class AiCredentialStore {
  constructor(path, safeStorage) {
    this.path = path;
    this.safeStorage = safeStorage;
    this.temporaryPath = `${path}.tmp`;
  }
  temporaryPath;
  /**
   * 读取并解密 AI API Key，读取异常只返回脱敏错误。
   * @returns 凭证配置状态和主进程内部 API Key。
   * @author zhenghq
   */
  readApiKey() {
    if (!node_fs.existsSync(this.path)) return { configured: false, apiKey: null };
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { configured: false, apiKey: null, error: translateMain("ai.credentials.secureStorageReadUnavailable") };
    }
    try {
      const raw = JSON.parse(node_fs.readFileSync(this.path, "utf8"));
      if (raw.version !== 1 || typeof raw.aiApiKey !== "string" || !raw.aiApiKey) {
        throw new Error("invalid ai credential file");
      }
      const ciphertext = Buffer.from(raw.aiApiKey, "base64");
      const apiKey = this.safeStorage.decryptString(ciphertext);
      if (!apiKey) throw new Error("empty api key");
      return { configured: true, apiKey };
    } catch {
      return { configured: false, apiKey: null, error: translateMain("ai.credentials.readFailed") };
    }
  }
  /**
   * 加密并原子写入新的 AI API Key；空值不会覆盖旧凭证。
   * @param apiKey 待保存的 API Key。
   * @returns 无返回值。
   * @author zhenghq
   */
  saveApiKey(apiKey) {
    const normalized = apiKey.trim();
    if (!normalized) return;
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error(translateMain("ai.credentials.secureStorageWriteUnavailable"));
    }
    const ciphertext = this.safeStorage.encryptString(normalized).toString("base64");
    const payload = { version: 1, aiApiKey: ciphertext };
    node_fs.mkdirSync(node_path.dirname(this.path), { recursive: true });
    node_fs.writeFileSync(this.temporaryPath, JSON.stringify(payload), { mode: 384 });
    node_fs.renameSync(this.temporaryPath, this.path);
  }
  /**
   * 显式删除持久化的 AI API Key。
   * @returns 无返回值。
   * @author zhenghq
   */
  clearApiKey() {
    if (node_fs.existsSync(this.path)) node_fs.unlinkSync(this.path);
    if (node_fs.existsSync(this.temporaryPath)) node_fs.unlinkSync(this.temporaryPath);
  }
}
class AiConfigurationService {
  constructor(dependencies) {
    this.dependencies = dependencies;
  }
  apiKey = null;
  /**
   * 加载安全凭证并同步公开的已配置标记。
   * @returns 同步后的公开设置。
   * @author zhenghq
   */
  initialize() {
    const loaded = this.dependencies.credentialStore.readApiKey();
    this.apiKey = loaded.apiKey;
    const settings = this.dependencies.getSettings();
    if (settings.aiApiKeyConfigured === loaded.configured) return settings;
    return this.dependencies.saveSettings({ aiApiKeyConfigured: loaded.configured });
  }
  /**
   * 应用 AI 配置补丁；空 API Key 保留旧值，失败时回滚已写入的凭证。
   * @param patch AI 启用状态、协议、Base URL、模型和可选新 API Key。
   * @returns 保存成功后的脱敏公开设置。
   * @author zhenghq
   */
  applyPatch(patch) {
    const previousSettings = this.dependencies.getSettings();
    const previousApiKey = this.apiKey;
    const submittedKey = typeof patch.apiKey === "string" ? patch.apiKey.trim() : "";
    const nextApiKey = submittedKey || previousApiKey;
    const keyChanged = Boolean(submittedKey) && submittedKey !== previousApiKey;
    const nextPatch = {
      aiEnabled: typeof patch.enabled === "boolean" ? patch.enabled : previousSettings.aiEnabled,
      aiProtocol: patch.protocol === void 0 ? previousSettings.aiProtocol : patch.protocol,
      aiBaseUrl: patch.baseUrl === void 0 ? previousSettings.aiBaseUrl : patch.baseUrl,
      aiModel: patch.model === void 0 ? previousSettings.aiModel : patch.model,
      aiApiKeyConfigured: nextApiKey != null
    };
    const configurationChanged = keyChanged || nextPatch.aiEnabled !== previousSettings.aiEnabled || nextPatch.aiProtocol !== previousSettings.aiProtocol || nextPatch.aiBaseUrl !== previousSettings.aiBaseUrl || nextPatch.aiModel !== previousSettings.aiModel;
    if (keyChanged) this.dependencies.credentialStore.saveApiKey(submittedKey);
    let settings;
    try {
      settings = this.dependencies.saveSettings(nextPatch);
    } catch (error2) {
      if (keyChanged) this.restoreApiKey(previousApiKey);
      throw error2;
    }
    this.apiKey = nextApiKey;
    if (configurationChanged) this.dependencies.resetTranslationRuntime?.();
    this.dependencies.onSettingsChanged?.(settings);
    return settings;
  }
  /**
   * 显式清除 API Key，并在公开设置保存失败时恢复旧凭证。
   * @returns 清除后的脱敏公开设置。
   * @author zhenghq
   */
  clearApiKey() {
    const previousSettings = this.dependencies.getSettings();
    const previousApiKey = this.apiKey;
    this.dependencies.credentialStore.clearApiKey();
    let settings;
    try {
      settings = this.dependencies.saveSettings({ aiApiKeyConfigured: false });
    } catch (error2) {
      this.restoreApiKey(previousApiKey);
      throw error2;
    }
    this.apiKey = null;
    if (previousApiKey != null || previousSettings.aiApiKeyConfigured) {
      this.dependencies.resetTranslationRuntime?.();
    }
    this.dependencies.onSettingsChanged?.(settings);
    return settings;
  }
  /**
   * 获取当前主进程使用的 API Key 快照。
   * @returns 解密后的 API Key 或 null。
   * @author zhenghq
   */
  getApiKey() {
    return this.apiKey;
  }
  /**
   * 在保存失败后恢复旧凭证。
   * @param previousApiKey 之前的 API Key。
   * @returns 无返回值。
   * @author zhenghq
   */
  restoreApiKey(previousApiKey) {
    this.apiKey = previousApiKey;
    if (previousApiKey) {
      this.dependencies.credentialStore.saveApiKey(previousApiKey);
    } else {
      this.dependencies.credentialStore.clearApiKey();
    }
  }
}
class AiModelDiscoveryService {
  constructor(options) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 1e4;
  }
  timeoutMs;
  cache = /* @__PURE__ */ new Map();
  /**
    * 调用协议模型列表接口并返回去空、去重、排序后的模型名称。
  * @param input 协议、Base URL 和凭证信息。
  * @returns 结构化脱敏模型列表结果。
  * @author zhenghq
    */
  async listModels(input) {
    const cacheKey = this.cacheKey(input);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.state === "success") return cached;
    const baseUrl = normalizeAiBaseUrl(input.baseUrl);
    const headers = { Accept: "application/json" };
    if (input.apiKey) {
      if (input.protocol === "openai") headers["Authorization"] = `Bearer ${input.apiKey}`;
      else if (input.protocol === "claude-code") {
        headers["x-api-key"] = input.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      }
    }
    const url = this.modelsUrl(input.protocol, baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortPromise = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("timeout")));
    });
    let response;
    try {
      response = await Promise.race([
        this.options.fetch(url, { method: "GET", headers, signal: controller.signal }),
        abortPromise
      ]);
    } catch (error2) {
      clearTimeout(timer);
      return { state: "error", models: [], message: this.toUserMessage(error2) };
    }
    clearTimeout(timer);
    if (!response.ok) {
      if (input.protocol === "claude-code" && response.status === 404) {
        return { state: "unsupported", models: [], message: translateMain("ai.modelDiscovery.unsupported") };
      }
      return { state: "error", models: [], message: this.statusMessage(response.status) };
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      if (input.protocol === "claude-code") {
        return { state: "unsupported", models: [], message: translateMain("ai.modelDiscovery.unsupported") };
      }
      return { state: "error", models: [], message: translateMain("ai.modelDiscovery.unsupportedResponse") };
    }
    let data;
    try {
      data = await response.json();
    } catch {
      return { state: "error", models: [], message: translateMain("ai.modelDiscovery.parseFailed") };
    }
    const models = this.extractModels(input.protocol, data);
    const result = { state: "success", models };
    this.cache.set(cacheKey, result);
    return result;
  }
  /**
    * 清理协议、Base URL 或 API Key 变化后的模型列表缓存。
  * @returns 无返回值。
  * @author zhenghq
    */
  clearCache() {
    this.cache.clear();
  }
  /**
    * 构造模型列表缓存键。
  * @param input 模型发现请求输入。
  * @returns 缓存键。
  * @author zhenghq
    */
  cacheKey(input) {
    return `${input.protocol}|${normalizeAiBaseUrl(input.baseUrl)}|${input.apiKey ? "key" : "none"}`;
  }
  /**
    * 根据协议构造模型列表请求 URL。
  * @param protocol AI 协议类型。
  * @param baseUrl 规范化后的 Base URL。
  * @returns 模型列表请求 URL。
  * @author zhenghq
    */
  modelsUrl(protocol, baseUrl) {
    switch (protocol) {
      case "ollama":
        return `${baseUrl}/api/tags`;
      case "openai":
        return `${baseUrl}/models`;
      case "claude-code":
        return `${baseUrl}/v1/models`;
      default:
        return `${baseUrl}/models`;
    }
  }
  /**
    * 根据协议从响应中提取、去空、去重、排序模型名称。
  * @param protocol AI 协议类型。
  * @param data 已解析的 JSON 对象。
  * @returns 规范化后的模型名称列表。
  * @author zhenghq
    */
  extractModels(protocol, data) {
    let raw = [];
    if (protocol === "ollama") {
      raw = data.models ?? [];
      raw = raw.map((item) => item.name);
    } else {
      raw = data.data ?? [];
      raw = raw.map((item) => item.id);
    }
    const names = raw.filter((value) => typeof value === "string" && value.trim() !== "").map((value) => value.trim());
    return Array.from(new Set(names)).sort();
  }
  /**
    * 将网络异常转换为脱敏用户提示。
  * @param error 捕获到的异常。
  * @returns 不含 URL、API Key 的提示。
  * @author zhenghq
    */
  toUserMessage(error2) {
    const normalized = normalizeAiNetworkError(error2);
    return normalized.message;
  }
  /**
    * 根据 HTTP 状态码返回脱敏提示。
  * @param status HTTP 状态码。
  * @returns 脱敏提示文本。
  * @author zhenghq
    */
  statusMessage(status) {
    if (status === 401 || status === 403) return translateMain("ai.modelDiscovery.authentication");
    if (status === 429) return translateMain("ai.modelDiscovery.rateLimit");
    return translateMain("ai.modelDiscovery.loadFailed");
  }
}
class AiCheckService {
  client;
  constructor(options) {
    this.client = new AiTranslationClient({ fetch: options.fetch, timeoutMs: options.timeoutMs });
  }
  /**
    * 检测当前 AI 配置能否完成一次最小翻译请求。
  * @param input 当前设置和 API Key。
  * @returns 结构化脱敏检测状态。
  * @author zhenghq
    */
  async check(input) {
    const { settings, apiKey } = input;
    if (!settings.aiBaseUrl.trim() || !settings.aiModel.trim()) {
      return { ok: false, code: "incomplete", message: translateMain("ai.check.incomplete") };
    }
    try {
      const translation = await this.client.translate({
        protocol: settings.aiProtocol,
        baseUrl: settings.aiBaseUrl,
        model: settings.aiModel,
        apiKey,
        text: "hello",
        sourceLang: "EN",
        targetLang: "ZH"
      });
      if (!translation) {
        return { ok: false, code: "service", message: translateMain("ai.error.emptyTranslation") };
      }
      return { ok: true, code: "available", message: translateMain("ai.check.available") };
    } catch (error2) {
      return this.toCheckStatus(error2);
    }
  }
  /**
    * 将内部 AI 错误转换为设置页可展示的结构化脱敏状态。
  * @param error AI 内部错误或未知异常。
  * @returns 不包含 API Key、鉴权 URL 和完整请求头的检测状态。
  * @author zhenghq
    */
  toCheckStatus(error2) {
    if (error2 instanceof AiError) {
      switch (error2.kind) {
        case "authentication":
          return { ok: false, code: "authentication", message: translateMain("ai.error.authentication") };
        case "permission":
          return { ok: false, code: "permission", message: translateMain("ai.check.permission") };
        case "rate-limit":
          return { ok: false, code: "rate-limit", message: translateMain("ai.check.rateLimit") };
        case "not-found":
          return { ok: false, code: "not-found", message: translateMain("ai.error.notFound") };
        case "network":
          return { ok: false, code: "network", message: error2.message };
        case "timeout":
          return { ok: false, code: "timeout", message: error2.message };
        default:
          return { ok: false, code: "service", message: translateMain("ai.check.serviceUnavailable") };
      }
    }
    return { ok: false, code: "network", message: translateMain("ai.error.network") };
  }
}
class DeepLxConfigurationService {
  constructor(dependencies) {
    this.dependencies = dependencies;
  }
  /**
   * 应用 DeepLX 多地址配置。
   * @param patch DeepLX 配置补丁。
   * @returns 保存后的公开设置。
   * @author zhenghq
   */
  applyPatch(patch) {
    const previousSettings = this.dependencies.getSettings();
    const nextUrl = patch.url === void 0 ? previousSettings.deepLxUrl : patch.url.trim();
    const settings = this.dependencies.saveSettings({ deepLxUrl: nextUrl });
    if (nextUrl !== previousSettings.deepLxUrl) this.dependencies.resetTranslationRuntime?.();
    this.dependencies.onSettingsChanged?.(settings);
    return settings;
  }
}
class DeepLxCheckService {
  constructor(dependencies) {
    this.dependencies = dependencies;
    this.timeoutMs = dependencies.timeoutMs ?? 3e3;
  }
  timeoutMs;
  /**
   * 检测中英文逗号分隔的所有 DeepLX 地址。
   * @param value DeepLX 地址列表。
   * @returns 多地址汇总在线状态。
   * @author zhenghq
   */
  async check(value) {
    const urls = parseDeepLxUrls(value);
    if (urls.length === 0) return { url: "", online: false, message: translateMain("deepLx.check.notConfigured") };
    const results = await Promise.all(urls.map((url) => this.checkEndpoint(url)));
    const onlineCount = results.filter((result) => result.online).length;
    const summary = translateMain("deepLx.check.summary", { online: onlineCount, total: urls.length });
    if (onlineCount > 0) return { url: "", online: true, message: summary };
    const reason = results.find((result) => result.message)?.message;
    return {
      url: "",
      online: false,
      message: reason ? `${summary}：${reason}` : summary
    };
  }
  /**
   * 检测一个 DeepLX 翻译端点并将错误转换为脱敏提示。
   * @param url 单个 DeepLX 翻译端点。
   * @returns 单地址内部检测结果。
   * @author zhenghq
   */
  async checkEndpoint(url) {
    try {
      const response = await this.dependencies.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "ping", source_lang: "en", target_lang: "zh" }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      let code;
      try {
        const body = await response.json();
        code = body.code;
      } catch {
      }
      if (response.ok && code === 200) return { online: true };
      return { online: false, message: `HTTP ${response.status}` };
    } catch (error2) {
      if (this.isTimeoutError(error2)) return { online: false, message: translateMain("deepLx.check.timeout") };
      return { online: false, message: translateMain("deepLx.check.network") };
    }
  }
  /**
   * 判断请求异常是否由超时或中止引起。
   * @param error 捕获到的未知异常。
   * @returns 是超时异常时返回 true。
   * @author zhenghq
   */
  isTimeoutError(error2) {
    if (!(error2 instanceof Error)) return false;
    return error2.name === "TimeoutError" || error2.name === "AbortError" || /abort|timeout/iu.test(error2.message);
  }
}
function isMacOSDiskImageExecution(platform, executablePath) {
  if (platform !== "darwin") return false;
  return executablePath.replace(/\/{2,}/gu, "/").startsWith("/Volumes/");
}
function shouldOpenSettingsOnInitialLaunch(platform) {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}
var out = {};
var CancellationToken$1 = {};
Object.defineProperty(CancellationToken$1, "__esModule", { value: true });
CancellationToken$1.CancellationError = CancellationToken$1.CancellationToken = void 0;
const events_1 = require$$0;
class CancellationToken extends events_1.EventEmitter {
  get cancelled() {
    return this._cancelled || this._parent != null && this._parent.cancelled;
  }
  set parent(value) {
    this.removeParentCancelHandler();
    this._parent = value;
    this.parentCancelHandler = () => this.cancel();
    this._parent.onCancel(this.parentCancelHandler);
  }
  // babel cannot compile ... correctly for super calls
  constructor(parent) {
    super();
    this.parentCancelHandler = null;
    this._parent = null;
    this._cancelled = false;
    if (parent != null) {
      this.parent = parent;
    }
  }
  cancel() {
    this._cancelled = true;
    this.emit("cancel");
  }
  onCancel(handler) {
    if (this.cancelled) {
      handler();
    } else {
      this.once("cancel", handler);
    }
  }
  createPromise(callback2) {
    if (this.cancelled) {
      return Promise.reject(new CancellationError());
    }
    const finallyHandler = () => {
      if (cancelHandler != null) {
        try {
          this.removeListener("cancel", cancelHandler);
          cancelHandler = null;
        } catch (_ignore) {
        }
      }
    };
    let cancelHandler = null;
    return new Promise((resolve, reject) => {
      let addedCancelHandler = null;
      cancelHandler = () => {
        try {
          if (addedCancelHandler != null) {
            addedCancelHandler();
            addedCancelHandler = null;
          }
        } finally {
          reject(new CancellationError());
        }
      };
      if (this.cancelled) {
        cancelHandler();
        return;
      }
      this.onCancel(cancelHandler);
      callback2(resolve, reject, (callback3) => {
        addedCancelHandler = callback3;
      });
    }).then((it) => {
      finallyHandler();
      return it;
    }).catch((e) => {
      finallyHandler();
      throw e;
    });
  }
  removeParentCancelHandler() {
    const parent = this._parent;
    if (parent != null && this.parentCancelHandler != null) {
      parent.removeListener("cancel", this.parentCancelHandler);
      this.parentCancelHandler = null;
    }
  }
  dispose() {
    try {
      this.removeParentCancelHandler();
    } finally {
      this.removeAllListeners();
      this._parent = null;
    }
  }
}
CancellationToken$1.CancellationToken = CancellationToken;
class CancellationError extends Error {
  constructor() {
    super("cancelled");
  }
}
CancellationToken$1.CancellationError = CancellationError;
var error = {};
Object.defineProperty(error, "__esModule", { value: true });
error.newError = newError;
function newError(message, code) {
  const error2 = new Error(message);
  error2.code = code;
  return error2;
}
var httpExecutor = {};
var src = { exports: {} };
var browser = { exports: {} };
var ms;
var hasRequiredMs;
function requireMs() {
  if (hasRequiredMs) return ms;
  hasRequiredMs = 1;
  var s = 1e3;
  var m = s * 60;
  var h = m * 60;
  var d = h * 24;
  var w = d * 7;
  var y = d * 365.25;
  ms = function(val, options) {
    options = options || {};
    var type = typeof val;
    if (type === "string" && val.length > 0) {
      return parse(val);
    } else if (type === "number" && isFinite(val)) {
      return options.long ? fmtLong(val) : fmtShort(val);
    }
    throw new Error(
      "val is not a non-empty string or a valid number. val=" + JSON.stringify(val)
    );
  };
  function parse(str) {
    str = String(str);
    if (str.length > 100) {
      return;
    }
    var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
      str
    );
    if (!match) {
      return;
    }
    var n = parseFloat(match[1]);
    var type = (match[2] || "ms").toLowerCase();
    switch (type) {
      case "years":
      case "year":
      case "yrs":
      case "yr":
      case "y":
        return n * y;
      case "weeks":
      case "week":
      case "w":
        return n * w;
      case "days":
      case "day":
      case "d":
        return n * d;
      case "hours":
      case "hour":
      case "hrs":
      case "hr":
      case "h":
        return n * h;
      case "minutes":
      case "minute":
      case "mins":
      case "min":
      case "m":
        return n * m;
      case "seconds":
      case "second":
      case "secs":
      case "sec":
      case "s":
        return n * s;
      case "milliseconds":
      case "millisecond":
      case "msecs":
      case "msec":
      case "ms":
        return n;
      default:
        return void 0;
    }
  }
  function fmtShort(ms2) {
    var msAbs = Math.abs(ms2);
    if (msAbs >= d) {
      return Math.round(ms2 / d) + "d";
    }
    if (msAbs >= h) {
      return Math.round(ms2 / h) + "h";
    }
    if (msAbs >= m) {
      return Math.round(ms2 / m) + "m";
    }
    if (msAbs >= s) {
      return Math.round(ms2 / s) + "s";
    }
    return ms2 + "ms";
  }
  function fmtLong(ms2) {
    var msAbs = Math.abs(ms2);
    if (msAbs >= d) {
      return plural(ms2, msAbs, d, "day");
    }
    if (msAbs >= h) {
      return plural(ms2, msAbs, h, "hour");
    }
    if (msAbs >= m) {
      return plural(ms2, msAbs, m, "minute");
    }
    if (msAbs >= s) {
      return plural(ms2, msAbs, s, "second");
    }
    return ms2 + " ms";
  }
  function plural(ms2, msAbs, n, name) {
    var isPlural = msAbs >= n * 1.5;
    return Math.round(ms2 / n) + " " + name + (isPlural ? "s" : "");
  }
  return ms;
}
var common;
var hasRequiredCommon;
function requireCommon() {
  if (hasRequiredCommon) return common;
  hasRequiredCommon = 1;
  function setup(env) {
    createDebug.debug = createDebug;
    createDebug.default = createDebug;
    createDebug.coerce = coerce;
    createDebug.disable = disable;
    createDebug.enable = enable;
    createDebug.enabled = enabled;
    createDebug.humanize = requireMs();
    createDebug.destroy = destroy;
    Object.keys(env).forEach((key) => {
      createDebug[key] = env[key];
    });
    createDebug.names = [];
    createDebug.skips = [];
    createDebug.formatters = {};
    function selectColor(namespace) {
      let hash = 0;
      for (let i = 0; i < namespace.length; i++) {
        hash = (hash << 5) - hash + namespace.charCodeAt(i);
        hash |= 0;
      }
      return createDebug.colors[Math.abs(hash) % createDebug.colors.length];
    }
    createDebug.selectColor = selectColor;
    function createDebug(namespace) {
      let prevTime;
      let enableOverride = null;
      let namespacesCache;
      let enabledCache;
      function debug2(...args) {
        if (!debug2.enabled) {
          return;
        }
        const self = debug2;
        const curr = Number(/* @__PURE__ */ new Date());
        const ms2 = curr - (prevTime || curr);
        self.diff = ms2;
        self.prev = prevTime;
        self.curr = curr;
        prevTime = curr;
        args[0] = createDebug.coerce(args[0]);
        if (typeof args[0] !== "string") {
          args.unshift("%O");
        }
        let index = 0;
        args[0] = args[0].replace(/%([a-zA-Z%])/g, (match, format) => {
          if (match === "%%") {
            return "%";
          }
          index++;
          const formatter = createDebug.formatters[format];
          if (typeof formatter === "function") {
            const val = args[index];
            match = formatter.call(self, val);
            args.splice(index, 1);
            index--;
          }
          return match;
        });
        createDebug.formatArgs.call(self, args);
        const logFn = self.log || createDebug.log;
        logFn.apply(self, args);
      }
      debug2.namespace = namespace;
      debug2.useColors = createDebug.useColors();
      debug2.color = createDebug.selectColor(namespace);
      debug2.extend = extend;
      debug2.destroy = createDebug.destroy;
      Object.defineProperty(debug2, "enabled", {
        enumerable: true,
        configurable: false,
        get: () => {
          if (enableOverride !== null) {
            return enableOverride;
          }
          if (namespacesCache !== createDebug.namespaces) {
            namespacesCache = createDebug.namespaces;
            enabledCache = createDebug.enabled(namespace);
          }
          return enabledCache;
        },
        set: (v) => {
          enableOverride = v;
        }
      });
      if (typeof createDebug.init === "function") {
        createDebug.init(debug2);
      }
      return debug2;
    }
    function extend(namespace, delimiter) {
      const newDebug = createDebug(this.namespace + (typeof delimiter === "undefined" ? ":" : delimiter) + namespace);
      newDebug.log = this.log;
      return newDebug;
    }
    function enable(namespaces) {
      createDebug.save(namespaces);
      createDebug.namespaces = namespaces;
      createDebug.names = [];
      createDebug.skips = [];
      const split = (typeof namespaces === "string" ? namespaces : "").trim().replace(/\s+/g, ",").split(",").filter(Boolean);
      for (const ns of split) {
        if (ns[0] === "-") {
          createDebug.skips.push(ns.slice(1));
        } else {
          createDebug.names.push(ns);
        }
      }
    }
    function matchesTemplate(search, template) {
      let searchIndex = 0;
      let templateIndex = 0;
      let starIndex = -1;
      let matchIndex = 0;
      while (searchIndex < search.length) {
        if (templateIndex < template.length && (template[templateIndex] === search[searchIndex] || template[templateIndex] === "*")) {
          if (template[templateIndex] === "*") {
            starIndex = templateIndex;
            matchIndex = searchIndex;
            templateIndex++;
          } else {
            searchIndex++;
            templateIndex++;
          }
        } else if (starIndex !== -1) {
          templateIndex = starIndex + 1;
          matchIndex++;
          searchIndex = matchIndex;
        } else {
          return false;
        }
      }
      while (templateIndex < template.length && template[templateIndex] === "*") {
        templateIndex++;
      }
      return templateIndex === template.length;
    }
    function disable() {
      const namespaces = [
        ...createDebug.names,
        ...createDebug.skips.map((namespace) => "-" + namespace)
      ].join(",");
      createDebug.enable("");
      return namespaces;
    }
    function enabled(name) {
      for (const skip of createDebug.skips) {
        if (matchesTemplate(name, skip)) {
          return false;
        }
      }
      for (const ns of createDebug.names) {
        if (matchesTemplate(name, ns)) {
          return true;
        }
      }
      return false;
    }
    function coerce(val) {
      if (val instanceof Error) {
        return val.stack || val.message;
      }
      return val;
    }
    function destroy() {
      console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
    }
    createDebug.enable(createDebug.load());
    return createDebug;
  }
  common = setup;
  return common;
}
var hasRequiredBrowser;
function requireBrowser() {
  if (hasRequiredBrowser) return browser.exports;
  hasRequiredBrowser = 1;
  (function(module2, exports) {
    exports.formatArgs = formatArgs;
    exports.save = save;
    exports.load = load;
    exports.useColors = useColors;
    exports.storage = localstorage();
    exports.destroy = /* @__PURE__ */ (() => {
      let warned = false;
      return () => {
        if (!warned) {
          warned = true;
          console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
        }
      };
    })();
    exports.colors = [
      "#0000CC",
      "#0000FF",
      "#0033CC",
      "#0033FF",
      "#0066CC",
      "#0066FF",
      "#0099CC",
      "#0099FF",
      "#00CC00",
      "#00CC33",
      "#00CC66",
      "#00CC99",
      "#00CCCC",
      "#00CCFF",
      "#3300CC",
      "#3300FF",
      "#3333CC",
      "#3333FF",
      "#3366CC",
      "#3366FF",
      "#3399CC",
      "#3399FF",
      "#33CC00",
      "#33CC33",
      "#33CC66",
      "#33CC99",
      "#33CCCC",
      "#33CCFF",
      "#6600CC",
      "#6600FF",
      "#6633CC",
      "#6633FF",
      "#66CC00",
      "#66CC33",
      "#9900CC",
      "#9900FF",
      "#9933CC",
      "#9933FF",
      "#99CC00",
      "#99CC33",
      "#CC0000",
      "#CC0033",
      "#CC0066",
      "#CC0099",
      "#CC00CC",
      "#CC00FF",
      "#CC3300",
      "#CC3333",
      "#CC3366",
      "#CC3399",
      "#CC33CC",
      "#CC33FF",
      "#CC6600",
      "#CC6633",
      "#CC9900",
      "#CC9933",
      "#CCCC00",
      "#CCCC33",
      "#FF0000",
      "#FF0033",
      "#FF0066",
      "#FF0099",
      "#FF00CC",
      "#FF00FF",
      "#FF3300",
      "#FF3333",
      "#FF3366",
      "#FF3399",
      "#FF33CC",
      "#FF33FF",
      "#FF6600",
      "#FF6633",
      "#FF9900",
      "#FF9933",
      "#FFCC00",
      "#FFCC33"
    ];
    function useColors() {
      if (typeof window !== "undefined" && window.process && (window.process.type === "renderer" || window.process.__nwjs)) {
        return true;
      }
      if (typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
        return false;
      }
      let m;
      return typeof document !== "undefined" && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance || // Is firebug? http://stackoverflow.com/a/398120/376773
      typeof window !== "undefined" && window.console && (window.console.firebug || window.console.exception && window.console.table) || // Is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      typeof navigator !== "undefined" && navigator.userAgent && (m = navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/)) && parseInt(m[1], 10) >= 31 || // Double check webkit in userAgent just in case we are in a worker
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/);
    }
    function formatArgs(args) {
      args[0] = (this.useColors ? "%c" : "") + this.namespace + (this.useColors ? " %c" : " ") + args[0] + (this.useColors ? "%c " : " ") + "+" + module2.exports.humanize(this.diff);
      if (!this.useColors) {
        return;
      }
      const c = "color: " + this.color;
      args.splice(1, 0, c, "color: inherit");
      let index = 0;
      let lastC = 0;
      args[0].replace(/%[a-zA-Z%]/g, (match) => {
        if (match === "%%") {
          return;
        }
        index++;
        if (match === "%c") {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
    }
    exports.log = console.debug || console.log || (() => {
    });
    function save(namespaces) {
      try {
        if (namespaces) {
          exports.storage.setItem("debug", namespaces);
        } else {
          exports.storage.removeItem("debug");
        }
      } catch (error2) {
      }
    }
    function load() {
      let r;
      try {
        r = exports.storage.getItem("debug") || exports.storage.getItem("DEBUG");
      } catch (error2) {
      }
      if (!r && typeof process !== "undefined" && "env" in process) {
        r = process.env.DEBUG;
      }
      return r;
    }
    function localstorage() {
      try {
        return localStorage;
      } catch (error2) {
      }
    }
    module2.exports = requireCommon()(exports);
    const { formatters } = module2.exports;
    formatters.j = function(v) {
      try {
        return JSON.stringify(v);
      } catch (error2) {
        return "[UnexpectedJSONParseError]: " + error2.message;
      }
    };
  })(browser, browser.exports);
  return browser.exports;
}
var node = { exports: {} };
var hasFlag;
var hasRequiredHasFlag;
function requireHasFlag() {
  if (hasRequiredHasFlag) return hasFlag;
  hasRequiredHasFlag = 1;
  hasFlag = (flag, argv = process.argv) => {
    const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
    const position = argv.indexOf(prefix + flag);
    const terminatorPosition = argv.indexOf("--");
    return position !== -1 && (terminatorPosition === -1 || position < terminatorPosition);
  };
  return hasFlag;
}
var supportsColor_1;
var hasRequiredSupportsColor;
function requireSupportsColor() {
  if (hasRequiredSupportsColor) return supportsColor_1;
  hasRequiredSupportsColor = 1;
  const os = require$$0$1;
  const tty = require$$1;
  const hasFlag2 = requireHasFlag();
  const { env } = process;
  let forceColor;
  if (hasFlag2("no-color") || hasFlag2("no-colors") || hasFlag2("color=false") || hasFlag2("color=never")) {
    forceColor = 0;
  } else if (hasFlag2("color") || hasFlag2("colors") || hasFlag2("color=true") || hasFlag2("color=always")) {
    forceColor = 1;
  }
  if ("FORCE_COLOR" in env) {
    if (env.FORCE_COLOR === "true") {
      forceColor = 1;
    } else if (env.FORCE_COLOR === "false") {
      forceColor = 0;
    } else {
      forceColor = env.FORCE_COLOR.length === 0 ? 1 : Math.min(parseInt(env.FORCE_COLOR, 10), 3);
    }
  }
  function translateLevel(level) {
    if (level === 0) {
      return false;
    }
    return {
      level,
      hasBasic: true,
      has256: level >= 2,
      has16m: level >= 3
    };
  }
  function supportsColor(haveStream, streamIsTTY) {
    if (forceColor === 0) {
      return 0;
    }
    if (hasFlag2("color=16m") || hasFlag2("color=full") || hasFlag2("color=truecolor")) {
      return 3;
    }
    if (hasFlag2("color=256")) {
      return 2;
    }
    if (haveStream && !streamIsTTY && forceColor === void 0) {
      return 0;
    }
    const min = forceColor || 0;
    if (env.TERM === "dumb") {
      return min;
    }
    if (process.platform === "win32") {
      const osRelease = os.release().split(".");
      if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
        return Number(osRelease[2]) >= 14931 ? 3 : 2;
      }
      return 1;
    }
    if ("CI" in env) {
      if (["TRAVIS", "CIRCLECI", "APPVEYOR", "GITLAB_CI", "GITHUB_ACTIONS", "BUILDKITE"].some((sign) => sign in env) || env.CI_NAME === "codeship") {
        return 1;
      }
      return min;
    }
    if ("TEAMCITY_VERSION" in env) {
      return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
    }
    if (env.COLORTERM === "truecolor") {
      return 3;
    }
    if ("TERM_PROGRAM" in env) {
      const version = parseInt((env.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
      switch (env.TERM_PROGRAM) {
        case "iTerm.app":
          return version >= 3 ? 3 : 2;
        case "Apple_Terminal":
          return 2;
      }
    }
    if (/-256(color)?$/i.test(env.TERM)) {
      return 2;
    }
    if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
      return 1;
    }
    if ("COLORTERM" in env) {
      return 1;
    }
    return min;
  }
  function getSupportLevel(stream) {
    const level = supportsColor(stream, stream && stream.isTTY);
    return translateLevel(level);
  }
  supportsColor_1 = {
    supportsColor: getSupportLevel,
    stdout: translateLevel(supportsColor(true, tty.isatty(1))),
    stderr: translateLevel(supportsColor(true, tty.isatty(2)))
  };
  return supportsColor_1;
}
var hasRequiredNode;
function requireNode() {
  if (hasRequiredNode) return node.exports;
  hasRequiredNode = 1;
  (function(module2, exports) {
    const tty = require$$1;
    const util = require$$1$1;
    exports.init = init;
    exports.log = log;
    exports.formatArgs = formatArgs;
    exports.save = save;
    exports.load = load;
    exports.useColors = useColors;
    exports.destroy = util.deprecate(
      () => {
      },
      "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`."
    );
    exports.colors = [6, 2, 3, 4, 5, 1];
    try {
      const supportsColor = requireSupportsColor();
      if (supportsColor && (supportsColor.stderr || supportsColor).level >= 2) {
        exports.colors = [
          20,
          21,
          26,
          27,
          32,
          33,
          38,
          39,
          40,
          41,
          42,
          43,
          44,
          45,
          56,
          57,
          62,
          63,
          68,
          69,
          74,
          75,
          76,
          77,
          78,
          79,
          80,
          81,
          92,
          93,
          98,
          99,
          112,
          113,
          128,
          129,
          134,
          135,
          148,
          149,
          160,
          161,
          162,
          163,
          164,
          165,
          166,
          167,
          168,
          169,
          170,
          171,
          172,
          173,
          178,
          179,
          184,
          185,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          214,
          215,
          220,
          221
        ];
      }
    } catch (error2) {
    }
    exports.inspectOpts = Object.keys(process.env).filter((key) => {
      return /^debug_/i.test(key);
    }).reduce((obj, key) => {
      const prop = key.substring(6).toLowerCase().replace(/_([a-z])/g, (_, k) => {
        return k.toUpperCase();
      });
      let val = process.env[key];
      if (/^(yes|on|true|enabled)$/i.test(val)) {
        val = true;
      } else if (/^(no|off|false|disabled)$/i.test(val)) {
        val = false;
      } else if (val === "null") {
        val = null;
      } else {
        val = Number(val);
      }
      obj[prop] = val;
      return obj;
    }, {});
    function useColors() {
      return "colors" in exports.inspectOpts ? Boolean(exports.inspectOpts.colors) : tty.isatty(process.stderr.fd);
    }
    function formatArgs(args) {
      const { namespace: name, useColors: useColors2 } = this;
      if (useColors2) {
        const c = this.color;
        const colorCode = "\x1B[3" + (c < 8 ? c : "8;5;" + c);
        const prefix = `  ${colorCode};1m${name} \x1B[0m`;
        args[0] = prefix + args[0].split("\n").join("\n" + prefix);
        args.push(colorCode + "m+" + module2.exports.humanize(this.diff) + "\x1B[0m");
      } else {
        args[0] = getDate() + name + " " + args[0];
      }
    }
    function getDate() {
      if (exports.inspectOpts.hideDate) {
        return "";
      }
      return (/* @__PURE__ */ new Date()).toISOString() + " ";
    }
    function log(...args) {
      return process.stderr.write(util.formatWithOptions(exports.inspectOpts, ...args) + "\n");
    }
    function save(namespaces) {
      if (namespaces) {
        process.env.DEBUG = namespaces;
      } else {
        delete process.env.DEBUG;
      }
    }
    function load() {
      return process.env.DEBUG;
    }
    function init(debug2) {
      debug2.inspectOpts = {};
      const keys = Object.keys(exports.inspectOpts);
      for (let i = 0; i < keys.length; i++) {
        debug2.inspectOpts[keys[i]] = exports.inspectOpts[keys[i]];
      }
    }
    module2.exports = requireCommon()(exports);
    const { formatters } = module2.exports;
    formatters.o = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts).split("\n").map((str) => str.trim()).join(" ");
    };
    formatters.O = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts);
    };
  })(node, node.exports);
  return node.exports;
}
if (typeof process === "undefined" || process.type === "renderer" || process.browser === true || process.__nwjs) {
  src.exports = requireBrowser();
} else {
  src.exports = requireNode();
}
var srcExports = src.exports;
var ProgressCallbackTransform$1 = {};
Object.defineProperty(ProgressCallbackTransform$1, "__esModule", { value: true });
ProgressCallbackTransform$1.ProgressCallbackTransform = void 0;
const stream_1$1 = require$$0$2;
class ProgressCallbackTransform extends stream_1$1.Transform {
  constructor(total, cancellationToken, onProgress) {
    super();
    this.total = total;
    this.cancellationToken = cancellationToken;
    this.onProgress = onProgress;
    this.start = Date.now();
    this.transferred = 0;
    this.delta = 0;
    this.nextUpdate = this.start + 1e3;
  }
  _transform(chunk, encoding, callback2) {
    if (this.cancellationToken.cancelled) {
      callback2(new Error("cancelled"), null);
      return;
    }
    this.transferred += chunk.length;
    this.delta += chunk.length;
    const now = Date.now();
    if (now >= this.nextUpdate && this.transferred !== this.total) {
      this.nextUpdate = now + 1e3;
      this.onProgress({
        total: this.total,
        delta: this.delta,
        transferred: this.transferred,
        percent: this.transferred / this.total * 100,
        bytesPerSecond: Math.round(this.transferred / ((now - this.start) / 1e3))
      });
      this.delta = 0;
    }
    callback2(null, chunk);
  }
  _flush(callback2) {
    if (this.cancellationToken.cancelled) {
      callback2(new Error("cancelled"));
      return;
    }
    this.onProgress({
      total: this.total,
      delta: this.delta,
      transferred: this.total,
      percent: 100,
      bytesPerSecond: Math.round(this.transferred / ((Date.now() - this.start) / 1e3))
    });
    this.delta = 0;
    callback2(null);
  }
}
ProgressCallbackTransform$1.ProgressCallbackTransform = ProgressCallbackTransform;
Object.defineProperty(httpExecutor, "__esModule", { value: true });
httpExecutor.DigestTransform = httpExecutor.HttpExecutor = httpExecutor.HttpError = void 0;
httpExecutor.addSensitiveRedirectHeader = addSensitiveRedirectHeader;
httpExecutor.addSensitiveFieldPattern = addSensitiveFieldPattern;
httpExecutor.createHttpError = createHttpError;
httpExecutor.parseJson = parseJson;
httpExecutor.configureRequestOptionsFromUrl = configureRequestOptionsFromUrl;
httpExecutor.configureRequestUrl = configureRequestUrl;
httpExecutor.safeGetHeader = safeGetHeader;
httpExecutor.configureRequestOptions = configureRequestOptions;
httpExecutor.isSensitiveFieldName = isSensitiveFieldName;
httpExecutor.hashSensitiveValue = hashSensitiveValue;
httpExecutor.safeStringifyJson = safeStringifyJson;
const crypto_1$1 = require$$0$3;
const debug_1 = srcExports;
const fs_1 = require$$2;
const stream_1 = require$$0$2;
const url_1 = require$$4;
const CancellationToken_1$1 = CancellationToken$1;
const error_1$2 = error;
const ProgressCallbackTransform_1 = ProgressCallbackTransform$1;
const debug = (0, debug_1.default)("electron-builder");
const normalizeName = (name) => name.toLowerCase().replace(/[-_]/g, "");
const SENSITIVE_REDIRECT_HEADERS = /* @__PURE__ */ new Set(["authorization", "proxyauthorization", "privatetoken", "xapikey", "xauthtoken", "xaccesstoken", "xgitlabtoken", "cookie", "xcsrftoken"]);
const SENSITIVE_FIELD_PATTERNS = ["token", "password", "secret", "authorization", "credential", "apikey", "passphrase", "auth"];
const SENSITIVE_FIELD_SUFFIXES = ["key"];
function addSensitiveRedirectHeader(header) {
  SENSITIVE_REDIRECT_HEADERS.add(normalizeName(header));
}
function addSensitiveFieldPattern(pattern) {
  SENSITIVE_FIELD_PATTERNS.push(pattern.toLowerCase().replace(/[-_]/g, ""));
}
function createHttpError(response, description = null) {
  return new HttpError(response.statusCode || -1, `${response.statusCode} ${response.statusMessage}` + (description == null ? "" : "\n" + JSON.stringify(description, null, "  ")) + "\nHeaders: " + safeStringifyJson(response.headers), description);
}
const HTTP_STATUS_CODES = /* @__PURE__ */ new Map([
  [429, "Too many requests"],
  [400, "Bad request"],
  [403, "Forbidden"],
  [404, "Not found"],
  [405, "Method not allowed"],
  [406, "Not acceptable"],
  [408, "Request timeout"],
  [413, "Request entity too large"],
  [500, "Internal server error"],
  [502, "Bad gateway"],
  [503, "Service unavailable"],
  [504, "Gateway timeout"],
  [505, "HTTP version not supported"]
]);
class HttpError extends Error {
  constructor(statusCode, message = `HTTP error: ${HTTP_STATUS_CODES.get(statusCode) || statusCode}`, description = null) {
    super(message);
    this.statusCode = statusCode;
    this.description = description;
    this.name = "HttpError";
    this.code = `HTTP_ERROR_${statusCode}`;
  }
  isServerError() {
    return this.statusCode >= 500 && this.statusCode <= 599;
  }
}
httpExecutor.HttpError = HttpError;
function parseJson(result) {
  return result.then((it) => it == null || it.length === 0 ? null : JSON.parse(it));
}
class HttpExecutor {
  constructor() {
    this.maxRedirects = 10;
  }
  request(options, cancellationToken = new CancellationToken_1$1.CancellationToken(), data) {
    configureRequestOptions(options);
    const json = data == null ? void 0 : JSON.stringify(data);
    const encodedData = json ? Buffer.from(json) : void 0;
    if (encodedData != null) {
      if (debug.enabled) {
        debug(safeStringifyJson(data));
      }
      const { headers, ...opts } = options;
      options = {
        method: "post",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": encodedData.length,
          ...headers
        },
        ...opts
      };
    }
    return this.doApiRequest(options, cancellationToken, (it) => it.end(encodedData));
  }
  doApiRequest(options, cancellationToken, requestProcessor, redirectCount = 0) {
    if (debug.enabled) {
      const { headers: _headers, auth: _auth, ...safeOptions } = options;
      debug(`Request: ${safeStringifyJson(safeOptions)}`);
    }
    return cancellationToken.createPromise((resolve, reject, onCancel) => {
      const request = this.createRequest(options, (response) => {
        try {
          this.handleResponse(response, options, cancellationToken, resolve, reject, redirectCount, requestProcessor);
        } catch (e) {
          reject(e);
        }
      });
      this.addErrorAndTimeoutHandlers(request, reject, options.timeout);
      this.addRedirectHandlers(request, options, reject, redirectCount, (options2) => {
        this.doApiRequest(options2, cancellationToken, requestProcessor, redirectCount).then(resolve).catch(reject);
      });
      requestProcessor(request, reject);
      onCancel(() => request.abort());
    });
  }
  // noinspection JSUnusedLocalSymbols
  // eslint-disable-next-line
  addRedirectHandlers(request, options, reject, redirectCount, handler) {
  }
  addErrorAndTimeoutHandlers(request, reject, timeout = 60 * 1e3) {
    this.addTimeOutHandler(request, reject, timeout);
    request.on("error", reject);
    request.on("aborted", () => {
      reject(new Error("Request has been aborted by the server"));
    });
  }
  handleResponse(response, options, cancellationToken, resolve, reject, redirectCount, requestProcessor) {
    var _a;
    if (debug.enabled) {
      const { headers: _headers, auth: _auth, ...safeOptions } = options;
      debug(`Response: ${response.statusCode} ${response.statusMessage}, request options: ${safeStringifyJson(safeOptions)}`);
    }
    if (response.statusCode === 404) {
      reject(createHttpError(response, `method: ${options.method || "GET"} url: ${options.protocol || "https:"}//${options.hostname}${options.port ? `:${options.port}` : ""}${options.path}

Please double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.
`));
      return;
    } else if (response.statusCode === 204) {
      resolve();
      return;
    }
    const code = (_a = response.statusCode) !== null && _a !== void 0 ? _a : 0;
    const shouldRedirect = code >= 300 && code < 400;
    const redirectUrl = safeGetHeader(response, "location");
    if (shouldRedirect && redirectUrl != null) {
      if (redirectCount > this.maxRedirects) {
        reject(this.createMaxRedirectError());
        return;
      }
      this.doApiRequest(HttpExecutor.prepareRedirectUrlOptions(redirectUrl, options), cancellationToken, requestProcessor, redirectCount).then(resolve).catch(reject);
      return;
    }
    response.setEncoding("utf8");
    let data = "";
    response.on("error", reject);
    response.on("data", (chunk) => data += chunk);
    response.on("end", () => {
      try {
        if (response.statusCode != null && response.statusCode >= 400) {
          const contentType = safeGetHeader(response, "content-type");
          const isJson = contentType != null && (Array.isArray(contentType) ? contentType.find((it) => it.includes("json")) != null : contentType.includes("json"));
          reject(createHttpError(response, `method: ${options.method || "GET"} url: ${options.protocol || "https:"}//${options.hostname}${options.port ? `:${options.port}` : ""}${options.path}

          Data:
          ${isJson ? safeStringifyJson(JSON.parse(data)) : data}
          `));
        } else {
          resolve(data.length === 0 ? null : data);
        }
      } catch (e) {
        reject(e);
      }
    });
  }
  async downloadToBuffer(url, options) {
    return await options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const responseChunks = [];
      const requestOptions = {
        headers: options.headers || void 0,
        // because PrivateGitHubProvider requires HttpExecutor.prepareRedirectUrlOptions logic, so, we need to redirect manually
        redirect: "manual"
      };
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      this.doDownload(requestOptions, {
        destination: null,
        options,
        onCancel,
        callback: (error2) => {
          if (error2 == null) {
            resolve(Buffer.concat(responseChunks));
          } else {
            reject(error2);
          }
        },
        responseHandler: (response, callback2) => {
          let receivedLength = 0;
          response.on("data", (chunk) => {
            receivedLength += chunk.length;
            if (receivedLength > 524288e3) {
              callback2(new Error("Maximum allowed size is 500 MB"));
              return;
            }
            responseChunks.push(chunk);
          });
          response.on("end", () => {
            callback2(null);
          });
        }
      }, 0);
    });
  }
  doDownload(requestOptions, options, redirectCount) {
    const request = this.createRequest(requestOptions, (response) => {
      if (response.statusCode >= 400) {
        options.callback(new Error(`Cannot download "${requestOptions.protocol || "https:"}//${requestOptions.hostname}${requestOptions.path}", status ${response.statusCode}: ${response.statusMessage}`));
        return;
      }
      response.on("error", options.callback);
      const redirectUrl = safeGetHeader(response, "location");
      if (redirectUrl != null) {
        if (redirectCount < this.maxRedirects) {
          this.doDownload(HttpExecutor.prepareRedirectUrlOptions(redirectUrl, requestOptions), options, redirectCount++);
        } else {
          options.callback(this.createMaxRedirectError());
        }
        return;
      }
      if (options.responseHandler == null) {
        configurePipes(options, response);
      } else {
        options.responseHandler(response, options.callback);
      }
    });
    this.addErrorAndTimeoutHandlers(request, options.callback, requestOptions.timeout);
    this.addRedirectHandlers(request, requestOptions, options.callback, redirectCount, (requestOptions2) => {
      this.doDownload(requestOptions2, options, redirectCount++);
    });
    request.end();
  }
  createMaxRedirectError() {
    return new Error(`Too many redirects (> ${this.maxRedirects})`);
  }
  addTimeOutHandler(request, callback2, timeout) {
    request.on("socket", (socket) => {
      socket.setTimeout(timeout, () => {
        request.abort();
        callback2(new Error("Request timed out"));
      });
    });
  }
  static prepareRedirectUrlOptions(redirectUrl, options) {
    const newOptions = configureRequestOptionsFromUrl(redirectUrl, { ...options });
    const headers = newOptions.headers;
    if (headers == null) {
      return newOptions;
    }
    const originalUrl = HttpExecutor.reconstructOriginalUrl(options);
    const parsedRedirectUrl = parseUrl(redirectUrl, options);
    if (HttpExecutor.isCrossOriginRedirect(originalUrl, parsedRedirectUrl)) {
      if (debug.enabled) {
        debug(`Cross-origin redirect (${originalUrl.host} → ${parsedRedirectUrl.host}): stripping sensitive headers`);
      }
      for (const key of Object.keys(headers)) {
        if (SENSITIVE_REDIRECT_HEADERS.has(normalizeName(key))) {
          delete headers[key];
        }
      }
    }
    return newOptions;
  }
  static reconstructOriginalUrl(options) {
    const protocol = options.protocol || "https:";
    if (!options.hostname) {
      throw new Error("Missing hostname in request options");
    }
    const hostname = options.hostname;
    const port = options.port ? `:${options.port}` : "";
    const path = options.path || "/";
    return new url_1.URL(`${protocol}//${hostname}${port}${path}`);
  }
  static isCrossOriginRedirect(originalUrl, redirectUrl) {
    if (originalUrl.hostname.toLowerCase() !== redirectUrl.hostname.toLowerCase()) {
      return true;
    }
    if (originalUrl.protocol === "http:" && // This can be replaced with `!originalUrl.port`, but for the sake of clarity.
    ["80", ""].includes(originalUrl.port) && redirectUrl.protocol === "https:" && // This can be replaced with `!redirectUrl.port`, but for the sake of clarity.
    ["443", ""].includes(redirectUrl.port)) {
      return false;
    }
    if (originalUrl.protocol !== redirectUrl.protocol) {
      return true;
    }
    const originalPort = originalUrl.port;
    const redirectPort = redirectUrl.port;
    return originalPort !== redirectPort;
  }
  static async retryOnServerError(task, maxRetries = 3) {
    for (let attemptNumber = 0; ; attemptNumber++) {
      try {
        return await task();
      } catch (e) {
        if (attemptNumber < maxRetries && (e instanceof HttpError && e.isServerError() || e.code === "EPIPE")) {
          await new Promise((r) => setTimeout(r, 1e3 * (attemptNumber + 1)));
          continue;
        }
        throw e;
      }
    }
  }
}
httpExecutor.HttpExecutor = HttpExecutor;
function parseUrl(url, options) {
  try {
    return new url_1.URL(url);
  } catch {
    const hostname = options.hostname;
    const protocol = options.protocol || "https:";
    const port = options.port ? `:${options.port}` : "";
    const baseUrl = `${protocol}//${hostname}${port}`;
    return new url_1.URL(url, baseUrl);
  }
}
function configureRequestOptionsFromUrl(url, options) {
  const result = configureRequestOptions(options);
  const parsedUrl = parseUrl(url, options);
  configureRequestUrl(parsedUrl, result);
  return result;
}
function configureRequestUrl(url, options) {
  options.protocol = url.protocol;
  options.hostname = url.hostname;
  if (url.port) {
    options.port = url.port;
  } else if (options.port) {
    delete options.port;
  }
  options.path = url.pathname + url.search;
}
class DigestTransform extends stream_1.Transform {
  // noinspection JSUnusedGlobalSymbols
  get actual() {
    return this._actual;
  }
  constructor(expected, algorithm = "sha512", encoding = "base64") {
    super();
    this.expected = expected;
    this.algorithm = algorithm;
    this.encoding = encoding;
    this._actual = null;
    this.isValidateOnEnd = true;
    this.digester = (0, crypto_1$1.createHash)(algorithm);
  }
  // noinspection JSUnusedGlobalSymbols
  _transform(chunk, encoding, callback2) {
    this.digester.update(chunk);
    callback2(null, chunk);
  }
  // noinspection JSUnusedGlobalSymbols
  _flush(callback2) {
    this._actual = this.digester.digest(this.encoding);
    if (this.isValidateOnEnd) {
      try {
        this.validate();
      } catch (e) {
        callback2(e);
        return;
      }
    }
    callback2(null);
  }
  validate() {
    if (this._actual == null) {
      throw (0, error_1$2.newError)("Not finished yet", "ERR_STREAM_NOT_FINISHED");
    }
    if (this._actual !== this.expected) {
      throw (0, error_1$2.newError)(`${this.algorithm} checksum mismatch, expected ${this.expected}, got ${this._actual}`, "ERR_CHECKSUM_MISMATCH");
    }
    return null;
  }
}
httpExecutor.DigestTransform = DigestTransform;
function checkSha2(sha2Header, sha2, callback2) {
  if (sha2Header != null && sha2 != null && sha2Header !== sha2) {
    callback2(new Error(`checksum mismatch: expected ${sha2} but got ${sha2Header} (X-Checksum-Sha2 header)`));
    return false;
  }
  return true;
}
function safeGetHeader(response, headerKey) {
  const value = response.headers[headerKey];
  if (value == null) {
    return null;
  } else if (Array.isArray(value)) {
    return value.length === 0 ? null : value[value.length - 1];
  } else {
    return value;
  }
}
function configurePipes(options, response) {
  if (!checkSha2(safeGetHeader(response, "X-Checksum-Sha2"), options.options.sha2, options.callback)) {
    return;
  }
  const streams = [];
  if (options.options.onProgress != null) {
    const contentLength = safeGetHeader(response, "content-length");
    if (contentLength != null) {
      streams.push(new ProgressCallbackTransform_1.ProgressCallbackTransform(parseInt(contentLength, 10), options.options.cancellationToken, options.options.onProgress));
    }
  }
  const sha512 = options.options.sha512;
  if (sha512 != null) {
    streams.push(new DigestTransform(sha512, "sha512", sha512.length === 128 && !sha512.includes("+") && !sha512.includes("Z") && !sha512.includes("=") ? "hex" : "base64"));
  } else if (options.options.sha2 != null) {
    streams.push(new DigestTransform(options.options.sha2, "sha256", "hex"));
  }
  const fileOut = (0, fs_1.createWriteStream)(options.destination);
  streams.push(fileOut);
  let lastStream = response;
  for (const stream of streams) {
    stream.on("error", (error2) => {
      fileOut.close();
      if (!options.options.cancellationToken.cancelled) {
        options.callback(error2);
      }
    });
    lastStream = lastStream.pipe(stream);
  }
  fileOut.on("finish", () => {
    fileOut.close(options.callback);
  });
}
function configureRequestOptions(options, token, method) {
  if (method != null) {
    options.method = method;
  }
  options.headers = { ...options.headers };
  const headers = options.headers;
  if (token != null) {
    headers.authorization = token.startsWith("Basic") || token.startsWith("Bearer") ? token : `token ${token}`;
  }
  if (headers["User-Agent"] == null) {
    headers["User-Agent"] = "electron-builder";
  }
  if (method == null || method === "GET" || headers["Cache-Control"] == null) {
    headers["Cache-Control"] = "no-cache";
  }
  if (options.protocol == null && process.versions.electron != null) {
    options.protocol = "https:";
  }
  return options;
}
function isSensitiveFieldName(name) {
  const normalized = normalizeName(name);
  return SENSITIVE_FIELD_PATTERNS.some((p) => normalized.includes(p)) || SENSITIVE_FIELD_SUFFIXES.some((s) => normalized.endsWith(s));
}
function hashSensitiveValue(value) {
  return `${(0, crypto_1$1.createHash)("sha256").update(value).digest("hex")} (sha256 hash)`;
}
function safeStringifyJson(data, skippedNames) {
  return JSON.stringify(data, (name, value) => {
    if (isSensitiveFieldName(name) || skippedNames != null && skippedNames.has(name)) {
      return typeof value === "string" ? hashSensitiveValue(value) : "<stripped sensitive data>";
    }
    return value;
  }, 2);
}
var MemoLazy$1 = {};
Object.defineProperty(MemoLazy$1, "__esModule", { value: true });
MemoLazy$1.MemoLazy = void 0;
class MemoLazy {
  constructor(selector, creator) {
    this.selector = selector;
    this.creator = creator;
    this.selected = void 0;
    this._value = void 0;
  }
  get hasValue() {
    return this._value !== void 0;
  }
  get value() {
    const selected = this.selector();
    if (this._value !== void 0 && equals(this.selected, selected)) {
      return this._value;
    }
    this.selected = selected;
    const result = this.creator(selected);
    this.value = result;
    return result;
  }
  set value(value) {
    this._value = value;
  }
}
MemoLazy$1.MemoLazy = MemoLazy;
function equals(firstValue, secondValue) {
  const isFirstObject = typeof firstValue === "object" && firstValue !== null;
  const isSecondObject = typeof secondValue === "object" && secondValue !== null;
  if (isFirstObject && isSecondObject) {
    const keys1 = Object.keys(firstValue);
    const keys2 = Object.keys(secondValue);
    return keys1.length === keys2.length && keys1.every((key) => equals(firstValue[key], secondValue[key]));
  }
  return firstValue === secondValue;
}
var publishOptions = {};
Object.defineProperty(publishOptions, "__esModule", { value: true });
publishOptions.githubUrl = githubUrl;
publishOptions.githubTagPrefix = githubTagPrefix;
publishOptions.getS3LikeProviderBaseUrl = getS3LikeProviderBaseUrl;
function githubUrl(options, defaultHost = "github.com") {
  return `${options.protocol || "https"}://${options.host || defaultHost}`;
}
function githubTagPrefix(options) {
  var _a;
  if (options.tagNamePrefix) {
    return options.tagNamePrefix;
  }
  if ((_a = options.vPrefixedTagName) !== null && _a !== void 0 ? _a : true) {
    return "v";
  }
  return "";
}
function getS3LikeProviderBaseUrl(configuration) {
  const provider = configuration.provider;
  if (provider === "s3") {
    return s3Url(configuration);
  }
  if (provider === "spaces") {
    return spacesUrl(configuration);
  }
  throw new Error(`Not supported provider: ${provider}`);
}
function s3Url(options) {
  let url;
  if (options.accelerate == true) {
    url = `https://${options.bucket}.s3-accelerate.amazonaws.com`;
  } else if (options.endpoint != null) {
    url = `${options.endpoint}/${options.bucket}`;
  } else if (options.bucket.includes(".")) {
    if (options.region == null) {
      throw new Error(`Bucket name "${options.bucket}" includes a dot, but S3 region is missing`);
    }
    if (options.region === "us-east-1") {
      url = `https://s3.amazonaws.com/${options.bucket}`;
    } else {
      url = `https://s3-${options.region}.amazonaws.com/${options.bucket}`;
    }
  } else if (options.region === "cn-north-1") {
    url = `https://${options.bucket}.s3.${options.region}.amazonaws.com.cn`;
  } else {
    url = `https://${options.bucket}.s3.amazonaws.com`;
  }
  return appendPath(url, options.path);
}
function appendPath(url, p) {
  if (p != null && p.length > 0) {
    if (!p.startsWith("/")) {
      url += "/";
    }
    url += p;
  }
  return url;
}
function spacesUrl(options) {
  if (options.name == null) {
    throw new Error(`name is missing`);
  }
  if (options.region == null) {
    throw new Error(`region is missing`);
  }
  return appendPath(`https://${options.name}.${options.region}.digitaloceanspaces.com`, options.path);
}
var retry$1 = {};
Object.defineProperty(retry$1, "__esModule", { value: true });
retry$1.retry = retry;
const CancellationToken_1 = CancellationToken$1;
async function retry(task, options) {
  var _a;
  const { retries: retryCount, interval, backoff = 0, attempt = 0, shouldRetry, cancellationToken = new CancellationToken_1.CancellationToken() } = options;
  try {
    return await task();
  } catch (error2) {
    if (await Promise.resolve((_a = shouldRetry === null || shouldRetry === void 0 ? void 0 : shouldRetry(error2)) !== null && _a !== void 0 ? _a : true) && retryCount > 0 && !cancellationToken.cancelled) {
      await new Promise((resolve) => setTimeout(resolve, interval + backoff * attempt));
      return await retry(task, { ...options, retries: retryCount - 1, attempt: attempt + 1 });
    } else {
      throw error2;
    }
  }
}
var rfc2253Parser = {};
Object.defineProperty(rfc2253Parser, "__esModule", { value: true });
rfc2253Parser.parseDn = parseDn;
function parseDn(seq) {
  let quoted = false;
  let key = null;
  let token = "";
  let nextNonSpace = 0;
  seq = seq.trim();
  const result = /* @__PURE__ */ new Map();
  for (let i = 0; i <= seq.length; i++) {
    if (i === seq.length) {
      if (key !== null) {
        result.set(key, token);
      }
      break;
    }
    const ch = seq[i];
    if (quoted) {
      if (ch === '"') {
        quoted = false;
        continue;
      }
    } else {
      if (ch === '"') {
        quoted = true;
        continue;
      }
      if (ch === "\\") {
        i++;
        const ord = parseInt(seq.slice(i, i + 2), 16);
        if (Number.isNaN(ord)) {
          token += seq[i];
        } else {
          i++;
          token += String.fromCharCode(ord);
        }
        continue;
      }
      if (key === null && ch === "=") {
        key = token;
        token = "";
        continue;
      }
      if (ch === "," || ch === ";" || ch === "+") {
        if (key !== null) {
          result.set(key, token);
        }
        key = null;
        token = "";
        continue;
      }
    }
    if (ch === " " && !quoted) {
      if (token.length === 0) {
        continue;
      }
      if (i > nextNonSpace) {
        let j = i;
        while (seq[j] === " ") {
          j++;
        }
        nextNonSpace = j;
      }
      if (nextNonSpace >= seq.length || seq[nextNonSpace] === "," || seq[nextNonSpace] === ";" || key === null && seq[nextNonSpace] === "=" || key !== null && seq[nextNonSpace] === "+") {
        i = nextNonSpace - 1;
        continue;
      }
    }
    token += ch;
  }
  return result;
}
var uuid = {};
Object.defineProperty(uuid, "__esModule", { value: true });
uuid.nil = uuid.UUID = void 0;
const crypto_1 = require$$0$3;
const error_1$1 = error;
const invalidName = "options.name must be either a string or a Buffer";
const randomHost = (0, crypto_1.randomBytes)(16);
randomHost[0] = randomHost[0] | 1;
const hex2byte = {};
const byte2hex = [];
for (let i = 0; i < 256; i++) {
  const hex = (i + 256).toString(16).substr(1);
  hex2byte[hex] = i;
  byte2hex[i] = hex;
}
class UUID {
  constructor(uuid2) {
    this.ascii = null;
    this.binary = null;
    const check = UUID.check(uuid2);
    if (!check) {
      throw new Error("not a UUID");
    }
    this.version = check.version;
    if (check.format === "ascii") {
      this.ascii = uuid2;
    } else {
      this.binary = uuid2;
    }
  }
  static v5(name, namespace) {
    return uuidNamed(name, "sha1", 80, namespace);
  }
  toString() {
    if (this.ascii == null) {
      this.ascii = stringify(this.binary);
    }
    return this.ascii;
  }
  inspect() {
    return `UUID v${this.version} ${this.toString()}`;
  }
  static check(uuid2, offset = 0) {
    if (typeof uuid2 === "string") {
      uuid2 = uuid2.toLowerCase();
      if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-([a-f0-9]{12})$/.test(uuid2)) {
        return false;
      }
      if (uuid2 === "00000000-0000-0000-0000-000000000000") {
        return { version: void 0, variant: "nil", format: "ascii" };
      }
      return {
        version: (hex2byte[uuid2[14] + uuid2[15]] & 240) >> 4,
        variant: getVariant((hex2byte[uuid2[19] + uuid2[20]] & 224) >> 5),
        format: "ascii"
      };
    }
    if (Buffer.isBuffer(uuid2)) {
      if (uuid2.length < offset + 16) {
        return false;
      }
      let i = 0;
      for (; i < 16; i++) {
        if (uuid2[offset + i] !== 0) {
          break;
        }
      }
      if (i === 16) {
        return { version: void 0, variant: "nil", format: "binary" };
      }
      return {
        version: (uuid2[offset + 6] & 240) >> 4,
        variant: getVariant((uuid2[offset + 8] & 224) >> 5),
        format: "binary"
      };
    }
    throw (0, error_1$1.newError)("Unknown type of uuid", "ERR_UNKNOWN_UUID_TYPE");
  }
  // read stringified uuid into a Buffer
  static parse(input) {
    const buffer = Buffer.allocUnsafe(16);
    let j = 0;
    for (let i = 0; i < 16; i++) {
      buffer[i] = hex2byte[input[j++] + input[j++]];
      if (i === 3 || i === 5 || i === 7 || i === 9) {
        j += 1;
      }
    }
    return buffer;
  }
}
uuid.UUID = UUID;
UUID.OID = UUID.parse("6ba7b812-9dad-11d1-80b4-00c04fd430c8");
function getVariant(bits) {
  switch (bits) {
    case 0:
    case 1:
    case 3:
      return "ncs";
    case 4:
    case 5:
      return "rfc4122";
    case 6:
      return "microsoft";
    default:
      return "future";
  }
}
var UuidEncoding;
(function(UuidEncoding2) {
  UuidEncoding2[UuidEncoding2["ASCII"] = 0] = "ASCII";
  UuidEncoding2[UuidEncoding2["BINARY"] = 1] = "BINARY";
  UuidEncoding2[UuidEncoding2["OBJECT"] = 2] = "OBJECT";
})(UuidEncoding || (UuidEncoding = {}));
function uuidNamed(name, hashMethod, version, namespace, encoding = UuidEncoding.ASCII) {
  const hash = (0, crypto_1.createHash)(hashMethod);
  const nameIsNotAString = typeof name !== "string";
  if (nameIsNotAString && !Buffer.isBuffer(name)) {
    throw (0, error_1$1.newError)(invalidName, "ERR_INVALID_UUID_NAME");
  }
  hash.update(namespace);
  hash.update(name);
  const buffer = hash.digest();
  let result;
  switch (encoding) {
    case UuidEncoding.BINARY:
      buffer[6] = buffer[6] & 15 | version;
      buffer[8] = buffer[8] & 63 | 128;
      result = buffer;
      break;
    case UuidEncoding.OBJECT:
      buffer[6] = buffer[6] & 15 | version;
      buffer[8] = buffer[8] & 63 | 128;
      result = new UUID(buffer);
      break;
    default:
      result = byte2hex[buffer[0]] + byte2hex[buffer[1]] + byte2hex[buffer[2]] + byte2hex[buffer[3]] + "-" + byte2hex[buffer[4]] + byte2hex[buffer[5]] + "-" + byte2hex[buffer[6] & 15 | version] + byte2hex[buffer[7]] + "-" + byte2hex[buffer[8] & 63 | 128] + byte2hex[buffer[9]] + "-" + byte2hex[buffer[10]] + byte2hex[buffer[11]] + byte2hex[buffer[12]] + byte2hex[buffer[13]] + byte2hex[buffer[14]] + byte2hex[buffer[15]];
      break;
  }
  return result;
}
function stringify(buffer) {
  return byte2hex[buffer[0]] + byte2hex[buffer[1]] + byte2hex[buffer[2]] + byte2hex[buffer[3]] + "-" + byte2hex[buffer[4]] + byte2hex[buffer[5]] + "-" + byte2hex[buffer[6]] + byte2hex[buffer[7]] + "-" + byte2hex[buffer[8]] + byte2hex[buffer[9]] + "-" + byte2hex[buffer[10]] + byte2hex[buffer[11]] + byte2hex[buffer[12]] + byte2hex[buffer[13]] + byte2hex[buffer[14]] + byte2hex[buffer[15]];
}
uuid.nil = new UUID("00000000-0000-0000-0000-000000000000");
var xml = {};
var sax$1 = {};
(function(exports) {
  (function(sax2) {
    sax2.parser = function(strict, opt) {
      return new SAXParser(strict, opt);
    };
    sax2.SAXParser = SAXParser;
    sax2.SAXStream = SAXStream;
    sax2.createStream = createStream;
    sax2.MAX_BUFFER_LENGTH = 64 * 1024;
    var buffers = [
      "comment",
      "sgmlDecl",
      "textNode",
      "tagName",
      "doctype",
      "procInstName",
      "procInstBody",
      "entity",
      "attribName",
      "attribValue",
      "cdata",
      "script"
    ];
    sax2.EVENTS = [
      "text",
      "processinginstruction",
      "sgmldeclaration",
      "doctype",
      "comment",
      "opentagstart",
      "attribute",
      "opentag",
      "closetag",
      "opencdata",
      "cdata",
      "closecdata",
      "error",
      "end",
      "ready",
      "script",
      "opennamespace",
      "closenamespace"
    ];
    function SAXParser(strict, opt) {
      if (!(this instanceof SAXParser)) {
        return new SAXParser(strict, opt);
      }
      var parser = this;
      clearBuffers(parser);
      parser.q = parser.c = "";
      parser.bufferCheckPosition = sax2.MAX_BUFFER_LENGTH;
      parser.encoding = null;
      parser.opt = opt || {};
      parser.opt.lowercase = parser.opt.lowercase || parser.opt.lowercasetags;
      parser.looseCase = parser.opt.lowercase ? "toLowerCase" : "toUpperCase";
      parser.opt.maxEntityCount = parser.opt.maxEntityCount || 512;
      parser.opt.maxEntityDepth = parser.opt.maxEntityDepth || 4;
      parser.entityCount = parser.entityDepth = 0;
      parser.tags = [];
      parser.closed = parser.closedRoot = parser.sawRoot = false;
      parser.tag = parser.error = null;
      parser.strict = !!strict;
      parser.noscript = !!(strict || parser.opt.noscript);
      parser.state = S.BEGIN;
      parser.strictEntities = parser.opt.strictEntities;
      parser.ENTITIES = parser.strictEntities ? Object.create(sax2.XML_ENTITIES) : Object.create(sax2.ENTITIES);
      parser.attribList = [];
      if (parser.opt.xmlns) {
        parser.ns = Object.create(rootNS);
      }
      if (parser.opt.unquotedAttributeValues === void 0) {
        parser.opt.unquotedAttributeValues = !strict;
      }
      parser.trackPosition = parser.opt.position !== false;
      if (parser.trackPosition) {
        parser.position = parser.line = parser.column = 0;
      }
      emit(parser, "onready");
    }
    if (!Object.create) {
      Object.create = function(o) {
        function F() {
        }
        F.prototype = o;
        var newf = new F();
        return newf;
      };
    }
    if (!Object.keys) {
      Object.keys = function(o) {
        var a = [];
        for (var i in o) if (o.hasOwnProperty(i)) a.push(i);
        return a;
      };
    }
    function checkBufferLength(parser) {
      var maxAllowed = Math.max(sax2.MAX_BUFFER_LENGTH, 10);
      var maxActual = 0;
      for (var i = 0, l = buffers.length; i < l; i++) {
        var len = parser[buffers[i]].length;
        if (len > maxAllowed) {
          switch (buffers[i]) {
            case "textNode":
              closeText(parser);
              break;
            case "cdata":
              emitNode(parser, "oncdata", parser.cdata);
              parser.cdata = "";
              break;
            case "script":
              emitNode(parser, "onscript", parser.script);
              parser.script = "";
              break;
            default:
              error2(parser, "Max buffer length exceeded: " + buffers[i]);
          }
        }
        maxActual = Math.max(maxActual, len);
      }
      var m = sax2.MAX_BUFFER_LENGTH - maxActual;
      parser.bufferCheckPosition = m + parser.position;
    }
    function clearBuffers(parser) {
      for (var i = 0, l = buffers.length; i < l; i++) {
        parser[buffers[i]] = "";
      }
    }
    function flushBuffers(parser) {
      closeText(parser);
      if (parser.cdata !== "") {
        emitNode(parser, "oncdata", parser.cdata);
        parser.cdata = "";
      }
      if (parser.script !== "") {
        emitNode(parser, "onscript", parser.script);
        parser.script = "";
      }
    }
    SAXParser.prototype = {
      end: function() {
        end(this);
      },
      write,
      resume: function() {
        this.error = null;
        return this;
      },
      close: function() {
        return this.write(null);
      },
      flush: function() {
        flushBuffers(this);
      }
    };
    var Stream;
    try {
      Stream = require("stream").Stream;
    } catch (ex) {
      Stream = function() {
      };
    }
    if (!Stream) Stream = function() {
    };
    var streamWraps = sax2.EVENTS.filter(function(ev) {
      return ev !== "error" && ev !== "end";
    });
    function createStream(strict, opt) {
      return new SAXStream(strict, opt);
    }
    function determineBufferEncoding(data, isEnd) {
      if (data.length >= 2) {
        if (data[0] === 255 && data[1] === 254) {
          return "utf-16le";
        }
        if (data[0] === 254 && data[1] === 255) {
          return "utf-16be";
        }
      }
      if (data.length >= 3 && data[0] === 239 && data[1] === 187 && data[2] === 191) {
        return "utf8";
      }
      if (data.length >= 4) {
        if (data[0] === 60 && data[1] === 0 && data[2] === 63 && data[3] === 0) {
          return "utf-16le";
        }
        if (data[0] === 0 && data[1] === 60 && data[2] === 0 && data[3] === 63) {
          return "utf-16be";
        }
        return "utf8";
      }
      return isEnd ? "utf8" : null;
    }
    function SAXStream(strict, opt) {
      if (!(this instanceof SAXStream)) {
        return new SAXStream(strict, opt);
      }
      Stream.apply(this);
      this._parser = new SAXParser(strict, opt);
      this.writable = true;
      this.readable = true;
      var me = this;
      this._parser.onend = function() {
        me.emit("end");
      };
      this._parser.onerror = function(er) {
        me.emit("error", er);
        me._parser.error = null;
      };
      this._decoder = null;
      this._decoderBuffer = null;
      streamWraps.forEach(function(ev) {
        Object.defineProperty(me, "on" + ev, {
          get: function() {
            return me._parser["on" + ev];
          },
          set: function(h) {
            if (!h) {
              me.removeAllListeners(ev);
              me._parser["on" + ev] = h;
              return h;
            }
            me.on(ev, h);
          },
          enumerable: true,
          configurable: false
        });
      });
    }
    SAXStream.prototype = Object.create(Stream.prototype, {
      constructor: {
        value: SAXStream
      }
    });
    SAXStream.prototype._decodeBuffer = function(data, isEnd) {
      if (this._decoderBuffer) {
        data = Buffer.concat([this._decoderBuffer, data]);
        this._decoderBuffer = null;
      }
      if (!this._decoder) {
        var encoding = determineBufferEncoding(data, isEnd);
        if (!encoding) {
          this._decoderBuffer = data;
          return "";
        }
        this._parser.encoding = encoding;
        this._decoder = new TextDecoder(encoding);
      }
      return this._decoder.decode(data, { stream: !isEnd });
    };
    SAXStream.prototype.write = function(data) {
      if (typeof Buffer === "function" && typeof Buffer.isBuffer === "function" && Buffer.isBuffer(data)) {
        data = this._decodeBuffer(data, false);
      } else if (this._decoderBuffer) {
        var remaining = this._decodeBuffer(Buffer.alloc(0), true);
        if (remaining) {
          this._parser.write(remaining);
          this.emit("data", remaining);
        }
      }
      this._parser.write(data.toString());
      this.emit("data", data);
      return true;
    };
    SAXStream.prototype.end = function(chunk) {
      if (chunk && chunk.length) {
        this.write(chunk);
      }
      if (this._decoderBuffer) {
        var finalChunk = this._decodeBuffer(Buffer.alloc(0), true);
        if (finalChunk) {
          this._parser.write(finalChunk);
          this.emit("data", finalChunk);
        }
      } else if (this._decoder) {
        var remaining = this._decoder.decode();
        if (remaining) {
          this._parser.write(remaining);
          this.emit("data", remaining);
        }
      }
      this._parser.end();
      return true;
    };
    SAXStream.prototype.on = function(ev, handler) {
      var me = this;
      if (!me._parser["on" + ev] && streamWraps.indexOf(ev) !== -1) {
        me._parser["on" + ev] = function() {
          var args = arguments.length === 1 ? [arguments[0]] : Array.apply(null, arguments);
          args.splice(0, 0, ev);
          me.emit.apply(me, args);
        };
      }
      return Stream.prototype.on.call(me, ev, handler);
    };
    var CDATAre = /^\[CDATA\[$/i;
    var DOCTYPEre = /^DOCTYPE$/i;
    var XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
    var XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
    var rootNS = { xml: XML_NAMESPACE, xmlns: XMLNS_NAMESPACE };
    var nameStart = /[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/;
    var nameBody = /[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/;
    var entityStart = /[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/;
    var entityBody = /[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/;
    function isWhitespace(c) {
      return c === " " || c === "\n" || c === "\r" || c === "	";
    }
    function isQuote(c) {
      return c === '"' || c === "'";
    }
    function isAttribEnd(c) {
      return c === ">" || isWhitespace(c);
    }
    function isMatch(regex, c) {
      return regex.test(c);
    }
    function notMatch(regex, c) {
      return !isMatch(regex, c);
    }
    var S = 0;
    sax2.STATE = {
      BEGIN: S++,
      // leading byte order mark or whitespace
      BEGIN_WHITESPACE: S++,
      // leading whitespace
      TEXT: S++,
      // general stuff
      TEXT_ENTITY: S++,
      // &amp and such.
      OPEN_WAKA: S++,
      // <
      SGML_DECL: S++,
      // <!BLARG
      SGML_DECL_QUOTED: S++,
      // <!BLARG foo "bar
      DOCTYPE: S++,
      // <!DOCTYPE
      DOCTYPE_QUOTED: S++,
      // <!DOCTYPE "//blah
      DOCTYPE_DTD: S++,
      // <!DOCTYPE "//blah" [ ...
      DOCTYPE_DTD_QUOTED: S++,
      // <!DOCTYPE "//blah" [ "foo
      COMMENT_STARTING: S++,
      // <!-
      COMMENT: S++,
      // <!--
      COMMENT_ENDING: S++,
      // <!-- blah -
      COMMENT_ENDED: S++,
      // <!-- blah --
      CDATA: S++,
      // <![CDATA[ something
      CDATA_ENDING: S++,
      // ]
      CDATA_ENDING_2: S++,
      // ]]
      PROC_INST: S++,
      // <?hi
      PROC_INST_BODY: S++,
      // <?hi there
      PROC_INST_ENDING: S++,
      // <?hi "there" ?
      OPEN_TAG: S++,
      // <strong
      OPEN_TAG_SLASH: S++,
      // <strong /
      ATTRIB: S++,
      // <a
      ATTRIB_NAME: S++,
      // <a foo
      ATTRIB_NAME_SAW_WHITE: S++,
      // <a foo _
      ATTRIB_VALUE: S++,
      // <a foo=
      ATTRIB_VALUE_QUOTED: S++,
      // <a foo="bar
      ATTRIB_VALUE_CLOSED: S++,
      // <a foo="bar"
      ATTRIB_VALUE_UNQUOTED: S++,
      // <a foo=bar
      ATTRIB_VALUE_ENTITY_Q: S++,
      // <foo bar="&quot;"
      ATTRIB_VALUE_ENTITY_U: S++,
      // <foo bar=&quot
      CLOSE_TAG: S++,
      // </a
      CLOSE_TAG_SAW_WHITE: S++,
      // </a   >
      SCRIPT: S++,
      // <script> ...
      SCRIPT_ENDING: S++
      // <script> ... <
    };
    sax2.XML_ENTITIES = Object.assign(/* @__PURE__ */ Object.create(null), {
      amp: "&",
      gt: ">",
      lt: "<",
      quot: '"',
      apos: "'"
    });
    sax2.ENTITIES = Object.assign(/* @__PURE__ */ Object.create(null), {
      amp: "&",
      gt: ">",
      lt: "<",
      quot: '"',
      apos: "'",
      AElig: 198,
      Aacute: 193,
      Acirc: 194,
      Agrave: 192,
      Aring: 197,
      Atilde: 195,
      Auml: 196,
      Ccedil: 199,
      ETH: 208,
      Eacute: 201,
      Ecirc: 202,
      Egrave: 200,
      Euml: 203,
      Iacute: 205,
      Icirc: 206,
      Igrave: 204,
      Iuml: 207,
      Ntilde: 209,
      Oacute: 211,
      Ocirc: 212,
      Ograve: 210,
      Oslash: 216,
      Otilde: 213,
      Ouml: 214,
      THORN: 222,
      Uacute: 218,
      Ucirc: 219,
      Ugrave: 217,
      Uuml: 220,
      Yacute: 221,
      aacute: 225,
      acirc: 226,
      aelig: 230,
      agrave: 224,
      aring: 229,
      atilde: 227,
      auml: 228,
      ccedil: 231,
      eacute: 233,
      ecirc: 234,
      egrave: 232,
      eth: 240,
      euml: 235,
      iacute: 237,
      icirc: 238,
      igrave: 236,
      iuml: 239,
      ntilde: 241,
      oacute: 243,
      ocirc: 244,
      ograve: 242,
      oslash: 248,
      otilde: 245,
      ouml: 246,
      szlig: 223,
      thorn: 254,
      uacute: 250,
      ucirc: 251,
      ugrave: 249,
      uuml: 252,
      yacute: 253,
      yuml: 255,
      copy: 169,
      reg: 174,
      nbsp: 160,
      iexcl: 161,
      cent: 162,
      pound: 163,
      curren: 164,
      yen: 165,
      brvbar: 166,
      sect: 167,
      uml: 168,
      ordf: 170,
      laquo: 171,
      not: 172,
      shy: 173,
      macr: 175,
      deg: 176,
      plusmn: 177,
      sup1: 185,
      sup2: 178,
      sup3: 179,
      acute: 180,
      micro: 181,
      para: 182,
      middot: 183,
      cedil: 184,
      ordm: 186,
      raquo: 187,
      frac14: 188,
      frac12: 189,
      frac34: 190,
      iquest: 191,
      times: 215,
      divide: 247,
      OElig: 338,
      oelig: 339,
      Scaron: 352,
      scaron: 353,
      Yuml: 376,
      fnof: 402,
      circ: 710,
      tilde: 732,
      Alpha: 913,
      Beta: 914,
      Gamma: 915,
      Delta: 916,
      Epsilon: 917,
      Zeta: 918,
      Eta: 919,
      Theta: 920,
      Iota: 921,
      Kappa: 922,
      Lambda: 923,
      Mu: 924,
      Nu: 925,
      Xi: 926,
      Omicron: 927,
      Pi: 928,
      Rho: 929,
      Sigma: 931,
      Tau: 932,
      Upsilon: 933,
      Phi: 934,
      Chi: 935,
      Psi: 936,
      Omega: 937,
      alpha: 945,
      beta: 946,
      gamma: 947,
      delta: 948,
      epsilon: 949,
      zeta: 950,
      eta: 951,
      theta: 952,
      iota: 953,
      kappa: 954,
      lambda: 955,
      mu: 956,
      nu: 957,
      xi: 958,
      omicron: 959,
      pi: 960,
      rho: 961,
      sigmaf: 962,
      sigma: 963,
      tau: 964,
      upsilon: 965,
      phi: 966,
      chi: 967,
      psi: 968,
      omega: 969,
      thetasym: 977,
      upsih: 978,
      piv: 982,
      ensp: 8194,
      emsp: 8195,
      thinsp: 8201,
      zwnj: 8204,
      zwj: 8205,
      lrm: 8206,
      rlm: 8207,
      ndash: 8211,
      mdash: 8212,
      lsquo: 8216,
      rsquo: 8217,
      sbquo: 8218,
      ldquo: 8220,
      rdquo: 8221,
      bdquo: 8222,
      dagger: 8224,
      Dagger: 8225,
      bull: 8226,
      hellip: 8230,
      permil: 8240,
      prime: 8242,
      Prime: 8243,
      lsaquo: 8249,
      rsaquo: 8250,
      oline: 8254,
      frasl: 8260,
      euro: 8364,
      image: 8465,
      weierp: 8472,
      real: 8476,
      trade: 8482,
      alefsym: 8501,
      larr: 8592,
      uarr: 8593,
      rarr: 8594,
      darr: 8595,
      harr: 8596,
      crarr: 8629,
      lArr: 8656,
      uArr: 8657,
      rArr: 8658,
      dArr: 8659,
      hArr: 8660,
      forall: 8704,
      part: 8706,
      exist: 8707,
      empty: 8709,
      nabla: 8711,
      isin: 8712,
      notin: 8713,
      ni: 8715,
      prod: 8719,
      sum: 8721,
      minus: 8722,
      lowast: 8727,
      radic: 8730,
      prop: 8733,
      infin: 8734,
      ang: 8736,
      and: 8743,
      or: 8744,
      cap: 8745,
      cup: 8746,
      int: 8747,
      there4: 8756,
      sim: 8764,
      cong: 8773,
      asymp: 8776,
      ne: 8800,
      equiv: 8801,
      le: 8804,
      ge: 8805,
      sub: 8834,
      sup: 8835,
      nsub: 8836,
      sube: 8838,
      supe: 8839,
      oplus: 8853,
      otimes: 8855,
      perp: 8869,
      sdot: 8901,
      lceil: 8968,
      rceil: 8969,
      lfloor: 8970,
      rfloor: 8971,
      lang: 9001,
      rang: 9002,
      loz: 9674,
      spades: 9824,
      clubs: 9827,
      hearts: 9829,
      diams: 9830
    });
    Object.keys(sax2.ENTITIES).forEach(function(key) {
      var e = sax2.ENTITIES[key];
      var s2 = typeof e === "number" ? String.fromCharCode(e) : e;
      sax2.ENTITIES[key] = s2;
    });
    for (var s in sax2.STATE) {
      sax2.STATE[sax2.STATE[s]] = s;
    }
    S = sax2.STATE;
    function emit(parser, event, data) {
      parser[event] && parser[event](data);
    }
    function getDeclaredEncoding(body) {
      var match = body && body.match(/(?:^|\s)encoding\s*=\s*(['"])([^'"]+)\1/i);
      return match ? match[2] : null;
    }
    function normalizeEncodingName(encoding) {
      if (!encoding) {
        return null;
      }
      return encoding.toLowerCase().replace(/[^a-z0-9]/g, "");
    }
    function encodingsMatch(detectedEncoding, declaredEncoding) {
      const detected = normalizeEncodingName(detectedEncoding);
      const declared = normalizeEncodingName(declaredEncoding);
      if (!detected || !declared) {
        return true;
      }
      if (declared === "utf16") {
        return detected === "utf16le" || detected === "utf16be";
      }
      return detected === declared;
    }
    function validateXmlDeclarationEncoding(parser, data) {
      if (!parser.strict || !parser.encoding || !data || data.name !== "xml") {
        return;
      }
      var declaredEncoding = getDeclaredEncoding(data.body);
      if (declaredEncoding && !encodingsMatch(parser.encoding, declaredEncoding)) {
        strictFail(
          parser,
          "XML declaration encoding " + declaredEncoding + " does not match detected stream encoding " + parser.encoding.toUpperCase()
        );
      }
    }
    function emitNode(parser, nodeType, data) {
      if (parser.textNode) closeText(parser);
      emit(parser, nodeType, data);
    }
    function closeText(parser) {
      parser.textNode = textopts(parser.opt, parser.textNode);
      if (parser.textNode) emit(parser, "ontext", parser.textNode);
      parser.textNode = "";
    }
    function textopts(opt, text) {
      if (opt.trim) text = text.trim();
      if (opt.normalize) text = text.replace(/\s+/g, " ");
      return text;
    }
    function error2(parser, er) {
      closeText(parser);
      if (parser.trackPosition) {
        er += "\nLine: " + parser.line + "\nColumn: " + parser.column + "\nChar: " + parser.c;
      }
      er = new Error(er);
      parser.error = er;
      emit(parser, "onerror", er);
      return parser;
    }
    function end(parser) {
      if (parser.sawRoot && !parser.closedRoot)
        strictFail(parser, "Unclosed root tag");
      if (parser.state !== S.BEGIN && parser.state !== S.BEGIN_WHITESPACE && parser.state !== S.TEXT) {
        error2(parser, "Unexpected end");
      }
      closeText(parser);
      parser.c = "";
      parser.closed = true;
      emit(parser, "onend");
      SAXParser.call(parser, parser.strict, parser.opt);
      return parser;
    }
    function strictFail(parser, message) {
      if (typeof parser !== "object" || !(parser instanceof SAXParser)) {
        throw new Error("bad call to strictFail");
      }
      if (parser.strict) {
        error2(parser, message);
      }
    }
    function newTag(parser) {
      if (!parser.strict) parser.tagName = parser.tagName[parser.looseCase]();
      var parent = parser.tags[parser.tags.length - 1] || parser;
      var tag = parser.tag = { name: parser.tagName, attributes: {} };
      if (parser.opt.xmlns) {
        tag.ns = parent.ns;
      }
      parser.attribList.length = 0;
      emitNode(parser, "onopentagstart", tag);
    }
    function qname(name, attribute) {
      var i = name.indexOf(":");
      var qualName = i < 0 ? ["", name] : name.split(":");
      var prefix = qualName[0];
      var local = qualName[1];
      if (attribute && name === "xmlns") {
        prefix = "xmlns";
        local = "";
      }
      return { prefix, local };
    }
    function attrib(parser) {
      if (!parser.strict) {
        parser.attribName = parser.attribName[parser.looseCase]();
      }
      if (parser.attribList.indexOf(parser.attribName) !== -1 || parser.tag.attributes.hasOwnProperty(parser.attribName)) {
        parser.attribName = parser.attribValue = "";
        return;
      }
      if (parser.opt.xmlns) {
        var qn = qname(parser.attribName, true);
        var prefix = qn.prefix;
        var local = qn.local;
        if (prefix === "xmlns") {
          if (local === "xml" && parser.attribValue !== XML_NAMESPACE) {
            strictFail(
              parser,
              "xml: prefix must be bound to " + XML_NAMESPACE + "\nActual: " + parser.attribValue
            );
          } else if (local === "xmlns" && parser.attribValue !== XMLNS_NAMESPACE) {
            strictFail(
              parser,
              "xmlns: prefix must be bound to " + XMLNS_NAMESPACE + "\nActual: " + parser.attribValue
            );
          } else {
            var tag = parser.tag;
            var parent = parser.tags[parser.tags.length - 1] || parser;
            if (tag.ns === parent.ns) {
              tag.ns = Object.create(parent.ns);
            }
            tag.ns[local] = parser.attribValue;
          }
        }
        parser.attribList.push([parser.attribName, parser.attribValue]);
      } else {
        parser.tag.attributes[parser.attribName] = parser.attribValue;
        emitNode(parser, "onattribute", {
          name: parser.attribName,
          value: parser.attribValue
        });
      }
      parser.attribName = parser.attribValue = "";
    }
    function openTag(parser, selfClosing) {
      if (parser.opt.xmlns) {
        var tag = parser.tag;
        var qn = qname(parser.tagName);
        tag.prefix = qn.prefix;
        tag.local = qn.local;
        tag.uri = tag.ns[qn.prefix] || "";
        if (tag.prefix && !tag.uri) {
          strictFail(
            parser,
            "Unbound namespace prefix: " + JSON.stringify(parser.tagName)
          );
          tag.uri = qn.prefix;
        }
        var parent = parser.tags[parser.tags.length - 1] || parser;
        if (tag.ns && parent.ns !== tag.ns) {
          Object.keys(tag.ns).forEach(function(p) {
            emitNode(parser, "onopennamespace", {
              prefix: p,
              uri: tag.ns[p]
            });
          });
        }
        for (var i = 0, l = parser.attribList.length; i < l; i++) {
          var nv = parser.attribList[i];
          var name = nv[0];
          var value = nv[1];
          var qualName = qname(name, true);
          var prefix = qualName.prefix;
          var local = qualName.local;
          var uri = prefix === "" ? "" : tag.ns[prefix] || "";
          var a = {
            name,
            value,
            prefix,
            local,
            uri
          };
          if (prefix && prefix !== "xmlns" && !uri) {
            strictFail(
              parser,
              "Unbound namespace prefix: " + JSON.stringify(prefix)
            );
            a.uri = prefix;
          }
          parser.tag.attributes[name] = a;
          emitNode(parser, "onattribute", a);
        }
        parser.attribList.length = 0;
      }
      parser.tag.isSelfClosing = !!selfClosing;
      parser.sawRoot = true;
      parser.tags.push(parser.tag);
      emitNode(parser, "onopentag", parser.tag);
      if (!selfClosing) {
        if (!parser.noscript && parser.tagName.toLowerCase() === "script") {
          parser.state = S.SCRIPT;
        } else {
          parser.state = S.TEXT;
        }
        parser.tag = null;
        parser.tagName = "";
      }
      parser.attribName = parser.attribValue = "";
      parser.attribList.length = 0;
    }
    function closeTag(parser) {
      if (!parser.tagName) {
        strictFail(parser, "Weird empty close tag.");
        parser.textNode += "</>";
        parser.state = S.TEXT;
        return;
      }
      if (parser.script) {
        if (parser.tagName !== "script") {
          parser.script += "</" + parser.tagName + ">";
          parser.tagName = "";
          parser.state = S.SCRIPT;
          return;
        }
        emitNode(parser, "onscript", parser.script);
        parser.script = "";
      }
      var t2 = parser.tags.length;
      var tagName = parser.tagName;
      if (!parser.strict) {
        tagName = tagName[parser.looseCase]();
      }
      var closeTo = tagName;
      while (t2--) {
        var close = parser.tags[t2];
        if (close.name !== closeTo) {
          strictFail(parser, "Unexpected close tag");
        } else {
          break;
        }
      }
      if (t2 < 0) {
        strictFail(parser, "Unmatched closing tag: " + parser.tagName);
        parser.textNode += "</" + parser.tagName + ">";
        parser.state = S.TEXT;
        return;
      }
      parser.tagName = tagName;
      var s2 = parser.tags.length;
      while (s2-- > t2) {
        var tag = parser.tag = parser.tags.pop();
        parser.tagName = parser.tag.name;
        emitNode(parser, "onclosetag", parser.tagName);
        var x = {};
        for (var i in tag.ns) {
          x[i] = tag.ns[i];
        }
        var parent = parser.tags[parser.tags.length - 1] || parser;
        if (parser.opt.xmlns && tag.ns !== parent.ns) {
          Object.keys(tag.ns).forEach(function(p) {
            var n = tag.ns[p];
            emitNode(parser, "onclosenamespace", { prefix: p, uri: n });
          });
        }
      }
      if (t2 === 0) parser.closedRoot = true;
      parser.tagName = parser.attribValue = parser.attribName = "";
      parser.attribList.length = 0;
      parser.state = S.TEXT;
    }
    function parseEntity(parser) {
      var entity = parser.entity;
      var entityLC = entity.toLowerCase();
      var num;
      var numStr = "";
      if (parser.ENTITIES[entity]) {
        return parser.ENTITIES[entity];
      }
      if (parser.ENTITIES[entityLC]) {
        return parser.ENTITIES[entityLC];
      }
      entity = entityLC;
      if (entity.charAt(0) === "#") {
        if (entity.charAt(1) === "x") {
          entity = entity.slice(2);
          num = parseInt(entity, 16);
          numStr = num.toString(16);
        } else {
          entity = entity.slice(1);
          num = parseInt(entity, 10);
          numStr = num.toString(10);
        }
      }
      entity = entity.replace(/^0+/, "");
      if (isNaN(num) || numStr.toLowerCase() !== entity || num < 0 || num > 1114111 || !isXmlChar(num)) {
        strictFail(parser, "Invalid character entity");
        return "&" + parser.entity + ";";
      }
      return String.fromCodePoint(num);
    }
    function isXmlChar(num) {
      return num === 9 || num === 10 || num === 13 || num >= 32 && num <= 55295 || num >= 57344 && num <= 65533 || num >= 65536 && num <= 1114111;
    }
    function beginWhiteSpace(parser, c) {
      if (c === "<") {
        parser.state = S.OPEN_WAKA;
        parser.startTagPosition = parser.position;
      } else if (!isWhitespace(c)) {
        strictFail(parser, "Non-whitespace before first tag.");
        parser.textNode = c;
        parser.state = S.TEXT;
      }
    }
    function charAt(chunk, i) {
      var result = "";
      if (i < chunk.length) {
        result = chunk.charAt(i);
      }
      return result;
    }
    function write(chunk) {
      var parser = this;
      if (this.error) {
        throw this.error;
      }
      if (parser.closed) {
        return error2(
          parser,
          "Cannot write after close. Assign an onready handler."
        );
      }
      if (chunk === null) {
        return end(parser);
      }
      if (typeof chunk === "object") {
        chunk = chunk.toString();
      }
      var i = 0;
      var c = "";
      while (true) {
        c = charAt(chunk, i++);
        parser.c = c;
        if (!c) {
          break;
        }
        if (parser.trackPosition) {
          parser.position++;
          if (c === "\n") {
            parser.line++;
            parser.column = 0;
          } else {
            parser.column++;
          }
        }
        switch (parser.state) {
          case S.BEGIN:
            parser.state = S.BEGIN_WHITESPACE;
            if (c === "\uFEFF") {
              continue;
            }
            beginWhiteSpace(parser, c);
            continue;
          case S.BEGIN_WHITESPACE:
            beginWhiteSpace(parser, c);
            continue;
          case S.TEXT:
            if (parser.sawRoot && !parser.closedRoot) {
              var starti = i - 1;
              while (c && c !== "<" && c !== "&") {
                c = charAt(chunk, i++);
                if (c && parser.trackPosition) {
                  parser.position++;
                  if (c === "\n") {
                    parser.line++;
                    parser.column = 0;
                  } else {
                    parser.column++;
                  }
                }
              }
              parser.textNode += chunk.substring(starti, i - 1);
            }
            if (c === "<" && !(parser.sawRoot && parser.closedRoot && !parser.strict)) {
              parser.state = S.OPEN_WAKA;
              parser.startTagPosition = parser.position;
            } else {
              if (!isWhitespace(c) && (!parser.sawRoot || parser.closedRoot)) {
                strictFail(parser, "Text data outside of root node.");
              }
              if (c === "&") {
                parser.state = S.TEXT_ENTITY;
              } else {
                parser.textNode += c;
              }
            }
            continue;
          case S.SCRIPT:
            if (c === "<") {
              parser.state = S.SCRIPT_ENDING;
            } else {
              parser.script += c;
            }
            continue;
          case S.SCRIPT_ENDING:
            if (c === "/") {
              parser.state = S.CLOSE_TAG;
            } else {
              parser.script += "<" + c;
              parser.state = S.SCRIPT;
            }
            continue;
          case S.OPEN_WAKA:
            if (c === "!") {
              parser.state = S.SGML_DECL;
              parser.sgmlDecl = "";
            } else if (isWhitespace(c)) ;
            else if (isMatch(nameStart, c)) {
              parser.state = S.OPEN_TAG;
              parser.tagName = c;
            } else if (c === "/") {
              parser.state = S.CLOSE_TAG;
              parser.tagName = "";
            } else if (c === "?") {
              parser.state = S.PROC_INST;
              parser.procInstName = parser.procInstBody = "";
            } else {
              strictFail(parser, "Unencoded <");
              if (parser.startTagPosition + 1 < parser.position) {
                var pad = parser.position - parser.startTagPosition;
                c = new Array(pad).join(" ") + c;
              }
              parser.textNode += "<" + c;
              parser.state = S.TEXT;
            }
            continue;
          case S.SGML_DECL:
            if (parser.sgmlDecl + c === "--") {
              parser.state = S.COMMENT;
              parser.comment = "";
              parser.sgmlDecl = "";
              continue;
            }
            if (parser.doctype && parser.doctype !== true && parser.sgmlDecl) {
              parser.state = S.DOCTYPE_DTD;
              parser.doctype += "<!" + parser.sgmlDecl + c;
              parser.sgmlDecl = "";
            } else if (CDATAre.test(parser.sgmlDecl + c)) {
              emitNode(parser, "onopencdata");
              parser.state = S.CDATA;
              parser.sgmlDecl = "";
              parser.cdata = "";
            } else if (DOCTYPEre.test(parser.sgmlDecl + c)) {
              parser.state = S.DOCTYPE;
              if (parser.doctype || parser.sawRoot) {
                strictFail(
                  parser,
                  "Inappropriately located doctype declaration"
                );
              }
              parser.doctype = "";
              parser.sgmlDecl = "";
            } else if (c === ">") {
              emitNode(parser, "onsgmldeclaration", parser.sgmlDecl);
              parser.sgmlDecl = "";
              parser.state = S.TEXT;
            } else if (isQuote(c)) {
              parser.state = S.SGML_DECL_QUOTED;
              parser.sgmlDecl += c;
            } else {
              parser.sgmlDecl += c;
            }
            continue;
          case S.SGML_DECL_QUOTED:
            if (c === parser.q) {
              parser.state = S.SGML_DECL;
              parser.q = "";
            }
            parser.sgmlDecl += c;
            continue;
          case S.DOCTYPE:
            if (c === ">") {
              parser.state = S.TEXT;
              emitNode(parser, "ondoctype", parser.doctype);
              parser.doctype = true;
            } else {
              parser.doctype += c;
              if (c === "[") {
                parser.state = S.DOCTYPE_DTD;
              } else if (isQuote(c)) {
                parser.state = S.DOCTYPE_QUOTED;
                parser.q = c;
              }
            }
            continue;
          case S.DOCTYPE_QUOTED:
            parser.doctype += c;
            if (c === parser.q) {
              parser.q = "";
              parser.state = S.DOCTYPE;
            }
            continue;
          case S.DOCTYPE_DTD:
            if (c === "]") {
              parser.doctype += c;
              parser.state = S.DOCTYPE;
            } else if (c === "<") {
              parser.state = S.OPEN_WAKA;
              parser.startTagPosition = parser.position;
            } else if (isQuote(c)) {
              parser.doctype += c;
              parser.state = S.DOCTYPE_DTD_QUOTED;
              parser.q = c;
            } else {
              parser.doctype += c;
            }
            continue;
          case S.DOCTYPE_DTD_QUOTED:
            parser.doctype += c;
            if (c === parser.q) {
              parser.state = S.DOCTYPE_DTD;
              parser.q = "";
            }
            continue;
          case S.COMMENT:
            if (c === "-") {
              parser.state = S.COMMENT_ENDING;
            } else {
              parser.comment += c;
            }
            continue;
          case S.COMMENT_ENDING:
            if (c === "-") {
              parser.state = S.COMMENT_ENDED;
              parser.comment = textopts(parser.opt, parser.comment);
              if (parser.comment) {
                emitNode(parser, "oncomment", parser.comment);
              }
              parser.comment = "";
            } else {
              parser.comment += "-" + c;
              parser.state = S.COMMENT;
            }
            continue;
          case S.COMMENT_ENDED:
            if (c !== ">") {
              strictFail(parser, "Malformed comment");
              parser.comment += "--" + c;
              parser.state = S.COMMENT;
            } else if (parser.doctype && parser.doctype !== true) {
              parser.state = S.DOCTYPE_DTD;
            } else {
              parser.state = S.TEXT;
            }
            continue;
          case S.CDATA:
            var starti = i - 1;
            while (c && c !== "]") {
              c = charAt(chunk, i++);
              if (c && parser.trackPosition) {
                parser.position++;
                if (c === "\n") {
                  parser.line++;
                  parser.column = 0;
                } else {
                  parser.column++;
                }
              }
            }
            parser.cdata += chunk.substring(starti, i - 1);
            if (c === "]") {
              parser.state = S.CDATA_ENDING;
            }
            continue;
          case S.CDATA_ENDING:
            if (c === "]") {
              parser.state = S.CDATA_ENDING_2;
            } else {
              parser.cdata += "]" + c;
              parser.state = S.CDATA;
            }
            continue;
          case S.CDATA_ENDING_2:
            if (c === ">") {
              if (parser.cdata) {
                emitNode(parser, "oncdata", parser.cdata);
              }
              emitNode(parser, "onclosecdata");
              parser.cdata = "";
              parser.state = S.TEXT;
            } else if (c === "]") {
              parser.cdata += "]";
            } else {
              parser.cdata += "]]" + c;
              parser.state = S.CDATA;
            }
            continue;
          case S.PROC_INST:
            if (c === "?") {
              parser.state = S.PROC_INST_ENDING;
            } else if (isWhitespace(c)) {
              parser.state = S.PROC_INST_BODY;
            } else {
              parser.procInstName += c;
            }
            continue;
          case S.PROC_INST_BODY:
            if (!parser.procInstBody && isWhitespace(c)) {
              continue;
            } else if (c === "?") {
              parser.state = S.PROC_INST_ENDING;
            } else {
              parser.procInstBody += c;
            }
            continue;
          case S.PROC_INST_ENDING:
            if (c === ">") {
              const procInstEndData = {
                name: parser.procInstName,
                body: parser.procInstBody
              };
              validateXmlDeclarationEncoding(parser, procInstEndData);
              emitNode(parser, "onprocessinginstruction", procInstEndData);
              parser.procInstName = parser.procInstBody = "";
              parser.state = S.TEXT;
            } else {
              parser.procInstBody += "?" + c;
              parser.state = S.PROC_INST_BODY;
            }
            continue;
          case S.OPEN_TAG:
            if (isMatch(nameBody, c)) {
              parser.tagName += c;
            } else {
              newTag(parser);
              if (c === ">") {
                openTag(parser);
              } else if (c === "/") {
                parser.state = S.OPEN_TAG_SLASH;
              } else {
                if (!isWhitespace(c)) {
                  strictFail(parser, "Invalid character in tag name");
                }
                parser.state = S.ATTRIB;
              }
            }
            continue;
          case S.OPEN_TAG_SLASH:
            if (c === ">") {
              openTag(parser, true);
              closeTag(parser);
            } else {
              strictFail(
                parser,
                "Forward-slash in opening tag not followed by >"
              );
              parser.state = S.ATTRIB;
            }
            continue;
          case S.ATTRIB:
            if (isWhitespace(c)) {
              continue;
            } else if (c === ">") {
              openTag(parser);
            } else if (c === "/") {
              parser.state = S.OPEN_TAG_SLASH;
            } else if (isMatch(nameStart, c)) {
              parser.attribName = c;
              parser.attribValue = "";
              parser.state = S.ATTRIB_NAME;
            } else {
              strictFail(parser, "Invalid attribute name");
            }
            continue;
          case S.ATTRIB_NAME:
            if (c === "=") {
              parser.state = S.ATTRIB_VALUE;
            } else if (c === ">") {
              strictFail(parser, "Attribute without value");
              parser.attribValue = parser.attribName;
              attrib(parser);
              openTag(parser);
            } else if (isWhitespace(c)) {
              parser.state = S.ATTRIB_NAME_SAW_WHITE;
            } else if (isMatch(nameBody, c)) {
              parser.attribName += c;
            } else {
              strictFail(parser, "Invalid attribute name");
            }
            continue;
          case S.ATTRIB_NAME_SAW_WHITE:
            if (c === "=") {
              parser.state = S.ATTRIB_VALUE;
            } else if (isWhitespace(c)) {
              continue;
            } else {
              strictFail(parser, "Attribute without value");
              parser.tag.attributes[parser.attribName] = "";
              parser.attribValue = "";
              emitNode(parser, "onattribute", {
                name: parser.attribName,
                value: ""
              });
              parser.attribName = "";
              if (c === ">") {
                openTag(parser);
              } else if (isMatch(nameStart, c)) {
                parser.attribName = c;
                parser.state = S.ATTRIB_NAME;
              } else {
                strictFail(parser, "Invalid attribute name");
                parser.state = S.ATTRIB;
              }
            }
            continue;
          case S.ATTRIB_VALUE:
            if (isWhitespace(c)) {
              continue;
            } else if (isQuote(c)) {
              parser.q = c;
              parser.state = S.ATTRIB_VALUE_QUOTED;
            } else {
              if (!parser.opt.unquotedAttributeValues) {
                error2(parser, "Unquoted attribute value");
              }
              parser.state = S.ATTRIB_VALUE_UNQUOTED;
              parser.attribValue = c;
            }
            continue;
          case S.ATTRIB_VALUE_QUOTED:
            if (c !== parser.q) {
              if (c === "&") {
                parser.state = S.ATTRIB_VALUE_ENTITY_Q;
              } else {
                parser.attribValue += c;
              }
              continue;
            }
            attrib(parser);
            parser.q = "";
            parser.state = S.ATTRIB_VALUE_CLOSED;
            continue;
          case S.ATTRIB_VALUE_CLOSED:
            if (isWhitespace(c)) {
              parser.state = S.ATTRIB;
            } else if (c === ">") {
              openTag(parser);
            } else if (c === "/") {
              parser.state = S.OPEN_TAG_SLASH;
            } else if (isMatch(nameStart, c)) {
              strictFail(parser, "No whitespace between attributes");
              parser.attribName = c;
              parser.attribValue = "";
              parser.state = S.ATTRIB_NAME;
            } else {
              strictFail(parser, "Invalid attribute name");
            }
            continue;
          case S.ATTRIB_VALUE_UNQUOTED:
            if (!isAttribEnd(c)) {
              if (c === "&") {
                parser.state = S.ATTRIB_VALUE_ENTITY_U;
              } else {
                parser.attribValue += c;
              }
              continue;
            }
            attrib(parser);
            if (c === ">") {
              openTag(parser);
            } else {
              parser.state = S.ATTRIB;
            }
            continue;
          case S.CLOSE_TAG:
            if (!parser.tagName) {
              if (isWhitespace(c)) {
                continue;
              } else if (notMatch(nameStart, c)) {
                if (parser.script) {
                  parser.script += "</" + c;
                  parser.state = S.SCRIPT;
                } else {
                  strictFail(parser, "Invalid tagname in closing tag.");
                }
              } else {
                parser.tagName = c;
              }
            } else if (c === ">") {
              closeTag(parser);
            } else if (isMatch(nameBody, c)) {
              parser.tagName += c;
            } else if (parser.script) {
              parser.script += "</" + parser.tagName + c;
              parser.tagName = "";
              parser.state = S.SCRIPT;
            } else {
              if (!isWhitespace(c)) {
                strictFail(parser, "Invalid tagname in closing tag");
              }
              parser.state = S.CLOSE_TAG_SAW_WHITE;
            }
            continue;
          case S.CLOSE_TAG_SAW_WHITE:
            if (isWhitespace(c)) {
              continue;
            }
            if (c === ">") {
              closeTag(parser);
            } else {
              strictFail(parser, "Invalid characters in closing tag");
            }
            continue;
          case S.TEXT_ENTITY:
          case S.ATTRIB_VALUE_ENTITY_Q:
          case S.ATTRIB_VALUE_ENTITY_U:
            var returnState;
            var buffer;
            switch (parser.state) {
              case S.TEXT_ENTITY:
                returnState = S.TEXT;
                buffer = "textNode";
                break;
              case S.ATTRIB_VALUE_ENTITY_Q:
                returnState = S.ATTRIB_VALUE_QUOTED;
                buffer = "attribValue";
                break;
              case S.ATTRIB_VALUE_ENTITY_U:
                returnState = S.ATTRIB_VALUE_UNQUOTED;
                buffer = "attribValue";
                break;
            }
            if (c === ";") {
              var parsedEntity = parseEntity(parser);
              if (parser.opt.unparsedEntities && !Object.values(sax2.XML_ENTITIES).includes(parsedEntity)) {
                if ((parser.entityCount += 1) > parser.opt.maxEntityCount) {
                  error2(
                    parser,
                    "Parsed entity count exceeds max entity count"
                  );
                }
                if ((parser.entityDepth += 1) > parser.opt.maxEntityDepth) {
                  error2(
                    parser,
                    "Parsed entity depth exceeds max entity depth"
                  );
                }
                parser.entity = "";
                parser.state = returnState;
                parser.write(parsedEntity);
                parser.entityDepth -= 1;
              } else {
                parser[buffer] += parsedEntity;
                parser.entity = "";
                parser.state = returnState;
              }
            } else if (isMatch(parser.entity.length ? entityBody : entityStart, c)) {
              parser.entity += c;
            } else {
              strictFail(parser, "Invalid character in entity name");
              parser[buffer] += "&" + parser.entity + c;
              parser.entity = "";
              parser.state = returnState;
            }
            continue;
          default: {
            throw new Error(parser, "Unknown state: " + parser.state);
          }
        }
      }
      if (parser.position >= parser.bufferCheckPosition) {
        checkBufferLength(parser);
      }
      return parser;
    }
    /*! http://mths.be/fromcodepoint v0.1.0 by @mathias */
    if (!String.fromCodePoint) {
      (function() {
        var stringFromCharCode = String.fromCharCode;
        var floor = Math.floor;
        var fromCodePoint = function() {
          var MAX_SIZE = 16384;
          var codeUnits = [];
          var highSurrogate;
          var lowSurrogate;
          var index = -1;
          var length = arguments.length;
          if (!length) {
            return "";
          }
          var result = "";
          while (++index < length) {
            var codePoint = Number(arguments[index]);
            if (!isFinite(codePoint) || // `NaN`, `+Infinity`, or `-Infinity`
            codePoint < 0 || // not a valid Unicode code point
            codePoint > 1114111 || // not a valid Unicode code point
            floor(codePoint) !== codePoint) {
              throw RangeError("Invalid code point: " + codePoint);
            }
            if (codePoint <= 65535) {
              codeUnits.push(codePoint);
            } else {
              codePoint -= 65536;
              highSurrogate = (codePoint >> 10) + 55296;
              lowSurrogate = codePoint % 1024 + 56320;
              codeUnits.push(highSurrogate, lowSurrogate);
            }
            if (index + 1 === length || codeUnits.length > MAX_SIZE) {
              result += stringFromCharCode.apply(null, codeUnits);
              codeUnits.length = 0;
            }
          }
          return result;
        };
        if (Object.defineProperty) {
          Object.defineProperty(String, "fromCodePoint", {
            value: fromCodePoint,
            configurable: true,
            writable: true
          });
        } else {
          String.fromCodePoint = fromCodePoint;
        }
      })();
    }
  })(exports);
})(sax$1);
Object.defineProperty(xml, "__esModule", { value: true });
xml.XElement = void 0;
xml.parseXml = parseXml;
const sax = sax$1;
const error_1 = error;
class XElement {
  constructor(name) {
    this.name = name;
    this.value = "";
    this.attributes = null;
    this.isCData = false;
    this.elements = null;
    if (!name) {
      throw (0, error_1.newError)("Element name cannot be empty", "ERR_XML_ELEMENT_NAME_EMPTY");
    }
    if (!isValidName(name)) {
      throw (0, error_1.newError)(`Invalid element name: ${name}`, "ERR_XML_ELEMENT_INVALID_NAME");
    }
  }
  attribute(name) {
    const result = this.attributes === null ? null : this.attributes[name];
    if (result == null) {
      throw (0, error_1.newError)(`No attribute "${name}"`, "ERR_XML_MISSED_ATTRIBUTE");
    }
    return result;
  }
  removeAttribute(name) {
    if (this.attributes !== null) {
      delete this.attributes[name];
    }
  }
  element(name, ignoreCase = false, errorIfMissed = null) {
    const result = this.elementOrNull(name, ignoreCase);
    if (result === null) {
      throw (0, error_1.newError)(errorIfMissed || `No element "${name}"`, "ERR_XML_MISSED_ELEMENT");
    }
    return result;
  }
  elementOrNull(name, ignoreCase = false) {
    if (this.elements === null) {
      return null;
    }
    for (const element of this.elements) {
      if (isNameEquals(element, name, ignoreCase)) {
        return element;
      }
    }
    return null;
  }
  getElements(name, ignoreCase = false) {
    if (this.elements === null) {
      return [];
    }
    return this.elements.filter((it) => isNameEquals(it, name, ignoreCase));
  }
  elementValueOrEmpty(name, ignoreCase = false) {
    const element = this.elementOrNull(name, ignoreCase);
    return element === null ? "" : element.value;
  }
}
xml.XElement = XElement;
const NAME_REG_EXP = new RegExp(/^[A-Za-z_][:A-Za-z0-9_-]*$/i);
function isValidName(name) {
  return NAME_REG_EXP.test(name);
}
function isNameEquals(element, name, ignoreCase) {
  const elementName = element.name;
  return elementName === name || ignoreCase === true && elementName.length === name.length && elementName.toLowerCase() === name.toLowerCase();
}
function parseXml(data) {
  let rootElement = null;
  const parser = sax.parser(true, {});
  const elements = [];
  parser.onopentag = (saxElement) => {
    const element = new XElement(saxElement.name);
    element.attributes = saxElement.attributes;
    if (rootElement === null) {
      rootElement = element;
    } else {
      const parent = elements[elements.length - 1];
      if (parent.elements == null) {
        parent.elements = [];
      }
      parent.elements.push(element);
    }
    elements.push(element);
  };
  parser.onclosetag = () => {
    elements.pop();
  };
  parser.ontext = (text) => {
    if (elements.length > 0) {
      elements[elements.length - 1].value = text;
    }
  };
  parser.oncdata = (cdata) => {
    const element = elements[elements.length - 1];
    element.value = cdata;
    element.isCData = true;
  };
  parser.onerror = (err) => {
    throw err;
  };
  parser.write(data);
  return rootElement;
}
var objects = {};
Object.defineProperty(objects, "__esModule", { value: true });
objects.mapToObject = mapToObject;
objects.isValidKey = isValidKey;
objects.asArray = asArray;
objects.deepAssign = deepAssign;
objects.objectToArgs = objectToArgs;
function mapToObject(map) {
  const obj = {};
  for (const [key, value] of map) {
    if (!isValidKey(key)) {
      continue;
    }
    if (value instanceof Map) {
      obj[key] = mapToObject(value);
    } else {
      obj[key] = value;
    }
  }
  return obj;
}
function isValidKey(key) {
  const protectedProperties = ["__proto__", "prototype", "constructor"];
  if (protectedProperties.includes(key)) {
    return false;
  }
  return ["string", "number", "symbol", "boolean"].includes(typeof key) || key === null;
}
function asArray(v) {
  if (v == null) {
    return [];
  } else if (Array.isArray(v)) {
    return v;
  } else {
    return [v];
  }
}
function isObject(x) {
  if (Array.isArray(x)) {
    return false;
  }
  const type = typeof x;
  return type === "object" || type === "function";
}
function assignKey(target, from, key) {
  const value = from[key];
  if (value === void 0) {
    return;
  }
  const prevValue = target[key];
  if (prevValue == null || value == null || !isObject(prevValue) || !isObject(value)) {
    if (Array.isArray(prevValue) && Array.isArray(value)) {
      target[key] = Array.from(new Set(prevValue.concat(value)));
    } else {
      target[key] = value;
    }
  } else {
    target[key] = assign(prevValue, value);
  }
}
function assign(to, from) {
  if (to !== from) {
    for (const key of Object.getOwnPropertyNames(from)) {
      if (isValidKey(key)) {
        assignKey(to, from, key);
      }
    }
  }
  return to;
}
function deepAssign(target, ...objects2) {
  for (const o of objects2) {
    if (o != null) {
      assign(target, o);
    }
  }
  return target;
}
const SAFE_FLAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const UNSAFE_VALUE_RE = /[\0\r\n]/;
function objectToArgs(obj) {
  const args = Object.entries(obj).reduce((args2, [name, value]) => {
    if (!isValidKey(name) || value == null) {
      return args2;
    }
    if (!SAFE_FLAG_NAME_RE.test(name)) {
      throw new Error(`objectToArgs: unsafe flag name rejected: ${JSON.stringify(name)}`);
    }
    if (UNSAFE_VALUE_RE.test(value)) {
      throw new Error(`objectToArgs: value for --${name} contains a null byte or newline`);
    }
    return args2.concat([`--${name}`, value]);
  }, []);
  return Object.freeze(args);
}
(function(exports) {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.CURRENT_APP_PACKAGE_FILE_NAME = exports.CURRENT_APP_INSTALLER_FILE_NAME = exports.objectToArgs = exports.deepAssign = exports.asArray = exports.mapToObject = exports.isValidKey = exports.XElement = exports.parseXml = exports.UUID = exports.parseDn = exports.retry = exports.githubTagPrefix = exports.githubUrl = exports.getS3LikeProviderBaseUrl = exports.ProgressCallbackTransform = exports.MemoLazy = exports.safeStringifyJson = exports.safeGetHeader = exports.parseJson = exports.isSensitiveFieldName = exports.HttpExecutor = exports.hashSensitiveValue = exports.HttpError = exports.DigestTransform = exports.createHttpError = exports.configureRequestUrl = exports.configureRequestOptionsFromUrl = exports.configureRequestOptions = exports.newError = exports.CancellationToken = exports.CancellationError = void 0;
  var CancellationToken_12 = CancellationToken$1;
  Object.defineProperty(exports, "CancellationError", { enumerable: true, get: function() {
    return CancellationToken_12.CancellationError;
  } });
  Object.defineProperty(exports, "CancellationToken", { enumerable: true, get: function() {
    return CancellationToken_12.CancellationToken;
  } });
  var error_12 = error;
  Object.defineProperty(exports, "newError", { enumerable: true, get: function() {
    return error_12.newError;
  } });
  var httpExecutor_1 = httpExecutor;
  Object.defineProperty(exports, "configureRequestOptions", { enumerable: true, get: function() {
    return httpExecutor_1.configureRequestOptions;
  } });
  Object.defineProperty(exports, "configureRequestOptionsFromUrl", { enumerable: true, get: function() {
    return httpExecutor_1.configureRequestOptionsFromUrl;
  } });
  Object.defineProperty(exports, "configureRequestUrl", { enumerable: true, get: function() {
    return httpExecutor_1.configureRequestUrl;
  } });
  Object.defineProperty(exports, "createHttpError", { enumerable: true, get: function() {
    return httpExecutor_1.createHttpError;
  } });
  Object.defineProperty(exports, "DigestTransform", { enumerable: true, get: function() {
    return httpExecutor_1.DigestTransform;
  } });
  Object.defineProperty(exports, "HttpError", { enumerable: true, get: function() {
    return httpExecutor_1.HttpError;
  } });
  Object.defineProperty(exports, "hashSensitiveValue", { enumerable: true, get: function() {
    return httpExecutor_1.hashSensitiveValue;
  } });
  Object.defineProperty(exports, "HttpExecutor", { enumerable: true, get: function() {
    return httpExecutor_1.HttpExecutor;
  } });
  Object.defineProperty(exports, "isSensitiveFieldName", { enumerable: true, get: function() {
    return httpExecutor_1.isSensitiveFieldName;
  } });
  Object.defineProperty(exports, "parseJson", { enumerable: true, get: function() {
    return httpExecutor_1.parseJson;
  } });
  Object.defineProperty(exports, "safeGetHeader", { enumerable: true, get: function() {
    return httpExecutor_1.safeGetHeader;
  } });
  Object.defineProperty(exports, "safeStringifyJson", { enumerable: true, get: function() {
    return httpExecutor_1.safeStringifyJson;
  } });
  var MemoLazy_1 = MemoLazy$1;
  Object.defineProperty(exports, "MemoLazy", { enumerable: true, get: function() {
    return MemoLazy_1.MemoLazy;
  } });
  var ProgressCallbackTransform_12 = ProgressCallbackTransform$1;
  Object.defineProperty(exports, "ProgressCallbackTransform", { enumerable: true, get: function() {
    return ProgressCallbackTransform_12.ProgressCallbackTransform;
  } });
  var publishOptions_1 = publishOptions;
  Object.defineProperty(exports, "getS3LikeProviderBaseUrl", { enumerable: true, get: function() {
    return publishOptions_1.getS3LikeProviderBaseUrl;
  } });
  Object.defineProperty(exports, "githubUrl", { enumerable: true, get: function() {
    return publishOptions_1.githubUrl;
  } });
  Object.defineProperty(exports, "githubTagPrefix", { enumerable: true, get: function() {
    return publishOptions_1.githubTagPrefix;
  } });
  var retry_1 = retry$1;
  Object.defineProperty(exports, "retry", { enumerable: true, get: function() {
    return retry_1.retry;
  } });
  var rfc2253Parser_1 = rfc2253Parser;
  Object.defineProperty(exports, "parseDn", { enumerable: true, get: function() {
    return rfc2253Parser_1.parseDn;
  } });
  var uuid_1 = uuid;
  Object.defineProperty(exports, "UUID", { enumerable: true, get: function() {
    return uuid_1.UUID;
  } });
  var xml_1 = xml;
  Object.defineProperty(exports, "parseXml", { enumerable: true, get: function() {
    return xml_1.parseXml;
  } });
  Object.defineProperty(exports, "XElement", { enumerable: true, get: function() {
    return xml_1.XElement;
  } });
  var objects_1 = objects;
  Object.defineProperty(exports, "isValidKey", { enumerable: true, get: function() {
    return objects_1.isValidKey;
  } });
  Object.defineProperty(exports, "mapToObject", { enumerable: true, get: function() {
    return objects_1.mapToObject;
  } });
  Object.defineProperty(exports, "asArray", { enumerable: true, get: function() {
    return objects_1.asArray;
  } });
  Object.defineProperty(exports, "deepAssign", { enumerable: true, get: function() {
    return objects_1.deepAssign;
  } });
  Object.defineProperty(exports, "objectToArgs", { enumerable: true, get: function() {
    return objects_1.objectToArgs;
  } });
  exports.CURRENT_APP_INSTALLER_FILE_NAME = "installer.exe";
  exports.CURRENT_APP_PACKAGE_FILE_NAME = "package.7z";
})(out);
const BUILD_METADATA_SCHEMA_VERSION = 1;
const BUILD_METADATA_FILE_NAME = "build-info.json";
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/u;
function normalizeSemanticVersion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^[vV]/u, "");
  return SEMVER_PATTERN.test(normalized) ? normalized : null;
}
function validateBuildMetadata(value, options = {}) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "not-an-object" };
  }
  const record = value;
  if (record["schemaVersion"] !== BUILD_METADATA_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported-schema" };
  }
  const requiredFields = ["version", "buildId", "sourceCommit", "workflowRunId", "workflowRunAttempt"];
  for (const field of requiredFields) {
    const fieldValue = record[field];
    if (typeof fieldValue !== "string" || !fieldValue.trim()) {
      return { ok: false, reason: "missing-field" };
    }
  }
  const version = record["version"];
  if (normalizeSemanticVersion(version) !== version) {
    return { ok: false, reason: "invalid-version" };
  }
  const expectedVersion = normalizeSemanticVersion(options.expectedVersion);
  if (options.expectedVersion !== void 0 && (!expectedVersion || expectedVersion !== version)) {
    return { ok: false, reason: "version-mismatch" };
  }
  return {
    ok: true,
    metadata: {
      schemaVersion: BUILD_METADATA_SCHEMA_VERSION,
      version,
      buildId: record["buildId"].trim(),
      sourceCommit: record["sourceCommit"].trim(),
      workflowRunId: record["workflowRunId"].trim(),
      workflowRunAttempt: record["workflowRunAttempt"].trim()
    }
  };
}
function parseBuildMetadata(content, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  return validateBuildMetadata(parsed, options);
}
function formatBuildIdLabel(buildId) {
  const normalized = typeof buildId === "string" ? buildId.trim() : "";
  if (!normalized) return "";
  const match = normalized.match(/^github-run-(\d+)-attempt-(\d+)$/u);
  if (match) return `#${match[1]}.${match[2]}`;
  if (normalized.length <= 24) return normalized;
  return `${normalized.slice(0, 8)}…`;
}
function resolveLocalBuildMetadataPath(resourcesPath) {
  return node_path.join(resourcesPath, BUILD_METADATA_FILE_NAME);
}
async function readLocalBuildMetadata(options) {
  if (!options.packaged || !options.resourcesPath) return void 0;
  const read = options.readFile ?? ((path) => promises.readFile(path, "utf8"));
  let content;
  try {
    content = await read(resolveLocalBuildMetadataPath(options.resourcesPath));
  } catch {
    return void 0;
  }
  const parsed = parseBuildMetadata(
    content,
    options.expectedVersion === void 0 ? {} : { expectedVersion: options.expectedVersion }
  );
  return parsed.ok ? parsed.metadata : void 0;
}
const DEFAULT_MINIMUM_INTERVAL_MS = 250;
const DEFAULT_SAMPLE_WINDOW_MS = 3e3;
function createUpdateProgressReporter(options) {
  const now = options.now ?? Date.now;
  const minimumIntervalMs = options.minimumIntervalMs ?? DEFAULT_MINIMUM_INTERVAL_MS;
  const sampleWindowMs = options.sampleWindowMs ?? DEFAULT_SAMPLE_WINDOW_MS;
  let total = Number.isFinite(options.total) && options.total > 0 ? options.total : 0;
  let transferred = 0;
  let lastReportedAt = 0;
  let highestPercent = 0;
  let samples = [];
  const currentBytesPerSecond = () => {
    if (samples.length < 2) return 0;
    const oldest = samples[0];
    const latest = samples[samples.length - 1];
    const elapsedMs = latest.at - oldest.at;
    if (elapsedMs <= 0) return 0;
    return (latest.transferred - oldest.transferred) / (elapsedMs / 1e3);
  };
  const buildProgress = () => {
    const rawPercent = total > 0 ? Math.min(100, transferred / total * 100) : 0;
    highestPercent = Math.max(highestPercent, rawPercent);
    return {
      percent: highestPercent,
      transferred,
      total,
      bytesPerSecond: currentBytesPerSecond()
    };
  };
  const recordSample = (at) => {
    samples.push({ at, transferred });
    const earliestAllowed = at - sampleWindowMs;
    const firstInsideWindow = samples.findIndex((sample) => sample.at >= earliestAllowed);
    if (firstInsideWindow > 1) samples = samples.slice(firstInsideWindow - 1);
  };
  const report = (at) => {
    lastReportedAt = at;
    options.onProgress?.(buildProgress());
  };
  return {
    start(initialTransferred = 0) {
      transferred = Math.max(0, initialTransferred);
      highestPercent = 0;
      samples = [];
      const at = now();
      recordSample(at);
      report(at);
    },
    add(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return;
      transferred += bytes;
      const at = now();
      recordSample(at);
      if (at - lastReportedAt >= minimumIntervalMs) report(at);
    },
    setTotal(value) {
      if (Number.isFinite(value) && value > 0) total = value;
    },
    finish() {
      const at = now();
      recordSample(at);
      report(at);
    },
    getTransferred() {
      return transferred;
    }
  };
}
class UpdateDownloadError extends Error {
  /** 与界面语言无关的稳定错误码。 */
  code;
  /**
   * 创建带错误码的更新下载异常。
   * @param code 稳定错误码，用于重试、续传与取消判定。
   * @param message 当前界面语言下的用户可见文案。
   * @author zhenghq
   */
  constructor(code, message) {
    super(message);
    this.name = "UpdateDownloadError";
    this.code = code;
  }
}
function createUpdateDownloadError(code, message) {
  return new UpdateDownloadError(code, message);
}
function getUpdateDownloadErrorCode(error2) {
  return error2 instanceof UpdateDownloadError ? error2.code : void 0;
}
function isUpdateDownloadErrorCode(error2, code) {
  return getUpdateDownloadErrorCode(error2) === code;
}
function isResumableUpdateDownloadError(error2) {
  const code = getUpdateDownloadErrorCode(error2);
  return code === "network-interrupted" || code === "request-timeout" || code === "read-timeout" || code === "segment-failed";
}
function isCancelledUpdateDownloadError(error2) {
  return getUpdateDownloadErrorCode(error2) === "cancelled";
}
function isTimeoutUpdateDownloadError(error2) {
  const code = getUpdateDownloadErrorCode(error2);
  return code === "request-timeout" || code === "read-timeout";
}
function resumeTemporaryPath(destination) {
  return `${destination}.part`;
}
function resumeRecordPath(destination) {
  return `${destination}.part.json`;
}
function isValidSegment(value) {
  if (!value || typeof value !== "object") return false;
  const segment = value;
  return Number.isFinite(segment.start) && Number.isFinite(segment.end) && Number.isFinite(segment.completed) && segment.start >= 0 && segment.end >= segment.start && segment.completed >= 0 && segment.completed <= segment.end - segment.start + 1;
}
function coversWholeFile(segments, total) {
  const ordered = [...segments].sort((left, right) => left.start - right.start);
  if (ordered[0]?.start !== 0) return false;
  if (ordered[ordered.length - 1]?.end !== total - 1) return false;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start !== ordered[index - 1].end + 1) return false;
  }
  return true;
}
async function saveDownloadResumeState(destination, record) {
  const recordPath = resumeRecordPath(destination);
  const temporaryRecordPath = `${recordPath}.tmp`;
  await promises.writeFile(temporaryRecordPath, JSON.stringify(record), "utf8");
  try {
    await promises.rename(temporaryRecordPath, recordPath);
  } catch {
    await promises.rm(recordPath, { force: true });
    await promises.rename(temporaryRecordPath, recordPath);
  }
}
async function loadDownloadResumeState(destination, target) {
  let record;
  try {
    const raw = await promises.readFile(resumeRecordPath(destination), "utf8");
    record = JSON.parse(raw);
  } catch {
    return void 0;
  }
  if (record?.version !== target.version) return void 0;
  if (record.total !== target.total) return void 0;
  if (record.sha512 !== target.sha512) return void 0;
  if (record.sha2 !== target.sha2) return void 0;
  if (!Array.isArray(record.segments) || record.segments.length === 0) return void 0;
  if (!record.segments.every(isValidSegment)) return void 0;
  if (!coversWholeFile(record.segments, record.total)) return void 0;
  const completed = record.segments.reduce((sum, segment) => sum + segment.completed, 0);
  try {
    const temporaryStat = await promises.stat(resumeTemporaryPath(destination));
    if (temporaryStat.size < completed) return void 0;
  } catch {
    return void 0;
  }
  return record;
}
async function clearDownloadResumeState(destination) {
  await promises.rm(resumeTemporaryPath(destination), { force: true }).catch(() => void 0);
  await promises.rm(resumeRecordPath(destination), { force: true }).catch(() => void 0);
  await promises.rm(`${resumeRecordPath(destination)}.tmp`, { force: true }).catch(() => void 0);
}
const MAX_DOWNLOAD_CONCURRENCY = 8;
const TARGET_SEGMENT_SIZE = 8 * 1024 * 1024;
const MINIMUM_SEGMENT_SIZE = 2 * 1024 * 1024;
const SEGMENT_QUEUE_MULTIPLIER = 2;
const DEFAULT_MAX_RETRIES = 3;
const SEGMENT_RETRY_DELAY_MS = 1e3;
const DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
const DEFAULT_READ_TIMEOUT_MS = 15e3;
const DEFAULT_CHECKPOINT_INTERVAL_BYTES = 4 * 1024 * 1024;
function parseRangeProbe(input) {
  const declaresBytes = (input.acceptRanges ?? "").toLowerCase().includes("bytes");
  if (input.status !== 206 || !declaresBytes) return { supported: false, total: 0 };
  const rangeTotal = Number(/\/(\d+)\s*$/u.exec(input.contentRange ?? "")?.[1]);
  const total = Number.isFinite(rangeTotal) && rangeTotal > 0 ? rangeTotal : Number.isFinite(input.manifestSize) && input.manifestSize > 0 ? input.manifestSize : 0;
  return total > 0 ? { supported: true, total } : { supported: false, total: 0 };
}
function planDownloadSegments(total, concurrency) {
  if (!Number.isFinite(total) || total <= 0) return [];
  const safeConcurrency = Math.max(
    1,
    Math.floor(Number.isFinite(concurrency) ? concurrency : MAX_DOWNLOAD_CONCURRENCY)
  );
  const maximumSegmentCount = Math.max(1, Math.floor(total / MINIMUM_SEGMENT_SIZE));
  const targetCount = Math.ceil(total / TARGET_SEGMENT_SIZE);
  const queueSegmentCount = Math.min(
    safeConcurrency * SEGMENT_QUEUE_MULTIPLIER,
    maximumSegmentCount
  );
  const finalCount = Math.max(targetCount, queueSegmentCount, 1);
  const segmentSize = Math.ceil(total / finalCount);
  const segments = [];
  for (let start = 0; start < total; start += segmentSize) {
    segments.push({ start, end: Math.min(start + segmentSize, total) - 1, completed: 0 });
  }
  return segments;
}
async function downloadSegments(options) {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? MAX_DOWNLOAD_CONCURRENCY, MAX_DOWNLOAD_CONCURRENCY));
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const readTimeoutMs = Math.max(1, options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS);
  const checkpointIntervalBytes = Math.max(
    1,
    options.checkpointIntervalBytes ?? DEFAULT_CHECKPOINT_INTERVAL_BYTES
  );
  const alreadyCompleted = options.segments.reduce((sum, segment) => sum + segment.completed, 0);
  const reporter = createUpdateProgressReporter({
    total: options.total,
    onProgress: options.onProgress
  });
  reporter.start(alreadyCompleted);
  const fileHandle = await promises.open(options.temporaryPath, "r+").catch(() => promises.open(options.temporaryPath, "w+"));
  let nextSegmentIndex = 0;
  let bytesSinceCheckpoint = 0;
  let checkpointChain = Promise.resolve();
  const requestCheckpoint = () => {
    const onCheckpoint = options.onCheckpoint;
    if (!onCheckpoint) return;
    checkpointChain = checkpointChain.then(() => onCheckpoint(options.segments)).catch(() => void 0);
  };
  const writeChunkAt = async (chunk, position) => {
    let written = 0;
    while (written < chunk.byteLength) {
      const result = await fileHandle.write(
        chunk,
        written,
        chunk.byteLength - written,
        position + written
      );
      if (result.bytesWritten <= 0) {
        throw createUpdateDownloadError(
          "write-failed",
          translateMain("update.downloadError.writeFailed")
        );
      }
      written += result.bytesWritten;
    }
    return written;
  };
  const recordWrittenBytes = (bytes) => {
    bytesSinceCheckpoint += bytes;
    if (bytesSinceCheckpoint < checkpointIntervalBytes) return;
    bytesSinceCheckpoint = 0;
    requestCheckpoint();
  };
  const downloadSegment = async (segment) => {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const rangeStart = segment.start + segment.completed;
      if (rangeStart > segment.end) return;
      if (options.signal?.aborted) {
        throw createUpdateDownloadError(
          "cancelled",
          translateMain("update.downloadError.cancelled")
        );
      }
      try {
        const requestAbortController = new AbortController();
        const abortRequest = () => requestAbortController.abort();
        options.signal?.addEventListener("abort", abortRequest, { once: true });
        let timeoutKind;
        const requestTimer = setTimeout(() => {
          if (!requestAbortController.signal.aborted) {
            timeoutKind = "request";
            abortRequest();
          }
        }, requestTimeoutMs);
        let readTimer;
        const resetReadTimeout = () => {
          if (readTimer) clearTimeout(readTimer);
          readTimer = setTimeout(() => {
            if (!requestAbortController.signal.aborted) {
              timeoutKind = "read";
              abortRequest();
            }
          }, readTimeoutMs);
        };
        const cleanupRequestResources = () => {
          clearTimeout(requestTimer);
          if (readTimer) clearTimeout(readTimer);
          options.signal?.removeEventListener("abort", abortRequest);
        };
        let response;
        try {
          response = await options.fetch(options.url, {
            headers: {
              ...options.headers,
              range: `bytes=${rangeStart}-${segment.end}`
            },
            signal: requestAbortController.signal
          });
        } catch (error2) {
          if (options.signal?.aborted) {
            throw createUpdateDownloadError(
              "cancelled",
              translateMain("update.downloadError.cancelled")
            );
          }
          if (timeoutKind === "request") {
            throw createUpdateDownloadError(
              "request-timeout",
              translateMain("update.downloadError.requestTimeout")
            );
          }
          if (isAbortLikeError(error2)) {
            throw createUpdateDownloadError(
              "network-interrupted",
              translateMain("update.downloadError.networkInterrupted")
            );
          }
          throw error2;
        } finally {
          if (!response) cleanupRequestResources();
        }
        clearTimeout(requestTimer);
        if (timeoutKind === "request") {
          throw createUpdateDownloadError(
            "request-timeout",
            translateMain("update.downloadError.requestTimeout")
          );
        }
        if (response.status !== 206) {
          throw new Error(`HTTP ${response.status}`);
        }
        let position = rangeStart;
        const body = response.body;
        if (body) {
          const reader = body.getReader();
          const readChunk = () => {
            return new Promise((resolve, reject) => {
              const onAbort = () => {
                requestAbortController.signal.removeEventListener("abort", onAbort);
                if (options.signal?.aborted) {
                  reject(createUpdateDownloadError(
                    "cancelled",
                    translateMain("update.downloadError.cancelled")
                  ));
                } else {
                  reject(createUpdateDownloadError(
                    timeoutKind === "read" ? "read-timeout" : "request-timeout",
                    translateMain(
                      timeoutKind === "read" ? "update.downloadError.readTimeout" : "update.downloadError.requestTimeout"
                    )
                  ));
                }
              };
              if (requestAbortController.signal.aborted) {
                onAbort();
                return;
              }
              requestAbortController.signal.addEventListener("abort", onAbort, { once: true });
              reader.read().then(
                (chunk) => {
                  requestAbortController.signal.removeEventListener("abort", onAbort);
                  resolve(chunk);
                },
                (error2) => {
                  requestAbortController.signal.removeEventListener("abort", onAbort);
                  reject(error2);
                }
              );
            });
          };
          let chunkLoopCompleted = false;
          try {
            resetReadTimeout();
            while (true) {
              if (options.signal?.aborted) {
                throw createUpdateDownloadError(
                  "cancelled",
                  translateMain("update.downloadError.cancelled")
                );
              }
              const chunk = await readChunk();
              if (chunk.done) break;
              if (!chunk.value) continue;
              resetReadTimeout();
              const written = await writeChunkAt(chunk.value, position);
              position += written;
              segment.completed += written;
              reporter.add(written);
              recordWrittenBytes(written);
            }
            if (timeoutKind === "read") {
              throw createUpdateDownloadError(
                "read-timeout",
                translateMain("update.downloadError.readTimeout")
              );
            }
            chunkLoopCompleted = true;
          } finally {
            cleanupRequestResources();
            if (!chunkLoopCompleted) await reader.cancel().catch(() => void 0);
          }
        } else {
          let arrayBufferCompleted = false;
          try {
            resetReadTimeout();
            const content = new Uint8Array(await response.arrayBuffer());
            if (timeoutKind === "read") {
              throw createUpdateDownloadError(
                "read-timeout",
                translateMain("update.downloadError.readTimeout")
              );
            }
            const written = await writeChunkAt(content, position);
            segment.completed += written;
            reporter.add(written);
            recordWrittenBytes(written);
            arrayBufferCompleted = true;
          } finally {
            cleanupRequestResources();
          }
        }
        return;
      } catch (error2) {
        lastError = normalizeSegmentError(error2, options.signal);
        if (isNetworkError(lastError)) {
          if (attempt < maxRetries) {
            await sleep(SEGMENT_RETRY_DELAY_MS, options.signal);
          }
        }
      }
    }
    throw createUpdateDownloadError(
      "segment-failed",
      translateMain("update.downloadError.segmentFailed", {
        start: segment.start,
        end: segment.end,
        message: lastError?.message ?? translateMain("update.downloadError.unknown")
      })
    );
  };
  const runWorker = async () => {
    while (true) {
      const index = nextSegmentIndex;
      nextSegmentIndex += 1;
      const segment = options.segments[index];
      if (!segment) return;
      await downloadSegment(segment);
    }
  };
  try {
    const workerCount = Math.min(concurrency, options.segments.length);
    const results = await Promise.allSettled(
      Array.from({ length: workerCount }, () => runWorker())
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") throw failure.reason;
    reporter.finish();
  } finally {
    await checkpointChain.catch(() => void 0);
    await fileHandle.close().catch(() => void 0);
  }
}
function isNetworkError(error2) {
  return /net::ERR_|ERR_(?:CONNECTION|TIMED_OUT|NETWORK|ABORTED)|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN/u.test(error2.message) || isUpdateDownloadErrorCode(error2, "request-timeout") || isUpdateDownloadErrorCode(error2, "read-timeout") || isUpdateDownloadErrorCode(error2, "network-interrupted");
}
function isAbortLikeError(error2) {
  if (!(error2 instanceof Error)) return false;
  if (error2.name === "AbortError") return true;
  return /this operation was aborted|operation aborted|the operation was aborted|request aborted|net::ERR_ABORTED/iu.test(error2.message);
}
function normalizeSegmentError(error2, signal) {
  if (signal?.aborted) {
    return createUpdateDownloadError(
      "cancelled",
      translateMain("update.downloadError.cancelled")
    );
  }
  if (error2 instanceof Error && getUpdateDownloadErrorCode(error2)) return error2;
  if (isAbortLikeError(error2)) {
    return createUpdateDownloadError(
      "network-interrupted",
      translateMain("update.downloadError.networkInterrupted")
    );
  }
  if (error2 instanceof Error && /net::ERR_/u.test(error2.message)) {
    return createUpdateDownloadError(
      "network-interrupted",
      translateMain("update.downloadError.networkInterrupted")
    );
  }
  return error2 instanceof Error ? error2 : new Error(String(error2));
}
function sleep(duration, signal) {
  if (signal?.aborted) {
    return Promise.reject(createUpdateDownloadError(
      "cancelled",
      translateMain("update.downloadError.cancelled")
    ));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, duration);
    const abort = () => {
      clearTimeout(timer);
      reject(createUpdateDownloadError(
        "cancelled",
        translateMain("update.downloadError.cancelled")
      ));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function resolveHttpsUpdateFileUrl(rawUrl, baseUrl) {
  try {
    const parsedUrl = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    return parsedUrl.protocol === "https:" ? parsedUrl : void 0;
  } catch {
    return void 0;
  }
}
function resolveManualMacDmgTarget(files, architecture, baseUrl) {
  const dmgFiles = files.filter((file) => /\.dmg(?:$|[?#])/iu.test(file.url));
  const architecturePattern = architecture === "arm64" ? /(?:arm64|aarch64)/iu : /(?:x64|x86_64|amd64)/iu;
  const buildVerifiedTarget = (file) => {
    const url = resolveHttpsUpdateFileUrl(file.url, baseUrl)?.toString();
    if (!url) return void 0;
    const target = { url };
    if (file.sha512) target.sha512 = file.sha512;
    if (Number.isFinite(file.size) && file.size > 0) target.size = file.size;
    return target;
  };
  const directDmg = dmgFiles.find((file) => architecturePattern.test(file.url));
  if (directDmg) return buildVerifiedTarget(directDmg);
  const zipFiles = files.filter((file) => /\.zip(?:$|[?#])/iu.test(file.url));
  const zipFile = zipFiles.find((file) => architecturePattern.test(file.url)) ?? (dmgFiles.length === 0 ? zipFiles[0] : void 0);
  if (!zipFile) {
    const fallbackDmg = dmgFiles[0];
    return fallbackDmg ? buildVerifiedTarget(fallbackDmg) : void 0;
  }
  const parsedUrl = resolveHttpsUpdateFileUrl(zipFile.url, baseUrl);
  if (!parsedUrl) return void 0;
  parsedUrl.pathname = parsedUrl.pathname.replace(/\.zip$/iu, ".dmg");
  return { url: parsedUrl.toString() };
}
function validateHttpsUrl(rawUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw createUpdateDownloadError(
      "invalid-url",
      translateMain("update.downloadError.invalidUrl")
    );
  }
  if (parsedUrl.protocol !== "https:") {
    throw createUpdateDownloadError(
      "insecure-url",
      translateMain("update.downloadError.insecureUrl")
    );
  }
  return parsedUrl;
}
function validateDmgUrl(rawUrl) {
  const parsedUrl = validateHttpsUrl(rawUrl);
  if (!parsedUrl.pathname.toLowerCase().endsWith(".dmg")) {
    throw createUpdateDownloadError(
      "not-dmg",
      translateMain("update.downloadError.notDmg")
    );
  }
  return parsedUrl.toString();
}
function sanitizeFileNamePart(value) {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/\.{2,}/gu, "_").replace(/^\.+/u, "_");
  return sanitized || "unknown";
}
function buildDmgPath(downloadsDirectory, version, architecture) {
  const filename = `SelectionTranslator-${sanitizeFileNamePart(version)}-mac-${sanitizeFileNamePart(architecture)}.dmg`;
  return node_path.join(downloadsDirectory, node_path.basename(filename));
}
async function computeFileSha512$1(path) {
  const hash = node_crypto.createHash("sha512");
  await new Promise((resolve, reject) => {
    const stream = node_fs.createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("base64");
}
function resolveResponseTotal(response, alreadyCompleted) {
  const contentRange = response.headers.get("content-range");
  const rangeTotal = contentRange ? Number(/\/(\d+)\s*$/u.exec(contentRange)?.[1]) : Number.NaN;
  if (Number.isFinite(rangeTotal) && rangeTotal > 0) return rangeTotal;
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(contentLength) || contentLength <= 0) return 0;
  return contentLength + alreadyCompleted;
}
async function requestWithRedirects(fetcher, initialUrl, headers, signal) {
  let currentUrl = initialUrl;
  let response;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    response = await fetcher(currentUrl, { redirect: "manual", headers, signal });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) {
      throw createUpdateDownloadError(
        "redirect-missing-location",
        translateMain("update.downloadError.redirectMissingLocation")
      );
    }
    currentUrl = validateHttpsUrl(new URL(location, currentUrl).toString()).toString();
    if (redirectCount === 5) {
      throw createUpdateDownloadError(
        "too-many-redirects",
        translateMain("update.downloadError.tooManyRedirects")
      );
    }
  }
  if (!response || !response.ok) {
    throw createUpdateDownloadError(
      "download-http-failed",
      translateMain("update.downloadError.downloadHttpFailed", {
        status: response?.status ?? translateMain("update.downloadError.unknownStatus")
      })
    );
  }
  return response;
}
async function writeResponseToTemporaryFile(response, temporaryPath, startOffset, reporter, signal) {
  const fileHandle = await promises.open(temporaryPath, startOffset > 0 ? "r+" : "w");
  let position = startOffset;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        if (signal?.aborted) {
          throw createUpdateDownloadError(
            "cancelled",
            translateMain("update.downloadError.cancelled")
          );
        }
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!chunk.value) continue;
        await fileHandle.write(chunk.value, 0, chunk.value.byteLength, position);
        position += chunk.value.byteLength;
        reporter.add(chunk.value.byteLength);
      }
    } else {
      const content = new Uint8Array(await response.arrayBuffer());
      await fileHandle.write(content, 0, content.byteLength, position);
      position += content.byteLength;
      reporter.add(content.byteLength);
    }
  } finally {
    await fileHandle.close().catch(() => void 0);
  }
}
async function probeRangeSupport$1(fetcher, url, manifestSize) {
  try {
    const response = await fetcher(url, { headers: { range: "bytes=0-0" } });
    await response.arrayBuffer().catch(() => void 0);
    return parseRangeProbe({
      status: response.status,
      acceptRanges: response.headers.get("accept-ranges"),
      contentRange: response.headers.get("content-range"),
      manifestSize
    });
  } catch {
    return { supported: false, total: 0 };
  }
}
async function ensureTemporaryFileSize(temporaryPath, total) {
  const fileHandle = await promises.open(temporaryPath, "a+");
  try {
    await fileHandle.truncate(total);
  } finally {
    await fileHandle.close().catch(() => void 0);
  }
}
async function finalizeDownload(params) {
  if (params.sha512) {
    const actualSha512 = await computeFileSha512$1(params.temporaryPath);
    if (actualSha512 !== params.sha512) {
      await clearDownloadResumeState(params.destination);
      await promises.rm(params.destination, { force: true }).catch(() => void 0);
      throw createUpdateDownloadError(
        "integrity-failed",
        translateMain("update.downloadError.integrityFailed")
      );
    }
  }
  await promises.rename(params.temporaryPath, params.destination);
  await clearDownloadResumeState(params.destination);
  const openError = await params.openPath(params.destination);
  if (openError) {
    throw createUpdateDownloadError(
      "open-failed",
      translateMain("update.downloadError.openFailed", { message: openError })
    );
  }
  return { path: params.destination, verified: Boolean(params.sha512) };
}
function createManualMacUpdateService(options) {
  const fetcher = options.fetch;
  const architecture = options.architecture ?? process.arch;
  return {
    /**
     * 下载指定 DMG、校验完整性、保存到 Downloads 并交给 Finder 打开。
     * @param url 已从更新清单获取的 DMG 下载地址。
     * @param version 更新版本号。
    * @param onProgress 下载进度回调。
     * @param integrity 更新清单提供的 sha512 校验值与文件长度。
     * @param signal 可选的取消信号；触发后下载中断并保留断点续传记录。
     * @returns 下载文件路径与校验结果的 Promise。
     * @author zhenghq
     */
    async downloadAndOpen(url, version, onProgress, integrity, signal) {
      const throwIfAborted = () => {
        if (signal?.aborted) {
          throw createUpdateDownloadError(
            "cancelled",
            translateMain("update.downloadError.cancelled")
          );
        }
      };
      throwIfAborted();
      const validatedUrl = validateDmgUrl(url);
      const destination = buildDmgPath(options.downloadsDirectory, version, architecture);
      const temporaryPath = resumeTemporaryPath(destination);
      await promises.mkdir(options.downloadsDirectory, { recursive: true });
      const expectedTotal = integrity?.size ?? 0;
      const resumeRecord = expectedTotal > 0 ? await loadDownloadResumeState(destination, {
        version,
        total: expectedTotal,
        sha512: integrity?.sha512
      }) : void 0;
      const completedBytes = resumeRecord ? resumeRecord.segments.reduce((sum, segment) => sum + segment.completed, 0) : 0;
      if (!resumeRecord) await clearDownloadResumeState(destination);
      const headers = {};
      if (completedBytes > 0) headers["range"] = `bytes=${completedBytes}-`;
      const plannedSegments = planDownloadSegments(expectedTotal, MAX_DOWNLOAD_CONCURRENCY);
      const probe = plannedSegments.length > 1 ? await probeRangeSupport$1(fetcher, validatedUrl, expectedTotal) : { supported: false, total: 0 };
      if (probe.supported && probe.total > 0) {
        const segments = resumeRecord?.segments.length ? resumeRecord.segments : probe.total === expectedTotal ? plannedSegments : planDownloadSegments(probe.total, MAX_DOWNLOAD_CONCURRENCY);
        await ensureTemporaryFileSize(temporaryPath, probe.total);
        try {
          await downloadSegments({
            url: validatedUrl,
            temporaryPath,
            total: probe.total,
            segments,
            concurrency: MAX_DOWNLOAD_CONCURRENCY,
            fetch: fetcher,
            onProgress,
            signal
          });
        } catch (error2) {
          await saveDownloadResumeState(destination, {
            version,
            total: probe.total,
            ...integrity?.sha512 ? { sha512: integrity.sha512 } : {},
            segments
          });
          throw error2;
        }
        return finalizeDownload({
          destination,
          temporaryPath,
          sha512: integrity?.sha512,
          openPath: options.openPath
        });
      }
      const reporter = createUpdateProgressReporter({ total: expectedTotal, onProgress });
      reporter.start(completedBytes);
      const response = await requestWithRedirects(fetcher, validatedUrl, headers, signal);
      const startOffset = completedBytes > 0 && response.status === 206 ? completedBytes : 0;
      if (startOffset === 0 && completedBytes > 0) {
        reporter.start(0);
        await promises.rm(temporaryPath, { force: true }).catch(() => void 0);
      }
      reporter.setTotal(resolveResponseTotal(response, startOffset));
      try {
        await writeResponseToTemporaryFile(response, temporaryPath, startOffset, reporter, signal);
      } catch (error2) {
        const total = expectedTotal > 0 ? expectedTotal : 0;
        const written = await promises.stat(temporaryPath).then((info) => info.size).catch(() => 0);
        if (total > 0 && written > 0) {
          await saveDownloadResumeState(destination, {
            version,
            total,
            ...integrity?.sha512 ? { sha512: integrity.sha512 } : {},
            segments: [{ start: 0, end: total - 1, completed: written }]
          });
        } else {
          await clearDownloadResumeState(destination);
        }
        throw error2;
      }
      reporter.setTotal(reporter.getTransferred());
      reporter.finish();
      return finalizeDownload({
        destination,
        temporaryPath,
        sha512: integrity?.sha512,
        openPath: options.openPath
      });
    }
  };
}
function assetFileName(value) {
  const withoutQuery = value.split(/[?#]/u, 1)[0];
  try {
    return node_path.basename(decodeURIComponent(withoutQuery));
  } catch {
    return node_path.basename(withoutQuery);
  }
}
function selectBuildMetadataAsset(assets) {
  if (!Array.isArray(assets)) return void 0;
  const matches = assets.filter(
    (asset) => typeof asset?.name === "string" && assetFileName(asset.name) === BUILD_METADATA_FILE_NAME
  );
  return matches.length === 1 ? matches[0] : void 0;
}
function applyCacheBustingQuery(url, cacheKey) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}cacheBust=${encodeURIComponent(cacheKey)}`;
}
async function fetchRemoteBuildMetadata(options) {
  const asset = selectBuildMetadataAsset(options.assets);
  if (!asset) return { ok: false, reason: "asset-missing" };
  const expectedDigest = typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/iu, "").trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) return { ok: false, reason: "digest-missing" };
  const downloadUrl = asset.browser_download_url || (options.fallbackDownloadBaseUrl ? `${options.fallbackDownloadBaseUrl}${BUILD_METADATA_FILE_NAME}` : "");
  if (!downloadUrl) return { ok: false, reason: "asset-missing" };
  let content;
  try {
    const response = await options.fetch(
      applyCacheBustingQuery(downloadUrl, expectedDigest.slice(0, 16)),
      { headers: { "cache-control": "no-cache", pragma: "no-cache" } }
    );
    if (!response.ok) return { ok: false, reason: "download-failed" };
    content = await response.text();
  } catch {
    return { ok: false, reason: "download-failed" };
  }
  const actualDigest = node_crypto.createHash("sha256").update(content).digest("hex");
  if (actualDigest !== expectedDigest) return { ok: false, reason: "digest-mismatch" };
  const parsed = parseBuildMetadata(
    content,
    options.expectedVersion === void 0 ? {} : { expectedVersion: options.expectedVersion }
  );
  return parsed.ok ? { ok: true, metadata: parsed.metadata } : { ok: false, reason: parsed.reason };
}
function fileName(value) {
  try {
    return node_path.basename(decodeURIComponent(new URL(value).pathname));
  } catch {
    return node_path.basename(value.split(/[?#]/u, 1)[0]);
  }
}
function parseSha256Sums(content) {
  const result = /* @__PURE__ */ new Map();
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^([a-f0-9]{64})\s+[* ]?(.+)$/iu);
    if (!match) continue;
    result.set(fileName(match[2].trim()), match[1].toLowerCase());
  }
  return result;
}
async function validateReleaseChecksums(options) {
  const assetName = options.assetNames.map(fileName).find(Boolean) || "未知安装包";
  const baseResult = { assetName };
  if (options.assetNames.length === 0) return { ...baseResult, status: "missing" };
  let response;
  try {
    response = await options.fetch(options.manifestUrl);
  } catch {
    return { ...baseResult, status: "unreachable" };
  }
  if (!response.ok) return { ...baseResult, status: "missing" };
  const sums = parseSha256Sums(await response.text());
  const candidateNames = options.assetNames.map(fileName);
  const matchingName = candidateNames.find((name) => sums.has(name));
  if (!matchingName) return { ...baseResult, status: "missing" };
  const expectedSha256 = sums.get(matchingName);
  const asset = options.assets?.find((item) => fileName(item.name) === matchingName);
  if (!asset?.digest) return { assetName: matchingName, expectedSha256, status: "missing" };
  const actualSha256 = asset.digest.replace(/^sha256:/iu, "").toLowerCase();
  if (expectedSha256 !== actualSha256) {
    return { assetName: matchingName, expectedSha256, status: "mismatch" };
  }
  return { assetName: matchingName, expectedSha256, status: "verified" };
}
function createAbortSignalFromToken(cancellationToken) {
  const controller = new AbortController();
  cancellationToken.createPromise((_resolve, _reject, onCancel) => {
    onCancel(() => controller.abort());
  }).catch(() => void 0);
  return controller.signal;
}
function buildFetchHeaders(options) {
  const headers = {};
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value != null) headers[key] = String(value);
  }
  return headers;
}
function reportElectronProgress(progress, onProgress) {
  onProgress?.({
    total: progress.total,
    delta: 0,
    transferred: progress.transferred,
    percent: progress.percent,
    bytesPerSecond: progress.bytesPerSecond
  });
}
function resolveResumeBasePath(destination) {
  const pendingDirectory = node_path.dirname(destination);
  const fileName2 = node_path.basename(destination);
  return node_path.basename(pendingDirectory) === "pending" ? node_path.join(node_path.dirname(pendingDirectory), "resume", fileName2) : `${destination}.resume`;
}
async function clearStaleResumeEntries(resumeDirectory, keepFileName) {
  const entries = await promises.readdir(resumeDirectory).catch(() => []);
  const keepFileNames = /* @__PURE__ */ new Set([
    keepFileName,
    `${keepFileName}.json`,
    `${keepFileName}.json.tmp`
  ]);
  await Promise.all(entries.filter((entry) => !keepFileNames.has(entry)).map((entry) => promises.rm(node_path.join(resumeDirectory, entry), { recursive: true, force: true }).catch(() => void 0)));
}
async function ensureFileSize(destination, total, preserveExisting = false) {
  let fileHandle;
  try {
    if (preserveExisting) {
      try {
        fileHandle = await promises.open(destination, "r+");
      } catch {
        fileHandle = await promises.open(destination, "w+");
      }
      const info = await fileHandle.stat();
      if (info.size !== total) await fileHandle.truncate(total);
    } else {
      fileHandle = await promises.open(destination, "w+");
      await fileHandle.truncate(total);
    }
    return true;
  } catch (error2) {
    if (!isTransientWindowsLockError(error2)) throw error2;
    logElectronUpdaterWarning(
      `Unable to truncate the update temporary file; falling back to native download: ${normalizeErrorMessage(error2)}`
    );
    return false;
  } finally {
    await fileHandle?.close().catch(() => void 0);
  }
}
function isTransientWindowsLockError(error2) {
  if (!(error2 instanceof Error)) return false;
  return /EPERM|EACCES|EBUSY/u.test(error2.message);
}
function normalizeErrorMessage(error2) {
  return error2 instanceof Error ? error2.message.trim() : String(error2);
}
function logElectronUpdaterWarning(message) {
  console.warn(`[electron-updater] ${message}`);
}
async function computeFileSha512(path) {
  const hash = node_crypto.createHash("sha512");
  await new Promise((resolve, reject) => {
    const stream = node_fs.createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("base64");
}
async function computeFileSha2(path) {
  const hash = node_crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = node_fs.createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}
function isHexSha512(sha512) {
  return sha512.length === 128 && !sha512.includes("+") && !sha512.includes("Z") && !sha512.includes("=");
}
async function verifyParallelDownload(destination, options, expectedSize) {
  const actualSize = await promises.stat(destination).then((info) => info.size).catch(() => 0);
  if (actualSize !== expectedSize) {
    throw createUpdateDownloadError(
      "length-mismatch",
      translateMain("update.downloadError.lengthMismatch", {
        expected: expectedSize,
        actual: actualSize
      })
    );
  }
  if (options.sha512 != null) {
    const actual = await computeFileSha512(destination);
    const expected = options.sha512;
    const matches = isHexSha512(expected) ? actual === Buffer.from(expected, "hex").toString("base64") : actual === expected;
    if (!matches) {
      throw createUpdateDownloadError(
        "checksum-mismatch",
        translateMain("update.downloadError.checksumMismatch")
      );
    }
  } else if (options.sha2 != null) {
    if (await computeFileSha2(destination) !== options.sha2) {
      throw createUpdateDownloadError(
        "checksum-mismatch",
        translateMain("update.downloadError.checksumMismatch")
      );
    }
  }
}
async function probeRangeSupport(fetcher, url, headers) {
  try {
    const response = await fetcher(url.toString(), {
      headers: { ...headers, range: "bytes=0-0" }
    });
    if (response.body) {
      await response.body.cancel().catch(() => void 0);
    } else {
      await response.arrayBuffer().catch(() => void 0);
    }
    return parseRangeProbe({
      status: response.status,
      acceptRanges: response.headers.get("accept-ranges"),
      contentRange: response.headers.get("content-range")
    });
  } catch {
    return { supported: false, total: 0 };
  }
}
function installParallelUpdateDownload(updater, fetcher) {
  const updaterWithExecutor = updater;
  const executor = updaterWithExecutor.httpExecutor;
  if (!executor?.download) return;
  const fullDownload = executor.download.bind(executor);
  executor.download = async (url, destination, options) => {
    const headers = buildFetchHeaders(options);
    const probe = await probeRangeSupport(fetcher, url, headers);
    if (!probe.supported || probe.total <= 0) {
      return fullDownload(url, destination, options);
    }
    const plannedSegments = planDownloadSegments(probe.total, MAX_DOWNLOAD_CONCURRENCY);
    if (plannedSegments.length <= 1) {
      return fullDownload(url, destination, options);
    }
    const resumeBasePath = resolveResumeBasePath(destination);
    const resumePath = resumeTemporaryPath(resumeBasePath);
    await promises.mkdir(node_path.dirname(resumePath), { recursive: true });
    await clearStaleResumeEntries(node_path.dirname(resumePath), node_path.basename(resumePath));
    const resumeRecord = await loadDownloadResumeState(resumeBasePath, {
      total: probe.total,
      ...options.sha512 != null ? { sha512: options.sha512 } : {},
      ...options.sha2 != null ? { sha2: options.sha2 } : {}
    });
    const segments = resumeRecord?.segments ?? plannedSegments;
    if (!resumeRecord) await clearDownloadResumeState(resumeBasePath);
    const fileReady = await ensureFileSize(resumePath, probe.total, resumeRecord != null);
    if (!fileReady) {
      return fullDownload(url, destination, options);
    }
    const resumeRecordForWrite = () => ({
      total: probe.total,
      ...options.sha512 != null ? { sha512: options.sha512 } : {},
      ...options.sha2 != null ? { sha2: options.sha2 } : {},
      segments
    });
    try {
      await downloadSegments({
        url: url.toString(),
        temporaryPath: resumePath,
        total: probe.total,
        segments,
        concurrency: MAX_DOWNLOAD_CONCURRENCY,
        fetch: fetcher,
        headers,
        signal: createAbortSignalFromToken(options.cancellationToken),
        onProgress: (progress) => reportElectronProgress(progress, options.onProgress),
        onCheckpoint: () => saveDownloadResumeState(resumeBasePath, resumeRecordForWrite())
      });
      await verifyParallelDownload(resumePath, options, probe.total);
      await promises.rm(destination, { force: true }).catch(() => void 0);
      await promises.rename(resumePath, destination);
      await clearDownloadResumeState(resumeBasePath);
    } catch (error2) {
      if (isUpdateDownloadErrorCode(error2, "length-mismatch") || isUpdateDownloadErrorCode(error2, "checksum-mismatch") || error2 instanceof Error && /checksum mismatch/iu.test(error2.message)) {
        await clearDownloadResumeState(resumeBasePath);
      } else {
        await saveDownloadResumeState(resumeBasePath, resumeRecordForWrite()).catch(() => void 0);
      }
      throw error2;
    }
    return destination;
  };
}
function compareSemanticVersions(left, right) {
  const normalizedLeft = normalizeSemanticVersion(left);
  const normalizedRight = normalizeSemanticVersion(right);
  if (!normalizedLeft || !normalizedRight) return null;
  const leftParts = normalizedLeft.split(".").map(Number);
  const rightParts = normalizedRight.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}
function resolveBuildId(metadata, expectedVersion) {
  if (!metadata) return void 0;
  const buildId = typeof metadata.buildId === "string" ? metadata.buildId.trim() : "";
  if (!buildId) return void 0;
  if (normalizeSemanticVersion(metadata.version) !== expectedVersion) return void 0;
  return buildId;
}
function decideUpdateAvailability(input) {
  const currentVersion = normalizeSemanticVersion(input.currentVersion);
  const remoteVersion = normalizeSemanticVersion(input.remoteVersion);
  if (!currentVersion || !remoteVersion) return { outcome: "metadata-unavailable" };
  const comparison = compareSemanticVersions(remoteVersion, currentVersion);
  if (comparison === null) return { outcome: "metadata-unavailable" };
  if (comparison > 0) return { outcome: "higher-version", remoteVersion };
  if (comparison < 0) return { outcome: "up-to-date", remoteVersion };
  const localBuildId = resolveBuildId(input.localBuild, currentVersion);
  const remoteBuildId = resolveBuildId(input.remoteBuild, remoteVersion);
  if (!localBuildId || !remoteBuildId) {
    return { outcome: "metadata-unavailable", remoteVersion };
  }
  if (localBuildId === remoteBuildId) {
    return { outcome: "up-to-date", remoteVersion, localBuildId, remoteBuildId };
  }
  return { outcome: "same-version-new-build", remoteVersion, localBuildId, remoteBuildId };
}
const UPDATE_CHECK_MAX_ATTEMPTS = 3;
const UPDATE_CHECK_RETRY_BASE_DELAY_MS = 600;
const UPDATE_DOWNLOAD_MAX_ATTEMPTS = 3;
const UPDATE_DOWNLOAD_RETRY_BASE_DELAY_MS = 1e3;
function resolveUpdateInstallMode(platform, packaged, linuxAppImage, macSigned, macDiskImage = false) {
  if (!packaged) return "disabled";
  if (platform === "darwin") return macSigned && !macDiskImage ? "automatic" : "manual";
  if (platform === "linux") return linuxAppImage ? "automatic" : "manual";
  return platform === "win32" ? "automatic" : "manual";
}
function resolveMacOSAppBundlePath(executablePath) {
  const marker = ".app/Contents/MacOS/";
  const markerIndex = executablePath.indexOf(marker);
  if (markerIndex < 0) return null;
  return executablePath.slice(0, markerIndex + ".app".length);
}
function isMacOSDeveloperIdApplicationSignature(signatureDetails) {
  return /^Authority=Developer ID Application:/mu.test(signatureDetails) && /^TeamIdentifier=499QMYBXLR$/mu.test(signatureDetails);
}
function isMacOSCodeSignatureValidationError(rawMessage) {
  return /Code signature at URL[\s\S]*did not pass validation/iu.test(rawMessage) || /代码未能满足指定的代码要求/u.test(rawMessage);
}
function isRetryableUpdateCheckError(error2) {
  const rawMessage = error2 instanceof Error ? error2.message : String(error2);
  return /ERR_(?:CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_ABORTED|CONNECTION_REFUSED|CONNECTION_FAILED|TIMED_OUT|NETWORK_CHANGED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/iu.test(rawMessage);
}
function formatTransientNetworkErrorMessage(rawMessage, translator) {
  if (/ERR_(?:TIMED_OUT|CONNECTION_TIMED_OUT)|ETIMEDOUT|timeout/iu.test(rawMessage)) {
    return translator.t("update.error.networkTimeout");
  }
  if (/ERR_(?:NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)|ENOTFOUND|EAI_AGAIN/iu.test(rawMessage)) {
    return translator.t("update.error.networkUnavailable");
  }
  if (isRetryableUpdateCheckError(rawMessage)) {
    return translator.t("update.error.networkInterrupted");
  }
  return void 0;
}
function isResumableDownloadError(error2) {
  const rawMessage = error2 instanceof Error ? error2.message : String(error2);
  const code = getUpdateDownloadErrorCode(error2);
  if (code === "length-mismatch" || code === "checksum-mismatch" || code === "http-error") {
    return false;
  }
  if (/checksum mismatch|HTTP \d{3}/iu.test(rawMessage)) return false;
  if (isDownloadCancelledError(error2)) return false;
  if (isResumableUpdateDownloadError(error2)) return true;
  return /分片(?:下载失败|请求超时|读取超时)|网络连接被中断|ERR_(?:CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_ABORTED|CONNECTION_REFUSED|CONNECTION_FAILED|TIMED_OUT|NETWORK_CHANGED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ABORTED)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|This operation was aborted/iu.test(rawMessage);
}
function isDownloadCancelledError(error2) {
  const rawMessage = error2 instanceof Error ? error2.message : String(error2);
  if (isCancelledUpdateDownloadError(error2)) return true;
  return /下载已取消|已取消下载|cancell?ed/iu.test(rawMessage);
}
function formatResumableDownloadErrorMessage(error2, translator) {
  if (!isResumableDownloadError(error2)) return void 0;
  const rawMessage = error2 instanceof Error ? error2.message : String(error2);
  return isTimeoutUpdateDownloadError(error2) || /超时|timed? out|ETIMEDOUT/iu.test(rawMessage) ? translator.t("update.error.downloadTimeout") : translator.t("update.error.downloadInterrupted");
}
function formatUpdateErrorMessage(error2, translator, phase) {
  const rawMessage = error2 instanceof Error ? error2.message : String(error2);
  if (isMacOSCodeSignatureValidationError(rawMessage)) {
    return translator.t("update.error.signatureMismatch");
  }
  if (phase === "downloading") {
    const resumeMessage = formatResumableDownloadErrorMessage(error2, translator);
    if (resumeMessage) return resumeMessage;
  }
  const networkMessage = formatTransientNetworkErrorMessage(rawMessage, translator);
  if (networkMessage) return networkMessage;
  const metadataMatch = rawMessage.match(/Cannot find\s+(latest(?:-[\w-]+)?\.yml)\b/iu);
  if (metadataMatch && /\b404\b/u.test(rawMessage)) {
    return translator.t("update.error.missingManifest", { manifest: metadataMatch[1] });
  }
  const firstLine = rawMessage.split(/\r?\n/u, 1)[0].replace(/\s+/gu, " ").trim();
  const conciseMessage = firstLine.length > 240 ? `${firstLine.slice(0, 239)}…` : firstLine;
  return translator.t("update.error.generic", {
    message: conciseMessage || translator.t("common.unknownError")
  });
}
function formatChecksumNotice(checksumStatus, translator) {
  if (checksumStatus === "missing") return translator.t("update.checksumMissing");
  if (checksumStatus === "mismatch") return translator.t("update.checksumMismatch");
  if (checksumStatus === "unreachable") return translator.t("update.checksumUnreachable");
  return "";
}
class UpdateManager {
  /**
   * 创建自动更新管理器并连接底层驱动事件。
   * @param options 自动更新依赖和运行环境选项。
   * @author zhenghq
   */
  constructor(options) {
    this.options = options;
    this.translator = options.translator ?? createTranslator("zh-CN");
    const translator = this.currentTranslator();
    const disabled = !options.enabled || options.installMode === "disabled";
    this.status = {
      phase: disabled ? "disabled" : "idle",
      currentVersion: options.currentVersion,
      installMode: disabled ? "disabled" : options.installMode,
      releaseUrl: options.releaseUrl,
      message: disabled ? translator.t("update.disabled") : translator.t("update.idle")
    };
    options.driver.initialize({
      checking: () => this.setStatus({ phase: "checking", message: this.currentTranslator().t("update.checking") }),
      available: (info) => this.handleAvailable(info),
      notAvailable: (info) => this.handleNotAvailable(info),
      progress: (progress) => this.handleProgress(progress),
      downloaded: (info) => this.handleDownloaded(info),
      error: (error2) => this.handleDriverError(error2)
    });
  }
  status;
  translator;
  manualDownloadUrl;
  manualDownloadIntegrity;
  /** 手动 DMG 下载的取消控制器；仅下载期间存在。 */
  manualDownloadAbort;
  /**
   * 设置后续更新状态使用的翻译器，用于界面语言即时切换。
   * @param translator 新的界面语言翻译器。
   * @returns 无返回值。
   * @author zhenghq
   */
  setTranslator(translator) {
    this.translator = translator;
  }
  /**
   * 获取当前应使用的翻译器；优先读取运行时提供的最新实例。
   * @returns 当前界面语言翻译器。
   * @author zhenghq
   */
  currentTranslator() {
    return this.options.getTranslator?.() ?? this.translator;
  }
  /**
   * 处理底层更新驱动广播的错误事件。
   *
   * electron-updater 在检查失败时会先同步广播 `error` 事件、再拒绝
   * `checkForUpdates()` 的 Promise。重试期间若直接把临时网络错误展示为最终
   * 失败，界面会先闪出错误提示，随后又被重试覆盖。这里把可恢复网络错误交回
   * `checkForUpdates()` 的重试循环统一处理，只在重试耗尽后展示最终错误。
   * @param error 底层更新驱动上报的异常。
   * @returns 无返回值。
   * @author zhenghq
   */
  handleDriverError(error2) {
    if (this.status.phase === "checking" && isRetryableUpdateCheckError(error2)) return;
    if (this.status.phase === "downloading" && isResumableDownloadError(error2)) return;
    if (isDownloadCancelledError(error2)) return;
    this.handleError(error2);
  }
  /**
   * 获取当前自动更新状态的只读副本。
   * @returns 当前自动更新状态。
   * @author zhenghq
   */
  getStatus() {
    const status = { ...this.status };
    if (this.status.progress) {
      status.progress = { ...this.status.progress };
    } else {
      delete status.progress;
    }
    return status;
  }
  /**
   * 主动检查 GitHub Release 中的最新版本。
   * @returns 检查请求发出后的当前状态。
   * @author zhenghq
   */
  async checkForUpdates() {
    if (this.status.phase === "disabled" || this.status.phase === "downloading") {
      return this.getStatus();
    }
    if (this.status.phase === "checking") return this.getStatus();
    if (this.options.isOnline && !this.options.isOnline()) return this.getStatus();
    this.setStatus({ phase: "checking", message: this.currentTranslator().t("update.checking"), progress: void 0 });
    for (let attempt = 1; attempt <= UPDATE_CHECK_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.options.driver.checkForUpdates();
        return this.getStatus();
      } catch (error2) {
        const isLastAttempt = attempt >= UPDATE_CHECK_MAX_ATTEMPTS;
        if (isLastAttempt || !isRetryableUpdateCheckError(error2)) {
          this.handleError(error2);
          return this.getStatus();
        }
        await new Promise((resolve) => {
          setTimeout(resolve, UPDATE_CHECK_RETRY_BASE_DELAY_MS * attempt);
        });
      }
    }
    return this.getStatus();
  }
  /**
   * 下载新版本；手动安装模式下把 DMG 保存到 Downloads 并打开安装界面。
   * @returns 操作完成后的当前状态。
   * @author zhenghq
   */
  async downloadUpdate() {
    if (this.status.updateAction === "open-release") {
      return this.openReleaseForManualUpdate();
    }
    if (this.status.updateAction === "verified-manual-download") {
      return this.downloadManualMacUpdate();
    }
    if (this.status.installMode === "manual") {
      return this.downloadManualMacUpdate();
    }
    if (this.status.installMode !== "automatic" || this.status.phase !== "available") {
      return this.getStatus();
    }
    this.setStatus({
      phase: "downloading",
      message: this.currentTranslator().t("update.downloadingInitial"),
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }
    });
    for (let attempt = 1; attempt <= UPDATE_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.options.driver.downloadUpdate();
        return this.getStatus();
      } catch (error2) {
        if (this.status.phase !== "downloading") return this.getStatus();
        const isLastAttempt = attempt >= UPDATE_DOWNLOAD_MAX_ATTEMPTS;
        if (isLastAttempt || !isResumableDownloadError(error2)) {
          this.handleError(error2);
          return this.getStatus();
        }
        this.setStatus({
          phase: "downloading",
          message: this.currentTranslator().t("update.downloadingInitial")
        });
        await new Promise((resolve) => {
          setTimeout(resolve, UPDATE_DOWNLOAD_RETRY_BASE_DELAY_MS * attempt);
        });
      }
    }
    return this.getStatus();
  }
  /**
   * 安装已下载的新版本并重新启动应用。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate() {
    if (this.status.updateReason === "same-version-new-build") return;
    if (this.status.installMode !== "automatic" || this.status.phase !== "downloaded") return;
    this.options.driver.installUpdate();
  }
  /**
   * 取消正在进行的更新下载，回到可重新下载状态，方便用户重新点击升级。
   * 自动安装模式通过驱动取消 electron-updater 下载；手动 DMG 模式通过
   * AbortSignal 中断分片或单流下载，已写入的断点续传记录会保留。
   * @returns 取消操作完成后的当前状态。
   * @author zhenghq
   */
  async cancelDownload() {
    if (this.status.phase !== "downloading") return this.getStatus();
    this.options.driver.cancelDownload();
    this.manualDownloadAbort?.abort();
    this.manualDownloadAbort = void 0;
    this.setStatus({
      phase: "available",
      message: this.currentTranslator().t("update.cancelled"),
      progress: void 0
    });
    return this.getStatus();
  }
  /**
   * 在系统默认浏览器中打开 GitHub Release 页面。
   * @returns 页面打开完成后的 Promise。
   * @author zhenghq
   */
  async openReleasePage() {
    await this.options.openExternal(this.options.releaseUrl);
  }
  /**
   * 处理检测到新版本事件。
   * @param info 新版本信息。
   * @returns 无返回值。
   * @author zhenghq
   */
  handleAvailable(info) {
    this.applyManualDownloadTarget(info);
    const decision = this.decide(info);
    const translator = this.currentTranslator();
    const message = (this.status.installMode === "automatic" ? translator.t("update.available", { version: info.version }) : translator.t("update.availableManual", { version: info.version })) + formatChecksumNotice(info.checksumStatus, translator);
    this.setStatus({
      phase: "available",
      latestVersion: info.version,
      message,
      progress: void 0,
      manualDownloadAvailable: this.options.manualUpdate && info.manualDownloadUrl ? true : void 0,
      checksumStatus: info.checksumStatus,
      updateReason: "higher-version",
      updateAction: this.status.installMode === "automatic" ? "automatic-download" : this.resolveManualUpdateAction(info),
      ...this.buildIdentityFields(info, decision)
    });
  }
  /**
   * 记录本次更新可用的手动 DMG 下载目标和完整性信息。
   * @param info 驱动上报的更新信息。
   * @returns 无返回值。
   * @author zhenghq
   */
  applyManualDownloadTarget(info) {
    this.manualDownloadUrl = info.manualDownloadUrl;
    this.manualDownloadIntegrity = info.manualDownloadSha512 || info.manualDownloadSize ? {
      ...info.manualDownloadSha512 ? { sha512: info.manualDownloadSha512 } : {},
      ...info.manualDownloadSize ? { size: info.manualDownloadSize } : {}
    } : void 0;
  }
  /**
   * 判断当前平台对本次更新可执行的手动交付动作。
   * @param info 驱动上报的更新信息。
   * @returns 具备受校验 DMG 目标时返回手动下载动作，否则返回打开 Release 动作。
   * @author zhenghq
   */
  resolveManualUpdateAction(info) {
    return this.options.manualUpdate && info.manualDownloadUrl ? "verified-manual-download" : "open-release";
  }
  /**
   * 使用纯函数决策器比较版本号与构建身份。
   * @param info 驱动上报的更新信息。
   * @returns 更新判断结果。
   * @author zhenghq
   */
  decide(info) {
    return decideUpdateAvailability({
      currentVersion: this.status.currentVersion,
      remoteVersion: info.version,
      ...info.localBuild ? { localBuild: info.localBuild } : {},
      ...info.remoteBuild ? { remoteBuild: info.remoteBuild } : {}
    });
  }
  /**
   * 生成构建标识的脱敏展示字段。
   * @param info 驱动上报的更新信息。
   * @param decision 更新判断结果。
   * @returns 可直接合并进状态的构建标识字段。
   * @author zhenghq
   */
  buildIdentityFields(info, decision) {
    const comparable = Boolean(decision.localBuildId && decision.remoteBuildId);
    return {
      localBuildLabel: formatBuildIdLabel(decision.localBuildId ?? info.localBuild?.buildId) || void 0,
      remoteBuildLabel: formatBuildIdLabel(decision.remoteBuildId ?? info.remoteBuild?.buildId) || void 0,
      buildMetadataAvailable: comparable
    };
  }
  /**
   * 处理当前已经是最新版本事件。
   * @param info 当前远程版本信息。
   * @returns 无返回值。
   * @author zhenghq
   */
  handleNotAvailable(info) {
    const translator = this.currentTranslator();
    const decision = this.decide(info);
    const checksumNeedsUpdate = info.checksumStatus === "missing" || info.checksumStatus === "mismatch";
    const sameVersionNewBuild = decision.outcome === "same-version-new-build";
    const needsUpdate = sameVersionNewBuild || checksumNeedsUpdate;
    const identityFields = this.buildIdentityFields(info, decision);
    if (needsUpdate) {
      this.applyManualDownloadTarget(info);
    } else {
      this.manualDownloadUrl = void 0;
      this.manualDownloadIntegrity = void 0;
    }
    this.setStatus({
      phase: needsUpdate ? "available" : "not-available",
      latestVersion: info.version || this.status.currentVersion,
      message: sameVersionNewBuild ? this.formatSameVersionMessage(info, decision) : checksumNeedsUpdate ? info.checksumStatus === "mismatch" ? translator.t("update.checksumNeedsUpdateMismatch") : translator.t("update.checksumNeedsUpdateMissing") : identityFields.buildMetadataAvailable ? translator.t("update.notAvailableWithBuild", {
        build: identityFields.localBuildLabel ?? ""
      }) : translator.t("update.notAvailable"),
      progress: void 0,
      manualDownloadAvailable: needsUpdate && this.options.manualUpdate && info.manualDownloadUrl ? true : void 0,
      checksumStatus: info.checksumStatus,
      updateReason: sameVersionNewBuild ? "same-version-new-build" : void 0,
      updateAction: needsUpdate ? this.resolveManualUpdateAction(info) : void 0,
      ...identityFields
    });
  }
  /**
   * 组织同版本新构建的用户提示文案。
   * @param info 驱动上报的更新信息。
   * @param decision 更新判断结果。
   * @returns 面向用户的同版本新构建说明。
   * @author zhenghq
   */
  formatSameVersionMessage(info, decision) {
    const version = info.version || this.status.currentVersion;
    const localLabel = formatBuildIdLabel(decision.localBuildId);
    const remoteLabel = formatBuildIdLabel(decision.remoteBuildId);
    const translator = this.currentTranslator();
    const action = this.resolveManualUpdateAction(info) === "verified-manual-download" ? translator.t("update.sameVersion.downloadAction") : translator.t("update.sameVersion.releaseAction");
    return translator.t("update.sameVersion.message", {
      version,
      localBuild: localLabel,
      remoteBuild: remoteLabel,
      action
    }) + formatChecksumNotice(info.checksumStatus, translator);
  }
  /**
   * 处理更新包下载进度事件。
   * @param progress 当前下载进度。
   * @returns 无返回值。
   * @author zhenghq
   */
  handleProgress(progress) {
    if (this.status.phase !== "downloading") return;
    this.setStatus({
      phase: "downloading",
      message: this.currentTranslator().t("update.downloading", {
        percent: Math.max(0, Math.min(100, progress.percent)).toFixed(1)
      }),
      progress: { ...progress }
    });
  }
  /**
   * 处理更新包下载完成事件。
   * @param info 已下载版本信息。
   * @returns 无返回值。
   * @author zhenghq
   */
  handleDownloaded(info) {
    if (this.status.phase !== "downloading") return;
    this.setStatus({
      phase: "downloaded",
      latestVersion: info.version,
      message: this.currentTranslator().t("update.downloaded", { version: info.version }),
      progress: this.status.progress ? { ...this.status.progress, percent: 100 } : { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 }
    });
  }
  /**
   * 为无法安全自动安装的平台打开 GitHub Release 手动更新入口。
   * @returns 操作完成后的当前状态。
   * @author zhenghq
   */
  async openReleaseForManualUpdate() {
    if (this.status.phase === "checking" || this.status.phase === "downloading") {
      return this.getStatus();
    }
    await this.openReleasePage();
    this.setStatus({
      message: this.currentTranslator().t("update.openRelease")
    });
    return this.getStatus();
  }
  /**
   * 下载并打开手动 macOS 更新包；缺少 DMG 地址时回退到 GitHub Release。
   * @returns 操作完成后的当前状态。
   * @author zhenghq
   */
  async downloadManualMacUpdate() {
    if (this.status.phase === "checking" || this.status.phase === "downloading") {
      return this.getStatus();
    }
    const version = this.status.latestVersion;
    if (!version || !this.manualDownloadUrl || !this.options.manualUpdate) {
      await this.openReleasePage();
      this.setStatus({
        message: this.currentTranslator().t("update.noDmgFallback")
      });
      return this.getStatus();
    }
    this.setStatus({
      phase: "downloading",
      message: this.currentTranslator().t("update.manualDmgDownloading"),
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      manualDownloadPath: void 0
    });
    try {
      const abortController = new AbortController();
      this.manualDownloadAbort = abortController;
      const downloadPromise = this.options.manualUpdate.downloadAndOpen(
        this.manualDownloadUrl,
        version,
        (progress) => this.handleProgress(progress),
        this.manualDownloadIntegrity,
        abortController.signal
      );
      let result;
      try {
        result = await downloadPromise;
      } finally {
        if (this.manualDownloadAbort === abortController) {
          this.manualDownloadAbort = void 0;
        }
      }
      if (this.status.phase !== "downloading") return this.getStatus();
      const translator = this.currentTranslator();
      const integrityNotice = result.verified ? "" : translator.t("update.integrityNoticeMissing");
      this.setStatus({
        phase: "manual-downloaded",
        message: translator.t("update.manualDownloaded") + integrityNotice,
        progress: this.status.progress ? { ...this.status.progress, percent: 100 } : { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
        manualDownloadPath: result.path
      });
    } catch (error2) {
      if (this.status.phase !== "downloading") return this.getStatus();
      this.handleError(error2);
    }
    return this.getStatus();
  }
  /**
  * 将底层异常转换为设置页可展示的错误状态。
   * @param error 自动更新异常。
   * @returns 无返回值。
   * @author zhenghq
  */
  handleError(error2) {
    const rawMessage = error2 instanceof Error ? error2.message : String(error2);
    const signatureValidationFailed = isMacOSCodeSignatureValidationError(rawMessage);
    const errorPhase = this.status.phase;
    this.setStatus({
      phase: "error",
      installMode: signatureValidationFailed ? "manual" : this.status.installMode,
      message: formatUpdateErrorMessage(error2, this.currentTranslator(), errorPhase),
      progress: void 0,
      manualDownloadAvailable: signatureValidationFailed && this.options.manualUpdate && this.manualDownloadUrl ? true : this.status.manualDownloadAvailable
    });
  }
  /**
   * 合并状态补丁、复制可变数据并通知所有窗口。
   * @param patch 自动更新状态补丁。
   * @returns 无返回值。
   * @author zhenghq
   */
  setStatus(patch) {
    this.status = {
      ...this.status,
      ...patch,
      progress: patch.progress ? { ...patch.progress } : patch.progress === void 0 && "progress" in patch ? void 0 : this.status.progress
    };
    this.options.onStatusChanged(this.getStatus());
  }
}
const silentUpdateLogger = { warn: () => void 0 };
const RELEASE_URL = "https://github.com/zhq734/translation/releases/latest";
const RELEASE_DOWNLOAD_BASE_URL = `${RELEASE_URL}/download/`;
const RELEASE_CHECKSUMS_URL = `${RELEASE_DOWNLOAD_BASE_URL}SHA256SUMS`;
const RELEASE_API_URL = "https://api.github.com/repos/zhq734/translation/releases/latest";
const execFileAsync$1 = node_util.promisify(node_child_process.execFile);
class ElectronUpdateDriver {
  /**
   * 创建 electron-updater 适配器。
   * @param localBuild 当前安装包内嵌的本地构建元数据；缺失时为 undefined。
   * @param logger electron-updater 日志转发器；默认静默。
   * @author zhenghq
   */
  constructor(localBuild, logger = silentUpdateLogger) {
    this.localBuild = localBuild;
    this.logger = logger;
  }
  releaseValidation = Promise.resolve();
  /** 当前下载使用的取消令牌；每次重新发起下载时更换。 */
  downloadCancellation;
  /**
   * 配置下载策略并转发 electron-updater 生命周期事件。
   * @param listeners 自动更新事件监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  initialize(listeners) {
    electronUpdater.autoUpdater.logger = {
      info: () => void 0,
      warn: (message) => this.logger.warn(message),
      error: (message) => this.logger.warn(message)
    };
    electronUpdater.autoUpdater.autoDownload = false;
    electronUpdater.autoUpdater.autoInstallOnAppQuit = false;
    if (process.platform === "win32" || process.platform === "linux") {
      electronUpdater.autoUpdater.disableDifferentialDownload = true;
    }
    if (process.platform === "win32") {
      electronUpdater.autoUpdater.disableWebInstaller = true;
    }
    if (process.platform === "win32" || process.platform === "linux") {
      installParallelUpdateDownload(electronUpdater.autoUpdater, updateDownloadFetch);
    }
    electronUpdater.autoUpdater.allowPrerelease = false;
    electronUpdater.autoUpdater.fullChangelog = false;
    electronUpdater.autoUpdater.on("checking-for-update", listeners.checking);
    electronUpdater.autoUpdater.on("update-available", (info) => {
      this.releaseValidation = this.resolveReleaseContext(info).then((context) => listeners.available(context));
    });
    electronUpdater.autoUpdater.on("update-not-available", (info) => {
      this.releaseValidation = this.resolveReleaseContext(info).then((context) => listeners.notAvailable(context));
    });
    electronUpdater.autoUpdater.on("download-progress", (progress) => listeners.progress(progress));
    electronUpdater.autoUpdater.on("update-downloaded", (info) => listeners.downloaded(info));
    electronUpdater.autoUpdater.on("error", (error2) => listeners.error(error2));
  }
  /**
   * 请求 electron-updater 检查 GitHub Release。
   * @returns 检查请求完成后的 Promise。
   * @author zhenghq
   */
  async checkForUpdates() {
    await electronUpdater.autoUpdater.checkForUpdates();
    await this.releaseValidation;
  }
  /**
   * 读取一次 GitHub Release 资产快照，合并 SHA256SUMS 校验与远程构建身份校验结果。
   * 辅助构建元数据失败只会导致该项不可用，不影响 SemVer 更新结果。
   * @param info electron-updater 返回的更新信息。
   * @returns 更新驱动上报给状态管理器的完整上下文。
   * @author zhenghq
   */
  async resolveReleaseContext(info) {
    const manualTarget = resolveMacOSManualDmgTarget(info);
    const assets = await this.fetchReleaseAssets();
    const checksumStatus = await this.validateChecksums(info, assets);
    const remoteBuild = await this.resolveRemoteBuild(info, assets);
    return {
      version: info.version,
      manualDownloadUrl: manualTarget?.url,
      manualDownloadSha512: manualTarget?.sha512,
      manualDownloadSize: manualTarget?.size,
      checksumStatus,
      ...this.localBuild ? { localBuild: this.localBuild } : {},
      ...remoteBuild.ok ? { remoteBuild: remoteBuild.metadata } : { buildMetadataUnavailableReason: remoteBuild.reason }
    };
  }
  /**
   * 获取最新 Release 的资产快照，供摘要校验与构建元数据校验共同复用。
   * @returns Release 资产列表；请求失败时返回 undefined。
   * @author zhenghq
   */
  async fetchReleaseAssets() {
    try {
      const response = await translationFetch(RELEASE_API_URL, {
        headers: { accept: "application/vnd.github+json" }
      });
      if (!response.ok) return void 0;
      const assets = (await response.json()).assets;
      return Array.isArray(assets) ? assets : void 0;
    } catch {
      return void 0;
    }
  }
  /**
   * 使用已获取的资产快照校验安装包 SHA256SUMS。
   * @param info electron-updater 返回的更新信息。
   * @param assets Release 资产快照。
   * @returns SHA256SUMS 校验状态。
   * @author zhenghq
   */
  async validateChecksums(info, assets) {
    if (!assets) return "unreachable";
    try {
      const result = await validateReleaseChecksums({
        manifestUrl: RELEASE_CHECKSUMS_URL,
        assetNames: info.files.map((file) => file.url),
        assets,
        fetch: async (url) => translationFetch(url)
      });
      return result.status;
    } catch {
      return "unreachable";
    }
  }
  /**
   * 下载并校验 Release 中的远程构建元数据。
   * @param info electron-updater 返回的更新信息。
   * @param assets Release 资产快照。
   * @returns 远程构建元数据校验结果。
   * @author zhenghq
   */
  async resolveRemoteBuild(info, assets) {
    if (!assets) return { ok: false, reason: "download-failed" };
    return fetchRemoteBuildMetadata({
      assets,
      expectedVersion: info.version,
      fallbackDownloadBaseUrl: RELEASE_DOWNLOAD_BASE_URL,
      fetch: async (url, init) => translationFetch(url, init)
    });
  }
  /**
   * 下载 electron-updater 已发现的更新包。
   * @returns 下载完成后的 Promise。
   * @author zhenghq
   */
  async downloadUpdate() {
    this.downloadCancellation = new out.CancellationToken();
    try {
      await electronUpdater.autoUpdater.downloadUpdate(this.downloadCancellation);
    } finally {
      this.downloadCancellation = void 0;
    }
  }
  /**
   * 取消 electron-updater 正在进行的更新下载；未在下载时为空操作。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelDownload() {
    this.downloadCancellation?.cancel();
  }
  /**
   * 退出应用、安装更新并在安装完成后重新启动。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate() {
    electronUpdater.autoUpdater.quitAndInstall(false, true);
  }
}
function resolveMacOSManualDmgTarget(info) {
  if (process.platform !== "darwin") return void 0;
  return resolveManualMacDmgTarget(info.files, process.arch, RELEASE_DOWNLOAD_BASE_URL);
}
async function isMacOSApplicationSigned(executablePath) {
  const appBundlePath = resolveMacOSAppBundlePath(executablePath);
  if (!appBundlePath) return false;
  try {
    await execFileAsync$1("/usr/bin/codesign", ["--verify", "--deep", "--strict", appBundlePath]);
    const { stderr } = await execFileAsync$1(
      "/usr/bin/codesign",
      ["-dv", "--verbose=4", appBundlePath]
    );
    return isMacOSDeveloperIdApplicationSignature(stderr);
  } catch {
    return false;
  }
}
async function createApplicationUpdateManager(onStatusChanged, logger) {
  const macSigned = process.platform === "darwin" && electron.app.isPackaged ? await isMacOSApplicationSigned(process.execPath) : false;
  const installMode = resolveUpdateInstallMode(
    process.platform,
    electron.app.isPackaged,
    Boolean(process.env["APPIMAGE"]),
    macSigned,
    isMacOSDiskImageExecution(process.platform, process.execPath)
  );
  const localBuild = await readLocalBuildMetadata({
    packaged: electron.app.isPackaged,
    resourcesPath: process.resourcesPath,
    expectedVersion: electron.app.getVersion()
  });
  return new UpdateManager({
    driver: new ElectronUpdateDriver(localBuild, logger),
    currentVersion: electron.app.getVersion(),
    enabled: electron.app.isPackaged,
    installMode,
    isOnline: () => electron.net.isOnline(),
    releaseUrl: RELEASE_URL,
    manualUpdate: process.platform === "darwin" ? createManualMacUpdateService({
      downloadsDirectory: electron.app.getPath("downloads"),
      fetch: translationFetch,
      openPath: (path) => electron.shell.openPath(path)
    }) : void 0,
    openExternal: async (url) => {
      await electron.shell.openExternal(url);
    },
    onStatusChanged
  });
}
const MACOS_APPLICATION_PATH = "/Applications/划词翻译.app";
const XATTR_COMMAND = "/usr/bin/xattr";
const execFileAsync = node_util.promisify(node_child_process.execFile);
async function runXattrCommand(command, args) {
  await execFileAsync(command, args);
}
function formatCommandError(error2) {
  const message = error2 instanceof Error ? error2.message : String(error2);
  return message.replace(/\s+/gu, " ").trim().slice(0, 240) || translateMain("macQuarantine.unknownError");
}
function isAllowedMacOSApplicationPath(platform, applicationPath) {
  return platform === "darwin" && applicationPath === MACOS_APPLICATION_PATH;
}
async function removeMacOSApplicationQuarantine(options = {}) {
  const platform = options.platform ?? process.platform;
  const applicationPath = options.applicationPath ?? MACOS_APPLICATION_PATH;
  const runCommand = options.runCommand ?? runXattrCommand;
  const manualCommand = `xattr -dr com.apple.quarantine "${MACOS_APPLICATION_PATH}"`;
  if (platform !== "darwin") {
    return { ok: false, message: translateMain("macQuarantine.unsupportedPlatform") };
  }
  if (!isAllowedMacOSApplicationPath(platform, applicationPath)) {
    return {
      ok: false,
      message: translateMain("macQuarantine.pathNotAllowed", {
        path: MACOS_APPLICATION_PATH
      })
    };
  }
  try {
    await runCommand(XATTR_COMMAND, ["-dr", "com.apple.quarantine", applicationPath]);
    return {
      ok: true,
      message: translateMain("macQuarantine.success", {
        path: MACOS_APPLICATION_PATH
      })
    };
  } catch (error2) {
    const errorMessage = formatCommandError(error2);
    if (/No such xattr/iu.test(errorMessage)) {
      return { ok: true, message: translateMain("macQuarantine.noAttribute") };
    }
    return {
      ok: false,
      message: translateMain("macQuarantine.failed", {
        message: errorMessage,
        command: manualCommand
      })
    };
  }
}
const MAX_OCR_PIXELS = 21e5;
function lumaOf(r, g, b) {
  return Math.round(r * 0.299 + g * 0.587 + b * 0.114);
}
function cropRgba(image, rect) {
  const x = Math.max(0, Math.min(Math.round(rect.x), image.width));
  const y = Math.max(0, Math.min(Math.round(rect.y), image.height));
  const width = Math.max(0, Math.min(Math.round(rect.width), image.width - x));
  const height = Math.max(0, Math.min(Math.round(rect.height), image.height - y));
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = ((y + row) * image.width + x) * 4;
    const targetOffset = row * width * 4;
    data.set(image.data.subarray(sourceOffset, sourceOffset + width * 4), targetOffset);
  }
  return { width, height, data };
}
function sampleBilinear(image, x, y) {
  const cx = Math.min(Math.max(x, 0), image.width - 1);
  const cy = Math.min(Math.max(y, 0), image.height - 1);
  const x0 = Math.min(Math.floor(cx), image.width - 1);
  const y0 = Math.min(Math.floor(cy), image.height - 1);
  const x1 = Math.min(x0 + 1, image.width - 1);
  const y1 = Math.min(y0 + 1, image.height - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const out2 = [0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel += 1) {
    const top = image.data[(y0 * image.width + x0) * 4 + channel] * (1 - fx) + image.data[(y0 * image.width + x1) * 4 + channel] * fx;
    const bottom = image.data[(y1 * image.width + x0) * 4 + channel] * (1 - fx) + image.data[(y1 * image.width + x1) * 4 + channel] * fx;
    out2[channel] = Math.round(top * (1 - fy) + bottom * fy);
  }
  return out2;
}
function resizeRgbaForOcr(image, scale = 1) {
  const safeScale = Math.min(3, Math.max(1, Number(scale) || 1));
  const sourcePixels = image.width * image.height;
  const budgetScale = sourcePixels > 0 ? Math.sqrt(MAX_OCR_PIXELS / sourcePixels) : 1;
  const targetScale = Math.min(safeScale, budgetScale);
  let width = Math.max(1, Math.round(image.width * targetScale));
  let height = Math.max(1, Math.round(image.height * targetScale));
  while (width * height > MAX_OCR_PIXELS) {
    if (width >= height) width -= 1;
    else height -= 1;
  }
  if (width === image.width && height === image.height) return image;
  const scaleX = width / image.width;
  const scaleY = height / image.height;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = sampleBilinear(
        image,
        (x + 0.5) / scaleX - 0.5,
        (y + 0.5) / scaleY - 0.5
      );
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return { width, height, data };
}
function enhanceRgbaForOcr(image) {
  const width = image.width;
  const height = image.height;
  const pixels = width * height;
  const histogram = new Array(256).fill(0);
  const lumas = new Uint8Array(pixels);
  for (let i = 0, j = 0; j < pixels; i += 4, j += 1) {
    const luma = lumaOf(image.data[i], image.data[i + 1], image.data[i + 2]);
    lumas[j] = luma;
    histogram[luma] += 1;
  }
  const percentile = (ratio) => {
    const target = Math.max(1, Math.floor(pixels * ratio));
    let seen = 0;
    for (let value = 0; value < histogram.length; value += 1) {
      seen += histogram[value];
      if (seen >= target) return value;
    }
    return 255;
  };
  const low = percentile(0.05);
  const high = Math.max(low + 32, percentile(0.95));
  const data = new Uint8Array(pixels * 4);
  for (let i = 0, j = 0; j < pixels; i += 4, j += 1) {
    const normalized = Math.min(1, Math.max(0, (lumas[j] - low) / (high - low)));
    const value = Math.min(255, Math.max(0, Math.round((normalized - 0.5) * 1.9 * 255 + 128)));
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  return { width, height, data };
}
class PngDecodeError extends Error {
  /**
   * 创建 PNG 解码错误。
   * @param message 错误描述。
   * @author zhenghq
   */
  constructor(message) {
    super(message);
    this.name = "PngDecodeError";
  }
}
const PNG_SIGNATURE$1 = [137, 80, 78, 71, 13, 10, 26, 10];
let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    }
    table[n] = c;
  }
  crcTable = table;
  return table;
}
function crc32(bytes) {
  const table = getCrcTable();
  let crc = 4294967295;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 255] ^ crc >>> 8;
  }
  return (crc ^ 4294967295) >>> 0;
}
function expandScanlines(raw, width, height, bpp) {
  const stride = width * bpp;
  const out2 = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = out2.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? out2.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowStart + 1 + x];
      const left = x >= bpp ? line[x - bpp] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= bpp ? previous[x - bpp] : 0;
      let reconstructed = 0;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + left;
          break;
        case 2:
          reconstructed = value + up;
          break;
        case 3:
          reconstructed = value + (left + up >> 1);
          break;
        case 4: {
          const predictor = left + up - upLeft;
          const diffLeft = Math.abs(predictor - left);
          const diffUp = Math.abs(predictor - up);
          const diffUpLeft = Math.abs(predictor - upLeft);
          const paeth = diffLeft <= diffUp && diffLeft <= diffUpLeft ? left : diffUp < diffUpLeft ? up : upLeft;
          reconstructed = value + paeth;
          break;
        }
        default:
          throw new PngDecodeError(translateMain("ocr.error.pngUnsupportedFilter", { filter }));
      }
      line[x] = reconstructed & 255;
    }
  }
  return out2;
}
function parseChunks(buffer) {
  if (buffer.length < 8 || PNG_SIGNATURE$1.some((byte, i) => buffer[i] !== byte)) {
    throw new PngDecodeError(translateMain("ocr.error.pngInvalidSignature"));
  }
  const header = { width: 0, height: 0, bitDepth: 0, colorType: 0 };
  const idatParts = [];
  let offset = 8;
  while (offset < buffer.length) {
    if (buffer.length < offset + 8) {
      throw new PngDecodeError(translateMain("ocr.error.pngChunkLengthIncomplete"));
    }
    const length = Number((buffer[offset] << 24 | buffer[offset + 1] << 16 | buffer[offset + 2] << 8 | buffer[offset + 3]) >>> 0);
    const type = String.fromCharCode(buffer[offset + 4], buffer[offset + 5], buffer[offset + 6], buffer[offset + 7]);
    const dataStart = offset + 8;
    if (buffer.length < dataStart + length + 4) {
      throw new PngDecodeError(translateMain("ocr.error.pngChunkOutOfBounds"));
    }
    const data = buffer.subarray(dataStart, dataStart + length);
    if (type === "IHDR") {
      header.width = Number((data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0);
      header.height = Number((data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7]) >>> 0);
      header.bitDepth = data[8];
      header.colorType = data[9];
      if (data[12] !== 0) {
        throw new PngDecodeError(translateMain("ocr.error.pngInterlacedUnsupported"));
      }
    } else if (type === "IDAT") {
      idatParts.push(data);
    }
    offset = dataStart + length + 4;
  }
  const idatLength = idatParts.reduce((sum, part) => sum + part.length, 0);
  const idat = new Uint8Array(idatLength);
  let cursor = 0;
  for (const part of idatParts) {
    idat.set(part, cursor);
    cursor += part.length;
  }
  return { header, idat };
}
function toEightBits(value, bitDepth) {
  return bitDepth === 16 ? value >> 8 : value;
}
function decodePng(buffer) {
  const { header, idat } = parseChunks(buffer);
  const { width, height, bitDepth, colorType } = header;
  if (!width || !height) throw new PngDecodeError(translateMain("ocr.error.pngInvalidDimensions"));
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new PngDecodeError(translateMain("ocr.error.pngUnsupportedBitDepth", { bitDepth }));
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : -1;
  if (channels < 0) {
    throw new PngDecodeError(translateMain("ocr.error.pngUnsupportedColorType", { colorType }));
  }
  const bytesPerPixel = channels * (bitDepth / 8);
  const stride = width * bytesPerPixel;
  const inflated = new Uint8Array(node_zlib.inflateSync(Buffer.from(idat)));
  const expected = height * (stride + 1);
  if (inflated.length < expected) {
    throw new PngDecodeError(translateMain("ocr.error.pngScanlineIncomplete"));
  }
  const raw = inflated.subarray(0, expected);
  const pixels = expandScanlines(raw, width, height, bytesPerPixel);
  const data = new Uint8Array(width * height * 4);
  const sourceStride = width * bytesPerPixel;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = y * sourceStride + x * bytesPerPixel;
      const target = (y * width + x) * 4;
      if (colorType === 0) {
        const gray = toEightBits(pixels[source], bitDepth);
        data[target] = gray;
        data[target + 1] = gray;
        data[target + 2] = gray;
        data[target + 3] = 255;
      } else if (colorType === 2) {
        data[target] = toEightBits(pixels[source], bitDepth);
        data[target + 1] = toEightBits(pixels[source + 1], bitDepth);
        data[target + 2] = toEightBits(pixels[source + 2], bitDepth);
        data[target + 3] = 255;
      } else if (colorType === 4) {
        data[target] = toEightBits(pixels[source], bitDepth);
        data[target + 1] = data[target];
        data[target + 2] = data[target];
        data[target + 3] = toEightBits(pixels[source + 1], bitDepth);
      } else {
        data[target] = toEightBits(pixels[source], bitDepth);
        data[target + 1] = toEightBits(pixels[source + 1], bitDepth);
        data[target + 2] = toEightBits(pixels[source + 2], bitDepth);
        data[target + 3] = toEightBits(pixels[source + 3], bitDepth);
      }
    }
  }
  return { width, height, data };
}
function writeUint32Be(out2, offset, value) {
  out2[offset] = value >>> 24 & 255;
  out2[offset + 1] = value >>> 16 & 255;
  out2[offset + 2] = value >>> 8 & 255;
  out2[offset + 3] = value & 255;
}
function writeChunk(out2, cursor, type, data) {
  const length = data.length;
  writeUint32Be(out2, cursor, length);
  out2[cursor + 4] = type.charCodeAt(0);
  out2[cursor + 5] = type.charCodeAt(1);
  out2[cursor + 6] = type.charCodeAt(2);
  out2[cursor + 7] = type.charCodeAt(3);
  out2.set(data, cursor + 8);
  const crc = crc32(out2.subarray(cursor + 4, cursor + 8 + length));
  writeUint32Be(out2, cursor + 8 + length, crc);
  return cursor + 12 + length;
}
function encodePng(image, options = {}) {
  const { width, height, data } = image;
  if (!width || !height || data.length < width * height * 4) {
    throw new PngDecodeError(translateMain("ocr.error.pngEncodeInvalidImage"));
  }
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const dest = y * (stride + 1);
    raw[dest] = 0;
    raw.set(data.subarray(y * stride, y * stride + stride), dest + 1);
  }
  const level = options.level ?? 1;
  const idat = node_zlib.deflateSync(raw, { level });
  const ihdr = new Uint8Array(13);
  writeUint32Be(ihdr, 0, width);
  writeUint32Be(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const total = 8 + (12 + 13) + (12 + idat.length) + 12;
  const out2 = new Uint8Array(total);
  out2.set(PNG_SIGNATURE$1, 0);
  let cursor = 8;
  cursor = writeChunk(out2, cursor, "IHDR", ihdr);
  cursor = writeChunk(out2, cursor, "IDAT", idat);
  writeChunk(out2, cursor, "IEND", new Uint8Array(0));
  return Buffer.from(out2.buffer, out2.byteOffset, out2.byteLength);
}
class ScreenCaptureError extends Error {
  /** 错误分类码。 */
  code;
  /**
   * 创建屏幕采集错误。
   * @param code 错误分类码。
   * @param message 面向用户的描述。
   * @author zhenghq
   */
  constructor(code, message) {
    super(message);
    this.name = "ScreenCaptureError";
    this.code = code;
  }
}
function intersectBounds(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return {
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1)
  };
}
function getDisplayForBounds(bounds, deps) {
  const point = {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  };
  return deps.getDisplayNearestPoint(point) || deps.getPrimaryDisplay();
}
function computeCropRect(bounds, displayBounds, imageWidth, imageHeight) {
  const clipped = intersectBounds(bounds, displayBounds);
  if (clipped.width < 4 || clipped.height < 4) {
    throw new ScreenCaptureError("out-of-bounds", translateMain("capture.error.selectionOutOfBounds"));
  }
  const scaleX = displayBounds.width > 0 ? imageWidth / displayBounds.width : 1;
  const scaleY = displayBounds.height > 0 ? imageHeight / displayBounds.height : 1;
  const rect = {
    x: Math.max(0, Math.round((clipped.x - displayBounds.x) * scaleX)),
    y: Math.max(0, Math.round((clipped.y - displayBounds.y) * scaleY)),
    width: Math.max(1, Math.round(clipped.width * scaleX)),
    height: Math.max(1, Math.round(clipped.height * scaleY))
  };
  rect.width = Math.min(rect.width, imageWidth - rect.x);
  rect.height = Math.min(rect.height, imageHeight - rect.y);
  return rect;
}
function resolveCroppedRectForWindows(bounds, displayBounds, imageWidth, imageHeight) {
  return computeCropRect(bounds, displayBounds, imageWidth, imageHeight);
}
function pickDisplaySource(sources, displayId) {
  const byId = sources.find((source) => String(source.display_id ?? "") === String(displayId));
  if (byId) return byId;
  const nonEmpty = sources.find((source) => source.thumbnail && !source.thumbnail.isEmpty());
  return nonEmpty ?? sources[0] ?? null;
}
async function captureRegionAsPng(bounds, options = {}, deps) {
  const display = getDisplayForBounds(bounds, deps);
  const scaleFactor = display.scaleFactor || 1;
  const thumbnailSize = {
    width: Math.max(1, Math.round(display.bounds.width * scaleFactor)),
    height: Math.max(1, Math.round(display.bounds.height * scaleFactor))
  };
  const sources = await deps.getSources({ types: ["screen"], thumbnailSize });
  if (!sources.length) {
    throw new ScreenCaptureError(
      (deps.platform ?? process.platform) === "darwin" ? "permission" : "no-source",
      translateMain("capture.error.screenCaptureFailed")
    );
  }
  const source = pickDisplaySource(sources, display.id);
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    const code = (deps.platform ?? process.platform) === "darwin" ? "permission" : "no-source";
    throw new ScreenCaptureError(
      code,
      code === "permission" ? translateMain("capture.error.screenRecordingPermissionRequired") : translateMain("capture.error.screenCaptureFailed")
    );
  }
  const fullImage = decodePng(source.thumbnail.toPNG());
  const cropRect = computeCropRect(bounds, display.bounds, fullImage.width, fullImage.height);
  const cropped = cropRgba(fullImage, cropRect);
  const scaled = resizeRgbaForOcr(cropped, options.ocrScale ?? 1);
  return {
    png: encodePng(scaled),
    sourceSize: { width: cropped.width, height: cropped.height },
    ocrSize: { width: scaled.width, height: scaled.height },
    displayId: display.id
  };
}
const WINDOWS_GDI_SOURCE_PREFIX = "windows-gdi";
function forceOpaqueBgra(bgra) {
  for (let i = 3; i < bgra.length; i += 4) {
    bgra[i] = 255;
  }
  return bgra;
}
function cropBgraSelectionPng(bgra, width, height, source, bounds, snapshotBounds) {
  const rect = resolveSnapshotCropRect(source, bounds, snapshotBounds, width, height);
  const selection = new Uint8Array(rect.width * rect.height * 4);
  let out2 = 0;
  for (let y = 0; y < rect.height; y += 1) {
    let src2 = ((rect.y + y) * width + rect.x) * 4;
    for (let x = 0; x < rect.width; x += 1) {
      selection[out2] = bgra[src2 + 2];
      selection[out2 + 1] = bgra[src2 + 1];
      selection[out2 + 2] = bgra[src2];
      selection[out2 + 3] = 255;
      out2 += 4;
      src2 += 4;
    }
  }
  return encodeOcrSelectionPng({ width: rect.width, height: rect.height, data: selection }, 1);
}
function resolveSnapshotCropRect(source, bounds, snapshotBounds, imageWidth, imageHeight) {
  return source.startsWith(WINDOWS_GDI_SOURCE_PREFIX) ? resolveCroppedRectForWindows(bounds, snapshotBounds, imageWidth, imageHeight) : computeCropRect(bounds, snapshotBounds, imageWidth, imageHeight);
}
function encodeOcrSelectionPng(selection, ocrScale) {
  const scaled = resizeRgbaForOcr(selection, ocrScale);
  return encodePng(scaled);
}
const WIN32_PROTOTYPES = {
  SetProcessDpiAwarenessContext: "bool __stdcall SetProcessDpiAwarenessContext(void *value)",
  SetProcessDPIAware: "bool __stdcall SetProcessDPIAware()",
  GetDC: "HDC __stdcall GetDC(HWND hwnd)",
  ReleaseDC: "int __stdcall ReleaseDC(HWND hwnd, HDC hdc)",
  CreateCompatibleDC: "HDC __stdcall CreateCompatibleDC(HDC hdc)",
  CreateCompatibleBitmap: "HBITMAP __stdcall CreateCompatibleBitmap(HDC hdc, int width, int height)",
  SelectObject: "HGDIOBJ __stdcall SelectObject(HDC hdc, HGDIOBJ obj)",
  DeleteObject: "bool __stdcall DeleteObject(HGDIOBJ obj)",
  DeleteDC: "bool __stdcall DeleteDC(HDC hdc)",
  BitBlt: "bool __stdcall BitBlt(HDC hdcDest, int xDest, int yDest, int width, int height, HDC hdcSrc, int xSrc, int ySrc, DWORD rop)",
  GetDIBits: "int __stdcall GetDIBits(HDC hdc, HBITMAP hbm, uint start, uint cLines, void *lpvBits, BITMAPINFO *lpbi, uint usage)"
};
const BITMAPINFO_FIELDS = {
  biSize: "uint32",
  biWidth: "int32",
  biHeight: "int32",
  biPlanes: "uint16",
  biBitCount: "uint16",
  biCompression: "uint32",
  biSizeImage: "uint32",
  biXPelsPerMeter: "int32",
  biYPelsPerMeter: "int32",
  biClrUsed: "uint32",
  biClrImportant: "uint32"
};
let koffiModule = null;
let koffiLoadErrorDetail = null;
let koffiLoadFailedAt = 0;
let koffiBindingClock = () => Date.now();
const KOFFI_BINDING_RETRY_INTERVAL_MS = 1e4;
const registeredKoffiTypes = /* @__PURE__ */ new Map();
let registeredKoffiModule = null;
function registerKoffiTypeOnce(koffi, name, register) {
  if (registeredKoffiModule !== koffi) {
    registeredKoffiTypes.clear();
    registeredKoffiModule = koffi;
  }
  if (registeredKoffiTypes.has(name)) return registeredKoffiTypes.get(name);
  const registered = register();
  registeredKoffiTypes.set(name, registered);
  return registered;
}
function buildBitmapInfo(width, height) {
  return {
    biSize: 40,
    biWidth: width,
    biHeight: -height,
    biPlanes: 1,
    biBitCount: 32,
    biCompression: 0,
    biSizeImage: width * height * 4,
    biXPelsPerMeter: 0,
    biYPelsPerMeter: 0,
    biClrUsed: 0,
    biClrImportant: 0
  };
}
function getKoffiGdiCapture(loadKoffi) {
  if (koffiModule) return koffiModule;
  if (koffiLoadErrorDetail && koffiBindingClock() - koffiLoadFailedAt < KOFFI_BINDING_RETRY_INTERVAL_MS) {
    throw new Error(
      translateMain("capture.error.gdiBindingLoadFailed", {
        interval: KOFFI_BINDING_RETRY_INTERVAL_MS,
        detail: koffiLoadErrorDetail
      })
    );
  }
  try {
    const koffi = loadKoffi ? loadKoffi() : require("koffi");
    const user32 = koffi.load("user32.dll");
    const gdi32 = koffi.load("gdi32.dll");
    registerKoffiTypeOnce(koffi, "HWND", () => koffi.pointer("HWND", koffi.opaque()));
    registerKoffiTypeOnce(koffi, "HDC", () => koffi.pointer("HDC", koffi.opaque()));
    registerKoffiTypeOnce(koffi, "HBITMAP", () => koffi.pointer("HBITMAP", koffi.opaque()));
    registerKoffiTypeOnce(koffi, "HGDIOBJ", () => koffi.pointer("HGDIOBJ", koffi.opaque()));
    registerKoffiTypeOnce(koffi, "DWORD", () => koffi.alias("DWORD", "uint32_t"));
    registerKoffiTypeOnce(koffi, "BITMAPINFO", () => koffi.struct("BITMAPINFO", BITMAPINFO_FIELDS));
    registerKoffiTypeOnce(
      koffi,
      "DPI_AWARENESS_CONTEXT",
      () => koffi.pointer("DPI_AWARENESS_CONTEXT", koffi.opaque())
    );
    const SetProcessDpiAwarenessContext = user32.func(WIN32_PROTOTYPES.SetProcessDpiAwarenessContext);
    const SetProcessDPIAware = user32.func(WIN32_PROTOTYPES.SetProcessDPIAware);
    const GetDC = user32.func(WIN32_PROTOTYPES.GetDC);
    const ReleaseDC = user32.func(WIN32_PROTOTYPES.ReleaseDC);
    const CreateCompatibleDC = gdi32.func(WIN32_PROTOTYPES.CreateCompatibleDC);
    const CreateCompatibleBitmap = gdi32.func(WIN32_PROTOTYPES.CreateCompatibleBitmap);
    const SelectObject = gdi32.func(WIN32_PROTOTYPES.SelectObject);
    const DeleteObject = gdi32.func(WIN32_PROTOTYPES.DeleteObject);
    const DeleteDC = gdi32.func(WIN32_PROTOTYPES.DeleteDC);
    const BitBlt = gdi32.func(WIN32_PROTOTYPES.BitBlt);
    const GetDIBits = gdi32.func(WIN32_PROTOTYPES.GetDIBits);
    const PER_MONITOR_DPI_AWARE = koffi.as(
      -4,
      registeredKoffiTypes.get("DPI_AWARENESS_CONTEXT")
    );
    if (!SetProcessDpiAwarenessContext(PER_MONITOR_DPI_AWARE)) {
      SetProcessDPIAware();
    }
    koffiModule = async function captureGdi(x, y, width, height) {
      const hdcScreen = GetDC(null);
      if (!hdcScreen) {
        throw new Error(translateMain("capture.error.gdiGetDcFailed"));
      }
      const hdcMem = CreateCompatibleDC(hdcScreen);
      if (!hdcMem) {
        ReleaseDC(null, hdcScreen);
        throw new Error(translateMain("capture.error.gdiCreateCompatibleDcFailed"));
      }
      const hBitmap = CreateCompatibleBitmap(hdcScreen, width, height);
      if (!hBitmap) {
        DeleteDC(hdcMem);
        ReleaseDC(null, hdcScreen);
        throw new Error(translateMain("capture.error.gdiCreateCompatibleBitmapFailed"));
      }
      const hOld = SelectObject(hdcMem, hBitmap);
      const SRCCOPY = 13369376;
      const ok = BitBlt(hdcMem, 0, 0, width, height, hdcScreen, x, y, SRCCOPY);
      if (!ok) {
        SelectObject(hdcMem, hOld);
        DeleteObject(hBitmap);
        DeleteDC(hdcMem);
        ReleaseDC(null, hdcScreen);
        throw new Error(translateMain("capture.error.gdiBitBltFailed"));
      }
      const bi = buildBitmapInfo(width, height);
      const pixels = Buffer.alloc(width * height * 4);
      const scanLines = GetDIBits(hdcMem, hBitmap, 0, height, pixels, bi, 0);
      SelectObject(hdcMem, hOld);
      DeleteObject(hBitmap);
      DeleteDC(hdcMem);
      ReleaseDC(null, hdcScreen);
      if (!scanLines) {
        throw new Error(translateMain("capture.error.gdiGetDIBitsFailed"));
      }
      return {
        data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
        width,
        height
      };
    };
    koffiLoadErrorDetail = null;
    koffiLoadFailedAt = 0;
    return koffiModule;
  } catch (error2) {
    const detail = error2 instanceof Error ? error2.message : String(error2);
    koffiLoadFailedAt = koffiBindingClock();
    koffiLoadErrorDetail = detail;
    throw new Error(
      translateMain("capture.error.gdiBindingLoadFailed", {
        interval: KOFFI_BINDING_RETRY_INTERVAL_MS,
        detail
      })
    );
  }
}
function toPhysicalRect(displayBounds, scaleFactor) {
  const scale = scaleFactor || 1;
  return {
    x: Math.round(displayBounds.x * scale),
    y: Math.round(displayBounds.y * scale),
    width: Math.max(1, Math.round(displayBounds.width * scale)),
    height: Math.max(1, Math.round(displayBounds.height * scale))
  };
}
async function captureWindowsRegionPixels(displayBounds, scaleFactor, deps) {
  if (deps.platform !== "win32") {
    throw new ScreenCaptureError("no-source", translateMain("capture.error.windowsOnlyGdi"));
  }
  const rect = toPhysicalRect(displayBounds, scaleFactor);
  try {
    const captureFn = deps.captureGdi ?? getKoffiGdiCapture(deps.loadKoffi);
    const captured = await captureFn(rect.x, rect.y, rect.width, rect.height);
    return {
      width: captured.width,
      height: captured.height,
      // GetDIBits 不写 alpha（恒为 0），直接交给 Chromium 会得到全透明图像；
      // 原地补 255 而不复制，避免 4K 整屏多出一次 30MB 级别的内存拷贝。
      data: forceOpaqueBgra(captured.data)
    };
  } catch (error2) {
    const message = error2 instanceof Error ? error2.message : String(error2);
    throw new ScreenCaptureError(
      "no-source",
      translateMain("capture.error.gdiCaptureFailed", { message })
    );
  }
}
function warmUpWindowsGdiCapture(platform, loadKoffi) {
  if (platform !== "win32") return false;
  try {
    getKoffiGdiCapture(loadKoffi);
    return true;
  } catch {
    return false;
  }
}
const WINDOWS_GDI_CAPTURE_SOURCE = "windows-gdi-copyscreen";
const WINDOWS_GDI_FALLBACK_SOURCE = "windows-gdi-fallback-powershell";
async function captureWindowsOcrPreviewPreferGdi(displayBounds, scaleFactor, deps) {
  try {
    const pixels = await captureWindowsRegionPixels(displayBounds, scaleFactor, deps);
    return { kind: "pixels", pixels, source: WINDOWS_GDI_CAPTURE_SOURCE };
  } catch (gdiError) {
    const gdiMessage = gdiError instanceof Error ? gdiError.message : String(gdiError);
    deps.onGdiFailure?.(gdiMessage);
    try {
      const png = await deps.captureFallback(displayBounds, scaleFactor);
      return { kind: "png", png, source: WINDOWS_GDI_FALLBACK_SOURCE };
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new ScreenCaptureError(
        "no-source",
        translateMain("capture.error.gdiAndFallbackFailed", { gdiMessage, fallbackMessage })
      );
    }
  }
}
const CACHE_DIR_NAME = "selection-translator-ocr-cache";
const HELPER_DLL_NAME = "ScreenCaptureDpiHelper.dll";
const HELPER_EXE_NAME = "ScreenCaptureHelper.exe";
const helperExeCompileTasks = /* @__PURE__ */ new Map();
const verifiedHelperExePaths = /* @__PURE__ */ new Set();
const HELPER_CSHARP_SOURCE = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class ScreenCaptureDpiHelper {",
  '  [DllImport("user32.dll", SetLastError = true)]',
  "  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);",
  '  [DllImport("user32.dll")]',
  "  public static extern bool SetProcessDPIAware();",
  "}"
].join("\n");
const HELPER_EXE_CSHARP_SOURCE = [
  "using System;",
  "using System.Drawing;",
  "using System.Drawing.Imaging;",
  "using System.Runtime.InteropServices;",
  "using System.IO;",
  "class ScreenCaptureHelper {",
  '  [DllImport("user32.dll", SetLastError = true)]',
  "  static extern bool SetProcessDpiAwarenessContext(IntPtr value);",
  '  [DllImport("user32.dll")]',
  "  static extern bool SetProcessDPIAware();",
  "  static int Main(string[] args) {",
  "    if (args.Length < 5) {",
  '      Console.Error.WriteLine("Usage: ScreenCaptureHelper.exe <x> <y> <width> <height> <outputPath>");',
  "      return 1;",
  "    }",
  "    if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) {",
  "      SetProcessDPIAware();",
  "    }",
  "    int x = int.Parse(args[0]);",
  "    int y = int.Parse(args[1]);",
  "    int w = int.Parse(args[2]);",
  "    int h = int.Parse(args[3]);",
  "    string outPath = args[4];",
  "    using (var bmp = new Bitmap(w, h)) {",
  "      using (var g = Graphics.FromImage(bmp)) {",
  "        g.CopyFromScreen(x, y, 0, 0, new Size(w, h));",
  "      }",
  "      bmp.Save(outPath, ImageFormat.Png);",
  "    }",
  "    return 0;",
  "  }",
  "}"
].join("\n");
function escapeSingleQuote(value) {
  return value.replace(/'/g, "''");
}
function buildWindowsCaptureCommand(displayBounds, scaleFactor, outputPath, helperDllPath) {
  const scale = scaleFactor || 1;
  const x = Math.round(displayBounds.x * scale);
  const y = Math.round(displayBounds.y * scale);
  const width = Math.max(1, Math.round(displayBounds.width * scale));
  const height = Math.max(1, Math.round(displayBounds.height * scale));
  const helperPath = escapeSingleQuote(helperDllPath);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    `if (Test-Path -LiteralPath '${helperPath}') {`,
    `  try { Add-Type -Path '${helperPath}' -ErrorAction Stop; $helperLoaded = $true } catch { $helperLoaded = $false }`,
    "} else { $helperLoaded = $false }",
    "if (-not $helperLoaded) {",
    `  $dllDir = Split-Path -Parent '${helperPath}'`,
    "  if (-not (Test-Path -LiteralPath $dllDir)) { $null = New-Item -ItemType Directory -Path $dllDir -Force }",
    "  try {",
    `    Add-Type -TypeDefinition '${escapeSingleQuote(HELPER_CSHARP_SOURCE)}' -OutputAssembly '${helperPath}'`,
    `    Add-Type -Path '${helperPath}'`,
    "  } catch {",
    `    Add-Type -TypeDefinition '${escapeSingleQuote(HELPER_CSHARP_SOURCE)}'`,
    "  }",
    "}",
    "$perMonitor = [ScreenCaptureDpiHelper]::SetProcessDpiAwarenessContext([IntPtr](-4))",
    "if (-not $perMonitor) { $null = [ScreenCaptureDpiHelper]::SetProcessDPIAware() }",
    `$x = ${x}`,
    `$y = ${y}`,
    `$width = ${width}`,
    `$height = ${height}`,
    "$bitmap = New-Object System.Drawing.Bitmap($width, $height)",
    "try {",
    "  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "  try {",
    "    $graphics.CopyFromScreen([int]$x, [int]$y, 0, 0, (New-Object System.Drawing.Size([int]$width, [int]$height)))",
    "  } finally {",
    "    $graphics.Dispose()",
    "  }",
    `  $bitmap.Save('${escapeSingleQuote(outputPath)}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "} finally {",
    "  $bitmap.Dispose()",
    "}"
  ].join("\n");
  return {
    executable: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      script
    ]
  };
}
function makeTempPngPath(tmpDir) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${tmpDir}\\selection-translator-ocr-${process.pid}-${suffix}.png`;
}
function makeHelperDllPath(tmpDir) {
  return `${tmpDir}\\${CACHE_DIR_NAME}\\${HELPER_DLL_NAME}`;
}
function makeHelperExePath(tmpDir) {
  return `${tmpDir}\\${CACHE_DIR_NAME}\\${HELPER_EXE_NAME}`;
}
function buildHelperExeCompileCommand(helperExePath) {
  const exePath = escapeSingleQuote(helperExePath);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$dllDir = Split-Path -Parent '${exePath}'`,
    "if (-not (Test-Path -LiteralPath $dllDir)) { $null = New-Item -ItemType Directory -Path $dllDir -Force }",
    `Add-Type -TypeDefinition '${escapeSingleQuote(HELPER_EXE_CSHARP_SOURCE)}' -OutputAssembly '${exePath}' -OutputType ConsoleApplication`
  ].join("\n");
  return {
    executable: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script]
  };
}
async function ensureHelperExe(deps, helperExePath) {
  const inFlight = helperExeCompileTasks.get(helperExePath);
  if (inFlight) return inFlight;
  const task = buildHelperExe(deps, helperExePath);
  helperExeCompileTasks.set(helperExePath, task);
  try {
    return await task;
  } finally {
    helperExeCompileTasks.delete(helperExePath);
  }
}
async function buildHelperExe(deps, helperExePath) {
  if (verifiedHelperExePaths.has(helperExePath)) return helperExePath;
  try {
    const result = await deps.spawn(helperExePath, [], { timeout: 3e3, windowsHide: true });
    if (result.exitCode === 1 || result.exitCode === 0) {
      verifiedHelperExePaths.add(helperExePath);
      return helperExePath;
    }
  } catch {
  }
  const compileCmd = buildHelperExeCompileCommand(helperExePath);
  try {
    await deps.execFile(compileCmd.executable, compileCmd.args, {
      timeout: 1e4,
      windowsHide: true
    });
    verifiedHelperExePaths.add(helperExePath);
    return helperExePath;
  } catch {
    return null;
  }
}
async function prewarmWindowsCaptureHelper(deps) {
  if (deps.platform !== "win32") return false;
  try {
    const helperExePath = makeHelperExePath(deps.tmpDir());
    return await ensureHelperExe(deps, helperExePath) !== null;
  } catch {
    return false;
  }
}
async function captureWindowsRegionAsPng(displayBounds, scaleFactor, deps) {
  if (deps.platform !== "win32") {
    throw new ScreenCaptureError("no-source", translateMain("capture.error.windowsOnlyGdi"));
  }
  const path = makeTempPngPath(deps.tmpDir());
  const helperDllPath = makeHelperDllPath(deps.tmpDir());
  const helperExePath = makeHelperExePath(deps.tmpDir());
  const scale = scaleFactor || 1;
  const x = Math.round(displayBounds.x * scale);
  const y = Math.round(displayBounds.y * scale);
  const width = Math.max(1, Math.round(displayBounds.width * scale));
  const height = Math.max(1, Math.round(displayBounds.height * scale));
  try {
    const exePath = await ensureHelperExe(deps, helperExePath);
    if (exePath !== null) {
      const exeArgs = [String(x), String(y), String(width), String(height), path];
      const result = await deps.spawn(exePath, exeArgs, { timeout: 5e3, windowsHide: true });
      if (result.exitCode !== 0) {
        verifiedHelperExePaths.delete(exePath);
        throw new Error(translateMain("capture.error.windowsHelperExit", {
          exitCode: result.exitCode,
          stderr: result.stderr
        }));
      }
      return await deps.readFile(path);
    }
    const command = buildWindowsCaptureCommand(displayBounds, scaleFactor, path, helperDllPath);
    await deps.execFile(command.executable, command.args, {
      timeout: 5e3,
      windowsHide: true
    });
    return await deps.readFile(path);
  } catch (error2) {
    const message = error2 instanceof Error ? error2.message : String(error2);
    throw new ScreenCaptureError(
      "no-source",
      translateMain("capture.error.windowsCaptureFailed", { message })
    );
  } finally {
    await deps.unlink(path).catch(() => void 0);
  }
}
const defaultTranslator = createTranslator("en-US");
class OcrEngineError extends Error {
  /** 错误分类码。 */
  code;
  /** 出错的引擎，可选。 */
  engine;
  /**
   * 创建 OCR 引擎错误。
   * @param code 错误分类码。
   * @param message 面向调用方的描述。
   * @param engine 出错的引擎。
   * @author zhenghq
   */
  constructor(code, message, engine) {
    super(message);
    this.name = "OcrEngineError";
    this.code = code;
    this.engine = engine;
  }
}
function joinOcrLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return "";
  const sorted = [...lines].sort((a, b) => {
    const ay = a.box?.y ?? Number.POSITIVE_INFINITY;
    const by = b.box?.y ?? Number.POSITIVE_INFINITY;
    if (ay !== by) return ay - by;
    const ax = a.box?.x ?? Number.POSITIVE_INFINITY;
    const bx = b.box?.x ?? Number.POSITIVE_INFINITY;
    return ax - bx;
  });
  const rows = [];
  for (const line of sorted) {
    const text = String(line.text || "").trim();
    if (!text) continue;
    const y = line.box?.y;
    const last = rows[rows.length - 1];
    if (!last) {
      rows.push([line]);
      continue;
    }
    const lastY = last[0]?.box?.y;
    const sameRow = y !== void 0 && lastY !== void 0 && Math.abs(y - lastY) <= 8;
    if (sameRow) last.push(line);
    else rows.push([line]);
  }
  return rows.map((row) => row.slice().sort((a, b) => (a.box?.x ?? 0) - (b.box?.x ?? 0)).map((item) => String(item.text || "").trim()).filter(Boolean).join(" ")).filter(Boolean).join("\n");
}
async function withOcrTimeout(task, options = {}, engine) {
  const { timeoutMs, signal } = options;
  const message = options.message ?? ((key, params) => defaultTranslator.t(key, params));
  if (signal?.aborted) {
    throw new OcrEngineError("timeout", message("ocr.error.requestCancelled"), engine);
  }
  let timer;
  let onAbort;
  try {
    const timeoutPromise = timeoutMs === void 0 ? null : new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new OcrEngineError(
          "timeout",
          message("ocr.error.recognizeTimeout", { timeout: timeoutMs }),
          engine
        ));
      }, timeoutMs);
    });
    const abortPromise = signal ? new Promise((_, reject) => {
      onAbort = () => {
        reject(new OcrEngineError("timeout", message("ocr.error.requestCancelled"), engine));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }) : null;
    const racers = [task];
    if (timeoutPromise) racers.push(timeoutPromise);
    if (abortPromise) racers.push(abortPromise);
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
const URL_PUNCTUATION_MAP = {
  "／": "/",
  "？": "?",
  "＆": "&",
  "＝": "=",
  "％": "%",
  "＃": "#",
  "＠": "@"
};
function containsCjkText(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(text);
}
function normalizeUrlLikeLine(line) {
  const protocolNormalized = line.replace(/：\s*[／/]\s*[／/]/gu, "://");
  if (!protocolNormalized.includes("://")) return line;
  const normalized = protocolNormalized.replace(/[／？＆＝％＃＠]/gu, (character) => URL_PUNCTUATION_MAP[character] ?? character).replace(/(?<=[A-Za-z0-9_\]\-])：/gu, ":").replace(/：(?=\/\/|\d)/gu, ":").replace(/\s*．\s*/gu, ".").replace(/(\d)\s*[。｡]\s*(?=\d)/gu, "$1.").replace(/\s*([.:/?#&=@])\s*/gu, "$1");
  return containsCjkText(normalized) ? normalized : normalized.replace(/\s+/gu, "");
}
function cleanOcrText(text) {
  return String(text ?? "").replace(/\r/g, "").replace(/[\u200b-\u200f\ufeff]/g, "").replace(/[|｜]{2,}/g, "|").replace(/[ \t]{2,}/g, " ").split("\n").map((line) => normalizeUrlLikeLine(
    line.trim().replace(/\s+([,.!?;:，。！？、；：])/g, "$1")
  )).filter(Boolean).join("\n").trim();
}
const COMMON_CJK_CHARS = "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞";
function isLikelyGarbledCjk(clean) {
  const chars = [...clean];
  const cjk = chars.filter((ch) => /[\u4e00-\u9fff]/u.test(ch));
  if (cjk.length < 12) return false;
  const latin = chars.filter((ch) => /[A-Za-z]/u.test(ch)).length;
  const kana = chars.filter((ch) => /[\u3040-\u30ff]/u.test(ch)).length;
  const hangul = chars.filter((ch) => /[\uac00-\ud7af]/u.test(ch)).length;
  if (kana > 0 || hangul > 0) return false;
  const fullWidth = chars.filter((ch) => /[\uff00-\uffef]/u.test(ch)).length;
  const oddSymbols = chars.filter((ch) => /[´★□<>[\]]/u.test(ch)).length;
  const common2 = cjk.filter((ch) => COMMON_CJK_CHARS.includes(ch)).length;
  const commonRatio = common2 / cjk.length;
  const uniqueRatio = new Set(cjk).size / cjk.length;
  const latinRatio = latin / Math.max(1, cjk.length);
  const diverseRareCjk = commonRatio < 0.45 && uniqueRatio > 0.25 && latinRatio < 0.12;
  const repetitiveRareCjk = commonRatio < 0.45 && uniqueRatio < 0.24 && cjk.length >= 60;
  const mixedGarbled = commonRatio < 0.55 && uniqueRatio > 0.18 && latinRatio < 0.12 && (fullWidth > 0 || oddSymbols > 0);
  return diverseRareCjk || repetitiveRareCjk || mixedGarbled;
}
function scoreOcrText(text) {
  const clean = cleanOcrText(text);
  if (!clean) return 0;
  const cjk = (clean.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (clean.match(/[A-Za-z]/g) || []).length;
  const digits = (clean.match(/\d/g) || []).length;
  const bad = (clean.match(/[\uFFFD\u25A1]/g) || []).length;
  const punctuation = (clean.match(/[,.!?;:，。！？、；：]/g) || []).length;
  const lines = clean.split("\n").filter(Boolean).length;
  return clean.length + cjk * 6 + latin + digits + punctuation * 0.3 + lines - bad * 12;
}
function isMostlyNoise(text) {
  const clean = cleanOcrText(text);
  if (!clean) return true;
  const signal = (clean.match(/[\p{L}\p{N}\u4e00-\u9fff]/gu) || []).length;
  const replacement = (clean.match(/[\uFFFD\u25A1]/g) || []).length;
  if (signal < 2) return true;
  if (isLikelyGarbledCjk(clean)) return true;
  if (replacement > 0 && replacement >= signal / 2) return true;
  if (clean.length > 8 && signal / clean.length < 0.35) return true;
  return false;
}
const RELIABLE_OCR_CONFIDENCE_THRESHOLD = 0.6;
const LANGUAGE_MISMATCH_MIN_LATIN_COUNT = 6;
const SAFE_OCR_TEXT_SCORE = 5;
function isChinesePreferredLanguage(language) {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === "zh" || normalized.startsWith("zh-");
}
function hasOcrLanguageMismatch(text, language) {
  if (!isChinesePreferredLanguage(language)) return false;
  if (/\p{Script=Han}/u.test(text)) return false;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  return latinCount >= LANGUAGE_MISMATCH_MIN_LATIN_COUNT;
}
function getAverageOcrConfidence(result) {
  const confidenceValues = result.lines.filter((line) => Boolean(line.text?.trim())).map((line) => line.confidence).filter(
    (confidence) => typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
  );
  if (confidenceValues.length === 0) return void 0;
  return confidenceValues.reduce((sum, confidence) => sum + confidence, 0) / confidenceValues.length;
}
function isOcrResultValid(result) {
  if (!result.text || !result.text.trim()) return false;
  if (isMostlyNoise(result.text)) return false;
  return scoreOcrText(result.text) > 0;
}
function evaluateOcrQuality(result, language) {
  const valid = isOcrResultValid(result);
  const textScore = scoreOcrText(result.text ?? "");
  const languageMismatch = hasOcrLanguageMismatch(result.text ?? "", language);
  const averageConfidence = getAverageOcrConfidence(result);
  const safeToAccept = valid && !languageMismatch && textScore >= SAFE_OCR_TEXT_SCORE && (averageConfidence === void 0 || averageConfidence >= RELIABLE_OCR_CONFIDENCE_THRESHOLD);
  return { valid, languageMismatch, averageConfidence, textScore, safeToAccept };
}
function canSafelyAcceptOcrResult(result, language) {
  return evaluateOcrQuality(result, language).safeToAccept;
}
function compareOcrQuality(candidate, baseline) {
  if (candidate.valid !== baseline.valid) return candidate.valid ? 1 : -1;
  if (candidate.languageMismatch !== baseline.languageMismatch) {
    return candidate.languageMismatch ? -1 : 1;
  }
  if (candidate.averageConfidence !== void 0 && baseline.averageConfidence !== void 0 && candidate.averageConfidence !== baseline.averageConfidence) {
    return candidate.averageConfidence > baseline.averageConfidence ? 1 : -1;
  }
  if (candidate.textScore === baseline.textScore) return 0;
  return candidate.textScore > baseline.textScore ? 1 : -1;
}
function buildEngineQueue(preference, platform, preferredEngine) {
  if (preference !== "auto") {
    return [preference];
  }
  const defaultQueue = platform === "linux" ? ["paddle", "tesseract"] : ["system", "paddle", "tesseract"];
  if (!preferredEngine) return defaultQueue;
  const preferredIndex = defaultQueue.indexOf(preferredEngine);
  if (preferredIndex < 0) return defaultQueue;
  return [
    ...defaultQueue.slice(preferredIndex),
    ...defaultQueue.slice(0, preferredIndex)
  ];
}
function logOcrEngineResult(result, accepted, quality) {
  console.log("[ocr] 引擎结果", {
    engine: result.engine,
    textLength: result.text?.length ?? 0,
    score: quality.textScore,
    noise: !quality.valid,
    languageMismatch: quality.languageMismatch,
    averageConfidence: quality.averageConfidence,
    safeToStop: quality.safeToAccept,
    accepted
  });
}
class OcrDispatcher {
  /** 可注入依赖。 */
  deps;
  /**
   * 创建 OCR 调度器。
   * @param deps 引擎依赖与平台信息。
   * @author zhenghq
   */
  constructor(deps) {
    this.deps = deps;
  }
  /**
   * 按指定偏好调度 OCR 识别：
   * 1. 按 buildEngineQueue 决定尝试顺序；
   * 2. 逐层尝试，空结果继续下一层，失败降级；
   * 3. 首个安全结果成功后立即返回，并记录为后续自动请求的首选引擎；
   * 4. 仅有可疑有效结果时继续降级，全部尝试后择优兜底；
   * 5. 无有效结果时抛出 empty；全部引擎不可用/失败时抛出 engine-unavailable。
   * @param input 识别输入。
   * @param preference 引擎偏好（来自设置）。
   * @returns 质量最优的识别结果。
   * @author zhenghq
   */
  async recognize(input, preference) {
    const queue = buildEngineQueue(
      preference,
      this.deps.platform,
      preference === "auto" ? this.deps.enginePreferenceState?.preferredEngine : void 0
    );
    const validResults = [];
    const errors = [];
    let attemptedCount = 0;
    let engineUnavailableCount = 0;
    for (const engineId of queue) {
      const engine = this.deps.engines[engineId];
      if (!engine) continue;
      let available = false;
      try {
        available = await engine.isAvailable();
      } catch {
        errors.push(translateMain("ocr.dispatcher.availabilityCheckFailed", { engine: engineId }));
        continue;
      }
      if (!available) {
        const reason = engine.getUnavailableReason?.() ?? translateMain("ocr.dispatcher.engineUnavailable");
        errors.push(`${engineId}: ${reason}`);
        continue;
      }
      attemptedCount += 1;
      try {
        const result = await engine.recognize(input);
        const quality = evaluateOcrQuality(result, input.language);
        const accepted = quality.valid;
        logOcrEngineResult(result, accepted, quality);
        if (quality.safeToAccept) {
          if (preference === "auto" && this.deps.enginePreferenceState) {
            this.deps.enginePreferenceState.preferredEngine = result.engine;
          }
          return result;
        } else if (accepted) {
          validResults.push(result);
        } else {
          errors.push(translateMain("ocr.dispatcher.invalidResult", { engine: engineId }));
        }
      } catch (error2) {
        if (error2 instanceof OcrEngineError && error2.code === "timeout") {
          throw error2;
        }
        const message = error2 instanceof Error ? error2.message : String(error2);
        errors.push(`${engineId}: ${message}`);
        if (error2 instanceof OcrEngineError && error2.code === "engine-unavailable") {
          engineUnavailableCount += 1;
        }
      }
    }
    if (validResults.length > 0) {
      const selected = validResults.reduce((best, candidate) => {
        const comparison = compareOcrQuality(
          evaluateOcrQuality(candidate, input.language),
          evaluateOcrQuality(best, input.language)
        );
        return comparison >= 0 ? candidate : best;
      });
      if (preference === "auto" && this.deps.enginePreferenceState) {
        this.deps.enginePreferenceState.preferredEngine = selected.engine;
      }
      return selected;
    }
    if (attemptedCount === 0 || engineUnavailableCount === attemptedCount) {
      throw new OcrEngineError(
        "engine-unavailable",
        translateMain("ocr.dispatcher.allEnginesUnavailable", { errors: errors.join("; ") })
      );
    }
    throw new OcrEngineError(
      "empty",
      translateMain("ocr.dispatcher.noTextRecognized", { errors: errors.join("; ") })
    );
  }
}
function handleOcrSelectionWindowHide(deps) {
  deps.resolveReady(false);
  deps.clearActiveRequests();
  deps.restoreSelectionListener();
}
function handleOcrSelectionWindowClosed(deps) {
  deps.resolveReady(false);
  deps.clearActiveRequests();
  deps.releaseSnapshot();
  deps.restoreSelectionListener();
}
function parseVisionOcrOutput(output) {
  if (!output || !output.trim()) return [];
  return output.split("\n").map((line) => line.trim()).filter(Boolean).map((text) => ({ text }));
}
function windowsOcrLanguageTag(language) {
  if (!language || language === "auto") return "auto";
  const map = {
    "zh": "zh-Hans-CN",
    "zh-hans": "zh-Hans-CN",
    "zh-hant": "zh-Hant-TW",
    "en": "en-US",
    "ja": "ja-JP",
    "ko": "ko-KR",
    "fr": "fr-FR",
    "de": "de-DE",
    "es": "es-ES",
    "pt": "pt-BR",
    "ru": "ru-RU"
  };
  return map[language.toLowerCase()] ?? language;
}
function parseWindowsOcrStructuredOutput(output) {
  const raw = String(output ?? "").trim();
  if (!raw) return [];
  if (!raw.startsWith("{")) return parseVisionOcrOutput(raw);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.lines)) return [];
    return parsed.lines.map((line) => {
      if (!line || typeof line !== "object") return null;
      const candidate = line;
      const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
      if (!text) return null;
      const words = Array.isArray(candidate.words) ? candidate.words.map((word) => {
        if (!word || typeof word !== "object") return null;
        const item = word;
        const wordText = typeof item.text === "string" ? item.text.trim() : "";
        const x = Number(item.x);
        const y = Number(item.y);
        const width = Number(item.width);
        const height = Number(item.height);
        if (!wordText || ![x, y, width, height].every(Number.isFinite)) return null;
        return { text: wordText, x, y, width, height };
      }).filter((word) => word !== null) : [];
      return words.length > 0 ? { text, words } : { text };
    }).filter((line) => line !== null);
  } catch {
    return parseVisionOcrOutput(raw);
  }
}
function hasUnderlineBetweenWords(image, left, right) {
  const gapLeft = Math.max(0, Math.ceil(left.x + left.width));
  const gapRight = Math.min(image.width - 1, Math.floor(right.x) - 1);
  const gapWidth = gapRight - gapLeft + 1;
  if (gapWidth < 2 || gapRight < gapLeft) return false;
  const top = Math.min(left.y, right.y);
  const bottom = Math.max(left.y + left.height, right.y + right.height);
  const lineHeight = Math.max(1, Math.min(left.height, right.height));
  const scanTop = Math.max(0, Math.floor(top + lineHeight * 0.85));
  const scanBottom = Math.min(image.height - 1, Math.ceil(bottom + lineHeight * 0.35));
  for (let y = scanTop; y <= scanBottom; y += 1) {
    let darkPixels = 0;
    for (let x = gapLeft; x <= gapRight; x += 1) {
      const offset = (y * image.width + x) * 4;
      const alpha = image.data[offset + 3] / 255;
      const luma = lumaOf(image.data[offset], image.data[offset + 1], image.data[offset + 2]) * alpha + 255 * (1 - alpha);
      if (luma < 190) darkPixels += 1;
    }
    if (darkPixels >= Math.max(2, Math.ceil(gapWidth * 0.6))) return true;
  }
  return false;
}
function restoreWindowsOcrUnderlines(lines, image) {
  return lines.map((line) => {
    if (!line.words || line.words.length < 2) return line;
    let text = line.text;
    for (let index = 0; index < line.words.length - 1; index += 1) {
      const left = line.words[index];
      const right = line.words[index + 1];
      if (!hasUnderlineBetweenWords(image, left, right)) continue;
      const leftIndex = text.indexOf(left.text);
      const rightIndex = leftIndex >= 0 ? text.indexOf(right.text, leftIndex + left.text.length) : -1;
      if (leftIndex >= 0 && rightIndex > leftIndex) {
        const gap = text.slice(leftIndex + left.text.length, rightIndex);
        if (/^\s*$/u.test(gap)) {
          text = text.slice(0, leftIndex + left.text.length) + "_" + text.slice(rightIndex);
        }
      } else if (text === line.words.map((word) => word.text).join(" ")) {
        text = line.words.map(
          (word, wordIndex) => wordIndex === index ? `${word.text}_` : word.text
        ).join(" ");
      }
    }
    return { ...line, text };
  });
}
function buildWindowsOcrCommand(imagePath, scriptPath, language) {
  const langTag = windowsOcrLanguageTag(language);
  return {
    executable: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-ImagePath",
      imagePath,
      "-Language",
      langTag
    ]
  };
}
function extractProcessErrorMessage(error2) {
  if (!error2 || typeof error2 !== "object") return String(error2);
  const processError = error2;
  for (const candidate of [processError.stderr, processError.stdout, processError.message]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return String(error2);
}
const WIN_OCR_SCRIPT = `param([string]$ImagePath, [string]$Language = 'auto')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

function Await-Operation($AsyncOperation, [type]$ResultType) {
  $method = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
  } | Select-Object -First 1).MakeGenericMethod($ResultType)
  $task = $method.Invoke($null, @($AsyncOperation))
  $task.Wait()
  return $task.Result
}

$file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  try {
    function New-OcrEngine([string]$Tag) {
      if (!$Tag -or $Tag -eq 'auto') {
        return [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      }
      try {
        $lang = [Windows.Globalization.Language]::new($Tag)
        return [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
      } catch {
        return $null
      }
    }

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Language -and $Language -ne 'auto') {
      $candidates.Add($Language)
      $candidates.Add('auto')
    } else {
      foreach ($tag in @('auto', 'zh-Hans-CN', 'zh-Hant-TW', 'en-US', 'ja-JP', 'ko-KR')) {
        $candidates.Add($tag)
      }
    }

    $bestText = ''
    $bestLines = @()
    foreach ($tag in $candidates) {
      $engine = New-OcrEngine $tag
      if ($null -eq $engine) { continue }
      $result = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $text = $result.Text
      if ($text.Trim().Length -gt $bestText.Trim().Length) {
        $bestText = $text
        $bestLines = @($result.Lines | ForEach-Object {
          $line = $_
          [pscustomobject]@{
            text = $line.Text
            words = @($line.Words | ForEach-Object {
              $rect = $_.BoundingRect
              [pscustomobject]@{
                text = $_.Text
                x = [int][Math]::Round($rect.X)
                y = [int][Math]::Round($rect.Y)
                width = [int][Math]::Round($rect.Width)
                height = [int][Math]::Round($rect.Height)
              }
            })
          }
        })
      }
      if ($Language -and $Language -ne 'auto' -and $bestText.Trim().Length -gt 0) {
        break
      }
    }

    if ($bestText.Trim().Length -eq 0) {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      if ($null -eq $engine) { throw 'No Windows OCR language is available.' }
    }
    [pscustomobject]@{ lines = @($bestLines) } | ConvertTo-Json -Compress -Depth 6
  } finally {
    if ($bitmap) { $bitmap.Dispose() }
  }
} finally {
  if ($stream) { $stream.Dispose() }
}
`;
class MacOsVisionOcrEngine {
  /** 引擎标识。 */
  id = "system";
  /** 可注入依赖，默认使用 Node.js 内置模块与 Electron 运行时。 */
  deps;
  /** Swift OSA 组件可用性探测缓存。 */
  availabilityCheck = null;
  /** 最近一次不可用原因的语义化词条 key。 */
  unavailableReasonKey;
  /** 最近一次不可用原因的插值参数。 */
  unavailableReasonParams;
  /**
   * 创建 macOS Vision OCR 引擎。
   * @param deps 可注入依赖；生产环境省略使用默认值。
   * @author zhenghq
   */
  constructor(deps) {
    this.deps = {
      platform: process.platform,
      execFile: defaultExecFile,
      writeFile: async (path, data) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, data);
      },
      tmpDir: node_os.tmpdir,
      visionHelperPath: defaultMacOsVisionHelperPath(),
      fileExists: node_fs.existsSync,
      ...deps
    };
  }
  /**
   * 判断当前平台和 Vision OCR helper 是否可用。
   * @returns 是否可用。
   * @author zhenghq
   */
  async isAvailable() {
    if (this.deps.platform !== "darwin") return false;
    if (!this.availabilityCheck) {
      const helperPath = this.resolveHelperPath();
      if (!helperPath) {
        this.unavailableReasonKey = "ocr.error.visionHelperMissing";
        this.unavailableReasonParams = void 0;
        this.availabilityCheck = Promise.resolve(false);
      } else {
        this.availabilityCheck = this.deps.execFile(helperPath, ["--version"], { timeout: 2e3 }).then(() => {
          this.unavailableReasonKey = void 0;
          this.unavailableReasonParams = void 0;
          return true;
        }).catch((error2) => {
          const message = error2 instanceof Error ? error2.message : String(error2);
          this.unavailableReasonKey = "ocr.error.visionHelperUnavailable";
          this.unavailableReasonParams = { message };
          return false;
        });
      }
    }
    return this.availabilityCheck;
  }
  /**
   * 返回 macOS system OCR 最近一次不可用原因。
   * @returns 不可用原因。
   * @author zhenghq
   */
  getUnavailableReason() {
    return this.unavailableReasonKey ? translateMain(this.unavailableReasonKey, this.unavailableReasonParams) : void 0;
  }
  /**
   * 解析可用的 macOS Vision OCR helper 路径。
   * @returns helper 路径，缺失时返回 undefined。
   * @author zhenghq
   */
  resolveHelperPath() {
    const helperPath = this.deps.visionHelperPath;
    if (!helperPath || !this.deps.fileExists?.(helperPath)) return void 0;
    return helperPath;
  }
  /**
   * 使用 osascript Swift 桥调用 Vision OCR 识别图片文字。
   * @param input 识别输入（图片字节或路径）。
   * @returns 识别结果，含文本行与拼接文本。
   * @author zhenghq
   */
  async recognize(input) {
    if (this.deps.platform !== "darwin") {
      throw new OcrEngineError(
        "engine-unavailable",
        translateMain("ocr.error.visionUnsupportedPlatform"),
        "system"
      );
    }
    const lang = input.language ?? "auto";
    let imagePath;
    let tempPath;
    if (input.imageBytes && input.imageBytes.length > 0) {
      tempPath = node_path.join(
        this.deps.tmpDir(),
        `ocr-vision-${process.pid}-${Date.now()}.png`
      );
      await this.deps.writeFile(tempPath, Buffer.from(input.imageBytes));
      imagePath = tempPath;
    } else if (input.imagePath) {
      imagePath = input.imagePath;
    } else {
      throw new OcrEngineError("empty", translateMain("ocr.error.visionMissingInput"), "system");
    }
    const timeoutMs = input.timeoutMs ?? 15e3;
    const helperPath = this.resolveHelperPath();
    if (!helperPath) {
      const message = translateMain("ocr.error.visionHelperMissing");
      this.unavailableReasonKey = "ocr.error.visionHelperMissing";
      this.unavailableReasonParams = void 0;
      throw new OcrEngineError("engine-unavailable", message, "system");
    }
    try {
      const { stdout, stderr } = await this.deps.execFile(
        helperPath,
        [imagePath, lang],
        { timeout: timeoutMs, signal: input.signal }
      );
      if (stderr?.toLowerCase().includes("permission")) {
        throw new OcrEngineError(
          "permission",
          translateMain("ocr.error.visionPermissionRequired"),
          "system"
        );
      }
      const lines = parseVisionOcrOutput(stdout);
      const text = joinOcrLines(lines);
      return { lines, text, engine: "system" };
    } catch (error2) {
      if (error2 instanceof OcrEngineError) throw error2;
      const message = error2 instanceof Error ? error2.message : String(error2);
      if (/permission|tcc/i.test(message)) {
        throw new OcrEngineError(
          "permission",
          translateMain("ocr.error.visionPermissionMissing"),
          "system"
        );
      }
      if (/timeout|signal/i.test(message)) {
        throw new OcrEngineError("timeout", translateMain("ocr.error.visionTimeout"), "system");
      }
      const reason = translateMain("ocr.error.visionFailed", { message });
      this.unavailableReasonKey = "ocr.error.visionFailed";
      this.unavailableReasonParams = { message };
      throw new OcrEngineError("engine-unavailable", reason, "system");
    }
  }
}
class WindowsSystemOcrEngine {
  /** 引擎标识。 */
  id = "system";
  /** win-ocr.ps1 在 userData 目录的缓存路径。 */
  scriptPath;
  /** Windows system OCR 最近一次不可用原因的语义化词条 key。 */
  unavailableReasonKey;
  /** Windows system OCR 最近一次不可用原因的插值参数。 */
  unavailableReasonParams;
  /** 可注入依赖。 */
  deps;
  /**
   * 创建 Windows 系统 OCR 引擎。
   * @param deps 可注入依赖；生产环境省略使用默认值。
   * @author zhenghq
   */
  constructor(deps) {
    this.deps = {
      platform: process.platform,
      execFile: defaultExecFile,
      writeFile: async (path, data) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, data);
      },
      tmpDir: node_os.tmpdir,
      ...deps
    };
  }
  /**
   * 判断当前平台是否为 Windows。
   * @returns 是否可用。
   * @author zhenghq
   */
  isAvailable() {
    return this.deps.platform === "win32";
  }
  /**
   * 返回 Windows system OCR 最近一次不可用原因。
   * @returns 不可用原因；尚未失败或可用时返回 undefined。
   * @author zhenghq
   */
  getUnavailableReason() {
    return this.unavailableReasonKey ? translateMain(this.unavailableReasonKey, this.unavailableReasonParams) : void 0;
  }
  /**
   * 确保 win-ocr.ps1 已写入临时目录并返回其路径。
   * @returns 脚本路径。
   * @author zhenghq
   */
  async ensureScript() {
    if (this.scriptPath) return this.scriptPath;
    const path = node_path.join(this.deps.tmpDir(), "win-ocr.ps1");
    await this.deps.writeFile(path, WIN_OCR_SCRIPT);
    this.scriptPath = path;
    return path;
  }
  /**
   * 使用 PowerShell win-ocr.ps1 调用 Windows.Media.Ocr 识别图片文字。
   * @param input 识别输入（图片字节或路径）。
   * @returns 识别结果，含文本行与拼接文本。
   * @author zhenghq
   */
  async recognize(input) {
    if (!this.isAvailable()) {
      throw new OcrEngineError(
        "engine-unavailable",
        translateMain("ocr.error.windowsUnsupportedPlatform"),
        "system"
      );
    }
    const lang = input.language ?? "auto";
    let imagePath;
    let tempPath;
    if (input.imageBytes && input.imageBytes.length > 0) {
      tempPath = node_path.join(
        this.deps.tmpDir(),
        `ocr-win-${process.pid}-${Date.now()}.png`
      );
      await this.deps.writeFile(tempPath, Buffer.from(input.imageBytes));
      imagePath = tempPath;
    } else if (input.imagePath) {
      imagePath = input.imagePath;
    } else {
      throw new OcrEngineError("empty", translateMain("ocr.error.windowsMissingInput"), "system");
    }
    const scriptPath = await this.ensureScript();
    const cmd = buildWindowsOcrCommand(imagePath, scriptPath, lang);
    const timeoutMs = input.timeoutMs ?? 2e4;
    try {
      const { stdout, stderr } = await this.deps.execFile(
        cmd.executable,
        cmd.args,
        { timeout: timeoutMs, signal: input.signal }
      );
      if (stderr?.includes("No Windows OCR language is available")) {
        throw new OcrEngineError(
          "engine-unavailable",
          translateMain("ocr.error.windowsLanguagePackMissing"),
          "system"
        );
      }
      let lines = parseWindowsOcrStructuredOutput(stdout);
      if (lines.some((line) => line.words && line.words.length > 1)) {
        try {
          const imageBytes = input.imageBytes && input.imageBytes.length > 0 ? input.imageBytes : await this.readImageBytes(imagePath);
          const restored = restoreWindowsOcrUnderlines(lines, decodePng(imageBytes));
          const restoredCount = restored.reduce((count, line, index) => count + ((line.text.match(/_/gu)?.length ?? 0) - (lines[index]?.text.match(/_/gu)?.length ?? 0)), 0);
          lines = restored;
          if (restoredCount > 0) {
            console.log("[ocr] Windows 系统 OCR 已按词间横线恢复下划线", { restoredCount });
          }
        } catch {
        }
      }
      const text = joinOcrLines(lines);
      this.unavailableReasonKey = void 0;
      this.unavailableReasonParams = void 0;
      return { lines, text, engine: "system" };
    } catch (error2) {
      if (error2 instanceof OcrEngineError) throw error2;
      const message = extractProcessErrorMessage(error2);
      if (/timeout/i.test(message)) {
        throw new OcrEngineError("timeout", translateMain("ocr.error.windowsTimeout"), "system");
      }
      if (/No Windows OCR/i.test(message)) {
        const reason2 = translateMain("ocr.error.windowsLanguagePackMissing");
        this.unavailableReasonKey = "ocr.error.windowsLanguagePackMissing";
        this.unavailableReasonParams = void 0;
        throw new OcrEngineError("engine-unavailable", reason2, "system");
      }
      const reason = translateMain("ocr.error.windowsFailed", { message });
      this.unavailableReasonKey = "ocr.error.windowsFailed";
      this.unavailableReasonParams = { message };
      throw new OcrEngineError("engine-unavailable", reason, "system");
    }
  }
  /**
   * 读取本地图片路径的字节内容，用于输入为路径时恢复下划线。
   * @param path 图片本地路径。
   * @returns 图片字节。
   * @author zhenghq
   */
  async readImageBytes(path) {
    const { readFile } = await import("node:fs/promises");
    return readFile(path);
  }
}
async function defaultExecFile(executable, args, options) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP2 = promisify(execFile);
  const result = await execFileP2(executable, args, {
    timeout: options?.timeout,
    signal: options?.signal,
    maxBuffer: 1024 * 1024 * 4,
    encoding: "utf8"
  });
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "")
  };
}
function defaultMacOsVisionHelperPath(options) {
  const fileExists = node_fs.existsSync;
  const cwd = process.cwd();
  const resourcesPath = typeof process.resourcesPath === "string" && process.resourcesPath ? process.resourcesPath : cwd;
  const resourcesHelperPath = node_path.join(resourcesPath, "macos-vision-ocr");
  if (fileExists(resourcesHelperPath)) return resourcesHelperPath;
  return node_path.join(cwd, "build", "macos-vision-ocr");
}
function createSystemOcrEngine(deps) {
  const platform = process.platform;
  if (platform === "darwin") return new MacOsVisionOcrEngine(deps);
  if (platform === "win32") return new WindowsSystemOcrEngine(deps);
  return null;
}
const MIN_INK_CONTRAST = 48;
const INK_COLUMN_THRESHOLD_RATIO = 0.25;
const UNDERLINE_SCAN_TOP_RATIO = 0.62;
const UNDERLINE_SCAN_BOTTOM_RATIO = 0.2;
const UNDERLINE_BAND_SEARCH_BOTTOM_RATIO = 1.2;
const UNDERLINE_COVERAGE_RATIO = 0.5;
const GLYPH_GAP_FILL_RATIO = 0.5;
function compositedLuma(image, offset, backgroundLuma) {
  const alpha = image.data[offset + 3] / 255;
  const luma = image.data[offset] * 0.299 + image.data[offset + 1] * 0.587 + image.data[offset + 2] * 0.114;
  return luma * alpha + backgroundLuma * (1 - alpha);
}
function estimateBackgroundLuma(image, left, top, right, bottom) {
  const histogram = new Uint32Array(256);
  let samples = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * image.width + x) * 4;
      const alpha = image.data[offset + 3] / 255;
      const luma = image.data[offset] * 0.299 + image.data[offset + 1] * 0.587 + image.data[offset + 2] * 0.114;
      const composited = Math.round(luma * alpha + 255 * (1 - alpha));
      histogram[Math.max(0, Math.min(255, composited))] += 1;
      samples += 1;
    }
  }
  if (samples === 0) return 255;
  let cumulative = 0;
  for (let luma = 0; luma < histogram.length; luma += 1) {
    cumulative += histogram[luma];
    if (cumulative * 2 >= samples) return luma;
  }
  return 255;
}
function isInkPixel(image, offset, backgroundLuma) {
  return Math.abs(compositedLuma(image, offset, backgroundLuma) - backgroundLuma) >= MIN_INK_CONTRAST;
}
function columnInkCounts(image, left, right, top, bottom, backgroundLuma) {
  const counts = [];
  for (let x = left; x <= right; x += 1) {
    let ink = 0;
    for (let y = top; y <= bottom; y += 1) {
      const offset = (y * image.width + x) * 4;
      if (isInkPixel(image, offset, backgroundLuma)) ink += 1;
    }
    counts.push(ink);
  }
  return counts;
}
function extractBlankGaps(counts, left, threshold) {
  const gaps = [];
  let gapStart = -1;
  for (let index = 0; index <= counts.length; index += 1) {
    const isBlank = index < counts.length && counts[index] < threshold;
    if (isBlank) {
      if (gapStart < 0) gapStart = index;
      continue;
    }
    if (gapStart >= 0) {
      gaps.push({
        start: left + gapStart,
        end: left + index - 1,
        width: index - gapStart
      });
      gapStart = -1;
    }
  }
  return gaps;
}
function findUnderlineBand(image, range, backgroundLuma) {
  const rowInk = [];
  for (let y = range.top; y <= range.bottom; y += 1) {
    let ink = 0;
    for (let x = range.left; x <= range.right; x += 1) {
      if (isInkPixel(image, (y * image.width + x) * 4, backgroundLuma)) ink += 1;
    }
    rowInk.push(ink);
  }
  const maxRowInk = rowInk.reduce((max, value) => Math.max(max, value), 0);
  if (maxRowInk <= 0) return null;
  const blankThreshold = Math.max(1, Math.floor(maxRowInk * 0.03));
  let cursor = rowInk.length - 1;
  while (cursor >= 0 && rowInk[cursor] < blankThreshold) cursor -= 1;
  if (cursor < 0) return null;
  const bandBottom = range.top + cursor;
  while (cursor >= 0 && rowInk[cursor] >= blankThreshold) cursor -= 1;
  const bandTop = range.top + cursor + 1;
  const bandHeight = bandBottom - bandTop + 1;
  if (bandHeight > Math.max(3, Math.ceil(range.height * 0.25))) return null;
  let hasGlyphBand = false;
  for (let index = cursor; index >= 0; index -= 1) {
    if (rowInk[index] >= blankThreshold) {
      hasGlyphBand = true;
      break;
    }
  }
  if (!hasGlyphBand) return null;
  return { top: bandTop, bottom: bandBottom };
}
function isGlyphFilledGap(image, gap, top, scanTop, backgroundLuma) {
  const requiredInk = Math.max(2, Math.ceil(gap.width * GLYPH_GAP_FILL_RATIO));
  for (let y = top; y < scanTop; y += 1) {
    let inkColumns = 0;
    for (let x = gap.start; x <= gap.end; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (isInkPixel(image, offset, backgroundLuma)) inkColumns += 1;
    }
    if (inkColumns >= requiredInk) return true;
  }
  return false;
}
function longestUnderlineRun(image, gap, scanTop, scanBottom, backgroundLuma) {
  let longest = 0;
  for (let y = scanTop; y <= scanBottom; y += 1) {
    let current = 0;
    for (let x = gap.start; x <= gap.end; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (isInkPixel(image, offset, backgroundLuma)) {
        current += 1;
        longest = Math.max(longest, current);
      } else {
        current = 0;
      }
    }
  }
  return longest;
}
function clampBoxToImage(box, image) {
  if (!box) return null;
  const x = Number(box.x);
  const y = Number(box.y);
  const width = Number(box.width);
  const height = Number(box.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(image.width - 1, Math.ceil(x + width) - 1);
  const bottom = Math.min(image.height - 1, Math.ceil(y + height) - 1);
  if (right <= left || bottom <= top) return null;
  return { left, right, top, bottom, height: bottom - top + 1 };
}
function restorePaddleOcrUnderlines(text, box, image) {
  const original = String(text ?? "");
  if (!original || !/\s/u.test(original)) return original;
  if (!image || image.width <= 0 || image.height <= 0) return original;
  const range = clampBoxToImage(box, image);
  if (!range) return original;
  const parts = original.trim().split(/([\s_]+)/u);
  const words = parts.filter((_, index) => index % 2 === 0);
  const separators = parts.filter((_, index) => index % 2 === 1);
  if (words.length < 2 || separators.length !== words.length - 1) return original;
  const backgroundLuma = estimateBackgroundLuma(image, range.left, range.top, range.right, range.bottom);
  let underlineBand = findUnderlineBand(image, range, backgroundLuma);
  if (!underlineBand) {
    const extendedBottom = Math.min(
      image.height - 1,
      range.bottom + Math.ceil(range.height * UNDERLINE_BAND_SEARCH_BOTTOM_RATIO)
    );
    if (extendedBottom > range.bottom) {
      const extendedBand = findUnderlineBand(
        image,
        { ...range, bottom: extendedBottom },
        backgroundLuma
      );
      if (extendedBand && extendedBand.bottom < extendedBottom) underlineBand = extendedBand;
    }
  }
  const countsBottom = underlineBand ? underlineBand.top - 1 : range.bottom;
  const counts = columnInkCounts(
    image,
    range.left,
    range.right,
    range.top,
    countsBottom,
    backgroundLuma
  );
  const maxInk = counts.reduce((max, value) => Math.max(max, value), 0);
  if (maxInk <= 0) return original;
  const inkThreshold = Math.max(2, Math.ceil(maxInk * INK_COLUMN_THRESHOLD_RATIO));
  let firstGlyph = -1;
  let lastGlyph = -1;
  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] >= inkThreshold) {
      if (firstGlyph < 0) firstGlyph = index;
      lastGlyph = index;
    }
  }
  if (firstGlyph < 0 || lastGlyph <= firstGlyph) return original;
  const glyphLeft = range.left + firstGlyph;
  const glyphRight = range.left + lastGlyph;
  const charCount = Math.max(1, original.replace(/\s/gu, "").length);
  const charCellWidth = (glyphRight - glyphLeft + 1) / charCount;
  const gaps = extractBlankGaps(counts, range.left, inkThreshold).filter(
    (gap) => gap.start > glyphLeft && gap.end < glyphRight
  );
  const scanTop = underlineBand ? underlineBand.top : Math.max(0, Math.min(
    image.height - 1,
    Math.floor(range.top + range.height * UNDERLINE_SCAN_TOP_RATIO)
  ));
  const scanBottom = underlineBand ? underlineBand.bottom : Math.max(scanTop, Math.min(
    image.height - 1,
    Math.ceil(range.bottom + range.height * UNDERLINE_SCAN_BOTTOM_RATIO)
  ));
  const wordCandidateGaps = gaps.filter(
    (gap) => !isGlyphFilledGap(image, gap, range.top, scanTop, backgroundLuma)
  );
  const underlineGaps = wordCandidateGaps.filter((gap) => {
    if (gap.width < Math.max(3, range.height * 0.25)) return false;
    const run = longestUnderlineRun(image, gap, scanTop, scanBottom, backgroundLuma);
    const referenceWidth = Math.min(gap.width, charCellWidth);
    return run >= Math.max(2, Math.ceil(referenceWidth * UNDERLINE_COVERAGE_RATIO));
  });
  if (underlineGaps.length === 0) return original;
  const textLength = original.trim().length;
  const separatorCenters = [];
  let cursor = 0;
  for (let index = 0; index < words.length; index += 1) {
    cursor += words[index].length;
    const separator = separators[index];
    if (separator === void 0) break;
    separatorCenters.push((cursor + separator.length / 2) / textLength);
    cursor += separator.length;
  }
  const lineSpan = Math.max(1, glyphRight - glyphLeft);
  const assignments = new Array(separators.length).fill(false);
  const anchorCenters = underlineGaps.map((gap) => ((gap.start + gap.end) / 2 - glyphLeft) / lineSpan).sort((a, b) => a - b);
  const tolerance = Math.max(range.height / lineSpan, 0.035);
  let anchorIndex = 0;
  for (let separatorIndex = 0; separatorIndex < separators.length; separatorIndex += 1) {
    const separatorCenter = separatorCenters[separatorIndex];
    while (anchorIndex < anchorCenters.length && anchorCenters[anchorIndex] < separatorCenter - tolerance) {
      anchorIndex += 1;
    }
    if (anchorIndex >= anchorCenters.length) break;
    if (Math.abs(anchorCenters[anchorIndex] - separatorCenter) <= tolerance) {
      assignments[separatorIndex] = true;
      anchorIndex += 1;
    }
  }
  let changed = false;
  const merged = [];
  for (let index = 0; index < words.length; index += 1) {
    merged.push(words[index]);
    const separator = separators[index];
    if (separator === void 0) break;
    if (assignments[index] || separator.includes("_")) {
      merged.push("_");
      if (!separator.includes("_")) changed = true;
    } else {
      merged.push(separator);
    }
  }
  return changed ? merged.join("") : original;
}
function getPaddleItemBox(item) {
  const points = Array.isArray(item?.box) ? item.box : null;
  if (points?.length) {
    const xs = points.map((p) => Number(p?.[0] ?? 0));
    const ys = points.map((p) => Number(p?.[1] ?? 0));
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const right = Math.max(...xs);
    const bottom = Math.max(...ys);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  const rawItem = item;
  const frame = rawItem.frame ?? rawItem.bounds ?? rawItem.boundingBox ?? {};
  const f = frame;
  const x = Number(f.left ?? f.x ?? 0);
  const y = Number(f.top ?? f.y ?? 0);
  const width = Number(f.width ?? 0);
  const height = Number(f.height ?? 0);
  return { x, y, width, height };
}
function shouldJoinWithoutSpace(previous, next) {
  if (!previous || !next) return true;
  if (/[\s([{《"']$/u.test(previous)) return true;
  if (/^[\s,.;:!?，。！？、；：）\]】》"']/u.test(next)) return true;
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]$/u.test(previous) && /^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(next)) return true;
  return false;
}
function joinOcrFragments(fragments) {
  return fragments.reduce((line, fragment) => {
    if (!line) return fragment;
    return line + (shouldJoinWithoutSpace(line, fragment) ? "" : " ") + fragment;
  }, "");
}
function mergePaddleItemBoxes(items) {
  const valid = items.filter(
    (item) => Number.isFinite(item.box.x) && Number.isFinite(item.box.y) && Number.isFinite(item.box.width) && Number.isFinite(item.box.height) && item.box.width > 0 && item.box.height > 0
  );
  if (valid.length === 0) return items[0].box;
  const left = Math.min(...valid.map((item) => item.box.x));
  const top = Math.min(...valid.map((item) => item.box.y));
  const right = Math.max(...valid.map((item) => item.box.x + item.box.width));
  const bottom = Math.max(...valid.map((item) => item.box.y + item.box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
function normalizePaddleLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const MIN_CONFIDENCE = 0.35;
  const items = lines.map((line) => {
    const text = String(line?.text ?? "").trim();
    const confidence = Number(
      line?.confidence ?? line?.score ?? line?.mean ?? line?.probability ?? 1
    );
    const box = getPaddleItemBox(line);
    return { text, confidence, box };
  }).filter(
    (item) => item.text.length > 0 && (!Number.isFinite(item.confidence) || item.confidence >= MIN_CONFIDENCE)
  ).sort((a, b) => {
    if (Math.abs(a.box.y - b.box.y) > 12) return a.box.y - b.box.y;
    return a.box.x - b.box.x;
  });
  const groups = [];
  for (const item of items) {
    const mid = item.box.y + (item.box.height || 0) / 2;
    const height = item.box.height || 18;
    let group = groups.find(
      (g) => Math.abs(g.mid - mid) <= Math.max(10, Math.max(g.height, height) * 0.72)
    );
    if (!group) {
      group = { mid, height, items: [] };
      groups.push(group);
    }
    group.items.push(item);
    group.height = Math.max(group.height, height);
    group.mid = group.items.reduce((sum, v) => sum + v.box.y + (v.box.height || 0) / 2, 0) / group.items.length;
  }
  const mergedLines = groups.sort((a, b) => a.mid - b.mid).map((group) => {
    const sorted = group.items.slice().sort((a, b) => a.box.x - b.box.x);
    const text = joinOcrFragments(sorted.map((item) => item.text));
    if (!text) return null;
    return {
      text,
      box: mergePaddleItemBoxes(sorted),
      confidence: sorted.reduce((sum, item) => sum + (item.confidence ?? 1), 0) / sorted.length
    };
  });
  return mergedLines.filter((line) => line !== null);
}
async function defaultCreateOcrNode(options) {
  const mod = await import("@gutenye/ocr-node");
  const Ocr = mod.default ?? mod;
  return Ocr.create({
    onnxOptions: { executionProviders: ["cpu"], ...options?.onnxOptions ?? {} },
    ...options?.models ? { models: options.models } : {}
  });
}
class PaddleOcrEngine {
  /** 引擎标识。 */
  id = "paddle";
  /** 已初始化的 ocr-node 实例。 */
  instance = null;
  /** 正在初始化的 Promise，防止并发重复初始化。 */
  loading = null;
  /** 可注入依赖。 */
  deps;
  /** ocr-node 加载的 ONNX 模型路径。 */
  models;
  /** 最近一次 runtime 初始化失败的语义化词条 key。 */
  unavailableReasonKey;
  /** 最近一次 runtime 初始化失败原因的插值参数。 */
  unavailableReasonParams;
  /**
   * 创建 PaddleOCR 引擎。
   * @param options 可注入依赖与模型路径；省略时使用默认值（生产环境）。
   * @author zhenghq
   */
  constructor(options) {
    const { models, ...deps } = options ?? {};
    this.deps = {
      writeFile: async (path, data) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, data);
      },
      unlink: async (path) => {
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(path);
        } catch {
        }
      },
      readFile: async (path) => {
        const { readFile } = await import("node:fs/promises");
        return readFile(path);
      },
      tmpDir: node_os.tmpdir,
      createOcrNode: defaultCreateOcrNode,
      ...deps
    };
    this.models = models;
  }
  /**
   * 检查 @gutenye/ocr-node 是否可加载。
   * 首次调用会尝试初始化，失败则返回 false。
   * @returns 是否可用。
   * @author zhenghq
   */
  async isAvailable() {
    try {
      await this.getOrCreate();
      this.unavailableReasonKey = void 0;
      this.unavailableReasonParams = void 0;
      return true;
    } catch (error2) {
      const message = error2 instanceof Error ? error2.message : String(error2);
      this.unavailableReasonKey = "ocr.error.paddleRuntimeInitFailed";
      this.unavailableReasonParams = { message };
      console.error("[ocr] PaddleOCR runtime 初始化失败:", message);
      return false;
    }
  }
  /**
   * 返回 PaddleOCR runtime 最近一次不可用原因。
   * @returns 不可用原因；尚未检测或可用时返回 undefined。
   * @author zhenghq
   */
  getUnavailableReason() {
    return this.unavailableReasonKey ? translateMain(this.unavailableReasonKey, this.unavailableReasonParams) : void 0;
  }
  /**
   * 惰性获取或创建 ocr-node 实例，防止并发重复初始化。
   * @returns ocr-node 实例。
   * @author zhenghq
   */
  async getOrCreate() {
    if (this.instance) return this.instance;
    if (this.loading) return this.loading;
    this.loading = this.deps.createOcrNode({
      onnxOptions: { executionProviders: ["cpu"] },
      ...this.models ? { models: this.models } : {}
    }).then((inst) => {
      this.instance = inst;
      return inst;
    }).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }
  /**
   * 使用 @gutenye/ocr-node 识别图片文字。
   * imageBytes 优先于 imagePath；结果经 normalizePaddleLines 规范化后返回。
   * @param input 识别输入。
   * @returns 识别结果。
   * @author zhenghq
   */
  async recognize(input) {
    const ocr = await this.getOrCreate();
    const timeoutMs = input.timeoutMs ?? 3e4;
    let imagePath;
    let tempPath;
    if (input.imageBytes && input.imageBytes.length > 0) {
      tempPath = node_path.join(
        this.deps.tmpDir(),
        `ocr-paddle-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`
      );
      await this.deps.writeFile(tempPath, Buffer.from(input.imageBytes));
      imagePath = tempPath;
    } else if (input.imagePath) {
      imagePath = input.imagePath;
    } else {
      throw new OcrEngineError("empty", translateMain("ocr.error.paddleMissingInput"), "paddle");
    }
    try {
      const raw = await withOcrTimeout(
        ocr.detect(imagePath),
        { timeoutMs, signal: input.signal, message: translateMain },
        "paddle"
      );
      const lines = normalizePaddleLines(raw);
      const restored = await this.restoreUnderlines(lines, input, imagePath);
      const text = restored.map((l) => l.text).join("\n");
      return { lines: restored, text, engine: "paddle" };
    } catch (error2) {
      if (error2 instanceof OcrEngineError) throw error2;
      const message = error2 instanceof Error ? error2.message : String(error2);
      if (/timeout/i.test(message)) {
        throw new OcrEngineError("timeout", translateMain("ocr.error.paddleTimeout"), "paddle");
      }
      throw new OcrEngineError(
        "engine-unavailable",
        translateMain("ocr.error.paddleFailed", { message }),
        "paddle"
      );
    } finally {
      if (tempPath) {
        await this.deps.unlink(tempPath);
      }
    }
  }
  /**
   * 按词间横线像素把 PaddleOCR 丢失为空格的下划线恢复出来。
   * 读取或解码图片失败时沿用原始 OCR 文本，不让增强逻辑影响主链路。
   * @param lines 规范化后的文本行。
   * @param input 识别输入。
   * @param imagePath 当前识别使用的图片路径。
   * @returns 恢复下划线后的文本行。
   * @author zhenghq
   */
  async restoreUnderlines(lines, input, imagePath) {
    if (!lines.some((line) => /\s/u.test(line.text))) return lines;
    try {
      const imageBytes = input.imageBytes && input.imageBytes.length > 0 ? input.imageBytes : await this.deps.readFile(imagePath);
      if (!imageBytes) return lines;
      const image = decodePng(imageBytes);
      let restoredCount = 0;
      const restored = lines.map((line) => {
        const text = restorePaddleOcrUnderlines(line.text, line.box, image);
        if (text === line.text) return line;
        restoredCount += (text.match(/_/gu)?.length ?? 0) - (line.text.match(/_/gu)?.length ?? 0);
        return { ...line, text };
      });
      if (restoredCount > 0) {
        console.log("[ocr] PaddleOCR 已按词间横线恢复下划线", { restoredCount });
      }
      return restored;
    } catch {
      return lines;
    }
  }
}
const GUTEN_PPOCRV4_METADATA = {
  name: "PP-OCRv4 ONNX",
  version: "@gutenye/ocr-models bundled",
  license: "MIT",
  distribution: "bundled",
  provider: "Guten OCR / PaddleOCR",
  source: {
    detection: "node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_det_infer.onnx",
    recognition: "node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_rec_infer.onnx",
    dictionary: "node_modules/@gutenye/ocr-models/assets/ppocr_keys_v1.txt"
  }
};
const GUTEN_PPOCRV4_RELATIVE_DIR = ["node_modules", "@gutenye", "ocr-models", "assets"];
const GUTEN_PPOCRV4_REQUIRED_FILES = [
  { name: "ch_PP-OCRv4_det_infer.onnx", minBytes: 4e6 },
  { name: "ch_PP-OCRv4_rec_infer.onnx", minBytes: 9e6 },
  { name: "ppocr_keys_v1.txt", minBytes: 2e4 }
];
function resolveOcrAssetRoot(appPath) {
  const normalized = String(appPath ?? "");
  return normalized.includes(".asar") ? normalized.replace(/\.asar(?=$|[\\/])/u, ".asar.unpacked") : normalized;
}
function findMissingModelFiles(modelDir, requiredFiles) {
  const missingFiles = [];
  for (const file of requiredFiles) {
    const filePath2 = node_path.join(modelDir, file.name);
    if (!node_fs.existsSync(filePath2)) {
      missingFiles.push(file.name);
      continue;
    }
    const size = node_fs.statSync(filePath2).size;
    if (size < file.minBytes) missingFiles.push(`${file.name}(${size}B)`);
  }
  return missingFiles;
}
function resolveBundledOcrModelAssets(appPath) {
  const modelDir = node_path.join(resolveOcrAssetRoot(appPath), ...GUTEN_PPOCRV4_RELATIVE_DIR);
  const missingFiles = findMissingModelFiles(modelDir, GUTEN_PPOCRV4_REQUIRED_FILES);
  const ready = missingFiles.length === 0;
  return {
    ready,
    modelDir,
    metadata: GUTEN_PPOCRV4_METADATA,
    models: ready ? {
      detectionPath: node_path.join(modelDir, "ch_PP-OCRv4_det_infer.onnx"),
      recognitionPath: node_path.join(modelDir, "ch_PP-OCRv4_rec_infer.onnx"),
      dictionaryPath: node_path.join(modelDir, "ppocr_keys_v1.txt")
    } : void 0,
    missingFiles,
    message: ready ? translateMain("ocr.model.gutenReady") : translateMain("ocr.model.gutenIncomplete", { files: missingFiles.join("、") })
  };
}
function tesseractLanguageTag(language) {
  if (!language || language === "auto") return "chi_sim+eng";
  const key = language.toLowerCase();
  if (key === "zh-hant" || key === "zh-tw" || key === "zht") return "chi_tra+eng";
  if (key.startsWith("zh")) return "chi_sim+eng";
  const map = {
    "en": "eng",
    "ja": "jpn+eng",
    "ko": "kor+eng",
    "ru": "rus+eng",
    "fr": "fra+eng",
    "de": "deu+eng",
    "es": "spa+eng",
    "it": "ita+eng",
    "pt": "por+eng",
    "ar": "ara+eng",
    "th": "tha+eng",
    "vi": "vie+eng",
    "id": "ind+eng"
  };
  return map[key] ?? "chi_sim+eng";
}
function normalizeTesseractLines(rawText) {
  if (!rawText || !rawText.trim()) return [];
  return rawText.split("\n").map((line) => line.trim()).filter(Boolean).map((text) => ({ text }));
}
function ensureTessDataDirectory(tessDataPath) {
  if (!tessDataPath) return;
  try {
    node_fs.mkdirSync(tessDataPath, { recursive: true });
  } catch {
  }
}
async function defaultCreateWorker(lang, tessDataPath, onProgress) {
  ensureTessDataDirectory(tessDataPath);
  const mod = await import("tesseract.js");
  const createWorker = mod.createWorker ?? mod.default?.createWorker;
  const worker = await createWorker(lang, 1, {
    cachePath: tessDataPath,
    logger: (message) => {
      if (!message?.status) return;
      if (!/loading language|recognizing text/iu.test(message.status)) return;
      const progress = Math.round((message.progress ?? 0) * 100);
      onProgress?.(message.status, progress || void 0);
    }
  });
  await worker.setParameters({
    tessedit_pageseg_mode: "6",
    preserve_interword_spaces: "1"
  });
  return worker;
}
class TesseractOcrEngine {
  /** 引擎标识。 */
  id = "tesseract";
  /** 按语言缓存的 worker 实例（key: Tesseract 语言字符串）。 */
  workerCache = /* @__PURE__ */ new Map();
  /** 可注入依赖。 */
  deps;
  /**
   * 创建 Tesseract OCR 引擎。
   * @param deps 可注入依赖；省略时使用默认值（生产环境）。
   * @author zhenghq
   */
  constructor(deps) {
    this.deps = {
      tessDataPath: "",
      createWorker: (lang) => defaultCreateWorker(lang, this.deps.tessDataPath, this.deps.onProgress),
      onProgress: void 0,
      ...deps
    };
  }
  /**
   * 判断 Tesseract.js 是否可加载。
   * 尝试动态 import tesseract.js 模块，失败则返回 false。
   * @returns 是否可用。
   * @author zhenghq
   */
  async isAvailable() {
    try {
      await import("tesseract.js");
      return true;
    } catch {
      return false;
    }
  }
  /**
   * 惰性获取或创建指定语言的 Tesseract worker，按语言字符串缓存。
   * @param lang Tesseract 语言字符串。
   * @returns worker 实例。
   * @author zhenghq
   */
  getOrCreateWorker(lang) {
    if (!this.workerCache.has(lang)) {
      const created = this.deps.createWorker(lang).catch((error2) => {
        this.workerCache.delete(lang);
        throw error2;
      });
      this.workerCache.set(lang, created);
    }
    return this.workerCache.get(lang);
  }
  /**
   * 使用 Tesseract.js 识别图片文字。
   * imageBytes 优先于 imagePath；结果经 normalizeTesseractLines 规范化后返回。
   * @param input 识别输入（图片字节或路径）。
   * @returns 识别结果。
   * @author zhenghq
   */
  async recognize(input) {
    const hasBytes = Boolean(input.imageBytes && input.imageBytes.length > 0);
    const hasPath = typeof input.imagePath === "string" && input.imagePath.trim() !== "";
    if (!hasBytes && !hasPath) {
      throw new OcrEngineError(
        "engine-unavailable",
        translateMain("ocr.error.tesseractMissingInput"),
        "tesseract"
      );
    }
    const lang = tesseractLanguageTag(input.language ?? "auto");
    const timeoutMs = input.timeoutMs ?? 6e4;
    try {
      const worker = await this.getOrCreateWorker(lang);
      const imageInput = hasBytes ? Buffer.from(input.imageBytes) : input.imagePath;
      const { data } = await withOcrTimeout(
        worker.recognize(imageInput),
        { timeoutMs, signal: input.signal, message: translateMain },
        "tesseract"
      );
      const lines = normalizeTesseractLines(data.text);
      const text = lines.map((l) => l.text).join("\n");
      return { lines, text, engine: "tesseract" };
    } catch (error2) {
      if (error2 instanceof OcrEngineError) throw error2;
      const message = error2 instanceof Error ? error2.message : String(error2);
      if (/timeout/i.test(message)) {
        throw new OcrEngineError("timeout", translateMain("ocr.error.tesseractTimeout"), "tesseract");
      }
      if (/traineddata|fetch|download|network/i.test(message)) {
        throw new OcrEngineError(
          "engine-unavailable",
          translateMain("ocr.error.tesseractModelDownloadFailed"),
          "tesseract"
        );
      }
      if (/terminated/i.test(message)) {
        throw new OcrEngineError(
          "engine-unavailable",
          translateMain("ocr.error.tesseractInterrupted"),
          "tesseract"
        );
      }
      throw new OcrEngineError(
        "engine-unavailable",
        translateMain("ocr.error.tesseractFailed", { message }),
        "tesseract"
      );
    }
  }
  /**
   * 释放所有缓存的 Tesseract worker，供应用退出时调用。
   * @returns 无返回值。
   * @author zhenghq
   */
  async dispose() {
    const workers = [...this.workerCache.values()];
    this.workerCache.clear();
    await Promise.allSettled(
      workers.map(async (wp) => {
        try {
          const w = await wp;
          await w.terminate();
        } catch {
        }
      })
    );
  }
}
const OCR_FALLBACK_TARGET_PIXELS = 1e6;
const OCR_FALLBACK_MIN_EFFECTIVE_SCALE = 1.15;
function normalizeOcrScale(scale) {
  return Math.min(3, Math.max(1, Number(scale) || 1));
}
function selectAdaptiveOcrFallback(width, height, maxScale) {
  const requestedScale = normalizeOcrScale(maxScale);
  const sourcePixels = Math.max(0, width) * Math.max(0, height);
  if (sourcePixels <= 0 || sourcePixels >= OCR_FALLBACK_TARGET_PIXELS) {
    return { strategy: "contrast-enhance", requestedScale, actualScale: 1 };
  }
  const targetScale = Math.sqrt(OCR_FALLBACK_TARGET_PIXELS / sourcePixels);
  const budgetScale = Math.sqrt(MAX_OCR_PIXELS / sourcePixels);
  const actualScale = Math.min(requestedScale, targetScale, budgetScale);
  if (actualScale < OCR_FALLBACK_MIN_EFFECTIVE_SCALE) {
    return { strategy: "contrast-enhance", requestedScale, actualScale: 1 };
  }
  return { strategy: "moderate-scale", requestedScale, actualScale };
}
function preprocessOcrBaselineImageBytes(imageBytes) {
  return preprocessOcrImageBytes(imageBytes, 1);
}
function createAdaptiveOcrFallbackImageBytes(imageBytes, maxScale) {
  const image = decodePng(imageBytes);
  const selection = selectAdaptiveOcrFallback(image.width, image.height, maxScale);
  const candidate = selection.strategy === "moderate-scale" ? resizeRgbaForOcr(image, selection.actualScale) : enhanceRgbaForOcr(resizeRgbaForOcr(image, 1));
  return { ...selection, imageBytes: encodePng(candidate) };
}
function preprocessOcrImageBytes(imageBytes, scale) {
  try {
    const image = decodePng(imageBytes);
    const resized = resizeRgbaForOcr(image, scale);
    if (resized === image) return Buffer.from(imageBytes);
    return encodePng(resized);
  } catch {
    return Buffer.from(imageBytes);
  }
}
function logAdaptiveOcrDiagnostic(diagnostic) {
  console.info("[ocr-adaptive]", diagnostic);
}
function getFallbackReason(quality) {
  if (!quality.valid) return "invalid-baseline";
  if (quality.languageMismatch) return "language-mismatch";
  if (quality.averageConfidence !== void 0 && quality.averageConfidence < 0.6) {
    return "low-confidence";
  }
  return "low-text-quality";
}
function isOcrTimeout(error2) {
  return error2 instanceof OcrEngineError && error2.code === "timeout";
}
async function recognizeAdaptiveOcr(options, deps) {
  const createBaseline = deps.createBaseline ?? preprocessOcrBaselineImageBytes;
  const createFallback = deps.createFallback ?? createAdaptiveOcrFallbackImageBytes;
  const logger = deps.logger ?? logAdaptiveOcrDiagnostic;
  const now = deps.now ?? Date.now;
  let baseline;
  let baselineQuality;
  let baselineError;
  let fallbackImage;
  try {
    baseline = await deps.recognize(createBaseline(options.imageBytes));
    baselineQuality = evaluateOcrQuality(baseline, options.language);
    if (canSafelyAcceptOcrResult(baseline, options.language)) return baseline;
  } catch (error2) {
    if (isOcrTimeout(error2)) throw error2;
    baselineError = error2;
  }
  const reason = baselineQuality ? getFallbackReason(baselineQuality) : "baseline-failed";
  logger({ event: "fallback-triggered", reason, baselineQuality });
  const fallbackStartedAt = now();
  try {
    fallbackImage = createFallback(options.imageBytes, options.maxScale);
    const fallback = await deps.recognize(fallbackImage.imageBytes);
    const fallbackQuality = evaluateOcrQuality(fallback, options.language);
    const selected = baseline && baselineQuality ? compareOcrQuality(fallbackQuality, baselineQuality) > 0 ? "fallback" : "baseline" : fallbackQuality.valid ? "fallback" : void 0;
    logger({
      event: "fallback-completed",
      reason,
      strategy: fallbackImage.strategy,
      requestedScale: fallbackImage.requestedScale,
      actualScale: fallbackImage.actualScale,
      baselineQuality,
      fallbackQuality,
      elapsedMs: Math.max(0, now() - fallbackStartedAt),
      selected
    });
    if (selected === "fallback") return fallback;
    if (baseline) return baseline;
  } catch (fallbackError) {
    logger({
      event: "fallback-failed",
      reason,
      strategy: fallbackImage?.strategy,
      requestedScale: fallbackImage?.requestedScale,
      actualScale: fallbackImage?.actualScale,
      baselineQuality,
      elapsedMs: Math.max(0, now() - fallbackStartedAt),
      selected: baseline ? "baseline" : void 0
    });
    if (baseline) return baseline;
    throw baselineError ?? fallbackError;
  }
  throw baselineError;
}
function shortHash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
function isValidRect(rect) {
  if (!rect || typeof rect !== "object") return false;
  const value = rect;
  return [value.x, value.y, value.width, value.height].every((part) => Number.isFinite(part)) && Number(value.width) > 0 && Number(value.height) > 0;
}
function isWebImageCandidate(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  return typeof candidate.imageId === "string" && candidate.imageId !== "" && isWebImageKind(candidate.kind) && typeof candidate.selector === "string" && candidate.selector !== "" && isValidRect(candidate.rect);
}
function buildWebImageId(candidate) {
  const rect = candidate.rect;
  return `web-image-${shortHash(JSON.stringify([
    candidate.selector,
    candidate.kind,
    candidate.shadowPath ?? [],
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.width),
    Math.round(rect.height),
    candidate.sourceFingerprint ?? ""
  ]))}`;
}
function meetsMinimumSize(candidate, minSize) {
  const limit = Math.max(0, minSize);
  return candidate.rect.width >= limit && candidate.rect.height >= limit;
}
function filterWebImageCandidates(candidates, options) {
  const maxImages = Math.max(0, Math.floor(options.maxImages));
  const accepted = [];
  const seen = /* @__PURE__ */ new Set();
  let skipped = 0;
  for (const candidate of candidates) {
    if (!isWebImageCandidate(candidate) || candidate.decorative || !meetsMinimumSize(candidate, options.minSize)) {
      skipped += 1;
      continue;
    }
    const id = candidate.imageId || buildWebImageId(candidate);
    if (seen.has(id)) {
      skipped += 1;
      continue;
    }
    if (accepted.length >= maxImages) {
      skipped += 1;
      continue;
    }
    seen.add(id);
    accepted.push(candidate);
  }
  return { accepted, skipped };
}
function selectWebImageSourceStrategy(candidate) {
  if (candidate.kind === "canvas" || candidate.inline || candidate.requestBlocked) return "capture";
  if (typeof candidate.src !== "string" || candidate.src.trim() === "") return "capture";
  return "session";
}
function resolveWebImageRenderDecision(candidate, mode, placement) {
  if (mode === "source") return "none";
  const hasOcr = typeof candidate.ocrText === "string" && candidate.ocrText.trim() !== "";
  const hasTranslation = typeof candidate.translation === "string" && candidate.translation.trim() !== "";
  if (!hasOcr || !hasTranslation) return "none";
  if (mode === "bilingual") return "bilingual";
  return placement === "overlay" ? "overlay" : "below";
}
function summarizeWebImageProgress(candidates) {
  let imageProcessed = 0;
  let imageSkipped = 0;
  let imageFailed = 0;
  for (const candidate of candidates) {
    if (typeof candidate.translation === "string" && candidate.translation.trim() !== "") imageProcessed += 1;
    else if (candidate.skippedReason) imageSkipped += 1;
    else if (candidate.error) imageFailed += 1;
  }
  return {
    imageCandidates: candidates.length,
    imageProcessed,
    imageSkipped,
    imageFailed
  };
}
function isAborted(signal) {
  return Boolean(signal?.aborted);
}
const RASTER_IMAGE_CONTENT_TYPES = /* @__PURE__ */ new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/heif"
]);
function isRasterImageContentType(contentType) {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  if (!normalized) return true;
  return RASTER_IMAGE_CONTENT_TYPES.has(normalized);
}
function isValidImageResponse(response, maxBytes, maxPixels) {
  const bytes = response.bytes;
  if (!bytes || bytes.length === 0) return false;
  if (bytes.length > maxBytes) return false;
  if (!isRasterImageContentType(response.contentType ?? "")) return false;
  const width = Number(response.width) || 0;
  const height = Number(response.height) || 0;
  if (width > 0 && height > 0 && width * height > maxPixels) return false;
  return true;
}
function createWebImageSource(deps) {
  const maxBytes = Math.max(1, Math.floor(deps.maxBytes));
  const maxPixels = Math.max(1, Math.floor(deps.maxPixels));
  const normalizeRect = (rect) => ({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  });
  const isWithinViewport = (rect, viewport) => rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
  return {
    async fetch(candidate) {
      const strategy = selectWebImageSourceStrategy(candidate);
      if (isAborted(deps.signal)) return { ok: false, strategy, reason: "cancelled" };
      if (strategy === "session" && candidate.src) {
        try {
          const response = await deps.requestImage(candidate.src, deps.signal);
          if (isAborted(deps.signal)) return { ok: false, strategy, reason: "cancelled" };
          if (isValidImageResponse(response, maxBytes, maxPixels)) {
            return { ok: true, strategy, bytes: Buffer.from(response.bytes) };
          }
          if (response.bytes && response.bytes.length > maxBytes) {
            return { ok: false, strategy: "capture", reason: "too-large" };
          }
        } catch {
        }
      }
      if (isAborted(deps.signal)) return { ok: false, strategy: "capture", reason: "cancelled" };
      if (candidate.kind === "canvas" && deps.readCanvasImage) {
        try {
          const exported = await deps.readCanvasImage(candidate);
          if (isAborted(deps.signal)) return { ok: false, strategy: "capture", reason: "cancelled" };
          if (exported && isValidImageResponse(exported, maxBytes, maxPixels)) {
            return { ok: true, strategy: "capture", bytes: Buffer.from(exported.bytes) };
          }
        } catch {
        }
      }
      if (isAborted(deps.signal)) return { ok: false, strategy: "capture", reason: "cancelled" };
      const originalViewport = deps.resolveViewport ? await deps.resolveViewport().catch(() => null) : null;
      const viewportRect = originalViewport ? {
        ...normalizeRect(candidate.rect),
        x: normalizeRect(candidate.rect).x - Math.round(originalViewport.scrollX),
        y: normalizeRect(candidate.rect).y - Math.round(originalViewport.scrollY)
      } : normalizeRect(candidate.rect);
      const alreadyVisible = !originalViewport || isWithinViewport(viewportRect, originalViewport);
      if (!alreadyVisible && deps.revealVisibleRect) {
        let revealed = null;
        try {
          revealed = await deps.revealVisibleRect(candidate);
        } catch {
          revealed = null;
        }
        if (!revealed) {
          await deps.restoreRevealed?.().catch(() => void 0);
          return { ok: false, strategy: "capture", reason: "capture-failed" };
        }
        try {
          const bytes = await deps.captureRegion(normalizeRect(revealed), deps.signal);
          if (isAborted(deps.signal)) return { ok: false, strategy: "capture", reason: "cancelled" };
          if (!bytes || bytes.length === 0) return { ok: false, strategy: "capture", reason: "capture-failed" };
          if (bytes.length > maxBytes) return { ok: false, strategy: "capture", reason: "too-large" };
          return { ok: true, strategy: "capture", bytes: Buffer.from(bytes) };
        } catch {
          return { ok: false, strategy: "capture", reason: "capture-failed" };
        } finally {
          await deps.restoreRevealed?.().catch(() => void 0);
        }
      }
      let scrollRect = viewportRect;
      let scrolled = false;
      if (originalViewport) {
        if (!isWithinViewport(scrollRect, originalViewport)) {
          if (!deps.scrollIntoView) return { ok: false, strategy: "capture", reason: "capture-failed" };
          let scrolledOk = false;
          try {
            scrolledOk = await deps.scrollIntoView(normalizeRect(candidate.rect));
          } catch {
            scrolledOk = false;
          }
          if (!scrolledOk) return { ok: false, strategy: "capture", reason: "capture-failed" };
          scrolled = true;
          const scrolledViewport = await deps.resolveViewport?.().catch(() => null) ?? null;
          if (!scrolledViewport) return { ok: false, strategy: "capture", reason: "capture-failed" };
          scrollRect = {
            ...normalizeRect(candidate.rect),
            x: normalizeRect(candidate.rect).x - Math.round(scrolledViewport.scrollX),
            y: normalizeRect(candidate.rect).y - Math.round(scrolledViewport.scrollY)
          };
          if (!isWithinViewport(scrollRect, scrolledViewport)) {
            await deps.restoreScroll?.(originalViewport.scrollX, originalViewport.scrollY).catch(() => void 0);
            return { ok: false, strategy: "capture", reason: "capture-failed" };
          }
        }
      }
      try {
        const bytes = await deps.captureRegion(scrollRect, deps.signal);
        if (isAborted(deps.signal)) return { ok: false, strategy: "capture", reason: "cancelled" };
        if (!bytes || bytes.length === 0) return { ok: false, strategy: "capture", reason: "capture-failed" };
        if (bytes.length > maxBytes) return { ok: false, strategy: "capture", reason: "too-large" };
        return { ok: true, strategy: "capture", bytes: Buffer.from(bytes) };
      } catch {
        return { ok: false, strategy: "capture", reason: "capture-failed" };
      } finally {
        if (scrolled && originalViewport) {
          await deps.restoreScroll?.(originalViewport.scrollX, originalViewport.scrollY).catch(() => void 0);
        }
      }
    }
  };
}
function formatBounds(bounds) {
  const round = (value) => Math.round(value);
  return [round(bounds.x), round(bounds.y), round(bounds.width), round(bounds.height)].join(",");
}
function buildOcrSessionResultKey(sessionId, bounds, settings) {
  const fingerprint = [
    settings.ocrLang,
    String(settings.ocrScale),
    settings.ocrEnginePreference,
    settings.ocrTesseractEnabled ? "1" : "0"
  ].join("|");
  return `${sessionId}|${formatBounds(bounds)}|${fingerprint}`;
}
class OcrSessionResultCache {
  entry = null;
  /**
   * 读取指定键的识别结果。
   * @param key 缓存键。
   * @returns 命中的识别结果；键不匹配时返回 null。
   * @author zhenghq
   */
  get(key) {
    if (!this.entry || this.entry.key !== key) return null;
    return this.entry.result;
  }
  /**
   * 写入识别结果并覆盖旧条目。
   * @param key 缓存键。
   * @param result 识别动作产出的结果。
   * @returns 无返回值。
   * @author zhenghq
   */
  set(key, result) {
    this.entry = { key, result };
  }
  /**
   * 清空缓存；在会话终止或结果被消费后调用。
   * @returns 无返回值。
   * @author zhenghq
   */
  clear() {
    this.entry = null;
  }
  /** 当前缓存条目数，恒为 0 或 1。 */
  get size() {
    return this.entry ? 1 : 0;
  }
}
const SCREENSHOT_EXPORT_LIMITS = {
  /** 导出图片最大宽度。 */
  maxWidth: 16e3,
  /** 导出图片最大高度。 */
  maxHeight: 16e3,
  /** 导出 PNG 最大字节数。 */
  maxBytes: 24 * 1024 * 1024
};
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function isExportAction(value) {
  return value === "copy-image" || value === "save-image";
}
function isValidBounds(value) {
  if (!value || typeof value !== "object") return false;
  const raw = value;
  return Number.isFinite(raw.x) && Number.isFinite(raw.y) && Number.isFinite(raw.width) && Number.isFinite(raw.height) && raw.width > 0 && raw.height > 0;
}
function validateAnnotatedExportPayload(value) {
  if (!value || typeof value !== "object") {
    return {
      ok: false,
      code: "invalid-export-payload",
      error: translateMain("capture.error.exportRequestInvalid")
    };
  }
  const raw = value;
  if (!isExportAction(raw.action)) {
    return {
      ok: false,
      code: "invalid-export-payload",
      error: translateMain("capture.error.exportActionInvalid")
    };
  }
  if (typeof raw.requestId !== "string" || !raw.requestId.trim()) {
    return {
      ok: false,
      code: "invalid-export-payload",
      error: translateMain("capture.error.exportRequestIdInvalid")
    };
  }
  if (!Number.isInteger(raw.sessionId) || raw.sessionId <= 0) {
    return {
      ok: false,
      code: "invalid-export-payload",
      error: translateMain("capture.error.exportSessionInvalid")
    };
  }
  if (!isValidBounds(raw.bounds)) {
    return {
      ok: false,
      code: "invalid-export-payload",
      error: translateMain("capture.error.exportBoundsInvalid")
    };
  }
  if (!Number.isFinite(raw.width) || !Number.isFinite(raw.height) || raw.width <= 0 || raw.height <= 0 || raw.width > SCREENSHOT_EXPORT_LIMITS.maxWidth || raw.height > SCREENSHOT_EXPORT_LIMITS.maxHeight) {
    return {
      ok: false,
      code: "invalid-export-payload",
      error: translateMain("capture.error.exportDimensionsInvalid")
    };
  }
  const png = Buffer.isBuffer(raw.png) ? raw.png : raw.png instanceof Uint8Array ? Buffer.from(raw.png) : null;
  if (!png || png.length < PNG_SIGNATURE.length || png.length > SCREENSHOT_EXPORT_LIMITS.maxBytes) {
    return {
      ok: false,
      code: "invalid-export-payload",
      error: translateMain("capture.error.exportDataInvalid")
    };
  }
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return {
      ok: false,
      code: "invalid-export-payload",
      error: translateMain("capture.error.exportPngRequired")
    };
  }
  return {
    ok: true,
    request: {
      action: raw.action,
      sessionId: raw.sessionId,
      requestId: raw.requestId,
      bounds: {
        x: Number(raw.bounds.x),
        y: Number(raw.bounds.y),
        width: Number(raw.bounds.width),
        height: Number(raw.bounds.height)
      },
      width: Math.round(raw.width),
      height: Math.round(raw.height),
      png
    }
  };
}
async function translateOcrResult(ocrResult, settings, deps) {
  const cleaned = cleanOcrText(ocrResult.text ?? "");
  const score = scoreOcrText(cleaned);
  const base = {
    ocrText: cleaned,
    ocrRawText: ocrResult.text ?? "",
    ocrScore: score,
    ocrEngine: ocrResult.engine
  };
  if (!cleaned) {
    return { ...base, ocrCode: "empty" };
  }
  if (isMostlyNoise(cleaned)) {
    return { ...base, ocrCode: "noise" };
  }
  if (deps.signal?.aborted) {
    return { ...base, ocrCode: "cancelled" };
  }
  try {
    const pair = resolveLanguagePair(cleaned, settings.sourceLang, settings.targetLang);
    const requestSettings = {
      ...settings,
      sourceLang: pair.sourceLang,
      targetLang: pair.targetLang
    };
    const translateResult = await deps.translate(cleaned, requestSettings, null, null);
    return {
      ...base,
      translation: translateResult.translation,
      detectedLang: translateResult.detectedLang,
      provider: translateResult.provider,
      channel: translateResult.channel
    };
  } catch (error2) {
    const message = error2 instanceof Error ? error2.message : String(error2);
    return { ...base, error: message };
  }
}
function readClipboardImage(clipboard) {
  const image = clipboard.readImage();
  if (image && !image.isEmpty()) {
    return { kind: "image", png: image.toPNG() };
  }
  const text = clipboard.readText("");
  if (text.trim()) return { kind: "text" };
  return { kind: "empty" };
}
const WEB_TRANSLATION_MAX_CHARS_PER_SEGMENT = 5e3;
const WEB_TRANSLATION_DEFAULT_MAX_SEGMENTS_PER_BATCH = 5;
const SEGMENT_MARKER_TEST = /\[\[\[\s*ST-SEG-\d+\s*\]\]\]/u;
function segmentMarker(index) {
  return `
[[[ST-SEG-${index}]]]
`;
}
function buildWebTranslationBatches(segments, options) {
  const maxChars = Math.max(1, Math.floor(options.maxChars));
  const configuredSegments = options.maxBlocksPerBatch ?? WEB_TRANSLATION_DEFAULT_MAX_SEGMENTS_PER_BATCH;
  const maxSegments = Math.max(1, Math.floor(configuredSegments));
  const batches = [];
  let pending = [];
  let pendingText = "";
  const flush = () => {
    if (pending.length === 0) return;
    batches.push(createWebTranslationBatch(pending, pendingText));
    pending = [];
    pendingText = "";
  };
  for (const segment of segments) {
    if (SEGMENT_MARKER_TEST.test(segment.text)) {
      flush();
      batches.push(createWebTranslationBatch([segment], segment.text));
      continue;
    }
    const candidate = pending.length === 0 ? segment.text : `${pendingText}${segmentMarker(pending.length - 1)}${segment.text}`;
    if (pending.length > 0 && (candidate.length > maxChars || pending.length >= maxSegments)) {
      flush();
      pending = [segment];
      pendingText = segment.text;
      continue;
    }
    pending.push(segment);
    pendingText = candidate;
  }
  flush();
  return batches;
}
function createWebTranslationBatch(segments, text) {
  return {
    batchId: segments.map((segment) => segment.segmentId).join("|"),
    segments: segments.slice(),
    text,
    mergeable: segments.length > 1
  };
}
function parseMergedTranslation(batch, translation) {
  if (batch.segments.length <= 1) return [translation.trim()];
  const count = batch.segments.length;
  const pattern = /\[\[\[\s*ST-SEG-(\d+)\s*\]\]\]/gu;
  const markers = [];
  let match;
  while ((match = pattern.exec(translation)) !== null) {
    markers.push({ index: Number(match[1]), start: match.index, end: match.index + match[0].length });
  }
  if (markers.length !== count - 1 && markers.length !== count) return null;
  for (let index = 0; index < markers.length; index += 1) {
    if (markers[index].index !== index) return null;
  }
  const parts = [];
  let lastIndex = 0;
  for (let index = 0; index < count - 1; index += 1) {
    parts.push(translation.slice(lastIndex, markers[index].start));
    lastIndex = markers[index].end;
  }
  if (markers.length === count) {
    if (translation.slice(markers[count - 1].end).trim() !== "") return null;
    parts.push(translation.slice(lastIndex, markers[count - 1].start));
  } else {
    parts.push(translation.slice(lastIndex));
  }
  return parts.map((part) => part.trim());
}
function splitText(text, maxChars, locale) {
  if (text.length <= maxChars) return [text];
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(locale, { granularity: "sentence" }) : void 0;
  const sentences = segmenter ? Array.from(segmenter.segment(text), (item) => item.segment) : text.split(/(?<=[。！？.!?])(?=\s|$)/u);
  const parts = [];
  let current = "";
  const append = (piece) => {
    if (!piece) return;
    if (piece.length > maxChars) {
      if (current) {
        parts.push(current);
        current = "";
      }
      for (let offset = 0; offset < piece.length; offset += maxChars) {
        parts.push(piece.slice(offset, offset + maxChars));
      }
      return;
    }
    if (current && current.length + piece.length > maxChars) {
      parts.push(current);
      current = "";
    }
    current += piece;
  };
  for (const sentence of sentences) append(sentence);
  if (current) parts.push(current);
  return parts.length ? parts : [text];
}
function splitWebTextBlocks(blocks, options) {
  return splitWebTextUnits(blocks.map((block) => ({
    id: block.id,
    blockId: block.id,
    sourceText: block.text,
    text: block.text,
    anchor: { parentSelector: block.anchor.selector, textNodeIndex: 0, sourceFingerprint: block.anchor.textFingerprint },
    category: block.category,
    ...block.language ? { language: block.language } : {}
  })), options);
}
function splitWebTextUnits(units, options) {
  const maxChars = Math.max(1, Math.floor(options.maxChars));
  const segments = [];
  const unitsByBlock = /* @__PURE__ */ new Map();
  for (const unit of units) {
    const list = unitsByBlock.get(unit.blockId);
    if (list) list.push(unit);
    else unitsByBlock.set(unit.blockId, [unit]);
  }
  for (const blockUnits of unitsByBlock.values()) {
    const text = blockUnits.map((unit) => unit.sourceText).join("").replace(/\s+/gu, " ").trim();
    if (!text) continue;
    const primary = blockUnits[0];
    const parts = splitText(text, maxChars, options.locale);
    parts.forEach((part, index) => {
      segments.push({
        unitId: primary.id,
        blockId: primary.blockId,
        unitIds: blockUnits.map((unit) => unit.id),
        segmentId: `${primary.id}:${index}`,
        index,
        segmentTotal: parts.length,
        text: part
      });
    });
  }
  return segments;
}
const ISOLATED_SKIP_MAX_LENGTH = 40;
function normalizeText(value) {
  return value.replace(/\s+/gu, " ").trim();
}
function hasWhitespace(value) {
  return /\s/u.test(value);
}
function resolveWebBilingualRenderKind(input) {
  const { block, units } = input;
  if (units.some((unit) => unit.anchor.semanticAttribute)) return "skip";
  if (units.some((unit) => unit.anchor.shadowPath !== void 0)) return "skip";
  if (block.type === "button" || block.type === "navigation") return "skip";
  if (block.category === "isolated" && normalizeText(block.text).length <= ISOLATED_SKIP_MAX_LENGTH) {
    return "skip";
  }
  return "inline";
}
function composeWebBilingualText(units, translations) {
  let composed = "";
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const translation = normalizeText(translations.get(unit.id) ?? "");
    if (!translation) continue;
    if (composed) {
      const previous = units[index - 1];
      const separator = hasWhitespace(previous.sourceText.slice(-1)) || hasWhitespace(unit.sourceText.slice(0, 1)) ? " " : "";
      composed += separator;
    }
    composed += translation;
  }
  return composed;
}
function buildWebBilingualOperations(input) {
  const unitsByBlock = /* @__PURE__ */ new Map();
  for (const unit of input.units) {
    const list = unitsByBlock.get(unit.blockId);
    if (list) list.push(unit);
    else unitsByBlock.set(unit.blockId, [unit]);
  }
  const operations = [];
  let skipped = 0;
  let unrendered = 0;
  const handledBlocks = /* @__PURE__ */ new Set();
  for (const block of input.blocks) {
    handledBlocks.add(block.id);
    const units = unitsByBlock.get(block.id) ?? [];
    if (units.length === 0) {
      unrendered += 1;
      continue;
    }
    if (resolveWebBilingualRenderKind({ block, units }) === "skip") {
      skipped += 1;
      continue;
    }
    const complete = units.every((unit) => typeof input.translations.get(unit.id) === "string");
    if (!complete) {
      unrendered += 1;
      continue;
    }
    const translation = composeWebBilingualText(units, input.translations);
    if (!translation) {
      unrendered += 1;
      continue;
    }
    operations.push({ blockId: block.id, selector: block.anchor.selector, translation });
  }
  for (const blockId of unitsByBlock.keys()) {
    if (!handledBlocks.has(blockId)) unrendered += 1;
  }
  return { operations, skipped, unrendered };
}
const WEB_IMAGE_TRANSLATION_MAX_CHARS = 1800;
function mergeWebImageResults(existing, processed) {
  const processedById = new Map(processed.map((candidate) => [candidate.imageId, candidate]));
  const existingIds = new Set(existing.map((candidate) => candidate.imageId));
  const merged = existing.map((candidate) => processedById.get(candidate.imageId) ?? candidate);
  for (const candidate of processed) {
    if (existingIds.has(candidate.imageId)) continue;
    existingIds.add(candidate.imageId);
    merged.push(candidate);
  }
  return merged;
}
async function processWebImageCandidates(candidates, deps) {
  const minScore = Number.isFinite(deps.minScore) ? Number(deps.minScore) : 0.35;
  const configuredMaxChars = Number.isFinite(deps.maxCharsPerRequest) ? Number(deps.maxCharsPerRequest) : WEB_IMAGE_TRANSLATION_MAX_CHARS;
  const maxCharsPerRequest = Math.max(1, Math.floor(configuredMaxChars));
  const results = [];
  let cancelled = false;
  for (const candidate of candidates) {
    if (deps.signal?.aborted) {
      cancelled = true;
      results.push({ ...candidate, skippedReason: "cancelled" });
      continue;
    }
    const fetched = await deps.source.fetch(candidate);
    if (deps.signal?.aborted) {
      cancelled = true;
      results.push({ ...candidate, skippedReason: "cancelled" });
      continue;
    }
    if (!fetched.ok || !fetched.bytes) {
      results.push({ ...candidate, skippedReason: fetched.reason ?? "fetch-failed" });
      continue;
    }
    let recognition;
    try {
      recognition = await deps.recognize(fetched.bytes, candidate);
    } catch {
      results.push({ ...candidate, error: "ocr-failed" });
      continue;
    }
    const text = String(recognition.text || "").trim();
    if (!text) {
      results.push({ ...candidate, skippedReason: "no-text" });
      continue;
    }
    if (!Number.isFinite(recognition.score) || recognition.score < minScore) {
      results.push({ ...candidate, ocrText: text, skippedReason: "low-quality" });
      continue;
    }
    const parts = splitText(text, maxCharsPerRequest, deps.sourceLang === "auto" ? void 0 : deps.sourceLang);
    try {
      const translations = [];
      for (const part of parts) {
        const translated = await deps.translate(part, candidate);
        const translation = String(translated.translation || "").trim();
        if (!translation) throw new Error("translate-failed");
        translations.push(translation);
      }
      results.push({ ...candidate, ocrText: text, translation: translations.join("\n") });
    } catch (error2) {
      results.push({
        ...candidate,
        ocrText: text,
        error: error2 instanceof Error && error2.message ? error2.message : "translate-failed"
      });
    }
  }
  return {
    candidates: results,
    summary: summarizeWebImageProgress(results),
    cancelled
  };
}
const WEB_TRANSLATION_MERGED_BATCH_MAX_CHARS = 1800;
class PageTranslationCoordinator {
  getConcurrency;
  translate;
  invalidJobs = /* @__PURE__ */ new Set();
  activeStreams = /* @__PURE__ */ new Set();
  /**
   * 创建页面翻译协调器。
   * @param options 并发数量与单段翻译器。
   * @author zhenghq
   */
  constructor(options) {
    const configured = options.concurrency;
    const read = typeof configured === "function" ? configured : () => configured ?? 3;
    this.getConcurrency = () => {
      const numeric = Number(read());
      if (!Number.isFinite(numeric)) return 3;
      return Math.max(1, Math.min(8, Math.floor(numeric)));
    };
    this.translate = options.translate;
  }
  /**
   * 使指定任务失效，迟到的网络结果不会再写入当前页面。
   * @param readerId 阅读器标识。
   * @param pageRevision 页面版本。
   * @param jobId 任务标识。
   * @param sourceLang 可选源语言，用于精确失效语言方向。
   * @param targetLang 可选目标语言，用于精确失效语言方向。
   * @returns 无返回值。
   * @author zhenghq
   */
  invalidate(readerId, pageRevision, jobId, sourceLang, targetLang) {
    const exact = this.key(readerId, pageRevision, jobId, sourceLang, targetLang);
    const legacy = this.key(readerId, pageRevision, jobId);
    this.invalidJobs.add(exact);
    if (!sourceLang && !targetLang) this.invalidJobs.add(legacy);
    for (const stream of this.activeStreams) {
      if (stream.key === exact || stream.legacyKey === legacy) stream.cancel();
    }
  }
  /**
   * 创建可在页面加载期间持续追加文本单元的翻译任务。
   * @param job 页面任务代次与保护配置。
   * @param onProgress 动态进度回调。
   * @param signal 外部取消信号。
   * @param onResult 单个分段完成回调。
   * @returns 可追加、关闭并等待最终结果的流式任务。
   * @author zhenghq
   */
  createStream(job, onProgress, signal, onResult) {
    const key = this.key(job.readerId, job.pageRevision, job.jobId, job.sourceLang, job.targetLang);
    const legacyKey = this.key(job.readerId, job.pageRevision, job.jobId);
    this.invalidJobs.delete(key);
    this.invalidJobs.delete(legacyKey);
    const queue = [];
    const results = [];
    const seenUnits = /* @__PURE__ */ new Set();
    const unitSegmentTotals = /* @__PURE__ */ new Map();
    const unitSegmentDone = /* @__PURE__ */ new Map();
    let acceptedUnits = 0;
    let acceptedChars = 0;
    let active = 0;
    let pendingWriteBacks = 0;
    let writeBackChain = Promise.resolve();
    let done = 0;
    let failed = 0;
    let truncated = false;
    let cancelled = false;
    let inputClosed = false;
    let settled = false;
    let mergeUnsupported = false;
    let resolveResult = () => void 0;
    const result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    const isStale = () => cancelled || signal?.aborted === true || this.invalidJobs.has(key) || this.invalidJobs.has(legacyKey);
    const snapshot = () => ({
      jobId: job.jobId,
      pageRevision: job.pageRevision,
      discovered: done + active + queue.length,
      queued: queue.length,
      done,
      total: done + active + queue.length,
      failed,
      cancelled,
      partial: truncated || failed > 0 || cancelled,
      inputClosed
    });
    const emit = () => {
      if (!this.invalidJobs.has(key) && !this.invalidJobs.has(legacyKey)) onProgress?.(snapshot());
    };
    const finishIfReady = () => {
      if (settled || !inputClosed || active > 0 || queue.length > 0) return;
      if (!cancelled && pendingWriteBacks > 0) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      this.activeStreams.delete(activeStream);
      const progress = snapshot();
      resolveResult({
        readerId: job.readerId,
        pageRevision: job.pageRevision,
        jobId: job.jobId,
        results: results.slice(),
        progress,
        partial: progress.partial
      });
    };
    const cancel = () => {
      if (settled || cancelled) return;
      cancelled = true;
      inputClosed = true;
      queue.splice(0);
      emit();
      finishIfReady();
    };
    const commitResult = (completed) => {
      results.push(completed);
      let allUnitsComplete = true;
      for (const unitId of completed.unitIds) {
        const completedCount = (unitSegmentDone.get(unitId) ?? 0) + 1;
        unitSegmentDone.set(unitId, completedCount);
        if (completedCount < (unitSegmentTotals.get(unitId) ?? 1)) allUnitsComplete = false;
      }
      emit();
      if (!onResult) return;
      const finished = completed;
      const snapshot2 = results.slice();
      pendingWriteBacks += 1;
      writeBackChain = writeBackChain.then(async () => {
        try {
          await onResult(finished, allUnitsComplete, snapshot2);
        } catch {
        }
      }).then(() => {
        pendingWriteBacks -= 1;
        finishIfReady();
      });
    };
    const fallbackSegments = async (item) => {
      const output = [];
      for (const segment of item.segments) {
        try {
          const single = await this.translate(segment.text, job.sourceLang, job.targetLang);
          if (isStale()) return [];
          output.push(this.success(segment, single));
        } catch (error2) {
          if (isStale()) return [];
          output.push({
            ...segment,
            error: error2 instanceof Error ? error2.message : translateMain("webReader.error.translationFailed")
          });
        }
      }
      return output;
    };
    const processWorkItem = async (item) => {
      let completedResults = [];
      try {
        if (item.merged && mergeUnsupported) {
          const fallback = await fallbackSegments(item);
          failed += fallback.filter((result2) => result2.error).length;
          completedResults = fallback;
        } else {
          const output = await this.translate(item.text, job.sourceLang, job.targetLang);
          if (!isStale()) {
            if (item.merged) {
              const parts = parseMergedTranslation(item.batch, output.translation);
              if (parts && parts.every((part) => part !== "")) {
                completedResults = item.segments.map((segment, index) => this.success(segment, output, parts[index]));
              } else {
                if (output.provider !== void 0 && output.provider !== "ai") mergeUnsupported = true;
                const fallback = await fallbackSegments(item);
                failed += fallback.filter((result2) => result2.error).length;
                completedResults = fallback;
              }
            } else {
              completedResults = item.segments.map((segment) => this.success(segment, output));
            }
          }
        }
      } catch (error2) {
        if (!isStale()) {
          if (item.merged) {
            const fallback = await fallbackSegments(item);
            failed += fallback.filter((result2) => result2.error).length;
            completedResults = fallback;
          } else {
            failed += 1;
            const message = error2 instanceof Error ? error2.message : translateMain("webReader.error.translationFailed");
            completedResults = item.segments.map((segment) => ({ ...segment, error: message }));
          }
        }
      }
      if (!isStale()) {
        done += 1;
        for (const completed of completedResults) commitResult(completed);
      }
      active -= 1;
      if (isStale()) cancel();
      pump();
      finishIfReady();
    };
    const pump = () => {
      if (isStale()) {
        cancel();
        return;
      }
      const concurrency = this.getConcurrency();
      while (active < concurrency && queue.length > 0) {
        const item = queue.shift();
        active += 1;
        void processWorkItem(item);
      }
      emit();
      finishIfReady();
    };
    const activeStream = { key, legacyKey, cancel };
    this.activeStreams.add(activeStream);
    signal?.addEventListener("abort", cancel, { once: true });
    return {
      enqueue: (units) => {
        const stats = { accepted: 0, duplicate: 0, truncated: 0 };
        if (inputClosed || isStale()) return stats;
        const blockUnits = /* @__PURE__ */ new Map();
        for (const unit of units) {
          if (job.scope === "body" && unit.category !== "body") continue;
          const unitKey = createWebTextUnitKey(unit);
          if (seenUnits.has(unitKey)) {
            stats.duplicate += 1;
            continue;
          }
          seenUnits.add(unitKey);
          const grouped = blockUnits.get(unit.blockId);
          if (grouped) grouped.push(unit);
          else blockUnits.set(unit.blockId, [unit]);
        }
        const pendingSegments = [];
        for (const groupedUnits of blockUnits.values()) {
          groupedUnits[0];
          if (acceptedUnits >= Math.max(0, job.maxBlocks ?? Number.MAX_SAFE_INTEGER)) {
            stats.truncated += 1;
            truncated = true;
            continue;
          }
          const segments = splitWebTextUnits(groupedUnits, { maxChars: job.maxCharsPerSegment, locale: job.locale });
          const segmentChars = segments.reduce((sum, segment) => sum + segment.text.length, 0);
          if (segments.length === 0) continue;
          if (acceptedChars + segmentChars > Math.max(0, job.maxChars ?? Number.MAX_SAFE_INTEGER)) {
            stats.truncated += 1;
            truncated = true;
            continue;
          }
          acceptedUnits += 1;
          acceptedChars += segmentChars;
          stats.accepted += 1;
          for (const groupedUnit of groupedUnits) {
            unitSegmentTotals.set(groupedUnit.id, (unitSegmentTotals.get(groupedUnit.id) ?? 0) + segments.length);
          }
          if (job.mergeAcrossBlocks && segments.length === 1) {
            pendingSegments.push(...segments);
          } else {
            for (const segment of segments) {
              queue.push({
                batch: { batchId: segment.segmentId, segments: [segment], text: segment.text, mergeable: false },
                text: segment.text,
                segments: [segment],
                merged: false
              });
            }
          }
        }
        if (pendingSegments.length > 0) {
          const batches = buildWebTranslationBatches(pendingSegments, {
            maxChars: Math.min(job.maxCharsPerSegment, WEB_TRANSLATION_MERGED_BATCH_MAX_CHARS),
            maxBlocksPerBatch: job.maxSegmentsPerBatch
          });
          for (const batch of batches) {
            queue.push({ batch, text: batch.text, segments: batch.segments, merged: batch.mergeable });
          }
        }
        emit();
        pump();
        return stats;
      },
      closeInput: () => {
        if (inputClosed) return;
        inputClosed = true;
        emit();
        finishIfReady();
      },
      result,
      getProgress: snapshot
    };
  }
  /**
   * 按正文范围筛选网页块并执行固定批次并发翻译。
   * @param job 页面任务代次与保护配置。
   * @param blocks 提取出的网页文本块或文本单元。
   * @param onProgress 进度回调。
   * @param signal 外部取消信号。
   * @param onResult 单个分段完成回调，并标记所属文本单元是否已经完整。
   * @returns 页面翻译结果和最终进度。
   * @author zhenghq
   */
  async run(job, blocks, onProgress, signal, onResult) {
    const isUnitList = blocks.length === 0 || "sourceText" in blocks[0];
    if (isUnitList) {
      let lastReportedDone = -1;
      const stream2 = this.createStream(job, (progress) => {
        if (progress.done === lastReportedDone) return;
        lastReportedDone = progress.done;
        if (progress.done > 0) onProgress?.(progress);
      }, signal, onResult);
      stream2.enqueue(blocks);
      stream2.closeInput();
      return stream2.result;
    }
    const selected = job.scope === "body" ? blocks.filter((block) => block.category === "body") : blocks;
    const limitedBlocks = selected.slice(0, Math.max(0, job.maxBlocks ?? Number.MAX_SAFE_INTEGER));
    const segments = splitWebTextBlocks(limitedBlocks, { maxChars: job.maxCharsPerSegment, locale: job.locale });
    const limitedSegments = this.limitChars(segments, job.maxChars);
    const syntheticUnits = limitedSegments.map((segment, index) => ({
      id: `${segment.unitId}:fixed-${index}`,
      blockId: segment.blockId,
      sourceText: segment.text,
      text: segment.text,
      category: limitedBlocks.find((block) => block.id === segment.blockId)?.category ?? "body",
      anchor: { parentSelector: `#fixed-${index}`, textNodeIndex: 0, sourceFingerprint: segment.segmentId }
    }));
    const stream = this.createStream({ ...job, maxBlocks: syntheticUnits.length, maxChars: void 0, maxCharsPerSegment: job.maxCharsPerSegment }, onProgress, signal, onResult);
    stream.enqueue(syntheticUnits);
    if (limitedBlocks.length !== selected.length || limitedSegments.length !== segments.length) {
      stream.enqueue([{ ...syntheticUnits[0], id: "__truncated__", text: "x", sourceText: "x", anchor: { parentSelector: "#truncated", textNodeIndex: 0, sourceFingerprint: "truncated" } }]);
    }
    stream.closeInput();
    return stream.result;
  }
  /**
   * 按总字符数保护截取分段。
   * @param segments 已拆分的分段。
   * @param maxChars 最大总字符数。
   * @returns 未超出总字符上限的前缀分段。
   * @author zhenghq
   */
  limitChars(segments, maxChars) {
    if (maxChars === void 0 || !Number.isFinite(maxChars)) return segments;
    const limit = Math.max(0, Math.floor(maxChars));
    let used = 0;
    const output = [];
    for (const segment of segments) {
      if (used + segment.text.length > limit) break;
      output.push(segment);
      used += segment.text.length;
    }
    return output;
  }
  /**
   * 将翻译服务输出映射为网页结果。
   * @param segment 原始分段。
   * @param output 翻译服务输出。
   * @param translation 可选的本段译文，用于跨块合并后按标记拆分的结果。
   * @returns 结构化网页翻译结果。
   * @author zhenghq
   */
  success(segment, output, translation) {
    return {
      unitId: segment.unitId,
      unitIds: segment.unitIds,
      blockId: segment.blockId,
      segmentId: segment.segmentId,
      segmentTotal: segment.segmentTotal,
      text: segment.text,
      translation: translation ?? output.translation,
      provider: output.provider,
      channel: output.channel
    };
  }
  /**
   * 创建任务代次键。
   * @param readerId 阅读器标识。
   * @param pageRevision 页面版本。
   * @param jobId 任务标识。
   * @param sourceLang 可选源语言。
   * @param targetLang 可选目标语言。
   * @returns 内部键。
   * @author zhenghq
   */
  key(readerId, pageRevision, jobId, sourceLang = "", targetLang = "") {
    return `${readerId}:${pageRevision}:${jobId}:${sourceLang}:${targetLang}`;
  }
}
function aggregatePageTranslationUnits(units, results) {
  const unitsByBlock = /* @__PURE__ */ new Map();
  for (const unit of units) {
    const list = unitsByBlock.get(unit.blockId);
    if (list) list.push(unit);
    else unitsByBlock.set(unit.blockId, [unit]);
  }
  const translations = /* @__PURE__ */ new Map();
  const errors = /* @__PURE__ */ new Map();
  for (const [blockId, blockUnits] of unitsByBlock) {
    const positionByUnitId = new Map(blockUnits.map((unit, index) => [unit.id, index]));
    const blockUnitIds = new Set(positionByUnitId.keys());
    const blockResults = results.filter((result) => {
      const coveredIds = result.unitIds?.length ? result.unitIds : [result.unitId];
      return coveredIds.some((unitId) => blockUnitIds.has(unitId));
    });
    const failure = blockResults.find((result) => result.error);
    if (failure?.error) {
      for (const unit of blockUnits) errors.set(unit.id, failure.error);
      continue;
    }
    const covered = /* @__PURE__ */ new Set();
    const indexesByBatch = /* @__PURE__ */ new Map();
    const totalsByBatch = /* @__PURE__ */ new Map();
    for (const result of blockResults) {
      const coveredIds = result.unitIds?.length ? result.unitIds : [result.unitId];
      for (const unitId of coveredIds) covered.add(unitId);
      const batchKey = result.unitId;
      totalsByBatch.set(batchKey, Math.max(totalsByBatch.get(batchKey) ?? 1, result.segmentTotal ?? 1));
      const segmentIndex = Number(result.segmentId.split(":").pop() ?? Number.NaN);
      if (!Number.isFinite(segmentIndex)) continue;
      const indexes = indexesByBatch.get(batchKey) ?? /* @__PURE__ */ new Set();
      indexes.add(segmentIndex);
      indexesByBatch.set(batchKey, indexes);
    }
    if (!blockUnits.every((unit) => covered.has(unit.id))) continue;
    let complete = true;
    for (const [batchKey, total] of totalsByBatch) {
      const indexes = indexesByBatch.get(batchKey) ?? /* @__PURE__ */ new Set();
      for (let index = 0; index < total; index += 1) {
        if (!indexes.has(index)) {
          complete = false;
          break;
        }
      }
      if (!complete) break;
    }
    if (!complete) continue;
    const ordered = blockResults.slice().sort((left, right) => {
      const leftCovered = left.unitIds?.length ? left.unitIds : [left.unitId];
      const rightCovered = right.unitIds?.length ? right.unitIds : [right.unitId];
      const leftPosition = Math.min(...leftCovered.map((unitId) => positionByUnitId.get(unitId) ?? Number.MAX_SAFE_INTEGER));
      const rightPosition = Math.min(...rightCovered.map((unitId) => positionByUnitId.get(unitId) ?? Number.MAX_SAFE_INTEGER));
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      const leftIndex = Number(left.segmentId.split(":").pop() ?? 0);
      const rightIndex = Number(right.segmentId.split(":").pop() ?? 0);
      return leftIndex - rightIndex;
    });
    const translation = ordered.map((result) => result.translation ?? "").join("");
    translations.set(blockUnits[0].id, translation);
    for (let index = 1; index < blockUnits.length; index += 1) {
      translations.set(blockUnits[index].id, "");
    }
  }
  return units.map((unit) => {
    const error2 = errors.get(unit.id);
    if (error2 !== void 0) return { ...unit, error: error2 };
    const translation = translations.get(unit.id);
    return translation === void 0 ? { ...unit } : { ...unit, translation };
  });
}
class WebPageTranslationCache {
  entries = /* @__PURE__ */ new Map();
  maxPages;
  maxDirectionsPerPage;
  maxUnits;
  maxBytes;
  unitCount = 0;
  byteCount = 0;
  /**
   * 创建页面翻译缓存。
   * @param options 页面数、语言方向、单元数和容量上限。
   * @author zhenghq
   */
  constructor(options = {}) {
    this.maxPages = Math.max(1, Math.floor(options.maxPages ?? 30));
    this.maxDirectionsPerPage = Math.max(1, Math.floor(options.maxDirectionsPerPage ?? 3));
    this.maxUnits = Math.max(1, Math.floor(options.maxUnits ?? 3e4));
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 30 * 1024 * 1024));
  }
  /**
   * 返回当前缓存页面数量。
   * @returns 按页面上下文去重后的页面数量。
   * @author zhenghq
   */
  get pageCount() {
    return new Set(Array.from(this.entries.values(), (entry) => entry.pageKey)).size;
  }
  /**
   * 写入成功译文并执行页面、语言方向和容量淘汰。
   * @param context 页面和翻译上下文。
   * @param units 待缓存的文本单元。
   * @returns 实际缓存的成功译文数量。
   * @author zhenghq
   */
  put(context, units) {
    const successful = units.filter((unit) => !unit.error && typeof unit.translation === "string").map((unit) => ({ ...unit }));
    const { pageKey, key } = this.keys(context);
    this.remove(key);
    if (successful.length === 0) return 0;
    const bytes = this.estimate(key, successful);
    if (successful.length > this.maxUnits || bytes > this.maxBytes) return 0;
    const entry = { pageKey, key, kind: "text", units: successful, bytes };
    this.entries.set(key, entry);
    this.unitCount += successful.length;
    this.byteCount += bytes;
    this.trimDirections(pageKey);
    this.trimPages();
    this.trimCapacity();
    return this.entries.has(key) ? successful.length : 0;
  }
  /**
   * 写入成功的图片 OCR 与译文结果，失败、取消或跳过结果不缓存。
   * @param context 页面和翻译上下文。
   * @param candidates 带识别与译文结果的图片候选。
   * @returns 实际缓存的图片数量。
   * @author zhenghq
   */
  putImages(context, candidates) {
    const successful = candidates.filter((candidate) => typeof candidate.imageId === "string" && candidate.imageId !== "" && typeof candidate.sourceFingerprint === "string" && candidate.sourceFingerprint !== "" && typeof candidate.ocrText === "string" && candidate.ocrText.trim() !== "" && typeof candidate.translation === "string" && candidate.translation.trim() !== "" && !candidate.error && !candidate.skippedReason);
    let stored = 0;
    for (const candidate of successful) {
      const key = this.imageKey(context, candidate);
      this.remove(key);
      const image = {
        imageId: candidate.imageId,
        sourceFingerprint: candidate.sourceFingerprint,
        ocrText: candidate.ocrText,
        translation: candidate.translation
      };
      const bytes = this.estimateImage(key, image);
      if (bytes > this.maxBytes) continue;
      const entry = {
        pageKey: this.keys(context).pageKey,
        key,
        kind: "image",
        units: [],
        image,
        bytes
      };
      this.entries.set(key, entry);
      this.unitCount += 1;
      this.byteCount += bytes;
      this.trimDirections(entry.pageKey);
      this.trimPages();
      this.trimCapacity();
      if (this.entries.has(key)) stored += 1;
    }
    return stored;
  }
  /**
   * 将缓存图片结果与当前快照按标识与来源指纹匹配。
   * @param context 当前页面和翻译上下文。
   * @param currentCandidates 当前页面重新提取的图片候选。
   * @returns 使用当前锚点并带上缓存识别与译文的候选列表。
   * @author zhenghq
   */
  matchImages(context, currentCandidates) {
    const matched = [];
    for (const candidate of currentCandidates) {
      if (typeof candidate.imageId !== "string" || candidate.imageId === "") continue;
      if (typeof candidate.sourceFingerprint !== "string" || candidate.sourceFingerprint === "") continue;
      const key = this.imageKey(context, candidate);
      const entry = this.entries.get(key);
      if (!entry?.image) continue;
      this.touch(key, entry);
      matched.push({
        ...candidate,
        ocrText: entry.image.ocrText,
        translation: entry.image.translation
      });
    }
    return matched;
  }
  /**
   * 将缓存译文与当前页面快照按原文和指纹匹配。
   * @param context 当前页面和翻译上下文。
   * @param currentUnits 当前页面重新提取的文本单元。
   * @returns 使用当前单元标识和锚点的缓存命中结果。
   * @author zhenghq
   */
  match(context, currentUnits) {
    const { key } = this.keys(context);
    const entry = this.entries.get(key);
    if (!entry) return [];
    this.touch(key, entry);
    const cached = /* @__PURE__ */ new Map();
    for (const unit of entry.units) {
      const matchKey = `${unit.sourceFingerprint}\0${unit.sourceText}`;
      const list = cached.get(matchKey) ?? [];
      list.push(unit);
      cached.set(matchKey, list);
    }
    const matched = [];
    for (const unit of currentUnits) {
      const matchKey = `${unit.anchor.sourceFingerprint}\0${unit.sourceText}`;
      const hit = cached.get(matchKey)?.shift();
      if (hit?.translation === void 0) continue;
      matched.push({ ...unit, anchor: { ...unit.anchor }, translation: hit.translation });
    }
    return matched;
  }
  /**
   * 清空全部页面译文缓存。
   * @returns 无返回值。
   * @author zhenghq
   */
  clear() {
    this.entries.clear();
    this.unitCount = 0;
    this.byteCount = 0;
  }
  /**
   * 构造规范化页面键和完整语言方向键。
   * @param context 页面缓存上下文。
   * @returns 页面分组键和完整缓存键。
   * @author zhenghq
   */
  keys(context) {
    const url = normalizeWebPageCacheUrl(context.url);
    const pageKey = `${url}|${context.pageFingerprint}|${context.scope}|${context.translationContext}`;
    return { pageKey, key: `${pageKey}|${context.sourceLang}>${context.targetLang}` };
  }
  /**
   * 刷新缓存条目的最近使用顺序。
   * @param key 完整缓存键。
   * @param entry 缓存条目。
   * @returns 无返回值。
   * @author zhenghq
   */
  touch(key, entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
  /**
   * 删除缓存条目并同步容量统计。
   * @param key 完整缓存键。
   * @returns 是否删除成功。
   * @author zhenghq
   */
  remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.unitCount -= entry.kind === "image" ? 1 : entry.units.length;
    this.byteCount -= entry.bytes;
    return true;
  }
  /**
   * 淘汰同一页面超过限制的最旧语言方向。
   * @param pageKey 页面分组键。
   * @returns 无返回值。
   * @author zhenghq
   */
  trimDirections(pageKey) {
    const keys = Array.from(this.entries.values()).filter((entry) => entry.pageKey === pageKey && entry.kind === "text").map((entry) => entry.key);
    while (keys.length > this.maxDirectionsPerPage) this.remove(keys.shift());
  }
  /**
   * 淘汰超过页面数量限制的最旧页面及其全部语言方向。
   * @returns 无返回值。
   * @author zhenghq
   */
  trimPages() {
    while (this.pageCount > this.maxPages) {
      const oldest = this.entries.values().next().value;
      if (!oldest) return;
      for (const entry of Array.from(this.entries.values())) {
        if (entry.pageKey === oldest.pageKey) this.remove(entry.key);
      }
    }
  }
  /**
   * 淘汰超过总单元数或估算容量的最旧缓存条目。
   * @returns 无返回值。
   * @author zhenghq
   */
  trimCapacity() {
    while (this.unitCount > this.maxUnits || this.byteCount > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) return;
      this.remove(oldest);
    }
  }
  /**
   * 估算页面缓存条目占用字节数。
   * @param key 完整缓存键。
   * @param units 成功译文单元。
   * @returns UTF-16 近似字节数。
   * @author zhenghq
   */
  estimate(key, units) {
    return (key.length + units.reduce((sum, unit) => sum + unit.sourceText.length + unit.sourceFingerprint.length + (unit.translation?.length ?? 0), 0)) * 2;
  }
  /**
   * 构造图片缓存键，与文本分区使用不同前缀避免互相覆盖。
   * @param context 页面缓存上下文。
   * @param image 图片标识与来源指纹。
   * @returns 图片完整缓存键。
   * @author zhenghq
   */
  imageKey(context, image) {
    const { key } = this.keys(context);
    return `${key}|image|${image.imageId}|${image.sourceFingerprint ?? ""}`;
  }
  /**
   * 估算图片缓存条目占用字节数。
   * @param key 图片完整缓存键。
   * @param image 图片缓存内容。
   * @returns UTF-16 近似字节数。
   * @author zhenghq
   */
  estimateImage(key, image) {
    return (key.length + image.ocrText.length + image.translation.length + image.sourceFingerprint.length) * 2;
  }
}
function createWebPageContentFingerprint(units) {
  let hash = 2166136261;
  for (const unit of units) {
    const value = `${unit.anchor.sourceFingerprint}\0${unit.text || unit.sourceText}`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 255;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function normalizeWebPageCacheUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.split("#", 1)[0];
  }
}
const ALLOWED_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:"]);
const GOOGLE_DOCS_EDITOR_PATH = /^\/document\/(?:u\/(\d+)\/)?d\/([\w-]+)\/edit\/?$/u;
function toWebReaderHtmlViewUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (parsed.hostname !== "docs.google.com") return value;
  const match = GOOGLE_DOCS_EDITOR_PATH.exec(parsed.pathname);
  if (!match) return value;
  const accountPrefix = match[1] ? `/u/${match[1]}` : "";
  parsed.pathname = `/document${accountPrefix}/d/${match[2]}/mobilebasic`;
  const heading = /^#heading=(h\.[\w-]+)$/u.exec(parsed.hash);
  parsed.hash = heading ? `#${heading[1]}` : "";
  return parsed.toString();
}
function normalizeWebReaderUrl(value) {
  const input = String(value ?? "").trim();
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(input) ? input : `https://${input}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(translateMain("webReader.error.invalidUrl"));
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(translateMain("webReader.error.onlyHttp"));
  }
  if (!parsed.hostname) throw new Error(translateMain("webReader.error.invalidUrl"));
  return parsed.toString();
}
function sanitizeWebViewBounds(bounds, contentSize) {
  const x = Math.max(0, Math.round(Number(bounds.x) || 0));
  const y = Math.max(0, Math.round(Number(bounds.y) || 0));
  const width = Math.max(0, Math.min(Math.round(Number(bounds.width) || 0), Math.max(0, Math.round(contentSize.width) - x)));
  const height = Math.max(0, Math.min(Math.round(Number(bounds.height) || 0), Math.max(0, Math.round(contentSize.height) - y)));
  return { x, y, width, height };
}
function isAllowedWebReaderUrl(value) {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}
function isDisposedWebFrameError(error2) {
  const message = error2 instanceof Error ? error2.message : String(error2 ?? "");
  return /render frame was disposed|webframemain could not be accessed|frame was disposed|object has been destroyed|webcontents was destroyed/iu.test(message);
}
function sendToAliveWebContents(contents, channel, payload) {
  try {
    if (!contents || contents.isDestroyed()) return false;
    contents.send(channel, payload);
    return true;
  } catch (error2) {
    if (isDisposedWebFrameError(error2)) return false;
    throw error2;
  }
}
function resolveWebTypewriterTuning(textLength, cached) {
  if (cached) return { intervalMs: 6, step: textLength > 120 ? 3 : 2 };
  if (textLength > 600) return { intervalMs: 8, step: 4 };
  if (textLength > 200) return { intervalMs: 12, step: 2 };
  return { intervalMs: 18, step: 1 };
}
function buildWebTypewriterRuntimeSnippet() {
  return `
    const typewriterKey = '__selectionTranslatorTypewriter';
    const typewriter = window[typewriterKey] || (window[typewriterKey] = {
      generation: 0,
      timers: new Map(),
      restoreTimer: null,
      cancel() {
        this.generation += 1;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        if (this.restoreTimer) clearTimeout(this.restoreTimer);
        this.restoreTimer = null;
        const pageState = window.__selectionTranslatorWebTranslation;
        if (pageState) pageState.suppressed = false;
      }
    });
    const scheduleTypewriter = (key, apply, fullText, tuning) => {
      const previous = typewriter.timers.get(key);
      if (previous) clearTimeout(previous);
      typewriter.timers.delete(key);
      const generation = typewriter.generation;
      let visible = 0;
      const tick = () => {
        if (generation !== typewriter.generation) return;
        visible = Math.min(fullText.length, visible + Math.max(1, tuning.step || 1));
        apply(fullText.slice(0, visible));
        if (visible < fullText.length) {
          const timer = setTimeout(tick, Math.max(1, tuning.intervalMs || 1));
          typewriter.timers.set(key, timer);
        } else {
          typewriter.timers.delete(key);
        }
      };
      if (fullText.length === 0) {
        apply('');
        return;
      }
      tick();
    };
  `;
}
function buildWebTypewriterCancelScript() {
  return `(() => {
    const typewriter = window.__selectionTranslatorTypewriter;
    if (!typewriter) return false;
    for (const timer of typewriter.timers.values()) clearTimeout(timer);
    typewriter.timers.clear();
    if (typewriter.restoreTimer) clearTimeout(typewriter.restoreTimer);
    typewriter.restoreTimer = null;
    typewriter.cancel();
    return true;
  })()`;
}
function buildWebDocumentReadyScript() {
  return `(() => ({
    readyState: document.readyState,
    hasRoot: Boolean(document.body || document.documentElement),
    url: location.href
  }))()`;
}
function buildWebIncrementalCollectorStartScript(debounceMs = 300) {
  const safeDebounce = Math.max(0, Math.floor(debounceMs));
  return `(() => {
    const previous = window.__selectionTranslatorWebTranslation;
    if (previous?.observers) for (const observer of previous.observers) observer.disconnect();
    if (previous?.observer) previous.observer.disconnect();
    if (previous?.timer) clearTimeout(previous.timer);
    const ignored = new Set(['SCRIPT','STYLE','TEMPLATE','SVG','NOSCRIPT','CANVAS','IFRAME']);
    const formControls = new Set(['INPUT','TEXTAREA','SELECT','OPTION']);
    const blockTags = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BUTTON','DD','DIV','DL','DT','FIGCAPTION','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TD','TH','TR','UL']);
    const semanticAttributes = new Set(['placeholder','aria-label','title']);
    const hash = (value) => {
      let result = 2166136261;
      for (let index = 0; index < value.length; index += 1) { result ^= value.charCodeAt(index); result = Math.imul(result, 16777619); }
      return (result >>> 0).toString(16).padStart(8, '0');
    };
    const selectorOf = (element) => {
      if (element.id) return '[id="' + CSS.escape(element.id) + '"]';
      const testId = element.getAttribute('data-testid');
      if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
      const segments = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const parent = current.parentElement;
        const index = parent ? Array.from(parent.children).indexOf(current) + 1 : 1;
        const tag = current.tagName.toLowerCase();
        // html 与 body 是文档唯一根元素，使用标签本身定位，避免受 head 等兄弟节点影响。
        segments.unshift(tag === 'html' || tag === 'body' ? tag : tag + ':nth-child(' + index + ')');
        current = parent;
      }
      return segments.join(' > ');
    };
    const visible = (element) => {
      if (!element || ignored.has(element.tagName) || element.isContentEditable || element.contentEditable === 'true') return false;
      // 应用注入的对照与图片译文节点及其子树不参与增量收集，避免译文被当作新原文再次翻译。
      if (element.closest && element.closest('[data-st-translation],[data-st-image-translation]')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
        (style.display === 'contents' || (rect.width > 0 && rect.height > 0));
    };
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.left + window.scrollX), y: Math.round(rect.top + window.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const semanticTextsOf = (element, onlyNew) => {
      const names = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
        ? ['placeholder','aria-label','title']
        : ['aria-label','title'];
      const values = [];
      for (const attribute of names) {
        if (!semanticAttributes.has(attribute)) continue;
        const text = element.getAttribute(attribute);
        if (!text || !text.trim()) continue;
        const key = selectorOf(element) + '|' + attribute + '|' + hash(text);
        if (onlyNew && seen.has(key)) continue;
        seen.add(key);
        values.push({ attribute, text });
      }
      return values;
    };
    const shadowLocationOf = (node) => {
      const root = node?.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? node : node?.getRootNode?.();
      if (!root || root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE || !root.host) return null;
      const path = [];
      let current = node === root ? null : node;
      while (current && current.parentNode !== root) {
        const parent = current.parentNode;
        if (!parent) return null;
        path.unshift(Array.from(parent.childNodes).indexOf(current));
        current = parent;
      }
      if (current) path.unshift(Array.from(root.childNodes).indexOf(current));
      return { hostSelector: selectorOf(root.host), path };
    };
    const seen = new Set();
    const imageMinSize = 64;
    const imageIgnoredTags = new Set(['SCRIPT','STYLE','TEMPLATE','NOSCRIPT','IFRAME']);
    const decorativeSource = /(^|[\\/_.-])(sprite|icon|logo|avatar|favicon|badge|pixel|spacer|qrcode|qr-code)([\\/_.-]|$)/i;
    const imageHash = (value) => {
      let result = 2166136261;
      for (let index = 0; index < value.length; index += 1) { result ^= value.charCodeAt(index); result = Math.imul(result, 16777619); }
      return (result >>> 0).toString(16).padStart(8, '0');
    };
    const imageVisible = (element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (Number(style.opacity) === 0) return false;
      return true;
    };
    const isDecorative = (element, source, rect) => {
      const role = (element.getAttribute('role') || '').toLowerCase();
      if (role === 'presentation' || role === 'none') return true;
      if (element.getAttribute('aria-hidden') === 'true') return true;
      const alt = element.getAttribute('alt');
      if (alt === '' && rect.width < imageMinSize * 2 && rect.height < imageMinSize * 2) return true;
      if (typeof source === 'string' && source && decorativeSource.test(source) &&
          rect.width < imageMinSize * 3 && rect.height < imageMinSize * 3) return true;
      return false;
    };
    const buildImageCandidate = (element, kind, source, naturalWidth, naturalHeight) => {
      if (!element || !imageVisible(element)) return null;
      if (imageIgnoredTags.has(element.tagName)) return null;
      if (element.isContentEditable || element.contentEditable === 'true') return null;
      if (element.closest && element.closest('[data-st-image-translation]')) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width < imageMinSize || rect.height < imageMinSize) return null;
      if (rect.width * rect.height > 20000000) return null;
      if (isDecorative(element, source, rect)) return null;
      const location = shadowLocationOf(element);
      const selector = location ? location.hostSelector : selectorOf(element);
      const pageRect = rectOf(element);
      const normalizedSource = typeof source === 'string' ? source : '';
      const inline = normalizedSource.startsWith('data:') || normalizedSource.startsWith('blob:');
      const sourceFingerprint = imageHash([normalizedSource, element.getAttribute('alt') || '', kind, naturalWidth || 0, naturalHeight || 0].join('|'));
      const imageId = 'web-image-' + imageHash(JSON.stringify([
        selector, kind, location ? location.path : [], pageRect.x, pageRect.y, pageRect.width, pageRect.height, sourceFingerprint
      ]));
      return {
        imageId, kind, selector, rect: pageRect,
        naturalWidth: naturalWidth || undefined, naturalHeight: naturalHeight || undefined,
        sourceFingerprint, src: normalizedSource || undefined,
        alt: element.getAttribute('alt') || undefined, inline: inline || undefined,
        shadowPath: location ? location.path : undefined
      };
    };
    const seenImageIds = new Set();
    const collectImages = (root) => {
      if (!root) return [];
      const output = [];
      const visit = (node) => {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
        const element = node;
        if (element.closest && element.closest('[data-st-image-translation]')) return;
        let candidate = null;
        if (element.tagName === 'IMG') {
          candidate = buildImageCandidate(element, 'img', element.currentSrc || element.getAttribute('src') || '', element.naturalWidth, element.naturalHeight);
        } else if (element.tagName === 'CANVAS') {
          candidate = buildImageCandidate(element, 'canvas', '', element.width, element.height);
        } else if (!imageIgnoredTags.has(element.tagName)) {
          const background = getComputedStyle(element).backgroundImage || '';
          if (background && background !== 'none' && background.indexOf('url(') >= 0) {
            const match = /url\\(["']?([^"')]+)["']?\\)/i.exec(background);
            candidate = buildImageCandidate(element, 'background', match ? match[1] : '', 0, 0);
          }
        }
        if (candidate && !seenImageIds.has(candidate.imageId)) {
          seenImageIds.add(candidate.imageId);
          output.push(candidate);
        }
        if (element.shadowRoot) for (const child of element.shadowRoot.children) visit(child);
        for (const child of element.children) visit(child);
      };
      visit(root);
      return output;
    };
    const snapshot = (node, onlyNew) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentNode;
        const owner = parent?.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? parent.host : node.parentElement;
        if (!owner || !visible(owner)) return null;
        const text = node.nodeValue || '';
        const location = shadowLocationOf(node.parentElement || parent);
        const selector = location ? location.hostSelector : selectorOf(owner);
        const textNodeIndex = Array.from(parent?.childNodes || []).indexOf(node);
        const sourceFingerprint = hash(text);
        const key = selector + '|' + (location ? JSON.stringify(location.path) : '') + '|' + textNodeIndex + '|' + sourceFingerprint;
        if (onlyNew && seen.has(key)) return null;
        seen.add(key);
        return { kind: 'text', text, textNodeIndex, visible: true, shadowPath: location?.path, shadowHostSelector: location?.hostSelector, children: [] };
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const element = node;
      if (!visible(element)) return { kind: 'element', tag: element.tagName.toLowerCase(), visible: false, children: [] };
      const location = shadowLocationOf(element);
      const semanticTexts = semanticTextsOf(element, onlyNew);
      const children = [];
      const childNodes = element.shadowRoot ? element.shadowRoot.childNodes : formControls.has(element.tagName) ? [] : element.childNodes;
      for (const child of childNodes) { const item = snapshot(child, onlyNew); if (item) children.push(item); }
      if (onlyNew && children.length === 0 && semanticTexts.length === 0) return null;
      return { kind: 'element', tag: element.tagName.toLowerCase(), visible: true, role: element.getAttribute('role') || undefined, id: element.id || undefined, testId: element.getAttribute('data-testid') || undefined, selector: location ? undefined : selectorOf(element), rect: rectOf(element), semanticTexts: semanticTexts.length ? semanticTexts : undefined, shadowRoot: Boolean(element.shadowRoot), shadowPath: location?.path, shadowHostSelector: element.shadowRoot ? selectorOf(element) : location?.hostSelector, children };
    };
    const semanticRoot = (node) => {
      let element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      if (!element && node?.host) element = node.host;
      while (element?.parentElement && !blockTags.has(element.tagName)) element = element.parentElement;
      return element || document.body || document.documentElement;
    };
    const state = window.__selectionTranslatorWebTranslation = {
      active: true, pageUpdated: false, suppressed: false, observer: null, observers: [], timer: null,
      roots: new Set(), pending: [], pendingImageCandidates: [], seen,
      flush() {
        if (!this.active || this.suppressed) return [];
        const roots = Array.from(this.roots); this.roots.clear();
        const snapshots = [];
        const images = [];
        for (const root of roots) {
          const item = snapshot(root, true);
          if (item) snapshots.push(item);
          images.push(...collectImages(root));
        }
        if (snapshots.length) this.pending.push(...snapshots);
        if (images.length) this.pendingImageCandidates.push(...images);
        return snapshots;
      },
      stop() {
        this.active = false;
        for (const observer of this.observers || []) observer.disconnect();
        if (this.observer) this.observer.disconnect();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
      }
    };
    const root = document.body || document.documentElement;
    const initialImages = collectImages(root);
    const initial = root ? snapshot(root, false) : null;
    const observer = new MutationObserver((records) => {
      if (!state.active || state.suppressed) return;
      state.pageUpdated = true;
      for (const record of records) {
        state.roots.add(semanticRoot(record.target));
        if (record.type === 'childList') {
          for (const node of record.addedNodes) {
            state.roots.add(semanticRoot(node));
            observeShadowRoots(node);
          }
        }
      }
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => { state.timer = null; state.flush(); }, ${safeDebounce});
    });
    const observedRoots = new Set();
    const observeShadowRoots = (node) => {
      if (!node) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        if (element.shadowRoot && !observedRoots.has(element.shadowRoot)) {
          observedRoots.add(element.shadowRoot);
          observer.observe(element.shadowRoot, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder','aria-label','title'] });
        }
      }
      for (const child of node.childNodes || []) observeShadowRoots(child);
    };
    if (root) {
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder','aria-label','title'] });
      observeShadowRoots(root);
    }
    state.observer = observer;
    state.observers = [observer];
    return { snapshot: initial, imageCandidates: initialImages, pageMeta: { url: location.href, title: document.title || '', langHint: document.documentElement.lang || undefined } };
  })()`;
}
function buildWebIncrementalCollectorDrainScript() {
  return `(() => {
    const state = window.__selectionTranslatorWebTranslation;
    if (!state) return { snapshots: [], imageCandidates: [], pageMeta: { url: location.href, title: document.title || '', langHint: document.documentElement.lang || undefined }, active: false, pageUpdated: false };
    if (state.timer) { clearTimeout(state.timer); state.timer = null; state.flush(); }
    const snapshots = state.pending.splice(0);
    const imageCandidates = state.pendingImageCandidates ? state.pendingImageCandidates.splice(0) : [];
    return { snapshots, imageCandidates, pageMeta: { url: location.href, title: document.title || '', langHint: document.documentElement.lang || undefined }, active: Boolean(state.active), pageUpdated: Boolean(state.pageUpdated) };
  })()`;
}
function buildWebIncrementalCollectorStopScript() {
  return `(() => {
    const state = window.__selectionTranslatorWebTranslation;
    if (!state) return false;
    state.active = false;
    if (state.observer) state.observer.disconnect();
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    return true;
  })()`;
}
function buildWebTextApplyScript(operations, mode, options = {}) {
  const serialized = JSON.stringify(operations);
  const serializedMode = JSON.stringify(mode);
  const serializedOptions = JSON.stringify({
    typewriter: mode === "target" && options.typewriter === true,
    cached: options.cached === true
  });
  const tuning = resolveWebTypewriterTuning(
    operations.reduce((total, operation) => total + (operation.translation?.length ?? 0), 0),
    options.cached === true
  );
  const serializedTuning = JSON.stringify(tuning);
  const typewriterDurationMs = options.typewriter === true && mode === "target" ? operations.reduce((longest, operation) => {
    const length = operation.translation?.length ?? 0;
    const duration = Math.ceil(length / Math.max(1, tuning.step)) * Math.max(1, tuning.intervalMs);
    return Math.max(longest, duration);
  }, 0) : 0;
  const typewriterRuntime = options.typewriter === true && mode === "target" ? buildWebTypewriterRuntimeSnippet() : "";
  return `(() => {
    const operations = ${serialized};
    const mode = ${serializedMode};
    const options = ${serializedOptions};
    const tuning = ${serializedTuning};
    ${typewriterRuntime}
    const state = window.__selectionTranslatorWebTranslation || (window.__selectionTranslatorWebTranslation = { pageUpdated: false, suppressed: false });
    const hash = (value) => {
      let result = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619);
      }
      return (result >>> 0).toString(16).padStart(8, '0');
    };
    const preserve = (source, translation) => {
      const leading = source.match(/^\\s*/u)?.[0] || '';
      const trailing = source.match(/\\s*$/u)?.[0] || '';
      return leading + String(translation || '').trim() + trailing;
    };
    const stats = { applied: 0, mismatched: 0, skipped: 0 };
    const resolveShadowParent = (anchor) => {
      let parent = null;
      try { parent = document.querySelector(anchor.parentSelector); } catch {}
      if (!parent || !Array.isArray(anchor.shadowPath)) return parent;
      let current = parent.shadowRoot;
      for (const index of anchor.shadowPath) {
        if (!current?.childNodes?.[index]) return null;
        current = current.childNodes[index];
      }
      return current;
    };
    state.suppressed = true;
    for (const operation of operations) {
      if (mode === 'target' && typeof operation.translation !== 'string') { stats.skipped += 1; continue; }
      const target = preserve(operation.sourceText, operation.translation || '');
      const sourceFingerprint = operation.anchor.sourceFingerprint;
      const targetFingerprint = hash(target);
      const desired = mode === 'source' ? operation.sourceText : target;
      const parent = resolveShadowParent(operation.anchor);
      if (operation.anchor.semanticAttribute) {
        if (!parent || parent.nodeType !== Node.ELEMENT_NODE) { stats.mismatched += 1; continue; }
        const current = String(parent.getAttribute(operation.anchor.semanticAttribute) || '');
        const currentFingerprint = hash(current);
        if (currentFingerprint !== sourceFingerprint && currentFingerprint !== targetFingerprint) { stats.mismatched += 1; continue; }
        if (options.typewriter && desired !== current) {
          scheduleTypewriter('text:' + operation.unitId, (text) => parent.setAttribute(operation.anchor.semanticAttribute, text), desired, tuning);
        } else if (current !== desired) parent.setAttribute(operation.anchor.semanticAttribute, desired);
        stats.applied += 1;
        continue;
      }
      const node = parent?.childNodes?.[operation.anchor.textNodeIndex];
      if (!node || node.nodeType !== Node.TEXT_NODE) { stats.mismatched += 1; continue; }
      const current = String(node.nodeValue || '');
      const currentFingerprint = hash(current);
      if (currentFingerprint !== sourceFingerprint && currentFingerprint !== targetFingerprint) { stats.mismatched += 1; continue; }
      if (options.typewriter && desired !== current) {
        scheduleTypewriter('text:' + operation.unitId, (text) => { node.nodeValue = text; }, desired, tuning);
      } else if (current !== desired) node.nodeValue = desired;
      stats.applied += 1;
    }
    if (!options.typewriter) setTimeout(() => { state.suppressed = false; }, 0);
    else {
      if (typewriter.restoreTimer) clearTimeout(typewriter.restoreTimer);
      typewriter.restoreTimer = setTimeout(() => {
        typewriter.restoreTimer = null;
        state.suppressed = false;
      }, ${typewriterDurationMs} + 1);
    }
    return stats;
  })()`;
}
function buildWebBilingualInjectScript(operations, targetLang, options = {}) {
  const serialized = JSON.stringify(operations);
  const serializedLang = JSON.stringify(targetLang);
  const serializedOptions = JSON.stringify({
    typewriter: options.typewriter === true,
    cached: options.cached === true
  });
  const totalLength = operations.reduce((total, operation) => total + operation.translation.length, 0);
  const tuning = resolveWebTypewriterTuning(totalLength, options.cached === true);
  const serializedTuning = JSON.stringify(tuning);
  const typewriterDurationMs = operations.reduce((longest, operation) => {
    const duration = Math.ceil(operation.translation.length / Math.max(1, tuning.step)) * Math.max(1, tuning.intervalMs);
    return Math.max(longest, duration);
  }, 0);
  const typewriterRuntime = options.typewriter === true ? buildWebTypewriterRuntimeSnippet() : "";
  return `(() => {
    const operations = ${serialized};
    const targetLang = ${serializedLang};
    const options = ${serializedOptions};
    const tuning = ${serializedTuning};
    ${typewriterRuntime}
    const state = window.__selectionTranslatorWebTranslation || (window.__selectionTranslatorWebTranslation = { pageUpdated: false, suppressed: false });
    const stats = { applied: 0, mismatched: 0, skipped: 0 };
    const resolveParent = (selector) => {
      try { return document.querySelector(selector); } catch { return null; }
    };
    state.suppressed = true;
    for (const operation of operations) {
      const block = resolveParent(operation.selector);
      if (!block || block.nodeType !== Node.ELEMENT_NODE) { stats.mismatched += 1; continue; }
      if (block.closest('[data-st-translation]')) { stats.skipped += 1; continue; }
      const display = getComputedStyle(block).display || '';
      let node = null;
      for (const candidate of block.querySelectorAll('[data-st-translation]')) {
        if (candidate.getAttribute('data-st-translation-for') === operation.blockId) { node = candidate; break; }
      }
      if (!node) {
        node = document.createElement('span');
        node.setAttribute('data-st-translation', '');
        node.setAttribute('data-st-translation-for', operation.blockId);
        node.setAttribute('data-st-parent-display', display.indexOf('flex') >= 0 ? 'flex' : display.indexOf('grid') >= 0 ? 'grid' : 'block');
        block.appendChild(node);
      } else {
        node.setAttribute('data-st-parent-display', display.indexOf('flex') >= 0 ? 'flex' : display.indexOf('grid') >= 0 ? 'grid' : 'block');
      }
      if (options.typewriter && node.textContent !== operation.translation) {
        scheduleTypewriter('bilingual:' + operation.blockId, (text) => { node.textContent = text; }, operation.translation, tuning);
      } else if (node.textContent !== operation.translation) node.textContent = operation.translation;
      node.setAttribute('lang', targetLang);
      node.setAttribute('dir', 'auto');
      stats.applied += 1;
    }
    if (!options.typewriter) setTimeout(() => { state.suppressed = false; }, 0);
    else {
      if (typewriter.restoreTimer) clearTimeout(typewriter.restoreTimer);
      typewriter.restoreTimer = setTimeout(() => {
        typewriter.restoreTimer = null;
        state.suppressed = false;
      }, ${typewriterDurationMs} + 1);
    }
    return stats;
  })()`;
}
function buildWebBilingualClearScript() {
  return `(() => {
    const state = window.__selectionTranslatorWebTranslation || (window.__selectionTranslatorWebTranslation = { pageUpdated: false, suppressed: false });
    state.suppressed = true;
    const nodes = document.querySelectorAll('[data-st-translation]');
    let removed = 0;
    for (const node of nodes) { if (node.parentNode) { node.parentNode.removeChild(node); removed += 1; } }
    for (const element of document.querySelectorAll('[data-st-dimmed]')) element.removeAttribute('data-st-dimmed');
    for (const element of document.querySelectorAll('[data-st-parent-display]')) element.removeAttribute('data-st-parent-display');
    setTimeout(() => { state.suppressed = false; }, 0);
    return { applied: removed, mismatched: 0, skipped: 0 };
  })()`;
}
function buildWebBilingualStyleSheet() {
  return [
    "[data-st-translation] { display: block; color: inherit; font: inherit; line-height: inherit; }",
    "[data-st-translation][data-st-parent-display='flex'] { flex: 1 0 100%; }",
    "[data-st-translation][data-st-parent-display='grid'] { grid-column: 1 / -1; }"
  ].join("\n");
}
function buildWebImageOverlayInjectScript(operations) {
  const serialized = JSON.stringify(operations);
  return `(() => {
    const operations = ${serialized};
    const state = window.__selectionTranslatorWebTranslation || (window.__selectionTranslatorWebTranslation = { pageUpdated: false, suppressed: false });
    const stats = { applied: 0, mismatched: 0, skipped: 0 };
    const resolveTarget = (operation) => {
      let element = null;
      try { element = document.querySelector(operation.selector); } catch {}
      if (!element || !Array.isArray(operation.shadowPath) || operation.shadowPath.length === 0) return element;
      let current = element.shadowRoot;
      for (const index of operation.shadowPath) {
        if (!current?.childNodes?.[index]) return null;
        current = current.childNodes[index];
      }
      return current?.nodeType === Node.ELEMENT_NODE ? current : null;
    };
    state.suppressed = true;
    for (const operation of operations) {
      const target = resolveTarget(operation);
      if (!target || target.nodeType !== Node.ELEMENT_NODE) { stats.mismatched += 1; continue; }
      if (target.closest && target.closest('[data-st-image-translation]')) { stats.skipped += 1; continue; }
      let node = null;
      for (const candidate of document.querySelectorAll('[data-st-image-translation]')) {
        if (candidate.getAttribute('data-st-image-translation-for') === operation.imageId) { node = candidate; break; }
      }
      if (!node) {
        node = document.createElement('div');
        node.setAttribute('data-st-image-translation', '');
        node.setAttribute('data-st-image-translation-for', operation.imageId);
        if (operation.placement === 'overlay' && target.parentNode) {
          target.parentNode.insertBefore(node, target.nextSibling);
        } else if (target.parentNode) {
          target.parentNode.insertBefore(node, target.nextSibling);
        }
      }
      // Google Docs 这类页面把正文画在绝对定位的整页 canvas 上，父容器高度等于页面高度，
      // 普通说明块会插到画布左上角遮住正文；此处标记为 canvas 说明块并由样式排到画布下方。
      if (target.tagName === 'CANVAS') node.setAttribute('data-st-image-canvas', 'true');
      else node.removeAttribute('data-st-image-canvas');
      node.setAttribute('data-st-image-placement', operation.placement === 'overlay' ? 'overlay' : 'below');
      const source = document.createElement('div');
      source.setAttribute('data-st-image-source', '');
      source.textContent = operation.ocrText;
      const translation = document.createElement('div');
      translation.setAttribute('data-st-image-target', '');
      translation.setAttribute('lang', operation.lang || '');
      translation.textContent = operation.translation;
      node.textContent = '';
      if (operation.bilingual) node.appendChild(source);
      node.appendChild(translation);
      stats.applied += 1;
    }
    setTimeout(() => { state.suppressed = false; }, 0);
    return stats;
  })()`;
}
function buildWebImageOverlayClearScript() {
  return `(() => {
    const state = window.__selectionTranslatorWebTranslation || (window.__selectionTranslatorWebTranslation = { pageUpdated: false, suppressed: false });
    state.suppressed = true;
    const nodes = document.querySelectorAll('[data-st-image-translation]');
    let removed = 0;
    for (const node of nodes) { if (node.parentNode) { node.parentNode.removeChild(node); removed += 1; } }
    setTimeout(() => { state.suppressed = false; }, 0);
    return { applied: removed, mismatched: 0, skipped: 0 };
  })()`;
}
function buildWebImageOverlayStyleSheet() {
  return [
    "[data-st-image-translation] { display: block; box-sizing: border-box; margin: 6px 0; padding: 8px 10px; border-radius: 6px; font-size: 13px; line-height: 1.5; background: rgba(127,127,127,0.14); color: inherit; font-family: inherit; }",
    "[data-st-image-canvas='true'][data-st-image-placement='below'] { position: absolute; top: 100%; left: 0; right: 0; margin: 0; }",
    "[data-st-image-placement='overlay'] { position: absolute; left: 0; right: 0; bottom: 0; margin: 0; border-radius: 0 0 6px 6px; background: rgba(0,0,0,0.62); color: #fff; max-height: 70%; overflow: auto; }",
    "[data-st-image-target] { display: block; }",
    "[data-st-image-source] { display: block; opacity: 0.7; font-size: 12px; margin-bottom: 4px; }"
  ].join("\n");
}
function buildWebPageChangeObserverScript() {
  return `(() => {
    const previous = window.__selectionTranslatorWebTranslation;
    if (previous?.observer) previous.observer.disconnect();
    const state = window.__selectionTranslatorWebTranslation = { pageUpdated: false, suppressed: false, observer: null };
    const observer = new MutationObserver((records) => {
      if (state.suppressed) return;
      if (records.some((record) => record.type === 'characterData' || record.type === 'childList' || record.type === 'attributes')) state.pageUpdated = true;
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'aria-label', 'title'] });
    state.observer = observer;
    return true;
  })()`;
}
function buildWebPageChangeStatusScript() {
  return `(() => Boolean(window.__selectionTranslatorWebTranslation?.pageUpdated))()`;
}
class WebTextExtractionTimeoutError extends Error {
}
async function executeWebTextExtraction(execute, timeoutMs = 5e3) {
  let timer;
  try {
    const result = await Promise.race([
      execute(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new WebTextExtractionTimeoutError()), timeoutMs);
      })
    ]);
    return {
      snapshot: result.snapshot,
      imageCandidates: Array.isArray(result.imageCandidates) ? result.imageCandidates : [],
      pageMeta: result.pageMeta
    };
  } catch (error2) {
    if (error2 instanceof WebTextExtractionTimeoutError) {
      throw new Error(translateMain("webReader.error.extractionTimeout"));
    }
    throw new Error(translateMain("webReader.error.extractionFailed"));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function waitForWebDocumentReady(execute, timeoutMs = 1e4, intervalMs = 50) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let last;
  while (Date.now() <= deadline) {
    try {
      const readiness = await execute();
      last = readiness;
      if (readiness.hasRoot) {
        return readiness;
      }
    } catch {
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(0, intervalMs), remaining)));
  }
  throw new Error(translateMain(last?.hasRoot ? "webReader.error.documentNotReady" : "webReader.error.rootNotReady"));
}
const WEB_READER_PARTITION = "persist:web-page-translation";
const WEB_INCREMENTAL_DEBOUNCE_MS = 300;
const WEB_INCREMENTAL_STOP_QUIET_MS = 1500;
const WEB_INCREMENTAL_WINDOW_MAX_MS = 3e4;
class WebReaderManager {
  readerId = node_crypto.randomUUID();
  options;
  coordinator;
  pageCache = new WebPageTranslationCache();
  readerSession = null;
  window = null;
  view = null;
  pageRevision = 0;
  extractedUnits = [];
  extractedBlocks = [];
  blockUnitIds = /* @__PURE__ */ new Map();
  extractedImageCandidates = [];
  imageFilterSkipped = 0;
  translatedUnits = [];
  translatedImageCandidates = [];
  bilingualInjected = false;
  bilingualCssKey = null;
  bilingualTargetLang = "";
  imageOverlayInjected = false;
  imageOverlayCssKey = null;
  streamBlockIds = /* @__PURE__ */ new Map();
  activeJobId = "";
  activeSourceLang = "";
  activeTargetLang = "";
  activeAbort = null;
  mode = "target";
  pageChangeTimer = null;
  incrementalPollTimer = null;
  incrementalQuietTimer = null;
  incrementalDeadlineTimer = null;
  activeStream = null;
  incrementalUnitSequence = 0;
  incrementalDrainQueue = Promise.resolve();
  incrementalUnitHandler = null;
  incrementalImageHandler = null;
  incrementalWindowRevision = null;
  incrementalGeneration = 0;
  incrementalFinishPromise = null;
  incrementalStopPromise = Promise.resolve();
  incrementalSeenUnitKeys = /* @__PURE__ */ new Set();
  hasExtractedSnapshot = false;
  /** 是否正在「先交还前台、再关闭窗口」的过程中，用于阻止重复关闭。 */
  closingWindow = false;
  /** 本次关闭是否已经获准放行 close 事件，避免统一关闭入口被再次拦截。 */
  allowWindowClose = false;
  state;
  /** 创建网页阅读器管理器。
   * @param options 阅读器依赖。
   * @author zhenghq
   */
  constructor(options) {
    this.options = options;
    this.coordinator = new PageTranslationCoordinator({
      // 每次调度都读取最新设置，用户调整并发数后无需重启阅读器即可生效。
      concurrency: () => this.options.getSettings().webTranslationConcurrency,
      translate: options.translate
    });
    this.state = this.createState();
  }
  /** 打开或聚焦阅读器。
   * @param url 可选初始 URL。
   * @param options 打开选项；`bringToFront` 为 true 时走统一窗口级置前入口。
   * @returns 无返回值。
   * @author zhenghq
   */
  async open(url, options = {}) {
    if (!this.options.getSettings().webTranslationEnabled) {
      throw new Error(translateMain("webReader.error.disabled"));
    }
    if (this.closingWindow) return;
    await rememberFrontmostAppIfInactiveAsync();
    await this.ensureWindow();
    const window2 = this.window;
    if (window2 && !window2.isDestroyed()) {
      if (options.bringToFront && this.options.bringToFrontToOwnWindow) {
        this.options.bringToFrontToOwnWindow(window2);
      } else {
        window2.show();
        window2.focus();
      }
    }
    if (url) await this.navigate(url);
  }
  /**
   * 判断指定窗口是否为当前有效的网页阅读器壳窗口。
   * @param window 待校验窗口。
   * @returns 属于当前有效阅读器壳窗口时返回 true。
   * @author zhenghq
   */
  ownsWindow(window2) {
    return this.window === window2 && !window2.isDestroyed();
  }
  /**
   * 激活仍然存在的网页阅读器窗口，供内部 activate 回调复用。
   * @returns 已成功激活时返回 true；窗口不存在或已销毁时返回 false。
   * @author zhenghq
   */
  focusExistingWindow() {
    if (!this.window || this.window.isDestroyed()) return false;
    if (this.window.isMinimized()) this.window.restore();
    if (this.window.isVisible() && !this.window.isMinimized()) return true;
    this.window.show();
    this.window.focus();
    return true;
  }
  /**
   * 通过显式用户入口打开或聚焦网页阅读器窗口。
   * 即使窗口已可见也重新 show()+focus()，以处理被其它应用遮挡的场景。
   * @returns 窗口存在并已尝试置前时返回 true；窗口不存在或已销毁时返回 false。
   * @author zhenghq
   */
  focusOrOpenExistingWindow() {
    if (!this.window || this.window.isDestroyed()) return false;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    return true;
  }
  /**
   * 返回阅读器窗口当前可见的屏幕区域，供划词监听排除应用内鼠标操作。
   * @returns 窗口可见时返回其屏幕区域，不可见或已销毁时返回 null。
   * @author zhenghq
   */
  getVisibleBounds() {
    if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) return null;
    return this.window.getBounds();
  }
  /**
   * 返回阅读器窗口当前是否持有焦点，供划词监听区分前台与后台窗口。
   * @returns 窗口存在且持有焦点时返回 true。
   * @author zhenghq
   */
  isWindowFocused() {
    if (!this.window || this.window.isDestroyed()) return false;
    return this.window.isFocused();
  }
  /** 关闭阅读器并取消任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  close() {
    const window2 = this.window;
    if (!window2 || window2.isDestroyed()) return;
    this.cancel();
    if (this.closingWindow) return;
    this.closingWindow = true;
    if (this.options.hasVisibleSettingsWindow?.()) {
      this.closingWindow = false;
      this.allowWindowClose = true;
      window2.close();
      return;
    }
    handBackFrontmostThen(window2, () => {
      this.closingWindow = false;
      if (window2.isDestroyed()) return;
      this.allowWindowClose = true;
      window2.close();
    });
  }
  /**
   * 应用退出时立即销毁阅读器，不再交还前台。
   * 退出流程中应用整体结束，交还会额外激活源应用，反而干扰系统退出动画。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose() {
    this.cancel();
    const window2 = this.window;
    if (!window2 || window2.isDestroyed()) return;
    this.allowWindowClose = true;
    this.closingWindow = false;
    window2.destroy();
  }
  /** 导航到 HTTP(S) URL。
   * @param url 地址栏内容。
   * @returns 最新导航状态。
   * @author zhenghq
   */
  async navigate(url) {
    await this.ensureWindow();
    const normalized = toWebReaderHtmlViewUrl(normalizeWebReaderUrl(url));
    this.clearError();
    await this.view?.webContents.loadURL(normalized);
    return this.getState();
  }
  /** 在历史记录中后退。
   * @returns 无返回值。
   * @author zhenghq
   */
  back() {
    if (this.view?.webContents.navigationHistory.canGoBack()) this.view.webContents.navigationHistory.goBack();
  }
  /** 在历史记录中前进。
   * @returns 无返回值。
   * @author zhenghq
   */
  forward() {
    if (this.view?.webContents.navigationHistory.canGoForward()) this.view.webContents.navigationHistory.goForward();
  }
  /** 刷新当前网页。
   * @returns 无返回值。
   * @author zhenghq
   */
  reload() {
    this.view?.webContents.reload();
  }
  /** 同步原生 View 矩形。
   * @param bounds Renderer 占位区矩形。
   * @returns 无返回值。
   * @author zhenghq
   */
  setBounds(bounds) {
    if (!this.window || !this.view || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    this.view.setBounds(this.calculateViewBounds(bounds, { width, height }));
  }
  /**
   * 计算远程网页视图的安全可用区域，确保标题栏和本地工具栏不被覆盖。
   * @param bounds Renderer 占位区矩形。
   * @param contentSize 当前窗口内容区尺寸。
   * @returns 裁剪后的 WebContentsView 矩形。
   * @author zhenghq
   */
  calculateViewBounds(bounds, contentSize) {
    return sanitizeWebViewBounds(bounds, contentSize);
  }
  /** 显式提取当前已渲染网页文本并启动初始加载增量收集器。
   * @returns 最新提取结果。
   * @author zhenghq
   */
  async extract() {
    const view = this.requireLoadedView();
    this.invalidateActiveJob(true);
    await this.clearBilingualInjection();
    await this.clearImageOverlays();
    await this.incrementalStopPromise;
    const navigationRevision = this.pageRevision;
    await waitForWebDocumentReady(
      () => view.webContents.executeJavaScript(buildWebDocumentReadyScript(), true)
    );
    await this.restoreSource();
    const raw = await executeWebTextExtraction(
      () => view.webContents.executeJavaScript(buildWebIncrementalCollectorStartScript(WEB_INCREMENTAL_DEBOUNCE_MS), true)
    );
    if (navigationRevision !== this.pageRevision) {
      throw new Error(translateMain("webReader.error.pageChanged"));
    }
    const result = extractWebTextBlocks(raw.snapshot, raw.pageMeta);
    const settings = this.options.getSettings();
    const imageFilter = settings.webTranslationImageOcrEnabled ? filterWebImageCandidates(raw.imageCandidates, {
      minSize: settings.webTranslationImageOcrMinSize,
      maxImages: settings.webTranslationImageOcrMaxImages
    }) : { accepted: [], skipped: raw.imageCandidates.length };
    this.pageRevision += 1;
    this.extractedUnits = result.units;
    this.extractedBlocks = result.blocks;
    this.blockUnitIds = this.createBlockUnitIds(result.units);
    this.extractedImageCandidates = imageFilter.accepted;
    this.imageFilterSkipped = imageFilter.skipped;
    this.translatedUnits = [];
    this.translatedImageCandidates = [];
    this.streamBlockIds.clear();
    this.incrementalUnitSequence = result.units.length;
    this.incrementalSeenUnitKeys = new Set(result.units.map((unit) => this.unitKey(unit)));
    this.hasExtractedSnapshot = true;
    this.state = {
      ...this.state,
      pageRevision: this.pageRevision,
      pageUpdated: false,
      translationWindowActive: true,
      translationDiscovered: 0,
      translationDone: 0,
      translationCacheHits: 0,
      ...summarizeWebImageProgress(this.extractedImageCandidates),
      imageSkipped: summarizeWebImageProgress(this.extractedImageCandidates).imageSkipped + this.imageFilterSkipped
    };
    this.emitState();
    this.stopPageChangePolling();
    return {
      ...result,
      readerId: this.readerId,
      pageRevision: this.pageRevision,
      imageCandidates: this.extractedImageCandidates.map((candidate) => ({ ...candidate }))
    };
  }
  /** 按语言方向翻译当前快照并原位写回。
   * @param request 翻译范围和语言方向。
   * @returns 翻译、聚合与写回结果。
   * @author zhenghq
   */
  async run(request = {}) {
    if (!this.hasExtractedSnapshot) throw new Error(translateMain("webReader.error.extractFirst"));
    this.invalidateActiveJob(false);
    await this.clearBilingualInjection();
    await this.clearImageOverlays();
    await this.restoreSource();
    const settings = this.options.getSettings();
    const sourceLang = request.sourceLang?.trim() || settings.sourceLang || "auto";
    const configuredTarget = request.targetLang?.trim() || settings.targetLang?.trim();
    const targetLang = configuredTarget && configuredTarget.toLowerCase() !== "auto" ? configuredTarget : "ZH";
    const jobId = node_crypto.randomUUID();
    const controller = new AbortController();
    const revision = this.pageRevision;
    const scope = request.scope ?? settings.webTranslationScope;
    this.activeJobId = jobId;
    this.activeSourceLang = sourceLang;
    this.activeTargetLang = targetLang;
    this.bilingualTargetLang = targetLang;
    this.activeAbort = controller;
    let apply = { applied: 0, mismatched: 0, skipped: 0 };
    let applyQueue = Promise.resolve();
    const latestResults = /* @__PURE__ */ new Map();
    const cachedTranslations = /* @__PURE__ */ new Map();
    const cacheContext = this.createCacheContext(scope, sourceLang, targetLang);
    const imagePlacement = settings.webTranslationImageOcrOverlay;
    const imageCandidates = settings.webTranslationImageOcrEnabled ? this.extractedImageCandidates.map((candidate) => ({ ...candidate })) : [];
    const cachedImageHits = /* @__PURE__ */ new Map();
    for (const hit of this.pageCache.matchImages(cacheContext, imageCandidates)) {
      cachedImageHits.set(hit.imageId, hit);
    }
    const cachedImageCandidates = imageCandidates.map((candidate) => cachedImageHits.get(candidate.imageId) ?? candidate);
    const pendingImageCandidates = imageCandidates.filter((candidate) => !cachedImageHits.has(candidate.imageId));
    let imageCandidatesResult = cachedImageCandidates;
    let imageCancelled = false;
    const processedImageIds = new Set(cachedImageHits.keys());
    let imageProcessChain = Promise.resolve();
    const isCurrentJob = () => this.activeJobId === jobId && this.pageRevision === revision && this.activeSourceLang === sourceLang && this.activeTargetLang === targetLang;
    const currentImageSummary = () => {
      const summary = summarizeWebImageProgress(imageCandidatesResult);
      return { ...summary, imageSkipped: summary.imageSkipped + this.imageFilterSkipped };
    };
    const processImageBatch = async (batch) => {
      if (batch.length === 0 || !isCurrentJob()) return;
      const createSource = this.options.createImageSource;
      const recognizeImage = this.options.recognizeImage;
      const view = this.view;
      const canFetch = Boolean(createSource && recognizeImage && view && !view.webContents.isDestroyed());
      let processedCandidates;
      if (canFetch) {
        const source = createSource.call(this.options, view, controller.signal);
        const processed = await processWebImageCandidates(batch, {
          source,
          recognize: (bytes, candidate) => recognizeImage.call(this.options, bytes, candidate),
          translate: async (text) => {
            const output = await this.options.translate(text, sourceLang, targetLang);
            return { translation: output.translation };
          },
          sourceLang,
          targetLang,
          signal: controller.signal
        });
        imageCancelled = imageCancelled || processed.cancelled;
        processedCandidates = processed.candidates;
      } else {
        processedCandidates = batch.map((candidate) => ({ ...candidate, skippedReason: "unavailable" }));
      }
      imageCandidatesResult = mergeWebImageResults(imageCandidatesResult, processedCandidates);
      for (const candidate of processedCandidates) processedImageIds.add(candidate.imageId);
      if (!isCurrentJob()) return;
      this.translatedImageCandidates = imageCandidatesResult;
      this.state = { ...this.state, ...currentImageSummary() };
      this.emitState();
      this.emitProgress({
        readerId: this.readerId,
        pageRevision: revision,
        jobId,
        done: this.state.translationDone ?? 0,
        discovered: this.state.translationDiscovered ?? 0,
        queued: 0,
        total: this.state.translationDiscovered ?? 0,
        failed: 0,
        cancelled: imageCancelled,
        partial: false,
        inputClosed: this.state.translationWindowActive !== true,
        sourceLang,
        targetLang,
        cacheHits: cachedTranslations.size,
        images: currentImageSummary()
      });
      await this.applyImageOverlays(imagePlacement);
    };
    const enqueueImageBatch = (batch) => {
      if (batch.length === 0) return Promise.resolve();
      const run = imageProcessChain.then(() => processImageBatch(batch));
      imageProcessChain = run.catch(() => void 0);
      return run;
    };
    const imagePromise = enqueueImageBatch(pendingImageCandidates);
    const addApplyResult = (result2) => {
      apply = {
        applied: apply.applied + result2.applied,
        mismatched: apply.mismatched + result2.mismatched,
        skipped: apply.skipped + result2.skipped,
        bilingualSkipped: (apply.bilingualSkipped ?? 0) + (result2.bilingualSkipped ?? 0),
        unrendered: (apply.unrendered ?? 0) + (result2.unrendered ?? 0)
      };
    };
    const applyCacheHits = async (units2) => {
      if (!isCurrentJob() || units2.length === 0) return;
      for (const unit of units2) cachedTranslations.set(unit.id, unit);
      this.translatedUnits = this.mergeTranslatedUnits(latestResults, cachedTranslations);
      this.state = { ...this.state, translationCacheHits: cachedTranslations.size };
      this.emitState();
      applyQueue = applyQueue.then(async () => {
        if (!isCurrentJob()) return;
        if (this.mode === "bilingual") {
          addApplyResult(await this.applyBilingual(void 0, { typewriter: true, cached: true }));
        } else if (this.mode === "target") {
          addApplyResult(await this.applyUnits(
            "target",
            new Set(units2.map((unit) => unit.id)),
            { typewriter: true, cached: true }
          ));
        }
      });
      await applyQueue;
    };
    const initialHits = this.selectCompleteCacheHits(
      this.pageCache.match(cacheContext, this.extractedUnits),
      this.extractedUnits
    );
    await applyCacheHits(initialHits);
    const initialHitIds = new Set(initialHits.map((unit) => unit.id));
    const stream = this.coordinator.createStream({
      readerId: this.readerId,
      pageRevision: revision,
      jobId,
      scope,
      maxCharsPerSegment: WEB_TRANSLATION_MAX_CHARS_PER_SEGMENT,
      // 相邻短段落合并为一次请求，显著降低请求数；模型未保留分隔标记时协调器会自动逐段回退。
      mergeAcrossBlocks: true,
      maxBlocks: settings.webTranslationMaxBlocks,
      maxChars: settings.webTranslationMaxChars,
      locale: sourceLang === "auto" ? void 0 : sourceLang,
      sourceLang,
      targetLang
    }, (progress) => {
      this.state = {
        ...this.state,
        translationDiscovered: progress.discovered,
        translationDone: progress.done,
        translationWindowActive: !progress.inputClosed,
        ...currentImageSummary()
      };
      this.emitState();
      this.emitProgress({
        ...progress,
        readerId: this.readerId,
        sourceLang,
        targetLang,
        cacheHits: cachedTranslations.size,
        images: currentImageSummary()
      });
    }, controller.signal, async (segmentResult, unitComplete) => {
      if (!isCurrentJob()) return;
      latestResults.set(segmentResult.segmentId, segmentResult);
      if (!unitComplete) return;
      applyQueue = applyQueue.then(async () => {
        if (!isCurrentJob()) return;
        const units2 = this.mergeTranslatedUnits(latestResults, cachedTranslations);
        const primaryUnitId = segmentResult.unitIds[0] ?? segmentResult.unitId;
        const completedUnit = units2.find((unit) => unit.id === primaryUnitId);
        if (!completedUnit || !isCurrentJob()) return;
        this.translatedUnits = units2;
        if (isCurrentJob() && this.mode === "bilingual") {
          if (this.isBlockComplete(completedUnit.blockId, units2)) {
            addApplyResult(await this.applyBilingual(/* @__PURE__ */ new Set([completedUnit.blockId]), { typewriter: true }));
          }
        } else if (isCurrentJob() && this.mode === "target" && typeof completedUnit.translation === "string") {
          const blockUnitIds = this.blockUnitIds.get(completedUnit.blockId);
          if (blockUnitIds && this.isBlockComplete(completedUnit.blockId, units2)) {
            addApplyResult(await this.applyUnits("target", new Set(blockUnitIds), { typewriter: true }));
          }
        }
      });
      await applyQueue;
    });
    this.activeStream = stream;
    stream.enqueue(this.extractedUnits.filter((unit) => !initialHitIds.has(unit.id)));
    this.startIncrementalWindow(stream, revision, async (newUnits) => {
      if (!isCurrentJob()) return;
      const currentContext = this.createCacheContext(scope, sourceLang, targetLang);
      const hits = this.selectCompleteCacheHits(this.pageCache.match(currentContext, newUnits), newUnits);
      await applyCacheHits(hits);
      const hitIds = new Set(hits.map((unit) => unit.id));
      stream.enqueue(newUnits.filter((unit) => !hitIds.has(unit.id)));
    }, async (newImages) => {
      if (!isCurrentJob()) return;
      const currentContext = this.createCacheContext(scope, sourceLang, targetLang);
      const hits = this.pageCache.matchImages(currentContext, newImages);
      const hitById = new Map(hits.map((candidate) => [candidate.imageId, candidate]));
      const pending = [];
      for (const candidate of newImages) {
        const hit = hitById.get(candidate.imageId);
        if (hit) {
          processedImageIds.add(hit.imageId);
          imageCandidatesResult.push(hit);
        } else {
          pending.push(candidate);
        }
      }
      await enqueueImageBatch(pending);
    });
    const result = await stream.result;
    await applyQueue;
    await imagePromise;
    await imageProcessChain;
    const current = isCurrentJob();
    let units = [];
    if (current) {
      units = this.mergeTranslatedUnits(latestResults, cachedTranslations);
      this.translatedUnits = units;
      if (!result.progress.cancelled) {
        const finalContext = this.createCacheContext(scope, sourceLang, targetLang);
        this.pageCache.put(finalContext, units.map((unit) => ({
          sourceText: unit.sourceText,
          sourceFingerprint: unit.anchor.sourceFingerprint,
          translation: unit.translation,
          error: unit.error
        })));
        if (!imageCancelled) this.pageCache.putImages(finalContext, imageCandidatesResult);
        this.activeJobId = "";
        this.activeAbort = null;
        this.activeStream = null;
      }
    }
    return {
      ...result,
      results: result.results,
      units,
      apply,
      sourceLang,
      targetLang,
      cacheHits: cachedTranslations.size,
      images: currentImageSummary(),
      progress: {
        ...result.progress,
        readerId: this.readerId,
        sourceLang,
        targetLang,
        cacheHits: cachedTranslations.size,
        images: currentImageSummary()
      }
    };
  }
  /** 取消当前任务并拒绝迟到结果。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancel() {
    void this.clearBilingualInjection();
    void this.clearImageOverlays();
    this.invalidateActiveJob(true);
  }
  /** 在原文和当前译文之间切换，不重新加载页面。
   * @param mode 展示模式。
   * @returns 写回统计。
   * @author zhenghq
   */
  async setMode(mode) {
    await this.cancelTypewriter();
    if (this.bilingualInjected && mode !== "bilingual") await this.clearBilingualInjection();
    this.mode = mode;
    const placement = this.options.getSettings().webTranslationImageOcrOverlay;
    if (mode === "source") {
      await this.clearImageOverlays();
      return this.applyUnits("source");
    }
    if (mode === "target") {
      const result = await this.applyUnits("target");
      await this.applyImageOverlays(placement);
      return result;
    }
    await this.applyUnits("source");
    await this.applyImageOverlays(placement);
    return this.applyBilingual();
  }
  /** 将代理配置应用到独立阅读器 Session。
   * @param settings 当前设置。
   * @returns 应用完成的 Promise。
   * @author zhenghq
   */
  async applyProxy(settings) {
    const currentSession = this.getSession();
    await currentSession.setProxy(buildProxyConfig(settings));
    await currentSession.closeAllConnections();
  }
  /** 返回当前阅读器状态。
   * @returns 状态副本。
   * @author zhenghq
   */
  getState() {
    return { ...this.state };
  }
  /**
   * 根据最新分段结果和页面缓存结果聚合当前快照。
   * @param latestResults 当前任务已经完成的分段结果。
   * @param cachedTranslations 当前页面缓存命中的文本单元译文。
   * @returns 按当前页面快照顺序排列的文本单元结果。
   * @author zhenghq
   */
  mergeTranslatedUnits(latestResults, cachedTranslations) {
    const translated = aggregatePageTranslationUnits(
      this.extractedUnits,
      Array.from(latestResults.values())
    );
    return translated.map((unit) => cachedTranslations.get(unit.id) ?? unit);
  }
  /**
   * 创建当前页面翻译缓存上下文，避免不同配置之间串用译文。
   * @param scope 当前翻译范围。
   * @param sourceLang 当前源语言。
   * @param targetLang 当前目标语言。
   * @returns 页面缓存上下文。
   * @author zhenghq
   */
  createCacheContext(scope, sourceLang, targetLang) {
    const settings = this.options.getSettings();
    const translationContext = JSON.stringify({
      preferredTranslationProvider: settings.preferredTranslationProvider,
      aiEnabled: settings.aiEnabled,
      aiProtocol: settings.aiProtocol,
      aiBaseUrl: settings.aiBaseUrl,
      aiModel: settings.aiModel,
      microsoftEnabled: settings.microsoftEnabled,
      deepLxUrl: settings.deepLxUrl,
      dingTalkEnabled: settings.dingTalkEnabled
    });
    return {
      url: this.state.url,
      pageFingerprint: createWebPageContentFingerprint(this.extractedUnits),
      scope: scope ?? settings.webTranslationScope,
      sourceLang,
      targetLang,
      translationContext
    };
  }
  /**
   * 生成主进程侧的文本单元去重键，防止局部快照重复加入翻译队列。
   * @param unit 待去重的网页文本单元。
   * @returns 由锚点、原文指纹和原文组成的稳定键。
   * @author zhenghq
   */
  unitKey(unit) {
    return createWebTextUnitKey(unit);
  }
  /**
   * 启动有限的网页初始加载增量翻译窗口。
   * @param stream 当前页面翻译流。
   * @param revision 当前页面代次。
   * @param onUnits 新增文本单元回调。
   * @returns 无返回值。
   * @author zhenghq
   */
  startIncrementalWindow(stream, revision, onUnits, onImages) {
    const collectorActive = this.state.translationWindowActive === true;
    this.stopIncrementalTimers();
    this.incrementalGeneration += 1;
    this.incrementalFinishPromise = null;
    this.incrementalWindowRevision = revision;
    this.incrementalUnitHandler = onUnits;
    this.incrementalImageHandler = onImages ?? null;
    this.activeStream = stream;
    if (!collectorActive) {
      this.incrementalWindowRevision = null;
      this.incrementalUnitHandler = null;
      this.incrementalImageHandler = null;
      this.activeStream = null;
      stream.closeInput();
      void this.installPageChangeMonitoring(revision);
      return;
    }
    const poll = () => {
      void this.drainIncrementalUnits(revision);
    };
    this.incrementalPollTimer = setInterval(poll, WEB_INCREMENTAL_DEBOUNCE_MS);
    poll();
    this.incrementalDeadlineTimer = setTimeout(() => {
      void this.finishIncrementalWindow(revision, true);
    }, WEB_INCREMENTAL_WINDOW_MAX_MS);
    if (!this.state.loading) this.scheduleIncrementalQuietStop(revision);
  }
  /**
   * 排空页面侧增量快照并把新增文本追加到当前翻译任务。
   * @param revision 当前页面代次。
   * @returns 排空完成后的 Promise。
   * @author zhenghq
   */
  drainIncrementalUnits(revision) {
    const run = this.incrementalDrainQueue.then(async () => {
      if (this.incrementalWindowRevision !== revision || this.pageRevision !== revision) return;
      const contents = this.view?.webContents;
      if (!contents || contents.isDestroyed()) return;
      let batch;
      try {
        batch = await contents.executeJavaScript(buildWebIncrementalCollectorDrainScript(), true);
      } catch (error2) {
        if (!isDisposedWebFrameError(error2)) this.markPageUpdated();
        return;
      }
      if (this.incrementalWindowRevision !== revision || this.pageRevision !== revision) return;
      if (!batch.active) {
        void this.finishIncrementalWindow(revision, true);
        return;
      }
      const newUnits = [];
      const snapshots = batch.snapshots ?? [];
      const newImages = batch.imageCandidates ?? [];
      for (const snapshot of snapshots) {
        const extracted = extractWebTextBlocks(snapshot, batch.pageMeta);
        for (const unit of extracted.units) {
          const key = this.unitKey(unit);
          if (this.incrementalSeenUnitKeys.has(key)) continue;
          this.incrementalSeenUnitKeys.add(key);
          const sequence = this.incrementalUnitSequence++;
          const streamBlockId = this.streamBlockIds.get(unit.blockId) ?? `${unit.blockId}:stream`;
          this.streamBlockIds.set(unit.blockId, streamBlockId);
          newUnits.push({
            ...unit,
            id: `stream-${revision}-${sequence}`,
            blockId: streamBlockId
          });
        }
        for (const block of extracted.blocks) {
          const streamBlockId = this.streamBlockIds.get(block.id) ?? `${block.id}:stream`;
          this.streamBlockIds.set(block.id, streamBlockId);
          if (this.extractedBlocks.some((existing) => existing.id === streamBlockId)) continue;
          this.extractedBlocks.push({ ...block, id: streamBlockId });
        }
      }
      if (snapshots.length > 0 || newImages.length > 0) this.scheduleIncrementalQuietStop(revision);
      if (newImages.length > 0) {
        const settings = this.options.getSettings();
        if (settings.webTranslationImageOcrEnabled) {
          const filter = filterWebImageCandidates(newImages, {
            minSize: settings.webTranslationImageOcrMinSize,
            maxImages: settings.webTranslationImageOcrMaxImages
          });
          this.imageFilterSkipped += filter.skipped;
          const known = new Set(this.extractedImageCandidates.map((candidate) => candidate.imageId));
          const added = filter.accepted.filter((candidate) => {
            if (known.has(candidate.imageId)) return false;
            known.add(candidate.imageId);
            return true;
          });
          if (added.length > 0) {
            this.extractedImageCandidates.push(...added);
            await this.incrementalImageHandler?.(added.map((candidate) => ({ ...candidate })));
          }
        } else {
          this.imageFilterSkipped += newImages.length;
        }
      }
      if (newUnits.length === 0) return;
      this.extractedUnits.push(...newUnits);
      this.blockUnitIds = this.createBlockUnitIds(this.extractedUnits);
      this.state = {
        ...this.state,
        translationDiscovered: this.activeStream?.getProgress().discovered ?? this.state.translationDiscovered
      };
      this.emitState();
      await this.incrementalUnitHandler?.(newUnits);
    });
    this.incrementalDrainQueue = run.catch(() => void 0);
    return run;
  }
  /**
   * 页面停止加载后安排静默期结束增量窗口。
   * @param revision 当前页面代次。
   * @returns 无返回值。
   * @author zhenghq
   */
  scheduleIncrementalQuietStop(revision) {
    if (this.incrementalQuietTimer) clearTimeout(this.incrementalQuietTimer);
    this.incrementalQuietTimer = setTimeout(() => {
      this.incrementalQuietTimer = null;
      void this.drainIncrementalUnits(revision).catch(() => void 0).then(() => {
        if (this.incrementalWindowRevision !== revision || this.pageRevision !== revision) return;
        if (this.incrementalQuietTimer) return;
        void this.finishIncrementalWindow(revision);
      });
    }, WEB_INCREMENTAL_STOP_QUIET_MS);
  }
  /**
   * 结束增量收集器并关闭翻译流输入，之后只保留页面变化提示。
   * @param revision 当前页面代次。
   * @param force 是否忽略静默期续期并立即结束，最长窗口到期时使用。
   * @returns 停止操作完成后的 Promise。
   * @author zhenghq
   */
  async finishIncrementalWindow(revision, force = false) {
    if (this.incrementalWindowRevision !== revision) return;
    if (this.incrementalFinishPromise) return this.incrementalFinishPromise;
    const generation = this.incrementalGeneration;
    const finish = (async () => {
      await this.drainIncrementalUnits(revision);
      if (generation !== this.incrementalGeneration || this.incrementalWindowRevision !== revision) return;
      if (!force && this.incrementalQuietTimer) return;
      this.stopIncrementalTimers();
      const stream = this.activeStream;
      this.incrementalWindowRevision = null;
      this.incrementalUnitHandler = null;
      this.activeStream = null;
      stream?.closeInput();
      this.state = { ...this.state, translationWindowActive: false };
      this.emitState();
      const contents = this.view?.webContents;
      if (contents && !contents.isDestroyed()) {
        try {
          await contents.executeJavaScript(buildWebIncrementalCollectorStopScript(), true);
        } catch (error2) {
          if (!isDisposedWebFrameError(error2)) this.markPageUpdated();
        }
      }
      if (generation === this.incrementalGeneration) await this.installPageChangeMonitoring(revision);
    })();
    this.incrementalFinishPromise = finish.finally(() => {
      if (generation === this.incrementalGeneration) this.incrementalFinishPromise = null;
    });
    return this.incrementalFinishPromise;
  }
  /**
   * 立即终止增量窗口，不再排空旧页面缓冲区。
   * @returns 无返回值。
   * @author zhenghq
   */
  abortIncrementalWindow() {
    this.incrementalGeneration += 1;
    this.incrementalFinishPromise = null;
    this.stopIncrementalTimers();
    this.incrementalWindowRevision = null;
    this.incrementalUnitHandler = null;
    this.activeStream?.closeInput();
    this.activeStream = null;
    this.state = { ...this.state, translationWindowActive: false };
    this.emitState();
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) {
      this.incrementalStopPromise = contents.executeJavaScript(buildWebIncrementalCollectorStopScript(), true).catch(() => void 0);
    } else {
      this.incrementalStopPromise = Promise.resolve();
    }
  }
  /**
   * 安装窗口结束后的页面变化观察器并启动状态轮询。
   * @param revision 当前页面代次。
   * @returns 安装完成后的 Promise。
   * @author zhenghq
   */
  async installPageChangeMonitoring(revision) {
    if (this.pageRevision !== revision) return;
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    try {
      await contents.executeJavaScript(buildWebPageChangeObserverScript(), true);
      if (this.pageRevision === revision) this.startPageChangePolling();
    } catch (error2) {
      if (!isDisposedWebFrameError(error2)) this.markPageUpdated();
    }
  }
  /**
   * 清理增量窗口的轮询和定时器。
   * @returns 无返回值。
   * @author zhenghq
   */
  stopIncrementalTimers() {
    if (this.incrementalPollTimer) clearInterval(this.incrementalPollTimer);
    if (this.incrementalQuietTimer) clearTimeout(this.incrementalQuietTimer);
    if (this.incrementalDeadlineTimer) clearTimeout(this.incrementalDeadlineTimer);
    this.incrementalPollTimer = null;
    this.incrementalQuietTimer = null;
    this.incrementalDeadlineTimer = null;
  }
  /**
   * 判断指定块内的全部文本单元是否都已取得成功译文。
   * @param blockId 目标块标识。
   * @param units 当前页面的全部文本单元结果。
   * @returns 块内全部单元均已完成时返回 true。
   * @author zhenghq
   */
  isBlockComplete(blockId, units) {
    const unitIds = this.blockUnitIds.get(blockId);
    if (!unitIds || unitIds.length === 0) return false;
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    return unitIds.every((unitId) => typeof byId.get(unitId)?.translation === "string");
  }
  /**
   * 建立块到单元标识的映射，供对照模式按块聚合使用。
   * @param units 当前页面的全部文本单元。
   * @returns 块标识到单元标识列表的映射。
   * @author zhenghq
   */
  createBlockUnitIds(units) {
    const mapping = /* @__PURE__ */ new Map();
    for (const unit of units) {
      const list = mapping.get(unit.blockId);
      if (list) list.push(unit.id);
      else mapping.set(unit.blockId, [unit.id]);
    }
    return mapping;
  }
  /**
   * 仅保留整段文本单元全部命中的缓存结果，避免段落级翻译拼接部分缓存译文。
   * @param hits 当前批次命中的缓存单元。
   * @param units 当前批次参与匹配的文本单元。
   * @returns 可以安全复用的完整段落缓存单元。
   * @author zhenghq
   */
  selectCompleteCacheHits(hits, units) {
    if (hits.length === 0) return hits;
    const hitIds = new Set(hits.map((unit) => unit.id));
    const unitsByBlock = /* @__PURE__ */ new Map();
    for (const unit of units) {
      const list = unitsByBlock.get(unit.blockId);
      if (list) list.push(unit);
      else unitsByBlock.set(unit.blockId, [unit]);
    }
    const completeBlocks = /* @__PURE__ */ new Set();
    for (const [blockId, blockUnits] of unitsByBlock) {
      if (blockUnits.every((unit) => hitIds.has(unit.id))) completeBlocks.add(blockId);
    }
    return hits.filter((hit) => completeBlocks.has(hit.blockId));
  }
  /**
   * 按块聚合构建并执行对照译文注入，返回注入与未对照统计。
   * @returns 对照注入统计。
   * @author zhenghq
   */
  async applyBilingual(onlyBlockIds, options = {}) {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) {
      return { applied: 0, mismatched: 0, skipped: 0, bilingualSkipped: 0, unrendered: 0 };
    }
    const translations = /* @__PURE__ */ new Map();
    for (const unit of this.translatedUnits) {
      if (typeof unit.translation === "string") translations.set(unit.id, unit.translation);
    }
    const blocks = onlyBlockIds ? this.extractedBlocks.filter((block) => onlyBlockIds.has(block.id)) : this.extractedBlocks;
    const built = buildWebBilingualOperations({
      blocks,
      units: onlyBlockIds ? this.extractedUnits.filter((unit) => onlyBlockIds.has(unit.blockId)) : this.extractedUnits,
      translations
    });
    const configured = this.bilingualTargetLang || this.options.getSettings().targetLang?.trim() || "";
    const targetLang = configured && configured.toLowerCase() !== "auto" ? configured : "ZH";
    try {
      await this.ensureBilingualStyles(view);
      const result = await view.webContents.executeJavaScript(
        buildWebBilingualInjectScript(built.operations, targetLang, options),
        true
      );
      this.bilingualInjected = true;
      if (result.mismatched > 0) this.markPageUpdated();
      return {
        applied: result.applied,
        mismatched: result.mismatched,
        skipped: result.skipped,
        bilingualSkipped: built.skipped,
        unrendered: built.unrendered
      };
    } catch (error2) {
      if (isDisposedWebFrameError(error2)) {
        return { applied: 0, mismatched: 0, skipped: built.operations.length, bilingualSkipped: built.skipped, unrendered: built.unrendered };
      }
      throw error2;
    }
  }
  /**
   * 注入对照样式表并记录 key，重复调用不重复注入。
   * @param view 远程网页视图。
   * @returns 注入完成后的 Promise。
   * @author zhenghq
   */
  async ensureBilingualStyles(view) {
    if (this.bilingualCssKey) return;
    this.bilingualCssKey = await view.webContents.insertCSS(buildWebBilingualStyleSheet());
  }
  /**
   * 清除对照注入节点与样式，远程 Frame 已销毁时安全跳过。
   * @returns 清理完成后的 Promise。
   * @author zhenghq
   */
  async clearBilingualInjection() {
    const view = this.view;
    const cssKey = this.bilingualCssKey;
    this.bilingualInjected = false;
    this.bilingualCssKey = null;
    if (!view || view.webContents.isDestroyed()) return;
    if (cssKey) {
      try {
        await view.webContents.removeInsertedCSS(cssKey);
      } catch (error2) {
        if (!isDisposedWebFrameError(error2)) throw error2;
      }
    }
    try {
      await view.webContents.executeJavaScript(buildWebBilingualClearScript(), true);
    } catch (error2) {
      if (!isDisposedWebFrameError(error2)) throw error2;
    }
  }
  /**
   * 注入或更新图片译文覆盖层，按当前展示模式与位置设置决定渲染方式。
   * @param placement 用户配置的图片译文展示位置。
   * @returns 注入完成后的 Promise。
   * @author zhenghq
   */
  async applyImageOverlays(placement) {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
    const operations = [];
    for (const candidate of this.translatedImageCandidates) {
      const decision = resolveWebImageRenderDecision(candidate, this.mode, placement);
      if (decision === "none" || !candidate.ocrText || !candidate.translation) continue;
      operations.push({
        imageId: candidate.imageId,
        selector: candidate.selector,
        ...candidate.shadowPath !== void 0 ? { shadowPath: [...candidate.shadowPath] } : {},
        ocrText: candidate.ocrText,
        translation: candidate.translation,
        placement: decision === "overlay" ? "overlay" : "below",
        bilingual: decision === "bilingual",
        lang: this.bilingualTargetLang || void 0
      });
    }
    if (operations.length === 0) {
      await this.clearImageOverlays();
      return;
    }
    try {
      await this.ensureImageOverlayStyles(view);
      const result = await view.webContents.executeJavaScript(
        buildWebImageOverlayInjectScript(operations),
        true
      );
      this.imageOverlayInjected = result.applied > 0;
      if (result.mismatched > 0) this.markPageUpdated();
    } catch (error2) {
      if (!isDisposedWebFrameError(error2)) throw error2;
    }
  }
  /**
   * 注入图片译文样式表并记录 key，重复调用不重复注入。
   * @param view 远程网页视图。
   * @returns 注入完成后的 Promise。
   * @author zhenghq
   */
  async ensureImageOverlayStyles(view) {
    if (this.imageOverlayCssKey) return;
    this.imageOverlayCssKey = await view.webContents.insertCSS(buildWebImageOverlayStyleSheet());
  }
  /**
   * 清除图片译文覆盖层与样式，远程 Frame 已销毁时安全跳过。
   * @returns 清理完成后的 Promise。
   * @author zhenghq
   */
  async clearImageOverlays() {
    const view = this.view;
    const cssKey = this.imageOverlayCssKey;
    this.imageOverlayInjected = false;
    this.imageOverlayCssKey = null;
    if (!view || view.webContents.isDestroyed()) return;
    if (cssKey) {
      try {
        await view.webContents.removeInsertedCSS(cssKey);
      } catch (error2) {
        if (!isDisposedWebFrameError(error2)) throw error2;
      }
    }
    try {
      await view.webContents.executeJavaScript(buildWebImageOverlayClearScript(), true);
    } catch (error2) {
      if (!isDisposedWebFrameError(error2)) throw error2;
    }
  }
  /**
   * 将保存的文本单元按指定模式写回远程页面。
   * @param mode 原文或译文模式。
   * @param onlyUnitIds 可选的增量写回单元集合；未提供时写回全部快照单元。
   * @returns 写回统计。
   * @author zhenghq
   */
  async applyUnits(mode, onlyUnitIds, options = {}) {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return { applied: 0, mismatched: 0, skipped: 0 };
    const translations = new Map(this.translatedUnits.map((unit) => [unit.id, unit]));
    const operations = this.extractedUnits.filter((unit) => !onlyUnitIds || onlyUnitIds.has(unit.id)).map((unit) => ({
      unitId: unit.id,
      sourceText: unit.sourceText,
      anchor: unit.anchor,
      translation: translations.get(unit.id)?.translation
    }));
    if (operations.length === 0) return { applied: 0, mismatched: 0, skipped: 0 };
    try {
      const result = await view.webContents.executeJavaScript(
        buildWebTextApplyScript(operations, mode, options),
        true
      );
      if (result.mismatched > 0) this.markPageUpdated();
      return result;
    } catch (error2) {
      if (isDisposedWebFrameError(error2)) return { applied: 0, mismatched: 0, skipped: operations.length };
      throw error2;
    }
  }
  /**
   * 恢复当前快照原文。
   * @returns 写回统计。
   * @author zhenghq
   */
  async restoreSource() {
    await this.clearImageOverlays();
    return this.applyUnits("source");
  }
  /**
   * 取消页面侧尚未完成的单元级打字机动画。
   * @returns 取消完成后的 Promise。
   * @author zhenghq
   */
  async cancelTypewriter() {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
    try {
      await view.webContents.executeJavaScript(buildWebTypewriterCancelScript(), true);
    } catch (error2) {
      if (!isDisposedWebFrameError(error2)) throw error2;
    }
  }
  /**
   * 创建阅读器壳窗口与远程 View。
   * @returns 窗口初始化完成后的 Promise。
   * @author zhenghq
   */
  async ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return;
    await this.applyProxy(this.options.getSettings());
    const window2 = new electron.BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 760,
      minHeight: 520,
      title: translateMain("webReader.mainWindowTitle"),
      frame: false,
      resizable: true,
      maximizable: true,
      fullscreenable: false,
      backgroundColor: "#f5f7fa",
      webPreferences: { preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    const view = new electron.WebContentsView({
      webPreferences: { session: this.getSession(), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    window2.contentView.addChildView(view);
    this.window = window2;
    this.view = view;
    this.options.onWindowStateChanged?.(true);
    this.bindRemoteEvents(view);
    this.allowWindowClose = false;
    this.closingWindow = false;
    window2.on("close", (event) => {
      if (this.allowWindowClose) return;
      event.preventDefault();
      this.close();
    });
    window2.on("blur", () => this.options.onInternalWindowFocusLost?.());
    window2.on("closed", () => {
      this.options.onInternalWindowFocusLost?.();
      this.disposeWindow(window2, view);
    });
    window2.webContents.once("did-finish-load", () => this.emitState());
    this.mode = this.options.getSettings().webTranslationDefaultMode;
    this.options.loadRenderer(window2, "web-reader.html");
  }
  /**
   * 返回或创建隔离的阅读器 Session。
   * @returns 阅读器专用 Session。
   * @author zhenghq
   */
  getSession() {
    if (!this.readerSession) {
      this.readerSession = electron.session.fromPartition(WEB_READER_PARTITION);
      this.readerSession.setPermissionRequestHandler((_webContents, _permission, callback2) => callback2(false));
      this.readerSession.setPermissionCheckHandler(() => false);
    }
    return this.readerSession;
  }
  /**
   * 绑定远程页面导航、安全与加载事件。
   * @param view 远程网页原生视图。
   * @returns 无返回值。
   * @author zhenghq
   */
  bindRemoteEvents(view) {
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedWebReaderUrl(url)) {
        event.preventDefault();
        return;
      }
      const htmlViewUrl = toWebReaderHtmlViewUrl(url);
      if (htmlViewUrl !== url) {
        event.preventDefault();
        void this.view?.webContents.loadURL(htmlViewUrl);
      }
    });
    contents.on("did-start-navigation", (_event, url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      this.advancePage(url);
      this.state.loading = true;
      this.emitState();
    });
    contents.on("page-title-updated", (_event, title) => {
      this.state.title = title;
      this.emitState();
    });
    contents.on("did-stop-loading", () => {
      this.state.loading = false;
      this.syncNavigationState();
      this.emitState();
      if (this.incrementalWindowRevision !== null) {
        this.scheduleIncrementalQuietStop(this.incrementalWindowRevision);
      }
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.state = {
        ...this.state,
        url,
        loading: false,
        error: translateMain("webReader.error.loadFailed", { description: description || code })
      };
      this.syncNavigationState();
      this.emitState();
    });
  }
  /**
   * 页面主文档变化时递增代次并清空快照。
   * @param url 新页面地址。
   * @returns 无返回值。
   * @author zhenghq
   */
  advancePage(url) {
    void this.clearBilingualInjection();
    void this.clearImageOverlays();
    this.invalidateActiveJob(true);
    this.stopPageChangePolling();
    this.pageRevision += 1;
    this.extractedUnits = [];
    this.extractedBlocks = [];
    this.blockUnitIds.clear();
    this.extractedImageCandidates = [];
    this.imageFilterSkipped = 0;
    this.translatedUnits = [];
    this.translatedImageCandidates = [];
    this.streamBlockIds.clear();
    this.bilingualInjected = false;
    this.bilingualCssKey = null;
    this.imageOverlayInjected = false;
    this.imageOverlayCssKey = null;
    this.incrementalSeenUnitKeys.clear();
    this.hasExtractedSnapshot = false;
    this.state = {
      ...this.state,
      pageRevision: this.pageRevision,
      url,
      title: "",
      error: void 0,
      pageUpdated: false,
      translationWindowActive: false,
      translationDiscovered: 0,
      translationDone: 0,
      translationCacheHits: 0,
      imageCandidates: 0,
      imageProcessed: 0,
      imageSkipped: 0,
      imageFailed: 0
    };
  }
  /**
   * 使当前任务失效并触发取消信号。
   * @param stopCollector 是否同时结束当前页面的增量收集窗口。
   * @returns 无返回值。
   * @author zhenghq
   */
  invalidateActiveJob(stopCollector = true) {
    if (stopCollector) this.abortIncrementalWindow();
    void this.cancelTypewriter();
    if (this.activeJobId) {
      this.coordinator.invalidate(
        this.readerId,
        this.pageRevision,
        this.activeJobId,
        this.activeSourceLang,
        this.activeTargetLang
      );
    }
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.activeJobId = "";
    this.activeSourceLang = "";
    this.activeTargetLang = "";
  }
  /**
   * 启动页面变化状态轮询。
   * @returns 无返回值。
   * @author zhenghq
   */
  startPageChangePolling() {
    this.stopPageChangePolling();
    this.pageChangeTimer = setInterval(() => {
      const contents = this.view?.webContents;
      if (!contents || contents.isDestroyed() || this.state.loading || this.state.pageUpdated) return;
      void contents.executeJavaScript(buildWebPageChangeStatusScript(), true).then((updated) => {
        if (updated) this.markPageUpdated();
      }).catch(() => void 0);
    }, 1e3);
  }
  /**
   * 停止页面变化状态轮询。
   * @returns 无返回值。
   * @author zhenghq
   */
  stopPageChangePolling() {
    if (this.pageChangeTimer) clearInterval(this.pageChangeTimer);
    this.pageChangeTimer = null;
  }
  /**
   * 标记页面内容已更新并广播。
   * @returns 无返回值。
   * @author zhenghq
   */
  markPageUpdated() {
    if (this.state.pageUpdated) return;
    this.state = { ...this.state, pageUpdated: true };
    this.emitState();
    this.sendToRenderer("web-translate:page-updated", true);
  }
  /**
   * 同步前进后退能力。
   * @returns 无返回值。
   * @author zhenghq
   */
  syncNavigationState() {
    const history = this.view?.webContents.navigationHistory;
    this.state.canGoBack = history?.canGoBack() ?? false;
    this.state.canGoForward = history?.canGoForward() ?? false;
  }
  /**
   * 广播阅读器状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  emitState() {
    this.sendToRenderer("web-reader:state", this.getState());
  }
  /**
   * 广播网页翻译进度。
   * @param progress 最新网页翻译进度。
   * @returns 无返回值。
   * @author zhenghq
   */
  emitProgress(progress) {
    this.sendToRenderer("web-translate:progress", progress);
  }
  /**
   * 向网页阅读器壳窗口发送消息，并安全处理窗口关闭期间的生命周期竞争。
   * @param channel IPC 通道名称。
   * @param payload 要发送的消息载荷。
   * @returns 无返回值。
   * @author zhenghq
   */
  sendToRenderer(channel, payload) {
    const window2 = this.window;
    if (!window2) return;
    try {
      if (window2.isDestroyed()) return;
      sendToAliveWebContents(window2.webContents, channel, payload);
    } catch (error2) {
      if (!isDisposedWebFrameError(error2)) throw error2;
    }
  }
  /**
   * 清理已关闭窗口的引用与任务。
   * @param window 已关闭的壳窗口。
   * @param view 已关闭的远程网页视图。
   * @returns 无返回值。
   * @author zhenghq
   */
  disposeWindow(window2, view) {
    if (this.window !== window2) return;
    this.window = null;
    this.closingWindow = false;
    this.allowWindowClose = false;
    this.options.onWindowStateChanged?.(false);
    void this.clearBilingualInjection();
    void this.clearImageOverlays();
    this.invalidateActiveJob(true);
    this.stopPageChangePolling();
    if (!view.webContents.isDestroyed()) view.webContents.close();
    this.view = null;
    this.extractedUnits = [];
    this.extractedBlocks = [];
    this.blockUnitIds.clear();
    this.extractedImageCandidates = [];
    this.imageFilterSkipped = 0;
    this.translatedUnits = [];
    this.translatedImageCandidates = [];
    this.streamBlockIds.clear();
    this.bilingualInjected = false;
    this.bilingualCssKey = null;
    this.imageOverlayInjected = false;
    this.imageOverlayCssKey = null;
    this.hasExtractedSnapshot = false;
  }
  /**
   * 要求远程网页已经加载。
   * @returns 可执行提取与写回的远程网页视图。
   * @author zhenghq
   */
  requireLoadedView() {
    if (!this.view || this.view.webContents.isDestroyed()) {
      throw new Error(translateMain("webReader.error.notOpen"));
    }
    if (!isAllowedWebReaderUrl(this.state.url)) {
      throw new Error(translateMain("webReader.error.urlRequired"));
    }
    return this.view;
  }
  /**
   * 清除上一次加载错误。
   * @returns 无返回值。
   * @author zhenghq
   */
  clearError() {
    this.state.error = void 0;
    this.emitState();
  }
  /**
   * 创建初始状态。
   * @returns 阅读器初始状态。
   * @author zhenghq
   */
  createState() {
    return {
      readerId: this.readerId,
      pageRevision: 0,
      url: "",
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pageUpdated: false
    };
  }
}
function resolveMacOSDockPresentation(state) {
  return state.showDockIcon && (state.settingsOpen || state.webReaderOpen) ? { policy: "regular", dockVisible: true } : { policy: "accessory", dockVisible: false };
}
function resolveAutoLaunchStrategy(environment) {
  if (!environment.packaged) return "skipped";
  if (environment.platform === "darwin" || environment.platform === "win32") return "login-item";
  if (environment.platform === "linux") return "desktop-entry";
  return "unsupported";
}
function buildLoginItemSettings(input) {
  if (input.platform === "win32") {
    return { openAtLogin: input.enabled, path: input.execPath, args: [] };
  }
  return { openAtLogin: input.enabled };
}
function resolveLinuxAutostartEntryPath(homeDirectory, applicationId) {
  return node_path.join(homeDirectory, ".config", "autostart", `${applicationId}.desktop`);
}
function buildLinuxAutostartEntry(input) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${input.appName}`,
    `Exec="${input.execPath}"`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    ""
  ].join("\n");
}
const isMac = process.platform === "darwin";
const execFileP = node_util.promisify(node_child_process.execFile);
const spawnP = (executable, args, options) => {
  return new Promise((resolve, reject) => {
    const child = node_child_process.spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
};
const PRELOAD_PATH = node_path.join(__dirname, "../preload/index.js");
const APP_ID = "com.selection.translator";
const DOCKER_IMAGE = "ghcr.io/owo-network/deeplx:latest";
const SELECTION_SETTLE_DELAY_MS = 80;
const SELECTION_ACTIVATION_SUPPRESS_MS = 500;
const SETTINGS_PANEL_RAISE_LEVEL_TIMEOUT_MS = 400;
const UPDATE_CHECK_DELAY_MS = 5e3;
const MIN_OCR_SELECTION_SIZE = 8;
const OCR_TIMEOUT_MS = 3e4;
function waitFor(ms2) {
  return new Promise((resolve) => setTimeout(resolve, ms2));
}
async function waitForSelectionWindowSnapshot(task) {
  if (!task) return false;
  return task.then(() => true, () => false);
}
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}
let tray = null;
let settingsWin = null;
let ocrSelectionWin = null;
const ocrSelectionWindowReadyPromises = /* @__PURE__ */ new WeakMap();
let pendingOcrSelectionReady = null;
let screenshotToastWin = null;
let screenshotToastHideTimer = null;
let dockIconEnabled = false;
let appliedMacOSDockPresentation = null;
let webReaderWindowOpen = false;
let dingTalkConfiguration = null;
let aiConfiguration = null;
let deepLxConfiguration = null;
let deepLxCheckService = null;
let aiModelDiscovery = null;
let aiCheckService = null;
let updateManager = null;
let webReader = null;
let mainI18n = null;
function registerLocaleIpc() {
  electron.ipcMain.on("i18n:get-current-locale", (event) => {
    event.returnValue = mainI18n?.locale ?? "en-US";
  });
}
function t(key, params) {
  if (mainI18n) return mainI18n.translator.t(key, params);
  return createTranslator("en-US").t(key, params);
}
const edgeSpeechClient = createEdgeSpeechClient({ socketFactory: createTranslationWebSocket });
const edgeSpeechRequests = /* @__PURE__ */ new Map();
let latestTranslationRequest = 0;
let latestSelectionGesture = 0;
let shortcutRegistrationStates = [];
let selectionActivationSuppressUntil = 0;
let settingsBringToFrontEpoch = 0;
let pendingMacOSDockShowTimer = null;
let pendingMacOSDockVisibilityTimer = null;
let latestOcrSnapshot = null;
let ocrSelectionSessionSeq = 0;
const activeScreenshotOcrRequests = /* @__PURE__ */ new Map();
const ocrSessionResultCache = new OcrSessionResultCache();
const selectionInteraction = new SelectionInteractionController();
let ocrInteractionToken = null;
let ocrSessionAppWasFrontmost = true;
const FRONT_RESTORE_DELAY_MS = 60;
const FRONT_RESTORE_VERIFY_DELAY_MS = 180;
const OCR_PREVIEW_CAPTURE_TIMEOUT_MS = 5e3;
const SCREENSHOT_PREWARM_DELAY_MS = 1500;
const selectionCapture = new SelectionCaptureCoordinator(
  captureSelection,
  captureSelectionByNativeOnly,
  captureSelectionAfterButtonClick,
  {
    onDiagnostic: (input) => {
      void queryFrontmostApp().then(({ app: app2 }) => {
        recordCaptureDiagnostic({
          at: input.at,
          entry: input.entry ?? "button",
          platform: input.platform,
          level: input.level,
          reason: input.reason,
          elapsedMs: input.elapsedMs,
          app: app2,
          windowLocate: input.windowLocate,
          windowCount: input.windowCount,
          windowMatched: input.windowMatched
        });
      });
    }
  }
);
const selectionListenerController = new SelectionListenerController({
  start: () => startAutoTrigger(
    handleSelectionGesture,
    handleSelectionPointerDown,
    handleCopyShortcut,
    handlePasteShortcut
  ),
  stop: () => stopAutoTrigger(),
  log: (message) => console.warn(message)
});
let lastSelectedText = "";
let lastSelectionAnchor;
let lastSelectionWindowContext;
let selectionWindowSnapshotTask;
let selectionWindowSnapshotGestureId = 0;
let lastOcrText = "";
let lastOcrAnchor;
let lastOcrEngine;
const ocrEnginePreferenceState = {};
function getDingTalkConfiguration() {
  if (!dingTalkConfiguration) throw new Error(t("app.serviceNotInitialized.dingtalk"));
  return dingTalkConfiguration;
}
function getAiConfiguration() {
  if (!aiConfiguration) throw new Error(t("app.serviceNotInitialized.aiConfig"));
  return aiConfiguration;
}
function getDeepLxConfiguration() {
  if (!deepLxConfiguration) throw new Error(t("app.serviceNotInitialized.deepLx"));
  return deepLxConfiguration;
}
function getUpdateManager() {
  if (!updateManager) throw new Error(t("app.serviceNotInitialized.update"));
  return updateManager;
}
function getWebReader() {
  if (!webReader) throw new Error(t("app.serviceNotInitialized.webReader"));
  return webReader;
}
async function synthesizeEdgeSpeech(requestId, text, language) {
  const normalizedText = String(text ?? "").trim();
  if (!normalizedText) return { ok: false, error: t("error.edgeSpeechEmptyText") };
  console.log("[edge-speech] IPC 请求开始", {
    requestId,
    language,
    textLength: normalizedText.length
  });
  const controller = new AbortController();
  edgeSpeechRequests.set(requestId, controller);
  try {
    const result = await edgeSpeechClient.synthesize(normalizedText, String(language ?? ""), controller.signal);
    console.log("[edge-speech] IPC 请求完成", {
      requestId,
      ok: result.ok,
      audioBytes: result.audio?.byteLength ?? 0,
      error: result.error
    });
    return result;
  } catch {
    console.error("[edge-speech] IPC 请求异常", { requestId });
    return { ok: false, error: t("error.edgeSpeechUnavailable") };
  } finally {
    edgeSpeechRequests.delete(requestId);
  }
}
function cancelEdgeSpeech(requestId) {
  edgeSpeechRequests.get(String(requestId))?.abort();
  edgeSpeechRequests.delete(String(requestId));
}
function isSettingsWindowVisibleForProbe() {
  return Boolean(settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible());
}
function shouldTreatActivateAsDockLaunch(probe) {
  const decision = canTreatActivateAsDockLaunch({
    interactionState: selectionInteraction.snapshot().state,
    selectionButtonVisible: isSelectionButtonVisible(),
    popupVisible: isPopupVisible(),
    hiServicesRepairRunning,
    ocrVisible: isOcrSelectionVisible(),
    listenerPausedForOcr: selectionListenerController.isPausedForOcr(),
    selectionActivationSuppressUntil
  });
  try {
    const diagnostic = createActivateSourceRecord({
      timestampMs: probe.timestampMs,
      decision: decision.allowed ? "allow" : "ignore",
      reason: decision.allowed ? void 0 : decision.reason ?? "unknown",
      stack: probe.stack,
      event: { hasVisibleWindows: probe.hasVisibleWindows }
    });
    if (diagnostic.ok) {
      console.log(formatActivateDiagnosticLog(diagnostic.record));
    } else {
      console.log(`${ACTIVATE_DIAGNOSTIC_PREFIX} dropped: ${diagnostic.error}`);
    }
  } catch (error2) {
    console.log(
      "[activate-diagnostics] output failed:",
      error2 instanceof Error ? error2.message : String(error2)
    );
  }
  if (decision.allowed) {
    console.log("[main] activate 按 Dock 启动处理:", JSON.stringify(decision.checks ?? {}));
  } else {
    console.log(`[main] 忽略内部 activate: ${decision.reason ?? "unknown"}`);
  }
  return decision.allowed;
}
function suppressSelectionActivationWindowGap() {
  selectionActivationSuppressUntil = Date.now() + SELECTION_ACTIVATION_SUPPRESS_MS;
  settingsBringToFrontEpoch += 1;
}
function isSelectionWindowRaiseGuardActive() {
  return selectionActivationSuppressUntil > Date.now();
}
function releaseSelectionInteraction(token) {
  const released = selectionInteraction.release(token);
  if (released) {
    suppressSelectionActivationWindowGap();
  }
}
function invalidateSelectionFlowWithFocusCleanup() {
  const invalidatedToken = selectionInteraction.invalidateSelectionFlow();
  return invalidatedToken;
}
function activateExistingPageOrOpenSettings() {
  logCandidateProbe("settings-activate-entry", isSettingsWindowVisibleForProbe());
  if (isSelectionWindowRaiseGuardActive()) return;
  if (webReader?.focusExistingWindow()) return;
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible() && !settingsWin.isMinimized()) {
    return;
  }
  void openSettings({ bringToFront: true }).then(async () => {
    const target = settingsWin;
    if (!target || target.isDestroyed() || !target.isVisible()) return;
    await yieldToEventLoop();
    if (settingsWin !== target || target.isDestroyed() || !target.isVisible()) return;
    if (isSelectionWindowRaiseGuardActive()) return;
    showOwnWindowForInteraction(target, { raiseLevel: false });
  }).catch((error2) => {
    console.error("[settings] Dock 激活打开设置窗口失败:", error2);
  });
}
const appLogger = createAppLogger({ logDir: electron.app.getPath("logs") });
function pushLogEntries(entries) {
  if (!settingsWin || settingsWin.isDestroyed()) return;
  settingsWin.webContents.send("logs:entry", entries);
}
appLogger.subscribe(pushLogEntries);
const gotLock = electron.app.requestSingleInstanceLock();
if (!gotLock) {
  electron.app.quit();
} else {
  const initialization = electron.app.whenReady().then(() => onReady()).catch(handleApplicationInitializationFailure);
  electron.app.on("second-instance", () => {
    void initialization.then((initialized) => {
      if (!initialized) return;
      void openSettings();
    });
  });
  if (isMac) {
    electron.app.on("activate", (_event, hasVisibleWindows) => {
      const activateStack = captureSyncStack();
      const activateTimestampMs = Date.now();
      void initialization.then((initialized) => {
        if (!initialized) return;
        if (!shouldTreatActivateAsDockLaunch({
          stack: activateStack,
          timestampMs: activateTimestampMs,
          hasVisibleWindows
        })) return;
        activateExistingPageOrOpenSettings();
      });
    });
  }
}
function handleApplicationInitializationFailure(error2) {
  const message = error2 instanceof Error ? error2.message : String(error2);
  console.error("[main] 应用初始化失败:", error2);
  electron.dialog.showErrorBox(
    t("app.startupFailed.title"),
    t("app.startupFailed.message", { message })
  );
  electron.app.quit();
  return false;
}
function loadMacOSDockIcon() {
  const iconPath = electron.app.isPackaged ? node_path.join(process.resourcesPath, "icon.png") : node_path.join(electron.app.getAppPath(), "build", "icon.png");
  const icon = electron.nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    throw new Error(t("error.dockIconLoadFailed", { message: iconPath }));
  }
  return icon;
}
async function applyMacOSDockVisibility(showDockIcon) {
  if (!isMac) return;
  dockIconEnabled = showDockIcon;
  if (isSelectionWindowRaiseGuardActive()) {
    scheduleMacOSDockVisibilityAfterSelectionGuard();
    return;
  }
  const presentation = resolveMacOSDockPresentation({
    showDockIcon,
    settingsOpen: Boolean(settingsWin && !settingsWin.isDestroyed()),
    webReaderOpen: webReaderWindowOpen
  });
  if (appliedMacOSDockPresentation?.policy === presentation.policy && appliedMacOSDockPresentation.dockVisible === presentation.dockVisible) {
    return;
  }
  const settingsWindowToPreserve = settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible() ? settingsWin : null;
  electron.app.setActivationPolicy(presentation.policy);
  if (presentation.dockVisible) {
    try {
      electron.app.dock?.setIcon(loadMacOSDockIcon());
      if (isSelectionWindowRaiseGuardActive()) {
        scheduleMacOSDockShowAfterSelectionGuard();
      } else {
        logCandidateProbe("dock-show-sync-before", isSettingsWindowVisibleForProbe());
        await electron.app.dock?.show();
        logCandidateProbe("dock-show-sync-after", isSettingsWindowVisibleForProbe());
      }
    } catch (error2) {
      console.error("[main] 恢复 macOS Dock 图标失败:", error2);
    }
    appliedMacOSDockPresentation = presentation;
    return;
  }
  await electron.app.dock?.hide();
  appliedMacOSDockPresentation = presentation;
  if (settingsWindowToPreserve && settingsWin === settingsWindowToPreserve && !settingsWindowToPreserve.isDestroyed()) {
    settingsWindowToPreserve.showInactive();
  }
}
function applyAutoLaunch(enabled) {
  const strategy = resolveAutoLaunchStrategy({
    platform: process.platform,
    packaged: electron.app.isPackaged
  });
  if (strategy === "skipped" || strategy === "unsupported") {
    console.log(`[autoLaunch] 当前环境不写入自启动配置: ${strategy}`);
    return;
  }
  try {
    if (strategy === "login-item") {
      electron.app.setLoginItemSettings(
        buildLoginItemSettings({
          platform: process.platform,
          enabled,
          execPath: process.execPath
        })
      );
      return;
    }
    const entryPath = resolveLinuxAutostartEntryPath(node_os.homedir(), APP_ID);
    if (!enabled) {
      node_fs.rmSync(entryPath, { force: true });
      return;
    }
    node_fs.mkdirSync(node_path.dirname(entryPath), { recursive: true });
    node_fs.writeFileSync(
      entryPath,
      buildLinuxAutostartEntry({ appName: electron.app.getName(), execPath: process.execPath }),
      { mode: 420 }
    );
  } catch (error2) {
    console.error("[autoLaunch] 同步开机自启动失败:", error2.message);
  }
}
async function refreshMacOSDockVisibility() {
  await applyMacOSDockVisibility(dockIconEnabled);
}
function scheduleMacOSDockShowAfterSelectionGuard() {
  if (!isMac) return;
  if (pendingMacOSDockShowTimer) clearTimeout(pendingMacOSDockShowTimer);
  const delayMs = Math.max(0, selectionActivationSuppressUntil - Date.now()) + 20;
  pendingMacOSDockShowTimer = setTimeout(() => {
    pendingMacOSDockShowTimer = null;
    if (isSelectionWindowRaiseGuardActive() || selectionInteraction.snapshot().state !== "idle") {
      scheduleMacOSDockShowAfterSelectionGuard();
      return;
    }
    logCandidateProbe("dock-show-delayed", isSettingsWindowVisibleForProbe());
    const showPromise = electron.app.dock?.show();
    if (showPromise) {
      void showPromise.catch((error2) => {
        console.error("[main] 划词结束后恢复 macOS Dock 图标失败:", error2);
      });
    }
  }, delayMs);
}
function scheduleMacOSDockVisibilityAfterSelectionGuard() {
  if (!isMac) return;
  if (pendingMacOSDockVisibilityTimer) clearTimeout(pendingMacOSDockVisibilityTimer);
  const delayMs = Math.max(0, selectionActivationSuppressUntil - Date.now()) + 20;
  pendingMacOSDockVisibilityTimer = setTimeout(() => {
    pendingMacOSDockVisibilityTimer = null;
    if (isSelectionWindowRaiseGuardActive() || selectionInteraction.snapshot().state !== "idle") {
      scheduleMacOSDockVisibilityAfterSelectionGuard();
      return;
    }
    void refreshMacOSDockVisibility().catch((error2) => {
      console.error("[main] 划词结束后刷新 macOS Dock 呈现失败:", error2);
    });
  }, delayMs);
}
async function configureMacOSMenuBarApplication(showDockIcon, settingsWillOpen) {
  if (!isMac) return;
  dockIconEnabled = showDockIcon;
  if (!showDockIcon || !settingsWillOpen) await applyMacOSDockVisibility(showDockIcon);
  electron.Menu.setApplicationMenu(null);
}
async function confirmMacOSInstalledApplicationLaunch() {
  if (!isMacOSDiskImageExecution(process.platform, process.execPath)) return true;
  const result = await electron.dialog.showMessageBox({
    type: "warning",
    title: t("dialog.installFromDiskImage.title"),
    message: t("dialog.installFromDiskImage.message"),
    detail: t("dialog.installFromDiskImage.detail"),
    buttons: [t("dialog.installFromDiskImage.exit"), t("dialog.installFromDiskImage.continue")],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return result.response === 1;
}
function prewarmScreenshotRuntime() {
  setTimeout(() => {
    try {
      getOcrSelectionWindow();
    } catch (error2) {
      console.log("[ocr] 覆盖窗口预创建失败", error2 instanceof Error ? error2.message : error2);
    }
    try {
      const warmed = warmUpWindowsGdiCapture(process.platform);
      if (warmed) console.log("[ocr] GDI 采集预热完成");
    } catch (error2) {
      console.log("[ocr] GDI 采集预热失败", error2 instanceof Error ? error2.message : error2);
    }
    void prewarmWindowsCaptureHelper(buildWindowsScreenCaptureDeps()).then((ready) => {
      if (ready) console.log("[ocr] helper exe 预热完成");
    });
  }, SCREENSHOT_PREWARM_DELAY_MS);
}
async function onReady() {
  if (!await confirmMacOSInstalledApplicationLaunch()) {
    electron.app.quit();
    return false;
  }
  loadSettings();
  mainI18n = createMainI18nRuntime({
    getUiLocale: () => getSettings().uiLocale,
    localeSources: {
      preferredSystemLanguages: electron.app.getPreferredSystemLanguages(),
      systemLocale: electron.app.getSystemLocale(),
      appLocale: electron.app.getLocale(),
      env: process.env
    },
    onLocaleChanged: () => refreshLocalizedApplicationChrome()
  });
  registerLocaleIpc();
  const openSettingsOnInitialLaunch = shouldOpenSettingsOnInitialLaunch(process.platform);
  await configureMacOSMenuBarApplication(
    getSettings().showDockIcon,
    openSettingsOnInitialLaunch
  );
  applyAutoLaunch(getSettings().autoLaunch);
  createTray();
  dingTalkConfiguration = new DingTalkConfigurationService({
    getSettings,
    saveSettings,
    credentialStore: new DingTalkCredentialStore(
      node_path.join(electron.app.getPath("userData"), "credentials.json"),
      electron.safeStorage
    ),
    onSettingsChanged: (settings) => {
      refreshTrayMenu();
      broadcast("settings:changed", settings);
    },
    resetTranslationRuntime: resetDingTalkTranslationRuntime
  });
  dingTalkConfiguration.initialize();
  aiConfiguration = new AiConfigurationService({
    getSettings,
    saveSettings,
    credentialStore: new AiCredentialStore(
      node_path.join(electron.app.getPath("userData"), "ai-credentials.json"),
      electron.safeStorage
    ),
    onSettingsChanged: (settings) => {
      refreshTrayMenu();
      broadcast("settings:changed", settings);
    },
    resetTranslationRuntime: resetAiTranslationRuntime
  });
  aiConfiguration.initialize();
  deepLxConfiguration = new DeepLxConfigurationService({
    getSettings,
    saveSettings,
    onSettingsChanged: (settings) => {
      refreshTrayMenu();
      broadcast("settings:changed", settings);
    },
    resetTranslationRuntime: resetDeepLxTranslationRuntime
  });
  aiModelDiscovery = new AiModelDiscoveryService({ fetch: translationFetch });
  aiCheckService = new AiCheckService({ fetch: translationFetch });
  deepLxCheckService = new DeepLxCheckService({ fetch: translationFetch });
  await applyTranslationProxy(getSettings());
  configureTranslationFetch(translationFetch);
  webReader = new WebReaderManager({
    preloadPath: PRELOAD_PATH,
    loadRenderer: loadRendererHtml,
    getSettings,
    createImageSource: (view, signal) => createWebReaderImageSource(view, signal),
    recognizeImage: async (bytes, candidate) => {
      const settings = getSettings();
      const dispatcher = createOcrDispatcher(settings);
      const ocr = await recognizeAdaptiveOcr(
        {
          imageBytes: bytes,
          maxScale: settings.ocrScale,
          language: settings.ocrLang
        },
        {
          recognize: (preparedImageBytes) => dispatcher.recognize({
            imageBytes: preparedImageBytes,
            language: settings.ocrLang,
            timeoutMs: OCR_TIMEOUT_MS
          }, settings.ocrEnginePreference)
        }
      );
      const text = cleanOcrText(ocr.text ?? "");
      const quality = evaluateOcrQuality(ocr, settings.ocrLang);
      if (!quality.valid || quality.languageMismatch) return { text: "", score: 0 };
      return { text, score: quality.averageConfidence ?? Math.min(1, quality.textScore / 10) };
    },
    onWindowStateChanged: (open) => {
      webReaderWindowOpen = open;
      void refreshMacOSDockVisibility();
    },
    onInternalWindowFocusLost: () => {
      const focusedWindow = electron.BrowserWindow.getFocusedWindow();
      lowerSettingsPanelRaiseLevel();
      if (focusedWindow && (focusedWindow === settingsWin || webReader?.ownsWindow(focusedWindow))) return;
      endPopupSettingsOpenGuard();
    },
    hasVisibleSettingsWindow: () => Boolean(
      settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible()
    ),
    bringToFrontToOwnWindow: (window2) => {
      showOwnWindowForInteraction(window2, { raiseLevel: true });
    },
    translate: async (text, sourceLang, targetLang) => {
      const settings = { ...getSettings(), sourceLang, targetLang };
      const dingTalkCredentials = settings.dingTalkEnabled ? getDingTalkConfiguration().getCredentialsSnapshot() : null;
      const aiApiKey = settings.aiEnabled ? getAiConfiguration().getApiKey() : null;
      const output = await translate(
        text,
        settings,
        dingTalkCredentials,
        aiApiKey
      );
      recordWebPageUsage(output.provider);
      return { translation: output.translation, provider: output.provider, channel: output.channel };
    }
  });
  updateManager = await createApplicationUpdateManager(
    (status) => {
      broadcast("updater:status", status);
    },
    // electron-updater 的日志（含离线时的 ERR_INTERNET_DISCONNECTED）统一汇入
    // 主进程日志层，不再由 electron-updater 直接输出到 console 刷屏。
    // @author zhenghq
    { warn: (message) => appLogger.append("warn", [message], "electron-updater") }
  );
  console.log(
    "[main] 启动完成 autoTrigger =",
    getSettings().triggerMode === "auto",
    "triggerMode =",
    getSettings().triggerMode,
    "hotkey =",
    getSettings().hotkey,
    "proxyMode =",
    getSettings().proxyMode
  );
  createPopup(PRELOAD_PATH, suppressSelectionActivationWindowGap);
  createSelectionButton(PRELOAD_PATH, suppressSelectionActivationWindowGap);
  registerGlobalShortcuts(getSettings());
  applySelectionListener();
  registerIpc();
  if (openSettingsOnInitialLaunch) await openSettings({ bringToFront: true });
  setTimeout(() => void checkForApplicationUpdates(), UPDATE_CHECK_DELAY_MS);
  getScreenshotToastWindow();
  setTimeout(() => void warnIfNoAccessibility(), 1500);
  setTimeout(() => void maybeSendInstallUpgradeNotification(), 1500);
  prewarmScreenshotRuntime();
  return true;
}
function loadRendererHtml(win2, html) {
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win2.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/${html}`);
  } else {
    void win2.loadFile(node_path.join(__dirname, `../renderer/${html}`));
  }
}
function registerGlobalShortcuts(settings) {
  shortcutRegistrationStates = collectShortcutRegistrationStates(settings, {
    unregisterAll: () => electron.globalShortcut.unregisterAll(),
    register: (accelerator) => electron.globalShortcut.register(accelerator, () => onGlobalShortcut(accelerator))
  });
  broadcast("shortcuts:registration-changed", shortcutRegistrationStates);
}
function onGlobalShortcut(accelerator) {
  const settings = getSettings();
  if (accelerator === settings.hotkey) {
    onHotkey();
  } else if (accelerator === settings.ocrHotkey) {
    onOcrHotkey();
  } else if (accelerator === settings.manualTranslationHotkey) {
    void openManualTranslation();
  } else if (accelerator === settings.webReaderHotkey) {
    openWebReaderFromShortcut();
  }
}
function onHotkey() {
  latestSelectionGesture += 1;
  markHotkeyTrigger();
  selectionCapture.markEntry("hotkey");
  invalidateSelectionFlowWithFocusCleanup();
  const interactionToken = selectionInteraction.beginTranslation();
  hideSelectionButton();
  lastSelectionWindowContext = void 0;
  selectionCapture.setWindowContext(void 0);
  const interactionSnapshot = selectionInteraction.snapshot();
  const windowSnapshotGestureId = latestSelectionGesture;
  const windowSnapshotTask = rememberFrontmostWindowAtPoint(electron.screen.getCursorScreenPoint());
  selectionWindowSnapshotTask = windowSnapshotTask;
  selectionWindowSnapshotGestureId = windowSnapshotGestureId;
  void windowSnapshotTask.then((recorded) => {
    if (windowSnapshotGestureId !== latestSelectionGesture) return;
    const current = selectionInteraction.snapshot();
    if (!recorded || current.state !== interactionSnapshot.state || current.token !== interactionSnapshot.token) return;
    lastSelectionWindowContext = {
      bundleId: recorded.snapshot.bundleId,
      pid: recorded.snapshot.pid,
      windowNumber: recorded.snapshot.windowNumber,
      bounds: recorded.snapshot.bounds,
      titleFingerprint: recorded.snapshot.titleFingerprint,
      // 入口层若已执行精确交还，复制链路不得再次激活同一窗口。
      windowActivationSettled: false
    };
    selectionCapture.setWindowContext(lastSelectionWindowContext);
  });
  const popupCloseVersion = showSelectionReadingPopup();
  const captureDelay = resolveHotkeyCaptureDelay(process.platform);
  const hotkeyModifiers = resolveHotkeyModifiers(getSettings().hotkey, process.platform);
  if (process.platform === "darwin") {
    setPendingMacOSCommandWasDown(hotkeyModifiers.includes("meta"));
  }
  if (shouldReleaseHotkeyModifiersBeforeCopy(process.platform)) {
    setPendingCopyModifierRelease(hotkeyModifiers);
  }
  if (captureDelay === 0 && process.platform === "darwin") {
    void windowSnapshotTask.then(() => {
      if (!selectionInteraction.isCurrent(interactionToken)) return;
      if (popupCloseVersion !== getPopupCloseVersion()) return;
      selectionCapture.setWindowContext(lastSelectionWindowContext);
      void queueSelectionTranslation(void 0, interactionToken, false, popupCloseVersion);
    });
    return;
  }
  if (captureDelay > 0) {
    setTimeout(
      () => {
        if (!selectionInteraction.isCurrent(interactionToken)) return;
        void queueSelectionTranslation(void 0, interactionToken, true, popupCloseVersion);
      },
      captureDelay
    );
    return;
  }
  void queueSelectionTranslation(void 0, interactionToken, false, popupCloseVersion);
}
function onOcrHotkey() {
  latestSelectionGesture += 1;
  hideSelectionButton();
  void openOcrSelection();
}
function collectOwnWindowCandidates() {
  const settingsFocused = Boolean(
    settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible() && settingsWin.isFocused()
  );
  const settingsBounds = settingsFocused && settingsWin ? settingsWin.getBounds() : null;
  const webReaderFocused = Boolean(webReader?.isWindowFocused());
  return [
    { name: "settings", focused: settingsFocused, bounds: settingsBounds },
    {
      name: "webReader",
      focused: webReaderFocused,
      bounds: webReaderFocused ? webReader?.getVisibleBounds() ?? null : null
    }
  ];
}
function resolveOwnWindowExclusionState() {
  const appFrontmost = resolveAppFrontmostForExclusion(process.platform, isMacAppActiveByEvents());
  return { appFrontmost, windows: resolveOwnWindowExclusion(appFrontmost, collectOwnWindowCandidates()) };
}
function getFocusedOwnWindowBounds() {
  return resolveOwnWindowExclusionState().windows.map((candidate) => candidate.bounds).filter((bounds) => bounds !== null);
}
function isPointInsideFocusedOwnWindow(point) {
  return findOwnWindowHit(point, resolveOwnWindowExclusionState().windows) !== null;
}
function isPointInsideVisibleSettingsWindow(point) {
  if (!settingsWin || settingsWin.isDestroyed() || !settingsWin.isVisible()) return false;
  return isPointInsideBounds(point, settingsWin.getBounds());
}
function isPointInsideVisibleWebReaderWindow(point) {
  const bounds = webReader?.getVisibleBounds();
  return bounds !== null && bounds !== void 0 && isPointInsideBounds(point, bounds);
}
function describeSuppressedOwnWindowHit(point) {
  if (resolveAppFrontmostForExclusion(process.platform, isMacAppActiveByEvents())) return null;
  const suppressed = findOwnWindowHit(point, resolveOwnWindowExclusion(true, collectOwnWindowCandidates()));
  if (!suppressed?.bounds) return null;
  const { bounds } = suppressed;
  return `${suppressed.name} bounds=${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`;
}
function scheduleSelectionAction(anchor) {
  suppressSelectionActivationWindowGap();
  lowerSettingsPanelRaiseLevel();
  const gestureId = ++latestSelectionGesture;
  invalidateSelectionFlowWithFocusCleanup();
  selectionCapture.invalidate();
  hideSelectionButton();
  lastSelectionAnchor = anchor;
  const action = decideSelectionAction(isPopupVisible(), getSettings().triggerMode);
  if (action === "ignore") return;
  lastSelectionWindowContext = void 0;
  selectionCapture.setWindowContext(void 0);
  const windowSnapshotTask = rememberFrontmostWindowAtPoint(anchor);
  selectionWindowSnapshotTask = windowSnapshotTask;
  selectionWindowSnapshotGestureId = gestureId;
  void windowSnapshotTask.then((recorded) => {
    if (!recorded || gestureId !== latestSelectionGesture) return;
    lastSelectionWindowContext = {
      bundleId: recorded.snapshot.bundleId,
      pid: recorded.snapshot.pid,
      windowNumber: recorded.snapshot.windowNumber,
      bounds: recorded.snapshot.bounds,
      titleFingerprint: recorded.snapshot.titleFingerprint,
      // 入口层若已执行精确交还，复制链路不得再次激活同一窗口。
      windowActivationSettled: false
    };
    selectionCapture.setWindowContext(lastSelectionWindowContext);
    if (action === "show-button" && shouldPrefetchSelectionForButton(process.platform)) {
      void selectionCapture.prepare(anchor);
    }
  });
  if (action === "show-button") {
    selectionInteraction.showButton();
    showSelectionButton(anchor);
    return;
  }
  selectionCapture.markEntry("auto");
  const interactionToken = selectionInteraction.beginTranslation();
  setTimeout(() => {
    if (gestureId !== latestSelectionGesture || !selectionInteraction.isCurrent(interactionToken)) return;
    void queueSelectionTranslation(anchor, interactionToken);
  }, SELECTION_SETTLE_DELAY_MS);
}
function handleSelectionGesture(gesture) {
  const ocrActive = selectionInteraction.snapshot().state === "ocr-selecting" || isOcrSelectionVisible();
  const focusedOwnWindow = isSelectionGestureInsideOwnWindows(gesture, getFocusedOwnWindowBounds());
  const popupHit = isPointInsidePopup(gesture.start) || isPointInsidePopup(gesture.end);
  const buttonHit = isPointInsideSelectionButton(gesture.start) || isPointInsideSelectionButton(gesture.end);
  if (ocrActive || focusedOwnWindow || popupHit || buttonHit) {
    const reasons = [];
    if (ocrActive) reasons.push("ocr");
    if (focusedOwnWindow) reasons.push("focused-own-window");
    if (popupHit) reasons.push("popup");
    if (buttonHit) reasons.push("selection-button");
    console.log(
      `[selection] 忽略划词手势 reasons=${reasons.join(",")} startX=${Math.round(gesture.start.x)} startY=${Math.round(gesture.start.y)} endX=${Math.round(gesture.end.x)} endY=${Math.round(gesture.end.y)}`
    );
    return;
  }
  const settings = getSettings();
  if (gesture.clicks >= 2 && settings.triggerMode === "button") {
    if (!settings.doubleClickSelectionButtonEnabled) return;
  }
  scheduleSelectionAction(gesture.anchor);
}
function handleSelectionPointerDown(point, button = 1) {
  const primaryButton = button === 1;
  const ocrActive = selectionInteraction.snapshot().state === "ocr-selecting" || isOcrSelectionVisible();
  const selectionButtonHit = isPointInsideSelectionButton(point);
  const popupHit = isPointInsidePopup(point);
  if (popupHit && primaryButton) return "ignore";
  const settingsWindowHit = isPopupSettingsOpenGuardActive() && isPointInsideVisibleSettingsWindow(point);
  const focusedOwnWindowHit = settingsWindowHit || isPointInsideFocusedOwnWindow(point);
  const result = classifySelectionPointerDown({
    ocrActive,
    selectionButtonHit,
    popupHit,
    // 翻译弹窗内部的拖动也属于应用内交互，按下阶段直接忽略，
    // 避免 mouseup 时再被拼成一次跨应用划词。
    focusedOwnWindowHit
  });
  if (result === "track") {
    if (isPopupVisible() && isPointInsideVisibleSettingsWindow(point)) {
      return "ignore";
    }
    if (isPopupVisible() && isPointInsideVisibleWebReaderWindow(point)) {
      return "ignore";
    }
    dismissPopupOnExternalPointerDown(point);
    const suppressedDetail = describeSuppressedOwnWindowHit(point);
    if (suppressedDetail) {
      console.log(
        `[selection] pointerdown 应用失活，已抑制自有窗口矩形排除 hit=${suppressedDetail} x=${Math.round(point.x)} y=${Math.round(point.y)}`
      );
    }
  }
  if (result === "consume" && selectionButtonHit && primaryButton) {
    void translateSelectionButton();
  }
  if (result === "consume" && primaryButton) return result;
  if (result === "consume" && ocrActive && !selectionButtonHit) return result;
  if (result === "ignore" && primaryButton) return result;
  latestSelectionGesture += 1;
  invalidateSelectionFlowWithFocusCleanup();
  selectionCapture.invalidate();
  hideSelectionButton();
  return primaryButton ? "track" : "ignore";
}
function handleCopyShortcut() {
  latestSelectionGesture += 1;
  invalidateSelectionFlowWithFocusCleanup();
  selectionCapture.invalidate();
  hideSelectionButton();
}
function handlePasteShortcut() {
  latestSelectionGesture += 1;
  invalidateSelectionFlowWithFocusCleanup();
  selectionCapture.invalidate();
  hideSelectionButton();
}
function showSelectionReadingPopup(anchor) {
  const settings = getSettings();
  const popupHoldingKeyWindow = process.platform === "darwin" ? isPopupHoldingKeyWindow() : isPopupActivated();
  if (shouldRestoreForegroundBeforeCapture(process.platform, popupHoldingKeyWindow)) {
    deactivatePopupForCapture();
  }
  const popupCloseVersion = getPopupCloseVersion();
  showPopup(
    {
      ok: true,
      origin: "selection",
      loading: true,
      loadingMessage: t("selection.loadingReading"),
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    },
    0,
    anchor,
    false
  );
  if (process.platform === "darwin" && isPopupHoldingKeyWindow()) {
    deactivatePopupForCapture();
  }
  return popupCloseVersion;
}
async function queueSelectionTranslation(anchor, interactionToken, directCapture = false, popupCloseVersion) {
  if (selectionInteraction.snapshot().state === "ocr-selecting") return;
  if (popupCloseVersion !== void 0 && popupCloseVersion !== getPopupCloseVersion()) return;
  const token = interactionToken ?? selectionInteraction.beginTranslation();
  if (selectionWindowSnapshotGestureId === latestSelectionGesture) {
    await waitForSelectionWindowSnapshot(selectionWindowSnapshotTask);
  }
  selectionCapture.setWindowContext(lastSelectionWindowContext);
  if (process.platform === "darwin" && isOwnWindowHoldingKeyWindow()) {
    if (isPopupHoldingKeyWindow()) deactivatePopupForCapture();
    const handedBack = await handBackKeyWindowToFrontmostApp();
    if (handedBack && lastSelectionWindowContext) {
      lastSelectionWindowContext = {
        ...lastSelectionWindowContext,
        windowActivationSettled: true
      };
      selectionCapture.setWindowContext(lastSelectionWindowContext);
    }
    await waitFor(POPUP_FOREGROUND_RESTORE_SETTLE_MS);
    if (!selectionInteraction.isCurrent(token)) return;
    if (popupCloseVersion !== void 0 && popupCloseVersion !== getPopupCloseVersion()) {
      releaseSelectionInteraction(token);
      return;
    }
  }
  const capture = directCapture ? selectionCapture.captureDirect(anchor) : selectionCapture.capture(anchor);
  void capture.then((result) => {
    if (!selectionInteraction.isCurrent(token)) return;
    if (popupCloseVersion !== void 0 && popupCloseVersion !== getPopupCloseVersion()) {
      releaseSelectionInteraction(token);
      return;
    }
    if (result) {
      handleSelectionCaptureResult(result, token);
      return;
    }
    hidePopup(true, "stale-token");
    releaseSelectionInteraction(token);
  });
}
async function translateSelectionButton() {
  if (!isSelectionButtonVisible()) return;
  suppressExternalPointerDismissForButtonClick(electron.screen.getCursorScreenPoint());
  setPendingMacOSCommandWasDown(false);
  suppressSelectionActivationWindowGap();
  selectionCapture.markEntry("button");
  const interactionToken = selectionInteraction.beginButtonCapture();
  if (interactionToken === null) return;
  const anchor = lastSelectionAnchor;
  await waitForSelectionWindowSnapshot(selectionWindowSnapshotTask);
  selectionCapture.setWindowContext(lastSelectionWindowContext);
  latestSelectionGesture += 1;
  hideSelectionButton();
  const popupWasActivated = shouldRestoreForegroundBeforeCapture(
    process.platform,
    process.platform === "darwin" ? isPopupHoldingKeyWindow() : isPopupActivated()
  );
  try {
    const popupCloseVersion = showSelectionReadingPopup(anchor);
    if (popupWasActivated) {
      await waitFor(POPUP_FOREGROUND_RESTORE_SETTLE_MS);
      if (!selectionInteraction.isCurrent(interactionToken) || popupCloseVersion !== getPopupCloseVersion()) return;
    }
    if (process.platform === "darwin" && isOwnWindowHoldingKeyWindow()) {
      if (isPopupHoldingKeyWindow()) deactivatePopupForCapture();
      const handedBack = await handBackKeyWindowToFrontmostApp();
      if (handedBack && lastSelectionWindowContext) {
        lastSelectionWindowContext = {
          ...lastSelectionWindowContext,
          windowActivationSettled: true
        };
        selectionCapture.setWindowContext(lastSelectionWindowContext);
      }
      await waitFor(POPUP_FOREGROUND_RESTORE_SETTLE_MS);
      if (!selectionInteraction.isCurrent(interactionToken) || popupCloseVersion !== getPopupCloseVersion()) return;
    }
    const consumption = await selectionCapture.consumePreparedBounded();
    console.log(
      `[capture] button-prefetch status=${consumption.status} waitedMs=${consumption.waitedMs}`
    );
    if (!selectionInteraction.isCurrent(interactionToken) || popupCloseVersion !== getPopupCloseVersion()) return;
    const result = consumption.result ?? await selectionCapture.captureFromButton(anchor);
    if (!selectionInteraction.isCurrent(interactionToken) || popupCloseVersion !== getPopupCloseVersion()) return;
    selectionCapture.invalidate();
    if (result) handleSelectionCaptureResult(result, interactionToken, true);
    else hidePopup(true, "capture-null");
  } finally {
    if (selectionInteraction.isCurrent(interactionToken) && selectionInteraction.snapshot().state === "capturing") {
      releaseSelectionInteraction(interactionToken);
    }
  }
}
function handleSelectionCaptureResult(result, interactionToken, trackMacCopyTimeout = false) {
  const shouldAutoRepairHiServices = trackMacCopyTimeout && recordCaptureOutcome(result);
  if (result.error) {
    handleTranslateError(result.error, getSettings(), result.anchor);
    if (interactionToken !== void 0) releaseSelectionInteraction(interactionToken);
    return;
  }
  if (!result.text) {
    const settings = getSettings();
    showPopup(
      {
        ok: false,
        error: resolveSelectionCaptureFailureMessage(
          result.reason,
          result.hasImage,
          mainI18n?.translator
        ),
        sourcePreference: settings.sourceLang,
        targetPreference: settings.targetLang,
        targetLang: settings.targetLang
      },
      2e3,
      result.anchor,
      shouldActivatePopupForCaptureFailure(process.platform)
    );
    if (interactionToken !== void 0) releaseSelectionInteraction(interactionToken);
    if (shouldAutoRepairHiServices) void autoRepairMacHiServices();
    return;
  }
  if (interactionToken !== void 0) {
    selectionInteraction.transition(interactionToken, "translating");
  }
  void translateText(result.text, result.anchor, void 0, "selection", interactionToken);
}
async function translateText(text, anchor, preferences, origin = "selection", interactionToken) {
  const settings = getSettings();
  const sourcePreference = preferences?.sourceLang ?? settings.sourceLang;
  const targetPreference = preferences?.targetLang ?? settings.targetLang;
  const pair = resolveLanguagePair(text, sourcePreference, targetPreference);
  const requestSettings = {
    ...settings,
    sourceLang: pair.sourceLang,
    targetLang: pair.targetLang
  };
  const requestId = ++latestTranslationRequest;
  const closeVersion2 = getPopupCloseVersion();
  if (origin === "selection") {
    lastSelectedText = text;
    if (anchor) lastSelectionAnchor = anchor;
  }
  showPopup(
    {
      ok: true,
      origin,
      requestId,
      loading: true,
      original: text,
      sourceLang: pair.sourceLang,
      targetLang: pair.targetLang,
      sourcePreference,
      targetPreference,
      ocrText: origin === "ocr" ? text : void 0,
      ocrRawText: origin === "ocr" ? text : void 0,
      ocrEngine: origin === "ocr" ? lastOcrEngine : void 0
    },
    0,
    anchor,
    // 选区取词刚通过 open -b 交还前台，加载态若立即 win.show() 会与交还动作
    // 竞争并产生迟到的 blur；等最终翻译结果到达后再激活，避免弹窗一闪即关。
    origin !== "selection"
  );
  try {
    const dingTalkCredentials = settings.dingTalkEnabled ? getDingTalkConfiguration().getCredentialsSnapshot() : null;
    const aiApiKey = settings.aiEnabled ? getAiConfiguration().getApiKey() : null;
    let deltaSequence = 0;
    const output = await translateStream(
      text,
      requestSettings,
      dingTalkCredentials,
      aiApiKey,
      {
        onDelta: (delta) => {
          if (requestId !== latestTranslationRequest || closeVersion2 !== getPopupCloseVersion()) return;
          const payload = {
            origin,
            requestId,
            delta,
            sequence: deltaSequence,
            final: false
          };
          deltaSequence += 1;
          sendPopupDelta(payload);
        }
      }
    );
    if (requestId !== latestTranslationRequest || closeVersion2 !== getPopupCloseVersion()) return;
    recordTranslationUsage(origin, output.provider);
    showPopup(
      {
        ok: true,
        origin,
        requestId,
        original: text,
        translation: output.translation,
        detectedLang: output.detectedLang,
        sourceLang: pair.sourceLang,
        targetLang: pair.targetLang,
        sourcePreference,
        targetPreference,
        provider: output.provider,
        channel: output.channel,
        ocrText: origin === "ocr" ? text : void 0,
        ocrRawText: origin === "ocr" ? text : void 0,
        ocrEngine: origin === "ocr" ? lastOcrEngine : void 0
      },
      settings.autoHideMs,
      anchor
    );
  } catch (e) {
    if (requestId !== latestTranslationRequest || closeVersion2 !== getPopupCloseVersion()) return;
    handleTranslateError(
      e,
      requestSettings,
      anchor,
      { sourceLang: sourcePreference, targetLang: targetPreference },
      { origin, requestId, original: text }
    );
  } finally {
    if (interactionToken !== void 0) releaseSelectionInteraction(interactionToken);
  }
}
function handleTranslateError(err, settings, anchor, preferences, context) {
  const common2 = {
    origin: context?.origin ?? "selection",
    requestId: context?.requestId,
    original: context?.original,
    sourcePreference: preferences?.sourceLang ?? settings.sourceLang,
    targetPreference: preferences?.targetLang ?? settings.targetLang,
    targetLang: settings.targetLang,
    ocrText: context?.origin === "ocr" ? context.original : void 0,
    ocrRawText: context?.origin === "ocr" ? context.original : void 0,
    ocrEngine: context?.origin === "ocr" ? lastOcrEngine : void 0
  };
  if (err instanceof PermissionError) {
    showPopup(
      {
        ok: false,
        error: t("error.accessibilityPermission"),
        ...common2
      },
      8e3,
      anchor
    );
    openAccessibilitySettings();
  } else {
    showPopup(
      { ok: false, error: err.message || t("error.translationFailed"), ...common2 },
      5e3,
      anchor
    );
  }
}
async function openManualTranslation() {
  await rememberFrontmostAppIfInactiveAsync();
  setPopupPinned(true);
  showManualTranslationPopup();
}
function getOcrSelectionWindowBounds() {
  const displays = electron.screen.getAllDisplays();
  return displays.reduce((area, display) => {
    const bounds = display.bounds;
    const x1 = Math.min(area.x, bounds.x);
    const y1 = Math.min(area.y, bounds.y);
    const x2 = Math.max(area.x + area.width, bounds.x + bounds.width);
    const y2 = Math.max(area.y + area.height, bounds.y + bounds.height);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }, { ...electron.screen.getPrimaryDisplay().bounds });
}
function getOcrSelectionWindow() {
  if (ocrSelectionWin && !ocrSelectionWin.isDestroyed()) return ocrSelectionWin;
  ocrSelectionWin = new electron.BrowserWindow({
    // 创建时就铺满全部显示器：Electron 默认以 800×600 创建窗口，若等到显示前才
    // setBounds 撑到全屏，Windows 会把这次尺寸变化渲染成「由小放大」的动作，
    // 空快照画布合成出的黑块也随之放大闪过。创建即全屏后窗口从第一帧就是最终尺寸。
    ...getOcrSelectionWindowBounds(),
    show: false,
    frame: false,
    transparent: true,
    // 透明窗口必须显式声明全透明原生背景色：Windows 上未声明时首帧会按默认
    // 背景色合成，用户看到的就是窗口上屏瞬间整屏闪一下大黑框。与翻译弹窗保持同一约定。
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // macOS 上普通无边框窗口会被系统钳制在菜单栏下方：setBounds 传入 y = 0 时实际会被抬到
    // workArea.y（本机为 33），窗口永远盖不住菜单栏。开启该选项后才能让覆盖窗口真正对齐
    // display.bounds 的 (0, 0)，这也是替代 setSimpleFullScreen 的关键——简单全屏会切换应用
    // 呈现模式并让系统隐藏菜单栏与 Dock 栏，采集到的快照本身就缺失这两个区域。
    // 该选项仅 macOS 生效，其它平台会被忽略。
    enableLargerThanScreen: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  ocrSelectionWin.setAlwaysOnTop(true, "screen-saver");
  ocrSelectionWin.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS);
  ocrSelectionWin.on("hide", () => {
    handleOcrSelectionWindowHide({
      resolveReady: resolveOcrSelectionReady,
      clearActiveRequests: () => activeScreenshotOcrRequests.clear(),
      restoreSelectionListener: restoreSelectionListenerAfterOcr
    });
  });
  ocrSelectionWin.on("closed", () => {
    ocrSelectionWin = null;
    handleOcrSelectionWindowClosed({
      resolveReady: resolveOcrSelectionReady,
      clearActiveRequests: () => activeScreenshotOcrRequests.clear(),
      releaseSnapshot: () => {
        latestOcrSnapshot = null;
        ocrSessionResultCache.clear();
      },
      restoreSelectionListener: restoreSelectionListenerAfterOcr
    });
  });
  ocrSelectionWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env["ELECTRON_RENDERER_URL"]) {
    ocrSelectionWin.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/selection.html`);
  } else {
    ocrSelectionWin.loadFile(node_path.join(__dirname, "../renderer/selection.html"));
  }
  return ocrSelectionWin;
}
function waitForOcrSelectionReady(win2, sessionId) {
  if (pendingOcrSelectionReady) resolveOcrSelectionReady(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingOcrSelectionReady?.sessionId === sessionId) pendingOcrSelectionReady = null;
      resolve(false);
    }, 1e3);
    pendingOcrSelectionReady = { sessionId, resolve, timer };
    if (win2.isDestroyed()) resolveOcrSelectionReady(false);
  });
}
function resolveOcrSelectionReady(ready) {
  const pending = pendingOcrSelectionReady;
  if (!pending) return;
  pendingOcrSelectionReady = null;
  clearTimeout(pending.timer);
  pending.resolve(ready);
}
function isOcrSelectionVisible() {
  return Boolean(ocrSelectionWin && !ocrSelectionWin.isDestroyed() && ocrSelectionWin.isVisible());
}
function whenOcrSelectionWindowReady(win2) {
  if (win2.isDestroyed()) return Promise.reject(new Error("ocr-overlay-destroyed"));
  if (!win2.webContents.isLoading()) return Promise.resolve();
  const existing = ocrSelectionWindowReadyPromises.get(win2);
  if (existing) return existing;
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      win2.webContents.removeListener("did-finish-load", onFinish);
      win2.webContents.removeListener("did-fail-load", onFail);
      win2.removeListener("closed", onClosed);
      ocrSelectionWindowReadyPromises.delete(win2);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error2) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error2);
    };
    const onFinish = () => succeed();
    const onFail = (_event, errorCode, errorDescription) => {
      fail(new Error(`ocr-overlay-load-failed:${errorCode}:${errorDescription}`));
    };
    const onClosed = () => fail(new Error("ocr-overlay-closed"));
    win2.webContents.once("did-finish-load", onFinish);
    win2.webContents.once("did-fail-load", onFail);
    win2.once("closed", onClosed);
  });
  ocrSelectionWindowReadyPromises.set(win2, ready);
  return ready;
}
function getScreenshotToastWindow() {
  if (screenshotToastWin && !screenshotToastWin.isDestroyed()) return screenshotToastWin;
  screenshotToastWin = new electron.BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    width: 260,
    height: 56,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  screenshotToastWin.setAlwaysOnTop(true, "screen-saver");
  screenshotToastWin.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS);
  screenshotToastWin.setIgnoreMouseEvents(true);
  screenshotToastWin.on("closed", () => {
    if (screenshotToastHideTimer) {
      clearTimeout(screenshotToastHideTimer);
      screenshotToastHideTimer = null;
    }
    screenshotToastWin = null;
    selectionListenerController.resume("screenshot-toast");
  });
  screenshotToastWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env["ELECTRON_RENDERER_URL"]) {
    screenshotToastWin.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/toast.html`);
  } else {
    screenshotToastWin.loadFile(node_path.join(__dirname, "../renderer/toast.html"));
  }
  return screenshotToastWin;
}
function showScreenshotToast(message, displayTimeMs = 1500, kind = "success") {
  selectionListenerController.pause("screenshot-toast");
  const win2 = getScreenshotToastWindow();
  const show = () => {
    win2.webContents.send("screenshot-toast:show", { message, kind, displayTimeMs });
  };
  if (win2.webContents.isLoading()) {
    win2.webContents.once("did-finish-load", show);
  } else {
    show();
  }
}
function handleScreenshotToastShowWindow(value) {
  const win2 = screenshotToastWin;
  if (!win2 || win2.isDestroyed()) return;
  if (screenshotToastHideTimer) {
    clearTimeout(screenshotToastHideTimer);
    screenshotToastHideTimer = null;
  }
  const raw = value;
  const width = Math.min(Math.max(Math.ceil(raw.width ?? 0) + 8, 120), 480);
  const height = Math.min(Math.max(Math.ceil(raw.height ?? 0) + 8, 36), 120);
  const displayTimeMs = Math.max(raw.displayTimeMs ?? 1500, 500);
  const display = electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint());
  const area = display.workArea;
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + area.height * 0.9 - height);
  win2.setBounds({ x, y, width, height });
  win2.showInactive();
  screenshotToastHideTimer = setTimeout(() => {
    if (screenshotToastWin && !screenshotToastWin.isDestroyed()) {
      screenshotToastWin.hide();
    }
    screenshotToastHideTimer = null;
    selectionListenerController.resume("screenshot-toast");
  }, displayTimeMs);
}
function suspendSelectionListenerForOcr() {
  selectionListenerController.pause("ocr");
}
function restoreSelectionListenerAfterOcr(interactionToken) {
  if (interactionToken !== void 0 && ocrInteractionToken !== interactionToken) return;
  selectionListenerController.resume("ocr");
  const token = ocrInteractionToken;
  ocrInteractionToken = null;
  if (token !== null) releaseSelectionInteraction(token);
}
function hideOcrSelectionWindow() {
  const wasVisible = isOcrSelectionVisible();
  if (process.platform === "darwin" && ocrSelectionWin && !ocrSelectionWin.isDestroyed() && ocrSelectionWin.isSimpleFullScreen()) {
    ocrSelectionWin.setSimpleFullScreen(false);
  }
  ocrSelectionWin?.hide();
  return wasVisible;
}
function isCurrentOcrCapture(token) {
  return ocrInteractionToken === token && selectionInteraction.isCurrent(token);
}
function sendToOcrSelectionWindow(win2, channel, payload) {
  if (win2.isDestroyed()) return;
  const sessionId = payload?.sessionId;
  if (win2.webContents.isLoading()) return;
  if (typeof sessionId === "number" && sessionId !== ocrSelectionSessionSeq) return;
  win2.webContents.send(channel, payload);
}
function failOcrSelectionCapture(interactionToken, error2, anchor) {
  if (!isCurrentOcrCapture(interactionToken)) return;
  const settings = getSettings();
  const code = resolveOcrErrorCode(error2);
  const message = error2 instanceof Error ? error2.message : t("error.screenCaptureFailed");
  const failedPayload = {
    sessionId: ocrSelectionSessionSeq,
    message,
    ocrCode: code
  };
  if (ocrSelectionWin && !ocrSelectionWin.isDestroyed()) {
    sendToOcrSelectionWindow(ocrSelectionWin, "ocr-selection:failed", failedPayload);
  }
  latestOcrSnapshot = null;
  ocrSessionResultCache.clear();
  const hideOverlay = () => {
    hideOcrSelectionWindow();
    restoreSelectionListenerAfterOcr(interactionToken);
  };
  const showErrorPopup = () => {
    showPopup({
      ok: false,
      origin: "ocr",
      original: "",
      error: message,
      ocrCode: code,
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    }, code === "permission" ? 8e3 : 5e3, anchor);
  };
  if (isMac) {
    showErrorPopup();
    hideOverlay();
  } else {
    hideOverlay();
    showErrorPopup();
  }
  if (code === "permission") {
    void electron.shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  }
}
async function openOcrSelection() {
  if (selectionInteraction.snapshot().state === "ocr-selecting") return;
  ocrSessionAppWasFrontmost = electron.BrowserWindow.getFocusedWindow() !== null;
  forgetFrontmostApp();
  const previousAppPromise = isMac && !ocrSessionAppWasFrontmost ? readFrontmostAppSnapshot() : null;
  const hotkeyAt = Date.now();
  latestSelectionGesture += 1;
  const interactionToken = selectionInteraction.beginOcrSelection();
  ocrInteractionToken = interactionToken;
  ocrSelectionSessionSeq += 1;
  const ocrSessionId = ocrSelectionSessionSeq;
  selectionCapture.invalidate();
  suspendSelectionListenerForOcr();
  hideSelectionButton();
  const display = electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint());
  const anchor = electron.screen.getCursorScreenPoint();
  latestOcrSnapshot = null;
  ocrSessionResultCache.clear();
  const win2 = getOcrSelectionWindow();
  const currentBounds = win2.getBounds();
  if (currentBounds.x !== display.bounds.x || currentBounds.y !== display.bounds.y || currentBounds.width !== display.bounds.width || currentBounds.height !== display.bounds.height) {
    win2.setBounds(display.bounds);
  }
  let timeoutTimer = null;
  let timedOut = false;
  try {
    await whenOcrSelectionWindowReady(win2);
    if (!isCurrentOcrCapture(interactionToken)) {
      restoreSelectionListenerAfterOcr(interactionToken);
      return;
    }
    if (!hasScreenRecordingPermission()) {
      throw new ScreenCaptureError("permission", t("error.screenRecordingPermission"));
    }
    const rendererReadyPromise = waitForOcrSelectionReady(win2, ocrSessionId);
    sendToOcrSelectionWindow(win2, "ocr-selection:begin", {
      sessionId: ocrSessionId,
      bounds: display.bounds
    });
    const showBeforeCapture = !["win32", "darwin"].includes(process.platform);
    let hotkeyToShowMs = 0;
    if (showBeforeCapture) {
      win2.show();
      win2.focus();
      hotkeyToShowMs = Date.now() - hotkeyAt;
    }
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      failOcrSelectionCapture(
        interactionToken,
        new ScreenCaptureError("no-source", t("error.screenCaptureTimeout")),
        anchor
      );
    }, OCR_PREVIEW_CAPTURE_TIMEOUT_MS);
    if (showBeforeCapture) {
      const readyBeforeShow = await rendererReadyPromise;
      if (!readyBeforeShow || !isCurrentOcrCapture(interactionToken)) {
        restoreSelectionListenerAfterOcr(interactionToken);
        return;
      }
    }
    const capturePromise = captureOcrPreviewSnapshot(display.bounds);
    const prepareMs = Date.now() - hotkeyAt;
    const [rendererReady2, preview] = await Promise.all([
      showBeforeCapture ? Promise.resolve(true) : rendererReadyPromise,
      capturePromise
    ]);
    const rendererReadyMs = Date.now() - hotkeyAt;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (timedOut) return;
    if (!rendererReady2 || !isCurrentOcrCapture(interactionToken)) {
      restoreSelectionListenerAfterOcr(interactionToken);
      return;
    }
    if (!isCurrentOcrCapture(interactionToken)) {
      restoreSelectionListenerAfterOcr(interactionToken);
      return;
    }
    if (!showBeforeCapture) {
      if (previousAppPromise) rememberFrontmostApp(await previousAppPromise);
      win2.show();
      win2.focus();
      hotkeyToShowMs = Date.now() - hotkeyAt;
    }
    await yieldToEventLoop();
    const { preview: previewPayload, previewEncodeMs } = preview.buildPreviewPayload();
    latestOcrSnapshot = preview.snapshot;
    const sendStartedAt = Date.now();
    sendToOcrSelectionWindow(win2, "ocr-selection:snapshot", {
      sessionId: ocrSessionId,
      bounds: preview.snapshot.bounds,
      ...previewPayload
    });
    console.log("[ocr] 预览就绪", {
      source: preview.snapshot.source,
      hotkeyToShowMs,
      prepareMs,
      rendererReadyMs,
      captureMs: preview.captureMs,
      previewEncodeMs,
      ipcSendMs: Date.now() - sendStartedAt
    });
  } catch (error2) {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (timedOut) return;
    failOcrSelectionCapture(interactionToken, error2, anchor);
  }
}
function returnFrontmostThenHideOcrSelection() {
  const sessionSeqAtReturn = ocrSelectionSessionSeq;
  const hideOverlay = () => {
    if (ocrSelectionSessionSeq !== sessionSeqAtReturn) return;
    hideOcrSelectionWindow();
  };
  handBackFrontmostThen(ocrSelectionWin, hideOverlay, () => {
    if (ocrSelectionSessionSeq !== sessionSeqAtReturn) return;
    hideOverlay();
    restoreAppWindowsByHidingApp();
  });
}
function restoreAppWindowsByHidingApp() {
  const sessionSeqAtHide = ocrSelectionSessionSeq;
  electron.app.hide();
  const restoreAppWindows = () => {
    if (ocrSelectionSessionSeq !== sessionSeqAtHide) return;
    electron.app.show();
  };
  setTimeout(restoreAppWindows, FRONT_RESTORE_DELAY_MS);
  setTimeout(restoreAppWindows, FRONT_RESTORE_VERIFY_DELAY_MS);
}
function cancelOcrSelection() {
  activeScreenshotOcrRequests.clear();
  resolveOcrSelectionReady(false);
  latestOcrSnapshot = null;
  ocrSessionResultCache.clear();
  restoreSelectionListenerAfterOcr();
  const wasVisible = isOcrSelectionVisible();
  if (wasVisible && !ocrSessionAppWasFrontmost) {
    ocrSessionAppWasFrontmost = true;
    returnFrontmostThenHideOcrSelection();
    return;
  }
  hideOcrSelectionWindow();
  ocrSessionAppWasFrontmost = true;
}
function finishScreenshotSession() {
  activeScreenshotOcrRequests.clear();
  latestOcrSnapshot = null;
  ocrSessionResultCache.clear();
}
class ScreenshotSelectionError extends Error {
  /** 细分错误码。 */
  code;
  /**
   * 创建截图选区动作错误。
   * @param code 细分错误码。
   * @param message 面向用户的描述。
   * @author zhenghq
   */
  constructor(code, message) {
    super(message);
    this.name = "ScreenshotSelectionError";
    this.code = code;
  }
}
function normalizeOcrSelectionBounds(value) {
  if (!value || typeof value !== "object") return null;
  const bounds = value;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < MIN_OCR_SELECTION_SIZE || height < MIN_OCR_SELECTION_SIZE) return null;
  const windowBounds = ocrSelectionWin?.getBounds() ?? { x: 0, y: 0 };
  return {
    x: Math.round(windowBounds.x + x),
    y: Math.round(windowBounds.y + y),
    width: Math.round(width),
    height: Math.round(height)
  };
}
function resolveOcrErrorCode(error2) {
  if (error2 instanceof ScreenCaptureError && error2.code === "permission") return "permission";
  if (error2 instanceof OcrEngineError) return error2.code;
  return "engine-unavailable";
}
const WEB_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const WEB_IMAGE_MAX_PIXELS = 16e6;
const WEB_IMAGE_REQUEST_TIMEOUT_MS = 15e3;
function createWebReaderImageSource(view, signal) {
  const requestImage = async (url, requestSignal) => {
    const request = electron.net.request({ url, session: view.webContents.session, useSessionCookies: true });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        request.abort();
        reject(new Error(t("error.imageRequestTimeout")));
      }, WEB_IMAGE_REQUEST_TIMEOUT_MS);
      const finish = () => {
        clearTimeout(timer);
      };
      requestSignal?.addEventListener("abort", () => {
        finish();
        request.abort();
        reject(new Error(t("error.imageRequestCancelled")));
      }, { once: true });
      request.on("error", (error2) => {
        finish();
        reject(error2);
      });
      request.on("response", (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("error", (error2) => {
          finish();
          reject(error2);
        });
        response.on("end", () => {
          finish();
          resolve({
            bytes: Buffer.concat(chunks),
            contentType: String(response.headers["content-type"] ?? "")
          });
        });
      });
      request.end();
    });
  };
  const resolveViewport = async () => {
    return await view.webContents.executeJavaScript(`(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight
    }))()`, true);
  };
  const readCanvasImage = async (candidate) => {
    const anchor = JSON.stringify({
      selector: candidate.selector,
      shadowPath: candidate.shadowPath ?? []
    });
    const exported = await view.webContents.executeJavaScript(`(() => {
      const anchor = ${anchor};
      let element = null;
      try { element = document.querySelector(anchor.selector); } catch {}
      if (element && anchor.shadowPath.length > 0) {
        let current = element.shadowRoot;
        for (const index of anchor.shadowPath) {
          if (!current?.childNodes?.[index]) { current = null; break; }
          current = current.childNodes[index];
        }
        element = current;
      }
      if (!element || element.tagName !== 'CANVAS') return null;
      try {
        const dataUrl = element.toDataURL('image/png');
        if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/png;base64,') !== 0) return null;
        return { base64: dataUrl.slice('data:image/png;base64,'.length), width: element.width, height: element.height };
      } catch {
        return null;
      }
    })()`, true);
    if (!exported?.base64) return null;
    const bytes = Buffer.from(exported.base64, "base64");
    if (bytes.length === 0) return null;
    return { bytes, contentType: "image/png", width: exported.width, height: exported.height };
  };
  const revealVisibleRect = async (candidate) => {
    const anchor = JSON.stringify({
      selector: candidate.selector,
      shadowPath: candidate.shadowPath ?? [],
      x: Math.round(candidate.rect.x),
      y: Math.round(candidate.rect.y),
      width: Math.round(candidate.rect.width),
      height: Math.round(candidate.rect.height)
    });
    return await view.webContents.executeJavaScript(`(async () => {
      const anchor = ${anchor};
      const resolve = () => {
        let element = null;
        try { element = document.querySelector(anchor.selector); } catch {}
        if (element && anchor.shadowPath.length > 0) {
          let current = element.shadowRoot;
          for (const index of anchor.shadowPath) {
            if (!current?.childNodes?.[index]) return null;
            current = current.childNodes[index];
          }
          element = current;
        }
        return element?.nodeType === Node.ELEMENT_NODE ? element : null;
      };
      const scrollableAncestors = (element) => {
        const list = [];
        let current = element.parentElement;
        while (current && current !== document.documentElement) {
          const style = getComputedStyle(current);
          if (/(auto|scroll|overlay)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 1) list.push(current);
          current = current.parentElement;
        }
        return list;
      };
      const restore = [];
      const element = resolve();
      if (!element) return null;
      for (const scroller of scrollableAncestors(element)) {
        restore.push({ scroller, scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft });
      }
      // 同时记录文档滚动位置，避免无内层滚动容器时 window.scrollTo 无法还原。
      window.__selectionTranslatorWebImageReveal = {
        windowScroll: { scrollX: window.scrollX, scrollY: window.scrollY },
        scrollers: restore
      };
      const viewport = { scrollX: window.scrollX, scrollY: window.scrollY };
      if (restore.length === 0) {
        const targetY = Math.max(0, anchor.y - Math.round(window.innerHeight / 3));
        window.scrollTo({ left: viewport.scrollX, top: targetY, behavior: 'instant' });
      } else {
        // 逐层把候选对齐到各自滚动容器顶部，外层容器同样需要滚动。
        for (const scroller of restore) {
          const scrollerRect = scroller.scroller.getBoundingClientRect();
          const elementRect = element.getBoundingClientRect();
          scroller.scroller.scrollTop += Math.round(elementRect.top - scrollerRect.top);
        }
      }
      // 页面被隐藏时 requestAnimationFrame 可能永不触发，改用定时器等待合成器提交新画面。
      await new Promise((resolve) => setTimeout(resolve, 32));
      const rect = element.getBoundingClientRect();
      let clip = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
      let current = element.parentElement;
      while (current) {
        const style = getComputedStyle(current);
        if (/(auto|scroll|overlay|hidden)/.test(style.overflowY) || /(auto|scroll|overlay|hidden)/.test(style.overflowX)) {
          const clipRect = current.getBoundingClientRect();
          clip = {
            top: Math.max(clip.top, clipRect.top),
            left: Math.max(clip.left, clipRect.left),
            right: Math.min(clip.right, clipRect.right),
            bottom: Math.min(clip.bottom, clipRect.bottom)
          };
        }
        current = current.parentElement;
      }
      const top = Math.max(rect.top, clip.top);
      const left = Math.max(rect.left, clip.left);
      const right = Math.min(rect.right, clip.right);
      const bottom = Math.min(rect.bottom, clip.bottom);
      if (right - left < 1 || bottom - top < 1) return null;
      return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
    })()`, true);
  };
  const restoreRevealed = async () => {
    await view.webContents.executeJavaScript(`(() => {
      const restore = window.__selectionTranslatorWebImageReveal;
      window.__selectionTranslatorWebImageReveal = null;
      if (!restore) return;
      for (const item of restore.scrollers || []) {
        if (!item?.scroller) continue;
        item.scroller.scrollTop = item.scrollTop;
        item.scroller.scrollLeft = item.scrollLeft;
      }
      const windowScroll = restore.windowScroll;
      if (windowScroll) {
        window.scrollTo({ left: windowScroll.scrollX, top: windowScroll.scrollY, behavior: 'instant' });
      }
    })()`, true);
  };
  return createWebImageSource({
    requestImage,
    captureRegion: async (rect, captureSignal) => {
      if (captureSignal?.aborted) throw new Error(t("error.imageCaptureCancelled"));
      const image = await view.webContents.capturePage(rect);
      return image.toPNG();
    },
    resolveViewport,
    readCanvasImage,
    revealVisibleRect,
    restoreRevealed,
    scrollIntoView: async (rect) => {
      return await view.webContents.executeJavaScript(`(async () => {
        const targetY = Math.max(0, ${JSON.stringify(Math.round(rect.y))} - Math.round(window.innerHeight / 3));
        // 页面可能声明 scroll-behavior: smooth，平滑动画结束前读取视口会取到错误区域，
        // 因此强制即时滚动，并在滚动位置稳定后再交由截图读取。
        window.scrollTo({ left: window.scrollX, top: targetY, behavior: 'instant' });
        // capturePage 在滚动后立即调用会返回滚动前的旧帧，等待两次绘制确保合成器已提交新画面。
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        // 页面底部图片可能受最大滚动距离限制而无法到达目标位置，
        // 因此以候选矩形是否进入视口作为成功判据，而非精确匹配目标滚动值。
        const top = ${JSON.stringify(Math.round(rect.y))} - window.scrollY;
        const left = ${JSON.stringify(Math.round(rect.x))} - window.scrollX;
        return top + ${JSON.stringify(Math.round(rect.height))} > 0 && top < window.innerHeight &&
          left + ${JSON.stringify(Math.round(rect.width))} > 0 && left < window.innerWidth;
      })()`, true);
    },
    restoreScroll: async (scrollX, scrollY) => {
      await view.webContents.executeJavaScript(
        `window.scrollTo({ left: ${JSON.stringify(Math.round(scrollX))}, top: ${JSON.stringify(Math.round(scrollY))}, behavior: 'instant' })`,
        true
      );
    },
    maxBytes: WEB_IMAGE_MAX_BYTES,
    maxPixels: WEB_IMAGE_MAX_PIXELS,
    signal
  });
}
function createOcrDispatcher(settings) {
  const paddleModelAssets = resolveBundledOcrModelAssets(electron.app.getAppPath());
  return new OcrDispatcher({
    platform: process.platform,
    enginePreferenceState: ocrEnginePreferenceState,
    engines: {
      system: createSystemOcrEngine(),
      paddle: paddleModelAssets.ready ? new PaddleOcrEngine({ models: paddleModelAssets.models }) : null,
      tesseract: settings.ocrTesseractEnabled ? new TesseractOcrEngine({ tessDataPath: node_path.join(electron.app.getPath("userData"), "tessdata") }) : null
    }
  });
}
async function getOcrStatus() {
  const paddleModelAssets = resolveBundledOcrModelAssets(electron.app.getAppPath());
  const systemEngine = createSystemOcrEngine();
  const paddleEngine = paddleModelAssets.ready ? new PaddleOcrEngine({ models: paddleModelAssets.models }) : null;
  const tesseractEngine = new TesseractOcrEngine({
    tessDataPath: node_path.join(electron.app.getPath("userData"), "tessdata")
  });
  const [systemAvailable, paddleAvailable, tesseractAvailable] = await Promise.all([
    Promise.resolve(systemEngine?.isAvailable() ?? false).catch(() => false),
    Promise.resolve(paddleEngine?.isAvailable() ?? false).catch(() => false),
    Promise.resolve(tesseractEngine.isAvailable()).catch(() => false)
  ]);
  return {
    systemAvailable,
    paddleAvailable,
    tesseractAvailable,
    modelName: paddleModelAssets.metadata.name,
    modelVersion: paddleModelAssets.metadata.version,
    license: paddleModelAssets.metadata.license,
    distribution: paddleModelAssets.ready ? "bundled" : "unavailable",
    message: paddleModelAssets.ready ? paddleAvailable ? t("ocr.assetsReady", { name: paddleModelAssets.metadata.name }) : t("ocr.assetsRuntimeUnavailable", { name: paddleModelAssets.metadata.name }) : t("ocr.assetsFallback", { message: paddleModelAssets.message })
  };
}
function showOcrTranslationResult(result, settings, requestId, anchor) {
  const sourcePreference = settings.sourceLang;
  const targetPreference = settings.targetLang;
  const code = result.ocrCode === "cancelled" ? "timeout" : result.ocrCode;
  lastOcrEngine = result.ocrEngine;
  if (result.ocrText) {
    lastOcrText = result.ocrText;
    lastOcrAnchor = anchor;
  }
  if (code || result.error) {
    showPopup({
      ok: false,
      origin: "ocr",
      requestId,
      original: result.ocrText,
      error: result.error ?? t("error.noTranslatableText"),
      ocrText: result.ocrText,
      ocrRawText: result.ocrRawText,
      ocrEngine: result.ocrEngine,
      ocrCode: code,
      sourcePreference,
      targetPreference,
      targetLang: settings.targetLang
    }, 5e3, anchor);
    return;
  }
  const pair = resolveLanguagePair(result.ocrText, sourcePreference, targetPreference);
  showPopup({
    ok: true,
    origin: "ocr",
    requestId,
    original: result.ocrText,
    translation: result.translation,
    detectedLang: result.detectedLang,
    sourceLang: pair.sourceLang,
    targetLang: pair.targetLang,
    sourcePreference,
    targetPreference,
    provider: result.provider,
    channel: result.channel,
    ocrText: result.ocrText,
    ocrRawText: result.ocrRawText,
    ocrEngine: result.ocrEngine
  }, settings.autoHideMs, anchor);
}
async function translateRecognizedOcrResult(ocr, settings) {
  return translateOcrResult(ocr, settings, {
    translate: async (text, requestSettings) => {
      const dingTalkCredentials = settings.dingTalkEnabled ? getDingTalkConfiguration().getCredentialsSnapshot() : null;
      const aiApiKey = settings.aiEnabled ? getAiConfiguration().getApiKey() : null;
      return translate(
        text,
        requestSettings ?? settings,
        dingTalkCredentials,
        aiApiKey
      );
    }
  });
}
async function processOcrImageBytes(imageBytes, settings) {
  const dispatcher = createOcrDispatcher(settings);
  const ocr = await recognizeAdaptiveOcr(
    {
      imageBytes,
      maxScale: settings.ocrScale,
      language: settings.ocrLang
    },
    {
      recognize: (preparedImageBytes) => dispatcher.recognize({
        imageBytes: preparedImageBytes,
        language: settings.ocrLang,
        timeoutMs: OCR_TIMEOUT_MS
      }, settings.ocrEnginePreference)
    }
  );
  return translateRecognizedOcrResult(ocr, settings);
}
async function logOcrCaptureDiagnostic(imageBytes, bounds, source) {
  const sha1 = node_crypto.createHash("sha1").update(imageBytes).digest("hex").slice(0, 12);
  console.log("[ocr] 截图完成", {
    source,
    bytes: imageBytes.length,
    sha1,
    bounds
  });
}
async function captureMacRegionAsPng(bounds) {
  const path = node_path.join(
    node_os.tmpdir(),
    `selection-translator-ocr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`
  );
  const rect = [
    Math.round(bounds.x),
    Math.round(bounds.y),
    Math.max(1, Math.round(bounds.width)),
    Math.max(1, Math.round(bounds.height))
  ].join(",");
  try {
    await execFileP("screencapture", ["-x", "-R", rect, path], { timeout: 5e3 });
    return await promises.readFile(path);
  } catch (error2) {
    const message = error2 instanceof Error ? error2.message : String(error2);
    if (/permission|privacy|denied|not authorized/i.test(message)) {
      throw new ScreenCaptureError("permission", t("error.screenRecordingPermission"));
    }
    throw new ScreenCaptureError("no-source", t("error.screenCaptureFailedDetail", { message }));
  } finally {
    await promises.unlink(path).catch(() => void 0);
  }
}
function resolveWindowsCaptureScale(bounds) {
  const display = electron.screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  });
  return display?.scaleFactor ?? 1;
}
function buildWindowsOcrCaptureDeps() {
  return {
    platform: process.platform,
    captureFallback: (displayBounds, scale) => captureWindowsRegionAsPng(displayBounds, scale, buildWindowsScreenCaptureDeps()),
    onGdiFailure: (message) => {
      console.warn("[ocr] GDI 截屏失败，回退 helper exe / PowerShell", { message });
    }
  };
}
function buildWindowsScreenCaptureDeps() {
  return {
    platform: process.platform,
    execFile: execFileP,
    readFile: promises.readFile,
    unlink: promises.unlink,
    tmpDir: node_os.tmpdir,
    spawn: spawnP
  };
}
async function captureWindowsOcrPreview(bounds) {
  return await captureWindowsOcrPreviewPreferGdi(
    bounds,
    resolveWindowsCaptureScale(bounds),
    buildWindowsOcrCaptureDeps()
  );
}
async function captureOcrPreviewSnapshot(bounds) {
  const captureStartedAt = Date.now();
  if (process.platform === "win32") {
    const captured = await captureWindowsOcrPreview(bounds);
    const captureMs2 = Date.now() - captureStartedAt;
    const createImage = () => captured.kind === "pixels" ? electron.nativeImage.createFromBitmap(
      Buffer.from(
        captured.pixels.data.buffer,
        captured.pixels.data.byteOffset,
        captured.pixels.data.byteLength
      ),
      { width: captured.pixels.width, height: captured.pixels.height }
    ) : electron.nativeImage.createFromBuffer(captured.png);
    let image2 = null;
    const resolveImage = () => {
      image2 ??= createImage();
      return image2;
    };
    return {
      snapshot: {
        get image() {
          return resolveImage();
        },
        pixels: captured.kind === "pixels" ? captured.pixels : void 0,
        bounds,
        source: `${captured.source}-preview`
      },
      captureMs: captureMs2,
      buildPreviewPayload: () => {
        const encodeStartedAt = Date.now();
        if (captured.kind === "pixels") {
          return {
            preview: { pixels: captured.pixels },
            previewEncodeMs: Date.now() - encodeStartedAt
          };
        }
        const previewDataUrl = `data:image/png;base64,${captured.png.toString("base64")}`;
        return {
          preview: { imageDataUrl: previewDataUrl },
          previewEncodeMs: Date.now() - encodeStartedAt
        };
      }
    };
  }
  if (process.platform === "darwin") {
    const png = await captureMacRegionAsPng(bounds);
    const captureMs2 = Date.now() - captureStartedAt;
    return {
      snapshot: { image: electron.nativeImage.createFromBuffer(png), bounds, source: "macos-screencapture-preview" },
      captureMs: captureMs2,
      // macOS 采集产物本身就是 PNG，base64 只是字符串转换；仍然延后到显示之后，
      // 避免整屏 base64（约 10-30MB 字符串）拖慢覆盖窗口出现。
      buildPreviewPayload: () => {
        const encodeStartedAt = Date.now();
        const previewDataUrl = `data:image/png;base64,${png.toString("base64")}`;
        return {
          preview: { imageDataUrl: previewDataUrl },
          previewEncodeMs: Date.now() - encodeStartedAt
        };
      }
    };
  }
  const image = await captureRegionAsPng(bounds, { ocrScale: 1 }, {
    getSources: (options) => electron.desktopCapturer.getSources(options),
    getDisplayNearestPoint: (point) => electron.screen.getDisplayNearestPoint(point),
    getPrimaryDisplay: () => electron.screen.getPrimaryDisplay(),
    platform: process.platform
  });
  const captureMs = Date.now() - captureStartedAt;
  return {
    snapshot: {
      image: electron.nativeImage.createFromBuffer(image.png),
      bounds,
      source: "electron-desktopCapturer-preview"
    },
    captureMs,
    buildPreviewPayload: () => {
      const encodeStartedAt = Date.now();
      const previewDataUrl = `data:image/png;base64,${image.png.toString("base64")}`;
      return {
        preview: { imageDataUrl: previewDataUrl },
        previewEncodeMs: Date.now() - encodeStartedAt
      };
    }
  };
}
function cropSnapshotSelectionPng(snapshot, bounds) {
  if (snapshot.pixels) {
    return cropBgraSelectionPng(
      snapshot.pixels.data,
      snapshot.pixels.width,
      snapshot.pixels.height,
      snapshot.source,
      bounds,
      snapshot.bounds
    );
  }
  const { width, height } = snapshot.image.getSize();
  const rect = resolveSnapshotCropRect(snapshot.source, bounds, snapshot.bounds, width, height);
  return snapshot.image.crop(rect).toPNG();
}
async function cropOcrSnapshotSelection(bounds) {
  const snapshot = latestOcrSnapshot;
  if (!snapshot) {
    throw new ScreenCaptureError("no-source", t("error.screenshotExpired"));
  }
  const png = cropSnapshotSelectionPng(snapshot, bounds);
  await logOcrCaptureDiagnostic(png, bounds, `${snapshot.source}-crop`);
  latestOcrSnapshot = null;
  return png;
}
function normalizeScreenshotActionRequest(value) {
  if (!value || typeof value !== "object") return null;
  const raw = value;
  const actions = ["recognize", "translate", "copy-image", "save-image"];
  if (!actions.includes(raw.action)) return null;
  if (typeof raw.requestId !== "string" || !raw.requestId.trim()) return null;
  if (!Number.isInteger(raw.sessionId) || raw.sessionId <= 0) return null;
  if (!raw.bounds || typeof raw.bounds !== "object") return null;
  return raw;
}
function normalizeScreenshotExportImageRequest(value) {
  if (!value || typeof value !== "object") return null;
  const raw = value;
  if (!Number.isInteger(raw.sessionId) || raw.sessionId <= 0) return null;
  if (!raw.bounds || typeof raw.bounds !== "object") return null;
  return raw;
}
function isCurrentScreenshotRequest(request) {
  return request.sessionId === ocrSelectionSessionSeq;
}
function cropCurrentOcrSelectionPng(value) {
  const bounds = normalizeOcrSelectionBounds(value);
  if (!bounds) {
    throw new ScreenshotSelectionError("invalid-selection", t("error.invalidSelection"));
  }
  const snapshot = latestOcrSnapshot;
  if (!snapshot) {
    throw new ScreenshotSelectionError("snapshot-expired", t("error.screenshotExpired"));
  }
  return cropSnapshotSelectionPng(snapshot, bounds);
}
function cropCurrentOcrSelectionPngFast(value) {
  const bounds = normalizeOcrSelectionBounds(value);
  if (!bounds) {
    throw new ScreenshotSelectionError("invalid-selection", t("error.invalidSelection"));
  }
  const snapshot = latestOcrSnapshot;
  if (!snapshot) {
    throw new ScreenshotSelectionError("snapshot-expired", t("error.screenshotExpired"));
  }
  const { width, height } = snapshot.image.getSize();
  const cropRect = resolveSnapshotCropRect(snapshot.source, bounds, snapshot.bounds, width, height);
  return snapshot.image.crop(cropRect).toPNG();
}
function isScreenshotOcrRequestActive(requestId, sessionId) {
  return activeScreenshotOcrRequests.get(requestId) === sessionId && sessionId === ocrSelectionSessionSeq && Boolean(ocrSelectionWin && !ocrSelectionWin.isDestroyed());
}
function resolveScreenshotActionErrorCode(error2) {
  if (error2 instanceof ScreenshotSelectionError) return error2.code;
  if (error2 instanceof OcrEngineError) return error2.code;
  if (error2 instanceof ScreenCaptureError) {
    return error2.code === "permission" ? "permission" : "snapshot-expired";
  }
  return "engine-unavailable";
}
function sendScreenshotRecognizeResult(result) {
  const sessionId = result.sessionId ?? ocrSelectionSessionSeq;
  if (!isScreenshotOcrRequestActive(result.requestId, sessionId)) return;
  ocrSelectionWin?.webContents.send("ocr-selection:recognize-result", { ...result, sessionId });
}
function sendScreenshotActionResult(result) {
  const sessionId = result.sessionId ?? ocrSelectionSessionSeq;
  if (!isScreenshotOcrRequestActive(result.requestId, sessionId)) return;
  ocrSelectionWin?.webContents.send("ocr-selection:action-result", { ...result, sessionId });
}
async function recognizeOcrSelectionAction(value) {
  const request = normalizeScreenshotActionRequest(value);
  if (!request || !isCurrentScreenshotRequest(request)) return;
  const settings = getSettings();
  try {
    const sessionBounds = normalizeOcrSelectionBounds(request.bounds);
    const png = cropCurrentOcrSelectionPng(request.bounds);
    const dispatcher = createOcrDispatcher(settings);
    const ocr = await recognizeAdaptiveOcr(
      {
        imageBytes: png,
        maxScale: settings.ocrScale,
        language: settings.ocrLang
      },
      {
        recognize: (preparedImageBytes) => dispatcher.recognize({
          imageBytes: preparedImageBytes,
          language: settings.ocrLang,
          timeoutMs: OCR_TIMEOUT_MS
        }, settings.ocrEnginePreference)
      }
    );
    const text = cleanOcrText(ocr.text ?? "");
    if (text) {
      if (sessionBounds) {
        ocrSessionResultCache.set(
          buildOcrSessionResultKey(request.sessionId, sessionBounds, settings),
          // 缓存原始识别结果：翻译管道会重新清洗并计算质量分，
          // 若提前写入清洗文本会丢失弹窗用于排查的 ocrRawText。
          ocr
        );
      }
    }
    sendScreenshotRecognizeResult(
      text ? { requestId: request.requestId, sessionId: request.sessionId, ok: true, text, engine: ocr.engine } : { requestId: request.requestId, sessionId: request.sessionId, ok: false, code: "empty", error: t("error.noRecognizedText") }
    );
  } catch (error2) {
    sendScreenshotRecognizeResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      ok: false,
      code: resolveScreenshotActionErrorCode(error2),
      error: error2 instanceof Error ? error2.message : t("error.ocrFailed")
    });
  } finally {
    activeScreenshotOcrRequests.delete(request.requestId);
  }
}
async function translateOcrSelectionAction(value) {
  const request = normalizeScreenshotActionRequest(value);
  if (!request || !isCurrentScreenshotRequest(request)) return;
  activeScreenshotOcrRequests.clear();
  await submitOcrSelection(request.bounds);
}
async function copyOcrSelectionImageAction(value) {
  const request = normalizeScreenshotActionRequest(value);
  if (!request || !isCurrentScreenshotRequest(request)) return;
  try {
    const png = cropCurrentOcrSelectionPngFast(request.bounds);
    electron.clipboard.writeImage(electron.nativeImage.createFromBuffer(png));
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: "copy-image",
      ok: true
    });
    showScreenshotToast(t("toast.copiedToClipboard"), 1500);
    finishScreenshotSession();
  } catch (error2) {
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: "copy-image",
      ok: false,
      code: error2 instanceof ScreenshotSelectionError || error2 instanceof ScreenCaptureError ? resolveScreenshotActionErrorCode(error2) : "clipboard-write-failed",
      error: error2 instanceof Error ? error2.message : t("error.copyImageFailed")
    });
  } finally {
    activeScreenshotOcrRequests.delete(request.requestId);
  }
}
function buildScreenshotSaveFileName() {
  const now = /* @__PURE__ */ new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${t("screenshot.defaultFileNamePrefix")}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
}
async function saveOcrSelectionImageAction(value) {
  const request = normalizeScreenshotActionRequest(value);
  if (!request || !isCurrentScreenshotRequest(request)) return;
  try {
    const win2 = ocrSelectionWin && !ocrSelectionWin.isDestroyed() ? ocrSelectionWin : void 0;
    const result = win2 ? await electron.dialog.showSaveDialog(win2, {
      defaultPath: buildScreenshotSaveFileName(),
      filters: [{ name: t("screenshot.pngFilter"), extensions: ["png"] }]
    }) : await electron.dialog.showSaveDialog({
      defaultPath: buildScreenshotSaveFileName(),
      filters: [{ name: t("screenshot.pngFilter"), extensions: ["png"] }]
    });
    if (result.canceled || !result.filePath) {
      sendScreenshotActionResult({
        requestId: request.requestId,
        sessionId: request.sessionId,
        action: "save-image",
        ok: true,
        canceled: true
      });
      return;
    }
    if (!isScreenshotOcrRequestActive(request.requestId, request.sessionId)) return;
    const png = cropCurrentOcrSelectionPngFast(request.bounds);
    await promises.writeFile(result.filePath, png);
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: "save-image",
      ok: true,
      filePath: result.filePath
    });
    showScreenshotToast(t("toast.savedToDisk"), 1500);
    finishScreenshotSession();
  } catch (error2) {
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: "save-image",
      ok: false,
      code: error2 instanceof ScreenshotSelectionError || error2 instanceof ScreenCaptureError ? resolveScreenshotActionErrorCode(error2) : "save-failed",
      error: error2 instanceof Error ? error2.message : t("error.saveImageFailed")
    });
  } finally {
    activeScreenshotOcrRequests.delete(request.requestId);
  }
}
async function copyAnnotatedOcrSelectionImageAction(value) {
  const validated = validateAnnotatedExportPayload(value);
  if (!validated.ok) {
    sendScreenshotActionResult({
      requestId: typeof value?.requestId === "string" ? value.requestId : "",
      action: "copy-image",
      ok: false,
      code: "invalid-export-payload",
      error: validated.error
    });
    return;
  }
  const request = validated.request;
  if (!isCurrentScreenshotRequest(request)) return;
  try {
    electron.clipboard.writeImage(electron.nativeImage.createFromBuffer(request.png));
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: "copy-image",
      ok: true
    });
    showScreenshotToast(t("toast.copiedToClipboard"), 1500);
    finishScreenshotSession();
  } catch (error2) {
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: "copy-image",
      ok: false,
      code: "clipboard-write-failed",
      error: error2 instanceof Error ? error2.message : t("error.copyImageFailed")
    });
  } finally {
    activeScreenshotOcrRequests.delete(request.requestId);
  }
}
async function saveAnnotatedOcrSelectionImageAction(value) {
  const validated = validateAnnotatedExportPayload(value);
  if (!validated.ok) {
    sendScreenshotActionResult({
      requestId: typeof value?.requestId === "string" ? value.requestId : "",
      action: "save-image",
      ok: false,
      code: "invalid-export-payload",
      error: validated.error
    });
    return;
  }
  const request = validated.request;
  if (!isCurrentScreenshotRequest(request)) return;
  try {
    const win2 = ocrSelectionWin && !ocrSelectionWin.isDestroyed() ? ocrSelectionWin : void 0;
    const result = win2 ? await electron.dialog.showSaveDialog(win2, {
      defaultPath: buildScreenshotSaveFileName(),
      filters: [{ name: t("screenshot.pngFilter"), extensions: ["png"] }]
    }) : await electron.dialog.showSaveDialog({
      defaultPath: buildScreenshotSaveFileName(),
      filters: [{ name: t("screenshot.pngFilter"), extensions: ["png"] }]
    });
    if (result.canceled || !result.filePath) {
      sendScreenshotActionResult({
        requestId: request.requestId,
        sessionId: request.sessionId,
        action: "save-image",
        ok: true,
        canceled: true
      });
      return;
    }
    if (!isScreenshotOcrRequestActive(request.requestId, request.sessionId)) return;
    await promises.writeFile(result.filePath, request.png);
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: "save-image",
      ok: true,
      filePath: result.filePath
    });
    showScreenshotToast(t("toast.savedToDisk"), 1500);
    finishScreenshotSession();
  } catch (error2) {
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: "save-image",
      ok: false,
      code: "save-failed",
      error: error2 instanceof Error ? error2.message : t("error.saveImageFailed")
    });
  } finally {
    activeScreenshotOcrRequests.delete(request.requestId);
  }
}
async function submitOcrSelection(value) {
  const bounds = normalizeOcrSelectionBounds(value);
  const restoreSelectionListener = () => {
    restoreSelectionListenerAfterOcr();
  };
  if (!bounds) {
    latestOcrSnapshot = null;
    ocrSessionResultCache.clear();
    hideOcrSelectionWindow();
    restoreSelectionListener();
    return;
  }
  const settings = getSettings();
  const requestId = ++latestTranslationRequest;
  const anchor = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
  const closeVersion2 = getPopupCloseVersion();
  const sessionId = ocrSelectionSessionSeq;
  const cached = ocrSessionResultCache.get(
    buildOcrSessionResultKey(sessionId, bounds, settings)
  );
  const showLoadingPopup = (original = t("selection.loadingRecognizing")) => {
    showPopup({
      ok: true,
      origin: "ocr",
      requestId,
      loading: true,
      original,
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    }, 0, anchor);
  };
  if (isMac) showLoadingPopup(cached ? t("selection.loadingTranslating") : void 0);
  hideOcrSelectionWindow();
  try {
    if (cached) {
      ocrSessionResultCache.clear();
      latestOcrSnapshot = null;
      restoreSelectionListener();
      if (!isMac) showLoadingPopup(t("selection.loadingTranslating"));
      const cachedResult = await translateRecognizedOcrResult(cached, settings);
      if (requestId !== latestTranslationRequest || closeVersion2 !== getPopupCloseVersion()) return;
      showOcrTranslationResult(cachedResult, settings, requestId, anchor);
      return;
    }
    const imageBytes = await cropOcrSnapshotSelection(bounds);
    restoreSelectionListener();
    if (!isMac) showLoadingPopup();
    const result = await processOcrImageBytes(imageBytes, settings);
    if (requestId !== latestTranslationRequest || closeVersion2 !== getPopupCloseVersion()) return;
    showOcrTranslationResult(result, settings, requestId, anchor);
  } catch (error2) {
    latestOcrSnapshot = null;
    ocrSessionResultCache.clear();
    restoreSelectionListener();
    if (requestId !== latestTranslationRequest || closeVersion2 !== getPopupCloseVersion()) return;
    const code = resolveOcrErrorCode(error2);
    const message = error2 instanceof Error ? error2.message : t("error.ocrFailed");
    showPopup({
      ok: false,
      origin: "ocr",
      requestId,
      original: "",
      error: message,
      ocrCode: code,
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    }, code === "permission" ? 8e3 : 5e3, anchor);
    if (code === "permission") {
      void electron.shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    }
  }
}
async function translateClipboardImage() {
  await rememberFrontmostAppIfInactiveAsync();
  const settings = getSettings();
  const anchor = electron.screen.getCursorScreenPoint();
  const requestId = ++latestTranslationRequest;
  const closeVersion2 = getPopupCloseVersion();
  const clipboardImage = readClipboardImage(electron.clipboard);
  if (clipboardImage.kind !== "image" || !clipboardImage.png) {
    showPopup({
      ok: false,
      origin: "ocr",
      requestId,
      original: "",
      error: t("error.noClipboardImage"),
      ocrCode: "no-clipboard-image",
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    }, 5e3, anchor);
    return;
  }
  showPopup({
    ok: true,
    origin: "ocr",
    requestId,
    loading: true,
    original: t("selection.loadingClipboardImage"),
    sourcePreference: settings.sourceLang,
    targetPreference: settings.targetLang,
    targetLang: settings.targetLang
  }, 0, anchor);
  try {
    const result = await processOcrImageBytes(clipboardImage.png, settings);
    if (requestId !== latestTranslationRequest || closeVersion2 !== getPopupCloseVersion()) return;
    showOcrTranslationResult(result, settings, requestId, anchor);
  } catch (error2) {
    if (requestId !== latestTranslationRequest || closeVersion2 !== getPopupCloseVersion()) return;
    const code = resolveOcrErrorCode(error2);
    const message = error2 instanceof Error ? error2.message : t("error.ocrFailed");
    showPopup({
      ok: false,
      origin: "ocr",
      requestId,
      original: "",
      error: message,
      ocrCode: code,
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    }, 5e3, anchor);
  }
}
async function translateManualRequest(request) {
  const raw = request && typeof request === "object" ? request : {};
  const text = raw.text;
  const validationError = validateManualTranslationText(text, mainI18n?.translator);
  const settings = getSettings();
  const sourceLang = typeof raw.sourceLang === "string" && raw.sourceLang ? raw.sourceLang : settings.sourceLang;
  const targetLang = typeof raw.targetLang === "string" && raw.targetLang ? raw.targetLang : settings.targetLang;
  if (validationError) {
    const requestId = ++latestTranslationRequest;
    showPopup({
      ok: false,
      origin: "manual",
      requestId,
      original: typeof text === "string" ? text : "",
      sourcePreference: sourceLang,
      targetPreference: targetLang,
      targetLang,
      error: validationError
    }, 0);
    return;
  }
  await translateText(text, void 0, { sourceLang, targetLang }, "manual");
}
function applySelectionListener() {
  latestSelectionGesture += 1;
  lowerSettingsPanelRaiseLevel();
  invalidateSelectionFlowWithFocusCleanup();
  selectionCapture.invalidate();
  hideSelectionButton();
  selectionListenerController.setMode(getSettings().triggerMode);
  if (getSettings().triggerMode !== "hotkey" && !selectionListenerController.isRunning()) {
    console.warn("[autoTrigger] 划词监听未能启动，划词与双击将不可用，快捷键仍可使用");
  }
}
async function warnIfNoAccessibility() {
  if (getSettings().triggerMode !== "auto") return;
  const ok = await checkAccessibilityPermission();
  if (!ok) {
    const settings = getSettings();
    showPopup(
      {
        ok: false,
        error: t("error.accessibilityPermissionAuto"),
        sourcePreference: settings.sourceLang,
        targetPreference: settings.targetLang,
        targetLang: settings.targetLang
      },
      1e4
    );
    openAccessibilitySettings();
  }
}
function openAccessibilitySettings() {
  void electron.shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
}
function restartMacHiServices() {
  return new Promise((resolve) => {
    node_child_process.execFile("pkill", ["-9", "-f", "com.apple.hiservices-xpcservice"], (error2) => {
      if (error2 && error2.code !== 1) {
        resolve({ ok: false, error: error2.message });
        return;
      }
      setTimeout(() => {
        selectionListenerController.restart();
        resolve({ ok: true });
      }, 500);
    });
  });
}
let hiServicesRepairRunning = false;
async function autoRepairMacHiServices() {
  if (hiServicesRepairRunning || process.platform !== "darwin") return;
  hiServicesRepairRunning = true;
  resetCopyTimeoutTracker();
  try {
    console.warn("[main] 连续取词超时，自动重启 macOS hiservices 服务");
    const repairResult = await restartMacHiServices();
    if (repairResult.ok) {
      console.log("[main] macOS hiservices 自动修复完成");
    } else {
      console.error("[main] macOS hiservices 自动修复失败:", repairResult.error);
    }
  } finally {
    resetCopyTimeoutTracker();
    suppressSelectionActivationWindowGap();
    hiServicesRepairRunning = false;
  }
}
async function repairMacHiServicesManually() {
  await autoRepairMacHiServices();
}
function whenWindowReadyToShow(win2) {
  if (win2.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!win2.isDestroyed()) {
        win2.removeListener("ready-to-show", finish);
        win2.removeListener("closed", finish);
        win2.webContents.removeListener("did-fail-load", finish);
      }
      resolve();
    };
    win2.once("ready-to-show", finish);
    win2.once("closed", finish);
    win2.webContents.once("did-fail-load", finish);
    timer = setTimeout(finish, 2e3);
  });
}
function showOwnWindowForInteraction(win2, options = {}) {
  if (win2.isDestroyed()) return;
  const focus = options.focus ?? true;
  const restore = options.restore ?? true;
  const moveTop = options.moveTop ?? true;
  const raiseLevel = options.raiseLevel ?? false;
  if (restore && win2.isMinimized()) win2.restore();
  if (isMac && raiseLevel) {
    win2.setAlwaysOnTop(true, "screen-saver");
    raisedInteractionWindows.add(win2);
    scheduleSettingsPanelRaiseLevelReset();
  }
  win2.show();
  if (isMac && moveTop) win2.moveTop();
  if (focus) win2.focus();
}
const raisedInteractionWindows = /* @__PURE__ */ new Set();
function logSettingsPanelBringToFront(phase) {
  if (!isMac || !settingsWin || settingsWin.isDestroyed()) return;
  console.log(
    "[main] 设置页置前阶段:",
    phase,
    JSON.stringify({
      isVisible: settingsWin.isVisible(),
      isFocused: settingsWin.isFocused(),
      isMinimized: settingsWin.isMinimized(),
      isAlwaysOnTop: settingsWin.isAlwaysOnTop(),
      bounds: settingsWin.getBounds(),
      appActive: isMacAppActiveByEvents()
    })
  );
}
let settingsPanelRaiseLevelTimer = null;
function lowerSettingsPanelRaiseLevel() {
  if (!isMac) return;
  if (settingsPanelRaiseLevelTimer) {
    clearTimeout(settingsPanelRaiseLevelTimer);
    settingsPanelRaiseLevelTimer = null;
  }
  for (const win2 of raisedInteractionWindows) {
    if (win2.isDestroyed()) {
      raisedInteractionWindows.delete(win2);
      continue;
    }
    if (win2.isAlwaysOnTop()) win2.setAlwaysOnTop(false);
  }
  raisedInteractionWindows.clear();
}
function scheduleSettingsPanelRaiseLevelReset() {
  if (!isMac) return;
  if (settingsPanelRaiseLevelTimer) clearTimeout(settingsPanelRaiseLevelTimer);
  settingsPanelRaiseLevelTimer = setTimeout(() => {
    settingsPanelRaiseLevelTimer = null;
    for (const win2 of raisedInteractionWindows) {
      if (!win2.isDestroyed()) win2.setAlwaysOnTop(false);
    }
    raisedInteractionWindows.clear();
  }, SETTINGS_PANEL_RAISE_LEVEL_TIMEOUT_MS);
}
async function createSettingsWindow(bringToFront, source) {
  const explicitPopupSource = source === "popup";
  const bringToFrontEpochAtStart = settingsBringToFrontEpoch;
  if (settingsWin && !settingsWin.isDestroyed()) {
    const existingWindow = settingsWin;
    await refreshMacOSDockVisibility();
    if (settingsWin !== existingWindow || existingWindow.isDestroyed()) return existingWindow;
    if (settingsWin.isMinimized()) {
      if (bringToFront && !explicitPopupSource && (bringToFrontEpochAtStart !== settingsBringToFrontEpoch || isSelectionWindowRaiseGuardActive())) {
        return settingsWin;
      }
      showOwnWindowForInteraction(settingsWin, { raiseLevel: bringToFront });
      return settingsWin;
    }
    if (settingsWin.isVisible()) {
      if (!bringToFront) return settingsWin;
      if (!explicitPopupSource && (bringToFrontEpochAtStart !== settingsBringToFrontEpoch || isSelectionWindowRaiseGuardActive())) {
        return settingsWin;
      }
      logCandidateProbe("settings-reuse-raise", settingsWin.isVisible());
      showOwnWindowForInteraction(settingsWin, { raiseLevel: explicitPopupSource });
      return settingsWin;
    }
    if (bringToFront && !explicitPopupSource && (bringToFrontEpochAtStart !== settingsBringToFrontEpoch || isSelectionWindowRaiseGuardActive())) {
      return settingsWin;
    }
    showOwnWindowForInteraction(settingsWin, { raiseLevel: bringToFront });
    return settingsWin;
  }
  const createdWindow = new electron.BrowserWindow({
    width: 900,
    height: 820,
    minWidth: 640,
    minHeight: 600,
    title: t("settings.windowTitle"),
    frame: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    show: false,
    backgroundColor: "#f5f7fa",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin = createdWindow;
  const readyToShow = whenWindowReadyToShow(createdWindow);
  if (process.platform === "win32") settingsWin.removeMenu();
  loadRendererHtml(settingsWin, "settings.html");
  settingsWin.on("focus", () => {
    beginPopupSettingsOpenGuard();
    const settingsBounds = settingsWin && !settingsWin.isDestroyed() ? settingsWin.getBounds() : void 0;
    resetAutoTriggerPointerState(settingsBounds);
  });
  settingsWin.on("blur", () => {
    if (isMac && !createdWindow.isDestroyed()) {
      lowerSettingsPanelRaiseLevel();
    }
    endPopupSettingsOpenGuard();
    const settingsBounds = settingsWin && !settingsWin.isDestroyed() ? settingsWin.getBounds() : void 0;
    resetAutoTriggerPointerState(settingsBounds);
  });
  settingsWin.on("hide", () => {
    endPopupSettingsOpenGuard();
    const settingsBounds = settingsWin && !settingsWin.isDestroyed() ? settingsWin.getBounds() : void 0;
    resetAutoTriggerPointerState(settingsBounds);
  });
  settingsWin.on("closed", () => {
    lowerSettingsPanelRaiseLevel();
    endPopupSettingsOpenGuard();
    resetAutoTriggerPointerState();
    if (settingsWin === createdWindow) {
      settingsWin = null;
    }
    void refreshMacOSDockVisibility();
  });
  await readyToShow;
  if (settingsWin !== createdWindow || createdWindow.isDestroyed()) return createdWindow;
  if (!explicitPopupSource && (bringToFrontEpochAtStart !== settingsBringToFrontEpoch || isSelectionWindowRaiseGuardActive() || selectionInteraction.snapshot().state !== "idle")) {
    showOwnWindowForInteraction(settingsWin, { focus: false, moveTop: false, raiseLevel: false });
    await refreshMacOSDockVisibility();
    return createdWindow;
  }
  showOwnWindowForInteraction(settingsWin, {
    focus: bringToFront,
    moveTop: bringToFront,
    raiseLevel: bringToFront
  });
  await refreshMacOSDockVisibility();
  if (settingsWin !== createdWindow || createdWindow.isDestroyed()) return createdWindow;
  if (bringToFront) {
    await yieldToEventLoop();
    if (settingsWin !== createdWindow || createdWindow.isDestroyed()) return createdWindow;
    if (!explicitPopupSource && (bringToFrontEpochAtStart !== settingsBringToFrontEpoch || isSelectionWindowRaiseGuardActive())) {
      return createdWindow;
    }
    showOwnWindowForInteraction(settingsWin, { raiseLevel: true });
    logSettingsPanelBringToFront("initial-launch-final");
  }
  return settingsWin;
}
async function openSettings(options = {}) {
  await createSettingsWindow(options.bringToFront ?? true, options.source);
}
function openSettingsFromPopup() {
  if (!isPopupPinned()) hidePopupForInternalWindowSwitch();
  beginPopupSettingsOpenGuard();
  void openSettings({ bringToFront: true, source: "popup" }).catch((error2) => {
    endPopupSettingsOpenGuard();
    console.error("[settings] 打开设置窗口失败:", error2);
  });
}
function openWebReaderFromPopup(url) {
  if (!isPopupPinned()) hidePopupForInternalWindowSwitch();
  beginPopupSettingsOpenGuard();
  void getWebReader().open(url, { bringToFront: true }).catch((error2) => {
    endPopupSettingsOpenGuard();
    const message = error2 instanceof Error ? error2.message : t("error.openWebReader");
    electron.dialog.showErrorBox(t("error.webTranslation"), message);
  });
}
function openWebReaderFromShortcut() {
  const reader = getWebReader();
  if (reader.focusOrOpenExistingWindow()) return;
  void reader.open().catch((error2) => {
    const message = error2 instanceof Error ? error2.message : t("error.openWebReader");
    electron.dialog.showErrorBox(t("error.webTranslation"), message);
  });
}
function checkDeepLx() {
  if (!deepLxCheckService) throw new Error(t("app.serviceNotInitialized.deepLxCheck"));
  return deepLxCheckService.check(getSettings().deepLxUrl);
}
function applyDeepLxConfig(patch) {
  return getDeepLxConfiguration().applyPatch(patch);
}
function buildDockerCommand(port) {
  const normalizedPort = Number.isInteger(port) && port > 0 ? port : 1189;
  return [
    "docker run -d \\",
    "  --name deeplx \\",
    "  --restart unless-stopped \\",
    `  -p ${normalizedPort}:1188 \\`,
    "  -e TOKEN=" + t("deepLx.dockerPlaceholder") + " \\",
    `  ${DOCKER_IMAGE}`
  ].join("\n");
}
function openDeployDoc() {
  const docPath = node_path.join(__dirname, "../../docs/deeplx-selfhost.md");
  void electron.shell.openPath(docPath).then((errorMessage) => {
    if (errorMessage) {
      void electron.shell.openExternal("https://github.com/OwO-Network/DeepLX");
    }
  });
}
async function checkForApplicationUpdates() {
  return getUpdateManager().checkForUpdates();
}
async function downloadApplicationUpdate() {
  return getUpdateManager().downloadUpdate();
}
async function cancelApplicationUpdateDownload() {
  return getUpdateManager().cancelDownload();
}
function installApplicationUpdate() {
  getUpdateManager().installUpdate();
}
async function openApplicationReleasePage() {
  await getUpdateManager().openReleasePage();
}
async function removeApplicationQuarantine() {
  if (!isMac) return removeMacOSApplicationQuarantine();
  const result = await electron.dialog.showMessageBox({
    type: "warning",
    title: t("dialog.quarantine.title"),
    message: t("dialog.quarantine.message"),
    detail: t("dialog.quarantine.detail"),
    buttons: [t("common.cancel"), t("dialog.quarantine.confirm")],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (result.response !== 1) {
    return { ok: false, message: t("dialog.quarantine.cancelled") };
  }
  return removeMacOSApplicationQuarantine();
}
function applyDingTalkConfig(patch) {
  return getDingTalkConfiguration().applyPatch(patch);
}
function clearDingTalkSecret() {
  return getDingTalkConfiguration().clearSecret();
}
function checkDingTalk() {
  const configuration = getDingTalkConfiguration();
  if (configuration.getCredentialError()) {
    return Promise.resolve({
      ok: false,
      code: "storage-unavailable",
      message: t("error.dingTalkCredentialsUnavailable")
    });
  }
  return checkDingTalk$1(configuration.getCredentialsSnapshot(false));
}
function checkMicrosoft() {
  return checkMicrosoft$1();
}
function applyAiConfig(patch) {
  return getAiConfiguration().applyPatch(patch);
}
function clearAiApiKey() {
  return getAiConfiguration().clearApiKey();
}
async function listAiModels() {
  if (!aiModelDiscovery) throw new Error(t("app.serviceNotInitialized.aiModelDiscovery"));
  const settings = getSettings();
  return aiModelDiscovery.listModels({
    protocol: settings.aiProtocol,
    baseUrl: settings.aiBaseUrl,
    apiKey: getAiConfiguration().getApiKey()
  });
}
function checkAi() {
  if (!aiCheckService) throw new Error(t("app.serviceNotInitialized.aiCheck"));
  return aiCheckService.check({
    settings: getSettings(),
    apiKey: getAiConfiguration().getApiKey()
  });
}
function broadcast(channel, payload) {
  for (const window2 of electron.BrowserWindow.getAllWindows()) {
    window2.webContents.send(channel, payload);
  }
}
function isWebViewBounds(value) {
  if (!value || typeof value !== "object") return false;
  const bounds = value;
  return ["x", "y", "width", "height"].every((key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]));
}
function isWebTranslationRunRequest(value) {
  if (value === void 0 || value === null) return true;
  if (typeof value !== "object") return false;
  const request = value;
  const validScope = request.scope === void 0 || request.scope === "body" || request.scope === "all";
  const validSource = request.sourceLang === void 0 || typeof request.sourceLang === "string";
  const validTarget = request.targetLang === void 0 || typeof request.targetLang === "string";
  return validScope && validSource && validTarget;
}
function isWebTranslationMode(value) {
  return value === "source" || value === "target" || value === "bilingual";
}
async function applySettingsPatch(patch) {
  if (patch.hotkey !== void 0 && isCopyShortcut(String(patch.hotkey))) {
    throw new Error(t("error.copyShortcutAsTranslationHotkey"));
  }
  if (patch.ocrHotkey !== void 0 && isCopyShortcut(String(patch.ocrHotkey))) {
    throw new Error(t("error.copyShortcutAsOcrHotkey"));
  }
  const previous = getSettings();
  const shortcutPatch = {};
  for (const id of ["hotkey", "ocrHotkey", "manualTranslationHotkey", "webReaderHotkey"]) {
    if (patch[id] !== void 0) shortcutPatch[id] = String(patch[id]).trim();
  }
  const shortcutCandidate = { ...previous, ...shortcutPatch };
  for (const id of Object.keys(shortcutPatch)) {
    const conflict = findShortcutConflict(id, shortcutCandidate[id], shortcutCandidate);
    if (conflict?.kind === "copy") {
      throw new Error(t("error.shortcutConflictCopy"));
    }
    if (conflict?.kind === "duplicate") {
      throw new Error(t("error.shortcutConflictDuplicate"));
    }
  }
  const safePatch = { ...patch };
  delete safePatch.deepLxUrl;
  delete safePatch.dingTalkEnabled;
  delete safePatch.dingTalkCorpId;
  delete safePatch.dingTalkClientId;
  delete safePatch.dingTalkSecretConfigured;
  delete safePatch.aiApiKey;
  delete safePatch.aiApiKeyConfigured;
  const aiFieldChanged = patch.aiEnabled !== void 0 && patch.aiEnabled !== previous.aiEnabled || patch.aiProtocol !== void 0 && patch.aiProtocol !== previous.aiProtocol || patch.aiBaseUrl !== void 0 && patch.aiBaseUrl !== previous.aiBaseUrl || patch.aiModel !== void 0 && patch.aiModel !== previous.aiModel;
  const settings = saveSettings(safePatch);
  if (patch.hotkey !== void 0 && settings.hotkey !== previous.hotkey || patch.ocrHotkey !== void 0 && settings.ocrHotkey !== previous.ocrHotkey || patch.manualTranslationHotkey !== void 0 && settings.manualTranslationHotkey !== previous.manualTranslationHotkey || patch.webReaderHotkey !== void 0 && settings.webReaderHotkey !== previous.webReaderHotkey) {
    registerGlobalShortcuts(settings);
  }
  if (patch.triggerMode !== void 0 && settings.triggerMode !== previous.triggerMode) {
    applySelectionListener();
    if (settings.triggerMode === "auto") void warnIfNoAccessibility();
  }
  if (patch.showDockIcon !== void 0 && settings.showDockIcon !== previous.showDockIcon) {
    await applyMacOSDockVisibility(settings.showDockIcon);
  }
  if (patch.autoLaunch !== void 0 && settings.autoLaunch !== previous.autoLaunch) {
    applyAutoLaunch(settings.autoLaunch);
  }
  if (patch.proxyMode !== void 0 || patch.proxyRules !== void 0 || patch.proxyBypassRules !== void 0) {
    await applyTranslationProxy(settings);
    await webReader?.applyProxy(settings);
  }
  if (patch.microsoftEnabled !== void 0 && settings.microsoftEnabled !== previous.microsoftEnabled) {
    resetMicrosoftTranslationRuntime();
  }
  if (patch.ocrEnginePreference !== void 0 && settings.ocrEnginePreference !== previous.ocrEnginePreference) {
    delete ocrEnginePreferenceState.preferredEngine;
  }
  if (aiFieldChanged) {
    resetAiTranslationRuntime();
    aiModelDiscovery?.clearCache();
  }
  mainI18n?.refresh();
  refreshLocalizedApplicationChrome();
  broadcast("settings:changed", settings);
  return settings;
}
function registerIpc() {
  registerWindowControls({
    isAllowedWindow: (window2) => window2 === settingsWin || Boolean(webReader?.ownsWindow(window2)),
    closeWindow: (window2) => {
      if (webReader?.ownsWindow(window2)) {
        webReader.close();
        return;
      }
      window2.close();
    }
  });
  electron.ipcMain.on("popup:copy", (_event, text) => {
    electron.clipboard.writeText(String(text ?? ""));
  });
  electron.ipcMain.on("popup:hide", () => hidePopup(true, "renderer-ipc"));
  electron.ipcMain.on("popup:resize", (_event, size) => {
    if (isPopupAutoSizeRequest(size)) resizePopup(size);
  });
  electron.ipcMain.on("popup:set-pinned", (_event, pinned2) => {
    setPopupPinned(Boolean(pinned2));
  });
  electron.ipcMain.on("settings:open", () => openSettingsFromPopup());
  electron.ipcMain.on("webview:open", (_event, url) => {
    openWebReaderFromPopup(typeof url === "string" && url.trim() ? url : void 0);
  });
  electron.ipcMain.on("webview:close", () => getWebReader().close());
  electron.ipcMain.handle("webview:navigate", (_event, url) => {
    if (typeof url !== "string" || !url.trim()) throw new Error(t("error.invalidWebUrl"));
    return getWebReader().navigate(url);
  });
  electron.ipcMain.on("webview:back", () => getWebReader().back());
  electron.ipcMain.on("webview:forward", () => getWebReader().forward());
  electron.ipcMain.on("webview:reload", () => getWebReader().reload());
  electron.ipcMain.on("webview:set-bounds", (_event, bounds) => {
    if (isWebViewBounds(bounds)) getWebReader().setBounds(bounds);
  });
  electron.ipcMain.handle("web-translate:extract", () => getWebReader().extract());
  electron.ipcMain.handle(
    "web-translate:run",
    (_event, request) => getWebReader().run(isWebTranslationRunRequest(request) ? request : {})
  );
  electron.ipcMain.on("web-translate:cancel", () => getWebReader().cancel());
  electron.ipcMain.handle("web-translate:set-mode", (_event, mode) => {
    if (!isWebTranslationMode(mode)) throw new Error(t("error.invalidWebMode"));
    return getWebReader().setMode(mode);
  });
  electron.ipcMain.on("settings:stop-service", () => stopApplicationService());
  electron.ipcMain.on("selection:translate", () => {
    void translateSelectionButton();
  });
  electron.ipcMain.on("ocr-selection:open", () => {
    void openOcrSelection();
  });
  electron.ipcMain.on("ocr-selection:ready", (_event, payload) => {
    const sessionId = payload?.sessionId;
    if (typeof sessionId !== "number" || sessionId !== ocrSelectionSessionSeq) return;
    resolveOcrSelectionReady(true);
  });
  electron.ipcMain.on("ocr-selection:cancel", () => cancelOcrSelection());
  electron.ipcMain.on("ocr-selection:submit", (_event, bounds) => {
    void submitOcrSelection(bounds);
  });
  electron.ipcMain.on("ocr-selection:recognize", (_event, request) => {
    const normalized = normalizeScreenshotActionRequest(request);
    if (normalized && normalized.sessionId === ocrSelectionSessionSeq) activeScreenshotOcrRequests.set(normalized.requestId, normalized.sessionId);
    void recognizeOcrSelectionAction(request);
  });
  electron.ipcMain.on("ocr-selection:translate", (_event, request) => {
    void translateOcrSelectionAction(request);
  });
  electron.ipcMain.on("ocr-selection:copy-image", (_event, request) => {
    const normalized = normalizeScreenshotActionRequest(request);
    if (normalized && normalized.sessionId === ocrSelectionSessionSeq) activeScreenshotOcrRequests.set(normalized.requestId, normalized.sessionId);
    void copyOcrSelectionImageAction(request);
  });
  electron.ipcMain.on("ocr-selection:save-image", (_event, request) => {
    const normalized = normalizeScreenshotActionRequest(request);
    if (normalized && normalized.sessionId === ocrSelectionSessionSeq) activeScreenshotOcrRequests.set(normalized.requestId, normalized.sessionId);
    void saveOcrSelectionImageAction(request);
  });
  electron.ipcMain.on("ocr-selection:copy-annotated-image", (_event, request) => {
    const validated = validateAnnotatedExportPayload(request);
    if (validated.ok && validated.request.sessionId === ocrSelectionSessionSeq) activeScreenshotOcrRequests.set(validated.request.requestId, validated.request.sessionId);
    void copyAnnotatedOcrSelectionImageAction(request);
  });
  electron.ipcMain.on("ocr-selection:save-annotated-image", (_event, request) => {
    const validated = validateAnnotatedExportPayload(request);
    if (validated.ok && validated.request.sessionId === ocrSelectionSessionSeq) activeScreenshotOcrRequests.set(validated.request.requestId, validated.request.sessionId);
    void saveAnnotatedOcrSelectionImageAction(request);
  });
  electron.ipcMain.handle("ocr-selection:export-image", (_event, request) => {
    const normalized = normalizeScreenshotExportImageRequest(request);
    if (!normalized || normalized.sessionId !== ocrSelectionSessionSeq) {
      throw new ScreenshotSelectionError("snapshot-expired", t("error.screenshotExpired"));
    }
    const png = cropCurrentOcrSelectionPng(normalized.bounds);
    return { dataUrl: `data:image/png;base64,${png.toString("base64")}` };
  });
  electron.ipcMain.on("screenshot-toast:show", (_event, payload) => {
    const raw = payload;
    if (typeof raw?.message === "string" && raw.message.trim()) {
      showScreenshotToast(raw.message, raw.displayTimeMs, raw.kind);
    }
  });
  electron.ipcMain.on("screenshot-toast:show-window", (_event, payload) => {
    handleScreenshotToastShowWindow(payload);
  });
  electron.ipcMain.on("ocr-clipboard:translate", () => {
    void translateClipboardImage();
  });
  electron.ipcMain.on("manual-translate:open-request", () => void openManualTranslation());
  electron.ipcMain.handle(
    "manual-translate:submit",
    (_event, request) => translateManualRequest(request)
  );
  electron.ipcMain.on("speech:edge-cancel", (_event, requestId) => {
    cancelEdgeSpeech(String(requestId ?? ""));
  });
  electron.ipcMain.handle(
    "speech:edge-synthesize",
    (_event, requestId, text, language) => synthesizeEdgeSpeech(String(requestId ?? ""), String(text ?? ""), String(language ?? ""))
  );
  electron.ipcMain.handle("popup:retranslate", async (_event, sourceLang, targetLang, origin) => {
    const sourcePreference = sourceLang || "auto";
    const targetPreference = targetLang || "auto";
    await applySettingsPatch({ sourceLang: sourcePreference, targetLang: targetPreference });
    const text = origin === "ocr" ? lastOcrText : lastSelectedText;
    const anchor = origin === "ocr" ? lastOcrAnchor : lastSelectionAnchor;
    if (!text) return;
    await translateText(text, anchor, {
      sourceLang: sourcePreference,
      targetLang: targetPreference
    }, origin === "ocr" ? "ocr" : "selection");
  });
  electron.ipcMain.handle("settings:get", () => getSettings());
  electron.ipcMain.handle("shortcuts:get-registration", () => shortcutRegistrationStates);
  electron.ipcMain.handle("logs:get-history", () => appLogger.getHistory());
  electron.ipcMain.handle("logs:export", async () => {
    const source = appLogger.getLogFilePath();
    const { canceled, filePath: filePath2 } = await electron.dialog.showSaveDialog({
      title: t("dialog.exportLogs.title"),
      defaultPath: `main-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.log`
    });
    if (canceled || !filePath2) return null;
    await promises.copyFile(source, filePath2);
    return filePath2;
  });
  electron.ipcMain.handle("capture-diagnostics:get-summary", () => {
    const data = getCaptureDiagnosticsStore().getSummary();
    const days = {};
    for (const [date, bucket] of Object.entries(data.days)) {
      days[date] = bucket.summary;
    }
    return { days };
  });
  electron.ipcMain.handle("capture-diagnostics:export", async () => {
    const data = getCaptureDiagnosticsStore().getExportData();
    const { canceled, filePath: filePath2 } = await electron.dialog.showSaveDialog({
      title: t("dialog.exportDiagnostics.title"),
      defaultPath: `capture-diagnostics-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (canceled || !filePath2) return null;
    await promises.writeFile(filePath2, JSON.stringify(data, null, 2), "utf-8");
    return filePath2;
  });
  electron.ipcMain.handle("settings:set", (_event, patch) => applySettingsPatch(patch));
  electron.ipcMain.handle(
    "dingtalk:configure",
    (_event, patch) => applyDingTalkConfig(patch)
  );
  electron.ipcMain.handle("dingtalk:clear-secret", () => clearDingTalkSecret());
  electron.ipcMain.handle("dingtalk:check", () => checkDingTalk());
  electron.ipcMain.handle("microsoft:check", () => checkMicrosoft());
  electron.ipcMain.handle("ai:configure", (_event, patch) => applyAiConfig(patch));
  electron.ipcMain.handle("ai:clear-key", () => clearAiApiKey());
  electron.ipcMain.handle("ai:list-models", () => listAiModels());
  electron.ipcMain.handle("ai:check", () => checkAi());
  electron.ipcMain.handle("ocr:get-status", () => getOcrStatus());
  electron.ipcMain.handle(
    "deeplx:configure",
    (_event, patch) => applyDeepLxConfig(patch)
  );
  electron.ipcMain.handle("deeplx:check", () => checkDeepLx());
  electron.ipcMain.handle("deeplx:docker-command", (_event, port) => buildDockerCommand(port));
  electron.ipcMain.on("deeplx:open-doc", () => openDeployDoc());
  electron.ipcMain.handle("updater:get-status", () => getUpdateManager().getStatus());
  electron.ipcMain.handle("updater:check", () => checkForApplicationUpdates());
  electron.ipcMain.handle("updater:download", () => downloadApplicationUpdate());
  electron.ipcMain.handle("updater:cancel-download", () => cancelApplicationUpdateDownload());
  electron.ipcMain.on("updater:install", () => installApplicationUpdate());
  electron.ipcMain.handle("updater:open-release", () => openApplicationReleasePage());
  electron.ipcMain.handle("updater:remove-quarantine", () => removeApplicationQuarantine());
}
function stopApplicationService() {
  electron.app.quit();
}
function loadTrayIcon() {
  const filename = isMac ? "trayTemplate.png" : "tray.png";
  const icon = electron.nativeImage.createFromPath(node_path.join(electron.app.getAppPath(), "build", filename));
  if (icon.isEmpty()) {
    throw new Error(t("error.trayIconLoadFailed", { message: filename }));
  }
  if (isMac) icon.setTemplateImage(true);
  return icon;
}
function createTray() {
  tray = new electron.Tray(loadTrayIcon());
  tray.setToolTip(t("app.name"));
  if (isMac) {
    tray.on("right-click", () => tray?.popUpContextMenu(buildTrayMenu()));
  } else {
    tray?.setContextMenu(buildTrayMenu());
  }
  tray.on("click", () => void openSettings());
  tray.on("double-click", () => void openSettings());
}
function buildTrayMenu() {
  const settings = getSettings();
  const t2 = mainI18n?.translator ?? {
    t: (key) => key
  };
  const targetOptions = [{ code: "auto", label: t2.t("menu.autoBilingual") }, ...LANGUAGES];
  const targetSubmenu = targetOptions.map((language) => ({
    label: language.label,
    type: "radio",
    checked: settings.targetLang.toLowerCase() === language.code.toLowerCase(),
    click: () => void applySettingsPatch({ targetLang: language.code })
  }));
  const sourceOptions = [{ code: "auto", label: t2.t("settings.sourceLang.auto") }, ...LANGUAGES];
  const sourceSubmenu = sourceOptions.map((language) => ({
    label: language.label,
    type: "radio",
    checked: settings.sourceLang.toLowerCase() === language.code.toLowerCase(),
    click: () => void applySettingsPatch({ sourceLang: language.code })
  }));
  return electron.Menu.buildFromTemplate([
    { label: `${t2.t("app.name")}   ${settings.hotkey}`, enabled: false },
    { type: "separator" },
    { label: t2.t("menu.manualTranslation"), click: () => void openManualTranslation() },
    { label: t2.t("menu.openWebTranslation"), enabled: settings.webTranslationEnabled, click: () => {
      void getWebReader().open().catch((error2) => {
        const message = error2 instanceof Error ? error2.message : t2.t("error.openWebReader");
        electron.dialog.showErrorBox(t2.t("error.webTranslation"), message);
      });
    } },
    { label: t2.t("menu.screenshotOcr"), click: () => openOcrSelection() },
    { label: t2.t("menu.clipboardImageOcr"), click: () => void translateClipboardImage() },
    { type: "separator" },
    {
      label: t2.t("menu.showSelectionButton"),
      type: "checkbox",
      checked: settings.triggerMode === "button",
      click: (menuItem) => void applySettingsPatch({ triggerMode: menuItem.checked ? "button" : "hotkey" })
    },
    ...isMac ? [{
      label: t2.t("menu.repairMacSelectionService"),
      click: () => void repairMacHiServicesManually()
    }] : [],
    { type: "separator" },
    { label: t2.t("menu.targetLanguage"), submenu: targetSubmenu },
    { label: t2.t("menu.sourceLanguage"), submenu: sourceSubmenu },
    { type: "separator" },
    { label: t2.t("menu.settings"), click: () => void openSettings() },
    { label: t2.t("menu.quit"), click: () => stopApplicationService() }
  ]);
}
function refreshLocalizedApplicationChrome() {
  const title = t("app.name");
  tray?.setToolTip(title);
  refreshTrayMenu();
  const settingsTitle = t("settings.windowTitle");
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setTitle(settingsTitle);
}
function refreshTrayMenu() {
  if (!isMac) tray?.setContextMenu(buildTrayMenu());
}
function cleanupBeforeQuit() {
  webReader?.dispose();
  webReader = null;
  selectionInteraction.invalidate();
  selectionListenerController.stop();
  electron.globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
}
electron.app.on("before-quit", cleanupBeforeQuit);
