import { AppUpdateService } from './app-update-service'
import { createElectronUpdateTransport, createDevelopmentUpdateTransport } from './app-update-transport'
import { AppUpdateInstaller } from './app-update-install'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, screen, shell, Tray } from 'electron'
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  BrowserCaptureCommand,
  BrowserCaptureEnvelope,
  RecorderCommand,
  RecorderEnvelope,
} from '@workflow-skill/capture-protocol'
import { DEFAULT_AI_TOOLS, type AIProjectItem, type AIToolTarget, type DeleteSkillMode, type Skill, type Workflow } from '@workflow-skill/workflow-model'
import { CaptureRepository } from './capture-repository'
import { BrowserCaptureManager } from './browser-capture-manager'
import { NativeRecorderManager } from './recorder-manager'
import { deleteSkillPaths } from './skill-deletion'
import { searchRepositorySkills } from './skill-repository-search'
import {
  deleteMCPServer,
  distributeMCPServer,
  preflightMCPDistribution,
  readAllMCPServers,
  saveMCPServer,
  toggleMCPServer,
  readCentralMCPServers,
  saveCentralMCPServer,
  deleteCentralMCPServer,
  injectMCPServerToTarget,
  uninjectMCPServerFromTarget,
  batchInjectMCPServers,
  batchUninjectMCPServers,
} from './mcp-manager'
import {
  listProjects,
  getActiveProject,
  setActiveProject,
  addProject,
  removeProject,
  scanProjectSkillPaths,
  getStoredProjectWorkspace as getStoredProjectWorkspaceFromManager,
  SUPPORTED_PROJECT_SKILL_PATHS,
} from './project-manager'
import {
  listRules,
  getRule,
  saveRule,
  deleteRule,
  getProjectRuleConfig,
  setProjectRules,
  uninjectRuleFromProject,
  syncProjectRules,
  createClaudeMdLink,
  checkClaudeMdLink,
} from './rule-manager'
import {
  injectSkillToTarget,
  uninjectSkillFromTarget,
  batchInjectSkills,
  batchUninjectSkills,
} from './skill-injection-manager'
import { AccountManager } from './account-manager'
import { AccountOAuthService } from './account-oauth'
import { createAccountOAuthProviders } from './account-oauth-providers'
import { AccountError, sanitizeErrorMessage, type AccountTool, type AccountActionResult } from '@workflow-skill/workflow-model/accounts'

const defaultTraceHome = path.join(os.homedir(), '.trace')

function getStoredTraceHome(): string {
  const configPath = path.join(defaultTraceHome, 'config.json')
  try {
    if (existsSync(configPath)) {
      const data = JSON.parse(readFileSync(configPath, 'utf8'))
      if (data.storagePath) return data.storagePath
    }
  } catch {}
  return defaultTraceHome
}

function ensureTraceDirectories(rootPath = getStoredTraceHome()) {
  const subdirs = [
    rootPath,
    path.join(rootPath, 'skills'),
    path.join(rootPath, 'workflows'),
    path.join(rootPath, 'captures'),
  ]
  for (const dir of subdirs) {
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {}
    }
  }
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const recorder = new NativeRecorderManager()
const browserCapture = new BrowserCaptureManager()
const defaultCapturePolicy: Extract<RecorderCommand, { type: 'policy' }> = {
  type: 'policy',
  excludedBundleIds: [
    'com.github.Electron',
    'com.1password.1password',
    'com.agilebits.onepassword7',
    'com.bitwarden.desktop',
    'com.apple.keychainaccess',
    'com.apple.Passwords',
    'Trace',
    'trace',
    '1Password',
    'Bitwarden',
    'KeePass',
    'KeePassXC',
  ],
  excludedWindowTitlePatterns: [],
}
const captureRepository = new CaptureRepository({
  getRootPath: getStoredTraceHome,
  onWorkflowsChanged: () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !browserCapture.ownsWindow(window)) {
        window.webContents.send('capture:workflows-changed')
      }
    }
  },
})
function resolveResourcePath(filename: string): string {
  const packagedPath = path.join(process.resourcesPath, filename)
  if (app.isPackaged && existsSync(packagedPath)) return packagedPath

  const candidates = [
    path.resolve(currentDirectory, '../resources', filename),
    path.resolve(currentDirectory, '../../resources', filename),
    path.resolve(process.cwd(), 'apps/desktop/resources', filename),
    path.resolve(process.cwd(), 'resources', filename),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return path.resolve(currentDirectory, '../resources', filename)
}

const iconPath = resolveResourcePath('trace-spirit-icon.png')

app.setName('Trace')

let statusTray: Tray | null = null
let trayAnimationTimer: ReturnType<typeof setInterval> | undefined
let trayFrame = 0
let trayIsMoving = false
let cachedStoppedTrayFrame: Electron.NativeImage | undefined
let cachedMovingTrayFrames: Electron.NativeImage[] = []

const movingTrayWaves = [0, 0.7, 1, 0.7, 0, -0.7, -1, -0.7]

function loadTrayFrame(frameIndex = 0, moving = false): Electron.NativeImage {
  const filename = moving ? `trace-tray-frame-${frameIndex % 8}.png` : 'trace-tray-spirit.png'
  const filePath = resolveResourcePath(filename)
  if (existsSync(filePath)) {
    const img = nativeImage.createFromPath(filePath)
    if (!img.isEmpty()) {
      const resized = img.resize({ width: 18, height: 18, quality: 'best' })
      if (process.platform === 'darwin') {
        resized.setTemplateImage(true)
      }
      return resized
    }
  }

  // Fallback: Pure monochrome SVG path without nested raster tags
  const wave = moving ? movingTrayWaves[frameIndex % movingTrayWaves.length] : 0
  const leftTailY = 17.2 + wave * 0.55
  const centerTailY = 18 - wave * 0.45
  const rightTailY = 17.3 + wave * 0.35
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 20 20">
    <defs>
      <mask id="eyes-${frameIndex}">
        <rect width="20" height="20" fill="white"/>
        <ellipse cx="8" cy="8.3" rx="0.65" ry="1.1" fill="black"/>
        <ellipse cx="12" cy="8.3" rx="0.65" ry="1.1" fill="black"/>
      </mask>
    </defs>
    <g>
      <path mask="url(#eyes-${frameIndex})" fill="black" d="
        M10 1.8
        C6.55 1.8 4.2 4.55 4.2 8.2
        L4.2 10.45
        C4.2 11.2 3.85 11.75 3.2 12.15
        L2.05 12.85
        C1.35 13.28 1.55 14.28 2.3 14.52
        C3.02 14.75 3.78 14.4 4.42 13.78
        L4.42 15.55
        C4.42 16.75 5.3 18 6.28 ${leftTailY}
        C7.18 16.38 7.62 18.08 8.8 ${centerTailY}
        C9.85 17.92 10.35 16.4 11.32 17.18
        C12.4 18.08 13.38 18.25 14.18 ${rightTailY}
        C15.05 16.25 15.58 15.05 15.58 13.78
        C16.22 14.4 16.98 14.75 17.7 14.52
        C18.45 14.28 18.65 13.28 17.95 12.85
        L16.8 12.15
        C16.15 11.75 15.8 11.2 15.8 10.45
        L15.8 8.2
        C15.8 4.55 13.45 1.8 10 1.8 Z"/>
    </g>
  </svg>`
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

function showMainWindow() {
  recorder.closePermisoOverlay()
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) {
    createWindow()
    return
  }
  if (!window.isVisible()) window.show()
  window.focus()
}

function updateTrayMenu() {
  if (!statusTray) return
  statusTray.setToolTip(trayIsMoving ? 'Trace · 正在观察' : 'Trace · 已停止')
  statusTray.setContextMenu(Menu.buildFromTemplate([
    { label: trayIsMoving ? '正在观察' : '已停止', enabled: false },
    { type: 'separator' },
    { label: '打开 Trace', click: showMainWindow },
  ]))
}

function setTrayMoving(moving: boolean) {
  if (!statusTray) return
  if (trayIsMoving === moving && trayAnimationTimer) return
  trayIsMoving = moving
  if (trayAnimationTimer) clearInterval(trayAnimationTimer)
  trayAnimationTimer = undefined
  trayFrame = 0

  if (!cachedStoppedTrayFrame) {
    cachedStoppedTrayFrame = loadTrayFrame(0, false)
  }
  if (cachedMovingTrayFrames.length === 0) {
    cachedMovingTrayFrames = Array.from({ length: 8 }, (_, i) => loadTrayFrame(i, true))
  }

  statusTray.setImage(moving ? cachedMovingTrayFrames[0] : cachedStoppedTrayFrame)
  updateTrayMenu()
  if (!moving) return

  trayAnimationTimer = setInterval(() => {
    if (!statusTray || !cachedMovingTrayFrames.length) return
    trayFrame = (trayFrame + 1) % cachedMovingTrayFrames.length
    statusTray.setImage(cachedMovingTrayFrames[trayFrame])
  }, 120)
}

function createStatusTray() {
  if (process.platform !== 'darwin' || statusTray) return
  if (!cachedStoppedTrayFrame) {
    cachedStoppedTrayFrame = loadTrayFrame(0, false)
  }
  statusTray = new Tray(cachedStoppedTrayFrame)
  statusTray.on('click', showMainWindow)
  setTrayMoving(false)
}

function windowsOwnerHandle() {
  if (process.platform !== 'win32') return undefined
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return undefined
  const handle = window.getNativeWindowHandle()
  return handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE())
}

let mainWindow: BrowserWindow | null = null
let updateInstaller: AppUpdateInstaller | undefined
let blockWindowCloseForUpdate: (() => string | undefined) | undefined
let captureCommandPending = 0

function createWindow() {
  const isDarwin = process.platform === 'darwin'
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

  // Comfortable, sleek, compact default window dimensions (1020 x 680)
  const defaultWidth = Math.min(1020, Math.max(820, Math.round(screenWidth * 0.72)))
  const defaultHeight = Math.min(680, Math.max(540, Math.round(screenHeight * 0.72)))

  const window = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    minWidth: 780,
    minHeight: 500,
    center: true,
    titleBarStyle: isDarwin ? 'hiddenInset' : 'default',
    trafficLightPosition: isDarwin ? { x: 16, y: 16 } : undefined,
    transparent: isDarwin,
    vibrancy: isDarwin ? 'under-window' : undefined,
    backgroundColor: '#00000000',
    hasShadow: true,
    icon: iconPath,
    show: false,
    webPreferences: {
      // Electron preload runs in a CommonJS-capable isolated world. Using a
      // `.cjs` extension is important because this package itself is ESM.
      preload: path.join(currentDirectory, 'preload.cjs'),
      sandbox: false,
    },
  })
  mainWindow = window
  window.on('close', event => {
    const reason = blockWindowCloseForUpdate?.()
    if (reason) {
      event.preventDefault()
      void dialog.showMessageBox(window, { type: 'info', message: reason, buttons: ['好'] })
    }
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  window.once('ready-to-show', () => window.show())

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void window.loadFile(path.join(currentDirectory, '../dist/index.html'))
  }
}

function getAppBundlePath(): string {
  if (app.isPackaged) {
    const execPath = process.execPath
    const appIndex = execPath.indexOf('.app')
    if (appIndex !== -1) {
      return execPath.slice(0, appIndex + 4)
    }
  }
  return process.execPath
}

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

app.whenReady().then(() => {
  ensureTraceDirectories()
  const icon = nativeImage.createFromPath(iconPath)
  if (process.platform === 'darwin' && !icon.isEmpty()) app.dock?.setIcon(icon)
  createStatusTray()

  recorder.on('message', (envelope: RecorderEnvelope) => {
    captureRepository.handleRecorderEnvelope(envelope)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !browserCapture.ownsWindow(window)) window.webContents.send('recorder:message', envelope)
    }
    if (envelope.type === 'status') {
      setTrayMoving(envelope.payload.state === 'observing')
    }
  })

  browserCapture.on('message', (envelope: BrowserCaptureEnvelope) => {
    captureRepository.handleBrowserCaptureEnvelope(envelope)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !browserCapture.ownsWindow(window)) {
        window.webContents.send('browser-capture:message', envelope)
      }
    }
    if (envelope.type === 'status') setTrayMoving(envelope.payload.state === 'capturing')
  })

  ipcMain.handle('system:theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))
  ipcMain.handle('system:set-theme', (_event, theme: 'dark' | 'light' | 'system') => {
    nativeTheme.themeSource = theme
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  })
  ipcMain.handle('recorder:status', () => recorder.getStatus())
  ipcMain.handle('recorder:command', async (_event, command: RecorderCommand) => {
    if (updateInstaller?.preparing || updateInstaller?.approved) throw new Error('正在安装应用更新。')
    captureCommandPending++
    try {
      const allowed = new Set(['start', 'pause', 'resume', 'stop', 'status', 'permissions', 'policy'])
      if (!allowed.has(command.type)) throw new Error('Unsupported recorder command')
      if (command.type === 'start' && browserCapture.getStatus().state === 'capturing') {
        await browserCapture.command({ type: 'stop' })
      }
      if (command.type === 'start') recorder.command(defaultCapturePolicy)
      return recorder.command({ ...command, ownerWindowHandle: windowsOwnerHandle() })
    } finally { captureCommandPending-- }
  })
  ipcMain.handle('browser-capture:status', () => browserCapture.getStatus())
  ipcMain.handle('browser-capture:command', async (_event, command: BrowserCaptureCommand) => {
    if (updateInstaller?.preparing || updateInstaller?.approved) throw new Error('正在安装应用更新。')
    captureCommandPending++
    try {
      const allowed = new Set(['start', 'stop', 'status'])
      if (!allowed.has(command.type)) throw new Error('Unsupported browser capture command')
      if (command.type === 'start' && recorder.getStatus().state === 'observing') {
        recorder.command({ type: 'stop' })
      }
      return await browserCapture.command(command)
    } finally { captureCommandPending-- }
  })
  ipcMain.handle('capture:list-workflows', () => captureRepository.loadWorkflows())
  ipcMain.handle('capture:list-events', (_event, limit?: number) => (
    captureRepository.loadRecentEvents(limit)
  ))
  ipcMain.handle('capture:dismiss-workflow', (_event, workflowId: string) => (
    captureRepository.dismissWorkflow(workflowId)
  ))
  ipcMain.handle('capture:update-workflow', (_event, workflow: Workflow) => (
    captureRepository.updateWorkflow(workflow)
  ))
  ipcMain.handle('skills:search-repository', (_event, repository: string) => (
    searchRepositorySkills(repository, getStoredProjectWorkspace())
  ))

  ipcMain.handle('system:open-privacy-settings', async (_event, type: 'accessibility' | 'screenRecording', sourceFrame?: WindowBounds) => {
    if (process.platform === 'darwin') {
      const appPath = getAppBundlePath()
      recorder.showPermisoOverlay(type, appPath, sourceFrame)
    }
  })

  let linkWindow: BrowserWindow | null = null

  ipcMain.handle('system:open-skill-link-window', (_event, skillId: string) => {
    if (linkWindow && !linkWindow.isDestroyed()) {
      linkWindow.focus()
      linkWindow.webContents.send('link-window:set-skill-id', skillId)
      return
    }

    const mainWindow = BrowserWindow.getAllWindows().find((w) => w !== linkWindow)
    const isDarwin = process.platform === 'darwin'

    linkWindow = new BrowserWindow({
      width: 520,
      height: 620,
      minWidth: 460,
      minHeight: 480,
      title: 'AI 环境分发树',
      titleBarStyle: isDarwin ? 'hiddenInset' : 'default',
      trafficLightPosition: isDarwin ? { x: 14, y: 14 } : undefined,
      transparent: isDarwin,
      vibrancy: isDarwin ? 'under-window' : undefined,
      backgroundColor: '#00000000',
      hasShadow: true,
      show: false,
      webPreferences: {
        preload: path.join(currentDirectory, 'preload.cjs'),
        sandbox: false,
      },
    })

    linkWindow.once('ready-to-show', () => linkWindow?.show())
    linkWindow.on('closed', () => {
      linkWindow = null
    })

    const hash = `#link-manager?skillId=${encodeURIComponent(skillId)}`
    if (process.env.VITE_DEV_SERVER_URL) {
      void linkWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}${hash}`)
    } else {
      void linkWindow.loadFile(path.join(currentDirectory, '../dist/index.html'), {
        hash: `link-manager?skillId=${encodeURIComponent(skillId)}`,
      })
    }
  })

  ipcMain.handle('system:close-skill-link-window', () => {
    if (linkWindow && !linkWindow.isDestroyed()) {
      linkWindow.close()
    }
  })

  ipcMain.handle('system:center-window', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.center()
    }
  })

  ipcMain.handle('system:locate-app-in-finder', async () => {
    if (process.platform === 'darwin') {
      const appPath = getAppBundlePath()
      shell.showItemInFolder(appPath)
    }
  })

  ipcMain.handle('system:get-storage-path', () => {
    const root = getStoredTraceHome()
    ensureTraceDirectories(root)
    return root
  })

  ipcMain.handle('system:select-storage-path', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const currentRoot = getStoredTraceHome()
    ensureTraceDirectories(currentRoot)

    const result = await dialog.showOpenDialog(win!, {
      title: 'Select Data Storage Folder',
      defaultPath: existsSync(currentRoot) ? currentRoot : os.homedir(),
      properties: ['openDirectory', 'createDirectory'],
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const selectedRoot = result.filePaths[0]
      ensureTraceDirectories(selectedRoot)
      try {
        const configPath = path.join(defaultTraceHome, 'config.json')
        let data: Record<string, any> = {}
        if (existsSync(configPath)) {
          data = JSON.parse(readFileSync(configPath, 'utf8'))
        }
        data.storagePath = selectedRoot
        writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8')
        disposeAccountManager()
      } catch {}
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('capture:workflows-changed')
      }
      return selectedRoot
    }
    return null
  })

  ipcMain.handle('system:reset-storage-path', () => {
    ensureTraceDirectories(defaultTraceHome)
    try {
      const configPath = path.join(defaultTraceHome, 'config.json')
      let data: Record<string, any> = {}
      if (existsSync(configPath)) {
        data = JSON.parse(readFileSync(configPath, 'utf8'))
      }
      delete data.storagePath
      writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8')
      disposeAccountManager()
    } catch {}
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('capture:workflows-changed')
    }
    return defaultTraceHome
  })

  ipcMain.handle('system:open-path', async (_event, targetPath: string) => {
    if (existsSync(targetPath)) {
      await shell.openPath(targetPath)
    } else {
      try {
        mkdirSync(targetPath, { recursive: true })
        await shell.openPath(targetPath)
      } catch {}
    }
  })

  function getStoredProjectWorkspace(): string {
    return getStoredProjectWorkspaceFromManager(getStoredTraceHome())
  }

  function setStoredProjectWorkspace(workspacePath: string) {
    setActiveProject(workspacePath, getStoredTraceHome())
  }

  function getAIToolDirectory(tool: AIToolTarget): string {
    const projectRoot = getStoredProjectWorkspace()
    if (tool.scope === 'project' && !projectRoot) return ''

    if (tool.customDir) {
      if (path.isAbsolute(tool.customDir)) return tool.customDir
      return tool.scope === 'project'
        ? path.join(projectRoot, tool.customDir)
        : path.join(os.homedir(), tool.customDir)
    }

    if (tool.scope === 'project') {
      return path.join(projectRoot, tool.defaultDir)
    }

    // Dynamic resolution for Gemini / Antigravity global paths
    if (tool.id === 'gemini-global') {
      const candidates = [
        path.join(os.homedir(), '.gemini/antigravity/skills'),
        path.join(os.homedir(), '.gemini/config/skills'),
        path.join(os.homedir(), '.gemini/skills'),
      ]
      for (const cand of candidates) {
        if (existsSync(cand)) return cand
      }
    }

    return path.join(os.homedir(), tool.defaultDir)
  }

  function detectInstalledAITools(): AIToolTarget[] {
    return DEFAULT_AI_TOOLS.map((tool) => {
      const dir = getAIToolDirectory(tool)
      if (tool.scope === 'project' && !dir) {
        return {
          ...tool,
          installed: false,
          detectedPath: '',
          itemCount: 0,
        }
      }
      const baseDir = path.dirname(dir)
      const installed = existsSync(dir) || (tool.scope === 'global' && existsSync(baseDir))
      let itemCount = 0
      if (existsSync(dir)) {
        try {
          const files = readdirSync(dir)
          itemCount = files.filter((f) => !f.startsWith('.')).length
        } catch {}
      }
      return {
        ...tool,
        installed,
        detectedPath: dir,
        itemCount,
      }
    })
  }

  function scanAIProjects(): AIProjectItem[] {
    const projectsMap = new Map<string, AIProjectItem>()
    const home = os.homedir()
    const projectMarkerCache = new Map<string, boolean>()
    const aiConfigSegments = new Set([
      '.agent',
      '.agents',
      '.claude',
      '.cline',
      '.codex',
      '.cursor',
      '.gemini',
      '.github',
      '.opencode',
      '.roo',
      '.trace',
      '.trae',
      '.vscode',
      '.windsurf',
    ])
    const projectMarkers = [
      '.git',
      '.hg',
      '.svn',
      'package.json',
      'pnpm-workspace.yaml',
      'yarn.lock',
      'bun.lock',
      'bun.lockb',
      'Cargo.toml',
      'go.mod',
      'pyproject.toml',
      'requirements.txt',
      'Pipfile',
      'poetry.lock',
      'composer.json',
      'Gemfile',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
      'Package.swift',
      'pubspec.yaml',
      'mix.exs',
      'deno.json',
      'deno.jsonc',
      'CMakeLists.txt',
    ]

    const isInside = (parent: string, candidate: string) => {
      const relative = path.relative(parent, candidate)
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    }

    const getTimestamp = (value: unknown, fallback = 0) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 1_000_000_000_000 ? value * 1000 : value
      }
      if (typeof value === 'string') {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
      }
      return fallback
    }

    const getMtime = (targetPath: string) => {
      try {
        return statSync(targetPath).mtimeMs
      } catch {
        return 0
      }
    }

    const collapseAIConfigPath = (candidate: string): string => {
      const parsed = path.parse(candidate)
      const relativeParts = candidate.slice(parsed.root.length).split(path.sep).filter(Boolean)
      const configIndex = relativeParts.findIndex((part) => aiConfigSegments.has(part.toLowerCase()))
      if (configIndex < 0) return candidate
      return path.join(parsed.root, ...relativeParts.slice(0, configIndex))
    }

    const hasProjectMarker = (candidate: string): boolean => {
      const cached = projectMarkerCache.get(candidate)
      if (cached !== undefined) return cached

      let found = projectMarkers.some((marker) => existsSync(path.join(candidate, marker)))
      if (!found) {
        try {
          found = readdirSync(candidate, { withFileTypes: true }).some((entry) => {
            const name = entry.name.toLowerCase()
            return name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace') || name.endsWith('.sln') || name.endsWith('.csproj')
          })
        } catch {}
      }
      projectMarkerCache.set(candidate, found)
      return found
    }

    const findProjectRoot = (candidate: string): string | null => {
      let current = collapseAIConfigPath(candidate)
      const root = path.parse(current).root
      while (current !== root && current !== home) {
        if (hasProjectMarker(current)) return current
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
      return null
    }

    const normalizeLocalPath = (rawPath: unknown): string | null => {
      if (typeof rawPath !== 'string' || !rawPath.trim()) return null
      let cleanPath = rawPath.trim()
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(cleanPath) && !cleanPath.startsWith('file://')) {
        return null
      }
      try {
        if (cleanPath.startsWith('file://')) cleanPath = fileURLToPath(cleanPath)
      } catch {
        return null
      }
      if (cleanPath === '~') cleanPath = home
      if (cleanPath.startsWith(`~${path.sep}`)) cleanPath = path.join(home, cleanPath.slice(2))
      if (!path.isAbsolute(cleanPath)) return null
      return path.normalize(cleanPath)
    }

    function addProject(rawPath: unknown, source: string, lastOpenedAt = 0) {
      const cleanPath = normalizeLocalPath(rawPath)
      if (!cleanPath || !existsSync(cleanPath)) return
      try {
        const stat = statSync(cleanPath)
        const candidate = stat.isDirectory() ? cleanPath : path.dirname(cleanPath)
        const privateToolRoots = [
          path.join(home, '.agent'),
          path.join(home, '.agents'),
          path.join(home, '.claude'),
          path.join(home, '.codex'),
          path.join(home, '.config', 'opencode'),
          path.join(home, '.continue'),
          path.join(home, '.gemini'),
          path.join(home, '.local', 'share', 'opencode'),
          path.join(home, '.trace'),
        ]
        if (privateToolRoots.some((root) => isInside(root, candidate))) return

        const projectRoot = findProjectRoot(candidate)
        if (!projectRoot) return
        const dirPath = realpathSync(projectRoot)
        const pathParts = dirPath.split(path.sep)
        const tempRoots = [os.tmpdir(), '/tmp', '/private/tmp', '/private/var']

        if (
          dirPath === path.parse(dirPath).root ||
          dirPath === home ||
          pathParts.includes('node_modules') ||
          pathParts.includes('.git') ||
          tempRoots.some((root) => isInside(root, dirPath)) ||
          privateToolRoots.some((root) => isInside(root, dirPath))
        ) {
          return
        }

        const mapKey = process.platform === 'win32' ? dirPath.toLowerCase() : dirPath
        const existing = projectsMap.get(mapKey)
        if (!existing) {
          projectsMap.set(mapKey, {
            id: dirPath,
            name: path.basename(dirPath),
            path: dirPath,
            sources: [source],
            skillDir: path.join(dirPath, '.agents', 'skills'),
            lastOpenedAt: lastOpenedAt || stat.mtimeMs,
          })
          return
        }

        if (!existing.sources.includes(source)) existing.sources.push(source)
        existing.lastOpenedAt = Math.max(existing.lastOpenedAt, lastOpenedAt || stat.mtimeMs)
      } catch {}
    }

    function addWorkspaceFile(rawPath: unknown, source: string, lastOpenedAt: number) {
      const workspacePath = normalizeLocalPath(rawPath)
      if (!workspacePath || !existsSync(workspacePath)) return
      try {
        const stat = statSync(workspacePath)
        if (!stat.isFile()) {
          addProject(workspacePath, source, lastOpenedAt)
          return
        }
        const data = JSON.parse(readFileSync(workspacePath, 'utf8'))
        const folders = Array.isArray(data.folders) ? data.folders : []
        for (const folder of folders) {
          const folderRef = folder?.uri || folder?.path
          if (typeof folderRef !== 'string') continue
          if (folderRef.startsWith('file://') || path.isAbsolute(folderRef)) {
            addProject(folderRef, source, lastOpenedAt)
          } else {
            addProject(path.resolve(path.dirname(workspacePath), folderRef), source, lastOpenedAt)
          }
        }
        if (folders.length === 0) addProject(path.dirname(workspacePath), source, lastOpenedAt)
      } catch {
        addProject(path.dirname(workspacePath), source, lastOpenedAt)
      }
    }

    function scanWorkspaceStorage(storagePath: string, source: string) {
      if (!existsSync(storagePath)) return
      try {
        for (const entry of readdirSync(storagePath, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const workspaceJson = path.join(storagePath, entry.name, 'workspace.json')
          if (!existsSync(workspaceJson)) continue
          try {
            const data = JSON.parse(readFileSync(workspaceJson, 'utf8'))
            const lastOpenedAt = Math.max(getMtime(workspaceJson), getMtime(path.dirname(workspaceJson)))
            if (data.folder) addProject(data.folder, source, lastOpenedAt)
            if (data.workspace) addWorkspaceFile(data.workspace, source, lastOpenedAt)
          } catch {}
        }
      } catch {}
    }

    // Electron-based AI IDEs store one workspace.json per opened project.
    const appData = app.getPath('appData')
    const editorStores = [
      { source: 'Cursor', productDirs: ['Cursor', 'cursor'] },
      { source: 'Trae', productDirs: ['Trae', 'trae'] },
      { source: 'Windsurf', productDirs: ['Windsurf', 'windsurf'] },
      { source: 'Antigravity', productDirs: ['Antigravity', 'antigravity'] },
      { source: 'VS Code', productDirs: ['Code', 'code'] },
    ]
    const scannedWorkspaceStores = new Set<string>()
    for (const editor of editorStores) {
      for (const productDir of editor.productDirs) {
        const storagePath = path.join(appData, productDir, 'User', 'workspaceStorage')
        if (scannedWorkspaceStores.has(storagePath)) continue
        scannedWorkspaceStores.add(storagePath)
        scanWorkspaceStorage(storagePath, editor.source)
      }
    }

    // Gemini CLI and Antigravity keep both a path index and richer project records.
    const geminiProjects = path.join(home, '.gemini', 'projects.json')
    if (existsSync(geminiProjects)) {
      try {
        const data = JSON.parse(readFileSync(geminiProjects, 'utf8'))
        const lastOpenedAt = getMtime(geminiProjects)
        for (const projectPath of Object.keys(data.projects || {})) {
          addProject(projectPath, 'Gemini', lastOpenedAt)
        }
      } catch {}
    }
    const geminiProjectRecords = path.join(home, '.gemini', 'config', 'projects')
    if (existsSync(geminiProjectRecords)) {
      try {
        for (const entry of readdirSync(geminiProjectRecords, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue
          const recordPath = path.join(geminiProjectRecords, entry.name)
          try {
            const data = JSON.parse(readFileSync(recordPath, 'utf8'))
            const lastOpenedAt = getTimestamp(data.updatedAt, getMtime(recordPath))
            for (const resource of data.projectResources?.resources || []) {
              addProject(resource?.gitFolder?.folderUri, 'Gemini', lastOpenedAt)
            }
          } catch {}
        }
      } catch {}
    }

    // Claude Code project directory names are lossy; read the cwd recorded in JSONL instead.
    const claudeProjectsDir = path.join(home, '.claude', 'projects')
    if (existsSync(claudeProjectsDir)) {
      try {
        for (const entry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const sessionDir = path.join(claudeProjectsDir, entry.name)
          let newestSession = ''
          let newestMtime = 0
          try {
            for (const file of readdirSync(sessionDir, { withFileTypes: true })) {
              if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
              const sessionPath = path.join(sessionDir, file.name)
              const mtime = getMtime(sessionPath)
              if (mtime > newestMtime) {
                newestMtime = mtime
                newestSession = sessionPath
              }
            }
          } catch {}
          if (!newestSession) continue

          let fd: number | undefined
          try {
            fd = openSync(newestSession, 'r')
            const buffer = Buffer.alloc(128 * 1024)
            const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
            for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
              if (!line.trim()) continue
              try {
                const data = JSON.parse(line)
                if (data.cwd) {
                  addProject(data.cwd, 'Claude Code', newestMtime)
                  break
                }
              } catch {}
            }
          } catch {
            // Ignore incomplete session logs while Claude is still writing them.
          } finally {
            if (fd !== undefined) closeSync(fd)
          }
        }
      } catch {}
    }

    // Codex Desktop persists its opened project roots in a compact global state file.
    const codexStateCandidates = [
      path.join(home, '.codex', '.codex-global-state.json'),
      path.join(home, '.codex', '.codex-global-state.json.bak'),
    ]
    for (const statePath of codexStateCandidates) {
      if (!existsSync(statePath)) continue
      try {
        const data = JSON.parse(readFileSync(statePath, 'utf8'))
        const stateMtime = getMtime(statePath)
        for (const key of ['active-workspace-roots', 'electron-saved-workspace-roots']) {
          for (const projectPath of Array.isArray(data[key]) ? data[key] : []) {
            addProject(projectPath, 'Codex', stateMtime)
          }
        }
        for (const project of Object.values(data['local-projects'] || {}) as Array<Record<string, unknown>>) {
          const lastOpenedAt = getTimestamp(project.updatedAt, stateMtime)
          for (const projectPath of Array.isArray(project.rootPaths) ? project.rootPaths : []) {
            addProject(projectPath, 'Codex', lastOpenedAt)
          }
        }
        break
      } catch {}
    }

    // OpenCode's JSON storage remains available alongside its newer SQLite index.
    const openCodeProjectsDir = path.join(home, '.local', 'share', 'opencode', 'storage', 'project')
    if (existsSync(openCodeProjectsDir)) {
      try {
        for (const entry of readdirSync(openCodeProjectsDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'global.json') continue
          const recordPath = path.join(openCodeProjectsDir, entry.name)
          try {
            const data = JSON.parse(readFileSync(recordPath, 'utf8'))
            const lastOpenedAt = getTimestamp(data.time?.updated || data.time?.created, getMtime(recordPath))
            addProject(data.directory || data.worktree || data.vcsDir, 'OpenCode', lastOpenedAt)
          } catch {}
        }
      } catch {}
    }

    return Array.from(projectsMap.values()).sort((a, b) => {
      if (a.lastOpenedAt !== b.lastOpenedAt) return b.lastOpenedAt - a.lastOpenedAt
      return a.name.localeCompare(b.name, 'zh-CN')
    })
  }

  ipcMain.handle('system:get-ai-projects', () => scanAIProjects())

  ipcMain.handle('system:select-custom-project', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: '选择项目工作区文件夹',
      properties: ['openDirectory'],
    })
    if (!result.canceled && result.filePaths.length > 0) {
      const selected = result.filePaths[0]
      return {
        id: selected,
        name: path.basename(selected),
        path: selected,
        sources: ['自定义'],
        skillDir: path.join(selected, '.agents', 'skills'),
        lastOpenedAt: Date.now(),
      }
    }
    return null
  })

  ipcMain.handle('system:link-skill-project', (_event, skillId: string, projectPath: string) => {
    if (!skillId || !projectPath) return { success: false }
    const root = getStoredTraceHome()
    const skillsDir = path.join(root, 'skills')
    const filePath = path.join(skillsDir, `${skillId}.json`)
    if (!existsSync(filePath)) return { success: false }

    try {
      const skill: Skill = JSON.parse(readFileSync(filePath, 'utf8'))
      const centralFolder = ensureSkillCentralDirectory(skill)

      const projectSkillDir = path.join(projectPath, '.agents', 'skills')
      if (!existsSync(projectSkillDir)) {
        mkdirSync(projectSkillDir, { recursive: true })
      }

      const targetLink = path.join(projectSkillDir, skillId)
      safeRemoveLink(targetLink)

      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(path.resolve(centralFolder), path.resolve(targetLink), symlinkType)

      const updatedProjects = Array.from(new Set([...(skill.targetProjects || []), projectPath]))
      skill.targetProjects = updatedProjects
      writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')

      return { success: true, linkPath: targetLink }
    } catch (err) {
      console.error(`Failed to link skill ${skillId} to project ${projectPath}:`, err)
      return { success: false }
    }
  })

  ipcMain.handle('system:unlink-skill-project', (_event, skillId: string, projectPath: string) => {
    if (!skillId || !projectPath) return { success: false }
    const root = getStoredTraceHome()
    const skillsDir = path.join(root, 'skills')
    const filePath = path.join(skillsDir, `${skillId}.json`)
    if (!existsSync(filePath)) return { success: false }

    try {
      const skill: Skill = JSON.parse(readFileSync(filePath, 'utf8'))
      const projectSkillDir = path.join(projectPath, '.agents', 'skills')
      const targetLink = path.join(projectSkillDir, skillId)
      safeRemoveLink(targetLink)

      skill.targetProjects = (skill.targetProjects || []).filter((p) => p !== projectPath)
      writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')

      return { success: true }
    } catch (err) {
      console.error(`Failed to unlink skill ${skillId} from project ${projectPath}:`, err)
      return { success: false }
    }
  })

  ipcMain.handle('system:link-all-skills-project', (_event, projectPath: string) => {
    if (!projectPath) return { success: false, count: 0 }
    const root = getStoredTraceHome()
    const centralSkillsDir = path.join(root, 'skills')
    const allSkills = discoverAllGlobalSkills()
    const projectSkillDir = path.join(projectPath, '.agents', 'skills')
    if (!existsSync(projectSkillDir)) {
      mkdirSync(projectSkillDir, { recursive: true })
    }

    let count = 0
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'

    for (const skill of allSkills) {
      try {
        const centralFolder = ensureSkillCentralDirectory(skill)
        const targetLink = path.join(projectSkillDir, skill.id)
        safeRemoveLink(targetLink)
        symlinkSync(path.resolve(centralFolder), path.resolve(targetLink), symlinkType)

        const filePath = path.join(centralSkillsDir, `${skill.id}.json`)
        if (existsSync(filePath)) {
          const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
          parsed.targetProjects = Array.from(new Set([...(parsed.targetProjects || []), projectPath]))
          writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8')
        }
        count++
      } catch (err) {
        console.error(`Failed to bulk link skill ${skill.id} to project:`, err)
      }
    }
    return { success: true, count }
  })

  ipcMain.handle('system:unlink-all-skills-project', (_event, projectPath: string) => {
    if (!projectPath) return { success: false, count: 0 }
    const root = getStoredTraceHome()
    const centralSkillsDir = path.join(root, 'skills')
    const allSkills = discoverAllGlobalSkills()
    const projectSkillDir = path.join(projectPath, '.agents', 'skills')

    let count = 0
    for (const skill of allSkills) {
      try {
        const targetLink = path.join(projectSkillDir, skill.id)
        safeRemoveLink(targetLink)

        const filePath = path.join(centralSkillsDir, `${skill.id}.json`)
        if (existsSync(filePath)) {
          const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
          parsed.targetProjects = (parsed.targetProjects || []).filter((p: string) => p !== projectPath)
          writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8')
        }
        count++
      } catch (err) {
        console.error(`Failed to bulk unlink skill ${skill.id} from project:`, err)
      }
    }
    return { success: true, count }
  })

  ipcMain.handle('system:get-project-workspace', () => getStoredProjectWorkspace())
  ipcMain.handle('system:select-project-workspace', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择项目工作区根目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getStoredProjectWorkspace(),
    })
    if (!res.canceled && res.filePaths.length > 0) {
      const selected = res.filePaths[0]
      setStoredProjectWorkspace(selected)
      return selected
    }
    return getStoredProjectWorkspace()
  })

  ipcMain.handle('system:migrate-all-skills-to-project', async (_event, customProjectPath?: string) => {
    const root = getStoredTraceHome()
    const centralSkillsDir = path.join(root, 'skills')
    const projectWorkspace = customProjectPath || getStoredProjectWorkspace()

    if (!projectWorkspace || !existsSync(projectWorkspace)) {
      return {
        success: false,
        count: 0,
        projectWorkspace: projectWorkspace || '',
        targetDir: '',
        error: '项目工作区目录不存在',
      }
    }

    const targetDir = path.join(projectWorkspace, '.agents', 'skills')
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true })
    }

    const allSkills = discoverAllGlobalSkills()
    let migratedCount = 0

    for (const skill of allSkills) {
      try {
        const skillId = skill.id
        const projectSkillFolder = path.join(targetDir, skillId)
        const centralSkillFolder = path.join(centralSkillsDir, skillId)
        const centralSkillJson = path.join(centralSkillsDir, `${skillId}.json`)

        // 1. Ensure project skill folder exists and has SKILL.md
        if (!existsSync(projectSkillFolder)) {
          mkdirSync(projectSkillFolder, { recursive: true })
        }

        // Copy files from central folder to project skill folder if it was a real directory
        if (existsSync(centralSkillFolder)) {
          try {
            const stat = lstatSync(centralSkillFolder)
            if (!stat.isSymbolicLink() && stat.isDirectory()) {
              cpSync(centralSkillFolder, projectSkillFolder, { recursive: true, force: true })
            }
          } catch {}
        }

        // Write SKILL.md in project skill folder
        const projectMdPath = path.join(projectSkillFolder, 'SKILL.md')
        if (!existsSync(projectMdPath) || skill.skillMarkdown) {
          const mdContent = skill.skillMarkdown || `---
name: ${skill.id}
description: ${skill.description || skill.name}
tools: [${skill.apps?.join(', ') || 'System'}]
version: ${skill.versions || 1}.0.0
---

# ${skill.name}

${skill.description || ''}
`
          writeFileSync(projectMdPath, mdContent, 'utf8')
        }

        // 2. Remove original central folder and create symlink to project skill folder
        safeRemoveLink(centralSkillFolder)
        const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
        symlinkSync(path.resolve(projectSkillFolder), path.resolve(centralSkillFolder), symlinkType)

        // 3. Update skill metadata in central repository
        skill.targetProjects = Array.from(new Set([...(skill.targetProjects || []), projectWorkspace]))
        skill.skillPath = projectSkillFolder
        writeFileSync(centralSkillJson, JSON.stringify(skill, null, 2), 'utf8')

        // 4. Also ensure global AI tool links point to project skill folder
        for (const toolId of skill.targetTools || []) {
          const tool = DEFAULT_AI_TOOLS.find((t) => t.id === toolId)
          if (tool) {
            const toolDir = getAIToolDirectory(tool)
            if (existsSync(toolDir)) {
              const linkPath = path.join(toolDir, skillId)
              safeRemoveLink(linkPath)
              symlinkSync(path.resolve(projectSkillFolder), path.resolve(linkPath), symlinkType)
            }
          }
        }

        migratedCount++
      } catch (err) {
        console.error(`Failed to migrate skill ${skill.id} to project:`, err)
      }
    }

    return {
      success: true,
      count: migratedCount,
      projectWorkspace,
      targetDir,
    }
  })

  function ensureSkillCentralDirectory(skill: Skill): string {
    const root = getStoredTraceHome()
    const skillFolder = path.join(root, 'skills', skill.id)
    if (!existsSync(skillFolder)) {
      mkdirSync(skillFolder, { recursive: true })
    }
    const mdPath = path.join(skillFolder, 'SKILL.md')
    if (!existsSync(mdPath)) {
      const mdContent = skill.skillMarkdown || `---
name: ${skill.id}
description: ${skill.description || skill.name}
tools: [${skill.apps?.join(', ') || 'System'}]
version: ${skill.versions || 1}.0.0
---

# ${skill.name}

${skill.description || ''}
`
      writeFileSync(mdPath, mdContent, 'utf8')
    }
    return skillFolder
  }

  function safeRemoveLink(targetLinkPath: string) {
    try {
      const lstat = lstatSync(targetLinkPath)
      if (lstat.isSymbolicLink()) {
        unlinkSync(targetLinkPath)
      }
    } catch {}
  }

  const safeSkillIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

  async function deleteSkillAsset(skillId: string, requestedMode: DeleteSkillMode) {
    if (!safeSkillIdPattern.test(skillId)) return false
    const mode: DeleteSkillMode = requestedMode === 'permanent' ? 'permanent' : 'trash'
    const root = getStoredTraceHome()
    const skillsDir = path.join(root, 'skills')

    try {
      const targetPaths = new Set<string>()
      for (const tool of detectInstalledAITools()) {
        const toolDir = getAIToolDirectory(tool)
        if (toolDir) targetPaths.add(path.join(toolDir, skillId))
      }
      for (const project of listProjects(root)) {
        for (const sp of SUPPORTED_PROJECT_SKILL_PATHS) {
          targetPaths.add(path.join(project.path, sp.relPath, skillId))
        }
      }
      targetPaths.add(path.join(skillsDir, skillId))
      targetPaths.add(path.join(skillsDir, `${skillId}.json`))

      await deleteSkillPaths(targetPaths, mode, (targetPath) => shell.trashItem(targetPath))
      return true
    } catch (error) {
      console.error(`[Trace] Failed to ${mode === 'trash' ? 'trash' : 'delete'} skill ${skillId}:`, error)
      return false
    }
  }

  ipcMain.handle('system:get-ai-tools', () => detectInstalledAITools())

  function parseSkillMetadata(content: string) {
    let name = ''
    let description = ''
    let tags: string[] = []
    let triggers: string[] = []

    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (fmMatch) {
      const lines = fmMatch[1].split('\n')
      for (const line of lines) {
        const nameMatch = line.match(/^name:\s*(.+)$/i)
        if (nameMatch) name = nameMatch[1].trim()
        const descMatch = line.match(/^description:\s*(.+)$/i)
        if (descMatch) description = descMatch[1].trim()
        const tagsMatch = line.match(/^tags:\s*\[(.*)\]/i)
        if (tagsMatch) {
          tags = tagsMatch[1]
            .split(',')
            .map((s) => s.trim().replace(/["']/g, ''))
            .filter(Boolean)
        }
        const triggersMatch = line.match(/^triggers:\s*\[(.*)\]/i)
        if (triggersMatch) {
          triggers = triggersMatch[1]
            .split(',')
            .map((s) => s.trim().replace(/["']/g, ''))
            .filter(Boolean)
        }
      }
    }

    if (!name) {
      const h1Match = content.match(/^#\s+(.+)$/m)
      if (h1Match) name = h1Match[1].trim()
    }

    if (!description) {
      const lines = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim().split('\n')
      const p = lines.find((l) => l.trim() && !l.startsWith('#'))
      if (p) description = p.trim().slice(0, 160)
    }

    return { name, description, tags, triggers }
  }

  function discoverAllGlobalSkills(): Skill[] {
    const root = getStoredTraceHome()
    const centralSkillsDir = path.join(root, 'skills')
    ensureTraceDirectories(root)

    const skillsMap = new Map<string, Skill>()

    // 1. Load existing central skills from ~/.trace/skills
    try {
      if (existsSync(centralSkillsDir)) {
        const files = readdirSync(centralSkillsDir)
        for (const file of files) {
          if (file.endsWith('.json')) {
            try {
              const content = readFileSync(path.join(centralSkillsDir, file), 'utf8')
              const parsed = JSON.parse(content)
              if (parsed && parsed.id) {
                const skillFolder = path.join(centralSkillsDir, parsed.id)
                const mdPath = path.join(skillFolder, 'SKILL.md')
                if (existsSync(mdPath)) {
                  parsed.skillMarkdown = readFileSync(mdPath, 'utf8')
                }
                parsed.skillPath = skillFolder
                skillsMap.set(parsed.id, parsed)
              }
            } catch {}
          }
        }
      }
    } catch {}

    // 2. Discover skills from all installed AI tool directories
    const installedTools = detectInstalledAITools().filter((t) => t.installed)
    for (const tool of installedTools) {
      const toolDir = getAIToolDirectory(tool)
      if (!existsSync(toolDir)) continue

      try {
        const items = readdirSync(toolDir)
        for (const item of items) {
          if (item.startsWith('.')) continue
          const itemPath = path.join(toolDir, item)
          let stat
          try {
            stat = lstatSync(itemPath)
          } catch {
            continue
          }

          let realPath = itemPath
          if (stat.isSymbolicLink()) {
            try {
              realPath = realpathSync(itemPath)
            } catch {
              continue
            }
          }

          let isDir = false
          try {
            isDir = statSync(realPath).isDirectory()
          } catch {
            continue
          }
          if (!isDir) continue

          const skillId = item
          const skillMdPath = path.join(realPath, 'SKILL.md')
          let skillMd = ''
          if (existsSync(skillMdPath)) {
            try {
              skillMd = readFileSync(skillMdPath, 'utf8')
            } catch {}
          }

          const parsed = parseSkillMetadata(skillMd)
          const name = parsed.name || skillId
          const description = parsed.description || `从 ${tool.name} 目录发现的全局技能`

          if (!skillsMap.has(skillId)) {
            const skillObj: Skill = {
              id: skillId,
              name,
              description,
              apps: ['AI Agent Runtime'],
              updatedLabel: '刚刚同步',
              pinned: false,
              sourceRuns: 1,
              versions: 1,
              workflow: {
                id: `wf-${skillId}`,
                name: name || skillId,
                summary: description || `Global skill workflow for ${skillId}`,
                repeatCount: 1,
                estimatedMinutes: 2,
                confidence: 98,
                nodes: [
                  {
                    id: 'step-1',
                    label: 'Load Skill Protocol',
                    kind: 'action',
                    app: 'AI Agent Runtime',
                    confidence: 100,
                  },
                  {
                    id: 'step-2',
                    label: 'Execute Instructions',
                    kind: 'action',
                    confidence: 96,
                  },
                ],
                edges: [{ from: 'step-1', to: 'step-2' }],
              },
              targetTools: [tool.id],
              tags: parsed.tags.length > 0 ? parsed.tags : [tool.id.replace('-code', '').replace('-std', '')],
              triggers: parsed.triggers,
              skillPath: realPath,
              skillMarkdown: skillMd,
            }

            // Also persist to central repository ~/.trace/skills/<id>.json & SKILL.md
            try {
              ensureSkillCentralDirectory(skillObj)
              const jsonPath = path.join(centralSkillsDir, `${skillId}.json`)
              writeFileSync(jsonPath, JSON.stringify(skillObj, null, 2), 'utf8')
            } catch {}

            skillsMap.set(skillId, skillObj)
          } else {
            const existing = skillsMap.get(skillId)!
            if (!existing.targetTools?.includes(tool.id)) {
              existing.targetTools = Array.from(new Set([...(existing.targetTools || []), tool.id]))
              try {
                const jsonPath = path.join(centralSkillsDir, `${skillId}.json`)
                writeFileSync(jsonPath, JSON.stringify(existing, null, 2), 'utf8')
              } catch {}
            }
          }
        }
      } catch (e: any) {
        console.warn(`[Trace] Error scanning ${toolDir}:`, e?.message)
      }
    }

    return Array.from(skillsMap.values())
  }

  ipcMain.handle('system:load-local-skills', () => discoverAllGlobalSkills())

  ipcMain.handle('system:save-local-skill', (_event, skill: Skill) => {
    if (!skill || !skill.id) return false
    const root = getStoredTraceHome()
    const skillsDir = path.join(root, 'skills')
    ensureTraceDirectories(root)
    try {
      ensureSkillCentralDirectory(skill)
      const filePath = path.join(skillsDir, `${skill.id}.json`)
      writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')
      if (skill.skillMarkdown) {
        const mdPath = path.join(skillsDir, skill.id, 'SKILL.md')
        writeFileSync(mdPath, skill.skillMarkdown, 'utf8')
      }
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('system:delete-local-skill', (_event, skillId: string, mode: DeleteSkillMode = 'trash') => (
    deleteSkillAsset(skillId, mode)
  ))

  ipcMain.handle('system:link-skill-target', (_event, skillId: string, targetId: string) => {
    if (!skillId || !targetId) return { success: false }
    const root = getStoredTraceHome()
    const skillsDir = path.join(root, 'skills')
    const filePath = path.join(skillsDir, `${skillId}.json`)
    if (!existsSync(filePath)) return { success: false }

    try {
      const skill: Skill = JSON.parse(readFileSync(filePath, 'utf8'))
      const centralFolder = ensureSkillCentralDirectory(skill)

      const tool = DEFAULT_AI_TOOLS.find((t) => t.id === targetId)
      if (!tool) return { success: false }

      const toolDir = getAIToolDirectory(tool)
      if (!existsSync(toolDir)) {
        mkdirSync(toolDir, { recursive: true })
      }

      const targetLink = path.join(toolDir, skillId)
      safeRemoveLink(targetLink)

      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(path.resolve(centralFolder), path.resolve(targetLink), symlinkType)

      const updatedTools = Array.from(new Set([...(skill.targetTools || []), targetId]))
      skill.targetTools = updatedTools
      writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')

      return { success: true, linkPath: targetLink }
    } catch (err: any) {
      console.error(`Failed to link skill ${skillId} to ${targetId}:`, err)
      return { success: false }
    }
  })

  ipcMain.handle('system:unlink-skill-target', (_event, skillId: string, targetId: string) => {
    if (!skillId || !targetId) return { success: false }
    const root = getStoredTraceHome()
    const skillsDir = path.join(root, 'skills')
    const filePath = path.join(skillsDir, `${skillId}.json`)

    try {
      const tool = DEFAULT_AI_TOOLS.find((t) => t.id === targetId)
      if (tool) {
        const toolDir = getAIToolDirectory(tool)
        const targetLink = path.join(toolDir, skillId)
        safeRemoveLink(targetLink)
      }

      if (existsSync(filePath)) {
        const skill: Skill = JSON.parse(readFileSync(filePath, 'utf8'))
        skill.targetTools = (skill.targetTools || []).filter((id) => id !== targetId)
        writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')
      }

      return { success: true }
    } catch {
      return { success: false }
    }
  })

  ipcMain.handle('system:get-skill-link-health', (_event, skillId: string) => {
    const healthMap: Record<string, 'healthy' | 'broken' | 'unlinked'> = {}
    const allTools = detectInstalledAITools()

    for (const tool of allTools) {
      const toolDir = getAIToolDirectory(tool)
      const linkPath = path.join(toolDir, skillId)
      try {
        if (existsSync(linkPath)) {
          const lstat = lstatSync(linkPath)
          if (lstat.isSymbolicLink() || (process.platform === 'win32' && lstat.isDirectory())) {
            healthMap[tool.id] = 'healthy'
          } else {
            healthMap[tool.id] = 'broken'
          }
        } else {
          healthMap[tool.id] = 'unlinked'
        }
      } catch {
        healthMap[tool.id] = 'broken'
      }
    }
    return healthMap
  })

  ipcMain.handle('system:delete-skill-completely', (_event, skillId: string, mode: DeleteSkillMode = 'permanent') => (
    deleteSkillAsset(skillId, mode)
  ))

  ipcMain.handle('system:link-all-skills-target', (_event, targetId: string) => {
    if (!targetId) return { success: false, count: 0 }
    const root = getStoredTraceHome()
    const skillsDir = path.join(root, 'skills')
    ensureTraceDirectories(root)

    const tool = DEFAULT_AI_TOOLS.find((t) => t.id === targetId)
    if (!tool) return { success: false, count: 0 }

    const toolDir = getAIToolDirectory(tool)
    if (!existsSync(toolDir)) {
      mkdirSync(toolDir, { recursive: true })
    }

    let count = 0
    try {
      if (existsSync(skillsDir)) {
        const files = readdirSync(skillsDir)
        for (const file of files) {
          if (file.endsWith('.json')) {
            try {
              const filePath = path.join(skillsDir, file)
              const skill: Skill = JSON.parse(readFileSync(filePath, 'utf8'))
              if (skill && skill.id) {
                const centralFolder = ensureSkillCentralDirectory(skill)
                const targetLink = path.join(toolDir, skill.id)
                safeRemoveLink(targetLink)
                const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
                symlinkSync(path.resolve(centralFolder), path.resolve(targetLink), symlinkType)

                const updatedTools = Array.from(new Set([...(skill.targetTools || []), targetId]))
                skill.targetTools = updatedTools
                writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')
                count++
              }
            } catch {}
          }
        }
      }
      return { success: true, count }
    } catch {
      return { success: false, count: 0 }
    }
  })

  ipcMain.handle('system:unlink-all-skills-target', (_event, targetId: string) => {
    if (!targetId) return { success: false, count: 0 }
    const root = getStoredTraceHome()
    const skillsDir = path.join(root, 'skills')

    const tool = DEFAULT_AI_TOOLS.find((t) => t.id === targetId)
    let count = 0

    try {
      if (tool) {
        const toolDir = getAIToolDirectory(tool)
        if (existsSync(toolDir)) {
          const files = readdirSync(skillsDir)
          for (const file of files) {
            if (file.endsWith('.json')) {
              try {
                const filePath = path.join(skillsDir, file)
                const skill: Skill = JSON.parse(readFileSync(filePath, 'utf8'))
                if (skill && skill.id) {
                  const targetLink = path.join(toolDir, skill.id)
                  safeRemoveLink(targetLink)
                  skill.targetTools = (skill.targetTools || []).filter((id) => id !== targetId)
                  writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')
                  count++
                }
              } catch {}
            }
          }
        }
      }
      return { success: true, count }
    } catch {
      return { success: false, count: 0 }
    }
  })

  ipcMain.handle('system:read-skill-markdown', (_event, skillId: string) => {
    const root = getStoredTraceHome()
    const mdPath = path.join(root, 'skills', skillId, 'SKILL.md')
    if (existsSync(mdPath)) {
      return readFileSync(mdPath, 'utf8')
    }
    return ''
  })

  ipcMain.handle('system:save-skill-markdown', (_event, skillId: string, markdown: string) => {
    const root = getStoredTraceHome()
    const skillFolder = path.join(root, 'skills', skillId)
    if (!existsSync(skillFolder)) {
      mkdirSync(skillFolder, { recursive: true })
    }
    const mdPath = path.join(skillFolder, 'SKILL.md')
    writeFileSync(mdPath, markdown, 'utf8')
    return true
  })

  function getMCPOptions() {
    return {
      getProjectWorkspace: getStoredProjectWorkspace,
      getTraceHome: getStoredTraceHome,
    }
  }

  function notifyMCPChanged() {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('mcp:changed')
      }
    }
  }

  function notifyProjectsChanged() {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('projects:changed')
      }
    }
  }

  function notifyRulesChanged() {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('rules:changed')
      }
    }
  }

  function notifySkillsChanged() {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('skills:changed')
      }
    }
  }

  // --- Projects IPC (OPC-56) ---
  ipcMain.handle('projects:list', () => listProjects(getStoredTraceHome()))
  ipcMain.handle('projects:get-active', () => getActiveProject(getStoredTraceHome()))
  ipcMain.handle('projects:set-active', (_event, idOrPath: string) => {
    const res = setActiveProject(idOrPath, getStoredTraceHome())
    if (res.success) notifyProjectsChanged()
    return res
  })
  ipcMain.handle('projects:add', async (_event, folderPath?: string) => {
    let chosen = folderPath
    if (!chosen) {
      const res = await dialog.showOpenDialog({
        title: '选择项目工作区根目录',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (res.canceled || res.filePaths.length === 0) {
        return { success: false, error: '用户取消了选择' }
      }
      chosen = res.filePaths[0]
    }
    const res = addProject(chosen, getStoredTraceHome())
    if (res.success) notifyProjectsChanged()
    return res
  })
  ipcMain.handle('projects:remove', (_event, idOrPath: string) => {
    const res = removeProject(idOrPath, getStoredTraceHome())
    if (res.success) notifyProjectsChanged()
    return res
  })
  ipcMain.handle('projects:scan-targets', (_event, projectPath?: string) => {
    const p = projectPath || getStoredProjectWorkspace()
    return scanProjectSkillPaths(p)
  })

  // --- Public Rule Libraries & CLAUDE.md IPC (OPC-56) ---
  ipcMain.handle('rules:list', () => listRules(getStoredTraceHome()))
  ipcMain.handle('rules:get', (_event, ruleId: string) => getRule(ruleId, getStoredTraceHome()))
  ipcMain.handle('rules:save', (_event, ruleInput) => {
    const res = saveRule(ruleInput, getStoredTraceHome())
    if (res.success) notifyRulesChanged()
    return res
  })
  ipcMain.handle('rules:delete', (_event, ruleId: string) => {
    const res = deleteRule(ruleId, getStoredTraceHome())
    if (res.success) notifyRulesChanged()
    return res
  })
  ipcMain.handle('rules:get-project-associations', (_event, projectPath?: string) => {
    const p = projectPath || getStoredProjectWorkspace()
    return getProjectRuleConfig(p, getStoredTraceHome())
  })
  ipcMain.handle('rules:set-project-rules', (_event, projectPath: string, ruleIds: string[]) => {
    const res = setProjectRules(projectPath, ruleIds, getStoredTraceHome())
    notifyRulesChanged()
    return res
  })
  ipcMain.handle('rules:uninject-project-rule', (_event, projectPath: string, ruleId: string) => {
    const res = uninjectRuleFromProject(projectPath, ruleId, getStoredTraceHome())
    notifyRulesChanged()
    return res
  })
  ipcMain.handle('rules:sync-project', (_event, projectPath: string) => {
    const res = syncProjectRules(projectPath, getStoredTraceHome())
    notifyRulesChanged()
    return res
  })
  ipcMain.handle('rules:create-claude-link', (_event, projectPath?: string) => {
    const p = projectPath || getStoredProjectWorkspace()
    return createClaudeMdLink(p)
  })
  ipcMain.handle('rules:check-claude-link', (_event, projectPath?: string) => {
    const p = projectPath || getStoredProjectWorkspace()
    return checkClaudeMdLink(p)
  })

  // --- Central MCP Assets IPC (OPC-56) ---
  ipcMain.handle('mcp:list', async () => {
    return readAllMCPServers(getMCPOptions())
  })

  ipcMain.handle('mcp:save', async (_event, target, input) => {
    const result = saveMCPServer(target, input, getMCPOptions())
    if (result.success) notifyMCPChanged()
    return result
  })

  ipcMain.handle('mcp:delete', async (_event, target) => {
    const result = deleteMCPServer(target, getMCPOptions())
    if (result.success) notifyMCPChanged()
    return result
  })

  ipcMain.handle('mcp:toggle', async (_event, target, enabled) => {
    const result = toggleMCPServer(target, enabled, getMCPOptions())
    if (result.success) notifyMCPChanged()
    return result
  })

  ipcMain.handle('mcp:preflight-distribution', async (_event, server, targets) => {
    return preflightMCPDistribution(server, targets, getMCPOptions())
  })

  ipcMain.handle('mcp:distribute', async (_event, server, targets) => {
    const result = distributeMCPServer(server, targets, getMCPOptions())
    notifyMCPChanged()
    return result
  })

  ipcMain.handle('mcp:list-central', async () => {
    return readCentralMCPServers(getMCPOptions())
  })

  ipcMain.handle('mcp:save-central', async (_event, input) => {
    const result = saveCentralMCPServer(input, getMCPOptions())
    if (result.success) notifyMCPChanged()
    return result
  })

  ipcMain.handle('mcp:delete-central', async (_event, idOrName: string) => {
    const result = deleteCentralMCPServer(idOrName, getMCPOptions())
    if (result.success) notifyMCPChanged()
    return result
  })

  ipcMain.handle('mcp:inject', async (_event, serverIdOrName: string, target: any) => {
    const result = injectMCPServerToTarget(serverIdOrName, target, getMCPOptions())
    if (result.success) notifyMCPChanged()
    return result
  })

  ipcMain.handle('mcp:uninject', async (_event, serverIdOrName: string, target: any) => {
    const result = uninjectMCPServerFromTarget(serverIdOrName, target, getMCPOptions())
    if (result.success) notifyMCPChanged()
    return result
  })

  ipcMain.handle('mcp:batch-inject', async (_event, serverIds: string[], target: any) => {
    const result = batchInjectMCPServers(serverIds, target, getMCPOptions())
    notifyMCPChanged()
    return result
  })

  ipcMain.handle('mcp:batch-uninject', async (_event, serverIds: string[], target: any) => {
    const result = batchUninjectMCPServers(serverIds, target, getMCPOptions())
    notifyMCPChanged()
    return result
  })

  // --- Unified Skill Injection IPC (OPC-56) ---
  ipcMain.handle(
    'skills:inject',
    async (_event, skillId: string, target: any) => {
      const res = injectSkillToTarget(skillId, target, {
        traceHome: getStoredTraceHome(),
        defaultProjectWorkspace: getStoredProjectWorkspace(),
      })
      if (res.success) notifySkillsChanged()
      return res
    }
  )

  ipcMain.handle(
    'skills:uninject',
    async (_event, skillId: string, target: any) => {
      const res = uninjectSkillFromTarget(skillId, target, {
        traceHome: getStoredTraceHome(),
        defaultProjectWorkspace: getStoredProjectWorkspace(),
      })
      if (res.success) notifySkillsChanged()
      return res
    }
  )

  ipcMain.handle(
    'skills:batch-inject',
    async (_event, skillIds: string[], target: any) => {
      const res = batchInjectSkills(skillIds, target, {
        traceHome: getStoredTraceHome(),
        defaultProjectWorkspace: getStoredProjectWorkspace(),
      })
      notifySkillsChanged()
      return res
    }
  )

  ipcMain.handle(
    'skills:batch-uninject',
    async (_event, skillIds: string[], target: any) => {
      const res = batchUninjectSkills(skillIds, target, {
        traceHome: getStoredTraceHome(),
        defaultProjectWorkspace: getStoredProjectWorkspace(),
      })
      notifySkillsChanged()
      return res
    }
  )

  let accountManager: AccountManager | undefined
  let accountStorageRoot = ''
  let accountMutationInProgress = false
  let accountOperations = 0
  let accountOAuth: AccountOAuthService | undefined
  let accountOAuthOwner: Electron.WebContents | undefined
  let detachOAuthOwner: (() => void) | undefined
  function disposeAccountManager() {
    disposeAccountOAuth()
    accountManager?.dispose()
    accountManager = undefined
    accountStorageRoot = ''
  }
  function disposeAccountOAuth() {
    accountOAuth?.dispose()
    accountOAuth = undefined
    detachOAuthOwner?.()
    detachOAuthOwner = undefined
    accountOAuthOwner = undefined
  }
  function getAccountManager() {
    const root = getStoredTraceHome()
    if (!accountManager || accountStorageRoot !== root) {
      if (accountMutationInProgress) throw new AccountError('账号操作进行中，请稍后重试。')
      disposeAccountManager()
      accountManager = new AccountManager({
        traceHome: root,
        onAccountsChanged: () => {
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.send('accounts:changed')
          }
        },
      })
      accountStorageRoot = root
    }
    return accountManager
  }
  function assertAccountSender(event: Electron.IpcMainInvokeEvent) {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new AccountError('账号请求来源无效。')
    }
  }
  function getAccountOAuth(event: Electron.IpcMainInvokeEvent) {
    assertAccountSender(event)
    if (updateInstaller?.preparing || updateInstaller?.approved) throw new AccountError('正在安装应用更新，请稍后重试。')
    const manager = getAccountManager()
    if (accountOAuth && accountOAuthOwner !== event.sender) disposeAccountOAuth()
    if (!accountOAuth) {
      const root = accountStorageRoot
      const owner = event.sender
      accountOAuthOwner = owner
      accountOAuth = new AccountOAuthService({
        providers: createAccountOAuthProviders(),
        openExternal: url => shell.openExternal(url),
        saveAccount: input => accountCall(current => {
          if (owner.isDestroyed() || current !== manager || getStoredTraceHome() !== root) {
            throw new AccountError('账号存储位置或窗口已变更，请重新登录。')
          }
          return current.saveAuthenticatedAccount(input)
        }, true),
      })
      const onNavigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !isInPlace) disposeAccountOAuth()
      }
      owner.once('destroyed', disposeAccountOAuth)
      owner.on('did-start-navigation', onNavigation)
      detachOAuthOwner = () => {
        owner.removeListener('destroyed', disposeAccountOAuth)
        owner.removeListener('did-start-navigation', onNavigation)
      }
    }
    return accountOAuth
  }
  let renewalRunning = false
  let renewalStopped = false
  async function checkAccountRenewals() {
    if (renewalRunning || renewalStopped || accountMutationInProgress || updateInstaller?.preparing || updateInstaller?.approved) return
    renewalRunning = true
    try {
      await getAccountManager().refreshDueAccounts()
    } catch {
      // Per-account failures are reported through the overview; never log credentials.
    } finally {
      renewalRunning = false
    }
  }
  const renewalTimer = setInterval(() => { void checkAccountRenewals() }, 60_000)
  renewalTimer.unref()
  const onRenewalWake = () => { void checkAccountRenewals() }
  powerMonitor.on('resume', onRenewalWake)
  app.on('browser-window-focus', onRenewalWake)
  app.on('before-quit', event => {
    if (event.defaultPrevented) return
    renewalStopped = true
    clearInterval(renewalTimer)
    powerMonitor.removeListener('resume', onRenewalWake)
    app.removeListener('browser-window-focus', onRenewalWake)
    disposeAccountManager()
  })
  async function accountCall<T>(operation: (manager: AccountManager) => Promise<T>, mutation = false): Promise<T> {
    if (updateInstaller?.preparing || updateInstaller?.approved) throw new Error('正在安装应用更新，请稍后重试。')
    accountOperations++
    try {
      if (mutation && accountMutationInProgress) throw new AccountError('账号操作进行中，请稍后重试。')
      const manager = getAccountManager()
      if (mutation) accountMutationInProgress = true
      try { return await operation(manager) }
      finally { if (mutation) accountMutationInProgress = false }
    } catch (error) {
      throw new Error(sanitizeErrorMessage(error))
    } finally { accountOperations-- }
  }
  // accountCall already sanitizes every error; action envelopes avoid Electron's
  // "Error invoking remote method" decoration in user-facing account feedback.
  async function accountActionCall(operation: (manager: AccountManager) => Promise<AccountActionResult>): Promise<AccountActionResult> {
    try { return await accountCall(operation, true) }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : sanitizeErrorMessage(error) } }
  }
  // The old profiles:* handlers are intentionally not registered: whole-environment
  // snapshots must never remain an alternate path to change model/MCP settings.
  ipcMain.handle('accounts:authorize-antigravity', event => {
    assertAccountSender(event)
    return accountCall(manager => manager.authorizeAntigravityKeychain(), true)
  })
  ipcMain.handle('accounts:overview', () => accountCall(manager => manager.getOverview()))
  ipcMain.handle('accounts:sync', event => {
    assertAccountSender(event)
    return accountCall(manager => manager.syncCurrentAccounts(), true)
  })
  ipcMain.handle('accounts:oauth-start', (event, tool: AccountTool) => getAccountOAuth(event).begin(tool))
  ipcMain.handle('accounts:oauth-status', (event, id: string) => getAccountOAuth(event).get(id))
  ipcMain.handle('accounts:oauth-cancel', (event, id: string) => getAccountOAuth(event).cancel(id))
  ipcMain.handle('accounts:oauth-reopen', (event, id: string) => getAccountOAuth(event).reopen(id))
  ipcMain.handle('accounts:refresh-quota', (event, id: string) => {
    assertAccountSender(event)
    return accountCall(manager => manager.refreshQuota(id))
  })
  ipcMain.handle('accounts:capture', (_event, input) => accountCall(manager => manager.captureAccount(input), true))
  ipcMain.handle('accounts:import', (_event, input) => accountCall(manager => manager.importAccount(input), true))
  ipcMain.handle('accounts:switch', (_event, id: string) => accountActionCall(manager => manager.switchAccount(id)))
  ipcMain.handle('accounts:rollback', (_event, tool: AccountTool) => accountActionCall(manager => manager.rollbackAccount(tool)))
  ipcMain.handle('accounts:recover', (_event, tool: AccountTool) => accountActionCall(manager => manager.recoverAccount(tool)))
  ipcMain.handle('accounts:rename', (_event, id: string, name: string) => accountCall(manager => manager.renameAccount(id, name), true))
  ipcMain.handle('accounts:delete', (_event, id: string) => accountCall(manager => manager.deleteAccount(id), true))

  const simulatedUpdates = !app.isPackaged && process.env.TRACE_SIMULATE_UPDATE === '1'
  let packagedUpdatesEnabled = false
  if (app.isPackaged) {
    try { packagedUpdatesEnabled = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).traceUpdatesEnabled === true } catch {}
  }
  const updatesEnabled = simulatedUpdates || (packagedUpdatesEnabled && ['darwin', 'win32'].includes(process.platform)
    && existsSync(path.join(process.resourcesPath, 'app-update.yml')))
  const updates = new AppUpdateService({
    currentVersion: app.getVersion(), enabled: updatesEnabled, simulated: simulatedUpdates,
    transport: updatesEnabled && !simulatedUpdates ? createElectronUpdateTransport()
      : createDevelopmentUpdateTransport({ currentVersion: app.getVersion(), progressIntervalMilliseconds: 500, progressSteps: 20 }),
    onStateChanged: state => {
      if (state.status === 'downloaded' && state.error && updateInstaller?.approved) {
        updateInstaller.approved = false
        mainWindow?.setEnabled(true)
        recorder.start()
      }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:changed', state)
    },
  })
  const updateBlockers = new Set<string>()
  const updateBlocker = (): string | undefined => {
    if (updateBlockers.size) return '请先保存或关闭正在编辑的内容，再安装更新。'
    const native = recorder.getStatus()
    const browser = browserCapture.getStatus()
    if (captureCommandPending || native.state === 'observing' || native.state === 'paused'
      || (native.state === 'interrupted' && native.sessionId) || browser.state === 'capturing') {
      return '请先结束录制，再安装更新。'
    }
    if (accountOperations || accountMutationInProgress || renewalRunning || accountManager?.hasActiveRefreshes()) {
      return '账号操作或凭据续期正在进行，请完成后再安装更新。'
    }
  }
  updateInstaller = new AppUpdateInstaller({
    ready: () => updates.state().status === 'downloaded',
    blocker: updateBlocker,
    prepare: async () => {
      mainWindow?.setEnabled(false)
      await browserCapture.shutdown()
      await recorder.shutdownAndWait()
    },
    install: () => { updates.installUpdate() },
  })
  blockWindowCloseForUpdate = () => !simulatedUpdates && updates.state().status === 'downloaded'
    && !updateInstaller?.approved ? (updateInstaller?.preparing ? '正在准备安装更新，请稍候。' : updateBlocker()) : undefined
  const installUpdate = async () => {
    if (simulatedUpdates) return updates.state() // Preview only: never shut down any resources.
    try { await updateInstaller!.install() }
    catch (error) { mainWindow?.setEnabled(true); recorder.start(); throw error }
    return updates.state()
  }
  for (const [channel, handler] of Object.entries({
    'updates:state': () => updates.state(),
    'updates:check': () => updates.checkForUpdates(),
    'updates:download': () => updates.downloadUpdate(),
    'updates:install': installUpdate,
  })) {
    ipcMain.handle(channel, event => { assertAccountSender(event); return handler() })
  }
  ipcMain.handle('updates:blocker', (event, key: unknown, blocked: unknown) => {
    assertAccountSender(event)
    if (typeof key !== 'string' || !/^[a-z-]{1,64}$/.test(key) || typeof blocked !== 'boolean') {
      throw new Error('更新保护状态无效。')
    }
    if (blocked) updateBlockers.add(key); else updateBlockers.delete(key)
  })
  // Run before existing before-quit cleanup, so a rejected quit leaves services running.
  app.prependListener('before-quit', event => {
    if (simulatedUpdates || updates.state().status !== 'downloaded' || updateInstaller?.approved) return
    event.preventDefault()
    void installUpdate().catch(() => {
      recorder.start()
      void dialog.showMessageBox({ type: 'info', message: updateBlocker() ?? '更新未能安装，请稍后重试。', buttons: ['好'] })
    })
  })
  app.on('will-quit', () => updates.dispose())
  updates.start({ automatic: updatesEnabled })

  createWindow()
  void checkAccountRenewals()

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
    } else {
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', event => {
  if (event.defaultPrevented) return
  if (trayAnimationTimer) clearInterval(trayAnimationTimer)
  trayAnimationTimer = undefined
  statusTray?.destroy()
  statusTray = null
  captureRepository.shutdown()
  void browserCapture.shutdown()
  recorder.closePermisoOverlay()
  recorder.shutdown()
})
