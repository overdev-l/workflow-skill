import React from 'react'
import {
  Antigravity,
  Claude,
  ClaudeCode,
  Cline,
  Codex,
  Cursor,
  Gemini,
  GithubCopilot,
  LobeHub,
  OpenAI,
  OpenCode,
  RooCode,
  Trae,
  Windsurf,
} from '@lobehub/icons'
import { FolderTree, Terminal } from 'lucide-react'

export function AIToolLogo({
  toolId,
  size = 18,
  color = true,
  className,
}: {
  toolId: string
  size?: number
  color?: boolean
  className?: string
}) {
  const normalized = (toolId || '').toLowerCase()

  if (normalized.includes('claude')) {
    return color ? <Claude.Color size={size} className={className} /> : <Claude size={size} className={className} />
  }

  if (normalized.includes('antigravity') || normalized.includes('gemini')) {
    return color ? <Gemini.Color size={size} className={className} /> : <Gemini size={size} className={className} />
  }

  if (normalized.includes('cursor')) {
    return color ? <Cursor.Color size={size} className={className} /> : <Cursor size={size} className={className} />
  }

  if (normalized.includes('windsurf')) {
    return color ? <Windsurf.Color size={size} className={className} /> : <Windsurf size={size} className={className} />
  }

  if (normalized.includes('trae')) {
    return color ? <Trae.Color size={size} className={className} /> : <Trae size={size} className={className} />
  }

  if (normalized.includes('cline')) {
    return color ? <Cline.Color size={size} className={className} /> : <Cline size={size} className={className} />
  }

  if (normalized.includes('roo')) {
    return color ? <RooCode.Color size={size} className={className} /> : <RooCode size={size} className={className} />
  }

  if (normalized.includes('codex') || normalized.includes('openai')) {
    return color ? <OpenAI.Color size={size} className={className} /> : <OpenAI size={size} className={className} />
  }

  if (normalized.includes('copilot')) {
    return color ? <GithubCopilot.Color size={size} className={className} /> : <GithubCopilot size={size} className={className} />
  }

  if (normalized.includes('opencode')) {
    return color ? <OpenCode.Color size={size} className={className} /> : <OpenCode size={size} className={className} />
  }

  if (normalized.includes('agents')) {
    return color ? <LobeHub.Color size={size} className={className} /> : <LobeHub size={size} className={className} />
  }

  return color ? <LobeHub.Color size={size} className={className} /> : <LobeHub size={size} className={className} />
}
