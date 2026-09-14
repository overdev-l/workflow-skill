const fs = require('node:fs')
const path = require('node:path')

const release = process.env.TRACE_RELEASE === '1'
const repository = process.env.TRACE_RELEASE_REPOSITORY || 'overdev-l/trace-releases'
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub release repository.')
const [owner, repo] = repository.split('/')
const publish = { provider: 'github', owner, repo, private: false, releaseType: 'release' }
if (release) {
  if (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD) {
    throw new Error('Release packaging requires signing credentials.')
  }
  if (process.platform === 'darwin' && (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID)) {
    throw new Error('Release packaging requires Apple notarization credentials.')
  }
}
const recorder = process.platform === 'darwin' ? 'workflow-recorder-macos' : 'WorkflowRecorder.exe'
for (const file of [`recorders/${recorder}`, ...(process.platform === 'darwin' ? ['native-bin/trace-account-keychain'] : [])]) {
  if (!fs.existsSync(path.join(__dirname, 'release-resources', file))) {
    throw new Error('Native resources missing. Run pnpm prepare:desktop-package on the target platform first.')
  }
}

module.exports = {
  appId: 'dev.trace.desktop',
  productName: 'Trace',
  directories: { output: '../../dist/desktop', buildResources: 'resources' },
  files: ['dist/**', 'dist-electron/**', 'package.json', '!**/*.map', '!**/.turbo/**', '!**/*.log', '!node_modules/@workflow-skill/**'],
  extraMetadata: { traceUpdatesEnabled: release },
  extraResources: [
    { from: 'resources', to: '.', filter: ['*.png'] },
    { from: 'release-resources', to: '.', filter: ['recorders/**', 'native-bin/**'] },
  ],
  publish,
  forceCodeSigning: release,
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    artifactName: 'Trace-${version}-mac-${arch}.${ext}',
    category: 'public.app-category.developer-tools',
    icon: 'resources/trace-spirit-icon.png',
    hardenedRuntime: true,
    notarize: release,
    binaries: ['Contents/Resources/recorders/workflow-recorder-macos', 'Contents/Resources/native-bin/trace-account-keychain'],
    extendInfo: {
      NSAppleEventsUsageDescription: 'Trace uses automation to capture workflows you choose to record.',
      NSScreenCaptureUsageDescription: 'Trace records your screen only when you start a workflow recording.',
    },
  },
  dmg: { contents: [{ x: 130, y: 220 }, { x: 410, y: 220, type: 'link', path: '/Applications' }] },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'Trace-${version}-win-${arch}.${ext}',
    icon: 'resources/trace-spirit-icon.png',
    verifyUpdateCodeSignature: true,
    signExts: ['.dll', '.exe'],
  },
  nsis: {
    oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
    createDesktopShortcut: 'always', createStartMenuShortcut: true, shortcutName: 'Trace',
  },
}
