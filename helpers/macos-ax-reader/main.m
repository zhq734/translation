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
 *   PRESENT 时其余行为选中文本；退出码恒为 0。
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
  // 部分 SDK 头文件未声明 kAXTextForRangeParameterizedAttribute，
  // 使用运行时属性名字符串，语义与常量一致。
  CFTypeRef text = NULL;
  AXError error = AXUIElementCopyParameterizedAttributeValue(
    element, CFSTR("AXTextForRange"), markerRange, &text);
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
 * 读取单个元素及其祖先链上的选中文本，命中第一个非空选区即返回。
 * 每层先读 AXSelectedText，失败后回退 AXSelectedTextMarkerRange，
 * 以覆盖 VS Code 注释、网页正文等不暴露 AXSelectedText 的自绘控件。
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
 * @return 鼠标位置元素；查询失败返回 nil。调用方负责 CFRelease。
 * @author zhenghq
 */
static AXUIElementRef CopyElementAtMousePosition(AXUIElementRef systemWide) {
  CGEventRef event = CGEventCreate(NULL);
  CGPoint point = CGEventGetLocation(event);
  CFRelease(event);
  AXUIElementRef element = NULL;
  if (AXUIElementCopyElementAtPosition(
        systemWide, (float)point.x, (float)point.y, &element) != kAXErrorSuccess) {
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
    AXValueGetValue((AXValueRef)positionValue, kAXValueCGPointType, &position) &&
    AXValueGetValue((AXValueRef)sizeValue, kAXValueCGSizeType, &size);
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
 * 在目标应用的 AX 窗口列表中按窗口上下文查找窗口。
 * 先按 AXWindowNumber 精确匹配；Chrome 普通多窗口可能不暴露该属性，
 * 此时再用 CGWindow 记录下来的 bounds 与标题指纹做二级匹配。
 * @param application 目标应用 AX 元素。
 * @param context 目标窗口上下文。
 * @return 命中的 AX 窗口；未命中返回 nil。调用方负责 CFRelease。
 * @author zhenghq
 */
static AXUIElementRef CopyWindowByContext(
  AXUIElementRef application,
  WindowCaptureContext context
) {
  CFTypeRef windowsValue = NULL;
  AXError error = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windowsValue);
  if (error != kAXErrorSuccess || !windowsValue ||
      CFGetTypeID(windowsValue) != CFArrayGetTypeID()) {
    if (windowsValue) CFRelease(windowsValue);
    return nil;
  }
  CFArrayRef windows = (CFArrayRef)windowsValue;
  AXUIElementRef matched = nil;
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
    if (!CopyAXWindowBounds(window, &windowBounds) || !WindowBoundsMatch(windowBounds, context.bounds)) {
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
  if (!matched && boundsCandidateCount > 1 && boundsMatched) {
    CFRelease(boundsMatched);
    boundsMatched = nil;
  }
  if (boundsMatched) CFRelease(boundsMatched);
  CFRelease(windowsValue);
  return matched;
}

/**
 * 判断 application 当前 focused window 是否就是目标窗口。
 * @param application 目标应用 AX 元素。
 * @param context 目标窗口上下文。
 * @param targetWindow 已定位的目标 AX 窗口。
 * @return focused window 可按编号或边界确认属于目标窗口时返回 true。
 * @author zhenghq
 */
static BOOL FocusedWindowBelongsToTarget(
  AXUIElementRef application,
  WindowCaptureContext context,
  AXUIElementRef targetWindow
) {
  CFTypeRef focusedWindowValue = NULL;
  if (AXUIElementCopyAttributeValue(
        application, kAXFocusedWindowAttribute, &focusedWindowValue) != kAXErrorSuccess ||
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
 * @return AX 窗口列表中的窗口数量；读取失败返回 0。
 * @author zhenghq
 */
static CFIndex CopyWindowCount(AXUIElementRef application) {
  if (!application) return 0;
  CFTypeRef windowsValue = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windowsValue) !=
        kAXErrorSuccess || !windowsValue ||
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
 * @return 命中的非空选中文本；无法命中返回 nil。
 * @author zhenghq
 */
static NSString *CopySelectedTextFromWindow(
  AXUIElementRef application,
  WindowCaptureContext context
) {
  if (!application) return nil;
  AXUIElementRef window = CopyWindowByContext(application, context);
  if (!window) {
    return nil;
  }
  // raise 失败不阻断读取：部分应用不支持 kAXRaiseAction，但仍可读取窗口内焦点元素。
  AXUIElementPerformAction(window, kAXRaiseAction);
  NSString *result = nil;
  // Chrome 等应用的选区挂在 application 的 focused UI element 上，而不是
  // window 元素本身。只有 focused window 已确认属于目标窗口时才读取，
  // 防止同一进程的另一个窗口把错误选区返回给调用方。
  if (FocusedWindowBelongsToTarget(application, context, window)) {
    CFTypeRef focusedValue = NULL;
    if (AXUIElementCopyAttributeValue(
          application, kAXFocusedUIElementAttribute, &focusedValue) == kAXErrorSuccess &&
        focusedValue && CFGetTypeID(focusedValue) == AXUIElementGetTypeID()) {
      result = CopySelectedTextFromAncestry((AXUIElementRef)focusedValue, 1);
    }
    if (focusedValue) CFRelease(focusedValue);
  }
  // 兼容仍把 focused UI element 暴露在窗口元素上的应用。
  if (!result) {
    CFTypeRef focusedValue = NULL;
    if (AXUIElementCopyAttributeValue(
          window, kAXFocusedUIElementAttribute, &focusedValue) == kAXErrorSuccess &&
        focusedValue && CFGetTypeID(focusedValue) == AXUIElementGetTypeID()) {
      result = CopySelectedTextFromAncestry((AXUIElementRef)focusedValue, 1);
    }
    if (focusedValue) CFRelease(focusedValue);
  }
  CFRelease(window);
  return result;
}

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
      WriteResult(@"PERMISSION", nil);
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

    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    if (!systemWide) {
      WriteResult(@"UNKNOWN", nil);
      return 0;
    }

    // 可选窗口级读取：调用方可传窗口编号和/或窗口边界。传入 pid 时直接
    // 创建目标应用 AX 元素，避免短暂焦点漂移导致读到另一个应用；参数非法或
    // 窗口不存在时回退原有三级读取，保持旧调用与跨应用兼容。
    CFIndex targetWindowCount = 0;
    if (argc > 1 && argv[1]) {
      WindowCaptureContext context = {0};
      if (strcmp(argv[1], "-") != 0) {
        char *end = NULL;
        long parsedWindowNumber = strtol(argv[1], &end, 10);
        if (end && *end == '\0' && parsedWindowNumber > 0) {
          context.windowNumber = parsedWindowNumber;
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
            context.hasBounds = YES;
            context.bounds = CGRectMake(x.doubleValue, y.doubleValue,
                                        width.doubleValue, height.doubleValue);
          }
        }
      }
      if (argc > 4 && argv[4] && strcmp(argv[4], "-") != 0) {
        context.titleFingerprint = [NSString stringWithUTF8String:argv[4]];
      }
      if (context.windowNumber > 0 || context.hasBounds) {
        AXUIElementRef application = NULL;
        if (argc > 2 && argv[2]) {
          char *pidEnd = NULL;
          long pid = strtol(argv[2], &pidEnd, 10);
          if (pidEnd && *pidEnd == '\0' && pid > 0) {
            application = AXUIElementCreateApplication((pid_t)pid);
          }
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
        targetWindowCount = CopyWindowCount(application);
        NSString *windowText = CopySelectedTextFromWindow(application, context);
        if (windowText) {
          WriteWindowDiagnostic(@"exact", targetWindowCount);
          WriteResult(@"PRESENT", windowText);
          if (application) CFRelease(application);
          CFRelease(systemWide);
          return 0;
        }
        if (application) CFRelease(application);
      }
    }

    // 第一级与第二级：聚焦元素的 AXSelectedText 与 AXSelectedTextMarkerRange。
    CFTypeRef focused = NULL;
    AXError focusedError = AXUIElementCopyAttributeValue(
      systemWide, kAXFocusedUIElementAttribute, &focused);
    if (focusedError == kAXErrorSuccess && focused &&
        CFGetTypeID(focused) == AXUIElementGetTypeID()) {
      AXUIElementRef focusedElement = (AXUIElementRef)focused;
      NSString *text = CopyStringAttribute(focusedElement, kAXSelectedTextAttribute);
      if (text) {
        if (argc > 1) WriteWindowDiagnostic(@"fallback", targetWindowCount);
        WriteResult(@"PRESENT", text);
        CFRelease(focused);
        CFRelease(systemWide);
        return 0;
      }
      NSString *markerText = CopySelectedTextViaMarkerRange(focusedElement);
      CFRelease(focused);
      if (markerText) {
        if (argc > 1) WriteWindowDiagnostic(@"fallback", targetWindowCount);
        WriteResult(@"PRESENT", markerText);
        CFRelease(systemWide);
        return 0;
      }
    } else {
      if (focused) CFRelease(focused);
    }

    // 第三级：鼠标位置元素及其最多 kMaxAncestorLevels 层祖先的选中文本。
    AXUIElementRef hoverElement = CopyElementAtMousePosition(systemWide);
    if (hoverElement) {
      NSString *hoverText =
        CopySelectedTextFromAncestry(hoverElement, kMaxAncestorLevels);
      CFRelease(hoverElement);
      CFRelease(systemWide);
      if (hoverText) {
        if (argc > 1) WriteWindowDiagnostic(@"fallback", targetWindowCount);
        WriteResult(@"PRESENT", hoverText);
        return 0;
      }
      if (argc > 1) WriteWindowDiagnostic(@"failed", targetWindowCount);
      WriteResult(@"UNKNOWN", nil);
      return 0;
    }

    CFRelease(systemWide);
    if (argc > 1) WriteWindowDiagnostic(@"failed", targetWindowCount);
    WriteResult(@"UNKNOWN", nil);
    return 0;
  }
}
