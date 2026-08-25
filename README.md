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

`dev:desktop` builds the native recorder for the current platform before opening Electron. On first launch, grant Trace Screen Recording and Accessibility access. Once both are authorized, observation starts silently on subsequent launches.

## Verification

```bash
pnpm build:recorder
pnpm verify:recorder
pnpm typecheck
pnpm build
```

The privileged recorder emits only sampled frame metadata and semantic interaction events. It does not persist frame pixels, typed text, or upload observation data. The Electron host receives newline-delimited protocol messages through a child process; the renderer only receives the small, allowlisted API exposed by the preload bridge.

On Windows, the first capture in an app session uses the system picker to select a display or window. Pause and resume reuse that target without another picker.

### macOS permission guidance

Trace follows the interaction model demonstrated by [zats/permiso](https://github.com/zats/permiso): the helper expands from the permission button along a curved 720 ms path, anchors to the bottom of the relevant System Settings window, and follows that window while it moves. A dedicated Swift `CGWindowList` observer supplies window geometry every 150 ms without requiring Accessibility permission. The helper is non-activating, hides whenever System Settings is not frontmost, supports multiple displays, and closes as soon as the requested permission is detected.
