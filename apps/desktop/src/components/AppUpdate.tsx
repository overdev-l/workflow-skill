import { useEffect, useLayoutEffect, useState } from 'react'
import { Download, LoaderCircle, RefreshCw } from 'lucide-react'
import type { AppUpdateState } from '@workflow-skill/workflow-model/updates'
import { useI18n } from '../i18n'
import '../updates.css'

export function useUpdateBlocker(key: string, dirty: boolean) {
  useLayoutEffect(() => {
    void window.workflowSkill?.setUpdateBlocker?.(key, dirty).catch(() => {})
    return () => { void window.workflowSkill?.setUpdateBlocker?.(key, false).catch(() => {}) }
  }, [key, dirty])
}

export function AppUpdate({ compact = false }: { compact?: boolean }) {
  const { resolvedLocale } = useI18n()
  const zh = resolvedLocale === 'zh-CN'
  const [state, setState] = useState<AppUpdateState>()
  const [error, setError] = useState('')
  const api = window.workflowSkill?.updates
  useEffect(() => {
    if (!api) return
    let alive = true
    let receivedEvent = false
    const accept = (value: AppUpdateState) => { receivedEvent = true; if (alive) setState(value) }
    const dispose = api.onChanged(accept)
    void api.getState().then(value => { if (alive && !receivedEvent) setState(value) }).catch(() => {})
    return () => { alive = false; dispose() }
  }, [api])
  const texts = zh
    ? { disabled: '此构建未启用更新', idle: '检查是否有新版本', checking: '正在检查更新…', upToDate: '已是最新版本', available: '发现新版本', downloading: '正在下载', downloaded: '更新已准备好', error: '更新失败，可重试' }
    : { disabled: 'Updates unavailable in this build', idle: 'Check for a newer version', checking: 'Checking for updates…', upToDate: 'You are up to date', available: 'Update available', downloading: 'Downloading', downloaded: 'Ready to install', error: 'Update failed; try again' }
  const status = state?.status ?? 'disabled'
  const progress = Math.round(state?.percent ?? 0)
  const busy = status === 'checking' || status === 'downloading'
  const actionable = status === 'downloaded' || status === 'available' || (status === 'error' && state?.availableVersion)
  const label = status === 'downloaded' ? (zh ? '重启并安装' : 'Restart and install')
    : status === 'downloading' ? `${progress}%`
    : actionable ? (zh ? '下载更新' : 'Download update') : (zh ? '检查更新' : 'Check for updates')
  const invoke = async () => {
    if (!api || busy) return
    setError('')
    try {
      const result = status === 'downloaded' ? await api.install() : actionable ? await api.download() : await api.check()
      setState(result)
    } catch (reason) { setError(reason instanceof Error ? reason.message : (zh ? '操作未完成' : 'Action failed')) }
  }
  if (compact && !actionable && status !== 'downloading') return null
  const Icon = busy ? LoaderCircle : status === 'downloaded' ? RefreshCw : Download
  return <div className={compact ? 'update-sidebar' : 'flat-settings-card app-update-card'}>
    {!compact && <div><strong>{zh ? '软件更新' : 'Software updates'}</strong><p>{zh ? '当前版本' : 'Current version'} {state?.currentVersion ?? '—'}{state?.availableVersion && ` → ${state.availableVersion}`}{state?.simulated && (zh ? ' · 模拟更新' : ' · Simulation')}</p></div>}
    <button type="button" className={compact ? 'nav-pill-btn update-action' : `btn btn--capsule ${actionable ? 'btn--primary' : ''} update-action`} onClick={() => { void invoke() }} disabled={busy || status === 'disabled'} title={texts[status]}>
      {status === 'downloading' && <span className="update-fill" style={{ width: `${progress}%` }} />}
      <Icon size={14} className={busy ? 'update-spinner' : ''} /><span>{state?.simulated && compact ? (zh ? '模拟 · ' : 'Demo · ') : ''}{label}</span>
    </button>
    {!compact && <p role="status">{texts[status]}{status === 'downloading' && ` · ${progress}%`}{state?.simulated && (zh ? '，不会安装或退出应用' : '; does not install or quit')}</p>}
    {(error || state?.error) && <p role="alert" className="update-error">{error || state?.error}</p>}
  </div>
}
