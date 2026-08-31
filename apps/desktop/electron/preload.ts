import { contextBridge, ipcRenderer } from 'electron'
import type {
  BrowserCaptureCommand,
  BrowserCaptureEnvelope,
  BrowserCaptureStatus,
  RecorderCommand,
  RecorderEnvelope,
  RecorderStatus,
} from '@workflow-skill/capture-protocol'
import type { AIProjectItem, DeleteSkillMode, RepositorySkillSearchResult, Workflow } from '@workflow-skill/workflow-model'

contextBridge.exposeInMainWorld('workflowSkill', {
  getSystemTheme: () => ipcRenderer.invoke('system:theme') as Promise<'light' | 'dark'>,
  setTheme: (theme: 'dark' | 'light' | 'system') => ipcRenderer.invoke('system:set-theme', theme) as Promise<'light' | 'dark'>,
  getRecorderStatus: () => ipcRenderer.invoke('recorder:status') as Promise<RecorderStatus>,
  sendRecorderCommand: (command: RecorderCommand) => ipcRenderer.invoke('recorder:command', command) as Promise<RecorderStatus>,
  getBrowserCaptureStatus: () => ipcRenderer.invoke('browser-capture:status') as Promise<BrowserCaptureStatus>,
  sendBrowserCaptureCommand: (command: BrowserCaptureCommand) =>
    ipcRenderer.invoke('browser-capture:command', command) as Promise<BrowserCaptureStatus>,
  loadCapturedWorkflows: () => ipcRenderer.invoke('capture:list-workflows') as Promise<Workflow[]>,
  loadCapturedEvents: (limit?: number) => ipcRenderer.invoke('capture:list-events', limit) as Promise<import('@workflow-skill/capture-protocol').CaptureEvent[]>,
  dismissCapturedWorkflow: (workflowId: string) =>
    ipcRenderer.invoke('capture:dismiss-workflow', workflowId) as Promise<boolean>,
  updateCapturedWorkflow: (workflow: Workflow) =>
    ipcRenderer.invoke('capture:update-workflow', workflow) as Promise<boolean>,
  searchRepositorySkills: (repository: string) =>
    ipcRenderer.invoke('skills:search-repository', repository) as Promise<RepositorySkillSearchResult>,
  openPrivacySettings: (type: 'accessibility' | 'screenRecording', sourceFrame?: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('system:open-privacy-settings', type, sourceFrame) as Promise<void>,
  locateAppInFinder: () => ipcRenderer.invoke('system:locate-app-in-finder') as Promise<void>,
  centerWindow: () => ipcRenderer.invoke('system:center-window') as Promise<void>,
  closePermisoOverlay: () => ipcRenderer.invoke('system:close-permiso-overlay') as Promise<void>,
  startDragApp: () => ipcRenderer.send('system:start-drag-app'),
  getStoragePath: () => ipcRenderer.invoke('system:get-storage-path') as Promise<string>,
  selectStoragePath: () => ipcRenderer.invoke('system:select-storage-path') as Promise<string | null>,
  resetStoragePath: () => ipcRenderer.invoke('system:reset-storage-path') as Promise<string>,
  getProjectWorkspace: () => ipcRenderer.invoke('system:get-project-workspace') as Promise<string>,
  selectProjectWorkspace: () => ipcRenderer.invoke('system:select-project-workspace') as Promise<string>,
  migrateAllSkillsToProject: (customProjectPath?: string) =>
    ipcRenderer.invoke('system:migrate-all-skills-to-project', customProjectPath) as Promise<{
      success: boolean
      count: number
      projectWorkspace: string
      targetDir: string
      error?: string
    }>,
  openPathInFinder: (targetPath: string) => ipcRenderer.invoke('system:open-path', targetPath) as Promise<void>,
  loadLocalSkills: () => ipcRenderer.invoke('system:load-local-skills') as Promise<any[]>,
  saveLocalSkill: (skill: any) => ipcRenderer.invoke('system:save-local-skill', skill) as Promise<boolean>,
  deleteLocalSkill: (skillId: string, mode: DeleteSkillMode = 'trash') =>
    ipcRenderer.invoke('system:delete-local-skill', skillId, mode) as Promise<boolean>,
  deleteSkillCompletely: (skillId: string, mode: DeleteSkillMode = 'permanent') =>
    ipcRenderer.invoke('system:delete-skill-completely', skillId, mode) as Promise<boolean>,
  getAITools: () => ipcRenderer.invoke('system:get-ai-tools') as Promise<any[]>,
  getAIProjects: () => ipcRenderer.invoke('system:get-ai-projects') as Promise<AIProjectItem[]>,
  selectCustomProject: () => ipcRenderer.invoke('system:select-custom-project') as Promise<AIProjectItem | null>,
  linkSkillProject: (skillId: string, projectPath: string) =>
    ipcRenderer.invoke('system:link-skill-project', skillId, projectPath) as Promise<{ success: boolean; linkPath?: string }>,
  unlinkSkillProject: (skillId: string, projectPath: string) =>
    ipcRenderer.invoke('system:unlink-skill-project', skillId, projectPath) as Promise<{ success: boolean }>,
  linkAllSkillsToProject: (projectPath: string) =>
    ipcRenderer.invoke('system:link-all-skills-project', projectPath) as Promise<{ success: boolean; count: number }>,
  unlinkAllSkillsFromProject: (projectPath: string) =>
    ipcRenderer.invoke('system:unlink-all-skills-project', projectPath) as Promise<{ success: boolean; count: number }>,
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
  openSkillLinkWindow: (skillId: string) =>
    ipcRenderer.invoke('system:open-skill-link-window', skillId) as Promise<void>,
  closeSkillLinkWindow: () =>
    ipcRenderer.invoke('system:close-skill-link-window') as Promise<void>,
  onLinkWindowSkillChange: (listener: (skillId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, skillId: string) => listener(skillId)
    ipcRenderer.on('link-window:set-skill-id', handler)
    return () => ipcRenderer.removeListener('link-window:set-skill-id', handler)
  },
  onRecorderMessage: (listener: (message: RecorderEnvelope) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: RecorderEnvelope) => listener(message)
    ipcRenderer.on('recorder:message', handler)
    return () => ipcRenderer.removeListener('recorder:message', handler)
  },
  onBrowserCaptureMessage: (listener: (message: BrowserCaptureEnvelope) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: BrowserCaptureEnvelope) => listener(message)
    ipcRenderer.on('browser-capture:message', handler)
    return () => ipcRenderer.removeListener('browser-capture:message', handler)
  },
  onCapturedWorkflowsChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('capture:workflows-changed', handler)
    return () => ipcRenderer.removeListener('capture:workflows-changed', handler)
  },
})
