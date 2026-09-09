/**
 * macOS AX 选区直读 helper。
 *
 * 直接调用 AXUIElement API 按序执行三级读取：
 *   1. 聚焦元素 AXSelectedText；
 *   2. 聚焦元素 AXSelectedTextMarkerRange 提取（覆盖 Safari/Chrome web area）；
 *   3. 鼠标位置元素及其最多 4 层祖先的 AXSelectedText。
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
 * 读取单个元素及其祖先链上的 AXSelectedText，命中第一个非空选区即返回。
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
 * 入口：校验 Accessibility 授权后按三级顺序直读选区并输出协议结果。
 * @param argc 参数个数（本 helper 不接收参数）。
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

    // 第一级与第二级：聚焦元素的 AXSelectedText 与 AXSelectedTextMarkerRange。
    CFTypeRef focused = NULL;
    AXError focusedError = AXUIElementCopyAttributeValue(
      systemWide, kAXFocusedUIElementAttribute, &focused);
    if (focusedError == kAXErrorSuccess && focused &&
        CFGetTypeID(focused) == AXUIElementGetTypeID()) {
      AXUIElementRef focusedElement = (AXUIElementRef)focused;
      NSString *text = CopyStringAttribute(focusedElement, kAXSelectedTextAttribute);
      if (text) {
        WriteResult(@"PRESENT", text);
        CFRelease(focused);
        CFRelease(systemWide);
        return 0;
      }
      NSString *markerText = CopySelectedTextViaMarkerRange(focusedElement);
      CFRelease(focused);
      if (markerText) {
        WriteResult(@"PRESENT", markerText);
        CFRelease(systemWide);
        return 0;
      }
    } else {
      if (focused) CFRelease(focused);
    }

    // 第三级：鼠标位置元素及其最多 kMaxAncestorLevels 层祖先的 AXSelectedText。
    AXUIElementRef hoverElement = CopyElementAtMousePosition(systemWide);
    if (hoverElement) {
      NSString *hoverText =
        CopySelectedTextFromAncestry(hoverElement, kMaxAncestorLevels);
      CFRelease(hoverElement);
      CFRelease(systemWide);
      if (hoverText) {
        WriteResult(@"PRESENT", hoverText);
        return 0;
      }
      WriteResult(@"UNKNOWN", nil);
      return 0;
    }

    CFRelease(systemWide);
    WriteResult(@"UNKNOWN", nil);
    return 0;
  }
}
