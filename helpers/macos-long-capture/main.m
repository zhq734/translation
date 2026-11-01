/**
 * macOS 长截图常驻抓帧 helper。
 *
 * 协议（stdin/stdout，二进制安全）：
 *   capture <x> <y> <width> <height>\n
 *   ok <pngByteLength>\n<png bytes>
 *   err <utf8ByteLength>\n<utf8 bytes>
 *
 * 使用 ScreenCaptureKit 的 SCScreenshotManager.captureImageInRect（macOS 15.2+）。
 * 进程常驻可避免每帧冷启动 screencapture，滚动采样间隔才能稳定接近 90ms。
 * 坐标使用 Electron 全局逻辑点坐标，与 ScreenCaptureKit 屏幕空间一致。
 *
 * @author zhenghq
 */
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <ImageIO/ImageIO.h>

/** 单行命令最大长度，防止异常输入无限占用内存。 */
static const NSUInteger kMaxCommandLength = 1024;

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
  WriteError(@"macOS 15.2 or newer is required");
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
