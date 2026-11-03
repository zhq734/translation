/**
 * macOS AX 选区直读 helper。
 * 直接调用 AXUIElement API 按序执行三级读取：
 *   0. 若调用方传入窗口编号，先定位该 AX 窗口的 focused element；
 *   1. 聚焦元素 AXSelectedText；
 *   2. 聚焦元素 AXSelectedTextMarkerRange 提取（覆盖 Safari/Chrome web area）；
 *   3. 鼠标位置元素及其最多 4 层祖先的 AXSelectedText 与 AXSelectedTextMarkerRange
 *      （覆盖 VS Code 注释、网页正文等自绘/Web 渲染控件，它们常不暴露 AXSelectedText）。
 * 仅依赖 Accessibility 授权，不触碰 System Events，因此不会触发 Automation 授权弹窗。
 *
 * 输出协议（与 src/shared/selectionBehavior.ts 的 parseNativeSelectionReadOutput 兼容）：
 *   首行状态标记（PRESENT / EMPTY / UNKNOWN / PERMISSION），
 *   UNKNOWN 可附带固定原因 reason=api-disabled（AXError -25211），
 *   PRESENT 时其余行为选中文本；退出码恒为 0。
 * stderr 另输出脱敏焦点阶段诊断：FOCUS unknown|ready|target-mismatch，
 * 不包含窗口标题、选区内容或焦点元素路径。
 *
 * @author zhenghq
 */
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>

/** 鼠标位置兜底允许沿 AXParent 上溯的最大祖先层数。 */
static const NSInteger kMaxAncestorLevels = 4;
/** AX 与 CGWindow 边界比较允许的像素误差，覆盖系统坐标系取整与阴影差异。 */
static const CGFloat kWindowBoundsTolerance = 2.0;
/** 菜单栏复制动作允许遍历的最大深度，避免异常 AX 树导致无限递归。 */
static const NSInteger kMaxMenuTraversalDepth = 8;
/** 菜单栏复制动作允许检查的最大节点数，保证 helper 执行时间有界。 */
static const NSInteger kMaxMenuNodeCount = 4096;
/** 为触发 AX 树构建而读取后代元素的最大深度。 */
static const NSInteger kMaxAxTouchDepth = 8;
/** 为触发 AX 树构建而读取后代元素的最大节点数，避免异常 AX 树拖慢取词。 */
static const NSInteger kMaxAxTouchNodeCount = 512;
/** 目标窗口内搜索选中文本的最大深度，避免 WebKit/Chromium 深树拖慢取词。 */
static const NSInteger kMaxAxSelectionSearchDepth = 12;
/** 目标窗口内搜索选中文本的最大节点数，保证单次原生直读时间有界。 */
static const NSInteger kMaxAxSelectionSearchNodeCount = 2048;

/** 调用方记录的窗口上下文，用于 AXWindowNumber 缺失时做二级匹配。 */
typedef struct {
  long windowNumber;
  BOOL hasBounds;
  CGRect bounds;
  NSString *titleFingerprint;
} WindowCaptureContext;

/** 菜单复制动作的遍历状态与唯一候选结果。 */
typedef struct {
  AXUIElementRef match;
  NSInteger visitedCount;
  NSInteger matchCount;
} MenuCopySearchState;

/** Chromium/Electron 增强 AX 属性的请求结果。 */
typedef enum {
  AXEnhancementModeNone = 0,
  AXEnhancementModeManual,
  AXEnhancementModeEnhanced
} AXEnhancementMode;

typedef struct {
  BOOL permissionGranted;
  BOOL applicationAvailable;
  BOOL accepted;
  AXEnhancementMode mode;
  AXError manualError;
  AXError enhancedError;
} AXEnhancementResult;

/** 进程内 AX 读取与 CLI helper 共用的结果状态。 */
typedef enum {
  MacosAxReadStatusPresent = 0,
  MacosAxReadStatusEmpty,
  MacosAxReadStatusUnknown,
  MacosAxReadStatusPermission
} MacosAxReadStatus;

/** 一次 AX 选区读取的完整结果，供 CLI 与 N-API addon 共同消费。 */
typedef struct {
  MacosAxReadStatus status;
  NSString *text;
  NSString *reason;
  NSString *windowLocate;
  BOOL windowMatched;
  CFIndex windowCount;
  NSString *focusStatus;
} MacosAxReadResult;

/** AX 选区读取选项；字段均为可选，保持旧调用兼容。 */
typedef struct {
  BOOL hasWindowArgument;
  BOOL hasWindowNumber;
  long windowNumber;
  BOOL hasPid;
  pid_t pid;
  BOOL hasBounds;
  CGRect bounds;
  NSString *titleFingerprint;
} MacosAxReadOptions;

/**
 * 向 stdout 输出状态标记与可选文本，协议为“状态行 + 可选文本行”。
 * @param status 状态标记（PRESENT / EMPTY / UNKNOWN / PERMISSION）。
 * @param text 状态为 PRESENT 时的选中文本，其余状态传 nil。
 * @return 无返回值。
 * @author zhenghq
 */
static void WriteResult(NSString *status, NSString *text) {
  NSFileHandle *out = NSFileHandle.fileHandleWithStandardOutput;
  [out writeData:[status dataUsingEncoding:NSUTF8StringEncoding]];
  if (text.length > 0) {
    NSMutableString *payload = [NSMutableString stringWithString:@"\n"];
    [payload appendString:text];
    [out writeData:[payload dataUsingEncoding:NSUTF8StringEncoding]];
  }
}

/**
 * 向 stderr 输出脱敏的窗口定位诊断。
 * 仅输出定位分类与普通窗口数量，不输出窗口标题、聊天对象或选区文本。
 * @param outcome 定位分类：exact / fallback / failed。
 * @param windowCount 目标应用普通窗口数量。
 * @return 无返回值。
 * @author zhenghq
 */
static void WriteWindowDiagnostic(NSString *outcome, CFIndex windowCount) {
  NSString *line = [NSString stringWithFormat:@"WINDOW %@ count=%ld\n",
                                               outcome, (long)windowCount];
  NSFileHandle *errorOutput = NSFileHandle.fileHandleWithStandardError;
  [errorOutput writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
}

/**
 * 向 stderr 输出脱敏焦点阶段诊断。
 * 只输出固定枚举，避免窗口标题或焦点元素路径进入日志。
 * @param status 焦点阶段：unknown / ready / target-mismatch。
 * @return 无返回值。
 * @author zhenghq
 */
static void WriteFocusDiagnostic(NSString *status) {
  NSString *line = [NSString stringWithFormat:@"FOCUS %@\n", status];
  NSFileHandle *errorOutput = NSFileHandle.fileHandleWithStandardError;
  [errorOutput writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
}

/**
 * 记录 AX 调用是否明确返回接口禁用错误（kAXErrorAPIDisabled，-25211）。
 * helper 是单次短进程，调用方通过输出参数累计本轮状态；一旦命中，
 * 最终必须输出 api-disabled，避免被普通 UNKNOWN 折叠成取词超时。
 * @param error 本次 AXUIElement API 调用返回的错误码。
 * @param apiDisabled 本轮 APIDisabled 状态；命中时置为 YES。
 * @return 本次错误是否为 kAXErrorAPIDisabled。
 * @author zhenghq
 */
static BOOL RecordApiDisabledError(AXError error, BOOL *apiDisabled) {
  if (error != kAXErrorAPIDisabled) return NO;
  if (apiDisabled) *apiDisabled = YES;
  return YES;
}

/**
 * 读取 AX 元素的字符串属性，失败或非字符串时返回 nil。
 * @param element 目标 AX 元素。
 * @param attribute 属性名。
 * @return 非空字符串值；读取失败返回 nil。
 * @author zhenghq
 */
static NSString *CopyStringAttribute(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || !value) {
    return nil;
  }
  if (CFGetTypeID(value) != CFStringGetTypeID()) {
    CFRelease(value);
    return nil;
  }
  NSString *text = (__bridge_transfer NSString *)value;
  return text.length > 0 ? text : nil;
}

/**
 * 有界深度优先读取 AX 元素的后代，触发 Chromium、Word、Excel 等应用
 * 按需构建辅助功能树。这里只读取 children，不修改元素或执行动作。
 * @param element 起始 AX 元素。
 * @param depth 剩余遍历深度。
 * @param visitedCount 已访问节点计数，所有递归共享同一上限。
 * @return 无返回值。
 * @author zhenghq
 */
static void TouchDescendantElements(
  AXUIElementRef element,
  NSInteger depth,
  NSInteger *visitedCount
) {
  if (!element || !visitedCount || depth <= 0 || depth > kMaxAxTouchDepth ||
      *visitedCount >= kMaxAxTouchNodeCount) {
    return;
  }
  *visitedCount += 1;
  CFTypeRef childrenValue = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &childrenValue) !=
        kAXErrorSuccess || !childrenValue ||
      CFGetTypeID(childrenValue) != CFArrayGetTypeID()) {
    if (childrenValue) CFRelease(childrenValue);
    return;
  }
  CFArrayRef children = (CFArrayRef)childrenValue;
  CFIndex count = CFArrayGetCount(children);
  for (CFIndex index = 0; index < count && *visitedCount < kMaxAxTouchNodeCount; index += 1) {
    AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, index);
    if (child && CFGetTypeID(child) == AXUIElementGetTypeID()) {
      TouchDescendantElements(child, depth - 1, visitedCount);
    }
  }
  CFRelease(childrenValue);
}

/**
 * 通过 AXSelectedTextMarkerRange 提取选中文本，覆盖浏览器 web area 等
 * 不直接暴露 AXSelectedText 的聚焦元素。
 * @param element 目标 AX 元素。
 * @return 提取到的非空文本；失败返回 nil。
 * @author zhenghq
 */
static NSString *CopySelectedTextViaMarkerRange(AXUIElementRef element) {
  CFTypeRef markerRange = NULL;
  // GitHub Actions 可能使用较旧 macOS SDK，其中未声明
  // kAXSelectedTextMarkerRangeAttribute；直接使用运行时属性名保持兼容。
  if (AXUIElementCopyAttributeValue(
        element, CFSTR("AXSelectedTextMarkerRange"), &markerRange) != kAXErrorSuccess ||
      !markerRange) {
    return nil;
  }
  // WebKit 的 marker range 必须使用 AXStringForTextMarkerRange 取文本；
  // 部分旧 SDK 未声明对应常量，直接使用运行时属性名保持兼容。
  CFTypeRef text = NULL;
  AXError error = AXUIElementCopyParameterizedAttributeValue(
    element, CFSTR("AXStringForTextMarkerRange"), markerRange, &text);
  // 少数旧版应用仍只实现 AXTextForRange，保留兼容回退但不得替代正确入口。
  if (error != kAXErrorSuccess || !text) {
    if (text) CFRelease(text);
    text = NULL;
    error = AXUIElementCopyParameterizedAttributeValue(
      element, CFSTR("AXTextForRange"), markerRange, &text);
  }
  CFRelease(markerRange);
  if (error != kAXErrorSuccess || !text) return nil;
  if (CFGetTypeID(text) != CFStringGetTypeID()) {
    CFRelease(text);
    return nil;
  }
  NSString *result = (__bridge_transfer NSString *)text;
  return result.length > 0 ? result : nil;
}

/**
 * 通过 AXSelectedTextRange 与 AXStringForRange 提取选中文本。
 * 部分 Safari/WebKit 版本只暴露选区范围而不直接返回选中文字，
 * 此时可用参数化属性按范围取回文本。
 * @param element 目标 AX 元素。
 * @return 提取到的非空文本；范围不可读、为空或取文本失败时返回 nil。
 * @author zhenghq
 */
static NSString *CopySelectedTextViaSelectedRange(AXUIElementRef element) {
  CFTypeRef rangeValue = NULL;
  // 兼容旧 SDK：直接使用运行时属性名，避免头文件缺少常量时编译失败。
  if (AXUIElementCopyAttributeValue(
        element, CFSTR("AXSelectedTextRange"), &rangeValue) != kAXErrorSuccess ||
      !rangeValue) {
    return nil;
  }
  CFRange range = {0, 0};
  BOOL isRange = CFGetTypeID(rangeValue) == AXValueGetTypeID() &&
    AXValueGetValue((AXValueRef)rangeValue, (AXValueType)kAXValueCFRangeType, &range);
  CFRelease(rangeValue);
  if (!isRange || range.length <= 0) return nil;

  CFTypeRef rangeObject = AXValueCreate((AXValueType)kAXValueCFRangeType, &range);
  if (!rangeObject) return nil;
  CFTypeRef text = NULL;
  AXError error = AXUIElementCopyParameterizedAttributeValue(
    element, CFSTR("AXStringForRange"), rangeObject, &text);
  CFRelease(rangeObject);
  if (error != kAXErrorSuccess || !text) return nil;
  if (CFGetTypeID(text) != CFStringGetTypeID()) {
    CFRelease(text);
    return nil;
  }
  NSString *result = (__bridge_transfer NSString *)text;
  return result.length > 0 ? result : nil;
}

/**
 * 读取单个元素及其祖先链上的选中文本，命中第一个非空选区即返回。
 * 每层先读 AXSelectedText，失败后依次回退 AXSelectedTextMarkerRange
 * 与 AXSelectedTextRange，以覆盖 VS Code 注释、网页正文及 Safari/WebKit
 * 等不直接暴露 AXSelectedText 的自绘控件。
 * @param element 起始 AX 元素。
 * @param maxLevels 允许上溯的最大层数（含起始元素本身）。
 * @return 命中的非空选中文本；链上均无可读选区时返回 nil。
 * @author zhenghq
 */
static NSString *CopySelectedTextFromAncestry(AXUIElementRef element, NSInteger maxLevels) {
  AXUIElementRef current = (AXUIElementRef)CFRetain(element);
  NSString *result = nil;
  for (NSInteger level = 0; level < maxLevels && current; level += 1) {
    NSString *text = CopyStringAttribute(current, kAXSelectedTextAttribute);
    if (!text) {
      text = CopySelectedTextViaMarkerRange(current);
    }
    if (!text) {
      text = CopySelectedTextViaSelectedRange(current);
    }
    if (text) {
      result = text;
      break;
    }
    CFTypeRef parent = NULL;
    AXError error = AXUIElementCopyAttributeValue(current, kAXParentAttribute, &parent);
    CFRelease(current);
    current = NULL;
    if (error != kAXErrorSuccess || !parent ||
        CFGetTypeID(parent) != AXUIElementGetTypeID()) {
      if (parent) CFRelease(parent);
      break;
    }
    current = (AXUIElementRef)parent;
  }
  if (current) CFRelease(current);
  return result;
}

/**
 * 在已精确命中的目标窗口内搜索 AXWebArea 及其后代选区。
 * 只读取选中文本相关属性，不接受正文；优先检查 AXWebArea，同时每个
 * 节点都会检查自身选区，再按 AXChildren 深度优先遍历。深度与节点数
 * 均有硬上限，避免异常 AX 树拖慢取词。
 * @param element 当前 AX 元素。
 * @param depth 剩余搜索深度。
 * @param visitedCount 所有递归共享的已访问节点计数。
 * @return 首个非空选中文本；未找到返回 nil。
 * @author zhenghq
 */
static NSString *CopySelectedTextFromDescendants(
  AXUIElementRef element,
  NSInteger depth,
  NSInteger *visitedCount
) {
  if (!element || !visitedCount || depth < 0 ||
      depth > kMaxAxSelectionSearchDepth ||
      *visitedCount >= kMaxAxSelectionSearchNodeCount) {
    return nil;
  }
  *visitedCount += 1;

  NSString *role = CopyStringAttribute(element, kAXRoleAttribute);
  BOOL isWebArea = role && [role isEqualToString:@"AXWebArea"];
  // 每个节点只检查自身选区属性；WebArea 与文本节点都可能直接暴露选区。
  // 使用单层读取而不是向上回溯，避免把父级正文或其它节点的选区误认为当前结果。
  NSString *text = CopySelectedTextFromAncestry(element, 1);
  if (text && isWebArea) return text;
  if (text) return text;
  if (depth == 0) return nil;

  CFTypeRef childrenValue = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &childrenValue) !=
        kAXErrorSuccess || !childrenValue ||
      CFGetTypeID(childrenValue) != CFArrayGetTypeID()) {
    if (childrenValue) CFRelease(childrenValue);
    return nil;
  }
  CFArrayRef children = (CFArrayRef)childrenValue;
  CFIndex count = CFArrayGetCount(children);
  NSString *result = nil;
  for (CFIndex index = 0; index < count &&
       *visitedCount < kMaxAxSelectionSearchNodeCount; index += 1) {
    AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, index);
    if (!child || CFGetTypeID(child) != AXUIElementGetTypeID()) continue;
    result = CopySelectedTextFromDescendants(child, depth - 1, visitedCount);
    if (result) break;
  }
  CFRelease(childrenValue);
  return result;
}

/**
 * 读取 AX 元素的布尔属性，失败或类型非法时返回 false。
 * @param element 目标 AX 元素。
 * @param attribute 属性名。
 * @return 属性为真时返回 true。
 * @author zhenghq
 */
static BOOL CopyBooleanAttribute(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || !value) {
    return NO;
  }
  BOOL result = CFGetTypeID(value) == CFBooleanGetTypeID() &&
    CFBooleanGetValue((CFBooleanRef)value);
  CFRelease(value);
  return result;
}

/**
 * 判断菜单项是否为唯一的 Command+C 复制命令。
 *
 * 仅按快捷键字符、修饰键与启用状态匹配，不依赖本地化菜单标题。
 * 必须排除 Shift、Option、Control 以及无 Command 的变体，防止误触
 * 剪切、粘贴或应用自定义快捷键。
 * @param element 待检查的 AX 元素。
 * @return 是可用 Command+C 菜单项时返回 true。
 * @author zhenghq
 */
static BOOL IsCommandCopyMenuItem(AXUIElementRef element) {
  NSString *commandCharacter = CopyStringAttribute(element, kAXMenuItemCmdCharAttribute);
  if (!commandCharacter || ![commandCharacter.lowercaseString isEqualToString:@"c"]) {
    return NO;
  }
  CFTypeRef modifiersValue = NULL;
  if (AXUIElementCopyAttributeValue(
        element, kAXMenuItemCmdModifiersAttribute, &modifiersValue) != kAXErrorSuccess ||
      !modifiersValue || CFGetTypeID(modifiersValue) != CFNumberGetTypeID()) {
    if (modifiersValue) CFRelease(modifiersValue);
    return NO;
  }
  long modifiers = 0;
  CFNumberGetValue((CFNumberRef)modifiersValue, kCFNumberLongType, &modifiers);
  CFRelease(modifiersValue);
  long forbiddenModifiers = kAXMenuItemModifierShift |
    kAXMenuItemModifierOption |
    kAXMenuItemModifierControl |
    kAXMenuItemModifierNoCommand;
  if ((modifiers & forbiddenModifiers) != 0) return NO;
  return CopyBooleanAttribute(element, kAXEnabledAttribute);
}

/**
 * 请求目标应用启用完整辅助功能树，并通过读取窗口后代触发按需构建。
 *
 * Electron 明确支持 AXManualAccessibility，Chromium 则通过
 * AXEnhancedUserInterface 进入延迟启用流程。两者都会重置 Chromium 的
 * 2 秒防抖定时器，因此必须先尝试 manual，只有被拒绝时才回退 enhanced，
 * 避免同一应用被重复计数。
 * @param pid 目标应用进程号。
 * @return 权限、应用可用性与两个属性的结构化结果。
 * @author zhenghq
 */
static AXEnhancementResult EnableEnhancedUserInterface(pid_t pid) {
  AXEnhancementResult result = {0};
  result.permissionGranted = AXIsProcessTrusted();
  if (!result.permissionGranted) return result;
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (!application) return result;
  result.applicationAvailable = YES;
  result.manualError = AXUIElementSetAttributeValue(
    application, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
  if (result.manualError == kAXErrorSuccess) {
    result.accepted = YES;
    result.mode = AXEnhancementModeManual;
  } else {
    result.enhancedError = AXUIElementSetAttributeValue(
      application, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
    if (result.enhancedError == kAXErrorSuccess) {
      result.accepted = YES;
      result.mode = AXEnhancementModeEnhanced;
    }
  }
  CFTypeRef windowsValue = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windowsValue) ==
        kAXErrorSuccess && windowsValue && CFGetTypeID(windowsValue) == CFArrayGetTypeID()) {
    CFArrayRef windows = (CFArrayRef)windowsValue;
    CFIndex count = CFArrayGetCount(windows);
    NSInteger visitedCount = 0;
    for (CFIndex index = 0; index < count; index += 1) {
      AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
      if (window && CFGetTypeID(window) == AXUIElementGetTypeID()) {
        TouchDescendantElements(window, kMaxAxTouchDepth, &visitedCount);
      }
    }
  }
  if (windowsValue) CFRelease(windowsValue);
  CFRelease(application);
  return result;
}

/**
 * 深度优先遍历菜单树，记录唯一启用的 Command+C 菜单项。
 *
 * 遍历深度与节点数量均有硬上限；发现第二个匹配项后停止继续搜索，
 * 由调用方按“无法唯一定位”安全放弃，避免执行错误菜单命令。
 * @param element 当前 AX 元素。
 * @param depth 当前遍历深度。
 * @param state 遍历状态与候选结果。
 * @return 无返回值。
 * @author zhenghq
 */
static void FindCommandCopyMenuItem(
  AXUIElementRef element,
  NSInteger depth,
  MenuCopySearchState *state
) {
  if (!element || !state || depth > kMaxMenuTraversalDepth ||
      state->visitedCount >= kMaxMenuNodeCount || state->matchCount > 1) {
    return;
  }
  state->visitedCount += 1;
  if (IsCommandCopyMenuItem(element)) {
    state->matchCount += 1;
    if (state->matchCount == 1) {
      state->match = (AXUIElementRef)CFRetain(element);
    } else if (state->match) {
      CFRelease(state->match);
      state->match = nil;
    }
    return;
  }
  CFTypeRef childrenValue = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &childrenValue) !=
        kAXErrorSuccess || !childrenValue ||
      CFGetTypeID(childrenValue) != CFArrayGetTypeID()) {
    if (childrenValue) CFRelease(childrenValue);
    return;
  }
  CFArrayRef children = (CFArrayRef)childrenValue;
  CFIndex count = CFArrayGetCount(children);
  for (CFIndex index = 0; index < count && state->matchCount <= 1; index += 1) {
    AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, index);
    if (child && CFGetTypeID(child) == AXUIElementGetTypeID()) {
      FindCommandCopyMenuItem(child, depth + 1, state);
    }
  }
  CFRelease(childrenValue);
}

/**
 * 在目标应用中查找唯一启用的 Command+C 菜单项并执行 AXPress。
 * @param pid 目标应用进程号。
 * @return 成功执行返回 true；权限不足、菜单不可读、无候选或候选不唯一返回 false。
 * @author zhenghq
 */
static BOOL PerformCommandCopyMenuAction(pid_t pid) {
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (!application) return NO;
  CFTypeRef menuBarValue = NULL;
  BOOL performed = NO;
  if (AXUIElementCopyAttributeValue(
        application, kAXMenuBarAttribute, &menuBarValue) == kAXErrorSuccess &&
      menuBarValue && CFGetTypeID(menuBarValue) == AXUIElementGetTypeID()) {
    MenuCopySearchState state = {0};
    FindCommandCopyMenuItem((AXUIElementRef)menuBarValue, 0, &state);
    if (state.matchCount == 1 && state.match) {
      performed = AXUIElementPerformAction(state.match, kAXPressAction) == kAXErrorSuccess;
    }
    if (state.match) CFRelease(state.match);
  }
  if (menuBarValue) CFRelease(menuBarValue);
  CFRelease(application);
  return performed;
}

/**
 * 读取当前鼠标位置下的 AX 元素，用于焦点与选区不一致时的兜底。
 * @param systemWide 系统级 AX 元素。
 * @param error 输出 AXUIElementCopyElementAtPosition 的错误码，可为 NULL。
 * @return 鼠标位置元素；查询失败返回 nil。调用方负责 CFRelease。
 * @author zhenghq
 */
static AXUIElementRef CopyElementAtMousePosition(AXUIElementRef systemWide, AXError *error) {
  CGEventRef event = CGEventCreate(NULL);
  CGPoint point = CGEventGetLocation(event);
  CFRelease(event);
  AXUIElementRef element = NULL;
  AXError copyError = AXUIElementCopyElementAtPosition(
    systemWide, (float)point.x, (float)point.y, &element);
  if (error) *error = copyError;
  if (copyError != kAXErrorSuccess) {
    return nil;
  }
  return element;
}

/**
 * 读取 AX 窗口的窗口编号。
 * @param window 目标 AX 窗口。
 * @return 窗口编号；属性缺失或类型非法时返回 0。
 * @author zhenghq
 */
static long CopyWindowNumber(AXUIElementRef window) {
  if (!window) return 0;
  CFTypeRef numberValue = NULL;
  if (AXUIElementCopyAttributeValue(window, CFSTR("AXWindowNumber"), &numberValue) !=
        kAXErrorSuccess || !numberValue) {
    return 0;
  }
  long windowNumber = 0;
  if (CFGetTypeID(numberValue) == CFNumberGetTypeID()) {
    CFNumberGetValue((CFNumberRef)numberValue, kCFNumberLongType, &windowNumber);
  }
  CFRelease(numberValue);
  return windowNumber;
}

/**
 * 读取 AX 窗口的位置与尺寸。
 * @param window 目标 AX 窗口。
 * @param bounds 输出的窗口边界。
 * @return 成功读取位置与尺寸时返回 true。
 * @author zhenghq
 */
static BOOL CopyAXWindowBounds(AXUIElementRef window, CGRect *bounds) {
  if (!window || !bounds) return NO;
  CFTypeRef positionValue = NULL;
  CFTypeRef sizeValue = NULL;
  if (AXUIElementCopyAttributeValue(window, kAXPositionAttribute, &positionValue) !=
        kAXErrorSuccess || !positionValue ||
      AXUIElementCopyAttributeValue(window, kAXSizeAttribute, &sizeValue) !=
        kAXErrorSuccess || !sizeValue) {
    if (positionValue) CFRelease(positionValue);
    if (sizeValue) CFRelease(sizeValue);
    return NO;
  }
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  BOOL ok = CFGetTypeID(positionValue) == AXValueGetTypeID() &&
    CFGetTypeID(sizeValue) == AXValueGetTypeID() &&
    AXValueGetValue((AXValueRef)positionValue, (AXValueType)kAXValueCGPointType, &position) &&
    AXValueGetValue((AXValueRef)sizeValue, (AXValueType)kAXValueCGSizeType, &size);
  CFRelease(positionValue);
  CFRelease(sizeValue);
  if (!ok) return NO;
  *bounds = CGRectMake(position.x, position.y, size.width, size.height);
  return YES;
}

/**
 * 计算窗口标题的 SHA-256 前 12 位指纹。
 * @param title 窗口标题。
 * @return 十六进制指纹；空标题返回 nil。
 * @author zhenghq
 */
static NSString *CopyTitleFingerprint(NSString *title) {
  NSString *normalizedTitle = [title stringByTrimmingCharactersInSet:
    NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (normalizedTitle.length == 0) return nil;
  NSData *data = [normalizedTitle dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *result = [NSMutableString stringWithCapacity:12];
  for (NSInteger index = 0; index < 6; index += 1) {
    [result appendFormat:@"%02x", digest[index]];
  }
  return result;
}

/**
 * 判断 AX 窗口边界是否与记录边界匹配。
 * @param left 左侧边界。
 * @param right 右侧边界。
 * @return 四边均在容差内时返回 true。
 * @author zhenghq
 */
static BOOL WindowBoundsMatch(CGRect left, CGRect right) {
  return fabs(left.origin.x - right.origin.x) <= kWindowBoundsTolerance &&
    fabs(left.origin.y - right.origin.y) <= kWindowBoundsTolerance &&
    fabs(left.size.width - right.size.width) <= kWindowBoundsTolerance &&
    fabs(left.size.height - right.size.height) <= kWindowBoundsTolerance;
}

/**
 * 判断候选 AX 窗口是否与调用方记录的窗口上下文匹配。
 * 先按窗口编号精确匹配，再按 bounds 与标题指纹组合校验；不能仅凭
 * focused/main window 的默认身份接受候选，否则可能读到同进程其它窗口。
 * @param window 候选 AX 窗口。
 * @param context 目标窗口上下文。
 * @param requireTitleFingerprint 是否要求标题指纹同时命中。
 * @return 候选窗口可确认属于目标窗口时返回 true。
 * @author zhenghq
 */
static BOOL WindowMatchesContext(
  AXUIElementRef window,
  WindowCaptureContext context,
  BOOL requireTitleFingerprint
) {
  if (!window) return NO;
  if (context.windowNumber > 0 && CopyWindowNumber(window) == context.windowNumber) {
    return YES;
  }
  if (!context.hasBounds) return NO;
  CGRect windowBounds = CGRectZero;
  if (!CopyAXWindowBounds(window, &windowBounds) ||
      !WindowBoundsMatch(windowBounds, context.bounds)) {
    return NO;
  }
  if (!requireTitleFingerprint) return YES;
  if (context.titleFingerprint.length == 0) return NO;
  NSString *title = CopyStringAttribute(window, kAXTitleAttribute);
  NSString *fingerprint = CopyTitleFingerprint(title);
  return fingerprint && [fingerprint isEqualToString:context.titleFingerprint];
}

/**
 * 从指定 application 属性读取候选窗口，并仅在通过目标窗口校验时返回。
 * @param application 目标应用 AX 元素。
 * @param attribute focused/main window 属性。
 * @param context 目标窗口上下文。
 * @param apiDisabled 本轮 AX 接口禁用状态。
 * @return 已确认属于目标的窗口；未命中返回 nil。调用方负责 CFRelease。
 * @author zhenghq
 */
static AXUIElementRef CopyVerifiedWindowAttribute(
  AXUIElementRef application,
  CFStringRef attribute,
  WindowCaptureContext context,
  BOOL *apiDisabled
) {
  CFTypeRef value = NULL;
  AXError error = AXUIElementCopyAttributeValue(application, attribute, &value);
  RecordApiDisabledError(error, apiDisabled);
  if (error != kAXErrorSuccess ||
      !value || CFGetTypeID(value) != AXUIElementGetTypeID()) {
    if (value) CFRelease(value);
    return nil;
  }
  AXUIElementRef window = (AXUIElementRef)value;
  if (!WindowMatchesContext(window, context, YES)) {
    CFRelease(value);
    return nil;
  }
  return window;
}

/**
 * 在目标应用的 AX 窗口列表中按窗口上下文查找窗口。
 * 先按 AXWindowNumber 精确匹配；Chrome 普通多窗口可能不暴露该属性，
 * 此时再用 CGWindow 记录下来的 bounds 与标题指纹做二级匹配。
 * @param application 目标应用 AX 元素。
 * @param context 目标窗口上下文。
 * @param apiDisabled 本轮 AX 接口禁用状态。
 * @return 命中的 AX 窗口；未命中返回 nil。调用方负责 CFRelease。
 * @author zhenghq
 */
static AXUIElementRef CopyWindowByContext(
  AXUIElementRef application,
  WindowCaptureContext context,
  BOOL *apiDisabled
) {
  CFTypeRef windowsValue = NULL;
  AXError error = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windowsValue);
  BOOL apiUnavailable = RecordApiDisabledError(error, apiDisabled);
  AXUIElementRef matched = nil;
  if (error == kAXErrorSuccess && windowsValue &&
      CFGetTypeID(windowsValue) == CFArrayGetTypeID()) {
    CFArrayRef windows = (CFArrayRef)windowsValue;
    AXUIElementRef boundsMatched = nil;
    CFIndex boundsCandidateCount = 0;
    CFIndex count = CFArrayGetCount(windows);
    for (CFIndex index = 0; index < count; index += 1) {
      AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
      if (!window || CFGetTypeID(window) != AXUIElementGetTypeID()) continue;
      if (context.windowNumber > 0 && CopyWindowNumber(window) == context.windowNumber) {
        matched = (AXUIElementRef)CFRetain(window);
        break;
      }
      if (!context.hasBounds) continue;
      CGRect windowBounds = CGRectZero;
      if (!CopyAXWindowBounds(window, &windowBounds) ||
          !WindowBoundsMatch(windowBounds, context.bounds)) {
        continue;
      }
      NSString *title = CopyStringAttribute(window, kAXTitleAttribute);
      NSString *fingerprint = CopyTitleFingerprint(title);
      BOOL fingerprintMatches = context.titleFingerprint.length > 0 &&
        fingerprint && [fingerprint isEqualToString:context.titleFingerprint];
      // 标题指纹存在时必须同时匹配；标题为空时只允许唯一 bounds 候选，避免误读同尺寸窗口。
      if (context.titleFingerprint.length > 0 && !fingerprintMatches) continue;
      boundsCandidateCount += 1;
      if (boundsMatched) CFRelease(boundsMatched);
      boundsMatched = (AXUIElementRef)CFRetain(window);
    }
    BOOL hasUniqueBoundsMatch = boundsCandidateCount == 1;
    if (!matched && hasUniqueBoundsMatch && boundsMatched) {
      matched = boundsMatched;
      boundsMatched = nil;
    }
    if (boundsMatched) CFRelease(boundsMatched);
  }
  if (windowsValue) CFRelease(windowsValue);
  // Chrome 偶发在 AXWindows 尚未构建时返回空数组；focused/main window 是
  // 同一应用的备用入口，但必须经过编号、bounds 与标题指纹校验后才可采用。
  if (!matched && !apiUnavailable) {
    matched = CopyVerifiedWindowAttribute(
      application, kAXFocusedWindowAttribute, context, apiDisabled);
  }
  if (!matched && !apiUnavailable) {
    matched = CopyVerifiedWindowAttribute(
      application, kAXMainWindowAttribute, context, apiDisabled);
  }
  return matched;
}

/**
 * 判断 application 当前 focused window 是否就是目标窗口。
 * @param application 目标应用 AX 元素。
 * @param context 目标窗口上下文。
 * @param targetWindow 已定位的目标 AX 窗口。
 * @param apiDisabled 本轮 AX 接口禁用状态。
 * @return focused window 可按编号或边界确认属于目标窗口时返回 true。
 * @author zhenghq
 */
static BOOL FocusedWindowBelongsToTarget(
  AXUIElementRef application,
  WindowCaptureContext context,
  AXUIElementRef targetWindow,
  BOOL *apiDisabled
) {
  CFTypeRef focusedWindowValue = NULL;
  AXError error = AXUIElementCopyAttributeValue(
    application, kAXFocusedWindowAttribute, &focusedWindowValue);
  RecordApiDisabledError(error, apiDisabled);
  if (error != kAXErrorSuccess ||
      !focusedWindowValue || CFGetTypeID(focusedWindowValue) != AXUIElementGetTypeID()) {
    if (focusedWindowValue) CFRelease(focusedWindowValue);
    return NO;
  }
  AXUIElementRef focusedWindow = (AXUIElementRef)focusedWindowValue;
  BOOL matches = NO;
  if (context.windowNumber > 0 && CopyWindowNumber(focusedWindow) == context.windowNumber) {
    matches = YES;
  } else if (context.hasBounds) {
    CGRect focusedBounds = CGRectZero;
    CGRect targetBounds = CGRectZero;
    matches = CopyAXWindowBounds(focusedWindow, &focusedBounds) &&
      CopyAXWindowBounds(targetWindow, &targetBounds) &&
      WindowBoundsMatch(focusedBounds, targetBounds);
  }
  CFRelease(focusedWindowValue);
  return matches;
}

/**
 * 读取目标应用的普通窗口数量。
 * @param application 目标应用 AX 元素。
 * @param apiDisabled 本轮 AX 接口禁用状态。
 * @return AX 窗口列表中的窗口数量；读取失败返回 0。
 * @author zhenghq
 */
static CFIndex CopyWindowCount(AXUIElementRef application, BOOL *apiDisabled) {
  if (!application) return 0;
  CFTypeRef windowsValue = NULL;
  AXError error = AXUIElementCopyAttributeValue(
    application, kAXWindowsAttribute, &windowsValue);
  RecordApiDisabledError(error, apiDisabled);
  if (error != kAXErrorSuccess || !windowsValue ||
      CFGetTypeID(windowsValue) != CFArrayGetTypeID()) {
    if (windowsValue) CFRelease(windowsValue);
    return 0;
  }
  CFIndex count = CFArrayGetCount((CFArrayRef)windowsValue);
  CFRelease(windowsValue);
  return count;
}

/**
 * 按窗口上下文读取目标窗口内 focused element 的选中文本。
 * 先提升目标窗口再读取，优先从 application 的 focused UI element 读取；
 * 但只有 focused window 已确认属于目标窗口时才允许这样做，避免同进程其它
 * 窗口的焦点元素污染结果。窗口不存在、AX 属性不可读或没有选区时返回 nil。
 * @param application 目标应用 AX 元素。
 * @param context 目标窗口上下文。
 * @param apiDisabled 本轮 AX 接口禁用状态。
 * @param windowMatched 是否已精确定位目标窗口；未命中时置为 NO。
 * @return 命中的非空选中文本；无法命中返回 nil。
 * @author zhenghq
 */
static NSString *CopySelectedTextFromWindow(
  AXUIElementRef application,
  WindowCaptureContext context,
  BOOL *apiDisabled,
  NSString **focusStatus,
  BOOL *windowMatched
) {
  if (windowMatched) *windowMatched = NO;
  if (!application) {
    if (focusStatus) *focusStatus = @"unknown";
    return nil;
  }
  AXUIElementRef window = CopyWindowByContext(application, context, apiDisabled);
  if (!window) {
    if (focusStatus) *focusStatus = @"unknown";
    return nil;
  }
  if (windowMatched) *windowMatched = YES;
  // raise 失败不阻断读取：部分应用不支持 kAXRaiseAction，但仍可读取窗口内焦点元素。
  AXUIElementPerformAction(window, kAXRaiseAction);
  // 部分应用只有在读取 children 后才构建完整 AX 树；必须在获取 focused element
  // 之前触发，否则 Chrome、Word、Excel 等仍可能返回空的焦点元素。
  NSInteger visitedCount = 0;
  TouchDescendantElements(window, kMaxAxTouchDepth, &visitedCount);
  NSString *result = nil;
  // Chrome 等应用的选区挂在 application 的 focused UI element 上，而不是
  // window 元素本身。只有 focused window 已确认属于目标窗口时才读取该入口，
  // 防止同一进程的另一个窗口把错误选区返回给调用方。
  BOOL applicationFocusMatchesTarget =
    FocusedWindowBelongsToTarget(application, context, window, apiDisabled);
  if (applicationFocusMatchesTarget) {
    if (focusStatus) *focusStatus = @"ready";
    CFTypeRef focusedValue = NULL;
    AXError focusedError = AXUIElementCopyAttributeValue(
      application, kAXFocusedUIElementAttribute, &focusedValue);
    RecordApiDisabledError(focusedError, apiDisabled);
    if (focusedError == kAXErrorSuccess &&
        focusedValue && CFGetTypeID(focusedValue) == AXUIElementGetTypeID()) {
      result = CopySelectedTextFromAncestry((AXUIElementRef)focusedValue, kMaxAncestorLevels);
    }
    if (focusedValue) CFRelease(focusedValue);
  }
  // 兼容仍把 focused UI element 暴露在窗口元素上的应用。目标窗口已经由
  // AXWindows 按编号或边界精确命中，因此即使 Safari 等后台应用的
  // application AXFocusedWindow 暂时不可读，也必须独立尝试 window 焦点入口。
  if (!result) {
    if (focusStatus && !applicationFocusMatchesTarget) *focusStatus = @"target-mismatch";
    CFTypeRef focusedValue = NULL;
    AXError focusedError = AXUIElementCopyAttributeValue(
      window, kAXFocusedUIElementAttribute, &focusedValue);
    RecordApiDisabledError(focusedError, apiDisabled);
    if (focusedError == kAXErrorSuccess &&
        focusedValue && CFGetTypeID(focusedValue) == AXUIElementGetTypeID()) {
      result = CopySelectedTextFromAncestry((AXUIElementRef)focusedValue, kMaxAncestorLevels);
      if (result && focusStatus) *focusStatus = @"ready";
    }
    if (focusedValue) CFRelease(focusedValue);
  }
  // Safari/WebKit 有时既不暴露窗口焦点元素，也不把选区挂在应用焦点上。
  // 此时仅在已精确命中的目标窗口内做有界后代搜索，避免跨窗口误读。
  if (!result) {
    NSInteger selectionVisitedCount = 0;
    result = CopySelectedTextFromDescendants(window, kMaxAxSelectionSearchDepth,
                                            &selectionVisitedCount);
  }
  CFRelease(window);
  return result;
}

/**
 * 执行窗口级、系统焦点与鼠标位置三级 AX 选区读取。
 *
 * 该函数不写 stdout/stderr，CLI helper 与 N-API addon 共用同一套读取、
 * 窗口校验和 APIDisabled 判定，避免两条调用链长期漂移。
 * @param options 目标窗口、进程号、边界与标题指纹等可选上下文。
 * @return 结构化读取结果，调用方负责按协议输出或转换为 JS 对象。
 * @author zhenghq
 */
static MacosAxReadResult ReadMacosAxSelection(MacosAxReadOptions options) {
  MacosAxReadResult result = {
    MacosAxReadStatusUnknown, nil, nil, nil, NO, 0, nil
  };
  if (!AXIsProcessTrusted()) {
    result.status = MacosAxReadStatusPermission;
    result.reason = @"permission";
    return result;
  }

  AXUIElementRef systemWide = AXUIElementCreateSystemWide();
  if (!systemWide) return result;

  CFIndex targetWindowCount = 0;
  BOOL apiDisabled = NO;
  BOOL completed = NO;
  if (options.hasWindowArgument) {
    WindowCaptureContext context = {0};
    if (options.hasWindowNumber) context.windowNumber = options.windowNumber;
    if (options.hasBounds) {
      context.hasBounds = YES;
      context.bounds = options.bounds;
    }
    if (options.titleFingerprint.length > 0) {
      context.titleFingerprint = options.titleFingerprint;
    }

    if (context.windowNumber > 0 || context.hasBounds) {
      AXUIElementRef application = NULL;
      if (options.hasPid && options.pid > 0) {
        application = AXUIElementCreateApplication(options.pid);
      }
      if (!application) {
        CFTypeRef focusedAppValue = NULL;
        if (AXUIElementCopyAttributeValue(
              systemWide, kAXFocusedApplicationAttribute, &focusedAppValue) ==
              kAXErrorSuccess &&
            focusedAppValue &&
            CFGetTypeID(focusedAppValue) == AXUIElementGetTypeID()) {
          application = (AXUIElementRef)focusedAppValue;
        } else if (focusedAppValue) {
          CFRelease(focusedAppValue);
        }
      }
      targetWindowCount = CopyWindowCount(application, &apiDisabled);
      NSString *focusStatus = nil;
      BOOL windowMatched = NO;
      NSString *windowText = CopySelectedTextFromWindow(
        application, context, &apiDisabled, &focusStatus, &windowMatched);
      result.focusStatus = focusStatus;
      result.windowMatched = windowMatched;
      if (windowMatched) {
        result.windowLocate = @"exact";
        result.windowCount = targetWindowCount;
      }
      if (windowText) {
        result.status = MacosAxReadStatusPresent;
        result.text = windowText;
        completed = YES;
      }
      // 窗口入口的 APIDisabled 不能证明系统焦点与鼠标位置入口也不可用，
      // 这里只累计原因并继续后续入口，避免单点 -25211 直接放弃原生直读。
      if (application) CFRelease(application);
    }
    if (!result.focusStatus) {
      result.focusStatus = @"unknown";
    }
  }

  // 第一级与第二级：聚焦元素及其祖先链上的 AXSelectedText、marker range 与 text range。
  if (!completed) {
    CFTypeRef focused = NULL;
    AXError focusedError = AXUIElementCopyAttributeValue(
      systemWide, kAXFocusedUIElementAttribute, &focused);
    if (RecordApiDisabledError(focusedError, &apiDisabled)) {
      // 系统焦点入口失败时仍保留鼠标位置入口；部分应用只在该入口暴露选区。
      if (focused) CFRelease(focused);
    } else if (focusedError == kAXErrorSuccess && focused &&
        CFGetTypeID(focused) == AXUIElementGetTypeID()) {
      AXUIElementRef focusedElement = (AXUIElementRef)focused;
      NSString *text = CopySelectedTextFromAncestry(focusedElement, kMaxAncestorLevels);
      CFRelease(focused);
      if (text) {
        result.status = MacosAxReadStatusPresent;
        result.text = text;
        if (options.hasWindowArgument) {
          result.windowLocate = @"fallback";
          result.windowMatched = NO;
          result.windowCount = targetWindowCount;
        }
        completed = YES;
      }
    } else if (focused) {
      CFRelease(focused);
    }
  }

  // 第三级：鼠标位置元素及其最多 kMaxAncestorLevels 层祖先的选中文本。
  if (!completed) {
    AXError hoverError = kAXErrorSuccess;
    AXUIElementRef hoverElement = CopyElementAtMousePosition(systemWide, &hoverError);
    RecordApiDisabledError(hoverError, &apiDisabled);
    if (hoverElement) {
      NSString *hoverText = CopySelectedTextFromAncestry(hoverElement, kMaxAncestorLevels);
      CFRelease(hoverElement);
      if (hoverText) {
        result.status = MacosAxReadStatusPresent;
        result.text = hoverText;
        if (options.hasWindowArgument) {
          result.windowLocate = @"fallback";
          result.windowMatched = NO;
          result.windowCount = targetWindowCount;
        }
        completed = YES;
      }
    }
  }

  // systemWide 在所有入口尝试完成后统一释放，禁止各分支重复释放。
  CFRelease(systemWide);
  // 仅在所有入口均未命中时汇总失败诊断，避免覆盖已成功的 exact/fallback 结果。
  if (!completed) {
    // 任一路径明确返回 APIDisabled 时输出 api-disabled，供上层区分权限/系统
    // AX 故障与普通空选区。
    if (apiDisabled) {
      result.reason = @"api-disabled";
      result.focusStatus = @"unknown";
    }
    if (options.hasWindowArgument && !result.windowMatched) {
      result.windowLocate = @"failed";
      result.windowCount = targetWindowCount;
    }
  }
  return result;
}

#ifndef MACOS_AX_READER_NO_MAIN

/**
 * 入口：校验 Accessibility 授权后按三级顺序直读选区并输出协议结果。
 * @param argc 参数个数；可选 argv[1] 为目标窗口编号，argv[2] 为目标进程号，
 *             argv[3] 为窗口边界 JSON，argv[4] 为标题哈希指纹。
 * @param argv 参数列表。
 * @return 进程退出码，恒为 0；状态通过 stdout 协议表达。
 * @author zhenghq
 */
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (!AXIsProcessTrusted()) {
      BOOL isEnhanceMode = argc > 1 && argv[1] && strcmp(argv[1], "--enhance") == 0;
      WriteResult(isEnhanceMode ? @"REJECTED reason=permission" : @"PERMISSION", nil);
      return 0;
    }

    // 菜单复制动作模式：调用方传入目标进程号，helper 只在目标应用菜单栏中
    // 查找唯一启用的 Command+C 项并执行 AXPress，不读取或输出任何菜单标题。
    if (argc > 1 && argv[1] && strcmp(argv[1], "--copy") == 0) {
      char *pidEnd = NULL;
      long pid = argc > 2 && argv[2] ? strtol(argv[2], &pidEnd, 10) : 0;
      if (!pidEnd || *pidEnd != '\0' || pid <= 0) {
        WriteResult(@"UNAVAILABLE", nil);
        return 0;
      }
      WriteResult(PerformCommandCopyMenuAction((pid_t)pid)
                    ? @"PERFORMED" : @"UNAVAILABLE", nil);
      return 0;
    }

    // Chromium 增强 AX 模式：只设置目标应用属性并输出固定状态，不读取任何内容。
    if (argc > 1 && argv[1] && strcmp(argv[1], "--enhance") == 0) {
      char *pidEnd = NULL;
      long pid = argc > 2 && argv[2] ? strtol(argv[2], &pidEnd, 10) : 0;
      if (!pidEnd || *pidEnd != '\0' || pid <= 0) {
        WriteResult(@"REJECTED reason=invalid-pid", nil);
        return 0;
      }
      AXEnhancementResult enhancement = EnableEnhancedUserInterface((pid_t)pid);
      if (enhancement.accepted && enhancement.mode == AXEnhancementModeManual) {
        WriteResult(@"ACCEPTED mode=manual", nil);
      } else if (enhancement.accepted && enhancement.mode == AXEnhancementModeEnhanced) {
        WriteResult(@"ACCEPTED mode=enhanced", nil);
      } else if (!enhancement.permissionGranted) {
        WriteResult(@"REJECTED reason=permission", nil);
      } else if (!enhancement.applicationAvailable) {
        WriteResult(@"REJECTED reason=application-unavailable", nil);
      } else {
        WriteResult([NSString stringWithFormat:
          @"REJECTED reason=manual-%ld,enhanced-%ld",
          (long)enhancement.manualError, (long)enhancement.enhancedError], nil);
      }
      return 0;
    }

    MacosAxReadOptions options = {0};
    options.hasWindowArgument = argc > 1;
    if (argc > 1 && argv[1]) {
      if (strcmp(argv[1], "-") != 0) {
        char *end = NULL;
        long parsedWindowNumber = strtol(argv[1], &end, 10);
        if (end && *end == '\0' && parsedWindowNumber > 0) {
          options.hasWindowNumber = YES;
          options.windowNumber = parsedWindowNumber;
        }
      }
      if (argc > 3 && argv[3] && strcmp(argv[3], "-") != 0) {
        NSString *boundsJSON = [NSString stringWithUTF8String:argv[3]];
        NSData *boundsData = [boundsJSON dataUsingEncoding:NSUTF8StringEncoding];
        id parsedBounds = boundsData
          ? [NSJSONSerialization JSONObjectWithData:boundsData options:0 error:nil]
          : nil;
        if ([parsedBounds isKindOfClass:[NSDictionary class]]) {
          NSDictionary *boundsObject = (NSDictionary *)parsedBounds;
          NSNumber *x = boundsObject[@"x"];
          NSNumber *y = boundsObject[@"y"];
          NSNumber *width = boundsObject[@"width"];
          NSNumber *height = boundsObject[@"height"];
          if (x && y && width && height &&
            width.doubleValue > 0 && height.doubleValue > 0) {
            options.hasBounds = YES;
            options.bounds = CGRectMake(x.doubleValue, y.doubleValue,
                                        width.doubleValue, height.doubleValue);
          }
        }
      }
      if (argc > 4 && argv[4] && strcmp(argv[4], "-") != 0) {
        options.titleFingerprint = [NSString stringWithUTF8String:argv[4]];
      }
      if (argc > 2 && argv[2]) {
        char *pidEnd = NULL;
        long pid = strtol(argv[2], &pidEnd, 10);
        if (pidEnd && *pidEnd == '\0' && pid > 0) {
          options.hasPid = YES;
          options.pid = (pid_t)pid;
        }
      }
    }

    MacosAxReadResult result = ReadMacosAxSelection(options);
    if (result.windowLocate.length > 0) {
      WriteWindowDiagnostic(result.windowLocate, result.windowCount);
    }
    if (result.focusStatus.length > 0) {
      WriteFocusDiagnostic(result.focusStatus);
    }
    if (result.status == MacosAxReadStatusPresent) {
      WriteResult(@"PRESENT", result.text);
    } else if (result.status == MacosAxReadStatusEmpty) {
      WriteResult(@"EMPTY", nil);
    } else if (result.status == MacosAxReadStatusPermission) {
      WriteResult(@"PERMISSION", nil);
    } else if ([result.reason isEqualToString:@"api-disabled"]) {
      WriteResult(@"UNKNOWN reason=api-disabled", nil);
    } else {
      WriteResult(@"UNKNOWN", nil);
    }
    return 0;
  }
}

#endif
