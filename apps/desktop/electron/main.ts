import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RecorderCommand, RecorderEnvelope } from '@workflow-skill/capture-protocol'
import { NativeRecorderManager } from './recorder-manager'

const defaultTraceHome = path.join(os.homedir(), '.trace')
const defaultSkillStoragePath = path.join(defaultTraceHome, 'skills')
const defaultWorkflowStoragePath = path.join(defaultTraceHome, 'workflows')
const defaultCapturesStoragePath = path.join(defaultTraceHome, 'captures')

function ensureTraceDirectories() {
  for (const dir of [defaultTraceHome, defaultSkillStoragePath, defaultWorkflowStoragePath, defaultCapturesStoragePath]) {
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {}
    }
  }
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const recorder = new NativeRecorderManager()
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'trace-spirit-icon.png')
  : path.resolve(currentDirectory, '../resources/trace-spirit-icon.png')
const trayIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'trace-tray-spirit.png')
  : path.resolve(currentDirectory, '../resources/trace-tray-spirit.png')
const trayIconDataUrl = existsSync(trayIconPath)
  ? `data:image/png;base64,${readFileSync(trayIconPath).toString('base64')}`
  : undefined

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

function createTrayFrame(frameIndex = 0, moving = false) {
  const motion = moving
    ? movingTrayFrames[frameIndex % movingTrayFrames.length]
    : movingTrayFrames[0]
  const leftTailY = 17.2 + motion.wave
  const centerTailY = 18 - motion.wave * 0.45
  const rightTailY = 17.3 + motion.wave * 0.7
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 20 20">
      <defs>
        <mask id="eyes">
          <rect width="20" height="20" fill="white"/>
          <ellipse cx="8" cy="8.3" rx="0.65" ry="1.1" fill="black"/>
          <ellipse cx="12" cy="8.3" rx="0.65" ry="1.1" fill="black"/>
        </mask>
      </defs>
      <g transform="translate(10 10) rotate(${motion.rotation}) translate(-10 -10) translate(0 ${motion.y})">
        ${trayIconDataUrl
          ? `<image href="${trayIconDataUrl}" x="1" y="1" width="18" height="18" preserveAspectRatio="xMidYMid meet"/>`
          : `<path mask="url(#eyes)" fill="black" d="
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
          `}
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
  cachedStoppedTrayFrame ??= createTrayFrame()
  if (cachedMovingTrayFrames.length === 0) {
    cachedMovingTrayFrames = movingTrayFrames.map((_, index) => createTrayFrame(index, true))
  }
  statusTray.setImage(moving ? cachedMovingTrayFrames[0] : cachedStoppedTrayFrame)
  updateTrayMenu()
  if (!moving) return
  trayAnimationTimer = setInterval(() => {
    trayFrame = (trayFrame + 1) % movingTrayFrames.length
    statusTray?.setImage(cachedMovingTrayFrames[trayFrame])
  }, 120)
}

function createStatusTray() {
  if (process.platform !== 'darwin' || statusTray) return
  statusTray = new Tray(createTrayFrame())
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
    backgroundColor: '#00000000',
    vibrancy: isDarwin ? 'sidebar' : undefined,
    visualEffectState: isDarwin ? 'active' : undefined,
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.once('ready-to-show', () => window.show())

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void window.loadFile(path.join(currentDirectory, '../dist/index.html'))
  }
}

function getAppBundlePath() {
  if (process.platform === 'darwin') {
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

  ipcMain.handle('system:get-skill-storage-path', () => {
    ensureTraceDirectories()
    const configPath = path.join(defaultTraceHome, 'config.json')
    let skillPath = defaultSkillStoragePath
    try {
      if (existsSync(configPath)) {
        const data = JSON.parse(readFileSync(configPath, 'utf8'))
        if (data.skillStoragePath) skillPath = data.skillStoragePath
      }
    } catch {}
    if (!existsSync(skillPath)) {
      try {
        mkdirSync(skillPath, { recursive: true })
      } catch {}
    }
    return skillPath
  })

  ipcMain.handle('system:select-skill-storage-path', async (event) => {
    ensureTraceDirectories()
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const configPath = path.join(defaultTraceHome, 'config.json')
    let currentPath = defaultSkillStoragePath
    try {
      if (existsSync(configPath)) {
        const data = JSON.parse(readFileSync(configPath, 'utf8'))
        if (data.skillStoragePath) currentPath = data.skillStoragePath
      }
    } catch {}

    const result = await dialog.showOpenDialog(win!, {
      title: 'Select Skill Storage Folder',
      defaultPath: existsSync(currentPath) ? currentPath : defaultTraceHome,
      properties: ['openDirectory', 'createDirectory'],
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const selectedPath = result.filePaths[0]
      try {
        let data: Record<string, any> = {}
        if (existsSync(configPath)) {
          data = JSON.parse(readFileSync(configPath, 'utf8'))
        }
        data.skillStoragePath = selectedPath
        writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8')
      } catch {}
      return selectedPath
    }
    return null
  })

  ipcMain.handle('system:reset-skill-storage-path', () => {
    ensureTraceDirectories()
    const configPath = path.join(defaultTraceHome, 'config.json')
    try {
      let data: Record<string, any> = {}
      if (existsSync(configPath)) {
        data = JSON.parse(readFileSync(configPath, 'utf8'))
      }
      data.skillStoragePath = defaultSkillStoragePath
      writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8')
    } catch {}
    return defaultSkillStoragePath
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
