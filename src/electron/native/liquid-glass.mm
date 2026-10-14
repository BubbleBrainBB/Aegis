// Liquid Glass behind an Electron window (macOS 26+).
//
// macOS 27 no longer blurs what is behind a window through NSVisualEffectView
// (Electron's `vibrancy`); only NSGlassEffectView does. Electron has no API
// for it, so this inserts one under the web contents of a window created with
// `transparent: true`. Plain N-API, so one build loads in any Electron.
//
// JS: isSupported() -> boolean
//     setGlass(handle: Buffer, enabled: boolean, cornerRadius?: number, style?: number) -> boolean
//   handle is BrowserWindow.getNativeWindowHandle() (an NSView*); style is
//   NSGlassEffectView.Style (0 regular, 1 clear).

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
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
