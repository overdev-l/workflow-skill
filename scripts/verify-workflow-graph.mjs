import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, Module } from 'node:module'
import path from 'node:path'
import ts from 'typescript'

// Render the real graph component with only its locale context stubbed.
// No Electron, account credentials, or persistent user data are accessed.
const desktopRequire = createRequire(path.resolve('apps/desktop/package.json'))
const React = desktopRequire('react')
const { renderToStaticMarkup } = desktopRequire('react-dom/server')
const filename = path.resolve('apps/desktop/src/components/WorkflowGraph.tsx')
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const component = new Module(filename)
component.filename = filename
component.require = (id) => {
  if (id.endsWith('.css')) return {}
  if (id === '../i18n') return { useI18n: () => ({ resolvedLocale: 'zh-CN' }) }
  return desktopRequire(id)
}
component._compile(compiled, filename)
const { WorkflowGraph } = component.exports
const node = (id) => ({ id, kind: 'action', label: `步骤 ${id}`, app: 'Test' })
const render = (nodes, edges, props = {}) => renderToStaticMarkup(React.createElement(WorkflowGraph, {
  workflow: { id: 'fixture', name: '图谱回归', nodes, edges }, ...props,
}))
const nodes = Array.from({ length: 93 }, (_, i) => node(String(i + 1)))
const chain = render(nodes, nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })), { selectedNodeId: '1' })
assert.equal((chain.match(/data-node-id=/g) || []).length, 93, 'Long flows retain every step')
assert.match(chain, /aria-label="93\./, 'Last step has a readable accessible label')
assert.equal((chain.match(/tabindex="0"/g) || []).length, 1, 'Only the selected node joins sequential keyboard navigation')
assert.match(chain, /aria-label="适应画布"/, 'Fit is an accessible control')
assert.match(chain, /aria-label="定位选中步骤"/, 'Selected-step navigation is discoverable')
const branch = render([node('root'), ...nodes], nodes.map(n => ({ from: 'root', to: n.id })))
const heights = Array.from(branch.matchAll(/height:([\d.]+)px/g), m => Number(m[1]))
assert.ok(Math.max(...heights) > 93 * 56, 'Tall branches receive sufficient vertical canvas space')
const loop = render([node('a'), node('b')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }])
assert.equal((loop.match(/data-node-id=/g) || []).length, 2, 'Cyclic imported graphs terminate and retain nodes')
assert.ok(!/NaN|Infinity/.test(render([], [])), 'Empty graph has finite geometry')
console.log('PASS WorkflowGraph: long chain, keyboard entry, tall branch, cycle, and empty state')
