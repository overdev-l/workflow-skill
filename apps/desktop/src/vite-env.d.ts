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
import type {
  AIProjectItem,
  AdoptMCPResult,
  AdoptSkillResult,
  BatchItemResult,
  CentralMCPServer,
  ClaudeLinkResult,
  ClaudeLinkStatus,
  DeleteSkillMode,
  DisconnectMCPResult,
  DisconnectSkillResult,
  MCPDistributionPreflightResult,
  MCPDistributionReport,
  MCPDistributionTarget,
  MCPScope,
  MCPServerDefinition,
  MCPServerInput,
  MCPSourceTool,
  ManagedProjectRecord,
  ProjectRecord,
  ProjectRuleAssociation,
  ProjectSkillPathStatus,
  ProjectSkillDiscoveryResult,
  PublicRule,
  RepositorySkillSearchResult,
  ResolveMCPConflictInput,
  ResolveMCPConflictResult,
  ResolveSkillConflictInput,
  ResolveSkillConflictResult,
  Workflow,
} from '@workflow-skill/workflow-model'

declare global {
  interface Window {
    workflowSkill?: {
      updates?: import('@workflow-skill/workflow-model/updates').AppUpdateAPI
      setUpdateBlocker?: (key: string, blocked: boolean) => Promise<void>
      accounts?: import('@workflow-skill/workflow-model/accounts').AccountManagementAPI
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
      listMCPServers?: () => Promise<{ global: MCPServerDefinition[]; project: MCPServerDefinition[] }>
      saveMCPServer?: (
        target: { tool: MCPSourceTool; scope: MCPScope; expectedRevision?: string },
        input: MCPServerInput & { isNew?: boolean }
      ) => Promise<{ success: boolean; server?: MCPServerDefinition; error?: string }>
      deleteMCPServer?: (target: { tool: MCPSourceTool; scope: MCPScope; name: string; expectedRevision?: string }) => Promise<{ success: boolean; error?: string }>
      toggleMCPServer?: (
        target: { tool: MCPSourceTool; scope: MCPScope; name: string; expectedRevision?: string },
        enabled: boolean
      ) => Promise<{ success: boolean; server?: MCPServerDefinition; error?: string }>
      preflightMCPDistribution?: (server: MCPServerDefinition | MCPServerInput, targets: MCPDistributionTarget[]) => Promise<MCPDistributionPreflightResult>
      distributeMCPServer?: (server: MCPServerDefinition | MCPServerInput, targets: MCPDistributionTarget[]) => Promise<MCPDistributionReport>
      onMCPChanged?: (listener: () => void) => () => void

      // --- Projects (OPC-56, OPC-64) ---
      discoverProjectSkills?: (projectPath: string) => Promise<ProjectSkillDiscoveryResult>
      listProjects?: () => Promise<ProjectRecord[]>
      listManagedProjects?: () => Promise<ManagedProjectRecord[]>
      getActiveProject?: () => Promise<ProjectRecord | null>
      setActiveProject?: (idOrPath: string) => Promise<{ success: boolean; project?: ProjectRecord; error?: string }>
      addProject?: (folderPath?: string) => Promise<{ success: boolean; project?: ProjectRecord; error?: string }>
      removeProject?: (idOrPath: string) => Promise<{ success: boolean; error?: string }>
      scanProjectSkillPaths?: (projectPath?: string) => Promise<ProjectSkillPathStatus[]>
      onProjectsChanged?: (listener: () => void) => () => void

      // --- Public Rule Libraries (OPC-56) ---
      listRules?: () => Promise<PublicRule[]>
      getRule?: (ruleId: string) => Promise<PublicRule | null>
      saveRule?: (rule: Partial<PublicRule> & { name: string; content: string }) => Promise<{
        success: boolean
        rule: PublicRule
        syncResults: Array<{ projectPath: string; success: boolean; error?: string }>
      }>
      deleteRule?: (ruleId: string) => Promise<{
        success: boolean
        syncResults: Array<{ projectPath: string; success: boolean; error?: string }>
      }>
      getProjectRuleConfig?: (projectPath?: string) => Promise<ProjectRuleAssociation>
      setProjectRules?: (projectPath: string, ruleIds: string[]) => Promise<{
        success: boolean
        status: 'synced' | 'failed'
        error?: string
      }>
      uninjectProjectRule?: (projectPath: string, ruleId: string) => Promise<{
        success: boolean
        status: 'synced' | 'failed'
        error?: string
      }>
      syncProjectRules?: (projectPath: string) => Promise<{
        success: boolean
        status: 'synced' | 'failed'
        error?: string
      }>
      createClaudeLink?: (projectPath?: string) => Promise<ClaudeLinkResult>
      checkClaudeLink?: (projectPath?: string) => Promise<ClaudeLinkStatus>
      onRulesChanged?: (listener: () => void) => () => void

      // --- Central MCP Assets & Target Injection (OPC-56) ---
      listCentralMCPServers?: () => Promise<CentralMCPServer[]>
      saveCentralMCPServer?: (input: Partial<CentralMCPServer> & { name: string; transport: any }) => Promise<{
        success: boolean
        server?: CentralMCPServer
        syncResults?: Array<{ tool: MCPSourceTool; scope: MCPScope; projectPath?: string; success: boolean; error?: string }>
        error?: string
      }>
      deleteCentralMCPServer?: (idOrName: string) => Promise<{ success: boolean; error?: string; targetErrors?: Array<{ target: any; error: string }> }>
      injectMCPServer?: (serverIdOrName: string, target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }) => Promise<{ success: boolean; error?: string }>
      uninjectMCPServer?: (serverIdOrName: string, target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }) => Promise<{ success: boolean; error?: string }>
      batchInjectMCPServers?: (serverIds: string[], target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }) => Promise<{ results: BatchItemResult[] }>
      batchUninjectMCPServers?: (serverIds: string[], target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }) => Promise<{ results: BatchItemResult[] }>
      adoptMCPServer?: (target: { tool: MCPSourceTool; scope: MCPScope; name: string; projectPath?: string }) => Promise<AdoptMCPResult>
      disconnectMCPServer?: (serverIdOrName: string, target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }) => Promise<DisconnectMCPResult>
      resolveMCPConflict?: (input: ResolveMCPConflictInput) => Promise<ResolveMCPConflictResult>

      // --- Unified Skill Injection & Batching (OPC-56) ---
      injectSkill?: (
        skillId: string,
        target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string }
      ) => Promise<{ success: boolean; linkPath?: string; error?: string }>
      uninjectSkill?: (
        skillId: string,
        target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string }
      ) => Promise<{ success: boolean; error?: string }>
      batchInjectSkills?: (
        skillIds: string[],
        target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string }
      ) => Promise<{ results: BatchItemResult[] }>
      batchUninjectSkills?: (
        skillIds: string[],
        target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string }
      ) => Promise<{ results: BatchItemResult[] }>
      disconnectSkill?: (
        skillId: string,
        target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string }
      ) => Promise<DisconnectSkillResult>
      adoptSkill?: (
        target: { type?: 'global' | 'project'; toolId?: string; projectPath?: string; relPath?: string; skillId?: string; targetPath?: string }
      ) => Promise<AdoptSkillResult>
      resolveSkillConflict?: (input: ResolveSkillConflictInput) => Promise<ResolveSkillConflictResult>
      onSkillsChanged?: (listener: () => void) => () => void
    }
  }
}

export {}
