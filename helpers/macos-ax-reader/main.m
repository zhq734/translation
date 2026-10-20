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

/** 鼠标位置兜底允许沿 AXParent 上溯的最大祖先层数。 */
static const NSInteger kMaxAncestorLevels = 4;

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
 * 在目标应用的 AX 窗口列表中按窗口编号查找窗口。
 * @param application 目标应用 AX 元素。
 * @param windowNumber 目标窗口编号。
 * @return 命中的 AX 窗口；未命中返回 nil。调用方负责 CFRelease。
 * @author zhenghq
 */
static AXUIElementRef CopyWindowByNumber(AXUIElementRef application, long windowNumber) {
  CFTypeRef windowsValue = NULL;
  AXError error = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windowsValue);
  if (error != kAXErrorSuccess || !windowsValue ||
      CFGetTypeID(windowsValue) != CFArrayGetTypeID()) {
    if (windowsValue) CFRelease(windowsValue);
    return nil;
  }
  CFArrayRef windows = (CFArrayRef)windowsValue;
  AXUIElementRef matched = nil;
  CFIndex count = CFArrayGetCount(windows);
  for (CFIndex index = 0; index < count; index += 1) {
    AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
    if (!window || CFGetTypeID(window) != AXUIElementGetTypeID()) continue;
    if (CopyWindowNumber(window) == windowNumber) {
      matched = (AXUIElementRef)CFRetain(window);
      break;
    }
  }
  CFRelease(windowsValue);
  return matched;
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
 * 按窗口编号读取目标窗口内 focused element 的选中文本。
 * 先提升目标窗口再读取，确保微信等多窗口应用把输入焦点切回源窗口；
 * 窗口不存在、AX 属性不可读或没有选区时返回 nil，由调用方回退旧路径。
 * @param application 目标应用 AX 元素。
 * @param windowNumber 目标窗口编号。
 * @return 命中的非空选中文本；无法命中返回 nil。
 * @author zhenghq
 */
static NSString *CopySelectedTextFromWindow(AXUIElementRef application, long windowNumber) {
  if (!application) return nil;
  AXUIElementRef window = CopyWindowByNumber(application, windowNumber);
  if (!window) {
    return nil;
  }
  // 优先使用应用当前的 focused window，但仅当它的窗口编号与记录一致时采用。
  // 这样既能覆盖微信把焦点切回源窗口后的状态，也能避免误读另一个微信窗口。
  AXUIElementRef readWindow = window;
  CFTypeRef focusedWindowValue = NULL;
  if (AXUIElementCopyAttributeValue(
        application, kAXFocusedWindowAttribute, &focusedWindowValue) == kAXErrorSuccess &&
      focusedWindowValue && CFGetTypeID(focusedWindowValue) == AXUIElementGetTypeID() &&
      CopyWindowNumber((AXUIElementRef)focusedWindowValue) == windowNumber) {
    readWindow = (AXUIElementRef)CFRetain(focusedWindowValue);
  }
  if (focusedWindowValue) CFRelease(focusedWindowValue);
  // raise 失败不阻断读取：部分应用不支持 kAXRaiseAction，但仍可读取窗口内焦点元素。
  AXUIElementPerformAction(readWindow, kAXRaiseAction);
  CFTypeRef focusedValue = NULL;
  NSString *result = nil;
  if (AXUIElementCopyAttributeValue(
        readWindow, kAXFocusedUIElementAttribute, &focusedValue) == kAXErrorSuccess &&
      focusedValue && CFGetTypeID(focusedValue) == AXUIElementGetTypeID()) {
    AXUIElementRef focusedElement = (AXUIElementRef)focusedValue;
    result = CopyStringAttribute(focusedElement, kAXSelectedTextAttribute);
    if (!result) result = CopySelectedTextViaMarkerRange(focusedElement);
  }
  if (focusedValue) CFRelease(focusedValue);
  if (readWindow != window) CFRelease(readWindow);
  CFRelease(window);
  return result;
}

/**
 * 入口：校验 Accessibility 授权后按三级顺序直读选区并输出协议结果。
 * @param argc 参数个数；可选 argv[1] 为目标窗口编号，argv[2] 为目标进程号。
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

    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    if (!systemWide) {
      WriteResult(@"UNKNOWN", nil);
      return 0;
    }

    // 可选窗口级读取：仅在调用方明确传入窗口编号时执行。传入 pid 时直接
    // 创建目标应用 AX 元素，避免短暂焦点漂移导致读到另一个应用；参数非法或
    // 窗口不存在时回退原有三级读取，保持旧调用与跨应用兼容。
    CFIndex targetWindowCount = 0;
    if (argc > 1 && argv[1]) {
      char *end = NULL;
      long windowNumber = strtol(argv[1], &end, 10);
      if (end && *end == '\0' && windowNumber > 0) {
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
        NSString *windowText = CopySelectedTextFromWindow(application, windowNumber);
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
