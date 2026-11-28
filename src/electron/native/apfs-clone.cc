// Minimal N-API wrapper around macOS APFS clonefile(2) so worktree bootstrap
// can copy-on-write clone whole directories (such as node_modules) in ~1s with
// zero extra disk blocks initially, without blocking the main Electron thread.

#include <node_api.h>
#include <sys/clonefile.h>

#include <cerrno>
#include <cstring>
#include <string>

namespace {

struct CloneWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string src;
  std::string dst;
  int err = 0;
};

bool ReadUtf8String(napi_env env, napi_value value, std::string* out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    return false;
  }
  out->assign(length, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, out->data(), length + 1, &copied) != napi_ok) {
    return false;
  }
  out->resize(copied);
  return true;
}

const char* ErrnoCodeName(int err) {
  switch (err) {
    case EEXIST: return "EEXIST";
    case ENOENT: return "ENOENT";
    case EXDEV: return "EXDEV";
    case ENOTSUP: return "ENOTSUP";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case EINVAL: return "EINVAL";
    case EISDIR: return "EISDIR";
    case ENOTDIR: return "ENOTDIR";
    case ENOSPC: return "ENOSPC";
    case EROFS: return "EROFS";
    case ELOOP: return "ELOOP";
    default: return "EIO";
  }
}

void ExecuteClone(napi_env /*env*/, void* data) {
  auto* req = static_cast<CloneWork*>(data);
  if (clonefile(req->src.c_str(), req->dst.c_str(), CLONE_NOFOLLOW) != 0) {
    req->err = errno;
  }
}

void CompleteClone(napi_env env, napi_status status, void* data) {
  auto* req = static_cast<CloneWork*>(data);
  if (status != napi_ok) {
    napi_value msg = nullptr;
    napi_value err = nullptr;
    napi_create_string_utf8(env, "clonefile async work failed", NAPI_AUTO_LENGTH, &msg);
    napi_create_error(env, nullptr, msg, &err);
    napi_reject_deferred(env, req->deferred, err);
  } else if (req->err != 0) {
    const char* codeStr = ErrnoCodeName(req->err);
    std::string message = std::string("clonefile failed (") + codeStr + "): " + std::strerror(req->err);
    napi_value code = nullptr;
    napi_value msg = nullptr;
    napi_value err = nullptr;
    napi_create_string_utf8(env, codeStr, NAPI_AUTO_LENGTH, &code);
    napi_create_string_utf8(env, message.c_str(), NAPI_AUTO_LENGTH, &msg);
    napi_create_error(env, code, msg, &err);
    napi_value errnoVal = nullptr;
    napi_create_int32(env, req->err, &errnoVal);
    napi_set_named_property(env, err, "errno", errnoVal);
    napi_reject_deferred(env, req->deferred, err);
  } else {
    napi_value undef = nullptr;
    napi_get_undefined(env, &undef);
    napi_resolve_deferred(env, req->deferred, undef);
  }
  napi_delete_async_work(env, req->work);
  delete req;
}

napi_value CloneFileAsync(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 2) {
    napi_throw_type_error(env, nullptr, "cloneFile(src, dst) requires two string arguments");
    return nullptr;
  }

  auto* req = new CloneWork();
  if (!ReadUtf8String(env, args[0], &req->src) || !ReadUtf8String(env, args[1], &req->dst)) {
    delete req;
    napi_throw_type_error(env, nullptr, "cloneFile(src, dst) arguments must be strings");
    return nullptr;
  }

  napi_value promise = nullptr;
  if (napi_create_promise(env, &req->deferred, &promise) != napi_ok) {
    delete req;
    return nullptr;
  }

  napi_value resourceName = nullptr;
  napi_create_string_utf8(env, "apfs_clonefile", NAPI_AUTO_LENGTH, &resourceName);
  if (napi_create_async_work(
          env,
          nullptr,
          resourceName,
          ExecuteClone,
          CompleteClone,
          req,
          &req->work) != napi_ok) {
    delete req;
    napi_throw_error(env, nullptr, "Failed to schedule clonefile async work");
    return nullptr;
  }

  if (napi_queue_async_work(env, req->work) != napi_ok) {
    napi_delete_async_work(env, req->work);
    delete req;
    napi_throw_error(env, nullptr, "Failed to queue clonefile async work");
    return nullptr;
  }

  return promise;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value fn = nullptr;
  napi_create_function(env, "cloneFile", NAPI_AUTO_LENGTH, CloneFileAsync, nullptr, &fn);
  napi_set_named_property(env, exports, "cloneFile", fn);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
