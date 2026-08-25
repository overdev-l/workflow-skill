import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RecorderCommand, RecorderEnvelope } from '@workflow-skill/capture-protocol'
import { DEFAULT_AI_TOOLS, type AIToolTarget, type Skill } from '@workflow-skill/workflow-model'
import { NativeRecorderManager } from './recorder-manager'

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

const movingTrayFrames = [
  { y: 0, rotation: 0, wave: 0 },
  { y: -0.35, rotation: -1.3, wave: 0.18 },
  { y: -0.7, rotation: -2.1, wave: 0.32 },
  { y: -0.95, rotation: -1.1, wave: 0.18 },
  { y: -0.7, rotation: 0.9, wave: -0.14 },
  { y: -0.35, rotation: 2, wave: -0.3 },
  { y: 0, rotation: 1.1, wave: -0.16 },
  { y: 0.2, rotation: 0, wave: 0 },
]

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
  const motion = moving
    ? movingTrayFrames[frameIndex % movingTrayFrames.length]
    : movingTrayFrames[0]
  const leftTailY = 17.2 + motion.wave
  const centerTailY = 18 - motion.wave * 0.45
  const rightTailY = 17.3 + motion.wave * 0.7
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 20 20">
    <defs>
      <mask id="eyes-${frameIndex}">
        <rect width="20" height="20" fill="white"/>
        <ellipse cx="8" cy="8.3" rx="0.65" ry="1.1" fill="black"/>
        <ellipse cx="12" cy="8.3" rx="0.65" ry="1.1" fill="black"/>
      </mask>
    </defs>
    <g transform="translate(10 10) rotate(${motion.rotation}) translate(-10 -10) translate(0 ${motion.y})">
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
  setTrayMoving(true)
}

function windowsOwnerHandle() {
  if (process.platform !== 'win32') return undefined
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return undefined
  const handle = window.getNativeWindowHandle()
  return handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE())
}

function createWindow() {
  const isDarwin = process.platform === 'darwin'
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 920,
    minHeight: 680,
    titleBarStyle: isDarwin ? 'hiddenInset' : 'default',
    trafficLightPosition: isDarwin ? { x: 16, y: 16 } : undefined,
    transparent: isDarwin,
    vibrancy: isDarwin ? 'under-window' : undefined,
    backgroundColor: '#00000000',
    hasShadow: true,
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.mjs'),
      sandbox: false,
    },
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
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('recorder:message', envelope)
    }
    if (envelope.type === 'status') {
      setTrayMoving(envelope.payload.state === 'observing')
    }
  })

  ipcMain.handle('system:theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))
  ipcMain.handle('system:set-theme', (_event, theme: 'dark' | 'light' | 'system') => {
    nativeTheme.themeSource = theme
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  })
  ipcMain.handle('recorder:status', () => recorder.getStatus())
  ipcMain.handle('recorder:command', (_event, command: RecorderCommand) => {
    const allowed = new Set(['start', 'pause', 'resume', 'stop', 'status', 'permissions', 'policy'])
    if (!allowed.has(command.type)) throw new Error('Unsupported recorder command')
    if (command.type === 'pause' || command.type === 'stop') {
      setTrayMoving(false)
    } else if (command.type === 'resume' || command.type === 'start') {
      setTrayMoving(true)
    }
    return recorder.command({ ...command, ownerWindowHandle: windowsOwnerHandle() })
  })

  ipcMain.handle('system:open-privacy-settings', async (_event, type: 'accessibility' | 'screenRecording', sourceFrame?: WindowBounds) => {
    if (process.platform === 'darwin') {
      const appPath = getAppBundlePath()
      recorder.showPermisoOverlay(type, appPath, sourceFrame)
    }
  })

  ipcMain.handle('system:close-permiso-overlay', () => {
    recorder.closePermisoOverlay()
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
      } catch {}
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
    } catch {}
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

  function getAIToolDirectory(tool: AIToolTarget): string {
    const rel = tool.customDir || tool.defaultDir
    if (path.isAbsolute(rel)) return rel
    return path.join(os.homedir(), rel)
  }

  function detectInstalledAITools(): AIToolTarget[] {
    return DEFAULT_AI_TOOLS.map((tool) => {
      const dir = getAIToolDirectory(tool)
      const baseDir = path.dirname(dir)
      const installed = existsSync(dir) || existsSync(baseDir)
      return {
        ...tool,
        installed,
        detectedPath: dir,
      }
    })
  }

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
      } else if (process.platform === 'win32' && lstat.isDirectory()) {
        rmdirSync(targetLinkPath)
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        try {
          unlinkSync(targetLinkPath)
        } catch {}
      }
    }
  }

  ipcMain.handle('system:get-ai-tools', () => detectInstalledAITools())

  ipcMain.handle('system:load-local-skills', () => {
    const root = getStoredTraceHome()
    const skillsDir = path.join(root, 'skills')
    ensureTraceDirectories(root)
    const skills: Skill[] = []
    try {
      if (existsSync(skillsDir)) {
        const files = readdirSync(skillsDir)
        for (const file of files) {
          if (file.endsWith('.json')) {
            try {
              const content = readFileSync(path.join(skillsDir, file), 'utf8')
              const parsed = JSON.parse(content)
              if (parsed && parsed.id) {
                const skillFolder = path.join(skillsDir, parsed.id)
                const mdPath = path.join(skillFolder, 'SKILL.md')
                if (existsSync(mdPath)) {
                  parsed.skillMarkdown = readFileSync(mdPath, 'utf8')
                }
                parsed.skillPath = skillFolder
                skills.push(parsed)
              }
            } catch {}
          }
        }
      }
    } catch {}
    return skills
  })

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

  ipcMain.handle('system:delete-local-skill', (_event, skillId: string) => {
    if (!skillId) return false
    const root = getStoredTraceHome()
    const skillsDir = path.join(root, 'skills')
    try {
      // Safely unlink from all AI tools
      const allTools = detectInstalledAITools()
      for (const tool of allTools) {
        const toolDir = getAIToolDirectory(tool)
        const linkPath = path.join(toolDir, skillId)
        safeRemoveLink(linkPath)
      }

      // Remove central folder
      const skillFolder = path.join(skillsDir, skillId)
      if (existsSync(skillFolder)) {
        rmSync(skillFolder, { recursive: true, force: true })
      }
      const filePath = path.join(skillsDir, `${skillId}.json`)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
      return true
    } catch {
      return false
    }
  })

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

  ipcMain.handle('system:delete-skill-completely', async (_event, skillId: string) => {
    if (!skillId) return false
    const root = getStoredTraceHome()
    const skillsDir = path.join(root, 'skills')
    try {
      const allTools = detectInstalledAITools()
      for (const tool of allTools) {
        const toolDir = getAIToolDirectory(tool)
        const linkPath = path.join(toolDir, skillId)
        safeRemoveLink(linkPath)
      }

      const skillFolder = path.join(skillsDir, skillId)
      if (existsSync(skillFolder)) {
        rmSync(skillFolder, { recursive: true, force: true })
      }
      const filePath = path.join(skillsDir, `${skillId}.json`)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
      return true
    } catch {
      return false
    }
  })

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

  createWindow()

  app.on('activate', () => {
    const mainWindows = BrowserWindow.getAllWindows()
    if (mainWindows.length === 0) {
      createWindow()
    } else {
      const win = mainWindows[0]
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (trayAnimationTimer) clearInterval(trayAnimationTimer)
  trayAnimationTimer = undefined
  statusTray?.destroy()
  statusTray = null
  recorder.closePermisoOverlay()
  recorder.shutdown()
})
