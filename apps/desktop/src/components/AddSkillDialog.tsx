import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  communityRemoteSkills,
  type RemoteSkill,
  type RepositorySkillSearchResult,
  type RepositorySkillSummary,
} from '@workflow-skill/workflow-model'
import './AddSkillDialog.css'

export interface AddSkillDialogProps {
  open: boolean
  targetLabel: string
  disabledReason?: string
  onClose: () => void
  onAdd: (remote: RemoteSkill) => Promise<void>
  onCreate: () => void
}

const REPO_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"

export function AddSkillDialog({
  open,
  targetLabel,
  disabledReason,
  onClose,
  onAdd,
  onCreate,
}: AddSkillDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const searchVersion = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const addingRef = useRef(false)
  const titleId = useId()

  const [query, setQuery] = useState('')
  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    () => communityRemoteSkills[0]?.id ?? ''
  )
  const [repoResult, setRepoResult] = useState<RepositorySkillSearchResult | null>(null)
  const [selectedRepoSkill, setSelectedRepoSkill] = useState<RepositorySkillSummary | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')
  const [copyFeedback, setCopyFeedback] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || !open) return
    previousFocus.current = document.activeElement as HTMLElement | null
    if (!dialog.open) dialog.showModal()
    searchRef.current?.focus()
    setAddError('')
    setSearchError('')
    setCopyFeedback('')
    setSearching(false)
    return () => {
      searchVersion.current += 1
      dialog.close()
      previousFocus.current?.focus()
    }
  }, [open])

  const changeQuery = (value: string) => {
    searchVersion.current += 1
    setQuery(value)
    setSearching(false)
    setSearchError('')
    setRepoResult(null)
    setSelectedRepoSkill(null)
    setCopyFeedback('')
  }

  const filteredPresets = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return communityRemoteSkills
    return communityRemoteSkills.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.author.toLowerCase().includes(q) ||
        item.tags?.some((t) => t.toLowerCase().includes(q))
    )
  }, [query])

  const selectedPreset = useMemo(() => {
    return filteredPresets.find((p) => p.id === selectedPresetId) ?? filteredPresets[0] ?? null
  }, [filteredPresets, selectedPresetId])

  const isRepoCandidate = REPO_PATTERN.test(query.trim())

  const handleSearchRepo = async () => {
    const target = query.trim()
    if (!REPO_PATTERN.test(target) || addingRef.current || searching) return
    const version = ++searchVersion.current
    setSearching(true)
    setSearchError('')
    setRepoResult(null)
    setSelectedRepoSkill(null)
    setCopyFeedback('')

    try {
      const api = window.workflowSkill?.searchRepositorySkills
      if (!api) throw new Error('仓库搜索服务不可用')
      const res = await api(target)
      if (searchVersion.current !== version) return
      setRepoResult(res)
      if (res.skills && res.skills.length > 0) {
        setSelectedRepoSkill(res.skills[0])
      }
    } catch (err) {
      if (searchVersion.current !== version) return
      setSearchError(err instanceof Error ? err.message : String(err))
    } finally {
      if (searchVersion.current === version) setSearching(false)
    }
  }

  const handleAddPreset = async () => {
    if (!selectedPreset || addingRef.current || disabledReason || !open) return
    addingRef.current = true
    setAdding(true)
    setAddError('')
    try {
      await onAdd(selectedPreset)
      onClose()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : '添加失败，请重试')
    } finally {
      addingRef.current = false
      setAdding(false)
    }
  }

  const handleCopyCommand = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopyFeedback('已复制')

    } catch {
      setCopyFeedback('复制失败')
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="add-skill-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault()
        if (!addingRef.current) onClose()
      }}
    >
      <header className="add-skill-dialog__header">
        <div className="add-skill-dialog__titles">
          <h2 id={titleId} className="add-skill-dialog__title">添加 Skill</h2>
          <span className="add-skill-dialog__target-label" title={targetLabel}>
            目标：{targetLabel}
          </span>
        </div>
        <div className="add-skill-dialog__header-actions">
          <button
            type="button"
            className="btn btn--sm btn--capsule btn--secondary"
            onClick={onCreate}
            disabled={adding || Boolean(disabledReason)}
            title={disabledReason}
          >
            新建空白 Skill
          </button>
          <button
            type="button"
            className="btn btn--sm btn--capsule btn--secondary add-skill-dialog__close"
            onClick={onClose}
            disabled={adding}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
      </header>

      <section className="add-skill-dialog__search-row">
        <input
          ref={searchRef}
          aria-label="搜索示例或仓库"
          type="text"
          className="add-skill-dialog__input"
          placeholder="搜索预置示例，或输入 owner/repo 搜索仓库..."
          value={query}
          onChange={(e) => changeQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isRepoCandidate && !searching) {
              e.preventDefault()
              void handleSearchRepo()
            }
          }}
          disabled={adding}
        />
        <button
          type="button"
          className="btn btn--sm btn--capsule btn--secondary"
          onClick={() => void handleSearchRepo()}
          disabled={adding || searching || !isRepoCandidate}
          title={isRepoCandidate ? '检索 GitHub 仓库技能' : '请输入 owner/repo 格式搜索仓库'}
        >
          {searching ? '搜索中...' : '搜索仓库'}
        </button>
      </section>

      {searchError && (
        <div className="add-skill-dialog__banner add-skill-dialog__banner--error" role="alert">
          {searchError}
        </div>
      )}

      <div className="add-skill-dialog__body">
        <aside className="add-skill-dialog__column add-skill-dialog__column--list">
          {repoResult ? (
            <div className="add-skill-dialog__section-wrap">
              <div className="add-skill-dialog__section-title">
                仓库技能
              </div>
              <div className="add-skill-dialog__list">
                {repoResult.skills.map((skill) => {
                  const active = selectedRepoSkill?.name === skill.name
                  return (
                    <button
                      key={skill.name}
                      type="button"
                      className={`add-skill-dialog__item ${active ? 'is-active' : ''}`}
                      disabled={adding}
                      aria-pressed={active}
                      onClick={() => {
                        setSelectedRepoSkill(skill)
                        setCopyFeedback('')
                      }}
                    >
                      <div className="add-skill-dialog__item-name">{skill.name}</div>
                      {skill.description && (
                        <div className="add-skill-dialog__item-sub">{skill.description}</div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="add-skill-dialog__section-wrap">
              <div className="add-skill-dialog__section-title">预置示例</div>
              <div className="add-skill-dialog__list">
                {filteredPresets.length === 0 ? (
                  <div className="add-skill-dialog__empty">未匹配到预置示例</div>
                ) : (
                  filteredPresets.map((preset) => {
                    const active = selectedPreset?.id === preset.id
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={`add-skill-dialog__item ${active ? 'is-active' : ''}`}
                        disabled={adding}
                        aria-pressed={active}
                        onClick={() => setSelectedPresetId(preset.id)}
                      >
                        <div className="add-skill-dialog__item-name">{preset.name}</div>
                        <div className="add-skill-dialog__item-sub">{preset.author}</div>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </aside>

        <section className="add-skill-dialog__column add-skill-dialog__column--preview">
          {repoResult ? (
            selectedRepoSkill ? (
              <div className="add-skill-dialog__preview">
                <div className="add-skill-dialog__preview-header">
                  <h3>{selectedRepoSkill.name}</h3>
                  <p className="add-skill-dialog__preview-desc">
                    {selectedRepoSkill.description || '无详细描述'}
                  </p>
                </div>
                <div className="add-skill-dialog__repo-callout">
                  <p className="add-skill-dialog__callout-warning">
                    仓库技能尚不支持应用内安装
                  </p>
                  <p className="add-skill-dialog__callout-hint">
                    复制命令后需自行确认执行目录与安装范围；此操作不会添加到当前目标。
                  </p>
                  <div className="add-skill-dialog__command-bar">
                    <code>
                      npx skills add {shellQuote(repoResult.repository)} --skill {shellQuote(selectedRepoSkill.name)}
                    </code>
                    <button
                      type="button"
                      className="btn btn--sm btn--capsule btn--secondary"
                      onClick={() =>
                        void handleCopyCommand(
                          `npx skills add ${shellQuote(repoResult.repository)} --skill ${shellQuote(selectedRepoSkill.name)}`
                        )
                      }
                    >
                      {copyFeedback || '复制命令'}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="add-skill-dialog__empty">{repoResult.skills.length ? '请选择仓库技能' : '仓库中未找到 Skill'}</div>
            )
          ) : selectedPreset ? (
            <div className="add-skill-dialog__preview">
              <div className="add-skill-dialog__preview-header">
                <h3>{selectedPreset.name}</h3>
                <p className="add-skill-dialog__preview-desc">{selectedPreset.description}</p>
                <div className="add-skill-dialog__meta-row">
                  <span>作者：{selectedPreset.author}</span>
                  {selectedPreset.tags?.length > 0 && (
                    <span>标签：{selectedPreset.tags.join(', ')}</span>
                  )}
                </div>
              </div>
              <pre className="add-skill-dialog__markdown-pre">
                <code>{selectedPreset.skillMarkdown}</code>
              </pre>
            </div>
          ) : (
            <div className="add-skill-dialog__empty">请选择预置示例</div>
          )}
        </section>
      </div>

      {addError && (
        <div className="add-skill-dialog__banner add-skill-dialog__banner--error" role="alert">
          {addError}
        </div>
      )}

      <footer className="add-skill-dialog__footer">
        <div className="add-skill-dialog__footer-hint">
          {disabledReason ? <span className="add-skill-dialog__warn">{disabledReason}</span> : null}
        </div>
        <div className="add-skill-dialog__footer-actions">
          <button
            type="button"
            className="btn btn--capsule btn--secondary"
            onClick={onClose}
            disabled={adding}
          >
            取消
          </button>
          {!repoResult && (
            <button
              type="button"
              className="btn btn--capsule btn--primary"
              onClick={() => void handleAddPreset()}
              disabled={adding || !selectedPreset || Boolean(disabledReason)}
              title={disabledReason}
            >
              {adding ? '添加中...' : '添加示例'}
            </button>
          )}
        </div>
      </footer>
    </dialog>
  )
}
