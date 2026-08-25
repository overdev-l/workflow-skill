import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@workflow-skill/ui/styles.css'
import './app.css'
import { App } from './App'
import { PermisoOverlayView } from './PermisoOverlay'
import { I18nProvider } from './i18n'

function Root() {
  const [isOverlay, setIsOverlay] = useState(
    typeof window !== 'undefined' && window.location.hash.startsWith('#permiso-overlay'),
  )

  useEffect(() => {
    const handleHash = () => {
      setIsOverlay(window.location.hash.startsWith('#permiso-overlay'))
    }
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  return isOverlay ? <PermisoOverlayView /> : <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <Root />
    </I18nProvider>
  </StrictMode>,
)
