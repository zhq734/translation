/**
 * macOS AX 选区读取 N-API addon。
 *
 * 本文件只负责 Node-API 参数与结果适配；真正的窗口定位、选区读取、
 * 菜单复制和 Chromium AX 增强均复用 main.m 中的同一套实现。其中选区
 * 读取继续复用 CopySelectedTextFromWindow 与 CopySelectedTextFromAncestry，
 * 所有 AX 调用都在 libuv 线程池执行，避免阻塞 Electron 主线程。
 *
 * @author zhenghq
 */
#define MACOS_AX_READER_NO_MAIN
#include "main.m"

#include <node_api.h>

#include <cmath>
#include <string>

/** addon 支持的三类异步操作。 */
enum MacosAxAddonOperation {
  MacosAxAddonOperationReadSelection = 0,
  MacosAxAddonOperationPerformCopy,
  MacosAxAddonOperationEnhanceAccessibility
};

/** 可跨线程传递的选区读取结果；不持有 Objective-C 对象。 */
struct MacosAxAddonReadResult {
  MacosAxReadStatus status = MacosAxReadStatusUnknown;
  std::string text;
  std::string reason;
  std::string windowLocate;
  bool hasWindowLocate = false;
  bool windowMatched = false;
  bool hasWindowCount = false;
  CFIndex windowCount = 0;
  std::string focusStatus;
  bool hasFocusStatus = false;
};

/** 可跨线程传递的 Chromium AX 增强结果。 */
struct MacosAxAddonEnhancementResult {
  bool permissionGranted = false;
  bool applicationAvailable = false;
  bool accepted = false;
  AXEnhancementMode mode = AXEnhancementModeNone;
  AXError manualError = kAXErrorSuccess;
  AXError enhancedError = kAXErrorSuccess;
};

/** 一次异步 N-API 调用的输入、输出与 Promise 生命周期。 */
struct MacosAxAddonWork {
  napi_env env = nullptr;
  napi_deferred deferred = nullptr;
  napi_async_work work = nullptr;
  MacosAxAddonOperation operation = MacosAxAddonOperationReadSelection;
  MacosAxReadOptions options = {0};
  /** 标题指纹的可跨线程副本；仅在 AX 工作线程内转换为 NSString。 */
  std::string titleFingerprintUtf8;
  pid_t pid = 0;
  MacosAxAddonReadResult readResult;
  MacosAxAddonEnhancementResult enhancementResult;
  bool copyPerformed = false;
  bool copyPermissionGranted = false;
  std::string error;
};

/**
 * 将 Objective-C 字符串复制为可安全跨线程保存的 UTF-8 字符串。
 * @param value 待复制字符串，可为 nil。
 * @return UTF-8 字符串副本；nil 或编码失败时返回空串。
 * @author zhenghq
 */
static std::string CopyMacosAxUtf8String(NSString *value) {
  if (value == nil) return std::string();
  const char *utf8 = value.UTF8String;
  return utf8 ? std::string(utf8) : std::string();
}

/**
 * 读取 JS 对象的可选数值属性。
 * @param env Node-API 环境。
 * @param object JS 对象。
 * @param name 属性名。
 * @param value 输出数值。
 * @return 属性存在且为数值时返回 true。
 * @author zhenghq
 */
static bool ReadOptionalNumber(
  napi_env env,
  napi_value object,
  const char *name,
  double *value
) {
  bool hasProperty = false;
  if (napi_has_named_property(env, object, name, &hasProperty) != napi_ok || !hasProperty) {
    return false;
  }
  napi_value property = nullptr;
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, object, name, &property) != napi_ok ||
      napi_typeof(env, property, &type) != napi_ok || type != napi_number) {
    return false;
  }
  return napi_get_value_double(env, property, value) == napi_ok && std::isfinite(*value);
}

/**
 * 读取 JS 对象的可选字符串属性。
 * @param env Node-API 环境。
 * @param object JS 对象。
 * @param name 属性名。
 * @return 属性存在且为字符串时返回其内容；否则返回空串。
 * @author zhenghq
 */
static std::string ReadOptionalString(napi_env env, napi_value object, const char *name) {
  bool hasProperty = false;
  if (napi_has_named_property(env, object, name, &hasProperty) != napi_ok || !hasProperty) {
    return std::string();
  }
  napi_value property = nullptr;
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, object, name, &property) != napi_ok ||
      napi_typeof(env, property, &type) != napi_ok || type != napi_string) {
    return std::string();
  }
  size_t length = 0;
  if (napi_get_value_string_utf8(env, property, nullptr, 0, &length) != napi_ok) {
    return std::string();
  }
  std::string result(length, '\0');
  if (length == 0) return result;
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, property, &result[0], length + 1, &copied) != napi_ok) {
    return std::string();
  }
  result.resize(copied);
  return result;
}

/**
 * 解析 addon 选区读取参数。
 * @param env Node-API 环境。
 * @param args JS 参数数组。
 * @param argc 参数数量。
 * @param work 输出异步工作项；Objective-C 字段必须保持为空，稍后在线程池内创建。
 * @return 参数合法时返回 true；否则在 env 上抛出类型错误。
 * @author zhenghq
 */
static bool ParseReadSelectionArguments(
  napi_env env,
  napi_value args[],
  size_t argc,
  MacosAxAddonWork *work
) {
  MacosAxReadOptions *options = &work->options;
  *options = {0};
  if (argc == 0) return true;

  napi_valuetype optionsType = napi_undefined;
  if (napi_typeof(env, args[0], &optionsType) != napi_ok) return false;
  if (optionsType == napi_undefined || optionsType == napi_null) return true;
  if (optionsType != napi_object) {
    napi_throw_type_error(env, nullptr, "readSelection options must be an object");
    return false;
  }

  options->hasWindowArgument = true;
  double number = 0;
  if (ReadOptionalNumber(env, args[0], "windowNumber", &number) &&
      number > 0 && number <= 9007199254740991.0) {
    options->hasWindowNumber = YES;
    options->windowNumber = (long)number;
  }
  if (ReadOptionalNumber(env, args[0], "pid", &number) &&
      number > 0 && number <= INT_MAX) {
    options->hasPid = YES;
    options->pid = (pid_t)number;
  }

  bool hasBounds = false;
  napi_value bounds = nullptr;
  napi_valuetype boundsType = napi_undefined;
  if (napi_get_named_property(env, args[0], "bounds", &bounds) == napi_ok &&
      napi_typeof(env, bounds, &boundsType) == napi_ok && boundsType == napi_object) {
    double x = 0;
    double y = 0;
    double width = 0;
    double height = 0;
    hasBounds = ReadOptionalNumber(env, bounds, "x", &x) &&
      ReadOptionalNumber(env, bounds, "y", &y) &&
      ReadOptionalNumber(env, bounds, "width", &width) &&
      ReadOptionalNumber(env, bounds, "height", &height) &&
      width > 0 && height > 0;
    if (hasBounds) {
      options->hasBounds = YES;
      options->bounds = CGRectMake(x, y, width, height);
    }
  }

  work->titleFingerprintUtf8 = ReadOptionalString(env, args[0], "titleFingerprint");
  return true;
}

/**
 * 解析单 PID 参数，供菜单复制与 AX 增强接口复用。
 * @param env Node-API 环境。
 * @param args JS 参数数组。
 * @param argc 参数数量。
 * @param pid 输出进程号。
 * @return 参数为有效正整数时返回 true；否则抛出类型或范围错误。
 * @author zhenghq
 */
static bool ParsePidArgument(napi_env env, napi_value args[], size_t argc, pid_t *pid) {
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "pid is required");
    return false;
  }
  napi_valuetype type = napi_undefined;
  double value = 0;
  if (napi_typeof(env, args[0], &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, args[0], &value) != napi_ok ||
      !std::isfinite(value) || value <= 0 || value > INT_MAX || std::floor(value) != value) {
    napi_throw_type_error(env, nullptr, "pid must be a positive integer");
    return false;
  }
  *pid = (pid_t)value;
  return true;
}

/**
 * 在 libuv 工作线程中执行 AX 操作。
 * @param env Node-API 环境；工作线程中不得调用 N-API。
 * @param data MacosAxAddonWork 指针。
 * @return 无返回值。
 * @author zhenghq
 */
static void ExecuteMacosAxAddonWork(napi_env env, void *data) {
  (void)env;
  MacosAxAddonWork *work = static_cast<MacosAxAddonWork *>(data);
  if (!work) return;
  @autoreleasepool {
    if (work->operation == MacosAxAddonOperationReadSelection) {
      if (!work->titleFingerprintUtf8.empty()) {
        work->options.titleFingerprint =
          [NSString stringWithUTF8String:work->titleFingerprintUtf8.c_str()];
      }
      MacosAxReadResult result = ReadMacosAxSelection(work->options);
      work->readResult.status = result.status;
      work->readResult.text = CopyMacosAxUtf8String(result.text);
      work->readResult.reason = CopyMacosAxUtf8String(result.reason);
      work->readResult.windowLocate = CopyMacosAxUtf8String(result.windowLocate);
      work->readResult.hasWindowLocate = result.windowLocate.length > 0;
      work->readResult.windowMatched = result.windowMatched;
      work->readResult.hasWindowCount = result.windowLocate.length > 0;
      work->readResult.windowCount = result.windowCount;
      work->readResult.focusStatus = CopyMacosAxUtf8String(result.focusStatus);
      work->readResult.hasFocusStatus = result.focusStatus.length > 0;
      return;
    }

    if (work->operation == MacosAxAddonOperationPerformCopy) {
      work->copyPermissionGranted = AXIsProcessTrusted();
      work->copyPerformed = work->copyPermissionGranted &&
        PerformCommandCopyMenuAction(work->pid);
      return;
    }

    if (work->operation == MacosAxAddonOperationEnhanceAccessibility) {
      AXEnhancementResult result = EnableEnhancedUserInterface(work->pid);
      work->enhancementResult.permissionGranted = result.permissionGranted;
      work->enhancementResult.applicationAvailable = result.applicationAvailable;
      work->enhancementResult.accepted = result.accepted;
      work->enhancementResult.mode = result.mode;
      work->enhancementResult.manualError = result.manualError;
      work->enhancementResult.enhancedError = result.enhancedError;
    }
  }
}

/**
 * 创建 JS 字符串属性。
 * @param env Node-API 环境。
 * @param object 目标对象。
 * @param name 属性名。
 * @param value UTF-8 字符串。
 * @return 无返回值。
 * @author zhenghq
 */
static void SetStringProperty(
  napi_env env,
  napi_value object,
  const char *name,
  const std::string &value
) {
  napi_value property = nullptr;
  if (napi_create_string_utf8(env, value.c_str(), value.size(), &property) == napi_ok) {
    napi_set_named_property(env, object, name, property);
  }
}

/**
 * 创建 JS 布尔属性。
 * @param env Node-API 环境。
 * @param object 目标对象。
 * @param name 属性名。
 * @param value 布尔值。
 * @return 无返回值。
 * @author zhenghq
 */
static void SetBooleanProperty(
  napi_env env,
  napi_value object,
  const char *name,
  bool value
) {
  napi_value property = nullptr;
  if (napi_get_boolean(env, value, &property) == napi_ok) {
    napi_set_named_property(env, object, name, property);
  }
}

/**
 * 将读取结果转换为 JS 对象。
 * @param env Node-API 环境。
 * @param result 跨线程读取结果。
 * @return JS 结果对象；创建失败时返回 nullptr。
 * @author zhenghq
 */
static napi_value CreateReadSelectionResult(
  napi_env env,
  const MacosAxAddonReadResult &result
) {
  napi_value object = nullptr;
  if (napi_create_object(env, &object) != napi_ok) return nullptr;

  const char *status = "unknown";
  if (result.status == MacosAxReadStatusPresent) status = "present";
  else if (result.status == MacosAxReadStatusEmpty) status = "empty";
  SetStringProperty(env, object, "status", status);
  SetStringProperty(env, object, "text", result.text);
  if (!result.reason.empty()) SetStringProperty(env, object, "reason", result.reason);
  if (result.hasWindowLocate) {
    const std::string windowLocate = result.windowLocate == "fallback"
      ? "app-fallback" : result.windowLocate;
    SetStringProperty(env, object, "windowLocate", windowLocate);
    SetBooleanProperty(env, object, "windowMatched", result.windowMatched);
  }
  if (result.hasWindowCount) {
    napi_value windowCount = nullptr;
    if (napi_create_int64(env, (int64_t)result.windowCount, &windowCount) == napi_ok) {
      napi_set_named_property(env, object, "windowCount", windowCount);
    }
  }
  if (result.hasFocusStatus) {
    SetStringProperty(env, object, "focusStatus", result.focusStatus);
  }
  return object;
}

/**
 * 将菜单复制结果转换为固定状态字符串。
 * @param env Node-API 环境。
 * @param work 已完成的工作项。
 * @return JS 状态字符串。
 * @author zhenghq
 */
static napi_value CreatePerformCopyResult(napi_env env, const MacosAxAddonWork *work) {
  const char *status = work->copyPerformed
    ? "performed" : (work->copyPermissionGranted ? "unavailable" : "permission");
  napi_value result = nullptr;
  if (napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &result) != napi_ok) {
    return nullptr;
  }
  return result;
}

/**
 * 将 AX 增强结果转换为 JS 对象。
 * @param env Node-API 环境。
 * @param result 跨线程增强结果。
 * @return JS 结果对象。
 * @author zhenghq
 */
static napi_value CreateEnhancementResult(
  napi_env env,
  const MacosAxAddonEnhancementResult &result
) {
  napi_value object = nullptr;
  if (napi_create_object(env, &object) != napi_ok) return nullptr;
  SetBooleanProperty(env, object, "accepted", result.accepted);

  const char *mode = "none";
  if (result.mode == AXEnhancementModeManual) mode = "manual";
  else if (result.mode == AXEnhancementModeEnhanced) mode = "enhanced";
  SetStringProperty(env, object, "mode", mode);

  if (!result.permissionGranted) {
    SetStringProperty(env, object, "reason", "permission");
  } else if (!result.applicationAvailable) {
    SetStringProperty(env, object, "reason", "application-unavailable");
  } else if (!result.accepted) {
    SetStringProperty(
      env,
      object,
      "reason",
      "manual-" + std::to_string((long)result.manualError) +
        ",enhanced-" + std::to_string((long)result.enhancedError)
    );
  }
  return object;
}

/**
 * 异步任务完成后在 JS 主线程结算 Promise。
 * @param env Node-API 环境。
 * @param status 异步任务状态。
 * @param data MacosAxAddonWork 指针。
 * @return 无返回值。
 * @author zhenghq
 */
static void CompleteMacosAxAddonWork(napi_env env, napi_status status, void *data) {
  MacosAxAddonWork *work = static_cast<MacosAxAddonWork *>(data);
  if (!work) return;
  @autoreleasepool {
    napi_handle_scope scope = nullptr;
    napi_open_handle_scope(env, &scope);
    if (status != napi_ok || !work->error.empty()) {
      const std::string message = !work->error.empty()
        ? work->error : "macOS AX addon async operation failed";
      napi_value error = nullptr;
      napi_create_string_utf8(env, message.c_str(), message.size(), &error);
      napi_reject_deferred(env, work->deferred, error);
    } else {
      napi_value result = nullptr;
      if (work->operation == MacosAxAddonOperationReadSelection) {
        result = CreateReadSelectionResult(env, work->readResult);
      } else if (work->operation == MacosAxAddonOperationPerformCopy) {
        result = CreatePerformCopyResult(env, work);
      } else {
        result = CreateEnhancementResult(env, work->enhancementResult);
      }
      if (result == nullptr) {
        napi_value error = nullptr;
        napi_create_string_utf8(
          env,
          "failed to create macOS AX addon result",
          NAPI_AUTO_LENGTH,
          &error
        );
        napi_reject_deferred(env, work->deferred, error);
      } else {
        napi_resolve_deferred(env, work->deferred, result);
      }
    }
    if (scope) napi_close_handle_scope(env, scope);
    napi_delete_async_work(env, work->work);
    delete work;
  }
}

/**
 * 创建 Promise 并把工作项加入 libuv 线程池。
 * @param env Node-API 环境。
 * @param resourceName 异步资源名。
 * @param work 已初始化的工作项。
 * @return JS Promise；失败时抛出错误并返回 nullptr。
 * @author zhenghq
 */
static napi_value QueueMacosAxAddonWork(
  napi_env env,
  const char *resourceName,
  MacosAxAddonWork *work
) {
  napi_value promise = nullptr;
  napi_value resource = nullptr;
  work->env = env;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, resourceName, NAPI_AUTO_LENGTH, &resource) != napi_ok ||
      napi_create_async_work(
        env,
        resource,
        resource,
        ExecuteMacosAxAddonWork,
        CompleteMacosAxAddonWork,
        work,
        &work->work
      ) != napi_ok ||
      napi_queue_async_work(env, work->work) != napi_ok) {
    if (work->work) napi_delete_async_work(env, work->work);
    delete work;
    napi_throw_error(env, nullptr, "failed to queue macOS AX addon operation");
    return nullptr;
  }
  return promise;
}

/**
 * JS `readSelection(options?)` 入口。
 * @param env Node-API 环境。
 * @param info 回调信息。
 * @return Promise 对象。
 * @author zhenghq
 */
static napi_value ReadSelection(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  MacosAxAddonWork *work = new MacosAxAddonWork();
  work->operation = MacosAxAddonOperationReadSelection;
  if (!ParseReadSelectionArguments(env, args, argc, work)) {
    delete work;
    return nullptr;
  }
  return QueueMacosAxAddonWork(env, "macos-ax-reader:readSelection", work);
}

/**
 * JS `performCopy(pid)` 入口。
 * @param env Node-API 环境。
 * @param info 回调信息。
 * @return Promise 对象。
 * @author zhenghq
 */
static napi_value PerformCopy(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  MacosAxAddonWork *work = new MacosAxAddonWork();
  work->operation = MacosAxAddonOperationPerformCopy;
  if (!ParsePidArgument(env, args, argc, &work->pid)) {
    delete work;
    return nullptr;
  }
  return QueueMacosAxAddonWork(env, "macos-ax-reader:performCopy", work);
}

/**
 * JS `enhanceAccessibility(pid)` 入口。
 * @param env Node-API 环境。
 * @param info 回调信息。
 * @return Promise 对象。
 * @author zhenghq
 */
static napi_value EnhanceAccessibility(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  MacosAxAddonWork *work = new MacosAxAddonWork();
  work->operation = MacosAxAddonOperationEnhanceAccessibility;
  if (!ParsePidArgument(env, args, argc, &work->pid)) {
    delete work;
    return nullptr;
  }
  return QueueMacosAxAddonWork(env, "macos-ax-reader:enhanceAccessibility", work);
}

/**
 * Node-API 模块初始化：导出三个异步方法。
 * @param env Node-API 环境。
 * @param exports 模块导出对象。
 * @return 模块导出对象。
 * @author zhenghq
 */
NAPI_MODULE_INIT() {
  napi_value readSelection = nullptr;
  napi_value performCopy = nullptr;
  napi_value enhanceAccessibility = nullptr;
  if (napi_create_function(
        env, "readSelection", NAPI_AUTO_LENGTH, ReadSelection, nullptr, &readSelection) == napi_ok) {
    napi_set_named_property(env, exports, "readSelection", readSelection);
  }
  if (napi_create_function(
        env, "performCopy", NAPI_AUTO_LENGTH, PerformCopy, nullptr, &performCopy) == napi_ok) {
    napi_set_named_property(env, exports, "performCopy", performCopy);
  }
  if (napi_create_function(
        env,
        "enhanceAccessibility",
        NAPI_AUTO_LENGTH,
        EnhanceAccessibility,
        nullptr,
        &enhanceAccessibility) == napi_ok) {
    napi_set_named_property(env, exports, "enhanceAccessibility", enhanceAccessibility);
  }
  return exports;
}
