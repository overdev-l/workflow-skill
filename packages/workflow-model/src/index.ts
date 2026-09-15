export type WorkflowNodeKind =
  | 'action'
  | 'http'
  | 'wait'
  | 'parallel-split'
  | 'parallel-join'
  | 'branch'
  | 'loop'

export interface HttpRequestTemplate {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  resourceType?: string
  expectedStatus?: number
}

export interface WorkflowNode {
  id: string
  label: string
  detail?: string
  kind: WorkflowNodeKind
  app?: string
  confidence: number
  http?: HttpRequestTemplate
}

export interface WorkflowEdge {
  from: string
  to: string
}

export type CaptureWorkflowState = 'recording' | 'paused' | 'completed' | 'interrupted'

export interface CaptureWorkflowMetadata {
  sessionIds: string[]
  startedAt: string
  updatedAt: string
  eventCount: number
  state: CaptureWorkflowState
  scenario?: 'desktop' | 'browser'
}

export interface RepositorySkillSummary {
  name: string
  description: string
}

export interface RepositorySkillSearchResult {
  repository: string
  sourceUrl: string
  skills: RepositorySkillSummary[]
}

export interface Workflow {
  id: string
  name: string
  summary: string
  repeatCount: number
  estimatedMinutes: number
  confidence: number
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  capture?: CaptureWorkflowMetadata
}

export type AIToolCategory = 'all' | 'ide' | 'cli' | 'extension' | 'standard'

export interface AssociatedAITool {
  id: string
  name: string
  logoId: string
}

export interface AIToolTarget {
  id: string
  name: string
  category: 'ide' | 'cli' | 'extension' | 'standard'
  scope?: 'global' | 'project'
  defaultDir: string
  customDir?: string
  installed?: boolean
  detectedPath?: string
  iconName: string
  description?: string
  compatibleTools?: AssociatedAITool[]
  itemCount?: number
}

export interface AIProjectItem {
  id: string
  name: string
  path: string
  sources: string[]
  skillDir: string
  lastOpenedAt: number
}

export const DEFAULT_AI_TOOLS: AIToolTarget[] = [
  // --- Global Environments ---
  {
    id: 'agents-global',
    name: '.agents 全局通用环境',
    category: 'standard',
    scope: 'global',
    defaultDir: '.agents/skills',
    iconName: 'FolderTree',
    description: 'skills.sh 全局开放标准目录，Antigravity、Gemini CLI、OpenCode、LobeHub 原生共用',
    compatibleTools: [
      { id: 'antigravity', name: 'Google Antigravity', logoId: 'antigravity' },
      { id: 'gemini', name: 'Gemini CLI', logoId: 'gemini' },
      { id: 'opencode', name: 'OpenCode', logoId: 'opencode' },
      { id: 'lobehub', name: 'LobeHub', logoId: 'lobehub' },
    ],
  },
  {
    id: 'claude-global',
    name: '.claude 全局技能环境',
    category: 'cli',
    scope: 'global',
    defaultDir: '.claude/skills',
    iconName: 'Zap',
    description: 'Anthropic Claude Code 全局终端编程 Agent 技能目录 (~/.claude/skills)',
    compatibleTools: [
      { id: 'claude-code', name: 'Claude Code', logoId: 'claude' },
      { id: 'claude-cli', name: 'Claude CLI', logoId: 'claude' },
    ],
  },
  {
    id: 'cursor-global',
    name: '.cursor 全局技能环境',
    category: 'ide',
    scope: 'global',
    defaultDir: '.cursor/skills',
    iconName: 'Terminal',
    description: 'Cursor IDE 全局智能编程编辑器技能与规则目录 (~/.cursor/skills)',
    compatibleTools: [
      { id: 'cursor', name: 'Cursor IDE', logoId: 'cursor' },
    ],
  },
  {
    id: 'github-global',
    name: '.github 全局技能环境',
    category: 'extension',
    scope: 'global',
    defaultDir: '.github/skills',
    iconName: 'FolderTree',
    description: 'GitHub Copilot 全局 Agent 技能扩展目录 (~/.github/skills)',
    compatibleTools: [
      { id: 'github-copilot', name: 'GitHub Copilot', logoId: 'copilot' },
    ],
  },
  {
    id: 'gemini-global',
    name: '.gemini 全局技能环境',
    category: 'standard',
    scope: 'global',
    defaultDir: '.gemini/antigravity/skills',
    iconName: 'FolderTree',
    description: 'Google Antigravity & Gemini 全局 Agent 技能目录 (~/.gemini/antigravity/skills)',
    compatibleTools: [
      { id: 'antigravity', name: 'Google Antigravity', logoId: 'antigravity' },
      { id: 'gemini', name: 'Gemini Agent', logoId: 'gemini' },
    ],
  },
  {
    id: 'trae-global',
    name: '.trae 全局技能环境',
    category: 'ide',
    scope: 'global',
    defaultDir: '.trae/skills',
    iconName: 'Monitor',
    description: 'ByteDance Trae AI 自适应集成开发环境全局技能目录 (~/.trae/skills)',
    compatibleTools: [
      { id: 'trae', name: 'Trae IDE', logoId: 'trae' },
    ],
  },
  {
    id: 'roo-global',
    name: '.roo 全局技能环境',
    category: 'extension',
    scope: 'global',
    defaultDir: '.roo/skills',
    iconName: 'Boxes',
    description: 'Roo Code 多模式 AI 架构与任务插件全局技能目录 (~/.roo/skills)',
    compatibleTools: [
      { id: 'roo', name: 'Roo Code', logoId: 'roo' },
    ],
  },
  {
    id: 'cline-global',
    name: '.cline 全局技能环境',
    category: 'extension',
    scope: 'global',
    defaultDir: '.cline/skills',
    iconName: 'Boxes',
    description: 'Cline VS Code 自主编码 Agent 插件全局技能目录 (~/.cline/skills)',
    compatibleTools: [
      { id: 'cline', name: 'Cline Extension', logoId: 'cline' },
    ],
  },
  {
    id: 'codex-global',
    name: '.codex 全局技能环境',
    category: 'cli',
    scope: 'global',
    defaultDir: '.codex/skills',
    iconName: 'Zap',
    description: 'OpenAI Codex 命令行代码生成工具全局技能目录 (~/.codex/skills)',
    compatibleTools: [
      { id: 'codex', name: 'Codex CLI', logoId: 'codex' },
      { id: 'openai', name: 'OpenAI Agent', logoId: 'openai' },
    ],
  },
  {
    id: 'opencode-global',
    name: '.config/opencode 全局环境',
    category: 'cli',
    scope: 'global',
    defaultDir: '.config/opencode/skills',
    iconName: 'FolderTree',
    description: 'OpenCode Agent CLI 全局配置技能目录 (~/.config/opencode/skills)',
    compatibleTools: [
      { id: 'opencode', name: 'OpenCode CLI', logoId: 'opencode' },
    ],
  },
  {
    id: 'windsurf-global',
    name: '.windsurf 全局技能环境',
    category: 'ide',
    scope: 'global',
    defaultDir: '.windsurf/skills',
    iconName: 'Monitor',
    description: 'Codeium Windsurf AI 原生 IDE 全局技能配置目录 (~/.windsurf/skills)',
    compatibleTools: [
      { id: 'windsurf', name: 'Windsurf IDE', logoId: 'windsurf' },
    ],
  },

  // --- Project Workspace Environments ---
  {
    id: 'agents-project',
    name: '.agents 项目工作区环境',
    category: 'standard',
    scope: 'project',
    defaultDir: '.agents/skills',
    iconName: 'FolderTree',
    description: '当前项目仓库内 .agents/skills 通用工作区技能目录',
    compatibleTools: [
      { id: 'antigravity', name: 'Google Antigravity', logoId: 'antigravity' },
      { id: 'opencode', name: 'OpenCode', logoId: 'opencode' },
      { id: 'lobehub', name: 'LobeHub', logoId: 'lobehub' },
    ],
  },
  {
    id: 'claude-project',
    name: '.claude 项目工作区环境',
    category: 'cli',
    scope: 'project',
    defaultDir: '.claude/skills',
    iconName: 'Zap',
    description: '当前项目仓库内 .claude/skills 专用项目级技能目录',
    compatibleTools: [
      { id: 'claude-code', name: 'Claude Code', logoId: 'claude' },
    ],
  },
  {
    id: 'cursor-project',
    name: '.cursor 项目工作区环境',
    category: 'ide',
    scope: 'project',
    defaultDir: '.cursor/skills',
    iconName: 'Terminal',
    description: '当前项目仓库内 .cursor/skills 专用项目级技能目录',
    compatibleTools: [
      { id: 'cursor', name: 'Cursor IDE', logoId: 'cursor' },
    ],
  },
  {
    id: 'github-project',
    name: '.github 项目技能环境',
    category: 'extension',
    scope: 'project',
    defaultDir: '.github/skills',
    iconName: 'FolderTree',
    description: '当前项目仓库内 .github/skills 扩展技能配置目录',
    compatibleTools: [
      { id: 'github-copilot', name: 'GitHub Copilot', logoId: 'copilot' },
    ],
  },
  {
    id: 'trae-project',
    name: '.trae 项目工作区环境',
    category: 'ide',
    scope: 'project',
    defaultDir: '.trae/skills',
    iconName: 'Monitor',
    description: '当前项目仓库内 .trae/skills 专用项目级技能目录',
    compatibleTools: [
      { id: 'trae', name: 'Trae IDE', logoId: 'trae' },
    ],
  },
  {
    id: 'gemini-project',
    name: '.gemini 项目工作区环境',
    category: 'standard',
    scope: 'project',
    defaultDir: '.gemini/skills',
    iconName: 'FolderTree',
    description: '当前项目仓库内 .gemini/skills 技能目录',
    compatibleTools: [
      { id: 'gemini', name: 'Gemini CLI', logoId: 'gemini' },
      { id: 'antigravity', name: 'Google Antigravity', logoId: 'antigravity' },
    ],
  },
  {
    id: 'windsurf-project',
    name: '.windsurf 项目工作区环境',
    category: 'ide',
    scope: 'project',
    defaultDir: '.windsurf/skills',
    iconName: 'Monitor',
    description: '当前项目仓库内 .windsurf/skills 专用项目级技能目录',
    compatibleTools: [
      { id: 'windsurf', name: 'Windsurf IDE', logoId: 'windsurf' },
    ],
  },
  {
    id: 'codex-project',
    name: '.codex 项目工作区环境',
    category: 'cli',
    scope: 'project',
    defaultDir: '.codex/skills',
    iconName: 'Zap',
    description: '当前项目仓库内 .codex/skills 专用项目级技能目录',
    compatibleTools: [
      { id: 'codex', name: 'Codex CLI', logoId: 'codex' },
      { id: 'openai', name: 'OpenAI Agent', logoId: 'openai' },
    ],
  },
  {
    id: 'opencode-project',
    name: '.opencode 项目工作区环境',
    category: 'cli',
    scope: 'project',
    defaultDir: '.opencode/skills',
    iconName: 'FolderTree',
    description: '当前项目仓库内 .opencode/skills 专用项目级技能目录',
    compatibleTools: [
      { id: 'opencode', name: 'OpenCode CLI', logoId: 'opencode' },
    ],
  },
  {
    id: 'roo-project',
    name: '.roo 项目工作区环境',
    category: 'extension',
    scope: 'project',
    defaultDir: '.roo/skills',
    iconName: 'Boxes',
    description: '当前项目仓库内 .roo/skills 专用项目级技能目录',
    compatibleTools: [
      { id: 'roo', name: 'Roo Code', logoId: 'roo' },
    ],
  },
  {
    id: 'cline-project',
    name: '.cline 项目工作区环境',
    category: 'extension',
    scope: 'project',
    defaultDir: '.cline/skills',
    iconName: 'Boxes',
    description: '当前项目仓库内 .cline/skills 专用项目级技能目录',
    compatibleTools: [
      { id: 'cline', name: 'Cline Extension', logoId: 'cline' },
    ],
  },
]

export interface Skill {
  id: string
  name: string
  description: string
  apps: string[]
  updatedLabel: string
  pinned: boolean
  sourceRuns: number
  versions: number
  workflow: Workflow
  targetTools?: string[]
  targetProjects?: string[]
  targetProjectPaths?: Array<{ projectPath: string; relPath: string }>
  tags?: string[]
  triggers?: string[]
  skillMarkdown?: string
  skillPath?: string
}

export type DeleteSkillMode = 'trash' | 'permanent'

export const reportWorkflow: Workflow = {
  id: 'weekly-report',
  name: '导出周报',
  summary: '准备两个文件，等待导出完成，然后一起发送。',
  repeatCount: 5,
  estimatedMinutes: 11,
  confidence: 88,
  nodes: [
    { id: 'open', label: '打开报表目录', kind: 'action', app: 'Finder', confidence: 96 },
    { id: 'summary', label: '准备 summary.xlsx', kind: 'action', app: 'Excel', confidence: 92 },
    { id: 'details', label: '准备 details.pdf', kind: 'action', app: 'Preview', confidence: 89 },
    { id: 'wait', label: '等待导出完成', kind: 'wait', confidence: 87 },
    { id: 'send', label: '发送两个文件', kind: 'action', app: 'Mail', confidence: 91 },
    { id: 'done', label: '完成', kind: 'action', confidence: 95 },
  ],
  edges: [
    { from: 'open', to: 'summary' },
    { from: 'open', to: 'details' },
    { from: 'summary', to: 'wait' },
    { from: 'details', to: 'wait' },
    { from: 'wait', to: 'send' },
    { from: 'send', to: 'done' },
  ],
}

export const feedbackWorkflow: Workflow = {
  id: 'customer-feedback',
  name: '整理客户反馈',
  summary: '收集渠道消息，按主题整理后更新到表格。',
  repeatCount: 3,
  estimatedMinutes: 7,
  confidence: 76,
  nodes: [
    { id: 'collect', label: '收集反馈', kind: 'action', app: 'Slack', confidence: 82 },
    { id: 'group', label: '按主题归类', kind: 'action', confidence: 74 },
    { id: 'write', label: '更新反馈表', kind: 'action', app: 'Sheets', confidence: 79 },
  ],
  edges: [
    { from: 'collect', to: 'group' },
    { from: 'group', to: 'write' },
  ],
}

export const demoSkills: Skill[] = [
  {
    id: 'weekly-report-skill',
    name: '导出周报与指标汇总',
    description: '自动提取表格关键指标，生成周报文件并联动邮件客户端准备发送。',
    apps: ['Excel', 'Mail'],
    updatedLabel: '今天更新',
    pinned: true,
    sourceRuns: 5,
    versions: 3,
    workflow: reportWorkflow,
    targetTools: ['claude-code', 'antigravity', 'cursor'],
    tags: ['report', 'excel', 'workflow'],
    triggers: ['/report', 'export weekly report'],
    skillMarkdown: `---
name: weekly-report-skill
description: 自动汇总本周关键数据与进展报告，导出为 summary.xlsx 并准备发送
tools: [Excel, Mail]
version: 3.0.0
---

# Weekly Report Skill

## Instructions
1. 打开报表根目录并检查源数据。
2. 读取关键统计指标并写入 summary.xlsx。
3. 导出 details.pdf 附录。
4. 调用邮件客户端生成草稿并附加报告附件。
`,
  },
  {
    id: 'feedback-skill',
    name: '整理客户反馈与主题归类',
    description: '收集多渠道客户反馈消息，按分类标签打标并自动同步到共享在线表格。',
    apps: ['Slack', 'Sheets'],
    updatedLabel: '今天更新',
    pinned: true,
    sourceRuns: 5,
    versions: 3,
    workflow: feedbackWorkflow,
    targetTools: ['claude-code', 'antigravity', 'windsurf'],
    tags: ['feedback', 'slack', 'sheets'],
    triggers: ['/feedback', 'classify feedback'],
    skillMarkdown: `---
name: feedback-skill
description: 提取多渠道反馈并聚类整理为结构化表格
tools: [Slack, Sheets]
version: 3.0.0
---

# Customer Feedback Distillation Skill

## Instructions
1. 抓取反馈通道未读消息。
2. 进行语义理解与分类标签提取。
3. 写入 Google Sheets / Excel 汇总行。
`,
  },
  {
    id: 'design-handoff',
    name: '准备设计规范与资产交付',
    description: '提取设计稿切图与尺寸规范，生成前端组件交付说明并创建任务单。',
    apps: ['Figma', 'Linear'],
    updatedLabel: '昨天更新',
    pinned: true,
    sourceRuns: 4,
    versions: 2,
    workflow: feedbackWorkflow,
    targetTools: ['cursor', 'trae', 'agents-std'],
    tags: ['design', 'figma', 'linear'],
    triggers: ['/handoff', 'design handoff'],
    skillMarkdown: `---
name: design-handoff
description: 设计切图与组件规范导出并创建 Linear 交付任务
tools: [Figma, Linear]
version: 2.0.0
---

# Design Handoff Skill

## Instructions
1. 检查 Figma 选中组件的图层属性与 token。
2. 导出 svg/png 资源。
3. 生成 Linear Issue 描述与附件链接。
`,
  },
  {
    id: 'release-notes',
    name: '发布版本更新说明 (Release Notes)',
    description: '根据代码提交日志梳理功能清单，排版后发布到知识库与团队通知频道。',
    apps: ['Notion', 'Slack'],
    updatedLabel: '2 天前更新',
    pinned: false,
    sourceRuns: 3,
    versions: 2,
    workflow: feedbackWorkflow,
    targetTools: ['claude-code', 'cline'],
    tags: ['release', 'notion', 'git'],
    triggers: ['/release', 'generate release notes'],
    skillMarkdown: `---
name: release-notes
description: 自动从 Git 变更提取 Release Notes 并发布
tools: [Notion, Slack]
version: 2.0.0
---

# Release Notes Generator

## Instructions
1. 扫描当前版本 tag 间的 commit 日志。
2. 提炼 Feature、Fix 与 Breaking Changes。
3. 格式化并推送到团队频道。
`,
  },
  {
    id: 'review-invoices',
    name: '发票报销数据检查与核验',
    description: '批量读取发票 PDF 并进行金额与税号提取，比对报销明细并标记异常。',
    apps: ['Preview', 'Sheets'],
    updatedLabel: '5 天前更新',
    pinned: false,
    sourceRuns: 6,
    versions: 4,
    workflow: reportWorkflow,
    targetTools: ['antigravity', 'roo'],
    tags: ['finance', 'pdf', 'invoice'],
    triggers: ['/invoice', 'audit invoices'],
    skillMarkdown: `---
name: review-invoices
description: 自动校验发票 PDF 金额与报销明细
tools: [Preview, Sheets]
version: 4.0.0
---

# Invoice Review Skill

## Instructions
1. 遍历待报销的发票 PDF 目录。
2. 提取发票代码、金额与开票日期。
3. 校验总和并在表格中标记合规状态。
`,
  },
]

export interface RemoteSkill {
  id: string
  name: string
  description: string
  author: string
  stars: number
  downloads: string
  verified: boolean
  tags: string[]
  recommendedTools: string[]
  skillMarkdown: string
}

export const communityRemoteSkills: RemoteSkill[] = [
  {
    id: 'nextjs-app-router-best-practices',
    name: 'Next.js 15 App Router 最佳实践规范',
    description: '指导 AI Agent 生成符合 Next.js 15 App Router、Server Actions、React Server Components 标准的架构代码。',
    author: 'vercel/community',
    stars: 1420,
    downloads: '28.5k',
    verified: true,
    tags: ['nextjs', 'react', 'typescript', 'frontend'],
    recommendedTools: ['agents-std', 'claude-code', 'cursor'],
    skillMarkdown: `---
name: nextjs-app-router-best-practices
description: Next.js 15 App Router & Server Components coding standards
tags: [nextjs, react, frontend]
---

# Next.js App Router Best Practices

## Guidelines
1. Always prefer Server Components unless client state (useState/useEffect/event listeners) is strictly needed.
2. Place Server Actions in dedicated \`actions/\` folders with \`'use server'\`.
3. Use Next.js dynamic routing convention: \`app/[slug]/page.tsx\`.
4. Ensure proper loading and error boundaries (\`loading.tsx\`, \`error.tsx\`).
`,
  },
  {
    id: 'supabase-postgres-expert',
    name: 'Supabase Postgres 数据库优化规范',
    description: 'PostgreSQL 架构设计、RLS 行级安全策略编写、索引性能优化及高并发连接池配置最佳实践。',
    author: 'supabase/official',
    stars: 2180,
    downloads: '42.1k',
    verified: true,
    tags: ['supabase', 'postgres', 'database', 'sql'],
    recommendedTools: ['antigravity', 'claude-code', 'windsurf'],
    skillMarkdown: `---
name: supabase-postgres-expert
description: Postgres performance optimization, RLS policies, and schema design from Supabase
tags: [postgres, supabase, sql]
---

# Supabase Postgres Expert Skill

## Guidelines
1. Always enable RLS (Row Level Security) on all tables with sensible policies.
2. Add foreign key indexes to prevent table locking during joins and updates.
3. Optimize queries with EXPLAIN ANALYZE before deploying production migrations.
`,
  },
  {
    id: 'git-conventional-commits-flow',
    name: 'Git 语义化提交与分支工作流规范',
    description: '自动遵循 Conventional Commits 标准解析 Diff，生成符合标准的 feat/fix/refactor/chore 提交信息并管理分支。',
    author: 'antigravity-hub',
    stars: 980,
    downloads: '19.4k',
    verified: true,
    tags: ['git', 'workflow', 'ci-cd'],
    recommendedTools: ['agents-std', 'claude-code', 'cursor', 'trae'],
    skillMarkdown: `---
name: git-conventional-commits-flow
description: Enforce semantic conventional commits and branch flows
tags: [git, workflow, commits]
---

# Git Conventional Commits Skill

## Commit Structure
- \`feat(scope): ...\` for new features
- \`fix(scope): ...\` for bug fixes
- \`refactor(scope): ...\` for code cleanups without behavior changes
- \`chore(scope): ...\` for build scripts / dependency updates
`,
  },
  {
    id: 'docker-compose-production-deploy',
    name: 'Docker 生产级多容器编排技能',
    description: '多阶段构建 Dockerfile 瘦身、无特权非 root 用户执行、Docker Compose 健康检查与持久化卷治理。',
    author: 'docker/community',
    stars: 870,
    downloads: '15.2k',
    verified: true,
    tags: ['docker', 'devops', 'deployment'],
    recommendedTools: ['agents-std', 'claude-code', 'roo'],
    skillMarkdown: `---
name: docker-compose-production-deploy
description: Hardened multi-stage Docker builds and Docker Compose recipes
tags: [docker, devops, deploy]
---

# Docker Production Deploy Skill

## Rules
1. Multi-stage builds: build stage with full SDK, runtime stage with minimal alpine/distroless.
2. Never run containers as root: declare \`USER nonroot:nonroot\`.
3. Include healthcheck endpoints in docker-compose.yml.
`,
  },
  {
    id: 'tailwind-v4-design-system',
    name: 'Tailwind CSS v4 现代原子化设计规范',
    description: '针对 Tailwind CSS v4 CSS-first 配置、OKLCH 色彩空间、动态变体与现代玻璃态组件的 Prompt 规范与代码生成。',
    author: 'tailwindlabs/community',
    stars: 1650,
    downloads: '31.8k',
    verified: true,
    tags: ['tailwind', 'css', 'design-system', 'ui'],
    recommendedTools: ['cursor', 'windsurf', 'trae'],
    skillMarkdown: `---
name: tailwind-v4-design-system
description: Modern Tailwind CSS v4 design tokens and glassy component generator
tags: [tailwind, css, ui]
---

# Tailwind CSS v4 Design System

## Instructions
1. Use \`@theme\` block in main CSS file instead of tailwind.config.js.
2. Utilize modern \`oklch()\` color definitions for high dynamic range fidelity.
3. Combine utility classes with CSS variables for dynamic light/dark theming.
`,
  },
]

// =========================================================================
// MCP (Model Context Protocol) Server Unified Architecture Models (OPC-47)
// =========================================================================

export type MCPSourceTool = 'claude-code' | 'cursor' | 'gemini' | 'codex'
export type MCPScope = 'global' | 'project'
export type MCPTransportType = 'stdio' | 'sse' | 'http'

export interface MCPServerDefinition {
  id: string
  name: string
  sourceTool: MCPSourceTool
  scope: MCPScope
  transport: MCPTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  envHeaders?: Record<string, string> // e.g. Codex env_http_headers
  enabled: boolean
  sourceRaw?: Record<string, unknown> // Unrecognized/tool-specific fields preserved on same-source edit
  configPath: string
  revision?: string // Opaque revision token for optimistic concurrency / conflict guard
  updatedAt?: number
}

export interface MCPServerInput {
  name: string
  transport: MCPTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  envHeaders?: Record<string, string>
  enabled?: boolean
  sourceRaw?: Record<string, unknown>
  expectedRevision?: string
}

export interface MCPDistributionTarget {
  tool: MCPSourceTool
  scope: MCPScope
  projectWorkspace?: string
  expectedRevision?: string
}

export interface MCPDistributionPreflightItem {
  tool: MCPSourceTool
  scope: MCPScope
  projectWorkspace?: string
  configPath: string
  targetExists: boolean
  willOverwrite: boolean
  compatible: boolean
  currentRevision?: string
  reasons?: string[]
}

export interface MCPDistributionPreflightResult {
  canDistribute: boolean
  targets: MCPDistributionPreflightItem[]
}

export interface MCPDistributionResultItem {
  tool: MCPSourceTool
  scope: MCPScope
  projectWorkspace?: string
  configPath: string
  success: boolean
  error?: string
}

export interface MCPDistributionReport {
  overallSuccess: boolean
  results: MCPDistributionResultItem[]
}

export interface MCPSourceToolMetadata {
  id: MCPSourceTool
  name: string
  logoId: string
  description: string
  globalConfigFileName: string
  projectConfigFileName: string
  supportedTransports: MCPTransportType[]
}

export const MCP_SOURCE_TOOLS: MCPSourceToolMetadata[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    logoId: 'claude',
    description: 'Anthropic Claude Code 全局终端或项目级 MCP 配置 (~/.claude.json / .mcp.json)',
    globalConfigFileName: '.claude.json',
    projectConfigFileName: '.mcp.json',
    supportedTransports: ['stdio', 'sse', 'http'],
  },
  {
    id: 'cursor',
    name: 'Cursor IDE',
    logoId: 'cursor',
    description: 'Cursor IDE 全局与项目级 MCP 服务目录 (~/.cursor/mcp.json / .cursor/mcp.json)',
    globalConfigFileName: '.cursor/mcp.json',
    projectConfigFileName: '.cursor/mcp.json',
    supportedTransports: ['stdio', 'http'],
  },
  {
    id: 'gemini',
    name: 'Google Antigravity & Gemini',
    logoId: 'gemini',
    description: 'Google Antigravity 与 Gemini CLI 全局与项目配置 (~/.gemini/settings.json)',
    globalConfigFileName: '.gemini/settings.json',
    projectConfigFileName: '.gemini/settings.json',
    supportedTransports: ['stdio', 'sse', 'http'],
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    logoId: 'codex',
    description: 'OpenAI Codex CLI TOML 配置文件 (~/.codex/config.toml / .codex/config.toml)',
    globalConfigFileName: '.codex/config.toml',
    projectConfigFileName: '.codex/config.toml',
    supportedTransports: ['stdio', 'http'],
  },
]

// =========================================================================
// Unified Asset Management, Projects & Public Rules (OPC-56)
// =========================================================================

export interface ProjectRecord {
  id: string
  name: string
  path: string
  addedAt: number
}

export type ProjectDirectoryStatus = 'valid' | 'missing'

export interface ManagedProjectRecord extends ProjectRecord {
  status: ProjectDirectoryStatus
  exists: boolean
  error?: string
}

export interface ProjectSkillPathStatus {
  id: string
  name: string
  relPath: string
  fullPath: string
  exists: boolean
  skillCount: number
}

export interface PublicRule {
  id: string
  name: string
  content: string
  description?: string
  createdAt: number
  updatedAt: number
}

export interface ProjectRuleAssociation {
  projectPath: string
  ruleIds: string[]
  lastSyncedAt?: number
  status: 'synced' | 'failed' | 'pending'
  lastError?: string
}

export interface ClaudeLinkStatus {
  exists: boolean
  isSymlink: boolean
  target?: string
  isCorrect: boolean
  conflict: boolean
  reason?: string
}

export interface ClaudeLinkResult {
  success: boolean
  action?: 'created' | 'skipped'
  conflict?: boolean
  reason?: string
}

export interface MCPTargetAssociation {
  tool: MCPSourceTool
  scope: MCPScope
  projectPath?: string
  injectedAt?: number
  lastSyncStatus?: 'synced' | 'failed'
  lastError?: string
}

export interface CentralMCPServer {
  id: string
  name: string
  transport: MCPTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  envHeaders?: Record<string, string>
  enabled: boolean
  description?: string
  targetAssociations?: MCPTargetAssociation[]
  updatedAt?: number
}

export interface BatchItemResult {
  id: string
  success: boolean
  error?: string
}

export const SUPPORTED_PROJECT_SKILL_PATHS: Array<{ id: string; name: string; relPath: string }> = [
  { id: 'agents', name: '.agents 通用规范', relPath: '.agents/skills' },
  { id: 'claude', name: 'Claude Code', relPath: '.claude/skills' },
  { id: 'cursor', name: 'Cursor IDE', relPath: '.cursor/skills' },
  { id: 'github', name: 'GitHub Copilot', relPath: '.github/skills' },
  { id: 'trae', name: 'Trae IDE', relPath: '.trae/skills' },
  { id: 'gemini', name: 'Google Antigravity & Gemini', relPath: '.gemini/skills' },
]
