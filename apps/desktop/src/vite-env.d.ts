/// <reference types="vite/client" />

import type {
  BrowserCaptureCommand,
  BrowserCaptureEnvelope,
  BrowserCaptureStatus,
  CaptureEvent,
  RecorderCommand,
  RecorderEnvelope,
  RecorderStatus,
} from '@workflow-skill/capture-protocol'
import type { AIProjectItem, DeleteSkillMode, RepositorySkillSearchResult, Workflow } from '@workflow-skill/workflow-model'

declare global {
  interface Window {
    workflowSkill?: {
      getSystemTheme: () => Promise<'light' | 'dark'>
      setTheme?: (theme: 'dark' | 'light' | 'system') => Promise<'light' | 'dark'>
      getRecorderStatus: () => Promise<RecorderStatus>
      sendRecorderCommand: (command: RecorderCommand) => Promise<RecorderStatus>
      getBrowserCaptureStatus?: () => Promise<BrowserCaptureStatus>
      sendBrowserCaptureCommand?: (command: BrowserCaptureCommand) => Promise<BrowserCaptureStatus>
      loadCapturedWorkflows?: () => Promise<Workflow[]>
      loadCapturedEvents?: (limit?: number) => Promise<CaptureEvent[]>
      dismissCapturedWorkflow?: (workflowId: string) => Promise<boolean>
      updateCapturedWorkflow?: (workflow: Workflow) => Promise<boolean>
      searchRepositorySkills?: (repository: string) => Promise<RepositorySkillSearchResult>
      openPrivacySettings?: (type: 'accessibility' | 'screenRecording', sourceFrame?: { x: number; y: number; width: number; height: number }) => Promise<void>
      locateAppInFinder?: () => Promise<void>
      centerWindow?: () => Promise<void>
      closePermisoOverlay?: () => Promise<void>
      startDragApp?: () => void
      getStoragePath?: () => Promise<string>
      selectStoragePath?: () => Promise<string | null>
      resetStoragePath?: () => Promise<string>
      getProjectWorkspace?: () => Promise<string>
      selectProjectWorkspace?: () => Promise<string>
      migrateAllSkillsToProject?: (customProjectPath?: string) => Promise<{
        success: boolean
        count: number
        projectWorkspace: string
        targetDir: string
        error?: string
      }>
      openPathInFinder?: (targetPath: string) => Promise<void>
      loadLocalSkills?: () => Promise<any[]>
      saveLocalSkill?: (skill: any) => Promise<boolean>
      deleteLocalSkill?: (skillId: string, mode?: DeleteSkillMode) => Promise<boolean>
      deleteSkillCompletely?: (skillId: string, mode?: DeleteSkillMode) => Promise<boolean>
      readSkillMarkdown?: (skillId: string) => Promise<string>
      saveSkillMarkdown?: (skillId: string, markdown: string) => Promise<boolean>
      getAITools?: () => Promise<any[]>
      getAIProjects?: () => Promise<AIProjectItem[]>
      selectCustomProject?: () => Promise<AIProjectItem | null>
      linkSkillProject?: (skillId: string, projectPath: string) => Promise<{ success: boolean; linkPath?: string }>
      unlinkSkillProject?: (skillId: string, projectPath: string) => Promise<{ success: boolean }>
      linkAllSkillsToProject?: (projectPath: string) => Promise<{ success: boolean; count: number }>
      unlinkAllSkillsFromProject?: (projectPath: string) => Promise<{ success: boolean; count: number }>
      linkSkillTarget?: (skillId: string, targetId: string) => Promise<{ success: boolean; targetDir?: string }>
      unlinkSkillTarget?: (skillId: string, targetId: string) => Promise<{ success: boolean; targetDir?: string }>
      linkAllSkillsToTarget?: (targetId: string) => Promise<{ success: boolean; count: number }>
      unlinkAllSkillsFromTarget?: (targetId: string) => Promise<{ success: boolean; count: number }>
      openSkillLinkWindow?: (skillId: string) => Promise<void>
      closeSkillLinkWindow?: () => Promise<void>
      onLinkWindowSkillChange?: (listener: (skillId: string) => void) => () => void
      onRecorderMessage: (listener: (message: RecorderEnvelope) => void) => () => void
      onBrowserCaptureMessage?: (listener: (message: BrowserCaptureEnvelope) => void) => () => void
      onCapturedWorkflowsChanged?: (listener: () => void) => () => void
    }
  }
}

export {}
