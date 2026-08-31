export type RecorderPlatform = 'macos' | 'windows'
export type RecorderState = 'idle' | 'observing' | 'paused' | 'interrupted'
export type CaptureScenario = 'desktop' | 'browser'
export type CaptureEventSource = 'desktop' | 'browser-dom' | 'browser-network'

export interface RecorderPermissions {
  screenRecording: boolean
  accessibility: boolean
}

export interface CapturePoint {
  x: number
  y: number
}

export interface CaptureBounds extends CapturePoint {
  width: number
  height: number
}

export interface SemanticTarget {
  role?: string
  subrole?: string
  identifier?: string
  labelHash?: string
  windowTitleHash?: string
  bounds?: CaptureBounds
}

export interface BrowserPageContext {
  url: string
  title?: string
  titleHash?: string
  frameId?: string
}

export type NetworkCapturePhase = 'request' | 'response'

export interface NetworkCapture {
  phase: NetworkCapturePhase
  requestId: string
  method: string
  url: string
  resourceType?: string
  documentUrl?: string
  initiatorType?: string
  initiatorEventId?: string
  headers: Record<string, string>
  postData?: string
  status?: number
  statusText?: string
  mimeType?: string
  fromDiskCache?: boolean
  fromServiceWorker?: boolean
}

export interface CaptureEvent {
  id: string
  occurredAt: string
  sessionId: string
  applicationId?: string
  applicationName?: string
  eventType: string
  pointer?: CapturePoint
  keyCode?: number
  modifiers?: number
  target?: SemanticTarget
  source?: CaptureEventSource
  page?: BrowserPageContext
  network?: NetworkCapture
  attributes: Record<string, string>
}

export interface FrameSample {
  frameNumber: number
  width: number
  height: number
  displayId?: number
  contentRect?: CaptureBounds
}

export interface RecorderStatus {
  protocolVersion: 1
  recorderVersion: string
  platform: RecorderPlatform
  state: RecorderState
  sessionId?: string
  activeApplication?: string
  eventCount: number
  frameCount: number
  recordedBytes: number
  permissions: RecorderPermissions
  timestamp: string
}

export type RecorderCommand =
  | { type: 'start'; sessionId: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'status' }
  | {
      type: 'permissions'
      prompt?: boolean
      permissionTarget?: 'accessibility' | 'screenRecording'
    }
  | {
      type: 'policy'
      excludedBundleIds: string[]
      excludedWindowTitlePatterns: string[]
    }

export interface RecorderError {
  code: string
  message: string
  recoverable: boolean
}

export type BrowserCaptureState = 'idle' | 'capturing' | 'interrupted'

export interface BrowserCaptureStatus {
  protocolVersion: 1
  scenario: 'browser'
  state: BrowserCaptureState
  sessionId?: string
  pageUrl?: string
  pageTitle?: string
  eventCount: number
  requestCount: number
  timestamp: string
}

export type BrowserCaptureCommand =
  | { type: 'start'; sessionId: string; url: string }
  | { type: 'stop' }
  | { type: 'status' }

export type BrowserCaptureEnvelope =
  | { protocolVersion: 1; type: 'status'; timestamp: string; payload: BrowserCaptureStatus }
  | { protocolVersion: 1; type: 'capture-event'; timestamp: string; payload: CaptureEvent }
  | { protocolVersion: 1; type: 'error'; timestamp: string; payload: RecorderError }

export type RecorderEnvelope =
  | { protocolVersion: 1; type: 'status'; timestamp: string; payload: RecorderStatus }
  | { protocolVersion: 1; type: 'permissions'; timestamp: string; payload: RecorderPermissions }
  | { protocolVersion: 1; type: 'capture-event'; timestamp: string; payload: CaptureEvent }
  | { protocolVersion: 1; type: 'frame-sample'; timestamp: string; payload: FrameSample }
  | { protocolVersion: 1; type: 'error'; timestamp: string; payload: RecorderError }
