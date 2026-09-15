import { useCallback, useEffect, useRef, useState } from 'react'
import { Folder, Plus, RefreshCw } from 'lucide-react'
import type { ManagedProjectRecord, ProjectRecord } from '@workflow-skill/workflow-model'
import { useI18n } from '../i18n'
import './ProjectsThreeColumn.css'

export function ProjectsThreeColumn({ notify }: { notify?: (message: string) => void }) {
  const { t, resolvedLocale } = useI18n()
  const [projects, setProjects] = useState<ManagedProjectRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [active, setActive] = useState<ProjectRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<ManagedProjectRecord | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const removeTrigger = useRef<HTMLButtonElement>(null)
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const version = ++request.current
    setLoading(true)
    try {
      const api = window.workflowSkill
      if (!api?.listManagedProjects || !api.getActiveProject) throw new Error(t.projects.apiUnavailable)
      const [list, current] = await Promise.all([api.listManagedProjects(), api.getActiveProject()])
      if (request.current !== version) return
      setProjects(list)
      setActive(current)
      setSelectedId(id => list.some(p => p.id === id) ? id : list[0]?.id ?? null)
      setError('')
    } catch (err) {
      if (request.current === version) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (request.current === version) setLoading(false)
    }
  }, [t.projects.apiUnavailable])
  useEffect(() => {
    void refresh()
    const unsubscribe = window.workflowSkill?.onProjectsChanged?.(() => void refresh())
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => { ++request.current; unsubscribe?.(); window.removeEventListener('focus', onFocus) }
  }, [refresh])
  useEffect(() => {
    if (removeTarget && dialog.current && !dialog.current.open) {
      dialog.current.showModal()
      return () => removeTrigger.current?.focus()
    }
  }, [removeTarget])

  const selected = projects.find(p => p.id === selectedId)
  const isActive = selected && (selected.id === active?.id || selected.path === active?.path)
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try { await action() } catch (err) { notify?.(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const add = () => void run(async () => {
    const result = await window.workflowSkill?.addProject?.()
    if (!result) throw new Error(t.projects.apiUnavailable)
    if (!result.success) {
      if (result.error === '用户取消了选择') return
      throw new Error(result.error || t.projects.actionFailed)
    }
    await refresh()
    if (result.project) {
      setSelectedId(result.project.id)
      notify?.(t.projects.addSuccessToast(result.project.name))
    }
  })
  const activate = () => void run(async () => {
    if (!selected || selected.status !== 'valid') return
    const result = await window.workflowSkill?.setActiveProject?.(selected.id)
    if (!result?.success) throw new Error(result?.error || t.projects.actionFailed)
    await refresh()
    notify?.(t.projects.setActiveSuccessToast(selected.name))
  })
  const remove = () => void run(async () => {
    if (!removeTarget) return
    const result = await window.workflowSkill?.removeProject?.(removeTarget.id)
    if (!result?.success) throw new Error(result?.error || t.projects.actionFailed)
    setRemoveTarget(null)
    await refresh()
    notify?.(t.projects.removeSuccessToast)
  })

  return <>
    <aside className="app-col-master projects-master" aria-label={t.projects.title}>
      <div className="projects-list-header">
        <strong>{t.projects.masterTitle}</strong>
        <button type="button" className="btn btn--sm btn--primary" onClick={add} disabled={busy} aria-label={t.projects.addProjectBtn} title={t.projects.addProjectBtn}><Plus size={13} /></button>
      </div>
      <div className="projects-list" aria-busy={loading}>
        {loading && projects.length === 0 ? <p className="projects-hint">{t.projects.loading}</p> : null}
        {!loading && !error && projects.length === 0 ? <p className="projects-hint">{t.projects.emptyTitle}</p> : null}
        {error ? <div className="projects-load-error" role="alert"><p>{error}</p><button type="button" className="btn btn--sm" onClick={() => void refresh()}>{t.projects.retry}</button></div> : null}
        {projects.map(project => <button type="button" key={project.id} className={`master-item-row ${project.id === selectedId ? 'is-selected' : ''}`} aria-current={project.id === selectedId ? 'true' : undefined} onClick={() => setSelectedId(project.id)}>
          <Folder size={15} aria-hidden="true" />
          <span className="master-item-content"><span className="master-item-title">{project.name}</span><span className="master-item-sub" title={project.path}>{project.path}</span>{project.status !== 'valid' ? <span className="projects-invalid">{t.projects.statusInvalid}</span> : null}</span>
        </button>)}
      </div>
    </aside>
    <section className="app-col-detail view-enter" aria-label={selected?.name || t.projects.title}>
      <div className="detail-stage-wrap projects-detail">
        {!selected ? <div className="projects-empty"><h1>{t.projects.title}</h1><p>{loading ? t.projects.loading : t.projects.emptyDetailDesc}</p></div> : <>
          <header className="projects-header"><h1>{selected.name}</h1><button type="button" className="btn btn--sm" onClick={() => void refresh()} disabled={loading || busy} title={t.projects.refresh} aria-label={t.projects.refresh}><RefreshCw size={13} /></button></header>
          <p className="projects-path">{selected.path}</p>
          <p className={`projects-status ${selected.status !== 'valid' ? 'projects-invalid' : ''}`}>{selected.status === 'valid' ? (isActive ? t.projects.activeBadge : t.projects.statusValid) : t.projects.invalidDesc}</p>
          <div className="projects-actions">
            {selected.status === 'valid' && !isActive ? <button type="button" className="btn btn--primary" onClick={activate} disabled={busy}>{t.projects.setActiveBtn}</button> : null}
            {selected.status === 'valid' ? <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void run(async () => { const api = window.workflowSkill; if (!api?.openPathInFinder) throw new Error(t.projects.apiUnavailable); await api.openPathInFinder(selected.path) })}>{t.projects.openInFinderBtn}</button> : null}
            <button type="button" ref={removeTrigger} className="btn btn--secondary" onClick={() => setRemoveTarget(selected)} disabled={busy}>{t.projects.removeBtn}</button>
          </div>
          <p className="projects-added">{t.projects.metaAddedAt} · {new Date(selected.addedAt).toLocaleDateString(resolvedLocale)}</p>
        </>}
      </div>
    </section>
    {removeTarget ? <dialog ref={dialog} className="projects-confirm" aria-labelledby="project-remove-title" aria-describedby="project-remove-desc" onCancel={e => { if (busy) e.preventDefault(); else setRemoveTarget(null) }} onClose={() => { if (!busy) setRemoveTarget(null) }}>
      <h2 id="project-remove-title">{t.projects.removeDialogTitle}</h2>
      <p id="project-remove-desc">{t.projects.removeDialogDesc}</p>
      <p className="projects-path">{removeTarget.path}</p>
      <div className="projects-actions"><button type="button" className="btn btn--secondary" autoFocus disabled={busy} onClick={() => setRemoveTarget(null)}>{t.projects.cancelBtn}</button><button type="button" className="btn btn--danger" disabled={busy} onClick={remove}>{t.projects.removeConfirmBtn}</button></div>
    </dialog> : null}
  </>
}
