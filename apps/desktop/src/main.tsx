import { StrictMode, useEffect, useState } from 'react'
import { createRoot, type Root as ReactRoot } from 'react-dom/client'
import '@workflow-skill/ui/styles.css'
import './app.css'
import { App } from './App'
import { PermisoOverlayView } from './PermisoOverlay'
import { SkillLinkManagerWindow } from './SkillLinkManagerWindow'
import { I18nProvider } from './i18n'

function Root() {
  const [route, setRoute] = useState<'app' | 'overlay' | 'link-manager'>(() => {
    if (typeof window === 'undefined') return 'app'
    if (window.location.hash.startsWith('#permiso-overlay')) return 'overlay'
    if (window.location.hash.startsWith('#link-manager')) return 'link-manager'
    return 'app'
  })

  useEffect(() => {
    const handleHash = () => {
      if (window.location.hash.startsWith('#permiso-overlay')) {
        setRoute('overlay')
      } else if (window.location.hash.startsWith('#link-manager')) {
        setRoute('link-manager')
      } else {
        setRoute('app')
      }
    }
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  if (route === 'overlay') return <PermisoOverlayView />
  if (route === 'link-manager') return <SkillLinkManagerWindow />
  return <App />
}

const rootElement = document.getElementById('root')!
const hotData = import.meta.hot?.data as { reactRoot?: ReactRoot } | undefined
const reactRoot = hotData?.reactRoot ?? createRoot(rootElement)
if (import.meta.hot) import.meta.hot.data.reactRoot = reactRoot

reactRoot.render(
  <StrictMode>
    <I18nProvider>
      <Root />
    </I18nProvider>
  </StrictMode>,
)
