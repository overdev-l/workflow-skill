import { contextBridge, ipcRenderer } from 'electron'
import type { AccountManagementAPI } from '@workflow-skill/workflow-model/accounts'
import type {
  BrowserCaptureCommand,
  BrowserCaptureEnvelope,
  BrowserCaptureStatus,
  RecorderCommand,
  RecorderEnvelope,
  RecorderStatus,
} from '@workflow-skill/capture-protocol'
import type {
  AIProjectItem,
  AdoptMCPResult,
  AdoptSkillResult,
  BatchSkillAdoptionResult,
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
  OnboardingMcpCandidate,
  OnboardingMcpMigrationResult,
  OnboardingSkillCandidate,
  OnboardingSkillMigrationRequest,
  OnboardingSkillMigrationResult,
  OnboardingState,
  OnboardingStepCounts,
  OnboardingStepId,
  OnboardingStepOutcome,
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
  SkillAdoptionPlan,
  Workflow,
} from '@workflow-skill/workflow-model'

const accounts: AccountManagementAPI = {
  authorizeAntigravityKeychain: () => ipcRenderer.invoke('accounts:authorize-antigravity'),
  getOverview: () => ipcRenderer.invoke('accounts:overview'),
  syncCurrentAccounts: () => ipcRenderer.invoke('accounts:sync'),
  startOAuth: tool => ipcRenderer.invoke('accounts:oauth-start', tool),
  getOAuthSession: id => ipcRenderer.invoke('accounts:oauth-status', id),
  cancelOAuth: id => ipcRenderer.invoke('accounts:oauth-cancel', id),
  reopenOAuth: id => ipcRenderer.invoke('accounts:oauth-reopen', id),
  refreshQuota: id => ipcRenderer.invoke('accounts:refresh-quota', id),
  captureAccount: input => ipcRenderer.invoke('accounts:capture', input),
  importAccount: input => ipcRenderer.invoke('accounts:import', input),
  switchAccount: id => ipcRenderer.invoke('accounts:switch', id),
  rollbackAccount: tool => ipcRenderer.invoke('accounts:rollback', tool),
  recoverAccount: tool => ipcRenderer.invoke('accounts:recover', tool),
  renameAccount: (id, name) => ipcRenderer.invoke('accounts:rename', id, name),
  deleteAccount: id => ipcRenderer.invoke('accounts:delete', id),
  setAutoSwitch: (tool, enabled) => ipcRenderer.invoke('accounts:set-auto-switch', tool, enabled),
  getAutoSwitch: tool => ipcRenderer.invoke('accounts:get-auto-switch', tool),
  onAccountsChanged: listener => {
    const handler = () => listener()
    ipcRenderer.on('accounts:changed', handler)
    return () => ipcRenderer.removeListener('accounts:changed', handler)
  },
}

contextBridge.exposeInMainWorld('workflowSkill', {
  accounts,
  updates: {
    getState: () => ipcRenderer.invoke('updates:state'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onChanged: (listener: (state: import('@workflow-skill/workflow-model/updates').AppUpdateState) => void) => {
      const handler = (_event: unknown, state: import('@workflow-skill/workflow-model/updates').AppUpdateState) => listener(state)
      ipcRenderer.on('updates:changed', handler)
      return () => ipcRenderer.removeListener('updates:changed', handler)
    },
  } satisfies import('@workflow-skill/workflow-model/updates').AppUpdateAPI,
  setUpdateBlocker: (key: string, blocked: boolean) => ipcRenderer.invoke('updates:blocker', key, blocked),
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
    ipcRenderer.invoke('system:link-skill-target', skillId, targetId) as Promise<{ success: boolean; error?: string; linkPath?: string; targetDir?: string }>,
  unlinkSkillTarget: (skillId: string, targetId: string) =>
    ipcRenderer.invoke('system:unlink-skill-target', skillId, targetId) as Promise<{ success: boolean; error?: string; linkPath?: string; targetDir?: string }>,
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
  listMCPServers: () =>
    ipcRenderer.invoke('mcp:list') as Promise<{ global: MCPServerDefinition[]; project: MCPServerDefinition[] }>,
  saveMCPServer: (
    target: { tool: MCPSourceTool; scope: MCPScope; expectedRevision?: string },
    input: MCPServerInput & { isNew?: boolean }
  ) =>
    ipcRenderer.invoke('mcp:save', target, input) as Promise<{ success: boolean; server?: MCPServerDefinition; error?: string }>,
  deleteMCPServer: (target: { tool: MCPSourceTool; scope: MCPScope; name: string; expectedRevision?: string }) =>
    ipcRenderer.invoke('mcp:delete', target) as Promise<{ success: boolean; error?: string }>,
  toggleMCPServer: (
    target: { tool: MCPSourceTool; scope: MCPScope; name: string; expectedRevision?: string },
    enabled: boolean
  ) =>
    ipcRenderer.invoke('mcp:toggle', target, enabled) as Promise<{ success: boolean; server?: MCPServerDefinition; error?: string }>,
  preflightMCPDistribution: (server: MCPServerDefinition | MCPServerInput, targets: MCPDistributionTarget[]) =>
    ipcRenderer.invoke('mcp:preflight-distribution', server, targets) as Promise<MCPDistributionPreflightResult>,
  distributeMCPServer: (server: MCPServerDefinition | MCPServerInput, targets: MCPDistributionTarget[]) =>
    ipcRenderer.invoke('mcp:distribute', server, targets) as Promise<MCPDistributionReport>,
  onMCPChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('mcp:changed', handler)
    return () => ipcRenderer.removeListener('mcp:changed', handler)
  },

  // --- Projects (OPC-56, OPC-64) ---
  discoverProjectSkills: (projectPath: string) => ipcRenderer.invoke('projects:discover-skills', projectPath) as Promise<ProjectSkillDiscoveryResult>,
  listProjects: () => ipcRenderer.invoke('projects:list') as Promise<ProjectRecord[]>,
  listManagedProjects: () => ipcRenderer.invoke('projects:list-managed') as Promise<ManagedProjectRecord[]>,
  getActiveProject: () => ipcRenderer.invoke('projects:get-active') as Promise<ProjectRecord | null>,
  setActiveProject: (idOrPath: string) =>
    ipcRenderer.invoke('projects:set-active', idOrPath) as Promise<{ success: boolean; project?: ProjectRecord; error?: string }>,
  addProject: (folderPath?: string) =>
    ipcRenderer.invoke('projects:add', folderPath) as Promise<{ success: boolean; project?: ProjectRecord; error?: string }>,
  removeProject: (idOrPath: string) =>
    ipcRenderer.invoke('projects:remove', idOrPath) as Promise<{ success: boolean; error?: string }>,
  scanProjectSkillPaths: (projectPath?: string) =>
    ipcRenderer.invoke('projects:scan-targets', projectPath) as Promise<ProjectSkillPathStatus[]>,
  onProjectsChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('projects:changed', handler)
    return () => ipcRenderer.removeListener('projects:changed', handler)
  },

  // --- Public Rule Libraries (OPC-56) ---
  listRules: () => ipcRenderer.invoke('rules:list') as Promise<PublicRule[]>,
  getRule: (ruleId: string) => ipcRenderer.invoke('rules:get', ruleId) as Promise<PublicRule | null>,
  saveRule: (rule: Partial<PublicRule> & { name: string; content: string }) =>
    ipcRenderer.invoke('rules:save', rule) as Promise<{
      success: boolean
      rule: PublicRule
      syncResults: Array<{ projectPath: string; success: boolean; error?: string }>
    }>,
  deleteRule: (ruleId: string) =>
    ipcRenderer.invoke('rules:delete', ruleId) as Promise<{
      success: boolean
      syncResults: Array<{ projectPath: string; success: boolean; error?: string }>
    }>,
  getProjectRuleConfig: (projectPath?: string) =>
    ipcRenderer.invoke('rules:get-project-associations', projectPath) as Promise<ProjectRuleAssociation>,
  setProjectRules: (projectPath: string, ruleIds: string[]) =>
    ipcRenderer.invoke('rules:set-project-rules', projectPath, ruleIds) as Promise<{
      success: boolean
      status: 'synced' | 'failed'
      error?: string
    }>,
  uninjectProjectRule: (projectPath: string, ruleId: string) =>
    ipcRenderer.invoke('rules:uninject-project-rule', projectPath, ruleId) as Promise<{
      success: boolean
      status: 'synced' | 'failed'
      error?: string
    }>,
  syncProjectRules: (projectPath: string) =>
    ipcRenderer.invoke('rules:sync-project', projectPath) as Promise<{
      success: boolean
      status: 'synced' | 'failed'
      error?: string
    }>,
  createClaudeLink: (projectPath?: string) =>
    ipcRenderer.invoke('rules:create-claude-link', projectPath) as Promise<ClaudeLinkResult>,
  checkClaudeLink: (projectPath?: string) =>
    ipcRenderer.invoke('rules:check-claude-link', projectPath) as Promise<ClaudeLinkStatus>,
  onRulesChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('rules:changed', handler)
    return () => ipcRenderer.removeListener('rules:changed', handler)
  },

  // --- Central MCP Assets & Target Injection (OPC-56) ---
  listCentralMCPServers: () =>
    ipcRenderer.invoke('mcp:list-central') as Promise<CentralMCPServer[]>,
  saveCentralMCPServer: (input: Partial<CentralMCPServer> & { name: string; transport: any }) =>
    ipcRenderer.invoke('mcp:save-central', input) as Promise<{
      success: boolean
      server?: CentralMCPServer
      syncResults?: Array<{ tool: MCPSourceTool; scope: MCPScope; projectPath?: string; success: boolean; error?: string }>
      error?: string
    }>,
  deleteCentralMCPServer: (idOrName: string) =>
    ipcRenderer.invoke('mcp:delete-central', idOrName) as Promise<{ success: boolean; error?: string }>,
  injectMCPServer: (serverIdOrName: string, target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }) =>
    ipcRenderer.invoke('mcp:inject', serverIdOrName, target) as Promise<{ success: boolean; error?: string }>,
  uninjectMCPServer: (serverIdOrName: string, target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }) =>
    ipcRenderer.invoke('mcp:uninject', serverIdOrName, target) as Promise<{ success: boolean; error?: string }>,
  batchInjectMCPServers: (serverIds: string[], target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }) =>
    ipcRenderer.invoke('mcp:batch-inject', serverIds, target) as Promise<{ results: BatchItemResult[] }>,
  batchUninjectMCPServers: (serverIds: string[], target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }) =>
    ipcRenderer.invoke('mcp:batch-uninject', serverIds, target) as Promise<{ results: BatchItemResult[] }>,

  adoptMCPServer: (target: { tool: MCPSourceTool; scope: MCPScope; name: string; projectPath?: string }) =>
    ipcRenderer.invoke('mcp:adopt', target) as Promise<AdoptMCPResult>,
  disconnectMCPServer: (serverIdOrName: string, target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }) =>
    ipcRenderer.invoke('mcp:disconnect', serverIdOrName, target) as Promise<DisconnectMCPResult>,
  resolveMCPConflict: (input: ResolveMCPConflictInput) =>
    ipcRenderer.invoke('mcp:resolve-conflict', input) as Promise<ResolveMCPConflictResult>,

  // --- Unified Skill Injection & Batching (OPC-56) ---
  injectSkill: (
    skillId: string,
    target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string }
  ) =>
    ipcRenderer.invoke('skills:inject', skillId, target) as Promise<{ success: boolean; linkPath?: string; error?: string }>,
  uninjectSkill: (
    skillId: string,
    target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string }
  ) =>
    ipcRenderer.invoke('skills:uninject', skillId, target) as Promise<{ success: boolean; error?: string }>,
  disconnectSkill: (
    skillId: string,
    target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string }
  ) =>
    ipcRenderer.invoke('skills:disconnect', skillId, target) as Promise<DisconnectSkillResult>,
  adoptSkill: (
    target: { type?: 'global' | 'project'; toolId?: string; projectPath?: string; relPath?: string; skillId?: string; targetPath?: string }
  ) =>
    ipcRenderer.invoke('skills:adopt', target) as Promise<AdoptSkillResult>,
  getSkillAdoptionPlan: () =>
    ipcRenderer.invoke('skills:adoption-plan') as Promise<SkillAdoptionPlan>,
  adoptAllSkills: () =>
    ipcRenderer.invoke('skills:adopt-all') as Promise<BatchSkillAdoptionResult>,
  resolveSkillConflict: (input: ResolveSkillConflictInput) =>
    ipcRenderer.invoke('skills:resolve-conflict', input) as Promise<ResolveSkillConflictResult>,
  batchInjectSkills: (
    skillIds: string[],
    target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string }
  ) =>
    ipcRenderer.invoke('skills:batch-inject', skillIds, target) as Promise<{ results: BatchItemResult[] }>,
  batchUninjectSkills: (
    skillIds: string[],
    target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string }
  ) =>
    ipcRenderer.invoke('skills:batch-uninject', skillIds, target) as Promise<{ results: BatchItemResult[] }>,
  onSkillsChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('skills:changed', handler)
    return () => ipcRenderer.removeListener('skills:changed', handler)
  },

  // --- Onboarding (OPC-214) ---
  getOnboardingState: () =>
    ipcRenderer.invoke('onboarding:get-state') as Promise<OnboardingState>,
  scanGlobalSkillCandidates: () =>
    ipcRenderer.invoke('onboarding:scan-global-skills') as Promise<OnboardingSkillCandidate[]>,
  scanGlobalMcpCandidates: () =>
    ipcRenderer.invoke('onboarding:scan-global-mcp') as Promise<OnboardingMcpCandidate[]>,
  scanProjectSkillCandidates: (projectPath: string) =>
    ipcRenderer.invoke('onboarding:scan-project-skills', projectPath) as Promise<OnboardingSkillCandidate[]>,
  scanProjectMcpCandidates: (projectPath: string) =>
    ipcRenderer.invoke('onboarding:scan-project-mcp', projectPath) as Promise<OnboardingMcpCandidate[]>,
  migrateOnboardingSkills: (requests: OnboardingSkillMigrationRequest[]) =>
    ipcRenderer.invoke('onboarding:migrate-skills', requests) as Promise<OnboardingSkillMigrationResult[]>,
  migrateOnboardingMcp: (serverIds: string[]) =>
    ipcRenderer.invoke('onboarding:migrate-mcp', serverIds) as Promise<OnboardingMcpMigrationResult[]>,
  selectOnboardingProject: (folderPath?: string) =>
    ipcRenderer.invoke('onboarding:select-project', folderPath) as Promise<ProjectRecord | null>,
  setOnboardingStep: (
    stepId: OnboardingStepId,
    outcome: OnboardingStepOutcome,
    counts?: OnboardingStepCounts
  ) =>
    ipcRenderer.invoke('onboarding:set-step', stepId, outcome, counts) as Promise<OnboardingState>,
  completeOnboarding: () =>
    ipcRenderer.invoke('onboarding:complete') as Promise<OnboardingState>,
  resetOnboarding: () =>
    ipcRenderer.invoke('onboarding:reset') as Promise<OnboardingState>,
})
