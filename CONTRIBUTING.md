# Contributing to Trace

Thank you for your interest in contributing to Trace! We welcome bug reports, feature suggestions, documentation improvements, and pull requests.

Please take a moment to review this guide before submitting contributions.

---

## Code of Conduct

All contributors and participants are expected to adhere to our [Code of Conduct](CODE_OF_CONDUCT.md). Please treat everyone with respect and empathy.

---

## Development Setup

### Prerequisites

- **Node.js**: `>=22.12.0`
- **pnpm**: `10.32.1`
- Platform SDKs:
  - **macOS**: Apple Silicon with Xcode command-line tools (`swiftc`, `swift build`).
  - **Windows**: Windows 10/11 x64 with .NET 8 SDK (`dotnet`).

### Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/overdev-l/workflow-skill.git
   cd workflow-skill
   ```

2. Install dependencies:
   ```bash
   pnpm install --frozen-lockfile
   ```

3. Run the desktop application in development mode:
   ```bash
   pnpm dev:desktop
   ```

---

## Verification & Quality Checks

Before submitting a pull request, run the offline verification suite to confirm that types, builds, and protocol checks succeed:

```bash
# Typecheck across all workspace packages
pnpm typecheck

# Production build across packages and apps
pnpm build

# Verify MCP server management and invariants
pnpm verify:mcp

# Verify capture pipeline and browser capture
pnpm verify:capture
pnpm verify:browser-capture

# Verify desktop update mechanisms and publishing invariants
pnpm verify:updates
```

---

## Pull Request Guidelines

1. **Focused Scope**: Keep PRs focused on a single feature, bug fix, or documentation enhancement. Avoid bundling unrelated refactors.
2. **Branching**: Create a meaningful branch name for your changes (e.g., `fix/browser-capture-header-sanitization` or `feat/mcp-server-export`).
3. **No Secrets or Credentials**:
   - **Never** commit real credentials, API tokens, OAuth secrets, session cookies, or personal runtime files.
   - Use only synthetic, sanitized test fixtures.
4. **No Build Artifacts**: Do not commit generated build directories (`dist/`, `dist-electron/`, `.output/`, native binaries).
5. **Privacy & Security Standards**: Trace is a local-first application designed with strict privacy boundaries. Ensure that no screen pixels, raw keystrokes, or unredacted credentials are leaked or persisted.
6. **Tests & Verification**: Include relevant verification scripts or unit tests for new functionality, and ensure existing checks continue to pass.

---

## Reporting Issues

- **Bug Reports**: Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md). Include reproducible steps, operating system, and application version.
- **Feature Requests**: Use the [Feature Request template](.github/ISSUE_TEMPLATE/feature_request.md) to explain the problem you are solving and the proposed workflow.
- **Security Vulnerabilities**: **Do not open a public issue.** See [SECURITY.md](SECURITY.md) to report vulnerabilities privately via GitHub Security Advisories.
