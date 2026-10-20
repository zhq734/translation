/**
 * macOS 窗口枚举与精确激活 helper。
 *
 * 子命令：
 *   list <pid>               输出该进程普通窗口与全局最前普通窗口的 JSON 对象
 *   raise <pid> <windowNumber> 通过 AXRaise 提升指定窗口（焦点确认由 Node 侧轮询）
 *   focused <pid>            输出该进程当前 focused window 编号
 *
 * 所有输出均为单行 JSON；失败时输出 {"ok":false} 并以非零退出码结束。
 * list 只读取 CGWindowList，不等待目标应用的 AX 响应；标题仅用于本地窗口匹配，
 * 不写入任何持久化文件。raise/focused 子命令才使用 AX。
 *
 * @author zhenghq
 */
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

/**
 * 将对象序列化为单行 JSON 并写入 stdout。
 * @param object 可序列化对象。
 * @return 无返回值。
 * @author zhenghq
 */
static void WriteJSON(NSDictionary *object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  if (!data) {
    fputs("{\"ok\":false}\n", stdout);
    return;
  }
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
}

/**
 * 读取 AX 元素的窗口编号属性。
 * @param element AX 窗口元素。
 * @return 窗口编号；不可用时返回 nil。
 * @author zhenghq
 */
static NSNumber *CopyWindowNumber(AXUIElementRef element) {
  CFTypeRef value = NULL;
  // 部分 macOS SDK 未声明 kAXWindowNumberAttribute，使用运行时属性名保持兼容。
  if (AXUIElementCopyAttributeValue(element, CFSTR("AXWindowNumber"), &value) != kAXErrorSuccess || !value) {
    return nil;
  }
  if (CFGetTypeID(value) != CFNumberGetTypeID()) {
    CFRelease(value);
    return nil;
  }
  NSNumber *number = (__bridge_transfer NSNumber *)value;
  return number;
}

/**
 * 通过 CGWindowList 枚举指定进程的普通窗口。
 *
 * 微信等应用在 AXWindows/AXTitle 上可能阻塞数百毫秒，窗口枚举必须只依赖
 * CGWindowList；窗口编号与边界已足够完成精确匹配，标题缺失只影响二级指纹匹配。
 * @param pid 目标进程号。
 * @return 窗口字典数组；CGWindowList 不可用时返回 nil。
 * @author zhenghq
 */
static NSArray<NSDictionary *> *EnumerateWindows(pid_t pid) {
  CFArrayRef windowList = CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID
  );
  if (!windowList) return nil;

  NSMutableArray<NSDictionary *> *result = [NSMutableArray array];
  CFArrayRef cgWindows = windowList;
  for (CFIndex index = 0; index < CFArrayGetCount(cgWindows); index += 1) {
    NSDictionary *window = (__bridge NSDictionary *)CFArrayGetValueAtIndex(cgWindows, index);
    NSNumber *ownerPid = window[(NSString *)kCGWindowOwnerPID];
    NSNumber *windowNumber = window[(NSString *)kCGWindowNumber];
    NSNumber *layer = window[(NSString *)kCGWindowLayer];
    NSDictionary *bounds = window[(NSString *)kCGWindowBounds];
    if (!ownerPid || ownerPid.intValue != pid || !windowNumber || !layer || !bounds) continue;
    if (layer.intValue != 0) continue;
    // 使用字符串键读取 CGWindow bounds，避免依赖不同 SDK 的常量导出。
    NSNumber *x = bounds[@"X"];
    NSNumber *y = bounds[@"Y"];
    NSNumber *width = bounds[@"Width"];
    NSNumber *height = bounds[@"Height"];
    if (!x || !y || !width || !height || width.doubleValue <= 0 || height.doubleValue <= 0) continue;
    // CGWindowName 是可选字段：屏幕录制权限不足或应用未提供时为空串，
    // 不影响按窗口编号和边界定位，也不得回退到同步 AX 标题读取。
    id titleValue = window[(NSString *)kCGWindowName];
    NSString *title = [titleValue isKindOfClass:[NSString class]] ? (NSString *)titleValue : @"";
    [result addObject:@{
      @"pid": @(pid),
      @"windowNumber": windowNumber,
      @"layer": layer,
      @"title": title,
      @"bounds": @{
        @"x": x,
        @"y": y,
        @"width": width,
        @"height": height
      }
    }];
  }

  CFRelease(windowList);
  return result;
}

/**
 * 从 CGWindowList 读取全局最前普通窗口。
 *
 * CGWindowListCopyWindowInfo 返回顺序为从前到后；第一个 layer=0 且具有
 * 有效边界与窗口编号的窗口，就是当前最前普通窗口。这里不读取 AX，
 * 避免微信 AXFocusedWindow 返回 -25201 或阻塞时污染窗口枚举。
 * @return 包含 frontmostWindowNumber 与 frontmostPid 的字典；列表不可用或无法确定时为空字典。
 * @author zhenghq
 */
static NSDictionary *ReadFrontmostWindow() {
  CFArrayRef windowList = CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID
  );
  if (!windowList) return @{};

  NSDictionary *result = @{};
  CFArrayRef cgWindows = windowList;
  for (CFIndex index = 0; index < CFArrayGetCount(cgWindows); index += 1) {
    NSDictionary *window = (__bridge NSDictionary *)CFArrayGetValueAtIndex(cgWindows, index);
    NSNumber *ownerPid = window[(NSString *)kCGWindowOwnerPID];
    NSNumber *windowNumber = window[(NSString *)kCGWindowNumber];
    NSNumber *layer = window[(NSString *)kCGWindowLayer];
    NSDictionary *bounds = window[(NSString *)kCGWindowBounds];
    if (!ownerPid || !windowNumber || !layer || !bounds || layer.intValue != 0) continue;
    NSNumber *width = bounds[@"Width"];
    NSNumber *height = bounds[@"Height"];
    if (!width || !height || width.doubleValue <= 0 || height.doubleValue <= 0) continue;
    result = @{
      @"frontmostWindowNumber": windowNumber,
      @"frontmostPid": ownerPid
    };
    break;
  }

  CFRelease(windowList);
  return result;
}

/**
 * 在应用 AX 窗口中查找指定窗口编号。
 * @param appElement 应用 AX 元素。
 * @param windowNumber 目标窗口编号。
 * @return 匹配窗口；未找到返回 NULL。
 * @author zhenghq
 */
static AXUIElementRef CopyAXWindowByNumber(AXUIElementRef appElement, NSNumber *windowNumber) {
  CFTypeRef windowsValue = NULL;
  if (!appElement ||
      AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute, &windowsValue) != kAXErrorSuccess ||
      !windowsValue || CFGetTypeID(windowsValue) != CFArrayGetTypeID()) {
    return NULL;
  }
  AXUIElementRef matched = NULL;
  CFArrayRef windows = (CFArrayRef)windowsValue;
  for (CFIndex index = 0; index < CFArrayGetCount(windows); index += 1) {
    AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
    if (!window || CFGetTypeID(window) != AXUIElementGetTypeID()) continue;
    NSNumber *number = CopyWindowNumber(window);
    if (number && [number isEqualToNumber:windowNumber]) {
      matched = (AXUIElementRef)CFRetain(window);
      break;
    }
  }
  CFRelease(windowsValue);
  return matched;
}

/**
 * 读取应用当前 focused window 编号。
 * @param appElement 应用 AX 元素。
 * @return focused window 编号；不可用时返回 nil。
 * @author zhenghq
 */
static NSNumber *CopyFocusedWindowNumber(AXUIElementRef appElement) {
  CFTypeRef focused = NULL;
  if (!appElement ||
      AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute, &focused) != kAXErrorSuccess ||
      !focused || CFGetTypeID(focused) != AXUIElementGetTypeID()) {
    return nil;
  }
  NSNumber *number = CopyWindowNumber((AXUIElementRef)focused);
  CFRelease(focused);
  return number;
}

/**
 * 提升指定窗口，只报告 AXRaise 动作本身是否成功。
 * focused window 切换是异步的，立即读取会把正常激活误判为失败；确认由 Node 侧轮询。
 * @param pid 目标进程号。
 * @param windowNumber 目标窗口编号。
 * @return AXRaise 动作成功时返回 true。
 * @author zhenghq
 */
static BOOL RaiseWindow(pid_t pid, NSNumber *windowNumber) {
  AXUIElementRef appElement = AXUIElementCreateApplication(pid);
  AXUIElementRef window = CopyAXWindowByNumber(appElement, windowNumber);
  if (!window) {
    if (appElement) CFRelease(appElement);
    return NO;
  }
  AXError raiseError = AXUIElementPerformAction(window, kAXRaiseAction);
  BOOL raised = raiseError == kAXErrorSuccess;
  CFRelease(window);
  if (appElement) CFRelease(appElement);
  return raised;
}

/**
 * 输出指定进程当前 focused window 编号。
 * @param pid 目标进程号。
 * @return 无返回值。
 * @author zhenghq
 */
static void WriteFocusedWindow(pid_t pid) {
  AXUIElementRef appElement = AXUIElementCreateApplication(pid);
  NSNumber *number = CopyFocusedWindowNumber(appElement);
  if (appElement) CFRelease(appElement);
  if (!number) {
    WriteJSON(@{@"ok": @NO});
    exit(1);
  }
  WriteJSON(@{@"ok": @YES, @"windowNumber": number});
}

/**
 * helper 入口：解析子命令并输出 JSON。
 * @param argc 参数数量。
 * @param argv 参数数组。
 * @return 进程退出码。
 * @author zhenghq
 */
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 3) {
      WriteJSON(@{@"ok": @NO});
      return 2;
    }
    NSString *command = [NSString stringWithUTF8String:argv[1]];
    pid_t pid = (pid_t)atoi(argv[2]);
    if (pid <= 0) {
      WriteJSON(@{@"ok": @NO});
      return 2;
    }
    if ([command isEqualToString:@"list"]) {
      NSArray<NSDictionary *> *windows = EnumerateWindows(pid);
      // 空数组代表“成功枚举但没有普通窗口”，nil 代表 CGWindowList 本身不可用；
      // 两者不能混用，否则 Node 侧会把系统查询失败误报为 windowCount=0。
      if (!windows) {
        WriteJSON(@{@"ok": @NO, @"error": @"window-list-unavailable"});
        return 1;
      }
      NSMutableDictionary *response = [@{@"ok": @YES, @"windows": windows} mutableCopy];
      [response addEntriesFromDictionary:ReadFrontmostWindow()];
      WriteJSON(response);
      return 0;
    }
    if ([command isEqualToString:@"raise"]) {
      if (argc < 4) {
        WriteJSON(@{@"ok": @NO});
        return 2;
      }
      NSNumber *windowNumber = @(atoi(argv[3]));
      BOOL raised = RaiseWindow(pid, windowNumber);
      WriteJSON(@{@"ok": @YES, @"raised": @(raised), @"windowNumber": windowNumber});
      return raised ? 0 : 1;
    }
    if ([command isEqualToString:@"focused"]) {
      WriteFocusedWindow(pid);
      return 0;
    }
    WriteJSON(@{@"ok": @NO});
    return 2;
  }
}
