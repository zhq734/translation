/**
 * macOS OCR 区域截图 helper。
 *
 * 协议（stdin/stdout，二进制安全）：
 *   capture <x> <y> <width> <height>\n
 *   ok <pngByteLength>\n<png bytes>
 *   err <utf8ByteLength>\n<utf8 bytes>
 *
 * macOS 15.2+ 使用 SCScreenshotManager.captureImageInRect 直接按全局区域截图；
 * macOS 14.2-15.1 使用显示器内容过滤器配合 SCStreamConfiguration.sourceRect。
 * 进程常驻可避免每次截图冷启动，并在截图完成后立即回包，不依赖 screencapture
 * 子进程退出。
 *
 * 坐标使用 Electron 全局逻辑点坐标，与 ScreenCaptureKit 屏幕空间一致。
 *
 * @author zhenghq
 */
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <ImageIO/ImageIO.h>

/** 单行命令最大长度，防止异常输入无限占用内存。 */
enum { kMaxCommandLength = 1024 };

/**
 * 读取 stdin 的一行 ASCII 命令，不使用 scanf，避免与二进制输出缓冲相互干扰。
 * @return 命令字符串；EOF 或超长时返回 nil。
 * @author zhenghq
 */
static NSString *ReadCommandLine(void) {
  char buffer[kMaxCommandLength];
  NSUInteger length = 0;
  while (length < sizeof(buffer) - 1) {
    char byte = 0;
    size_t count = fread(&byte, 1, 1, stdin);
    if (count == 0) {
      return length == 0 ? nil : [[NSString alloc] initWithBytes:buffer length:length encoding:NSUTF8StringEncoding];
    }
    if (byte == '\n') break;
    buffer[length++] = byte;
  }
  return [[NSString alloc] initWithBytes:buffer length:length encoding:NSUTF8StringEncoding];
}

/**
 * 将错误文本以二进制安全协议写入 stdout。
 * @param message 错误文本。
 * @return 无返回值。
 * @author zhenghq
 */
static void WriteError(NSString *message) {
  NSData *data = [(message ?: @"capture failed") dataUsingEncoding:NSUTF8StringEncoding];
  fprintf(stdout, "err %zu\n", (size_t)data.length);
  fwrite(data.bytes, 1, data.length, stdout);
  fflush(stdout);
}

/**
 * 将 CGImage 编码为 PNG 并按协议写入 stdout。
 * @param image ScreenCaptureKit 返回的截图。
 * @return 无返回值。
 * @author zhenghq
 */
static void WriteImage(CGImageRef image) {
  if (!image) {
    WriteError(@"empty image");
    return;
  }
  NSMutableData *data = [NSMutableData data];
  CGImageDestinationRef destination = CGImageDestinationCreateWithData(
    (__bridge CFMutableDataRef)data,
    CFSTR("public.png"),
    1,
    NULL
  );
  if (!destination) {
    WriteError(@"cannot create PNG encoder");
    return;
  }
  CGImageDestinationAddImage(destination, image, NULL);
  BOOL ok = CGImageDestinationFinalize(destination);
  CFRelease(destination);
  if (!ok || data.length == 0) {
    WriteError(@"PNG encoding failed");
    return;
  }
  fprintf(stdout, "ok %zu\n", (size_t)data.length);
  fwrite(data.bytes, 1, data.length, stdout);
  fflush(stdout);
}

/**
 * 在可用显示器中选择与目标区域相交面积最大的显示器。
 * @param content ScreenCaptureKit 返回的可共享内容。
 * @param rect 全局屏幕逻辑点坐标下的目标区域。
 * @param clippedRect 输出参数，返回目标区域与所选显示器的交集。
 * @return 最匹配的显示器；没有交集时返回 nil。
 * @author zhenghq
 */
static SCDisplay *FindDisplayForRect(SCShareableContent *content, CGRect rect, CGRect *clippedRect) {
  SCDisplay *bestDisplay = nil;
  CGRect bestIntersection = CGRectNull;
  CGFloat bestArea = 0;
  for (SCDisplay *display in content.displays) {
    CGRect intersection = CGRectIntersection(rect, display.frame);
    if (CGRectIsNull(intersection) || CGRectIsEmpty(intersection)) continue;
    CGFloat area = intersection.size.width * intersection.size.height;
    if (area > bestArea) {
      bestArea = area;
      bestDisplay = display;
      bestIntersection = intersection;
    }
  }
  if (clippedRect) *clippedRect = bestIntersection;
  return bestDisplay;
}

/**
 * 使用 macOS 14.0 提供的截图过滤器 API 采集单个显示器内的目标区域。
 * @param rect 全局屏幕逻辑点坐标下的目标区域。
 * @return 无返回值。
 * @author zhenghq
 */
static void CaptureWithContentFilter(CGRect rect) {
  dispatch_semaphore_t contentSemaphore = dispatch_semaphore_create(0);
  __block SCShareableContent *shareableContent = nil;
  __block NSError *contentError = nil;
  [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *content, NSError *error) {
    shareableContent = content;
    contentError = error;
    dispatch_semaphore_signal(contentSemaphore);
  }];
  long contentWaitResult = dispatch_semaphore_wait(
    contentSemaphore,
    dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)
  );
  if (contentWaitResult != 0) {
    WriteError(@"timed out waiting for shareable content");
    return;
  }
  if (contentError || !shareableContent) {
    WriteError(contentError.localizedDescription ?: @"cannot read shareable content");
    return;
  }

  CGRect clippedRect = CGRectNull;
  SCDisplay *display = FindDisplayForRect(shareableContent, rect, &clippedRect);
  if (!display || CGRectIsNull(clippedRect) || CGRectIsEmpty(clippedRect)) {
    WriteError(@"capture rect is outside available displays");
    return;
  }

  SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
  SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
  configuration.sourceRect = CGRectMake(
    clippedRect.origin.x - display.frame.origin.x,
    clippedRect.origin.y - display.frame.origin.y,
    clippedRect.size.width,
    clippedRect.size.height
  );
  CGFloat scaleX = display.frame.size.width > 0
    ? CGDisplayPixelsWide(display.displayID) / display.frame.size.width
    : 1;
  CGFloat scaleY = display.frame.size.height > 0
    ? CGDisplayPixelsHigh(display.displayID) / display.frame.size.height
    : 1;
  configuration.width = MAX(1, lround(clippedRect.size.width * scaleX));
  configuration.height = MAX(1, lround(clippedRect.size.height * scaleY));
  configuration.showsCursor = NO;
  configuration.scalesToFit = YES;

  dispatch_semaphore_t captureSemaphore = dispatch_semaphore_create(0);
  __block CGImageRef captured = NULL;
  __block NSError *captureError = nil;
  [SCScreenshotManager captureImageWithFilter:filter
                               configuration:configuration
                           completionHandler:^(CGImageRef image, NSError *error) {
    if (image) captured = CGImageRetain(image);
    captureError = error;
    dispatch_semaphore_signal(captureSemaphore);
  }];
  long captureWaitResult = dispatch_semaphore_wait(
    captureSemaphore,
    dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)
  );
  if (captureWaitResult != 0) {
    WriteError(@"timed out waiting for screenshot capture");
    return;
  }
  if (!captured) {
    WriteError(captureError.localizedDescription ?: @"screen capture failed");
    return;
  }
  WriteImage(captured);
  CGImageRelease(captured);
}

/**
 * 解析并执行一次 capture 命令。
 * @param command stdin 读取到的单行命令。
 * @return 无返回值。
 * @author zhenghq
 */
static void HandleCommand(NSString *command) {
  NSArray<NSString *> *parts = [command componentsSeparatedByCharactersInSet:
    [NSCharacterSet whitespaceCharacterSet]];
  NSMutableArray<NSString *> *tokens = [NSMutableArray array];
  for (NSString *part in parts) {
    if (part.length > 0) [tokens addObject:part];
  }
  if (tokens.count != 5 || ![tokens[0] isEqualToString:@"capture"]) {
    WriteError(@"invalid command");
    return;
  }
  double x = tokens[1].doubleValue;
  double y = tokens[2].doubleValue;
  double width = tokens[3].doubleValue;
  double height = tokens[4].doubleValue;
  if (width <= 0 || height <= 0 || !isfinite(x) || !isfinite(y) || !isfinite(width) || !isfinite(height)) {
    WriteError(@"invalid rect");
    return;
  }

  if (@available(macOS 15.2, *)) {
    CGRect rect = CGRectMake(x, y, width, height);
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block CGImageRef captured = NULL;
    __block NSError *captureError = nil;
    [SCScreenshotManager captureImageInRect:rect completionHandler:^(CGImageRef image, NSError *error) {
      if (image) captured = CGImageRetain(image);
      captureError = error;
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    if (!captured) {
      WriteError(captureError.localizedDescription ?: @"screen capture failed");
      return;
    }
    WriteImage(captured);
    CGImageRelease(captured);
    return;
  }
  CaptureWithContentFilter(CGRectMake(x, y, width, height));
}

/**
 * 常驻处理 stdin 命令，直到父进程关闭管道。
 * @return 进程退出码。
 * @author zhenghq
 */
int main(void) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    while (YES) {
      @autoreleasepool {
        NSString *command = ReadCommandLine();
        if (!command) break;
        if (command.length > 0) HandleCommand(command);
      }
    }
  }
  return 0;
}
