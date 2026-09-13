import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAccountAdapters } from '../apps/desktop/electron/account-adapters.ts'
import { sanitizeErrorMessage } from '../packages/workflow-model/src/accounts.ts'

const home = mkdtempSync(path.join(os.tmpdir(), 'trace-account-adapters-'))
const put = (relative, value) => { const file = path.join(home, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); return file }
const jwt = value => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(value)).toString('base64url')}.synthetic`
const codexCredential = JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: jwt({ sub: 'synthetic-user', email: 'test@example.invalid' }), access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: 'synthetic-refresh', account_id: 'synthetic-account' } })
try {
  const adapters = createAccountAdapters({ homeDir: home, env: {} })
  const c = adapters.codex
  for (const key of ['cli_auth_credentials_store', '"cli_auth_credentials_store"', "'cli_auth_credentials_store'"]) {
    const original = `# unchanged\nmodel = "fixture"\n${key} = 'auto' # auth comment\n[mcp_servers.example]\ncommand = "fixture"\n`
    const file = put('.codex/config.toml', original)
    const before = c.read()
    c.writeSlot('mode', 'file')
    assert.equal(readFileSync(file, 'utf8'), original.replace("'auto'", '"file"'))
    // Non-auth edits made after switch must survive rollback.
    writeFileSync(file, readFileSync(file, 'utf8').replace('"fixture"', '"changed-model"'))
    c.writeSlot('mode', before.mode)
    assert.equal(c.read().mode, 'auto')
    assert.match(readFileSync(file, 'utf8'), /changed-model/)
    assert.match(readFileSync(file, 'utf8'), /# auth comment/)
  }
  put('.codex/config.toml', 'cli_auth_credentials_store = "file"\ninvalid = [')
  assert.throws(() => c.read())
  put('.codex/config.toml', 'model_provider = "custom"\n')
  assert.equal(c.capability().available, false)
  put('.codex/config.toml', 'forced_login_method = "api"\n')
  assert.equal(c.capability().available, false)
  put('.codex/config.toml', 'forced_chatgpt_workspace_id = "other-account"\n')
  assert.throws(() => c.desired(codexCredential))
  put('.codex/config.toml', 'model = "unchanged"\n')
  assert.equal(c.inspect(codexCredential).email, 'test@example.invalid')
  assert.throws(() => c.inspect('{"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-key"}'))

  const claude = adapters['claude-code']
  const settings = put('.claude/settings.json', JSON.stringify({ model: 'unchanged', env: { KEEP_ME: 'value' }, mcpServers: { keep: { command: 'fixture' } } }))
  const old = JSON.parse(readFileSync(settings, 'utf8'))
  const oauth = 'sk-ant-oat01-' + 'a'.repeat(64)
  claude.writeSlot('oauth', oauth)
  assert.equal(claude.read().oauth, oauth)
  claude.writeSlot('oauth', null)
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), old)
  assert.throws(() => claude.inspect('sk-ant-api03-' + 'a'.repeat(64)))
  for (const variable of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_BASE_URL']) {
    assert.equal(createAccountAdapters({ homeDir: home, env: { [variable]: 'synthetic-conflict' } })['claude-code'].capability().available, false)
  }
  const sentinel = 'synthetic-secret-not-to-echo'
  put('.claude/settings.json', `{"${sentinel}": invalid`)
  try { claude.read(); assert.fail('malformed input accepted') } catch (error) { assert.ok(!sanitizeErrorMessage(error).includes(sentinel)) }

  assert.equal(adapters.antigravity.capability().available, false)
  assert.equal(createAccountAdapters({ homeDir: home, env: { SSH_TTY: '/dev/fixture' } }).antigravity.capability().available, true)
  assert.equal(createAccountAdapters({ homeDir: home, env: { SSH_TTY: '/dev/fixture', GEMINI_API_KEY: 'synthetic' } }).antigravity.capability().available, false)
  assert.throws(() => adapters.antigravity.inspect('{"access_token":"not-antigravity-file"}'))
  const outside = path.join(home, 'outside')
  mkdirSync(outside)
  rmSync(path.join(home, '.codex'), { recursive: true })
  symlinkSync(outside, path.join(home, '.codex'))
  assert.throws(() => c.writeSlot('auth', codexCredential))
  console.log('Account adapters: TOML ranges, settings preservation, auth conflicts, credential formats and path/error checks passed.')
} finally { rmSync(home, { recursive: true, force: true }) }
