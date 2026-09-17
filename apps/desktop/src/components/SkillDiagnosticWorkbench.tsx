import { useMemo } from 'react'
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Download,
  Folder,
  Layers,
  Link2,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react'
import type {
  BatchSkillAdoptionResult,
  ManagedProjectRecord,
  Skill,
  SkillAdoptionPlan,
  SkillAdoptionPlanItem,
  SkillTargetBinding,
} from '@workflow-skill/workflow-model'
import { useI18n } from '../i18n'

export interface SkillDiagnosticWorkbenchProps {
  plan: SkillAdoptionPlan | null
  result: BatchSkillAdoptionResult | null
  busy: boolean
  scope: 'global' | 'project'
  selectedProject?: ManagedProjectRecord | null
  projects?: ManagedProjectRecord[]
  skills: Skill[]
  projectDiscoveryErrors?: string[]
  onAdoptAll: () => Promise<void>
  onSelectSkill: (skillId: string) => void
  onResolveConflict?: (binding: SkillTargetBinding, skill: Skill) => void
  onRefresh: () => Promise<void>
  onClose?: () => void
}

interface DiagnosticConflictItem {
  id: string
  name: string
  reason: string
  sourcePath?: string
  targets: Array<{ toolId?: string; scope: string; path?: string }>
  skill?: Skill
  binding?: SkillTargetBinding
}

interface DiagnosticBrokenItem {
  id: string
  title: string
  reason: string
  path?: string
  skill?: Skill
}

export function SkillDiagnosticWorkbench({
  plan,
  result,
  busy,
  scope,
  selectedProject,
  skills,
  projectDiscoveryErrors = [],
  onAdoptAll,
  onSelectSkill,
  onResolveConflict,
  onRefresh,
  onClose,
}: SkillDiagnosticWorkbenchProps) {
  const { t } = useI18n()

  // 1. Ready items (可直接接管)
  const readyItems = useMemo<SkillAdoptionPlanItem[]>(() => {
    return (plan?.items || []).filter((item) => item.status === 'ready')
  }, [plan?.items])

  const readyTargetsCount = useMemo(() => {
    return readyItems.reduce((acc, item) => acc + item.targets.length, 0)
  }, [readyItems])

  // 2. Conflict items (内容冲突)
  const conflictItems = useMemo<DiagnosticConflictItem[]>(() => {
    const list: DiagnosticConflictItem[] = []
    const seenIds = new Set<string>()

    // From adoption plan
    for (const item of plan?.items || []) {
      if (item.status === 'conflict') {
        const id = item.suggestedSkillId || item.name
        seenIds.add(id)
        const matchingSkill = skills.find((s) => s.id === id || s.name === item.name)
        const conflictBinding = matchingSkill?.targetBindings?.find((b) => b.status === 'conflict')
        list.push({
          id,
          name: item.name,
          reason: item.reason || '与中心库同名 Skill 内容不同，或多个工具目录下版本不一致',
          sourcePath: item.sourcePath,
          targets: item.targets.map((tgt) => ({
            toolId: tgt.toolId,
            scope: tgt.scope,
            path: tgt.targetPath,
          })),
          skill: matchingSkill,
          binding: conflictBinding,
        })
      }
    }

    // From current loaded skills in scope
    for (const skill of skills) {
      if (seenIds.has(skill.id)) continue
      const conflictBinding = skill.targetBindings?.find((b) => b.status === 'conflict')
      if (skill.scopeStatus === '冲突' || conflictBinding) {
        seenIds.add(skill.id)
        list.push({
          id: skill.id,
          name: skill.name,
          reason: conflictBinding?.error || '该 Skill 在目标环境中存在未同步的内容修改',
          sourcePath: skill.sourcePath || skill.skillPath,
          targets: (skill.targetBindings || [])
            .filter((b) => b.status === 'conflict')
            .map((b) => ({
              toolId: b.toolId,
              scope: b.scope,
              path: b.targetPath,
            })),
          skill,
          binding: conflictBinding,
        })
      }
    }

    return list
  }, [plan?.items, skills])

  // 3. Broken / Invalid items (断链 / 异常)
  const brokenItems = useMemo<DiagnosticBrokenItem[]>(() => {
    const list: DiagnosticBrokenItem[] = []
    const seenKeys = new Set<string>()

    // From adoption plan items
    for (const item of plan?.items || []) {
      if (item.status === 'invalid') {
        const key = `invalid-${item.key}`
        seenKeys.add(key)
        list.push({
          id: key,
          title: item.name,
          reason: item.reason || '目录无法读取或软链接损坏',
          path: item.sourcePath,
        })
      }
    }

    // From adoption plan errors
    for (const err of plan?.errors || []) {
      if (seenKeys.has(err)) continue
      seenKeys.add(err)
      list.push({
        id: `plan-err-${err}`,
        title: '扫描错误',
        reason: err,
      })
    }

    // From project discovery errors
    for (const err of projectDiscoveryErrors) {
      if (seenKeys.has(err)) continue
      seenKeys.add(err)
      list.push({
        id: `proj-err-${err}`,
        title: '项目扫描异常',
        reason: err,
      })
    }

    // From skills with broken bindings
    for (const skill of skills) {
      const brokenBinding = skill.targetBindings?.find((b) => b.status === 'broken')
      if (skill.scopeStatus === '链接损坏' || brokenBinding) {
        const key = `broken-skill-${skill.id}`
        if (seenKeys.has(key)) continue
        seenKeys.add(key)
        list.push({
          id: key,
          title: skill.name,
          reason: brokenBinding?.error || '指向的软链接已损坏或目标目录不存在',
          path: brokenBinding?.targetPath || skill.sourcePath,
          skill,
        })
      }
    }

    return list
  }, [plan?.items, plan?.errors, projectDiscoveryErrors, skills])

  const readyCount = readyItems.length
  const conflictCount = conflictItems.length
  const brokenCount = brokenItems.length
  const totalIssues = readyCount + conflictCount + brokenCount

  return (
    <div className="skill-diagnostic-workbench view-enter" role="region" aria-label="Skill 诊断与批量接管工作台">
      {/* Header */}
      <header className="skill-diag-header">
        <div className="skill-diag-header__main">
          <div className="skill-diag-header__title-row">
            <div className="skill-diag-header__icon-box">
              <ShieldCheck size={20} className="skill-diag-header__icon" />
            </div>
            <div>
              <div className="skill-diag-header__eyebrow">
                <span>{t.skills.diagnosticTitle}</span>
                <span className="skill-diag-scope-pill">
                  {scope === 'global' ? '全局工作区' : selectedProject ? `项目：${selectedProject.name}` : '项目工作区'}
                </span>
              </div>
              <p className="skill-diag-header__desc">{t.skills.diagnosticSub}</p>
            </div>
          </div>
          <div className="skill-diag-header__actions">
            <button
              type="button"
              className="btn btn--capsule btn--secondary btn--sm"
              onClick={() => void onRefresh()}
              disabled={busy}
              title="重新诊断与扫描"
            >
              <RefreshCw size={12} className={busy ? 'spin' : ''} />
              <span>{busy ? '正在扫描…' : '重新扫描'}</span>
            </button>
            {onClose ? (
              <button
                type="button"
                className="btn btn--capsule btn--secondary btn--sm"
                onClick={onClose}
                title="返回 Skill 列表"
              >
                <ArrowLeft size={12} />
                <span>返回列表</span>
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {/* Metrics Summary Strip */}
      <section className="skill-diag-metrics" aria-label="诊断状态统计">
        <div className={`skill-diag-metric-card ${readyCount > 0 ? 'is-ready' : 'is-muted'}`}>
          <div className="skill-diag-metric-card__header">
            <CheckCircle2 size={15} />
            <span>可直接接管</span>
          </div>
          <div className="skill-diag-metric-card__value">
            <strong>{readyCount}</strong>
            <small>个 Skill ({readyTargetsCount} 个入口)</small>
          </div>
          <p className="skill-diag-metric-card__hint">已校验一致，可一键批量纳入中心库</p>
        </div>

        <div className={`skill-diag-metric-card ${conflictCount > 0 ? 'is-conflict' : 'is-muted'}`}>
          <div className="skill-diag-metric-card__header">
            <AlertTriangle size={15} />
            <span>内容冲突</span>
          </div>
          <div className="skill-diag-metric-card__value">
            <strong>{conflictCount}</strong>
            <small>项待确认</small>
          </div>
          <p className="skill-diag-metric-card__hint">外部与中心库内容不一致，需人工决策</p>
        </div>

        <div className={`skill-diag-metric-card ${brokenCount > 0 ? 'is-broken' : 'is-muted'}`}>
          <div className="skill-diag-metric-card__header">
            <AlertCircle size={15} />
            <span>断链 / 异常</span>
          </div>
          <div className="skill-diag-metric-card__value">
            <strong>{brokenCount}</strong>
            <small>项需排查</small>
          </div>
          <p className="skill-diag-metric-card__hint">软链接失效、路径不存在或无读取权限</p>
        </div>
      </section>

      {/* Batch Adoption Hero Card */}
      {readyCount > 0 ? (
        <section className="skill-diag-batch-card" aria-label="批量接管操作区">
          <div className="skill-diag-batch-card__content">
            <div className="skill-diag-batch-card__info">
              <div className="skill-diag-batch-card__badge-row">
                <span className="skill-diag-badge skill-diag-badge--accent">
                  <Download size={11} />
                  <span>可批量执行</span>
                </span>
                <span className="skill-diag-safe-guarantee">零风险安全接管承诺</span>
              </div>
              <h3 className="skill-diag-batch-card__title">统一将外部散落 Skill 纳入 Trace 中心库</h3>
              <p className="skill-diag-batch-card__desc">
                <strong>影响范围：</strong>将把上述 <strong>{readyCount}</strong> 个 Skill 复制到中心库，并在其对应的{' '}
                <strong>{readyTargetsCount}</strong> 个外部 AI 环境中建立规范符号链接。
              </p>
              <p className="skill-diag-batch-card__desc">
                <strong>安全保护：</strong>原目录在替换前将自动安全备份至 <code>~/.trace/.trash</code>
                ；冲突项（{conflictCount}）与异常项（{brokenCount}）均已自动隔离跳过，绝不静默覆盖现有代码。
              </p>
            </div>
            <div className="skill-diag-batch-card__cta">
              <button
                type="button"
                className="btn btn--primary btn--capsule"
                disabled={busy}
                onClick={() => void onAdoptAll()}
              >
                {busy ? <RefreshCw size={13} className="spin" /> : <Download size={13} />}
                <span>{busy ? '正在批量接管…' : `批量接管可处理项 (${readyTargetsCount})`}</span>
              </button>
            </div>
          </div>

          {result ? (
            <div
              className={`skill-diag-result ${result.success ? 'is-success' : 'is-partial'}`}
              role="status"
            >
              {result.success ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              <div>
                <strong>{result.success ? '批量接管完成' : '批量接管已部分完成'}</strong>
                <span>
                  已成功统一连接 {result.linkedTargetCount} 个入口
                  {result.skippedCount > 0
                    ? `，仍有 ${result.skippedCount} 项因冲突或异常保留原状，需手动核对`
                    : ''}
                  。
                </span>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Global Healthy Safe Empty State */}
      {totalIssues === 0 ? (
        <div className="skill-diag-healthy-card" role="status">
          <div className="skill-diag-healthy-card__icon-box">
            <CheckCircle2 size={36} />
          </div>
          <h3>{t.skills.diagnosticHealthyTitle}</h3>
          <p>{t.skills.diagnosticHealthyDesc}</p>
          <button
            type="button"
            className="btn btn--capsule btn--secondary btn--sm"
            onClick={() => void onRefresh()}
            disabled={busy}
          >
            <RefreshCw size={12} className={busy ? 'spin' : ''} />
            <span>重新扫描</span>
          </button>
        </div>
      ) : null}

      {/* Status Groups */}
      <div className="skill-diag-groups">
        {/* Group 1: 可直接接管 */}
        <section className="skill-diag-group" aria-labelledby="group-ready-heading">
          <div className="skill-diag-group__header">
            <div className="skill-diag-group__title-row">
              <CheckCircle2 size={16} className="skill-diag-group__icon is-ready" />
              <h2 id="group-ready-heading" className="skill-diag-group__title">
                {t.skills.diagnosticReadyGroup}
              </h2>
              <span className="skill-diag-group__count is-ready">{readyCount}</span>
            </div>
            <span className="skill-diag-group__tag is-ready">可安全迁移</span>
          </div>
          <p className="skill-diag-group__desc">{t.skills.diagnosticReadyDesc}</p>

          {readyCount === 0 ? (
            <div className="skill-diag-empty-box">暂无可直接接管的项目。当前无外部散落的未受管资产。</div>
          ) : (
            <div className="skill-diag-item-list">
              {readyItems.map((item) => (
                <div className="skill-diag-item-row" key={item.key}>
                  <div className="skill-diag-item-row__main">
                    <div className="skill-diag-item-row__title-wrap">
                      <Folder size={14} className="skill-diag-item-icon" />
                      <span className="skill-diag-item-title">{item.name}</span>
                      <span className="skill-diag-item-badge">
                        {item.targets.length} 个入口目标
                      </span>
                    </div>
                    <div className="skill-diag-item-row__path font-mono" title={item.sourcePath}>
                      {item.sourcePath}
                    </div>
                    <div className="skill-diag-item-row__targets">
                      {item.targets.map((tgt, idx) => (
                        <span className="skill-diag-target-pill" key={idx}>
                          {tgt.toolId || tgt.relPath || tgt.scope}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="skill-diag-item-row__action">
                    <button
                      type="button"
                      className="btn btn--capsule btn--secondary btn--sm"
                      onClick={() => onSelectSkill(item.suggestedSkillId || item.name)}
                    >
                      <span>单项详情</span>
                      <ChevronRight size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Group 2: 内容冲突 */}
        <section className="skill-diag-group" aria-labelledby="group-conflict-heading">
          <div className="skill-diag-group__header">
            <div className="skill-diag-group__title-row">
              <AlertTriangle size={16} className="skill-diag-group__icon is-conflict" />
              <h2 id="group-conflict-heading" className="skill-diag-group__title">
                {t.skills.diagnosticConflictGroup}
              </h2>
              <span className="skill-diag-group__count is-conflict">{conflictCount}</span>
            </div>
            <span className="skill-diag-group__tag is-conflict">需人工确认</span>
          </div>
          <p className="skill-diag-group__desc">{t.skills.diagnosticConflictDesc}</p>

          {conflictCount === 0 ? (
            <div className="skill-diag-empty-box">暂无内容冲突。各环境下的同名 Skill 版本均保持一致。</div>
          ) : (
            <div className="skill-diag-item-list">
              {conflictItems.map((item) => (
                <div className="skill-diag-item-row is-conflict-row" key={item.id}>
                  <div className="skill-diag-item-row__main">
                    <div className="skill-diag-item-row__title-wrap">
                      <AlertTriangle size={14} className="skill-diag-item-icon is-conflict" />
                      <span className="skill-diag-item-title">{item.name}</span>
                      <span className="skill-diag-item-badge is-conflict">冲突保护中</span>
                    </div>
                    <p className="skill-diag-item-conflict-reason">{item.reason}</p>
                    {item.sourcePath ? (
                      <div className="skill-diag-item-row__path font-mono" title={item.sourcePath}>
                        {item.sourcePath}
                      </div>
                    ) : null}
                  </div>
                  <div className="skill-diag-item-row__action">
                    <button
                      type="button"
                      className="btn btn--capsule btn--secondary btn--sm"
                      onClick={() => {
                        if (item.binding && item.skill && onResolveConflict) {
                          onResolveConflict(item.binding, item.skill)
                        } else {
                          onSelectSkill(item.id)
                        }
                      }}
                    >
                      <span>解决冲突 / 查看分发</span>
                      <ChevronRight size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Group 3: 断链 / 异常 */}
        <section className="skill-diag-group" aria-labelledby="group-broken-heading">
          <div className="skill-diag-group__header">
            <div className="skill-diag-group__title-row">
              <AlertCircle size={16} className="skill-diag-group__icon is-broken" />
              <h2 id="group-broken-heading" className="skill-diag-group__title">
                {t.skills.diagnosticBrokenGroup}
              </h2>
              <span className="skill-diag-group__count is-broken">{brokenCount}</span>
            </div>
            <span className="skill-diag-group__tag is-broken">需排查修复</span>
          </div>
          <p className="skill-diag-group__desc">{t.skills.diagnosticBrokenDesc}</p>

          {brokenCount === 0 ? (
            <div className="skill-diag-empty-box">暂无断链或异常。所有软链接与目标目录均正常可访问。</div>
          ) : (
            <div className="skill-diag-item-list">
              {brokenItems.map((item) => (
                <div className="skill-diag-item-row is-broken-row" key={item.id}>
                  <div className="skill-diag-item-row__main">
                    <div className="skill-diag-item-row__title-wrap">
                      <AlertCircle size={14} className="skill-diag-item-icon is-broken" />
                      <span className="skill-diag-item-title">{item.title}</span>
                    </div>
                    <p className="skill-diag-item-error-msg">{item.reason}</p>
                    {item.path ? (
                      <div className="skill-diag-item-row__path font-mono" title={item.path}>
                        {item.path}
                      </div>
                    ) : null}
                  </div>
                  {item.skill ? (
                    <div className="skill-diag-item-row__action">
                      <button
                        type="button"
                        className="btn btn--capsule btn--secondary btn--sm"
                        onClick={() => onSelectSkill(item.skill!.id)}
                      >
                        <span>查看该 Skill</span>
                        <ChevronRight size={11} />
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
