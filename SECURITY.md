# Security Policy

## Supported Versions

Security updates are provided for the latest release on the `main` branch.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

If you believe you have found a security vulnerability in Trace, report it privately using GitHub's **Private Vulnerability Reporting**:

👉 **[Submit a Security Advisory](https://github.com/overdev-l/workflow-skill/security/advisories/new)**

Alternatively:
1. Navigate to the repository on GitHub: `https://github.com/overdev-l/workflow-skill`.
2. Click on the **Security** tab.
3. Under **Reporting**, click **Report a vulnerability**.

### What to Include

To help us triage and resolve the issue quickly, please provide:

- A clear description of the vulnerability and the potential security impact.
- Step-by-step instructions or a minimal proof-of-concept to reproduce the behavior.
- The operating system, platform architecture (e.g., macOS Apple Silicon, Windows x64), and Trace version.
- Any relevant logs or stack traces (ensure any real credentials or tokens are redacted before submitting).
- Potential remediation or fix suggestions, if available.

### What to Expect

- **Acknowledgment**: We aim to acknowledge receipt within 48 hours.
- **Assessment**: We will investigate and confirm the report, keeping you informed of our findings.
- **Remediation**: Once verified, a fix will be developed and released through a coordinated security advisory.

---

## Security & Privacy Architecture

Trace is designed as a local-first application with privacy and security at its foundation:

1. **Local-First Data Storage**: Observation events and derived workflow skills are stored locally on the user's filesystem (in user-scoped configuration directories). Observation data is never uploaded to remote servers.
2. **No Raw Pixel or Keystroke Persistence**: Privileged native recorders emit sampled semantic interactions and window metadata. Raw screen pixels and keystrokes are never persisted to disk.
3. **Sensitive Request Sanitization**: Browser capture automatically redacts authentication headers (`Authorization`, cookies, CSRF tokens, session IDs, passwords, API keys) into parameter references before writing NDJSON logs.
4. **IPC Sandboxing**: The Electron renderer operates with context isolation enabled and accesses native capabilities solely through a strictly allowlisted preload bridge (`contextBridge`).
5. **Signing & Update Integrity**: Production releases and update manifests are cryptographically verified with SHA-512 checksums and blockmaps, hosted on GitHub Releases, and signed with platform certificates.
