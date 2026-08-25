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
  getStoragePath: () => ipcRenderer.invoke('system:get-storage-path') as Promise<string>,
  selectStoragePath: () => ipcRenderer.invoke('system:select-storage-path') as Promise<string | null>,
  resetStoragePath: () => ipcRenderer.invoke('system:reset-storage-path') as Promise<string>,
  openPathInFinder: (targetPath: string) => ipcRenderer.invoke('system:open-path', targetPath) as Promise<void>,
  loadLocalSkills: () => ipcRenderer.invoke('system:load-local-skills') as Promise<any[]>,
  saveLocalSkill: (skill: any) => ipcRenderer.invoke('system:save-local-skill', skill) as Promise<boolean>,
  deleteLocalSkill: (skillId: string) => ipcRenderer.invoke('system:delete-local-skill', skillId) as Promise<boolean>,
  getAITools: () => ipcRenderer.invoke('system:get-ai-tools') as Promise<any[]>,
  linkSkillTarget: (skillId: string, targetId: string) =>
    ipcRenderer.invoke('system:link-skill-target', skillId, targetId) as Promise<{ success: boolean; linkPath?: string }>,
  unlinkSkillTarget: (skillId: string, targetId: string) =>
    ipcRenderer.invoke('system:unlink-skill-target', skillId, targetId) as Promise<{ success: boolean }>,
  getSkillLinkHealth: (skillId: string) =>
    ipcRenderer.invoke('system:get-skill-link-health', skillId) as Promise<Record<string, 'healthy' | 'broken' | 'unlinked'>>,
  linkAllSkillsToTarget: (targetId: string) =>
    ipcRenderer.invoke('system:link-all-skills-target', targetId) as Promise<{ success: boolean; count: number }>,
  unlinkAllSkillsFromTarget: (targetId: string) =>
    ipcRenderer.invoke('system:unlink-all-skills-target', targetId) as Promise<{ success: boolean; count: number }>,
  readSkillMarkdown: (skillId: string) =>
    ipcRenderer.invoke('system:read-skill-markdown', skillId) as Promise<string>,
  saveSkillMarkdown: (skillId: string, markdown: string) =>
    ipcRenderer.invoke('system:save-skill-markdown', skillId, markdown) as Promise<boolean>,
  onRecorderMessage: (listener: (message: RecorderEnvelope) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: RecorderEnvelope) => listener(message)
    ipcRenderer.on('recorder:message', handler)
    return () => ipcRenderer.removeListener('recorder:message', handler)
  },
})
