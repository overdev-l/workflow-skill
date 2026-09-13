import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MacOSSecurityKeychainAdapter } from '../apps/desktop/electron/profile-keychain.ts'

if (process.platform !== 'darwin') throw new Error('This integration check requires macOS Keychain.')

// This command creates and deletes only this unique synthetic test item.
const service = `Trace-Profile-Verification-${randomUUID()}`
const account = 'trace-verification'
const adapter = new MacOSSecurityKeychainAdapter()
try {
  assert.equal(await adapter.readSecret(service, account), null)
  for (const secret of ['', 'deadbeef', '含中文\n', 'fixture-"quotes"-\\-\n', JSON.stringify({ fixture: 'x'.repeat(1400), nested: { enabled: true } })]) {
    await adapter.writeSecret(service, account, secret)
    assert.equal((await adapter.readSecret(service, account))?.secret, secret)
  }
  const before = (await adapter.readSecret(service, account)).secret
  await assert.rejects(() => adapter.writeSecret(service, account, 'x'.repeat(12000)), /safe system command size/)
  assert.equal((await adapter.readSecret(service, account))?.secret, before)
  console.log('Native Keychain OK: empty, Unicode, JSON, quotes, updates, and oversized input rejected without mutation')
} finally {
  await adapter.deleteSecret(service, account)
  assert.equal(await adapter.readSecret(service, account), null)
  console.log('Synthetic Keychain entry removed')
}
