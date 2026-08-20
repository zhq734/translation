"use strict";
const electron = require("electron");
const node_path = require("node:path");
const node_fs = require("node:fs");
const node_child_process = require("node:child_process");
const node_util = require("node:util");
const undici = require("undici");
const node_crypto = require("node:crypto");
const uiohookNapi = require("uiohook-napi");
const electronUpdater = require("electron-updater");
const promises = require("node:fs/promises");
const MANUAL_TRANSLATION_MAX_CHARS = 5e3;
const DEFAULT_AI_BASE_URL = "http://127.0.0.1:11434";
function isAiProtocol(value) {
  return value === "ollama" || value === "openai" || value === "claude-code";
}
const TRANSLATION_PROVIDERS = [
  { id: "ai", label: "AI 翻译" },
  { id: "dingtalk", label: "钉钉翻译" },
  { id: "microsoft", label: "微软翻译" },
  { id: "deeplx-self", label: "自建 DeepLX" },
  { id: "deeplx-public", label: "公共 DeepLX" },
  { id: "google", label: "Google 翻译" },
  { id: "mymemory", label: "MyMemory 翻译" }
];
function isTranslationProviderPreference(value) {
  return value === "auto" || TRANSLATION_PROVIDERS.some((provider) => provider.id === value);
}
const SETTINGS_SCHEMA_VERSION = 11;
const DEFAULT_SETTINGS = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  targetLang: "auto",
  sourceLang: "auto",
  hotkey: "Alt+T",
  autoHideMs: 0,
  deepLxUrl: "",
  triggerMode: "button",
  showDockIcon: false,
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
  speechProvider: "system"
};
function isTriggerMode(value) {
  return value === "auto" || value === "button" || value === "hotkey";
}
function isProxyMode(value) {
  return value === "system" || value === "direct" || value === "custom";
}
function isSpeechProvider(value) {
  return value === "system" || value === "edge";
}
function normalizeAiBaseUrl$1(baseUrl) {
  return baseUrl.replace(/\/+$/u, "");
}
function normalizeSettings(rawSettings = {}) {
  const schemaVersion = Number(rawSettings.schemaVersion ?? 1);
  const merged = { ...DEFAULT_SETTINGS, ...rawSettings };
  let triggerMode = isTriggerMode(rawSettings.triggerMode) ? rawSettings.triggerMode : rawSettings.autoTrigger ? "auto" : "button";
  if (schemaVersion < 4) triggerMode = "button";
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    targetLang: schemaVersion < 2 ? "auto" : String(merged.targetLang || "auto"),
    sourceLang: String(merged.sourceLang || "auto"),
    hotkey: String(merged.hotkey || ""),
    autoHideMs: schemaVersion < 2 ? 0 : Math.max(0, Number(merged.autoHideMs) || 0),
    deepLxUrl: String(merged.deepLxUrl || "").trim(),
    triggerMode,
    showDockIcon: rawSettings.showDockIcon === true,
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
    speechProvider: isSpeechProvider(rawSettings.speechProvider) ? rawSettings.speechProvider : "system"
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
        } catch (error) {
          console.error("[settings] 迁移后的配置保存失败:", error.message);
        }
      }
    } else {
      cache = { ...DEFAULT_SETTINGS };
    }
  } catch (error) {
    console.error("[settings] 读取配置失败，使用默认值:", error.message);
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
const SYNTHETIC_COPY_OBSERVATION_TIMEOUT_MS = 120;
function hasClipboardCaptureCompleted(currentText, hasImage, sentinel) {
  return hasImage || Boolean(currentText && currentText !== sentinel);
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
function resolveSelectionCaptureFailureMessage(reason, hasImage = false) {
  if (hasImage) return "已识别到图片选区，暂不支持图片翻译";
  switch (reason) {
    case "timeout":
      return "取词超时，请重试或确认所选内容可复制";
    case "unsupported":
      return "当前应用不支持划词取词，请确认所选内容可复制";
    case "permission":
      return "需要「辅助功能」权限才能读取选中文字，请授权后重试";
    case "empty":
    default:
      return "未检测到选中文字，请重新划词后点击“译”按钮";
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
    clicks: Math.max(1, clicks),
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
const execFileP = node_util.promisify(node_child_process.execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIPBOARD_STABILITY_DELAY_MS = 120;
const SELECTION_INSPECTION_TIMEOUT_MS = 1500;
const NATIVE_SELECTION_RETRY_COUNT = 2;
const NATIVE_SELECTION_RETRY_DELAY_MS = 40;
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
const WINDOWS_COPY = [
  `$signature = '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);';`,
  "Add-Type -MemberDefinition $signature -Name NativeKeyboard -Namespace SelectionTranslator;",
  "[SelectionTranslator.NativeKeyboard]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero);",
  "[SelectionTranslator.NativeKeyboard]::keybd_event(0x43, 0, 0, [UIntPtr]::Zero);",
  "[SelectionTranslator.NativeKeyboard]::keybd_event(0x43, 0, 2, [UIntPtr]::Zero);",
  "[SelectionTranslator.NativeKeyboard]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero);"
].join(" ");
class PermissionError extends Error {
}
async function readSelectionByNative(signal) {
  try {
    if (signal?.aborted) return { status: "unknown", text: "", reason: "unknown" };
    if (process.platform === "linux") {
      const text = electron.clipboard.readText("selection");
      return text.trim() ? { status: "present", text } : { status: "empty", text: "" };
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileP(
        "osascript",
        ["-e", MACOS_SELECTION_PRESENCE],
        { timeout: SELECTION_INSPECTION_TIMEOUT_MS, signal }
      );
      return parseNativeSelectionReadOutput(stdout);
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileP("powershell.exe", [
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
async function readSelectionByNativeWithRetry(signal) {
  let result = await readSelectionByNative(signal);
  for (let attempt = 1; attempt < NATIVE_SELECTION_RETRY_COUNT; attempt += 1) {
    if (signal?.aborted || result.status === "present" && result.text.trim()) return result;
    await sleep(NATIVE_SELECTION_RETRY_DELAY_MS);
    if (signal?.aborted) return result;
    result = await readSelectionByNative(signal);
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
const JXA_COPY = [
  "ObjC.import('CoreGraphics');",
  "var s=$.CGEventSourceCreate($.kCGEventSourceStateCombinedSessionState);",
  "var commandWasDown=$.CGEventSourceKeyState($.kCGEventSourceStateHIDSystemState,55)||$.CGEventSourceKeyState($.kCGEventSourceStateHIDSystemState,54);",
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
async function simulateCopy() {
  const strategy = resolveSelectionCaptureStrategy(process.platform);
  if (strategy === "linux-primary-selection") return;
  if (strategy === "unsupported") throw new Error(`暂不支持当前平台：${process.platform}`);
  try {
    if (strategy === "macos-command-copy") {
      await execFileP("osascript", ["-l", "JavaScript", "-e", JXA_COPY]);
    } else {
      await execFileP("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        WINDOWS_COPY
      ]);
    }
  } catch (e) {
    const err = e;
    const msg = String(err?.stderr ?? err?.message ?? err);
    if (/assistive|not allowed|-25211|-1719|1002/i.test(msg)) {
      throw new PermissionError("需要「辅助功能」权限才能模拟复制");
    }
    throw new Error(`模拟复制失败: ${msg}`);
  }
}
async function captureByCopy(signal, timeoutMs = 800) {
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
    return text2.trim() ? { text: text2 } : { text: "", reason: "empty" };
  }
  signal?.addEventListener("abort", handleAbort, { once: true });
  const sentinel = `__SELECTION_TRANSLATOR_SENTINEL_${Date.now()}__`;
  electron.clipboard.clear();
  electron.clipboard.writeText(sentinel);
  let text = "";
  let hasImage = false;
  try {
    const expectation = copyShortcutGuard.expectSyntheticCopyShortcut();
    try {
      await simulateCopy();
    } finally {
      await expectation.finish();
    }
    const start = Date.now();
    while (!signal?.aborted && Date.now() - start < timeoutMs) {
      text = electron.clipboard.readText();
      hasImage = !electron.clipboard.readImage().isEmpty();
      if (hasClipboardCaptureCompleted(text, hasImage, sentinel)) break;
      await sleep(40);
    }
  } finally {
    try {
      if (!signal?.aborted) {
        await sleep(CLIPBOARD_STABILITY_DELAY_MS);
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
  if (signal?.aborted) return { text: "" };
  if (hasImage) return { text: "", hasImage: true };
  if (!text || text === sentinel) return { text: "", reason: "timeout" };
  return { text };
}
async function captureSelectionByNativeOnly(signal) {
  if (signal?.aborted) return { text: "" };
  const native = await readSelectionByNativeWithRetry(signal);
  if (native.status === "present" && native.text.trim()) {
    return { text: native.text };
  }
  return {
    text: "",
    reason: native.status === "empty" ? "empty" : "unsupported"
  };
}
async function captureSelection(signal, timeoutMs = 800) {
  if (signal?.aborted) return { text: "" };
  const plan = getSelectionCapturePlan(process.platform);
  if (plan.supportsNativeRead) {
    const native = await readSelectionByNative(signal);
    if (native.status === "present" && native.text.trim()) {
      return { text: native.text };
    }
    if (plan.copyFallback) {
      return captureByCopy(signal, timeoutMs);
    }
    return {
      text: "",
      reason: native.status === "empty" ? "empty" : "unsupported"
    };
  }
  if (plan.copyFallback) {
    return captureByCopy(signal, timeoutMs);
  }
  return { text: "", reason: "unsupported" };
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
    return new DingTalkError("authentication", "钉钉鉴权失败", {
      authenticationInvalid: AUTHENTICATION_CODES.has(errorCode ?? -1)
    });
  }
  if (status === 403 || PERMISSION_CODES.has(errorCode ?? -1)) {
    return new DingTalkError("permission", "钉钉应用权限不足");
  }
  if (status === 429 || RATE_LIMIT_CODES.has(errorCode ?? -1)) {
    return new DingTalkError("rate-limit", "钉钉接口请求过于频繁");
  }
  if (status === 400 || PARAMETER_CODES.has(errorCode ?? -1)) {
    return new DingTalkError("parameter", "钉钉请求参数无效");
  }
  return new DingTalkError("service", "钉钉服务暂时不可用");
}
function normalizeDingTalkNetworkError(error) {
  if (error instanceof DingTalkError) return error;
  const name = error instanceof Error ? error.name : "";
  const timeout = name === "AbortError" || name === "TimeoutError";
  return new DingTalkError("network", timeout ? "钉钉请求超时" : "钉钉网络连接失败", {
    cause: error
  });
}
function toDingTalkCheckStatus(error) {
  const normalized = error instanceof DingTalkError ? error : normalizeDingTalkNetworkError(error);
  switch (normalized.kind) {
    case "configuration":
      return { ok: false, code: "incomplete", message: "钉钉配置不完整，请填写 CorpId、ClientId 和 ClientSecret" };
    case "authentication":
      return { ok: false, code: "authentication", message: "钉钉鉴权失败，请检查 CorpId、ClientId 和 ClientSecret" };
    case "permission":
      return { ok: false, code: "permission", message: "钉钉应用未获得文本翻译权限" };
    case "rate-limit":
      return { ok: false, code: "rate-limit", message: "钉钉接口请求过于频繁，请稍后重试" };
    case "parameter":
      return { ok: false, code: "parameter", message: "钉钉翻译请求参数不受支持" };
    case "network":
      return { ok: false, code: "network", message: normalized.message };
    default:
      return { ok: false, code: "service", message: "钉钉服务暂时不可用，请稍后重试" };
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
          throw new DingTalkError("service", "钉钉 Token 响应格式无效");
        }
        if (generation === this.generation && key === this.credentialKey) {
          this.cachedToken = token;
          this.expiresAt = this.now() + expiresIn * 1e3;
        }
        return token;
      });
    } catch (error) {
      throw normalizeDingTalkNetworkError(error);
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
    } catch (error) {
      throw new DingTalkError("service", "钉钉 Token 响应无法解析", { cause: error });
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
      } catch (error) {
        const normalized = normalizeDingTalkNetworkError(error);
        if (attempt === 0 && normalized.authenticationInvalid) {
          this.options.tokenManager.reset();
          continue;
        }
        throw normalized;
      }
    }
    throw new DingTalkError("authentication", "钉钉鉴权失败");
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
      if (!translation) throw new DingTalkError("service", "钉钉翻译响应为空");
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
    } catch (error) {
      throw new DingTalkError("service", "钉钉翻译响应无法解析", { cause: error });
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
    return new MicrosoftError("authentication", "微软翻译网页会话已失效");
  }
  if (status === 429) return new MicrosoftError("rate-limit", "微软翻译接口请求过于频繁");
  if (status === 400) return new MicrosoftError("parameter", "微软翻译请求参数无效");
  return new MicrosoftError("service", "微软翻译服务暂时不可用");
}
function normalizeMicrosoftNetworkError(error) {
  if (error instanceof MicrosoftError) return error;
  const name = error instanceof Error ? error.name : "";
  const timeout = name === "AbortError" || name === "TimeoutError";
  return new MicrosoftError("network", timeout ? "微软翻译请求超时" : "微软翻译网络连接失败", {
    cause: error
  });
}
function toMicrosoftCheckStatus(error) {
  const normalized = error instanceof MicrosoftError ? error : normalizeMicrosoftNetworkError(error);
  switch (normalized.kind) {
    case "authentication":
      return { ok: false, code: "authentication", message: "微软翻译网页会话获取失败，请稍后重试" };
    case "rate-limit":
      return { ok: false, code: "rate-limit", message: "微软翻译接口请求过于频繁，请稍后重试" };
    case "parameter":
      return { ok: false, code: "parameter", message: "微软翻译请求参数不受支持" };
    case "network":
      return { ok: false, code: "network", message: normalized.message };
    default:
      return { ok: false, code: "service", message: "微软翻译服务暂时不可用，请稍后重试" };
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
    } catch (error) {
      const normalized = normalizeMicrosoftNetworkError(error);
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
    if (chunks.length === 0) throw new MicrosoftError("parameter", "微软翻译文本不能为空");
    const results = await Promise.all(chunks.map((chunk) => this.requestTranslation(chunk, pair)));
    const translation = results.map((result) => result.translation).join("");
    if (!translation) throw new MicrosoftError("service", "微软翻译响应为空");
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
    } catch (error) {
      throw new MicrosoftError("service", "微软翻译网页响应无法读取", { cause: error });
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
      throw new MicrosoftError("service", "微软翻译网页重定向地址无效");
    }
    const hostname = parsed.hostname.toLowerCase();
    const trustedHost = hostname === "bing.com" || hostname.endsWith(".bing.com");
    if (parsed.protocol !== "https:" || !trustedHost) {
      throw new MicrosoftError("service", "微软翻译网页重定向地址无效");
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
      throw new MicrosoftError("service", "微软翻译网页鉴权参数无法解析");
    }
    const ttlMs = Number(prevention[3]);
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new MicrosoftError("service", "微软翻译网页鉴权有效期无效");
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
    } catch (error) {
      throw new MicrosoftError("service", "微软翻译响应无法解析", { cause: error });
    }
    const item = Array.isArray(payload) ? payload[0] : void 0;
    const translation = typeof item?.translations?.[0]?.text === "string" ? item.translations[0].text : "";
    if (!translation) throw new MicrosoftError("service", "微软翻译响应为空");
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
  if (status === 401 || status === 403) return new AiError("authentication", "AI 鉴权失败，请检查 API Key");
  if (status === 429) return new AiError("rate-limit", "AI 接口请求限流，请稍后重试");
  if (status === 404) return new AiError("not-found", "AI 模型不存在或路径错误");
  if (status >= 500) return new AiError("service", "AI 服务暂时不可用");
  return new AiError("service", `AI 服务返回错误（HTTP ${status}）`);
}
function normalizeAiNetworkError(error) {
  if (error instanceof AiError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return new AiError("timeout", "AI 请求超时", { cause: error });
  }
  return new AiError("network", "AI 网络连接失败", { cause: error });
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
    "，只输出译文，保留换行和基本格式，不要输出解释、Markdown 代码块或额外引号。"
  ].join("");
}
function buildAiTranslationRequest(input) {
  const baseUrl = normalizeAiBaseUrl(input.baseUrl);
  const systemPrompt = buildTranslationSystemPrompt(input.sourceLang, input.targetLang);
  const headers = /* @__PURE__ */ new Map([["Content-Type", "application/json"]]);
  switch (input.protocol) {
    case "ollama": {
      const body = JSON.stringify({
        model: input.model,
        stream: false,
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
        stream: false,
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
    let built;
    try {
      built = buildAiTranslationRequest({
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: input.apiKey,
        text: input.text,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang
      });
    } catch (error) {
      throw new AiError("service", "AI 请求构造失败", { cause: error });
    }
    const headers = {};
    built.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortPromise = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new AiError("timeout", "AI 请求超时"));
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
    } catch (error) {
      clearTimeout(timer);
      throw normalizeAiNetworkError(error);
    }
    clearTimeout(timer);
    if (!response.ok) {
      throw createAiResponseError(response.status);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      throw new AiError("service", "AI 服务返回非 JSON 响应");
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new AiError("service", "AI 服务响应解析失败", { cause: error });
    }
    const translation = extractAiTranslation(input.protocol, data);
    if (!translation) {
      throw new AiError("service", "AI 返回译文为空");
    }
    return translation;
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
const PUBLIC_DEEPLX = "https://api.deeplx.org/mRZmM06yhhNJw55Vx87G2CuVvw0FYNtaOAkzo5UQVYI/translate";
const GOOGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";
const DINGTALK_CHANNEL = "钉钉翻译";
const MICROSOFT_CHANNEL = "微软翻译";
const AI_CHANNEL = "AI 翻译";
const MAX_CHARS = 5e3;
const GOOGLE_MAX_CHARS = 2e3;
const MYMEMORY_MAX_CHARS = 500;
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
  cache = /* @__PURE__ */ new Map();
  breaker = /* @__PURE__ */ new Map();
  now;
  dingTalkClient;
  microsoftClient;
  aiClient;
  /**
   * 按用户首选 API、默认顺序执行翻译并自动降级。
   * @param text 待翻译文本。
   * @param settings 当前公开设置快照。
   * @param dingTalkCredentials 主进程解密后的钉钉凭证快照。
   * @returns 首个成功通道的统一翻译结果。
   * @author zhenghq
   */
  async translate(text, settings, dingTalkCredentials = null, aiApiKey = null) {
    const input = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
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
    if (hit) return { ...hit, channel: "缓存" };
    const channels = this.createChannels(input, settings, dingTalkCredentials, aiApiKey);
    let lastError = "所有翻译通道均失败";
    for (const channel of channels) {
      if (this.isTripped(channel.name)) {
        console.warn(`[translate] 跳过 ${channel.name}（熔断中）`);
        continue;
      }
      try {
        const output = await channel.run();
        this.resetBreaker(channel.name);
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
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知错误";
        lastError = `${channel.name}: ${message}`;
        this.trip(channel.name, channel.cooldownMs);
        console.warn(`[translate] ${lastError}`);
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
      return toDingTalkCheckStatus(new DingTalkError("configuration", "钉钉配置不完整"));
    }
    try {
      await this.dingTalkClient.translate("你好", {
        supported: true,
        sourceLanguage: "zh",
        targetLanguage: "en"
      }, credentials);
      return { ok: true, code: "available", message: "钉钉翻译在线且可用" };
    } catch (error) {
      return toDingTalkCheckStatus(error);
    }
  }
  /**
   * 不经过普通翻译结果缓存检测免订阅微软文本翻译链路。
   * @returns 设置页可展示的结构化脱敏状态。
   * @author zhenghq
   */
  async checkMicrosoft() {
    try {
      await this.microsoftClient.translate("你好", {
        supported: true,
        sourceLanguage: "zh-Hans",
        targetLanguage: "en"
      });
      return { ok: true, code: "available", message: "微软翻译在线且可用" };
    } catch (error) {
      return toMicrosoftCheckStatus(error);
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
   * 根据配置和语言对构建本次翻译通道列表。
   * @param text 已截断的待翻译文本。
   * @param settings 当前公开设置。
   * @param dingTalkCredentials 当前主进程钉钉凭证快照。
   * @returns 按优先级排列的翻译通道。
   * @author zhenghq
   */
  createChannels(text, settings, dingTalkCredentials, aiApiKey) {
    const channels = [];
    if (settings.aiEnabled && settings.aiBaseUrl.trim() && settings.aiModel.trim()) {
      channels.push({
        id: "ai",
        name: AI_CHANNEL,
        cooldownMs: 6e4,
        run: () => this.aiChannel(text, settings, aiApiKey)
      });
    }
    if (settings.dingTalkEnabled && settings.dingTalkCorpId && settings.dingTalkClientId && settings.dingTalkSecretConfigured && dingTalkCredentials) {
      const pair = resolveDingTalkLanguagePair(text, settings.sourceLang, settings.targetLang);
      if (pair.supported) {
        channels.push({
          id: "dingtalk",
          name: DINGTALK_CHANNEL,
          cooldownMs: 6e4,
          run: () => this.dingTalkClient.translate(text, pair, dingTalkCredentials)
        });
      }
    }
    if (settings.microsoftEnabled) {
      const pair = resolveMicrosoftLanguagePair(settings.sourceLang, settings.targetLang);
      if (pair.supported) {
        channels.push({
          id: "microsoft",
          name: MICROSOFT_CHANNEL,
          cooldownMs: 6e4,
          run: () => this.microsoftClient.translate(text, pair)
        });
      }
    }
    const selfHost = settings.deepLxUrl.trim();
    if (selfHost) {
      channels.push({
        id: "deeplx-self",
        name: "自建 DeepLX",
        cooldownMs: 15e3,
        run: () => this.deepLxChannel(selfHost, text, settings, 2500)
      });
    }
    channels.push({
      id: "deeplx-public",
      name: "公共 DeepLX",
      cooldownMs: 12e4,
      run: () => this.deepLxChannel(PUBLIC_DEEPLX, text, settings, 3e3)
    });
    channels.push({
      id: "google",
      name: "Google",
      cooldownMs: 6e4,
      run: () => this.googleChannel(text, settings)
    });
    channels.push({
      id: "mymemory",
      name: "MyMemory",
      cooldownMs: 6e4,
      run: () => this.myMemoryChannel(text, settings)
    });
    const preferred = settings.preferredTranslationProvider;
    if (preferred === "auto") return channels;
    const preferredIndex = channels.findIndex((channel) => channel.id === preferred);
    if (preferredIndex <= 0) return channels;
    const [preferredChannel] = channels.splice(preferredIndex, 1);
    channels.unshift(preferredChannel);
    return channels;
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
    throw new Error(json.code === 429 ? "限流 (429)" : json.message || `HTTP ${response.status}`);
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
    const query = text.length > GOOGLE_MAX_CHARS ? text.slice(0, GOOGLE_MAX_CHARS) : text;
    const url = `${GOOGLE_ENDPOINT}?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(query)}`;
    const response = await this.fetchWithTimeout(url, { method: "GET" }, 3500);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) throw new Error("被拦截（非 JSON 响应）");
    const data = await response.json();
    const segments = Array.isArray(data?.[0]) ? data[0] : [];
    const translation = segments.map((segment) => segment?.[0] ? String(segment[0]) : "").join("").trim();
    if (!translation) throw new Error("返回为空");
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
    const query = text.length > MYMEMORY_MAX_CHARS ? text.slice(0, MYMEMORY_MAX_CHARS) : text;
    const url = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(query)}&langpair=${encodeURIComponent(
      `${source}|${target}`
    )}&mt=1`;
    const response = await this.fetchWithTimeout(url, { method: "GET" }, 6e3);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.quotaFinished) throw new Error("免费额度已用完");
    const translation = data.responseData?.translatedText?.trim();
    if (!translation) throw new Error(data.responseDetails || "无结果");
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
let translationSession = null;
function getTranslationSession() {
  if (!translationSession) {
    translationSession = electron.session.fromPartition("translation-network");
  }
  return translationSession;
}
async function applyTranslationProxy(settings) {
  const currentSession = getTranslationSession();
  await currentSession.setProxy(buildProxyConfig(settings));
  await currentSession.closeAllConnections();
  console.log("[network] 代理模式已应用:", settings.proxyMode);
}
function translationFetch(input, init) {
  return getTranslationSession().fetch(input, init);
}
async function createTranslationWebSocket(url, headers) {
  const proxyResult = await getTranslationSession().resolveProxy(url.replace(/^wss:/u, "https:"));
  const proxyUrl = edgeSpeechProxyUrl(proxyResult);
  if (proxyUrl === void 0) throw new Error("当前代理类型不支持 Edge 在线语音");
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
    if (!text.trim()) return { ok: false, error: "朗读文本为空" };
    if (signal?.aborted) return { ok: false, error: "Edge 语音请求已取消" };
    const currentDate = now();
    let socket;
    try {
      const socketResult = socketFactory(
        buildEdgeSocketUrl(currentDate, connectionId()),
        buildEdgeSocketHeaders(muid())
      );
      socket = socketResult instanceof Promise ? await socketResult : socketResult;
    } catch {
      return { ok: false, error: "Edge 语音服务连接失败" };
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
        resolve(result);
      };
      const abort = () => finish({ ok: false, error: "Edge 语音请求已取消" });
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish({ ok: false, error: "Edge 语音请求超时" }), timeoutMs);
      socket.onopen = () => {
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
            finish(audio2.length > 0 ? { ok: true, audio: audio2, mimeType: "audio/mpeg" } : { ok: false, error: "Edge 语音服务未返回音频" });
          }
          return;
        }
        const audio = parseAudioFrame(event.data);
        if (audio && audio.length > 0) chunks.push(audio);
      };
      socket.onerror = () => finish({ ok: false, error: "Edge 语音服务连接失败" });
      socket.onclose = () => {
        if (!settled) finish(chunks.length > 0 ? { ok: true, audio: concatBytes(chunks), mimeType: "audio/mpeg" } : { ok: false, error: "Edge 语音服务连接已关闭" });
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
function shouldDismissPopupOnBlur(pinned2) {
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
const WINDOW_EDGE_GAP = 8;
const CURSOR_GAP = 16;
let win$1 = null;
let hideTimer = null;
let closeVersion = 0;
let pinned = false;
let currentAutoHideMs = 0;
function createPopup(preloadPath) {
  win$1 = new electron.BrowserWindow({
    width: 460,
    height: 360,
    minWidth: 360,
    minHeight: 260,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Edge 音频需要先等待网络合成，播放调用会晚于用户点击，不能依赖已失效的手势授权。
      autoplayPolicy: "no-user-gesture-required"
    }
  });
  win$1.setAlwaysOnTop(true, "floating");
  win$1.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    win$1.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win$1.loadFile(node_path.join(__dirname, "../renderer/index.html"));
  }
  win$1.on("blur", handlePopupBlur);
  win$1.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return win$1;
}
function handlePopupBlur() {
  if (!win$1?.isVisible()) return;
  const cursorInsideDragRegion = isPointInPopupDragRegion(
    electron.screen.getCursorScreenPoint(),
    win$1.getBounds()
  );
  if (!cursorInsideDragRegion && shouldDismissPopupOnBlur(pinned)) hidePopup();
}
function positionNearAnchor(anchor) {
  if (!win$1) return;
  const point = anchor ?? electron.screen.getCursorScreenPoint();
  const display = electron.screen.getDisplayNearestPoint(point);
  const workArea = display.workArea;
  const [width, height] = win$1.getSize();
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
  win$1.setPosition(Math.round(x), Math.round(y));
}
function showPopup(payload, autoHideMs, anchor) {
  if (!win$1) return;
  currentAutoHideMs = Math.max(0, autoHideMs);
  const alreadyVisible = win$1.isVisible();
  win$1.webContents.send("translate:result", payload);
  win$1.webContents.send("popup:pinned", pinned);
  if (!alreadyVisible) {
    positionNearAnchor(anchor);
    win$1.show();
  }
  scheduleHide(autoHideMs);
}
function showManualTranslationPopup() {
  if (!win$1) return;
  currentAutoHideMs = 0;
  clearHide();
  const alreadyVisible = win$1.isVisible();
  if (!alreadyVisible) {
    positionNearAnchor();
    win$1.show();
  } else {
    win$1.focus();
  }
  win$1.webContents.send("popup:pinned", pinned);
  if (win$1.webContents.isLoadingMainFrame()) {
    win$1.webContents.once("did-finish-load", () => {
      win$1?.webContents.send("manual-translate:open");
    });
  } else {
    win$1.webContents.send("manual-translate:open");
  }
}
function hidePopup() {
  clearHide();
  closeVersion += 1;
  pinned = false;
  win$1?.webContents.send("popup:pinned", false);
  win$1?.hide();
}
function setPopupPinned(value) {
  pinned = value;
  if (pinned) {
    clearHide();
  } else if (win$1?.isVisible()) {
    scheduleHide(currentAutoHideMs);
  }
  win$1?.webContents.send("popup:pinned", pinned);
}
function isPopupVisible() {
  return Boolean(win$1?.isVisible());
}
function getPopupCloseVersion() {
  return closeVersion;
}
function isPointInsidePopup(point) {
  if (!win$1?.isVisible()) return false;
  const bounds = win$1.getBounds();
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}
function scheduleHide(milliseconds) {
  clearHide();
  if (!pinned && milliseconds > 0) hideTimer = setTimeout(hidePopup, milliseconds);
}
function clearHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}
const BUTTON_SIZE = 36;
const EDGE_GAP = 8;
let win = null;
let rendererReady = false;
let pendingAnchor = null;
function showReadySelectionButton(anchor) {
  if (!win || !rendererReady) return;
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
  pendingAnchor = null;
  win.setPosition(Math.round(x), Math.round(y));
  win.showInactive();
  win.setAlwaysOnTop(true, "pop-up-menu");
  win.moveTop();
}
function createSelectionButton(preloadPath) {
  rendererReady = false;
  pendingAnchor = null;
  win = new electron.BrowserWindow({
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
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(true, "pop-up-menu");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.once("did-finish-load", () => {
    rendererReady = true;
    if (pendingAnchor) showReadySelectionButton(pendingAnchor);
  });
  win.on("closed", () => {
    win = null;
    rendererReady = false;
    pendingAnchor = null;
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/selection.html`);
  } else {
    win.loadFile(node_path.join(__dirname, "../renderer/selection.html"));
  }
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return win;
}
function showSelectionButton(anchor) {
  if (!win) return;
  pendingAnchor = anchor;
  showReadySelectionButton(anchor);
}
function hideSelectionButton() {
  pendingAnchor = null;
  win?.hide();
}
function isSelectionButtonVisible() {
  return Boolean(win?.isVisible());
}
function isPointInsideSelectionButton(point) {
  if (!win?.isVisible()) return false;
  const bounds = win.getBounds();
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
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
function resolveMousePoint(e) {
  const point = { x: e.x, y: e.y };
  if (process.platform !== "win32") return point;
  return resolveWindowsPointerPoint(
    point,
    electron.screen.screenToDipPoint(point),
    electron.screen.getCursorScreenPoint()
  );
}
function onMouseDown(e) {
  const point = resolveMousePoint(e);
  const pointerHandled = pointerDownCallback?.(point) ?? false;
  if (pointerHandled) {
    modifiersHeld = false;
    downAt = null;
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) {
    modifiersHeld = true;
    downAt = null;
    return;
  }
  modifiersHeld = false;
  downAt = createObservedPointerSample(point, Date.now());
}
function onMouseUp(e) {
  const start = downAt;
  downAt = null;
  if (modifiersHeld || !start || !callback) {
    modifiersHeld = false;
    return;
  }
  modifiersHeld = false;
  const gesture = getSelectionGesture(
    start,
    createObservedPointerSample(resolveMousePoint(e), Date.now()),
    e.clicks ?? 1
  );
  if (!shouldTriggerSelectionGesture(gesture, e.clicks ?? 1, DEFAULTS)) return;
  console.log(
    `[autoTrigger] 检测到选区 clicks=${e.clicks ?? 1} distance=${Math.round(gesture.distance)} duration=${gesture.durationMs}ms`
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
function startAutoTrigger(cb, onPointerDown, onCopyShortcut, onPasteShortcut) {
  stopAutoTrigger();
  callback = cb;
  pointerDownCallback = onPointerDown ?? null;
  copyShortcutCallback = onCopyShortcut ?? null;
  pasteShortcutCallback = onPasteShortcut ?? null;
  uiohookNapi.uIOhook.on("mousedown", onMouseDown);
  uiohookNapi.uIOhook.on("mouseup", onMouseUp);
  uiohookNapi.uIOhook.on("keydown", onKeyDown);
  try {
    uiohookNapi.uIOhook.start();
    running = true;
    console.log("[autoTrigger] 划词监听已启动");
  } catch (e) {
    console.warn("[selection-translator] 划词监听启动失败:", e.message);
  }
}
function stopAutoTrigger() {
  uiohookNapi.uIOhook.off("mousedown", onMouseDown);
  uiohookNapi.uIOhook.off("mouseup", onMouseUp);
  uiohookNapi.uIOhook.off("keydown", onKeyDown);
  if (running) {
    try {
      uiohookNapi.uIOhook.stop();
    } catch {
    }
  }
  running = false;
  callback = null;
  pointerDownCallback = null;
  copyShortcutCallback = null;
  pasteShortcutCallback = null;
  downAt = null;
  modifiersHeld = false;
}
const LANGUAGES = [
  { code: "ZH", label: "中文" },
  { code: "EN", label: "英语" },
  { code: "JA", label: "日语" },
  { code: "KO", label: "韩语" },
  { code: "FR", label: "法语" },
  { code: "DE", label: "德语" },
  { code: "ES", label: "西班牙语" },
  { code: "PT", label: "葡萄牙语" },
  { code: "IT", label: "意大利语" },
  { code: "NL", label: "荷兰语" },
  { code: "PL", label: "波兰语" },
  { code: "RU", label: "俄语" },
  { code: "TR", label: "土耳其语" },
  { code: "ID", label: "印尼语" },
  { code: "UK", label: "乌克兰语" },
  { code: "AR", label: "阿拉伯语" },
  { code: "SV", label: "瑞典语" },
  { code: "DA", label: "丹麦语" },
  { code: "CS", label: "捷克语" },
  { code: "EL", label: "希腊语" },
  { code: "FI", label: "芬兰语" },
  { code: "HU", label: "匈牙利语" },
  { code: "RO", label: "罗马尼亚语" },
  { code: "SK", label: "斯洛伐克语" },
  { code: "BG", label: "保加利亚语" },
  { code: "LT", label: "立陶宛语" },
  { code: "LV", label: "拉脱维亚语" },
  { code: "ET", label: "爱沙尼亚语" },
  { code: "SL", label: "斯洛文尼亚语" }
];
const LIST_LINE_PATTERN = /^(?:[-*+•]\s+|\d+[.)]\s+)/u;
const BLOCK_LINE_PATTERN = /^(?:#{1,6}\s+|>\s+|```|~~~|\|)/u;
const INDENTED_CODE_PATTERN = /^(?:\t| {4,})\S/u;
const CJK_CHARACTER_PATTERN = /[\u2e80-\u9fff\uf900-\ufaff]/u;
const NO_SPACE_AFTER_PATTERN = /[(\[{“‘/\-‐‑–—]$/u;
const NO_SPACE_BEFORE_PATTERN = /^[,.;:!?，。！？；：、)\]}”’]/u;
const SENTENCE_END_PATTERN = /[.!?。！？]["'”’）)\]}]*$/u;
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
function normalizeSelectedText(text) {
  const normalizedText = String(text ?? "").replace(/\r\n?|[\u2028\u2029]/gu, "\n").replace(/\u00ad/gu, "").replace(/\u00a0/gu, " ").trim();
  if (!normalizedText.includes("\n")) return normalizedText;
  const lines = normalizedText.split("\n");
  let result = "";
  let previousRawLine = "";
  let paragraphBreakPending = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
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
      const currentKind = classifySelectedLine(rawLine);
      const preserveLineBreak = currentKind !== "prose" || previousKind === "block" || previousKind === "prose" && endsCompleteSentence(previousRawLine.trim());
      result += preserveLineBreak ? `
${line}` : `${resolveSoftLineSeparator(previousRawLine.trim(), line)}${line}`;
    }
    previousRawLine = rawLine;
    paragraphBreakPending = false;
  }
  return result;
}
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
class SelectionCaptureCoordinator {
  /**
   * 创建选中文字捕获协调器。
   * @param captureSelection 实际执行系统取词的异步函数。
   * @param prefetchSelection 按钮显示期间执行只读预取的异步函数；不注入复制键、不写剪贴板。
   * @author zhenghq
   */
  constructor(captureSelection2, prefetchSelection) {
    this.captureSelection = captureSelection2;
    this.prefetchSelection = prefetchSelection;
  }
  latestRequestId = 0;
  captureChain = Promise.resolve();
  preparedSelection = null;
  pendingPreparation = null;
  activeCaptureController = null;
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
   * @returns 排队后的取词 Promise。
   * @author zhenghq
   */
  enqueue(anchor, prepare, delayMs, usePrefetch = false) {
    const requestId = ++this.latestRequestId;
    this.abortActiveCapture();
    const task = this.captureChain.catch(() => void 0).then(async () => {
      if (requestId !== this.latestRequestId) return null;
      const controller = new AbortController();
      this.activeCaptureController = controller;
      let outcome = { text: "" };
      let error;
      try {
        await waitForCaptureDelay(delayMs, controller.signal);
        if (controller.signal.aborted || requestId !== this.latestRequestId) return null;
        const capture = usePrefetch && this.prefetchSelection ? this.prefetchSelection : this.captureSelection;
        const raw = await capture(controller.signal);
        if (typeof raw === "string") {
          outcome = { text: normalizeSelectedText(raw) };
        } else {
          outcome = {
            text: normalizeSelectedText(raw?.text ?? ""),
            reason: raw?.reason,
            hasImage: Boolean(raw?.hasImage)
          };
        }
      } catch (cause) {
        error = cause instanceof Error ? cause : new Error(String(cause));
      } finally {
        if (this.activeCaptureController === controller) {
          this.activeCaptureController = null;
        }
      }
      if (requestId !== this.latestRequestId || controller.signal.aborted) return null;
      const result = { text: outcome.text };
      if (outcome.reason) result.reason = outcome.reason;
      if (outcome.hasImage) result.hasImage = true;
      if (anchor) result.anchor = anchor;
      if (error) result.error = error;
      if (prepare) this.preparedSelection = result;
      return result;
    });
    this.captureChain = task.then(() => void 0);
    return task;
  }
}
function validateManualTranslationText(value) {
  if (typeof value !== "string") return "原文格式无效";
  if (!value.trim()) return "请输入要翻译的原文";
  if (value.length > MANUAL_TRANSLATION_MAX_CHARS) {
    return `原文不能超过${MANUAL_TRANSLATION_MAX_CHARS}个字符`;
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
      return { configured: false, secret: null, error: "当前系统无法使用安全存储，无法读取钉钉凭证" };
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
      return { configured: false, secret: null, error: "无法读取已保存的钉钉凭证，请重新配置" };
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
      throw new Error("当前系统安全存储不可用，无法保存钉钉凭证");
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
    } catch (error) {
      if (secretChanged) this.restoreSecret(previousSecret);
      throw error;
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
    } catch (error) {
      this.restoreSecret(previousSecret);
      throw error;
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
      return { configured: false, apiKey: null, error: "当前系统无法使用安全存储，无法读取 AI 凭证" };
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
      return { configured: false, apiKey: null, error: "无法读取已保存的 AI 凭证，请重新配置" };
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
      throw new Error("当前系统安全存储不可用，无法保存 AI 凭证");
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
    } catch (error) {
      if (keyChanged) this.restoreApiKey(previousApiKey);
      throw error;
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
    } catch (error) {
      this.restoreApiKey(previousApiKey);
      throw error;
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
    } catch (error) {
      clearTimeout(timer);
      return { state: "error", models: [], message: this.toUserMessage(error) };
    }
    clearTimeout(timer);
    if (!response.ok) {
      if (input.protocol === "claude-code" && response.status === 404) {
        return { state: "unsupported", models: [], message: "当前服务不支持模型列表，请手动输入模型名称" };
      }
      return { state: "error", models: [], message: this.statusMessage(response.status) };
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      if (input.protocol === "claude-code") {
        return { state: "unsupported", models: [], message: "当前服务不支持模型列表，请手动输入模型名称" };
      }
      return { state: "error", models: [], message: "模型列表响应格式不受支持" };
    }
    let data;
    try {
      data = await response.json();
    } catch {
      return { state: "error", models: [], message: "模型列表解析失败" };
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
  toUserMessage(error) {
    const normalized = normalizeAiNetworkError(error);
    return normalized.message;
  }
  /**
    * 根据 HTTP 状态码返回脱敏提示。
  * @param status HTTP 状态码。
  * @returns 脱敏提示文本。
  * @author zhenghq
    */
  statusMessage(status) {
    if (status === 401 || status === 403) return "模型列表鉴权失败，请检查 API Key";
    if (status === 429) return "模型列表请求过于频繁，请稍后重试";
    return "模型列表加载失败";
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
      return { ok: false, code: "incomplete", message: "AI 配置不完整，请填写 Base URL 和模型" };
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
        return { ok: false, code: "service", message: "AI 返回译文为空" };
      }
      return { ok: true, code: "available", message: "AI 翻译配置可用" };
    } catch (error) {
      return this.toCheckStatus(error);
    }
  }
  /**
    * 将内部 AI 错误转换为设置页可展示的结构化脱敏状态。
  * @param error AI 内部错误或未知异常。
  * @returns 不包含 API Key、鉴权 URL 和完整请求头的检测状态。
  * @author zhenghq
    */
  toCheckStatus(error) {
    if (error instanceof AiError) {
      switch (error.kind) {
        case "authentication":
          return { ok: false, code: "authentication", message: "AI 鉴权失败，请检查 API Key" };
        case "permission":
          return { ok: false, code: "permission", message: "AI 应用权限不足" };
        case "rate-limit":
          return { ok: false, code: "rate-limit", message: "AI 接口请求过于频繁，请稍后重试" };
        case "not-found":
          return { ok: false, code: "not-found", message: "AI 模型不存在或路径错误" };
        case "network":
          return { ok: false, code: "network", message: error.message };
        case "timeout":
          return { ok: false, code: "timeout", message: error.message };
        default:
          return { ok: false, code: "service", message: "AI 服务暂时不可用，请稍后重试" };
      }
    }
    return { ok: false, code: "network", message: "AI 网络连接失败" };
  }
}
function isMacOSDiskImageExecution(platform, executablePath) {
  if (platform !== "darwin") return false;
  return executablePath.replace(/\/{2,}/gu, "/").startsWith("/Volumes/");
}
function shouldOpenSettingsOnInitialLaunch(platform) {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}
function resolveHttpsUpdateFileUrl(rawUrl, baseUrl) {
  try {
    const parsedUrl = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    return parsedUrl.protocol === "https:" ? parsedUrl : void 0;
  } catch {
    return void 0;
  }
}
function resolveManualMacDmgUrl(files, architecture, baseUrl) {
  const dmgFiles = files.filter((file) => /\.dmg(?:$|[?#])/iu.test(file.url));
  const architecturePattern = architecture === "arm64" ? /(?:arm64|aarch64)/iu : /(?:x64|x86_64|amd64)/iu;
  const directDmg = dmgFiles.find((file) => architecturePattern.test(file.url));
  if (directDmg) return resolveHttpsUpdateFileUrl(directDmg.url, baseUrl)?.toString();
  const zipFiles = files.filter((file) => /\.zip(?:$|[?#])/iu.test(file.url));
  const zipFile = zipFiles.find((file) => architecturePattern.test(file.url)) ?? (dmgFiles.length === 0 ? zipFiles[0] : void 0);
  if (!zipFile) {
    const fallbackDmg = dmgFiles[0];
    return fallbackDmg ? resolveHttpsUpdateFileUrl(fallbackDmg.url, baseUrl)?.toString() : void 0;
  }
  const parsedUrl = resolveHttpsUpdateFileUrl(zipFile.url, baseUrl);
  if (!parsedUrl) return void 0;
  parsedUrl.pathname = parsedUrl.pathname.replace(/\.zip$/iu, ".dmg");
  return parsedUrl.toString();
}
function validateHttpsUrl(rawUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error("DMG 下载地址格式无效");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error("DMG 下载只支持 HTTPS 地址");
  }
  return parsedUrl;
}
function validateDmgUrl(rawUrl) {
  const parsedUrl = validateHttpsUrl(rawUrl);
  if (!parsedUrl.pathname.toLowerCase().endsWith(".dmg")) {
    throw new Error("更新下载地址必须是 DMG 文件");
  }
  return parsedUrl.toString();
}
function sanitizeFileNamePart(value) {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/gu, "_").replace(/\.{2,}/gu, "_").replace(/^\.+/u, "_");
  return sanitized || "unknown";
}
function buildDmgPath(downloadsDirectory, version, architecture) {
  const filename = `SelectionTranslator-${sanitizeFileNamePart(version)}-mac-${sanitizeFileNamePart(architecture)}.dmg`;
  return node_path.join(downloadsDirectory, node_path.basename(filename));
}
async function writeResponseToFile(response, temporaryPath, destination, onProgress) {
  const totalHeader = Number(response.headers.get("content-length") ?? 0);
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : 0;
  const startedAt = Date.now();
  let transferred = 0;
  let fileHandle;
  const reportProgress = () => {
    const elapsedSeconds = Math.max((Date.now() - startedAt) / 1e3, 1e-3);
    const bytesPerSecond = transferred / elapsedSeconds;
    const percent = total > 0 ? Math.min(100, transferred / total * 100) : transferred > 0 ? 100 : 0;
    onProgress?.({ percent, transferred, total, bytesPerSecond });
  };
  try {
    fileHandle = await promises.open(temporaryPath, "w");
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!chunk.value) continue;
        await fileHandle.write(chunk.value);
        transferred += chunk.value.byteLength;
        reportProgress();
      }
    } else {
      const content = new Uint8Array(await response.arrayBuffer());
      await fileHandle.write(content);
      transferred = content.byteLength;
      reportProgress();
    }
    await fileHandle.close();
    fileHandle = void 0;
    await promises.rename(temporaryPath, destination);
  } catch (error) {
    await fileHandle?.close().catch(() => void 0);
    await promises.rm(temporaryPath, { force: true }).catch(() => void 0);
    throw error;
  }
}
function createManualMacUpdateService(options) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const architecture = options.architecture ?? process.arch;
  return {
    /**
     * 下载指定 DMG、保存到 Downloads 并交给 Finder 打开。
     * @param url 已从更新清单获取的 DMG 下载地址。
     * @param version 更新版本号。
     * @param onProgress 下载进度回调。
     * @returns 下载文件路径的 Promise。
     * @author zhenghq
     */
    async downloadAndOpen(url, version, onProgress) {
      let currentUrl = validateDmgUrl(url);
      let response;
      for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
        response = await fetcher(currentUrl, { redirect: "manual" });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location");
        if (!location) throw new Error("DMG 下载重定向缺少目标地址");
        currentUrl = validateHttpsUrl(new URL(location, currentUrl).toString()).toString();
        if (redirectCount === 5) throw new Error("DMG 下载重定向次数过多");
      }
      if (!response || !response.ok) {
        throw new Error(`DMG 下载失败（HTTP ${response?.status ?? "未知状态"}）`);
      }
      const destination = buildDmgPath(options.downloadsDirectory, version, architecture);
      const temporaryPath = `${destination}.part`;
      await promises.mkdir(options.downloadsDirectory, { recursive: true });
      onProgress?.({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
      await writeResponseToFile(response, temporaryPath, destination, onProgress);
      const openError = await options.openPath(destination);
      if (openError) throw new Error(`无法打开已下载的 DMG：${openError}`);
      return { path: destination };
    }
  };
}
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
function formatUpdateErrorMessage(error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (isMacOSCodeSignatureValidationError(rawMessage)) {
    return "更新包签名与当前应用不兼容，已改用手动安装；请下载 DMG，拖入“应用程序”并覆盖旧版本";
  }
  const metadataMatch = rawMessage.match(/Cannot find\s+(latest(?:-[\w-]+)?\.yml)\b/iu);
  if (metadataMatch && /\b404\b/u.test(rawMessage)) {
    return `当前 GitHub Release 缺少自动更新清单 ${metadataMatch[1]}，请稍后重新检查或打开发布页手动安装`;
  }
  const firstLine = rawMessage.split(/\r?\n/u, 1)[0].replace(/\s+/gu, " ").trim();
  const conciseMessage = firstLine.length > 240 ? `${firstLine.slice(0, 239)}…` : firstLine;
  return `更新失败：${conciseMessage || "未知错误"}`;
}
class UpdateManager {
  /**
   * 创建自动更新管理器并连接底层驱动事件。
   * @param options 自动更新依赖和运行环境选项。
   * @author zhenghq
   */
  constructor(options) {
    this.options = options;
    const disabled = !options.enabled || options.installMode === "disabled";
    this.status = {
      phase: disabled ? "disabled" : "idle",
      currentVersion: options.currentVersion,
      installMode: disabled ? "disabled" : options.installMode,
      releaseUrl: options.releaseUrl,
      message: disabled ? "开发环境不会检查更新" : "尚未检查更新"
    };
    options.driver.initialize({
      checking: () => this.setStatus({ phase: "checking", message: "正在检查更新…" }),
      available: (info) => this.handleAvailable(info),
      notAvailable: (info) => this.handleNotAvailable(info),
      progress: (progress) => this.handleProgress(progress),
      downloaded: (info) => this.handleDownloaded(info),
      error: (error) => this.handleError(error)
    });
  }
  status;
  manualDownloadUrl;
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
    this.setStatus({ phase: "checking", message: "正在检查更新…", progress: void 0 });
    try {
      await this.options.driver.checkForUpdates();
    } catch (error) {
      this.handleError(error);
    }
    return this.getStatus();
  }
  /**
   * 下载新版本；手动安装模式下把 DMG 保存到 Downloads 并打开安装界面。
   * @returns 操作完成后的当前状态。
   * @author zhenghq
   */
  async downloadUpdate() {
    if (this.status.installMode === "manual") {
      return this.downloadManualMacUpdate();
    }
    if (this.status.installMode !== "automatic" || this.status.phase !== "available") {
      return this.getStatus();
    }
    this.setStatus({
      phase: "downloading",
      message: "正在下载更新…",
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }
    });
    try {
      await this.options.driver.downloadUpdate();
    } catch (error) {
      this.handleError(error);
    }
    return this.getStatus();
  }
  /**
   * 安装已下载的新版本并重新启动应用。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate() {
    if (this.status.installMode !== "automatic" || this.status.phase !== "downloaded") return;
    this.options.driver.installUpdate();
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
    this.manualDownloadUrl = info.manualDownloadUrl;
    const message = this.status.installMode === "automatic" ? `发现新版本 ${info.version}，可以下载并安装` : `发现新版本 ${info.version}，当前环境需要手动安装`;
    this.setStatus({
      phase: "available",
      latestVersion: info.version,
      message,
      progress: void 0,
      manualDownloadAvailable: this.options.manualUpdate && info.manualDownloadUrl ? true : void 0
    });
  }
  /**
   * 处理当前已经是最新版本事件。
   * @param info 当前远程版本信息。
   * @returns 无返回值。
   * @author zhenghq
   */
  handleNotAvailable(info) {
    this.manualDownloadUrl = void 0;
    this.setStatus({
      phase: "not-available",
      latestVersion: info.version || this.status.currentVersion,
      message: "当前已经是最新版本",
      progress: void 0,
      manualDownloadAvailable: void 0
    });
  }
  /**
   * 处理更新包下载进度事件。
   * @param progress 当前下载进度。
   * @returns 无返回值。
   * @author zhenghq
   */
  handleProgress(progress) {
    this.setStatus({
      phase: "downloading",
      message: `正在下载更新… ${Math.max(0, Math.min(100, progress.percent)).toFixed(1)}%`,
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
    this.setStatus({
      phase: "downloaded",
      latestVersion: info.version,
      message: `版本 ${info.version} 已下载，重启后完成升级`,
      progress: this.status.progress ? { ...this.status.progress, percent: 100 } : { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 }
    });
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
        message: "当前更新清单没有可直接下载的 DMG，已打开 GitHub Release，请手动下载安装"
      });
      return this.getStatus();
    }
    this.setStatus({
      phase: "downloading",
      message: "正在下载 macOS DMG 更新包…",
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      manualDownloadPath: void 0
    });
    try {
      const result = await this.options.manualUpdate.downloadAndOpen(
        this.manualDownloadUrl,
        version,
        (progress) => this.handleProgress(progress)
      );
      this.setStatus({
        phase: "manual-downloaded",
        message: "更新包已下载到“下载”文件夹并打开 DMG；请把“划词翻译”拖入“应用程序”覆盖旧版本，然后点击“解除 macOS 隔离属性”",
        progress: this.status.progress ? { ...this.status.progress, percent: 100 } : { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
        manualDownloadPath: result.path
      });
    } catch (error) {
      this.handleError(error);
    }
    return this.getStatus();
  }
  /**
   * 将底层异常转换为设置页可展示的错误状态。
   * @param error 自动更新异常。
   * @returns 无返回值。
   * @author zhenghq
  */
  handleError(error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const signatureValidationFailed = isMacOSCodeSignatureValidationError(rawMessage);
    this.setStatus({
      phase: "error",
      installMode: signatureValidationFailed ? "manual" : this.status.installMode,
      message: formatUpdateErrorMessage(error),
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
const RELEASE_URL = "https://github.com/zhq734/translation/releases/latest";
const RELEASE_DOWNLOAD_BASE_URL = `${RELEASE_URL}/download/`;
const execFileAsync$1 = node_util.promisify(node_child_process.execFile);
class ElectronUpdateDriver {
  /**
   * 配置下载策略并转发 electron-updater 生命周期事件。
   * @param listeners 自动更新事件监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  initialize(listeners) {
    electronUpdater.autoUpdater.autoDownload = false;
    electronUpdater.autoUpdater.autoInstallOnAppQuit = false;
    electronUpdater.autoUpdater.allowPrerelease = false;
    electronUpdater.autoUpdater.fullChangelog = false;
    electronUpdater.autoUpdater.on("checking-for-update", listeners.checking);
    electronUpdater.autoUpdater.on("update-available", (info) => listeners.available({
      version: info.version,
      manualDownloadUrl: resolveMacOSManualDmgUrl(info)
    }));
    electronUpdater.autoUpdater.on("update-not-available", (info) => listeners.notAvailable(info));
    electronUpdater.autoUpdater.on("download-progress", (progress) => listeners.progress(progress));
    electronUpdater.autoUpdater.on("update-downloaded", (info) => listeners.downloaded(info));
    electronUpdater.autoUpdater.on("error", (error) => listeners.error(error));
  }
  /**
   * 请求 electron-updater 检查 GitHub Release。
   * @returns 检查请求完成后的 Promise。
   * @author zhenghq
   */
  async checkForUpdates() {
    await electronUpdater.autoUpdater.checkForUpdates();
  }
  /**
   * 下载 electron-updater 已发现的更新包。
   * @returns 下载完成后的 Promise。
   * @author zhenghq
   */
  async downloadUpdate() {
    await electronUpdater.autoUpdater.downloadUpdate();
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
function resolveMacOSManualDmgUrl(info) {
  if (process.platform !== "darwin") return void 0;
  return resolveManualMacDmgUrl(info.files, process.arch, RELEASE_DOWNLOAD_BASE_URL);
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
async function createApplicationUpdateManager(onStatusChanged) {
  const macSigned = process.platform === "darwin" && electron.app.isPackaged ? await isMacOSApplicationSigned(process.execPath) : false;
  const installMode = resolveUpdateInstallMode(
    process.platform,
    electron.app.isPackaged,
    Boolean(process.env["APPIMAGE"]),
    macSigned,
    isMacOSDiskImageExecution(process.platform, process.execPath)
  );
  return new UpdateManager({
    driver: new ElectronUpdateDriver(),
    currentVersion: electron.app.getVersion(),
    enabled: electron.app.isPackaged,
    installMode,
    releaseUrl: RELEASE_URL,
    manualUpdate: process.platform === "darwin" ? createManualMacUpdateService({
      downloadsDirectory: electron.app.getPath("downloads"),
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
function formatCommandError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim().slice(0, 240) || "未知错误";
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
    return { ok: false, message: "仅 macOS 支持解除应用隔离属性" };
  }
  if (!isAllowedMacOSApplicationPath(platform, applicationPath)) {
    return {
      ok: false,
      message: `为避免误操作，只允许处理 ${MACOS_APPLICATION_PATH}`
    };
  }
  try {
    await runCommand(XATTR_COMMAND, ["-dr", "com.apple.quarantine", applicationPath]);
    return { ok: true, message: "已解除 /Applications/划词翻译.app 的 macOS 隔离属性" };
  } catch (error) {
    const errorMessage = formatCommandError(error);
    if (/No such xattr/iu.test(errorMessage)) {
      return { ok: true, message: "应用本来就没有隔离属性（com.apple.quarantine）" };
    }
    return {
      ok: false,
      message: `解除应用隔离属性失败：${errorMessage}。可手动执行：${manualCommand}`
    };
  }
}
const isMac = process.platform === "darwin";
const PRELOAD_PATH = node_path.join(__dirname, "../preload/index.js");
const DOCKER_IMAGE = "ghcr.io/owo-network/deeplx:latest";
const SELECTION_SETTLE_DELAY_MS = 80;
const UPDATE_CHECK_DELAY_MS = 5e3;
let tray = null;
let settingsWin = null;
let dingTalkConfiguration = null;
let aiConfiguration = null;
let aiModelDiscovery = null;
let aiCheckService = null;
let updateManager = null;
const edgeSpeechClient = createEdgeSpeechClient({ socketFactory: createTranslationWebSocket });
const edgeSpeechRequests = /* @__PURE__ */ new Map();
let latestTranslationRequest = 0;
let latestSelectionGesture = 0;
const selectionCapture = new SelectionCaptureCoordinator(
  captureSelection,
  captureSelectionByNativeOnly
);
let lastSelectedText = "";
let lastSelectionAnchor;
function getDingTalkConfiguration() {
  if (!dingTalkConfiguration) throw new Error("钉钉配置服务尚未初始化");
  return dingTalkConfiguration;
}
function getAiConfiguration() {
  if (!aiConfiguration) throw new Error("AI 配置服务尚未初始化");
  return aiConfiguration;
}
function getUpdateManager() {
  if (!updateManager) throw new Error("自动更新服务尚未初始化");
  return updateManager;
}
async function synthesizeEdgeSpeech(requestId, text, language) {
  const normalizedText = String(text ?? "").trim();
  if (!normalizedText) return { ok: false, error: "朗读文本为空" };
  const controller = new AbortController();
  edgeSpeechRequests.set(requestId, controller);
  try {
    return await edgeSpeechClient.synthesize(normalizedText, String(language ?? ""), controller.signal);
  } catch {
    return { ok: false, error: "Edge 语音服务暂不可用" };
  } finally {
    edgeSpeechRequests.delete(requestId);
  }
}
function cancelEdgeSpeech(requestId) {
  edgeSpeechRequests.get(String(requestId))?.abort();
  edgeSpeechRequests.delete(String(requestId));
}
const gotLock = electron.app.requestSingleInstanceLock();
if (!gotLock) {
  electron.app.quit();
} else {
  const initialization = electron.app.whenReady().then(() => onReady()).catch(handleApplicationInitializationFailure);
  electron.app.on("second-instance", () => {
    void initialization.then((initialized) => {
      if (!initialized) return;
      openSettings();
    });
  });
  if (isMac) {
    electron.app.on("activate", () => {
      void initialization.then((initialized) => {
        if (!initialized) return;
        openSettings();
      });
    });
  }
}
function handleApplicationInitializationFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[main] 应用初始化失败:", error);
  electron.dialog.showErrorBox("划词翻译启动失败", `应用无法完成启动：${message}`);
  electron.app.quit();
  return false;
}
function applyMacOSDockVisibility(showDockIcon) {
  if (!isMac) return;
  electron.app.setActivationPolicy(showDockIcon ? "regular" : "accessory");
  if (showDockIcon) {
    void electron.app.dock?.show();
    return;
  }
  electron.app.dock?.hide();
}
function configureMacOSMenuBarApplication(showDockIcon) {
  if (!isMac) return;
  applyMacOSDockVisibility(showDockIcon);
  electron.Menu.setApplicationMenu(null);
}
async function confirmMacOSInstalledApplicationLaunch() {
  if (!isMacOSDiskImageExecution(process.platform, process.execPath)) return true;
  const result = await electron.dialog.showMessageBox({
    type: "warning",
    title: "请先安装划词翻译",
    message: "当前应用正在从磁盘镜像运行",
    detail: "请先将“划词翻译”复制到“应用程序”文件夹，再从“应用程序”启动，避免重装后旧实例持续运行。",
    buttons: ["退出应用", "仍然运行"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return result.response === 1;
}
async function onReady() {
  configureMacOSMenuBarApplication(false);
  if (!await confirmMacOSInstalledApplicationLaunch()) {
    electron.app.quit();
    return false;
  }
  loadSettings();
  configureMacOSMenuBarApplication(getSettings().showDockIcon);
  createTray();
  dingTalkConfiguration = new DingTalkConfigurationService({
    getSettings,
    saveSettings,
    credentialStore: new DingTalkCredentialStore(
      node_path.join(electron.app.getPath("userData"), "credentials.json"),
      electron.safeStorage
    ),
    onSettingsChanged: (settings) => {
      tray?.setContextMenu(buildTrayMenu());
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
      tray?.setContextMenu(buildTrayMenu());
      broadcast("settings:changed", settings);
    },
    resetTranslationRuntime: resetAiTranslationRuntime
  });
  aiConfiguration.initialize();
  aiModelDiscovery = new AiModelDiscoveryService({ fetch: translationFetch });
  aiCheckService = new AiCheckService({ fetch: translationFetch });
  await applyTranslationProxy(getSettings());
  configureTranslationFetch(translationFetch);
  updateManager = await createApplicationUpdateManager((status) => {
    broadcast("updater:status", status);
  });
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
  createPopup(PRELOAD_PATH);
  createSelectionButton(PRELOAD_PATH);
  registerShortcut(getSettings().hotkey);
  applySelectionListener();
  registerIpc();
  if (shouldOpenSettingsOnInitialLaunch(process.platform)) openSettings();
  setTimeout(() => void checkForApplicationUpdates(), UPDATE_CHECK_DELAY_MS);
  setTimeout(() => void warnIfNoAccessibility(), 1500);
  return true;
}
function loadRendererHtml(win2, html) {
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win2.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/${html}`);
  } else {
    void win2.loadFile(node_path.join(__dirname, `../renderer/${html}`));
  }
}
function registerShortcut(accelerator) {
  electron.globalShortcut.unregisterAll();
  if (!accelerator) return;
  if (isCopyShortcut(accelerator)) {
    console.warn("[selection-translator] Ctrl+C / Command+C 为系统复制快捷键，不注册为翻译快捷键");
    return;
  }
  const ok = electron.globalShortcut.register(accelerator, onHotkey);
  if (!ok) {
    console.warn(`[selection-translator] 快捷键注册失败: ${accelerator}`);
  }
}
function onHotkey() {
  latestSelectionGesture += 1;
  hideSelectionButton();
  queueSelectionTranslation();
}
function scheduleSelectionAction(anchor) {
  const gestureId = ++latestSelectionGesture;
  selectionCapture.invalidate();
  hideSelectionButton();
  lastSelectionAnchor = anchor;
  const action = decideSelectionAction(isPopupVisible(), getSettings().triggerMode);
  if (action === "ignore") return;
  if (action === "show-button") {
    showSelectionButton(anchor);
    void selectionCapture.prepare(anchor);
    return;
  }
  setTimeout(() => {
    if (gestureId !== latestSelectionGesture) return;
    queueSelectionTranslation(anchor);
  }, SELECTION_SETTLE_DELAY_MS);
}
async function scheduleDoubleClickSelectionButton(gesture) {
  const gestureId = ++latestSelectionGesture;
  selectionCapture.invalidate();
  hideSelectionButton();
  lastSelectionAnchor = gesture.anchor;
  showSelectionButton(gesture.anchor);
  await selectionCapture.prepare(gesture.anchor, SELECTION_SETTLE_DELAY_MS);
  if (gestureId !== latestSelectionGesture || getSettings().triggerMode !== "button") return;
}
function handleSelectionGesture(gesture) {
  if (isPointInsidePopup(gesture.start) || isPointInsidePopup(gesture.end) || isPointInsideSelectionButton(gesture.start) || isPointInsideSelectionButton(gesture.end)) {
    return;
  }
  if (gesture.clicks >= 2 && getSettings().triggerMode === "button") {
    void scheduleDoubleClickSelectionButton(gesture);
    return;
  }
  scheduleSelectionAction(gesture.anchor);
}
function handleSelectionPointerDown(point) {
  if (isPointInsideSelectionButton(point)) {
    void translateSelectionButton();
    return true;
  }
  latestSelectionGesture += 1;
  selectionCapture.invalidate();
  hideSelectionButton();
  return false;
}
function handleCopyShortcut() {
  latestSelectionGesture += 1;
  selectionCapture.invalidate();
  hideSelectionButton();
}
function handlePasteShortcut() {
  latestSelectionGesture += 1;
  selectionCapture.invalidate();
  hideSelectionButton();
}
function queueSelectionTranslation(anchor) {
  void selectionCapture.capture(anchor).then((result) => {
    if (result) handleSelectionCaptureResult(result);
  });
}
async function translateSelectionButton() {
  if (!isSelectionButtonVisible()) return;
  latestSelectionGesture += 1;
  hideSelectionButton();
  const prepared = await selectionCapture.consumePreparedOrWait();
  const result = prepared?.text ? prepared : await selectionCapture.capture(lastSelectionAnchor);
  selectionCapture.invalidate();
  if (result) handleSelectionCaptureResult(result);
}
function handleSelectionCaptureResult(result) {
  if (result.error) {
    handleTranslateError(result.error, getSettings(), result.anchor);
    return;
  }
  if (!result.text) {
    const settings = getSettings();
    showPopup(
      {
        ok: false,
        error: resolveSelectionCaptureFailureMessage(result.reason, result.hasImage),
        sourcePreference: settings.sourceLang,
        targetPreference: settings.targetLang,
        targetLang: settings.targetLang
      },
      2e3,
      result.anchor
    );
    return;
  }
  void translateText(result.text, result.anchor);
}
async function translateText(text, anchor, preferences, origin = "selection") {
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
      targetPreference
    },
    0,
    anchor
  );
  try {
    const dingTalkCredentials = settings.dingTalkEnabled ? getDingTalkConfiguration().getCredentialsSnapshot() : null;
    const aiApiKey = settings.aiEnabled ? getAiConfiguration().getApiKey() : null;
    const output = await translate(text, requestSettings, dingTalkCredentials, aiApiKey);
    if (requestId !== latestTranslationRequest || closeVersion2 !== getPopupCloseVersion()) return;
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
        channel: output.channel
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
  }
}
function handleTranslateError(err, settings, anchor, preferences, context) {
  const common = {
    origin: context?.origin ?? "selection",
    requestId: context?.requestId,
    original: context?.original,
    sourcePreference: preferences?.sourceLang ?? settings.sourceLang,
    targetPreference: preferences?.targetLang ?? settings.targetLang,
    targetLang: settings.targetLang
  };
  if (err instanceof PermissionError) {
    showPopup(
      {
        ok: false,
        error: "需要「辅助功能」权限。请在弹出的系统设置中勾选本应用后重试。",
        ...common
      },
      8e3,
      anchor
    );
    openAccessibilitySettings();
  } else {
    showPopup(
      { ok: false, error: err.message || "翻译失败", ...common },
      5e3,
      anchor
    );
  }
}
function openManualTranslation() {
  setPopupPinned(true);
  showManualTranslationPopup();
}
async function translateManualRequest(request) {
  const raw = request && typeof request === "object" ? request : {};
  const text = raw.text;
  const validationError = validateManualTranslationText(text);
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
  selectionCapture.invalidate();
  stopAutoTrigger();
  hideSelectionButton();
  if (getSettings().triggerMode !== "hotkey") {
    startAutoTrigger(
      handleSelectionGesture,
      handleSelectionPointerDown,
      handleCopyShortcut,
      handlePasteShortcut
    );
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
        error: "需要「辅助功能」权限才能划词取词与自动翻译。请在系统设置中勾选本应用（开发模式为 Electron）后重启。",
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
function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new electron.BrowserWindow({
    width: 640,
    height: 820,
    minWidth: 480,
    minHeight: 600,
    title: "划词翻译 · 设置",
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (process.platform === "win32") settingsWin.removeMenu();
  loadRendererHtml(settingsWin, "settings.html");
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
  return settingsWin;
}
function openSettings() {
  createSettingsWindow();
}
async function checkDeepLx(url) {
  const normalizedUrl = (url || "").trim();
  if (!normalizedUrl) return { url: "", online: false, message: "未配置地址" };
  try {
    const response = await translationFetch(normalizedUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "ping", source_lang: "en", target_lang: "zh" }),
      signal: AbortSignal.timeout(3e3)
    });
    const json = await response.json();
    if (json?.code === 200) return { url: normalizedUrl, online: true };
    return {
      url: normalizedUrl,
      online: false,
      message: json?.message || `HTTP ${response.status}`
    };
  } catch (e) {
    const message = e.message || String(e);
    return {
      url: normalizedUrl,
      online: false,
      message: message.includes("abort") ? "连接超时" : message
    };
  }
}
function buildDockerCommand(port) {
  const normalizedPort = Number.isInteger(port) && port > 0 ? port : 1189;
  return [
    "docker run -d \\",
    "  --name deeplx \\",
    "  --restart unless-stopped \\",
    `  -p ${normalizedPort}:1188 \\`,
    "  -e TOKEN=你的dl_session值 \\",
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
    title: "确认解除 macOS 隔离属性",
    message: "请先下载 DMG 并将“划词翻译”拖入“应用程序”覆盖旧版本",
    detail: "确认已完成覆盖安装后继续。此操作只处理 /Applications/划词翻译.app，不会调用 sudo，也不能修复代码签名不匹配。",
    buttons: ["取消", "已完成安装，继续"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (result.response !== 1) {
    return { ok: false, message: "已取消解除 macOS 隔离属性" };
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
      message: "钉钉凭证无法安全读取，请重新配置"
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
  if (!aiModelDiscovery) throw new Error("AI 模型发现服务尚未初始化");
  const settings = getSettings();
  return aiModelDiscovery.listModels({
    protocol: settings.aiProtocol,
    baseUrl: settings.aiBaseUrl,
    apiKey: getAiConfiguration().getApiKey()
  });
}
function checkAi() {
  if (!aiCheckService) throw new Error("AI 检测服务尚未初始化");
  return aiCheckService.check({
    settings: getSettings(),
    apiKey: getAiConfiguration().getApiKey()
  });
}
function broadcast(channel, payload) {
  for (const window of electron.BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}
async function applySettingsPatch(patch) {
  if (patch.hotkey !== void 0 && isCopyShortcut(String(patch.hotkey))) {
    throw new Error("Ctrl+C / Command+C 是系统复制快捷键，不能设为翻译快捷键");
  }
  const previous = getSettings();
  const safePatch = { ...patch };
  delete safePatch.dingTalkEnabled;
  delete safePatch.dingTalkCorpId;
  delete safePatch.dingTalkClientId;
  delete safePatch.dingTalkSecretConfigured;
  delete safePatch.aiApiKey;
  delete safePatch.aiApiKeyConfigured;
  const aiFieldChanged = patch.aiEnabled !== void 0 && patch.aiEnabled !== previous.aiEnabled || patch.aiProtocol !== void 0 && patch.aiProtocol !== previous.aiProtocol || patch.aiBaseUrl !== void 0 && patch.aiBaseUrl !== previous.aiBaseUrl || patch.aiModel !== void 0 && patch.aiModel !== previous.aiModel;
  const settings = saveSettings(safePatch);
  if (patch.hotkey !== void 0 && settings.hotkey !== previous.hotkey) {
    registerShortcut(settings.hotkey);
  }
  if (patch.triggerMode !== void 0 && settings.triggerMode !== previous.triggerMode) {
    applySelectionListener();
    if (settings.triggerMode === "auto") void warnIfNoAccessibility();
  }
  if (patch.showDockIcon !== void 0 && settings.showDockIcon !== previous.showDockIcon) {
    applyMacOSDockVisibility(settings.showDockIcon);
  }
  if (patch.proxyMode !== void 0 || patch.proxyRules !== void 0 || patch.proxyBypassRules !== void 0) {
    await applyTranslationProxy(settings);
  }
  if (patch.microsoftEnabled !== void 0 && settings.microsoftEnabled !== previous.microsoftEnabled) {
    resetMicrosoftTranslationRuntime();
  }
  if (aiFieldChanged) {
    resetAiTranslationRuntime();
    aiModelDiscovery?.clearCache();
  }
  tray?.setContextMenu(buildTrayMenu());
  broadcast("settings:changed", settings);
  return settings;
}
function registerIpc() {
  electron.ipcMain.on("popup:copy", (_event, text) => {
    electron.clipboard.writeText(String(text ?? ""));
  });
  electron.ipcMain.on("popup:hide", () => hidePopup());
  electron.ipcMain.on("popup:set-pinned", (_event, pinned2) => {
    setPopupPinned(Boolean(pinned2));
  });
  electron.ipcMain.on("settings:open", () => openSettings());
  electron.ipcMain.on("settings:stop-service", () => stopApplicationService());
  electron.ipcMain.on("selection:translate", () => {
    void translateSelectionButton();
  });
  electron.ipcMain.on("manual-translate:open-request", () => openManualTranslation());
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
  electron.ipcMain.handle("popup:retranslate", async (_event, sourceLang, targetLang) => {
    const sourcePreference = sourceLang || "auto";
    const targetPreference = targetLang || "auto";
    await applySettingsPatch({ sourceLang: sourcePreference, targetLang: targetPreference });
    if (!lastSelectedText) return;
    await translateText(lastSelectedText, lastSelectionAnchor, {
      sourceLang: sourcePreference,
      targetLang: targetPreference
    });
  });
  electron.ipcMain.handle("settings:get", () => getSettings());
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
  electron.ipcMain.handle("deeplx:check", (_event, url) => checkDeepLx(url));
  electron.ipcMain.handle("deeplx:docker-command", (_event, port) => buildDockerCommand(port));
  electron.ipcMain.on("deeplx:open-doc", () => openDeployDoc());
  electron.ipcMain.handle("updater:get-status", () => getUpdateManager().getStatus());
  electron.ipcMain.handle("updater:check", () => checkForApplicationUpdates());
  electron.ipcMain.handle("updater:download", () => downloadApplicationUpdate());
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
    throw new Error(`无法加载托盘图标: ${filename}`);
  }
  if (isMac) icon.setTemplateImage(true);
  return icon;
}
function createTray() {
  tray = new electron.Tray(loadTrayIcon());
  tray.setToolTip("划词翻译");
  tray.setContextMenu(buildTrayMenu());
}
function buildTrayMenu() {
  const settings = getSettings();
  const targetOptions = [{ code: "auto", label: "自动中英互译" }, ...LANGUAGES];
  const targetSubmenu = targetOptions.map((language) => ({
    label: language.label,
    type: "radio",
    checked: settings.targetLang.toLowerCase() === language.code.toLowerCase(),
    click: () => void applySettingsPatch({ targetLang: language.code })
  }));
  const sourceOptions = [{ code: "auto", label: "自动检测" }, ...LANGUAGES];
  const sourceSubmenu = sourceOptions.map((language) => ({
    label: language.label,
    type: "radio",
    checked: settings.sourceLang.toLowerCase() === language.code.toLowerCase(),
    click: () => void applySettingsPatch({ sourceLang: language.code })
  }));
  return electron.Menu.buildFromTemplate([
    { label: `划词翻译   ${settings.hotkey}`, enabled: false },
    { type: "separator" },
    { label: "手动翻译…", click: () => openManualTranslation() },
    { type: "separator" },
    {
      label: "划词后自动显示“译”按钮",
      type: "checkbox",
      checked: settings.triggerMode === "button",
      click: (menuItem) => void applySettingsPatch({ triggerMode: menuItem.checked ? "button" : "hotkey" })
    },
    { type: "separator" },
    { label: "目标语言", submenu: targetSubmenu },
    { label: "源语言", submenu: sourceSubmenu },
    { type: "separator" },
    { label: "设置", click: () => openSettings() },
    { label: "退出", click: () => stopApplicationService() }
  ]);
}
function cleanupBeforeQuit() {
  stopAutoTrigger();
  electron.globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
}
electron.app.on("before-quit", cleanupBeforeQuit);
