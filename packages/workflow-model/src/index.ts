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
    name: '导出周报',
    description: '汇总关键指标并发送给相关成员。',
    apps: ['Excel', 'Mail'],
    updatedLabel: '今天更新',
    pinned: true,
    sourceRuns: 5,
    versions: 3,
    workflow: reportWorkflow,
  },
  {
    id: 'feedback-skill',
    name: '整理客户反馈',
    description: '收集、标记并按主题整理客户反馈。',
    apps: ['Slack', 'Sheets'],
    updatedLabel: '今天更新',
    pinned: true,
    sourceRuns: 5,
    versions: 3,
    workflow: feedbackWorkflow,
  },
  {
    id: 'design-handoff',
    name: '准备设计交付',
    description: '整理资源和说明，交付给研发团队。',
    apps: ['Figma', 'Linear'],
    updatedLabel: '昨天更新',
    pinned: true,
    sourceRuns: 4,
    versions: 2,
    workflow: feedbackWorkflow,
  },
  {
    id: 'release-notes',
    name: '发布版本说明',
    description: '整理变更并发布到团队频道。',
    apps: ['Notion', 'Slack'],
    updatedLabel: '2 天前更新',
    pinned: false,
    sourceRuns: 3,
    versions: 2,
    workflow: feedbackWorkflow,
  },
  {
    id: 'review-invoices',
    name: '检查发票',
    description: '提取金额并标记异常项目。',
    apps: ['Preview', 'Sheets'],
    updatedLabel: '5 天前更新',
    pinned: false,
    sourceRuns: 6,
    versions: 4,
    workflow: reportWorkflow,
  },
]

