# win-appcontainer — Windows AppContainer + Job Object launcher

MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §5.4 / §7.4.

This native binding wraps `CreateProcessAsUser` +
`AssignProcessToJobObject` so the Aitne daemon can launch its managed
Chromium inside an AppContainer with a Job-Object resource ceiling. The
binding is **only built on win32** — non-Windows installs skip the
`node-gyp rebuild` step automatically (see `loader.js`).

## Build prerequisites (Windows only)

- Node ≥ 22 with `npm config get python` pointing at a working Python.
- Visual Studio Build Tools 2022 ("Desktop development with C++"
  workload).
- `npm install -g node-gyp@latest`.

The daemon installer runs:

```cmd
npm rebuild --filter @aitne/daemon
```

and that triggers `node-gyp` for this binding. The output `.node` file
lands at `build/Release/win_appcontainer.node`; the `loader.js`
fallback emits a clear runtime error if the addon is missing on a
Windows host (a fresh source checkout that has not been rebuilt).

## API surface (exported from `loader.js → loadHelper()`)

```ts
interface WindowsHelper {
  spawnInAppContainer(opts: {
    profileName: string;       // AppContainer profile (created if absent)
    binary: string;            // Resolved Chromium binary path
    args: readonly string[];
    detached: boolean;
    readableBindings: readonly string[];
    writableBindings: readonly string[];
  }): ChildProcess;
}
```

The returned `ChildProcess` behaves like a standard Node spawn handle —
`pid`, `kill()`, `on("exit")` all work. The actual process executes
under an AppContainer SID with a Job Object enforcing memory + CPU
ceilings.

## Why a native binding and not PowerShell

The existing daemon spawn path for secrets reading uses PowerShell
(DPAPI / `secret-tool` equivalents). AppContainer creation is a
multi-call Win32 sequence (`CreateAppContainerProfile`,
`DeriveAppContainerSidFromAppContainerName`,
`UpdateProcThreadAttribute`, etc.) that would be brittle and slow over
a PowerShell hop. A small N-API addon is the right choice — it ships
prebuilt for users who install the npm package and only requires VC++
when rebuilding from source.

## Sandbox status (B-1 milestone)

The binding is shipped as a stub on non-Windows hosts and the
`loadHelper()` fallback throws with a clear message. Windows users
exercising B-1 will build the addon as part of `npm install`; the
binding source (`src/win_appcontainer.cc`) lives next to this README
for inspection and contribution.
