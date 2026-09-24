import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'
import {
  DEFAULT_AI_TOOLS,
  MCP_SOURCE_TOOLS,
  ONBOARDING_GLOBAL_SKILL_SOURCE_TOOL_IDS,
  type CentralMCPServer,
  type MCPScope,
  type MCPServerDefinition,
  type MCPSourceTool,
  type MCPTargetAssociation,
  type McpSecretRef,
  type OnboardingMcpCandidate,
  type OnboardingMcpMigrationResult,
  type OnboardingSkillCandidate,
  type OnboardingSkillMigrationRequest,
  type OnboardingSkillMigrationResult,
  type SkillAdoptionPlanItem,
} from '@workflow-skill/workflow-model'
import {
  loadCentralMCPRegistry,
  readMCPServersForTool,
  resolveMCPConfigPath,
  saveCentralMCPRegistry,
  type MCPOptions,
} from './mcp-manager.ts'
import { deleteMcpSecret, storeMcpSecret } from './mcp-secret-store.ts'
import { SUPPORTED_PROJECT_SKILL_PATHS } from './project-manager.ts'
import {
  adoptSkillAsset,
  buildSkillAdoptionPlan,
  getAIToolDirectory,
  getEffectiveHomeDir,
  getEffectiveTraceHome,
  isPathInside,
  normalizeSkillId,
  readExistingCentralHash,
  resolveSkillConflict,
  tryGetSkillDirectoryFingerprint,
  type AdoptSkillTarget,
  type SkillInjectionOptions,
} from './skill-injection-manager.ts'

export type {
  OnboardingSkillCandidate,
  OnboardingSkillMigrationRequest,
  OnboardingSkillMigrationResult,
  OnboardingMcpCandidate,
  OnboardingMcpMigrationResult,
}

const GLOBAL_SOURCE_LABELS: Record<string, string> = {
  'agents-global': 'agents',
  'codex-global': 'codex',
  'claude-global': 'claude',
}

/**
 * Check if a given path is already a symlink pointing to a central library Skill.
 */
export function isSkillAlreadyLinked(targetPath: string, customTraceHome?: string): boolean {
  const traceHome = getEffectiveTraceHome(customTraceHome)
  const centralSkillsDir = path.join(traceHome, 'skills')
  try {
    const stat = lstatSync(targetPath)
    if (!stat.isSymbolicLink()) return false
    const linkDest = realpathSync(targetPath)
    return isPathInside(centralSkillsDir, linkDest)
  } catch {
    return false
  }
}

/**
 * Extract human-readable display name from SKILL.md or central metadata record.
 */
function getSkillDisplayName(canonicalPath: string, fallbackName: string, centralSkillsDir?: string): string {
  if (centralSkillsDir && isPathInside(centralSkillsDir, canonicalPath)) {
    const rel = path.relative(centralSkillsDir, canonicalPath)
    const centralId = rel.split(path.sep)[0]
    const jsonPath = path.join(centralSkillsDir, `${centralId}.json`)
    try {
      if (existsSync(jsonPath)) {
        const data = JSON.parse(readFileSync(jsonPath, 'utf8'))
        if (data?.name && typeof data.name === 'string' && data.name.trim()) {
          return data.name.trim()
        }
      }
    } catch {}
  }

  try {
    const mdPath = path.join(canonicalPath, 'SKILL.md')
    if (existsSync(mdPath)) {
      const skillMdContent = readFileSync(mdPath, 'utf8')
      const frontmatter = skillMdContent.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
      if (frontmatter) {
        try {
          const doc = parseDocument(frontmatter[1])
          const parsed = doc.toJS()
          if (parsed && typeof parsed === 'object' && typeof (parsed as any).name === 'string') {
            const name = (parsed as any).name.trim()
            if (name) return name
          }
        } catch {}
      }
      const h1 = skillMdContent.match(/^#\s+(.+)$/m)
      if (h1 && h1[1].trim()) {
        return h1[1].trim()
      }
    }
  } catch {}

  return fallbackName
}

interface ResolvedTargetDescriptor {
  type: 'global' | 'project'
  toolId?: string
  projectPath?: string
  relPath?: string
  skillId: string
  targetPath: string
}

/**
 * Map an arbitrary absolute path to a structured AdoptSkillTarget descriptor
 * by matching against supported global AI tools and project relative skill directories.
 */
function resolveTargetFromAbsolutePath(
  absolutePath: string,
  options?: SkillInjectionOptions
): ResolvedTargetDescriptor | null {
  const targetPath = path.resolve(absolutePath)
  const skillId = path.basename(targetPath)
  const parentDir = path.dirname(targetPath)

  // 1. Match against global AI tools
  for (const tool of DEFAULT_AI_TOOLS.filter((t) => t.scope === 'global')) {
    const toolDir = getAIToolDirectory(tool, options)
    if (toolDir && path.resolve(toolDir) === parentDir) {
      return {
        type: 'global',
        toolId: tool.id,
        skillId,
        targetPath,
      }
    }
  }

  // 2. Match against supported project skill paths
  for (const supported of SUPPORTED_PROJECT_SKILL_PATHS) {
    const normRel = path.normalize(supported.relPath)
    const parts = normRel.split(path.sep)
    const parentParts = parentDir.split(path.sep)
    if (parentParts.length > parts.length) {
      const endsWithRel = parts.every(
        (part, idx) => parentParts[parentParts.length - parts.length + idx] === part
      )
      if (endsWithRel) {
        const projectPath = parentParts.slice(0, parentParts.length - parts.length).join(path.sep) || path.sep
        if (path.resolve(projectPath, supported.relPath, skillId) === targetPath) {
          return {
            type: 'project',
            projectPath,
            relPath: supported.relPath,
            skillId,
            targetPath,
          }
        }
      }
    }
  }

  return null
}

/**
 * Scan global Skill candidates for onboarding.
 * Only scans the three sources in ONBOARDING_GLOBAL_SKILL_SOURCE_TOOL_IDS (agents-global / codex-global / claude-global).
 */
export function scanGlobalSkillCandidates(options?: SkillInjectionOptions): OnboardingSkillCandidate[] {
  const traceHome = getEffectiveTraceHome(options?.traceHome)
  const centralSkillsDir = path.join(traceHome, 'skills')

  // Reuse existing buildSkillAdoptionPlan to detect fingerprints and conflict status without re-implementing hash logic
  const plan = buildSkillAdoptionPlan(options)
  const planItemByPath = new Map<string, SkillAdoptionPlanItem>()
  for (const item of plan.items) {
    for (const target of item.targets) {
      planItemByPath.set(path.resolve(target.targetPath), item)
    }
  }

  const candidates: OnboardingSkillCandidate[] = []

  for (const sourceToolId of ONBOARDING_GLOBAL_SKILL_SOURCE_TOOL_IDS) {
    const tool = DEFAULT_AI_TOOLS.find((t) => t.id === sourceToolId && t.scope === 'global')
    if (!tool) continue

    const toolDir = getAIToolDirectory(tool, options)
    if (!toolDir || !existsSync(toolDir)) continue

    let entries: string[]
    try {
      entries = readdirSync(toolDir).sort((a, b) => a.localeCompare(b))
    } catch {
      continue
    }

    const sourceLabel = GLOBAL_SOURCE_LABELS[sourceToolId] || sourceToolId.replace(/-global$/, '')

    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const targetPath = path.resolve(toolDir, entry)

      let stat
      try {
        stat = lstatSync(targetPath)
      } catch {
        continue
      }

      const isSym = stat.isSymbolicLink()
      let canonicalPath = targetPath
      if (isSym) {
        try {
          canonicalPath = realpathSync(targetPath)
        } catch {
          // Skip broken symlinks
          continue
        }
      }

      let isDir = false
      try {
        isDir = statSync(canonicalPath).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue

      const skillMdPath = path.join(canonicalPath, 'SKILL.md')
      if (!existsSync(skillMdPath)) continue

      const alreadyLinked = isSym && isPathInside(centralSkillsDir, canonicalPath)

      let conflictsWithCentralId: string | undefined = undefined
      if (!alreadyLinked) {
        const planItem = planItemByPath.get(targetPath)
        const suggestedId = planItem ? planItem.suggestedSkillId : normalizeSkillId(entry)
        const centralHash = readExistingCentralHash(centralSkillsDir, suggestedId)
        if (centralHash) {
          const contentHash = planItem?.contentHash || tryGetSkillDirectoryFingerprint(canonicalPath)
          if (contentHash && centralHash !== contentHash) {
            conflictsWithCentralId = suggestedId
          }
        }
      }

      const skillName = getSkillDisplayName(canonicalPath, entry, centralSkillsDir)

      candidates.push({
        sourceToolId,
        sourceLabel,
        skillName,
        absolutePath: targetPath,
        alreadyLinked,
        conflictsWithCentralId,
      })
    }
  }

  return candidates.sort(
    (a, b) => a.skillName.localeCompare(b.skillName) || a.absolutePath.localeCompare(b.absolutePath)
  )
}

/**
 * Scan project-level Skill candidates for onboarding across supported relative paths.
 */
export function scanProjectSkillCandidates(
  projectPath: string,
  options?: SkillInjectionOptions
): OnboardingSkillCandidate[] {
  if (!projectPath) return []
  const resolvedProjectPath = path.resolve(projectPath)
  try {
    if (!existsSync(resolvedProjectPath) || !statSync(resolvedProjectPath).isDirectory()) {
      return []
    }
  } catch {
    return []
  }

  const traceHome = getEffectiveTraceHome(options?.traceHome)
  const centralSkillsDir = path.join(traceHome, 'skills')

  const plan = buildSkillAdoptionPlan({
    ...options,
    projectPaths: [resolvedProjectPath],
  })
  const planItemByPath = new Map<string, SkillAdoptionPlanItem>()
  for (const item of plan.items) {
    for (const target of item.targets) {
      planItemByPath.set(path.resolve(target.targetPath), item)
    }
  }

  const candidates: OnboardingSkillCandidate[] = []

  for (const supportedPath of SUPPORTED_PROJECT_SKILL_PATHS) {
    const skillDir = path.resolve(resolvedProjectPath, supportedPath.relPath)
    if (!existsSync(skillDir)) continue

    let entries: string[]
    try {
      entries = readdirSync(skillDir).sort((a, b) => a.localeCompare(b))
    } catch {
      continue
    }

    const sourceToolId = supportedPath.id
    const sourceLabel = supportedPath.id

    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const targetPath = path.resolve(skillDir, entry)

      let stat
      try {
        stat = lstatSync(targetPath)
      } catch {
        continue
      }

      const isSym = stat.isSymbolicLink()
      let canonicalPath = targetPath
      if (isSym) {
        try {
          canonicalPath = realpathSync(targetPath)
        } catch {
          continue
        }
      }

      let isDir = false
      try {
        isDir = statSync(canonicalPath).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue

      const skillMdPath = path.join(canonicalPath, 'SKILL.md')
      if (!existsSync(skillMdPath)) continue

      const alreadyLinked = isSym && isPathInside(centralSkillsDir, canonicalPath)

      let conflictsWithCentralId: string | undefined = undefined
      if (!alreadyLinked) {
        const planItem = planItemByPath.get(targetPath)
        const suggestedId = planItem ? planItem.suggestedSkillId : normalizeSkillId(entry)
        const centralHash = readExistingCentralHash(centralSkillsDir, suggestedId)
        if (centralHash) {
          const contentHash = planItem?.contentHash || tryGetSkillDirectoryFingerprint(canonicalPath)
          if (contentHash && centralHash !== contentHash) {
            conflictsWithCentralId = suggestedId
          }
        }
      }

      const skillName = getSkillDisplayName(canonicalPath, entry, centralSkillsDir)

      candidates.push({
        sourceToolId,
        sourceLabel,
        skillName,
        absolutePath: targetPath,
        alreadyLinked,
        conflictsWithCentralId,
      })
    }
  }

  return candidates.sort(
    (a, b) => a.skillName.localeCompare(b.skillName) || a.absolutePath.localeCompare(b.absolutePath)
  )
}

/**
 * Orchestrate migration of onboarding skill candidates.
 *
 * Atomicity and Rollback Guarantee:
 * - We delegate directory migration, link creation, and metadata generation entirely to `adoptSkillAsset`
 *   and `resolveSkillConflict` from `skill-injection-manager.ts`.
 * - `adoptSkillAsset` already implements full atomic staging and rollback:
 *   1. Staging: Target is copied into `~/.trace/skills/{id}` and verified for `SKILL.md`.
 *   2. Backup: Source directory is renamed atomically on the same filesystem to a `.trace-adopt-backup-*` folder.
 *   3. Symlink Verification: Creates the symlink and validates its `realpath`. If this step fails,
 *      the backup directory is immediately renamed back to the original source path, and central files are cleaned up.
 *   4. Trash: Only after symlink verification passes is the backup archived into `.trash`.
 * - `resolveSkillConflict` similarly preserves previous state in `.trash` and rolls back central and target
 *   directories if any step fails.
 * - In this orchestration layer, each item is executed in an isolated try/catch block so that
 *   failure of a single migration candidate never halts or breaks the remaining items.
 */
export async function migrateSkillCandidates(
  requests: OnboardingSkillMigrationRequest[],
  options?: SkillInjectionOptions
): Promise<OnboardingSkillMigrationResult[]> {
  const results: OnboardingSkillMigrationResult[] = []
  const traceHome = getEffectiveTraceHome(options?.traceHome)
  const centralSkillsDir = path.join(traceHome, 'skills')

  for (const req of requests) {
    if (!req.absolutePath) {
      results.push({
        absolutePath: req.absolutePath || '',
        ok: false,
        error: '未提供技能绝对路径',
      })
      continue
    }

    try {
      const targetDesc = resolveTargetFromAbsolutePath(req.absolutePath, options)
      if (!targetDesc) {
        results.push({
          absolutePath: req.absolutePath,
          ok: false,
          error: `无法识别的技能路径，非受支持的全局或项目技能目录: ${req.absolutePath}`,
        })
        continue
      }

      // Check if already linked into central library
      const alreadyLinked = isSkillAlreadyLinked(targetDesc.targetPath, options?.traceHome)
      if (alreadyLinked) {
        // Idempotently update metadata using existing adoptSkillAsset
        const adoptRes = adoptSkillAsset(
          {
            type: targetDesc.type,
            toolId: targetDesc.toolId,
            projectPath: targetDesc.projectPath,
            relPath: targetDesc.relPath,
            skillId: targetDesc.skillId,
            targetPath: targetDesc.targetPath,
          },
          options
        )
        results.push({
          absolutePath: req.absolutePath,
          ok: adoptRes.success,
          centralId: adoptRes.skill?.id,
          error: adoptRes.error,
        })
        continue
      }

      const strategy = req.conflictStrategy
      if (strategy === 'use_app' || strategy === 'use_target' || strategy === 'keep_external') {
        // The central library keys on the normalized id, which is what the scan
        // reports as conflictsWithCentralId. The on-disk directory keeps its own
        // name and is passed separately so the strategy is never silently dropped.
        const centralId = normalizeSkillId(targetDesc.skillId)
        const centralFolder = path.join(centralSkillsDir, centralId)
        const centralJson = path.join(centralSkillsDir, `${centralId}.json`)
        if (existsSync(centralFolder) && existsSync(centralJson)) {
          const conflictRes = resolveSkillConflict(
            {
              skillId: centralId,
              strategy,
              target: {
                scope: targetDesc.type,
                toolId: targetDesc.toolId,
                projectPath: targetDesc.projectPath,
                relPath: targetDesc.relPath,
                targetPath: targetDesc.targetPath,
                targetDirName: targetDesc.skillId,
              },
            },
            options
          )
          results.push({
            absolutePath: req.absolutePath,
            ok: conflictRes.success,
            centralId: conflictRes.skill?.id || centralId,
            error: conflictRes.error,
          })
          continue
        }
      }

      // Fallback or strategy === 'rename' (or undefined):
      // adoptSkillAsset naturally allocates an incremented ID (id-{n}) if central already exists with divergent content.
      // This maps the 'rename' requirement directly onto adoptSkillAsset's built-in id-{n} suffixing behavior
      // without adding new strategy enums to existing code.
      const adoptTarget: AdoptSkillTarget = {
        type: targetDesc.type,
        toolId: targetDesc.toolId,
        projectPath: targetDesc.projectPath,
        relPath: targetDesc.relPath,
        skillId: targetDesc.skillId,
        targetPath: targetDesc.targetPath,
      }
      const adoptRes = adoptSkillAsset(adoptTarget, options)
      results.push({
        absolutePath: req.absolutePath,
        ok: adoptRes.success,
        centralId: adoptRes.skill?.id,
        error: adoptRes.error,
      })
    } catch (err: any) {
      // Isolate error per-item: one failure must never abort the remaining entries
      results.push({
        absolutePath: req.absolutePath,
        ok: false,
        error: err?.message || String(err),
      })
    }
  }

  return results
}

// =========================================================================
// Onboarding MCP Orchestration (OPC-214 Phase B2)
// =========================================================================

/**
 * Secret Key Matching Rules:
 * Keys in `env`, `headers`, `envHeaders`, or URL search params are inspected (case-insensitive).
 * Any key matching one of the following patterns is identified as a sensitive credential:
 * - /key/i          (e.g., API_KEY, apiKey, access_key, privateKey)
 * - /token/i        (e.g., GITHUB_TOKEN, bearerToken, authToken)
 * - /secret/i       (e.g., CLIENT_SECRET, app_secret, sharedSecret)
 * - /password/i     (e.g., DB_PASSWORD, redis_password, pass)
 * - /credential/i   (e.g., AWS_CREDENTIALS, googleCredentials)
 * - /api_key/i      (e.g., api_key)
 * - /authorization/i (e.g., Authorization header)
 */
export const MCP_SECRET_KEY_REGEX = /(?:key|token|secret|password|credential|api_key|authorization)/i

/**
 * Extracts all sensitive field paths from an MCP server definition.
 * Examines:
 * - env: Record<string, string> -> fieldPath: `env.${key}`
 * - headers: Record<string, string> -> fieldPath: `headers.${key}`
 * - envHeaders: Record<string, string> -> fieldPath: `envHeaders.${key}`
 * - url: string -> fieldPath: `url.${searchParam}` or `url.password`
 */
export function extractSecretFieldPaths(
  server: Pick<MCPServerDefinition, 'env' | 'headers' | 'envHeaders' | 'url'>
): string[] {
  const paths: string[] = []

  if (server.env && typeof server.env === 'object') {
    for (const [k, v] of Object.entries(server.env)) {
      if (typeof v === 'string' && v.trim() !== '' && MCP_SECRET_KEY_REGEX.test(k)) {
        paths.push(`env.${k}`)
      }
    }
  }

  if (server.headers && typeof server.headers === 'object') {
    for (const [k, v] of Object.entries(server.headers)) {
      if (typeof v === 'string' && v.trim() !== '' && MCP_SECRET_KEY_REGEX.test(k)) {
        paths.push(`headers.${k}`)
      }
    }
  }

  if (server.envHeaders && typeof server.envHeaders === 'object') {
    for (const [k, v] of Object.entries(server.envHeaders)) {
      if (typeof v === 'string' && v.trim() !== '' && MCP_SECRET_KEY_REGEX.test(k)) {
        paths.push(`envHeaders.${k}`)
      }
    }
  }

  if (server.url && typeof server.url === 'string') {
    try {
      const u = new URL(server.url)
      for (const param of u.searchParams.keys()) {
        if (MCP_SECRET_KEY_REGEX.test(param)) {
          paths.push(`url.${param}`)
        }
      }
      if (u.password && MCP_SECRET_KEY_REGEX.test('password')) {
        paths.push('url.password')
      }
    } catch {
      // If URL parsing fails, check query string manually
      const qIdx = server.url.indexOf('?')
      if (qIdx !== -1) {
        const queryPart = server.url.slice(qIdx + 1)
        const params = queryPart.split('&')
        for (const p of params) {
          const eqIdx = p.indexOf('=')
          const key = eqIdx === -1 ? p : p.slice(0, eqIdx)
          if (MCP_SECRET_KEY_REGEX.test(decodeURIComponent(key))) {
            paths.push(`url.${decodeURIComponent(key)}`)
          }
        }
      }
    }
  }

  return Array.from(new Set(paths)).sort()
}

/**
 * Recursively strips keys matching sensitive pattern from arbitrary raw objects
 * to prevent plain secrets from leaking through tool-specific `sourceRaw` entries.
 */
function sanitizeObjectSecrets(obj: unknown): void {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) {
    for (const item of obj) sanitizeObjectSecrets(item)
    return
  }
  const record = obj as Record<string, unknown>
  for (const [k, v] of Object.entries(record)) {
    if (MCP_SECRET_KEY_REGEX.test(k) && typeof v === 'string') {
      delete record[k]
    } else if (k === 'url' && typeof v === 'string') {
      try {
        const u = new URL(v)
        let changed = false
        for (const p of Array.from(u.searchParams.keys())) {
          if (MCP_SECRET_KEY_REGEX.test(p)) {
            u.searchParams.delete(p)
            changed = true
          }
        }
        if (u.password && MCP_SECRET_KEY_REGEX.test('password')) {
          u.password = ''
          changed = true
        }
        if (changed) {
          record[k] = u.toString()
        }
      } catch {}
    } else if (v && typeof v === 'object') {
      sanitizeObjectSecrets(v)
    }
  }
}

interface InternalCollectedMcpServer {
  definition: MCPServerDefinition
  sourceTools: Array<{
    tool: MCPSourceTool
    scope: MCPScope
    configPath: string
    projectPath?: string
  }>
  secretFieldPaths: string[]
  alreadyManaged: boolean
}

function collectMcpServers(
  scope: MCPScope,
  options?: MCPOptions
): Map<string, InternalCollectedMcpServer> {
  const registry = loadCentralMCPRegistry(options)
  const map = new Map<string, InternalCollectedMcpServer>()

  for (const toolMeta of MCP_SOURCE_TOOLS) {
    const tool = toolMeta.id
    try {
      const configPath = resolveMCPConfigPath(tool, scope, options)
      if (!existsSync(configPath)) continue

      const servers = readMCPServersForTool(tool, scope, options)
      for (const server of servers) {
        // Aggregate deduplication key: server name + transport
        const aggKey = `${server.name}:${server.transport}`
        const secretPaths = extractSecretFieldPaths(server)
        const alreadyManaged = Boolean(
          registry[server.name] ||
          Object.values(registry).some((s) => s.name === server.name)
        )

        const sourceItem = {
          tool,
          scope,
          configPath: server.configPath || configPath,
          projectPath: options?.projectWorkspace,
        }

        const existing = map.get(aggKey)
        if (existing) {
          existing.sourceTools.push(sourceItem)
          existing.secretFieldPaths = Array.from(
            new Set([...existing.secretFieldPaths, ...secretPaths])
          ).sort()
          // Preserve any extra env or headers found in later tools
          if (server.env) {
            existing.definition.env = { ...(server.env), ...(existing.definition.env || {}) }
          }
          if (server.headers) {
            existing.definition.headers = { ...(server.headers), ...(existing.definition.headers || {}) }
          }
          if (server.envHeaders) {
            existing.definition.envHeaders = { ...(server.envHeaders), ...(existing.definition.envHeaders || {}) }
          }
        } else {
          map.set(aggKey, {
            definition: { ...server },
            sourceTools: [sourceItem],
            secretFieldPaths: secretPaths,
            alreadyManaged,
          })
        }
      }
    } catch {
      // Gracefully continue with remaining tools if one tool fails
      continue
    }
  }

  return map
}

/**
 * Scan global MCP candidates across all supported AI tools for onboarding.
 * Deduplicates by server name + transport, identifies suspected secret fields,
 * and flags servers already managed in ~/.trace/mcp-central.json.
 */
export function scanGlobalMcpCandidates(options?: MCPOptions): OnboardingMcpCandidate[] {
  const map = collectMcpServers('global', options)
  const candidates: OnboardingMcpCandidate[] = []

  for (const item of map.values()) {
    candidates.push({
      serverId: item.definition.name,
      serverName: item.definition.name,
      sourceToolId: item.sourceTools[0].tool,
      transport: item.definition.transport,
      hasSecrets: item.secretFieldPaths.length > 0,
      secretFieldPaths: item.secretFieldPaths,
      alreadyManaged: item.alreadyManaged,
    })
  }

  return candidates.sort(
    (a, b) => a.serverName.localeCompare(b.serverName) || a.serverId.localeCompare(b.serverId)
  )
}

/**
 * Scan project-level MCP candidates across all supported AI tools for onboarding.
 */
export function scanProjectMcpCandidates(
  projectPath: string,
  options?: MCPOptions
): OnboardingMcpCandidate[] {
  if (!projectPath) return []
  const resolvedProjectPath = path.resolve(projectPath)
  try {
    if (!existsSync(resolvedProjectPath) || !statSync(resolvedProjectPath).isDirectory()) {
      return []
    }
  } catch {
    return []
  }

  const projectOptions: MCPOptions = {
    ...options,
    projectWorkspace: resolvedProjectPath,
  }

  const map = collectMcpServers('project', projectOptions)
  const candidates: OnboardingMcpCandidate[] = []

  for (const item of map.values()) {
    candidates.push({
      serverId: item.definition.name,
      serverName: item.definition.name,
      sourceToolId: item.sourceTools[0].tool,
      transport: item.definition.transport,
      hasSecrets: item.secretFieldPaths.length > 0,
      secretFieldPaths: item.secretFieldPaths,
      alreadyManaged: item.alreadyManaged,
    })
  }

  return candidates.sort(
    (a, b) => a.serverName.localeCompare(b.serverName) || a.serverId.localeCompare(b.serverId)
  )
}

/**
 * Orchestrate migration of selected MCP candidates into the central registry (~/.trace/mcp-central.json).
 *
 * Guarantees:
 * 1. All identified credentials are saved to Keychain via storeMcpSecret, leaving only McpSecretRef
 *    references in the central library; no plaintext secrets are persisted to central JSON.
 * 2. Per-server failure isolation: failure of one server (e.g. Keychain unavailable/rejected)
 *    never interrupts the migration of remaining servers.
 * 3. Atomic secret isolation: if storing any secret for a server fails, newly stored secrets for that
 *    server are rolled back, and the server is NOT written to central registry (no half-plaintext records).
 * 4. Already managed servers in central library are skipped and returned with ok=true.
 */
export async function migrateMcpCandidates(
  serverIds: string[],
  options?: MCPOptions
): Promise<OnboardingMcpMigrationResult[]> {
  const results: OnboardingMcpMigrationResult[] = []
  const registry = loadCentralMCPRegistry(options)

  // Collect available candidates from global and (if configured) project workspace
  const globalMap = collectMcpServers('global', options)
  const projectMap = options?.projectWorkspace
    ? collectMcpServers('project', options)
    : new Map<string, InternalCollectedMcpServer>()

  // Combined index: map by candidate serverId (server.name)
  const candidatesIndex = new Map<string, InternalCollectedMcpServer>()
  for (const item of globalMap.values()) {
    candidatesIndex.set(item.definition.name, item)
    candidatesIndex.set(item.definition.id, item)
  }
  for (const item of projectMap.values()) {
    if (!candidatesIndex.has(item.definition.name)) {
      candidatesIndex.set(item.definition.name, item)
      candidatesIndex.set(item.definition.id, item)
    }
  }

  for (const serverId of serverIds) {
    // 1. Check if already managed in central library
    const isAlreadyManaged = Boolean(
      registry[serverId] ||
      Object.values(registry).some((s) => s.id === serverId || s.name === serverId)
    )
    if (isAlreadyManaged) {
      results.push({
        serverId,
        ok: true,
        secretsStored: 0,
      })
      continue
    }

    // 2. Locate server candidate definition
    const candidate = candidatesIndex.get(serverId)
    if (!candidate) {
      results.push({
        serverId,
        ok: false,
        secretsStored: 0,
        error: `未找到 MCP 服务定义: ${serverId}`,
      })
      continue
    }

    const def = candidate.definition
    const targetAssociations: MCPTargetAssociation[] = candidate.sourceTools.map((st) => ({
      tool: st.tool,
      scope: st.scope,
      projectPath: st.projectPath,
      injectedAt: Date.now(),
      lastSyncStatus: 'synced',
      configPath: st.configPath,
    }))

    const centralServer: CentralMCPServer = {
      id: def.name,
      name: def.name,
      transport: def.transport,
      command: def.command,
      args: def.args ? [...def.args] : undefined,
      env: def.env ? { ...def.env } : undefined,
      cwd: def.cwd,
      url: def.url,
      headers: def.headers ? { ...def.headers } : undefined,
      envHeaders: def.envHeaders ? { ...def.envHeaders } : undefined,
      enabled: def.enabled !== false,
      ownership: 'app',
      sourceRaw: def.sourceRaw ? JSON.parse(JSON.stringify(def.sourceRaw)) : undefined,
      targetAssociations,
      updatedAt: Date.now(),
      secretRefs: {},
    }

    const storedRefsInAttempt: McpSecretRef[] = []
    let secretsStored = 0

    try {
      // 3. Migrate env secrets
      if (centralServer.env) {
        for (const [key, value] of Object.entries(centralServer.env)) {
          if (MCP_SECRET_KEY_REGEX.test(key) && typeof value === 'string' && value.trim() !== '') {
            const fieldPath = `env.${key}`
            const ref = storeMcpSecret(centralServer.id, fieldPath, value)
            storedRefsInAttempt.push(ref)
            centralServer.secretRefs![fieldPath] = ref
            delete centralServer.env[key]
            secretsStored++
          }
        }
      }

      // 4. Migrate headers secrets
      if (centralServer.headers) {
        for (const [key, value] of Object.entries(centralServer.headers)) {
          if (MCP_SECRET_KEY_REGEX.test(key) && typeof value === 'string' && value.trim() !== '') {
            const fieldPath = `headers.${key}`
            const ref = storeMcpSecret(centralServer.id, fieldPath, value)
            storedRefsInAttempt.push(ref)
            centralServer.secretRefs![fieldPath] = ref
            delete centralServer.headers[key]
            secretsStored++
          }
        }
      }

      // 5. Migrate envHeaders secrets
      if (centralServer.envHeaders) {
        for (const [key, value] of Object.entries(centralServer.envHeaders)) {
          if (MCP_SECRET_KEY_REGEX.test(key) && typeof value === 'string' && value.trim() !== '') {
            const fieldPath = `envHeaders.${key}`
            const ref = storeMcpSecret(centralServer.id, fieldPath, value)
            storedRefsInAttempt.push(ref)
            centralServer.secretRefs![fieldPath] = ref
            delete centralServer.envHeaders[key]
            secretsStored++
          }
        }
      }

      // 6. Migrate url secrets (e.g. query param tokens or passwords)
      if (centralServer.url && typeof centralServer.url === 'string') {
        try {
          const parsedUrl = new URL(centralServer.url)
          const paramsToMigrate: string[] = []
          for (const paramKey of parsedUrl.searchParams.keys()) {
            if (MCP_SECRET_KEY_REGEX.test(paramKey)) {
              paramsToMigrate.push(paramKey)
            }
          }

          for (const paramKey of paramsToMigrate) {
            const val = parsedUrl.searchParams.get(paramKey)
            if (val) {
              const fieldPath = `url.${paramKey}`
              const ref = storeMcpSecret(centralServer.id, fieldPath, val)
              storedRefsInAttempt.push(ref)
              centralServer.secretRefs![fieldPath] = ref
              parsedUrl.searchParams.delete(paramKey)
              secretsStored++
            }
          }

          if (parsedUrl.password && MCP_SECRET_KEY_REGEX.test('password')) {
            const fieldPath = 'url.password'
            const ref = storeMcpSecret(centralServer.id, fieldPath, parsedUrl.password)
            storedRefsInAttempt.push(ref)
            centralServer.secretRefs![fieldPath] = ref
            parsedUrl.password = ''
            secretsStored++
          }

          centralServer.url = parsedUrl.toString()
        } catch {
          // If URL cannot be parsed by standard URL, preserve sanitized form
        }
      }

      // 7. Sanitize sourceRaw to ensure zero plaintext secrets remain
      if (centralServer.sourceRaw) {
        sanitizeObjectSecrets(centralServer.sourceRaw)
      }

      // If no secrets were found, ensure secretRefs is either empty object or preserved
      if (Object.keys(centralServer.secretRefs || {}).length === 0) {
        delete centralServer.secretRefs
      }

      // 8. Atomically save to central library registry
      registry[centralServer.id] = centralServer
      saveCentralMCPRegistry(registry, options)

      results.push({
        serverId,
        ok: true,
        secretsStored,
      })
    } catch (err: any) {
      // Rollback any newly stored secrets in this attempt
      for (const ref of storedRefsInAttempt) {
        try {
          deleteMcpSecret(ref)
        } catch {
          // Best effort rollback
        }
      }

      // Never write half-plaintext or unencrypted records to central registry
      results.push({
        serverId,
        ok: false,
        secretsStored: 0,
        error: err?.message || String(err),
      })
    }
  }

  return results
}

