export type WorkflowNodeKind =
  | 'action'
  | 'wait'
  | 'parallel-split'
  | 'parallel-join'
  | 'branch'
  | 'loop'

export interface WorkflowNode {
  id: string
  label: string
  detail?: string
  kind: WorkflowNodeKind
  app?: string
  confidence: number
}

export interface WorkflowEdge {
  from: string
  to: string
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
  defaultDir: string
  customDir?: string
  installed?: boolean
  detectedPath?: string
  iconName: string
  description?: string
  compatibleTools?: AssociatedAITool[]
}

export const DEFAULT_AI_TOOLS: AIToolTarget[] = [
  {
    id: 'agents-std',
    name: '.agents 通用目录环境',
    category: 'standard',
    defaultDir: '.agents/skills',
    iconName: 'FolderTree',
    description: 'skills.sh 跨工具通用开放规范，多个主流 AI Agent 原生共用此目录',
    compatibleTools: [
      { id: 'antigravity', name: 'Google Antigravity', logoId: 'antigravity' },
      { id: 'gemini', name: 'Gemini CLI', logoId: 'gemini' },
      { id: 'opencode', name: 'OpenCode', logoId: 'opencode' },
      { id: 'lobehub', name: 'LobeHub', logoId: 'lobehub' },
    ],
  },
  {
    id: 'claude-code',
    name: '.claude 技能目录环境',
    category: 'cli',
    defaultDir: '.claude/skills',
    iconName: 'Zap',
    description: 'Anthropic Claude Code CLI 终端编程 Agent 专用技能目录',
    compatibleTools: [
      { id: 'claude-code', name: 'Claude Code', logoId: 'claude' },
      { id: 'claude-cli', name: 'Claude CLI', logoId: 'claude' },
    ],
  },
  {
    id: 'cursor',
    name: '.cursor 技能目录环境',
    category: 'ide',
    defaultDir: '.cursor/skills',
    iconName: 'Terminal',
    description: 'Cursor AI 智能编程编辑器技能与规则配置目录',
    compatibleTools: [
      { id: 'cursor', name: 'Cursor IDE', logoId: 'cursor' },
    ],
  },
  {
    id: 'windsurf',
    name: '.windsurf 技能目录环境',
    category: 'ide',
    defaultDir: '.windsurf/skills',
    iconName: 'Monitor',
    description: 'Codeium Windsurf AI 原生 IDE 技能配置目录',
    compatibleTools: [
      { id: 'windsurf', name: 'Windsurf IDE', logoId: 'windsurf' },
    ],
  },
  {
    id: 'trae',
    name: '.trae 技能目录环境',
    category: 'ide',
    defaultDir: '.trae/skills',
    iconName: 'Monitor',
    description: 'ByteDance Trae AI 自适应集成开发环境技能目录',
    compatibleTools: [
      { id: 'trae', name: 'Trae IDE', logoId: 'trae' },
    ],
  },
  {
    id: 'cline',
    name: '.cline 技能目录环境',
    category: 'extension',
    defaultDir: '.cline/skills',
    iconName: 'Boxes',
    description: 'Cline VS Code 自主编码 Agent 插件技能目录',
    compatibleTools: [
      { id: 'cline', name: 'Cline Extension', logoId: 'cline' },
    ],
  },
  {
    id: 'roo',
    name: '.roo 技能目录环境',
    category: 'extension',
    defaultDir: '.roo/skills',
    iconName: 'Boxes',
    description: 'Roo Code 多模式 AI 架构与任务插件技能目录',
    compatibleTools: [
      { id: 'roo', name: 'Roo Code', logoId: 'roo' },
    ],
  },
  {
    id: 'codex',
    name: '.codex 技能目录环境',
    category: 'cli',
    defaultDir: '.codex/skills',
    iconName: 'Zap',
    description: 'OpenAI Codex 命令行代码生成工具技能目录',
    compatibleTools: [
      { id: 'codex', name: 'Codex CLI', logoId: 'codex' },
      { id: 'openai', name: 'OpenAI Agent', logoId: 'openai' },
    ],
  },
  {
    id: 'copilot',
    name: '.github 技能目录环境',
    category: 'extension',
    defaultDir: '.github/skills',
    iconName: 'FolderTree',
    description: 'GitHub Copilot 扩展技能配置目录',
    compatibleTools: [
      { id: 'github-copilot', name: 'GitHub Copilot', logoId: 'copilot' },
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
  tags?: string[]
  triggers?: string[]
  skillMarkdown?: string
  skillPath?: string
}

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

