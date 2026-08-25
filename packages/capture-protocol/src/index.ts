export type RecorderPlatform = 'macos' | 'windows'
export type RecorderState = 'idle' | 'observing' | 'paused' | 'interrupted'

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

export type RecorderEnvelope =
  | { protocolVersion: 1; type: 'status'; timestamp: string; payload: RecorderStatus }
  | { protocolVersion: 1; type: 'permissions'; timestamp: string; payload: RecorderPermissions }
  | { protocolVersion: 1; type: 'capture-event'; timestamp: string; payload: CaptureEvent }
  | { protocolVersion: 1; type: 'frame-sample'; timestamp: string; payload: FrameSample }
  | { protocolVersion: 1; type: 'error'; timestamp: string; payload: RecorderError }
