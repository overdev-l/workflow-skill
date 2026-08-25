import { contextBridge, ipcRenderer } from 'electron'
import type { RecorderCommand, RecorderEnvelope, RecorderStatus } from '@workflow-skill/capture-protocol'

contextBridge.exposeInMainWorld('workflowSkill', {
  getSystemTheme: () => ipcRenderer.invoke('system:theme') as Promise<'light' | 'dark'>,
  setTheme: (theme: 'dark' | 'light' | 'system') => ipcRenderer.invoke('system:set-theme', theme) as Promise<'light' | 'dark'>,
  getRecorderStatus: () => ipcRenderer.invoke('recorder:status') as Promise<RecorderStatus>,
  sendRecorderCommand: (command: RecorderCommand) => ipcRenderer.invoke('recorder:command', command) as Promise<RecorderStatus>,
  openPrivacySettings: (type: 'accessibility' | 'screenRecording', sourceFrame?: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('system:open-privacy-settings', type, sourceFrame) as Promise<void>,
  locateAppInFinder: () => ipcRenderer.invoke('system:locate-app-in-finder') as Promise<void>,
  centerWindow: () => ipcRenderer.invoke('system:center-window') as Promise<void>,
  closePermisoOverlay: () => ipcRenderer.invoke('system:close-permiso-overlay') as Promise<void>,
  startDragApp: () => ipcRenderer.send('system:start-drag-app'),
  getSkillStoragePath: () => ipcRenderer.invoke('system:get-skill-storage-path') as Promise<string>,
  selectSkillStoragePath: () => ipcRenderer.invoke('system:select-skill-storage-path') as Promise<string | null>,
  resetSkillStoragePath: () => ipcRenderer.invoke('system:reset-skill-storage-path') as Promise<string>,
  openPathInFinder: (targetPath: string) => ipcRenderer.invoke('system:open-path', targetPath) as Promise<void>,
  onRecorderMessage: (listener: (message: RecorderEnvelope) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: RecorderEnvelope) => listener(message)
    ipcRenderer.on('recorder:message', handler)
    return () => ipcRenderer.removeListener('recorder:message', handler)
  },
})
