// Aitne win-appcontainer — Windows AppContainer + Job Object launcher.
//
// Compiled into a .node addon by node-gyp on Windows only (see
// binding.gyp `conditions`). The TypeScript-side loader
// (loader.js) refuses to call into this on non-Windows hosts.
//
// API:
//   spawnInAppContainer({profileName, binary, args, detached,
//                       readableBindings, writableBindings})
//     -> { pid, kill }
//
// Strategy:
//   1. Create (or fetch) an AppContainer profile via
//      CreateAppContainerProfile / DeriveAppContainerSidFromAppContainerName.
//   2. Build a STARTUPINFOEX with PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES
//      bearing the derived SID + the requested capability set.
//   3. CreateProcessAsUser the Chromium binary inside the AppContainer.
//   4. AssignProcessToJobObject to enforce memory / CPU ceilings.
//   5. Return a small JS object exposing pid + a kill() that calls
//      TerminateJobObject (so the job's whole tree dies, not just the
//      root process).
//
// This file ships as a stub today — full integration depends on the
// daemon's secret-store layer and the BROWSER_HISTORY_INTEGRATION_PLAN
// §19.1 native-helper contract that is itself in flight. Build, link,
// and minimal `spawnInAppContainer({...}) -> { pid: -1 }` are wired so
// the node-gyp pipeline + npm install path exercise on Windows before
// the implementation lands.

#define NAPI_DISABLE_CPP_EXCEPTIONS

#include <napi.h>

#ifdef _WIN32
#include <Windows.h>
#include <UserEnv.h>
#endif

namespace {

Napi::Value SpawnInAppContainer(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

#ifdef _WIN32
  // TODO(aitne#managed-chromium): wire CreateAppContainerProfile +
  // CreateProcessAsUser + AssignProcessToJobObject per the header
  // comment. Until then the binding errors loudly so callers do not
  // silently fall back to an unsandboxed launch.
  Napi::Error::New(env, "spawnInAppContainer not yet implemented on this build of win-appcontainer").ThrowAsJavaScriptException();
  return env.Null();
#else
  Napi::Error::New(env, "win-appcontainer is Windows-only").ThrowAsJavaScriptException();
  return env.Null();
#endif
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(
    Napi::String::New(env, "spawnInAppContainer"),
    Napi::Function::New(env, SpawnInAppContainer)
  );
  return exports;
}

}  // namespace

NODE_API_MODULE(win_appcontainer, Init)
