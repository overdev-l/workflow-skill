# Trace

A local-first desktop product that observes repeated work across desktop applications, proposes a traceable workflow, and lets the user preserve it as a reusable Skill.

The source code in this repository is open source under the [MIT License](LICENSE).

---

## Architecture & Repository Structure

- `apps/desktop`: Electron + React desktop application and the interactive V1 UI.
- `apps/web`: TanStack Start marketing site prepared for Cloudflare Workers.
- `packages/workflow-model`: Shared workflow and skill data structures.
- `packages/capture-protocol`: Recorder control and event contracts.
- `packages/ui`: Shared design tokens and styles.
- `recorders/macos`: ScreenCaptureKit + Accessibility recorder (Swift).
- `recorders/windows`: Windows Graphics Capture + UI Automation recorder (C# / .NET 8).
- `proto`: Cross-language protocol definitions.
- `scripts`: Build, packaging, verification, and maintenance tooling.

---

## Quickstart & Local Development

### Prerequisites

- **Node.js**: `>=22.12.0`
- **pnpm**: `10.32.1`
- Platform SDKs (for native recorders):
  - macOS: Xcode command-line tools (`swiftc`, `swift build`) on Apple Silicon.
  - Windows: .NET 8 SDK (`dotnet`) for Windows x64.

### Getting Started

```bash
# Install workspace dependencies with frozen lockfile
pnpm install

# Start desktop development environment
pnpm dev:desktop
```

`dev:desktop` builds the native recorder for the current platform before opening Electron. Screen Recording and Accessibility permissions are only required for the desktop capture scenario. Capture always starts from an explicit user action and never begins silently at launch.

---

## Workflow Capture & Privacy

### Browser Capture

Workflow capture can begin with an explicit browser scenario. Enter an HTTP(S) URL and Trace opens a dedicated Chromium window backed by a persistent local session. Only that window is observed. Trace records page navigation, DOM click/change/submit semantics, and Document/XHR/Fetch request-response metadata through the Chromium DevTools Protocol (CDP).

`POST`, `PUT`, `PATCH`, and `DELETE` requests are compiled into editable `http` workflow nodes with their sanitized request template and expected response status. Authorization headers, cookies, tokens, passwords, CSRF fields, and similar credentials are replaced with runtime secret references before NDJSON persistence. Multipart and unknown request bodies are omitted.

### Desktop Capture & Privacy Model

The privileged native recorder emits only sampled frame metadata and semantic interaction events. The Electron host stores filtered semantic events as NDJSON under the selected local `captures` directory and derived workflows as JSON under `workflows`.

- **Frame pixels and typed text are never persisted.**
- **Observation data is never uploaded to any remote service.**
- The Electron host communicates with native recorders via newline-delimited protocol messages through child processes.
- The renderer UI only accesses a strictly allowlisted, secure IPC surface exposed by the preload bridge (`contextBridge`).

On Windows, the first capture in an app session uses the system picker to select a display or window. Pause and resume reuse that target without another picker.

### macOS Permission Guidance

Trace follows the interaction model demonstrated by [zats/permiso](https://github.com/zats/permiso): the helper expands from the permission button along a curved 720 ms path, anchors to the bottom of the relevant System Settings window, and follows that window while it moves. A dedicated Swift `CGWindowList` observer supplies window geometry every 150 ms without requiring Accessibility permission. The helper is non-activating, hides whenever System Settings is not frontmost, supports multiple displays, and closes as soon as the requested permission is detected.

---

## Verification & Testing

Trace includes a comprehensive suite of verification scripts that run offline and require no credentials:

```bash
# Build platform native recorder
pnpm build:recorder

# Verify native recorder, capture pipelines, and MCP management
pnpm verify:recorder
pnpm verify:capture
pnpm verify:browser-capture
pnpm verify:mcp

# Typecheck and production bundle build across workspace
pnpm typecheck
pnpm build
```

---

## Supported Platforms & Limitations

| Platform | Architecture | Status & Requirements |
| --- | --- | --- |
| **macOS** | Apple Silicon (`arm64`) | Supported (macOS 13+ Ventura or newer). Requires Screen Recording & Accessibility permissions for desktop capture. |
| **Windows** | `x64` | Supported (Windows 10/11 x64). Uses .NET 8 self-contained runtime, Windows Graphics Capture, and UI Automation. |
| **Linux / Intel Mac** | `x64` / `arm64` | Not currently supported; native recorder pipelines are implemented for macOS arm64 and Windows x64. |

---

## Desktop Builds, Releases & Updates

While the application source code is publicly hosted in this repository (`overdev-l/workflow-skill`), automated builds, code signing, Apple notarization, and official release packages are hosted separately in the release repository:

👉 **[overdev-l/trace-releases](https://github.com/overdev-l/trace-releases)**

- Official release downloads: Visit [Releases](https://github.com/overdev-l/trace-releases/releases) for signed macOS arm64 (`.dmg` / `.zip`) and Windows x64 (`.exe`) installers.
- Unsigned previews are marked as prereleases and do not enable automatic updates.
- See [Desktop Build & Auto-Update Documentation](docs/DESKTOP_AUTO_UPDATE.md) for full architecture details regarding CI inputs, release signing secrets, and update verification.

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on code style, local development workflows, and the pull request process. Please also review our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Security

Security and privacy are core to Trace. If you discover a potential security vulnerability, please **do not open a public issue**. Instead, submit a private report via GitHub's [Private Vulnerability Reporting](https://github.com/overdev-l/workflow-skill/security/advisories/new).

For more details, please see [SECURITY.md](SECURITY.md).

---

## License

This project is licensed under the [MIT License](LICENSE).
Copyright &copy; 2026 overdev-l.
