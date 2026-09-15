import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the actual component's queue callback and effect with fake time/API.
// No credentials, network, Electron runtime, or account mutations are involved.
const source = readFileSync(new URL('../apps/desktop/src/components/AccountSettings.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('AccountSettings.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let enqueueNode, effectNode
const constants = []
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['QUOTA_FAILURE_COOLDOWN_MS', 'QUOTA_CACHE_TTL_MS'].includes(node.name.getText(ast))) {
    constants.push(`globalThis.${node.name.getText(ast)} = ${node.initializer.getText(ast)}`)
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'enqueueVisibleQuotas') {
    enqueueNode = node.initializer.arguments[0]
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('lastToolRunRef.current')) {
    effectNode = node.arguments[0]
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(enqueueNode && effectNode, 'Locate real quota scheduling code')
let now = 1_000_000
let runs = 0
const account = (id, tool) => ({ id, tool, updatedAt: 1 })
const a = account('a', 'claude-code'), b = account('b', 'codex')
const ctx = vm.createContext({
  api: { refreshQuota() {} },
  Date: class extends Date { static now() { return now } },
  selectedTool: a.tool,
  toolSavedAccounts: [a],
  quotas: {
    a: { status: 'ready', attemptedAt: now, fetchedAt: now },
    b: { status: 'ready', attemptedAt: now, fetchedAt: now },
  },
  lastToolRunRef: { current: '' },
  lastAccountIdsRef: { current: '' },
  inFlightQuotasRef: { current: new Set() },
  quotaFetchQueue: { current: [] },
  failedQuotaAttempts: { current: new Map() },
  processQuotaQueue() { runs++ },
})
vm.runInContext(constants.join('\n'), ctx)
for (const [name, node] of [['enqueueVisibleQuotas', enqueueNode], ['runEffect', effectNode]]) {
  vm.runInContext(ts.transpile(`globalThis.${name} = ${node.getText(ast)}`, { target: ts.ScriptTarget.ES2022 }), ctx)
}
const queued = () => Array.from(ctx.quotaFetchQueue.current)
ctx.runEffect()
assert.deepEqual(queued(), ['a'], 'Entering a tool refreshes a recent successful cached quota')
ctx.quotaFetchQueue.current = []
ctx.selectedTool = b.tool; ctx.toolSavedAccounts = [b]
ctx.runEffect()
assert.deepEqual(queued(), ['b'], 'Switching refreshes target tool')
ctx.selectedTool = a.tool; ctx.toolSavedAccounts = [a]
ctx.runEffect()
assert.deepEqual(queued(), ['a'], 'Returning to cached tool refreshes and removes stale queued work')
ctx.quotaFetchQueue.current = []
const previousRuns = runs
ctx.quotas = { ...ctx.quotas, a: { ...ctx.quotas.a, fetchedAt: now + 1 } }
ctx.runEffect()
assert.equal(runs, previousRuns, 'Quota response rerender does not trigger an endless refresh')
ctx.enqueueVisibleQuotas(true); ctx.enqueueVisibleQuotas(true)
assert.deepEqual(queued(), ['a'], 'Queue deduplicates repeated scheduling')
ctx.quotaFetchQueue.current = []
ctx.inFlightQuotasRef.current.add('a')
ctx.enqueueVisibleQuotas(true)
assert.deepEqual(queued(), [], 'Do not duplicate an in-flight request')
ctx.inFlightQuotasRef.current.clear()
ctx.failedQuotaAttempts.current.set('a', now)
ctx.quotas.a = { status: 'rate-limited', attemptedAt: now }
ctx.selectedTool = b.tool; ctx.toolSavedAccounts = [b]; ctx.runEffect()
ctx.selectedTool = a.tool; ctx.toolSavedAccounts = [a]; ctx.runEffect()
assert.deepEqual(queued(), [], 'Automatic tool switching respects failure cooldown')
ctx.enqueueVisibleQuotas(true)
assert.deepEqual(queued(), ['a'], 'Explicit refresh can retry during automatic cooldown')
ctx.quotaFetchQueue.current = []
now += ctx.QUOTA_FAILURE_COOLDOWN_MS + 1
ctx.selectedTool = b.tool; ctx.toolSavedAccounts = [b]; ctx.runEffect()
ctx.selectedTool = a.tool; ctx.toolSavedAccounts = [a]; ctx.runEffect()
assert.deepEqual(queued(), ['a'], 'Tool switch retries after failure cooldown')
ctx.selectedTool = 'antigravity'; ctx.toolSavedAccounts = []; ctx.runEffect()
assert.deepEqual(queued(), [], 'Empty tool clears obsolete queued accounts safely')
console.log('PASS account tool refresh: cached A→B→A, stable rerenders, deduplication, cooldown, and empty tools')
