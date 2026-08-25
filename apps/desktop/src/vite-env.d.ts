/// <reference types="vite/client" />

import type { RecorderCommand, RecorderEnvelope, RecorderStatus } from '@workflow-skill/capture-protocol'

declare global {
  interface Window {
    workflowSkill?: {
      getSystemTheme: () => Promise<'light' | 'dark'>
      setTheme?: (theme: 'dark' | 'light' | 'system') => Promise<'light' | 'dark'>
      getRecorderStatus: () => Promise<RecorderStatus>
      sendRecorderCommand: (command: RecorderCommand) => Promise<RecorderStatus>
      openPrivacySettings?: (type: 'accessibility' | 'screenRecording', sourceFrame?: { x: number; y: number; width: number; height: number }) => Promise<void>
      locateAppInFinder?: () => Promise<void>
      centerWindow?: () => Promise<void>
      closePermisoOverlay?: () => Promise<void>
      startDragApp?: () => void
      onRecorderMessage: (listener: (message: RecorderEnvelope) => void) => () => void
    }
  }
}

export {}
