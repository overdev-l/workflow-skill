# Trace

A local-first desktop product that observes repeated work across desktop applications, proposes a traceable workflow, and lets the user preserve it as a reusable Skill.

## Repository

- `apps/desktop`: Electron + React desktop app and the interactive V1 UI.
- `apps/web`: TanStack Start marketing site prepared for Cloudflare Workers.
- `packages/workflow-model`: shared workflow and skill data structures.
- `packages/capture-protocol`: recorder control and event contracts.
- `packages/ui`: shared design tokens.
- `recorders/macos`: ScreenCaptureKit + Accessibility recorder.
- `recorders/windows`: Windows Graphics Capture + UI Automation recorder.
- `proto`: cross-language protocol definitions.

## Start

```bash
pnpm install
pnpm dev:desktop
```

`dev:desktop` builds the native recorder for the current platform before opening Electron. Screen Recording and Accessibility permissions are only required for the desktop capture scenario. Capture always starts from an explicit user action and never begins silently at launch.

### Browser capture

Workflow capture now starts with an explicit browser scenario. Enter an HTTP(S) URL and Trace opens a dedicated Chromium window backed by a persistent local session. Only that window is observed. Trace records page navigation, DOM click/change/submit semantics, and Document/XHR/Fetch request-response metadata through the Chromium DevTools Protocol.

`POST`, `PUT`, `PATCH`, and `DELETE` requests are compiled into editable `http` workflow nodes with their sanitized request template and expected response status. Authorization headers, cookies, tokens, passwords, CSRF fields, and similar credentials are replaced with runtime secret references before NDJSON persistence. Multipart and unknown request bodies are omitted.

## Verification

```bash
pnpm build:recorder
pnpm verify:recorder
pnpm verify:capture
pnpm verify:browser-capture
pnpm typecheck
pnpm build
```

The privileged recorder emits only sampled frame metadata and semantic interaction events. The Electron host stores filtered semantic events as NDJSON under the selected local `captures` directory and derived workflows as JSON under `workflows`. Frame pixels and typed text are never persisted, and observation data is never uploaded. The Electron host receives newline-delimited protocol messages through a child process; the renderer only receives the small, allowlisted API exposed by the preload bridge.

On Windows, the first capture in an app session uses the system picker to select a display or window. Pause and resume reuse that target without another picker.

### macOS permission guidance

Trace follows the interaction model demonstrated by [zats/permiso](https://github.com/zats/permiso): the helper expands from the permission button along a curved 720 ms path, anchors to the bottom of the relevant System Settings window, and follows that window while it moves. A dedicated Swift `CGWindowList` observer supplies window geometry every 150 ms without requiring Accessibility permission. The helper is non-activating, hides whenever System Settings is not frontmost, supports multiple displays, and closes as soon as the requested permission is detected.
