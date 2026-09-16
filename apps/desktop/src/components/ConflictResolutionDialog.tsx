import { AlertTriangle, Check, Download, ExternalLink, RefreshCw, X } from 'lucide-react'
import type { ConflictResolutionStrategy } from '@workflow-skill/workflow-model'

export interface ConflictResolutionDialogProps {
  open: boolean
  assetKind: 'Skill' | 'MCP'
  assetName: string
  targetLabel: string
  sourcePath?: string
  targetPath?: string
  statusLabel: string
  canUseTarget: boolean
  busy?: boolean
  error?: string
  onClose: () => void
  onResolve: (strategy: ConflictResolutionStrategy) => void | Promise<void>
}

const STRATEGIES: Array<{
  id: ConflictResolutionStrategy
  title: string
  description: string
  icon: typeof Check
  tone: string
}> = [
  {
    id: 'use_app',
    title: '以应用为准',
    description: '用 Trace 中央版本恢复目标。原目标会先备份到回收目录。',
    icon: Check,
    tone: 'is-primary',
  },
  {
    id: 'use_target',
    title: '以目标为准',
    description: '把目标修改纳入中央资产，旧中央版本会先备份。',
    icon: Download,
    tone: 'is-target',
  },
  {
    id: 'keep_external',
    title: '保留外部',
    description: '保持目标现状，只解除 Trace 对这个目标的管理关联。',
    icon: ExternalLink,
    tone: 'is-neutral',
  },
]

export function ConflictResolutionDialog({
  open,
  assetKind,
  assetName,
  targetLabel,
  sourcePath,
  targetPath,
  statusLabel,
  canUseTarget,
  busy = false,
  error,
  onClose,
  onResolve,
}: ConflictResolutionDialogProps) {
  if (!open) return null

  return (
    <div className="conflict-resolution-backdrop view-enter" onMouseDown={() => { if (!busy) onClose() }}>
      <div
        className="glass-dialog-box conflict-resolution-dialog modal-pop"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="conflict-resolution-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header-row">
          <div className="conflict-resolution-title-wrap">
            <span className="conflict-resolution-icon"><AlertTriangle size={16} /></span>
            <div>
              <h3 id="conflict-resolution-title" className="glass-dialog-title">解决 {assetKind} 冲突</h3>
              <p className="conflict-resolution-subtitle">{assetName} · {targetLabel}</p>
            </div>
          </div>
          <button type="button" className="clear-search-btn" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={14} />
          </button>
        </div>

        <div className="conflict-resolution-summary">
          <div><span>当前状态</span><strong>{statusLabel}</strong></div>
          {sourcePath ? <div><span>应用源</span><code title={sourcePath}>{sourcePath}</code></div> : null}
          {targetPath ? <div><span>目标位置</span><code title={targetPath}>{targetPath}</code></div> : null}
        </div>
        <p className="dialog-desc-text">
          目标内容已被外部修改。请选择处理方式；未选择前不会覆盖或删除任何内容。
        </p>

        <div className="conflict-resolution-options">
          {STRATEGIES.map((strategy) => {
            const Icon = strategy.icon
            const disabled = busy || (strategy.id === 'use_target' && !canUseTarget)
            return (
              <button
                key={strategy.id}
                type="button"
                className={`conflict-resolution-option ${strategy.tone}`}
                disabled={disabled}
                onClick={() => void onResolve(strategy.id)}
              >
                <span className="conflict-resolution-option__icon">
                  {busy ? <RefreshCw size={14} className="spin" /> : <Icon size={14} />}
                </span>
                <span className="conflict-resolution-option__copy">
                  <strong>{strategy.title}</strong>
                  <small>{strategy.id === 'use_target' && !canUseTarget ? '目标软链已损坏，无法读取目标内容。' : strategy.description}</small>
                </span>
              </button>
            )
          })}
        </div>

        {error ? <div className="conflict-resolution-error" role="alert">{error}</div> : null}

        <div className="dialog-footer-row">
          <button type="button" className="btn btn--capsule-ghost btn--sm" onClick={onClose} disabled={busy}>取消</button>
        </div>
      </div>
    </div>
  )
}
