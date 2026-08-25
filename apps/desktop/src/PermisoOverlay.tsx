import { useEffect, useState, useCallback } from 'react'
import { ArrowUp, ChevronLeft, Check } from 'lucide-react'
import { useI18n } from './i18n'
import type { RecorderStatus } from '@workflow-skill/capture-protocol'

export function PermisoOverlayView() {
  const { resolvedLocale } = useI18n()
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>()
  const [grantedSuccess, setGrantedSuccess] = useState(false)
  const hash = typeof window !== 'undefined' ? window.location.hash : ''
  const isScreenRecording = hash.includes('type=screenRecording')

  const isGranted = Boolean(isScreenRecording
    ? recorderStatus?.permissions.screenRecording
    : recorderStatus?.permissions.accessibility)

  const handleClose = useCallback(() => {
    if (window.workflowSkill?.closePermisoOverlay) {
      void window.workflowSkill.closePermisoOverlay()
    } else {
      window.close()
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleClose])

  useEffect(() => {
    const api = window.workflowSkill
    if (!api) return

    let active = true
    const checkStatus = async () => {
      try {
        const cached = await api.getRecorderStatus()
        if (active) setRecorderStatus(cached)
        await api.sendRecorderCommand({ type: 'status' })
      } catch {
        // ignore
      }
    }

    void checkStatus()
    const timer = window.setInterval(checkStatus, 400)

    const unsubscribe = api.onRecorderMessage((envelope) => {
      if (envelope.type === 'status') {
        setRecorderStatus(envelope.payload)
      }
    })

    return () => {
      active = false
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!isGranted) return
    setGrantedSuccess(true)
    const timer = window.setTimeout(() => {
      handleClose()
    }, 650)
    return () => window.clearTimeout(timer)
  }, [isGranted, handleClose])

  const handleStartDrag = (e: React.DragEvent) => {
    e.preventDefault()
    if (window.workflowSkill?.startDragApp) {
      window.workflowSkill.startDragApp()
    }
  }

  const isZh = resolvedLocale === 'zh-CN'
  const titleText = grantedSuccess
    ? isZh
      ? '权限已开启，Trace 可以继续观察'
      : 'Permission granted. Trace can continue observing.'
    : isZh
      ? isScreenRecording
        ? '拖拽 Trace 到上方列表中以允许屏幕录制'
        : '拖拽 Trace 到上方列表中以允许辅助功能'
      : isScreenRecording
        ? 'Drag Trace to the list above to allow Screen Recording'
        : 'Drag Trace to the list above to allow Accessibility'

  return (
    <div className="permiso-panel-shell">
      {/* Row 1: Up Arrow + Instructional Title */}
      <div className="permiso-top-header">
        <div className={`permiso-arrow-box ${grantedSuccess ? 'is-granted' : ''}`}>
          {grantedSuccess ? (
            <Check size={22} className="permiso-granted-check" />
          ) : (
            <ArrowUp size={24} className="permiso-up-arrow" />
          )}
        </div>
        <span className="permiso-instruction-label">{titleText}</span>
      </div>

      {/* Row 2: Back Button + Draggable App Row (AppDragSourceView) */}
      <div className="permiso-bottom-row">
        <button
          type="button"
          className="permiso-nav-back"
          onClick={handleClose}
          aria-label="Back"
          title="返回"
        >
          <ChevronLeft size={16} />
        </button>

        <div
          className="permiso-app-drag-row"
          draggable
          onDragStart={handleStartDrag}
          title="按住并向上拖拽至上方列表中"
        >
          <div className="permiso-app-icon-plate">
            <img
              src="/trace-spirit-icon.png"
              alt="Trace"
              className="permiso-app-native-icon"
              draggable={false}
            />
          </div>
          <span className="permiso-app-native-title font-mono">Trace</span>
        </div>
      </div>
    </div>
  )
}
