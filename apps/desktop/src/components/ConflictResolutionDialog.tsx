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
    description: '使用应用版本覆盖目标（原内容已备份至回收目录）',
    icon: Check,
    tone: 'is-primary',
  },
  {
    id: 'use_target',
    title: '以目标为准',
    description: '同步目标外部修改回应用（旧版本已备份）',
    icon: Download,
    tone: 'is-target',
  },
  {
    id: 'keep_external',
    title: '保留外部',
    description: '保持目标现状，仅解除与 Trace 的管理关联',
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
    <div
      className="modal-backdrop conflict-resolution-backdrop view-enter"
      onMouseDown={() => { if (!busy) onClose() }}
    >
      <div
        className="dialog-surface conflict-resolution-dialog modal-pop"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="conflict-resolution-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header-row">
          <div className="conflict-resolution-title-wrap">
            <div className="danger-icon-badge">
              <AlertTriangle size={15} />
            </div>
            <div>
              <h2 id="conflict-resolution-title">解决 {assetKind} 冲突</h2>
              <p className="conflict-resolution-subtitle font-mono">
                <span>{assetName} · {targetLabel}</span>
                {statusLabel && statusLabel !== '存在冲突' ? (
                  <span className="conflict-status-pill">{statusLabel}</span>
                ) : null}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="dialog-close-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className="dialog-body conflict-resolution-dialog__body">
          {(sourcePath || targetPath) ? (
            <div className="conflict-paths-list font-mono">
              {sourcePath ? (
                <div className="conflict-path-row">
                  <span className="conflict-path-label">应用源</span>
                  <span className="conflict-path-value" title={sourcePath}>{sourcePath}</span>
                </div>
              ) : null}
              {targetPath ? (
                <div className="conflict-path-row">
                  <span className="conflict-path-label">目标位置</span>
                  <span className="conflict-path-value" title={targetPath}>{targetPath}</span>
                </div>
              ) : null}
            </div>
          ) : null}

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
                    {busy ? <RefreshCw size={13} className="spin" /> : <Icon size={13} />}
                  </span>
                  <span className="conflict-resolution-option__copy">
                    <strong>{strategy.title}</strong>
                    <small>{strategy.id === 'use_target' && !canUseTarget ? '目标软链已损坏，无法读取目标内容' : strategy.description}</small>
                  </span>
                </button>
              )
            })}
          </div>

          {error ? <div className="conflict-resolution-error" role="alert">{error}</div> : null}
        </div>

        <div className="dialog-footer-row">
          <button
            type="button"
            className="btn btn--secondary btn--capsule btn--sm"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
