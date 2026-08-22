#import <CoreImage/CoreImage.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <Vision/Vision.h>

/**
 * 向 stderr 写入一行错误信息。
 * @param message 错误信息。
 * @return 无返回值。
 * @author zhenghq
 */
static void WriteError(NSString *message) {
  NSData *data = [[message stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
  [NSFileHandle.fileHandleWithStandardError writeData:data];
}

/**
 * 将应用语言偏好映射为 Vision OCR 语言标签。
 * @param language 应用传入的语言偏好。
 * @return Vision 可识别的 BCP-47 语言标签数组。
 * @author zhenghq
 */
static NSArray<NSString *> *VisionLanguages(NSString *language) {
  if (language.length == 0 || [language isEqualToString:@"auto"]) {
    return @[ @"zh-Hans", @"zh-Hant", @"en-US", @"ja-JP", @"ko-KR" ];
  }

  NSDictionary<NSString *, NSArray<NSString *> *> *languageMap = @{
    @"zh": @[ @"zh-Hans", @"zh-Hant" ],
    @"zh-hans": @[ @"zh-Hans" ],
    @"zh-hant": @[ @"zh-Hant" ],
    @"en": @[ @"en-US" ],
    @"ja": @[ @"ja-JP" ],
    @"ko": @[ @"ko-KR" ],
    @"fr": @[ @"fr-FR" ],
    @"de": @[ @"de-DE" ],
    @"es": @[ @"es-ES" ],
    @"pt": @[ @"pt-BR" ],
    @"ru": @[ @"ru-RU" ],
    @"ar": @[ @"ar-SA" ]
  };

  NSArray<NSString *> *mapped = languageMap[language.lowercaseString];
  return mapped ?: @[ language ];
}

/**
 * 返回当前系统 Vision OCR 支持的最新 request revision。
 * @return Vision 支持的最新修订号。
 * @author zhenghq
 */
static NSUInteger LatestTextRecognitionRevision(void) {
  NSUInteger latestRevision = VNRecognizeTextRequest.supportedRevisions.lastIndex;
  return latestRevision == NSNotFound ? VNRecognizeTextRequest.defaultRevision : latestRevision;
}

/**
 * 过滤当前系统 Vision OCR 不支持的语言标签，避免请求整体失败。
 * @param requestedLanguages 应用希望使用的语言标签。
 * @param request Vision OCR 请求。
 * @return 当前系统支持的语言标签数组；没有匹配时返回空数组。
 * @author zhenghq
 */
static NSArray<NSString *> *SupportedVisionLanguages(NSArray<NSString *> *requestedLanguages, VNRecognizeTextRequest *request) {
  NSError *error = nil;
  NSArray<NSString *> *supportedLanguages = [request supportedRecognitionLanguagesAndReturnError:&error];
  if (supportedLanguages.count == 0) return @[];

  NSMutableArray<NSString *> *filtered = [NSMutableArray array];
  for (NSString *language in requestedLanguages) {
    if ([supportedLanguages containsObject:language]) {
      [filtered addObject:language];
    }
  }
  return filtered;
}

/**
 * 打印当前系统 Vision OCR 支持的 revision 和语言，便于诊断系统 OCR 能力。
 * @return 进程退出码。
 * @author zhenghq
 */
static int PrintSupportedLanguages(void) {
  VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  NSError *error = nil;
  NSArray<NSString *> *supportedLanguages = [request supportedRecognitionLanguagesAndReturnError:&error];
  printf("revision=%lu\n", (unsigned long)request.revision);
  if (error) {
    printf("error=%s:%ld:%s\n", error.domain.UTF8String, (long)error.code, error.localizedDescription.UTF8String);
  }
  for (NSString *language in supportedLanguages ?: @[]) {
    printf("%s\n", language.UTF8String);
  }
  return error ? 1 : 0;
}

/**
 * 按阅读顺序排序 Vision OCR 观察结果。
 * @param observations Vision 返回的文本观察结果。
 * @return 排序后的文本观察结果。
 * @author zhenghq
 */
static NSArray<VNRecognizedTextObservation *> *SortObservations(NSArray<VNRecognizedTextObservation *> *observations) {
  return [observations sortedArrayUsingComparator:^NSComparisonResult(VNRecognizedTextObservation *left, VNRecognizedTextObservation *right) {
    CGFloat yDistance = fabs(left.boundingBox.origin.y + left.boundingBox.size.height / 2.0 - right.boundingBox.origin.y - right.boundingBox.size.height / 2.0);
    if (yDistance > 0.02) {
      return left.boundingBox.origin.y > right.boundingBox.origin.y ? NSOrderedAscending : NSOrderedDescending;
    }
    return left.boundingBox.origin.x < right.boundingBox.origin.x ? NSOrderedAscending : NSOrderedDescending;
  }];
}

/**
 * 使用 Vision OCR 识别指定图片中的文字。
 * @param imagePath 本地图片路径。
 * @param language 语言偏好。
 * @param error 错误输出指针。
 * @return 每个识别文本行组成的数组。
 * @author zhenghq
 */
static NSArray<NSString *> *RecognizeText(NSString *imagePath, NSString *language, NSError **error) {
  NSURL *imageUrl = [NSURL fileURLWithPath:imagePath];
  CGImageSourceRef imageSource = CGImageSourceCreateWithURL((__bridge CFURLRef)imageUrl, NULL);
  CGImageRef image = imageSource ? CGImageSourceCreateImageAtIndex(imageSource, 0, NULL) : NULL;
  if (imageSource) CFRelease(imageSource);
  if (!image) {
    if (error) {
      *error = [NSError errorWithDomain:@"macos-vision-ocr"
                                   code:2
                               userInfo:@{ NSLocalizedDescriptionKey: [NSString stringWithFormat:@"cannot load image: %@", imagePath] }];
    }
    return nil;
  }

  VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = YES;
  NSArray<NSString *> *languages = SupportedVisionLanguages(VisionLanguages(language), request);
  if (languages.count > 0) request.recognitionLanguages = languages;

  VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
  BOOL ok = [handler performRequests:@[ request ] error:error];
  CGImageRelease(image);
  if (!ok) return nil;

  NSMutableArray<NSString *> *lines = [NSMutableArray array];
  for (VNRecognizedTextObservation *observation in SortObservations(request.results ?: @[])) {
    VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
    NSString *text = [candidate.string stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (text.length > 0) [lines addObject:text];
  }
  return lines;
}

/**
 * 运行命令行入口，处理版本参数和图片识别参数。
 * @param argc 参数数量。
 * @param argv 参数数组。
 * @return 进程退出码。
 * @author zhenghq
 */
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc > 1 && strcmp(argv[1], "--version") == 0) {
      printf("macos-vision-ocr 1.0\n");
      return 0;
    }
    if (argc > 1 && strcmp(argv[1], "--languages") == 0) {
      return PrintSupportedLanguages();
    }

    if (argc < 2) {
      WriteError(@"usage: macos-vision-ocr <image-path> [language]");
      return 64;
    }

    NSString *imagePath = [NSString stringWithUTF8String:argv[1]];
    NSString *language = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : @"auto";
    NSError *error = nil;
    NSArray<NSString *> *lines = RecognizeText(imagePath, language, &error);
    if (!lines) {
      NSString *reason = error.localizedDescription ?: @"Vision OCR failed";
      if (error) {
        reason = [NSString stringWithFormat:@"%@ (%@:%ld)", reason, error.domain, (long)error.code];
      }
      WriteError(reason);
      return 1;
    }

    for (NSString *line in lines) {
      printf("%s\n", line.UTF8String);
    }
    return 0;
  }
}
