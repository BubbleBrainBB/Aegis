// Liquid Glass behind an Electron window (macOS 26+).
//
// macOS 27 no longer blurs what is behind a window through NSVisualEffectView
// (Electron's `vibrancy`); only NSGlassEffectView does. Electron has no API
// for it, so this inserts one under the web contents of a window created with
// `transparent: true`. Plain N-API, so one build loads in any Electron.
//
// JS: isSupported() -> boolean
//     setGlass(handle: Buffer, enabled: boolean, cornerRadius?: number, style?: number) -> boolean
//     watchFullScreen(handle: Buffer, callback: (phase: string) => void) -> boolean
//   handle is BrowserWindow.getNativeWindowHandle() (an NSView*); style is
//   NSGlassEffectView.Style (0 regular, 1 clear). watchFullScreen calls back
//   'will-enter' as native fullscreen starts, before AppKit animates the
//   window into its Space (Electron's 'enter-full-screen' only fires after).
//   The watch ends when the window closes.

#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>

static const void *kGlassViewKey = &kGlassViewKey;

static bool SetGlass(NSView *root, bool enabled, double cornerRadius, double style) {
  NSView *existing = objc_getAssociatedObject(root, kGlassViewKey);
  if (!enabled) {
    [existing removeFromSuperview];
    objc_setAssociatedObject(root, kGlassViewKey, nil, OBJC_ASSOCIATION_RETAIN);
    return true;
  }

  Class glassClass = NSClassFromString(@"NSGlassEffectView");
  if (!glassClass) return false;

  NSView *glass = existing;
  if (!glass) {
    glass = [[glassClass alloc] initWithFrame:root.bounds];
    glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [root addSubview:glass positioned:NSWindowBelow relativeTo:nil];
    objc_setAssociatedObject(root, kGlassViewKey, glass, OBJC_ASSOCIATION_RETAIN);
  }
  if (cornerRadius >= 0 && [glass respondsToSelector:@selector(setCornerRadius:)]) {
    [glass setValue:@(cornerRadius) forKey:@"cornerRadius"];
  }
  if (style >= 0 && [glass respondsToSelector:@selector(setStyle:)]) {
    [glass setValue:@((NSInteger)style) forKey:@"style"];
  }
  return true;
}

static napi_value JsSetGlass(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  napi_value result;
  bool ok = false;
  void *data = nullptr;
  size_t length = 0;
  bool enabled = false;
  double cornerRadius = -1;
  double style = -1;

  if (argc >= 2 && napi_get_buffer_info(env, argv[0], &data, &length) == napi_ok &&
      length >= sizeof(void *) && napi_get_value_bool(env, argv[1], &enabled) == napi_ok) {
    if (argc >= 3) napi_get_value_double(env, argv[2], &cornerRadius);
    if (argc >= 4) napi_get_value_double(env, argv[3], &style);
    NSView *root = *reinterpret_cast<NSView *__unsafe_unretained *>(data);
    if (root && [NSThread isMainThread]) ok = SetGlass(root, enabled, cornerRadius, style);
  }

  napi_get_boolean(env, ok, &result);
  return result;
}

// One per watched window. It is freed once the window has closed and no
// callback is still running: the JS callback may itself close the window,
// which delivers the close notification while CallWatch is still on the stack.
struct FullScreenWatch {
  napi_env env;
  napi_ref callback;
  NSMutableArray *observers;
  int delivering;
  bool closed;
};

static void ReleaseWatch(FullScreenWatch *watch) {
  napi_delete_reference(watch->env, watch->callback);
  delete watch;
}

// AppKit posts these on the main thread, which in Electron's main process is
// also the JS thread. Observers with a nil queue run inside the post, so the
// callback finishes before AppKit starts the fullscreen animation.
static void CallWatch(FullScreenWatch *watch, const char *phase) {
  if (watch->closed) return;
  napi_env env = watch->env;
  napi_handle_scope scope;
  if (napi_open_handle_scope(env, &scope) != napi_ok) return;
  watch->delivering += 1;
  napi_value callback, global, argument;
  if (napi_get_reference_value(env, watch->callback, &callback) == napi_ok && callback &&
      napi_get_global(env, &global) == napi_ok &&
      napi_create_string_utf8(env, phase, NAPI_AUTO_LENGTH, &argument) == napi_ok) {
    napi_call_function(env, global, callback, 1, &argument, nullptr);
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
      napi_value error;
      napi_get_and_clear_last_exception(env, &error);
    }
  }
  watch->delivering -= 1;
  napi_close_handle_scope(env, scope);
  if (watch->closed && watch->delivering == 0) ReleaseWatch(watch);
}

static bool WatchFullScreen(napi_env env, NSWindow *window, napi_value callback) {
  FullScreenWatch *watch = new FullScreenWatch{env, nullptr, [NSMutableArray array], 0, false};
  if (napi_create_reference(env, callback, 1, &watch->callback) != napi_ok) {
    delete watch;
    return false;
  }
  NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
  [watch->observers addObject:[center addObserverForName:NSWindowWillEnterFullScreenNotification
                                                  object:window
                                                   queue:nil
                                              usingBlock:^(NSNotification *) { CallWatch(watch, "will-enter"); }]];
  [watch->observers addObject:[center addObserverForName:NSWindowWillCloseNotification
                                                  object:window
                                                   queue:nil
                                              usingBlock:^(NSNotification *) {
    if (watch->closed) return;
    watch->closed = true;
    for (id observer in watch->observers) [[NSNotificationCenter defaultCenter] removeObserver:observer];
    if (watch->delivering == 0) ReleaseWatch(watch);
  }]];
  return true;
}

static napi_value JsWatchFullScreen(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  bool ok = false;
  void *data = nullptr;
  size_t length = 0;
  napi_valuetype type = napi_undefined;
  if (argc >= 2 && napi_get_buffer_info(env, argv[0], &data, &length) == napi_ok &&
      length >= sizeof(void *) && napi_typeof(env, argv[1], &type) == napi_ok && type == napi_function) {
    NSView *root = *reinterpret_cast<NSView *__unsafe_unretained *>(data);
    if (root.window && [NSThread isMainThread]) ok = WatchFullScreen(env, root.window, argv[1]);
  }

  napi_value result;
  napi_get_boolean(env, ok, &result);
  return result;
}

static napi_value JsIsSupported(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, NSClassFromString(@"NSGlassEffectView") != nil, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "setGlass", NAPI_AUTO_LENGTH, JsSetGlass, nullptr, &fn);
  napi_set_named_property(env, exports, "setGlass", fn);
  napi_create_function(env, "isSupported", NAPI_AUTO_LENGTH, JsIsSupported, nullptr, &fn);
  napi_set_named_property(env, exports, "isSupported", fn);
  napi_create_function(env, "watchFullScreen", NAPI_AUTO_LENGTH, JsWatchFullScreen, nullptr, &fn);
  napi_set_named_property(env, exports, "watchFullScreen", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
