# Native recorders

The native recorders are intentionally narrow in V1: permission state, capture lifecycle, sampled frame metadata, application/window context, accessibility semantics, and privacy filtering. Workflow inference stays outside the privileged process.

- `macos`: Swift 6 executable using ScreenCaptureKit, Accessibility, CGEvent taps, and active application notifications.
- `windows`: .NET 8 executable using Windows Graphics Capture, low-level input hooks, and UI Automation.
- `../proto`: stable messages shared with the Electron host.

Both executables run as long-lived child processes in `serve` mode. Commands arrive as one JSON object per line on standard input; protocol envelopes leave on standard output. Diagnostic output is reserved for standard error.

Privacy guarantees enforced inside the privileged process:

- sampled frames are counted but never written to disk;
- keyboard events contain virtual key codes and modifiers, never typed characters;
- accessible labels and window titles are SHA-256 hashes;
- application and window-title exclusion policies are applied before events leave the recorder;
- `recordedBytes` remains zero in this version.

Build and handshake-test the recorder for the current platform from the repository root:

```bash
pnpm build:recorder
pnpm verify:recorder
```
