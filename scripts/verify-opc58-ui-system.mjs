import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

console.log('=== OPC-58 Desktop UI Design System Verification ===\n')

const rootDir = process.cwd()
const tokensCssPath = path.join(rootDir, 'packages/ui/src/tokens.css')
const primitivesCssPath = path.join(rootDir, 'packages/ui/src/primitives.css')
const appCssPath = path.join(rootDir, 'apps/desktop/src/app.css')
const layoutCssPath = path.join(rootDir, 'apps/desktop/src/layout.css')
const accountsCssPath = path.join(rootDir, 'apps/desktop/src/accounts.css')
const mcpCssPath = path.join(rootDir, 'apps/desktop/src/mcp.css')
const updatesCssPath = path.join(rootDir, 'apps/desktop/src/updates.css')

const moduleFiles = [
  'detail.css',
  'diagnostics.css',
  'dialogs.css',
  'environments.css',
  'master.css',
  'settings.css',
  'sidebar.css',
  'workflow.css',
]

const tokensCss = readFileSync(tokensCssPath, 'utf8')
const primitivesCss = readFileSync(primitivesCssPath, 'utf8')
const uiCss = [tokensCss, primitivesCss].join('\n')
const stylesCss = uiCss // alias for backward-compatibility if referenced

const appCssRaw = readFileSync(appCssPath, 'utf8')
const layoutCss = readFileSync(layoutCssPath, 'utf8')
const moduleCssParts = moduleFiles.map((file) =>
  readFileSync(path.join(rootDir, 'apps/desktop/src/modules', file), 'utf8')
)
const appCss = [appCssRaw, layoutCss, ...moduleCssParts].join('\n')

const accountsCss = readFileSync(accountsCssPath, 'utf8')
const mcpCss = readFileSync(mcpCssPath, 'utf8')
const updatesCss = readFileSync(updatesCssPath, 'utf8')

// Helper function to extract token value from CSS content within a selector block
function extractToken(css, blockSelector, tokenName) {
  const blockRegex = new RegExp(`${blockSelector}\\s*\\{([\\s\\S]*?)\\}`, 'm')
  const match = css.match(blockRegex)
  if (!match) return null
  const blockContent = match[1]
  const tokenRegex = new RegExp(`${tokenName}:\\s*([^;]+);`)
  const tokenMatch = blockContent.match(tokenRegex)
  return tokenMatch ? tokenMatch[1].trim() : null
}

// ---------------------------------------------------------------------------
// 1. Layout Column Tokens & Shell Geometry
// ---------------------------------------------------------------------------
console.log('--- Check 1: Layout Column Tokens & Shell Geometry ---')

// 1.1 3-Column Shell Geometry: 160px sidebar, master column (210px), detail stage minmax(0, 1fr)
assert.match(
  appCss,
  /\.app-shell\s*\{[^}]*grid-template-columns:\s*160px\s+var\(--master-column-width,\s*210px\)\s+minmax\(0,\s*1fr\);/,
  '.app-shell must declare 3-column layout: 160px, var(--master-column-width, 210px), minmax(0, 1fr)'
)

// 1.2 Sidebar width is strictly 160px
assert.match(
  appCss,
  /\.app-sidebar\s*\{[^}]*width:\s*160px;/,
  '.app-sidebar width must be fixed at 160px'
)

// 1.3 Settings and the user-specified account workbench use two columns.
assert.match(
  appCss,
  /\.app-shell\.is-settings,\s*\.app-shell\.is-accounts\s*\{[^}]*grid-template-columns:\s*160px\s+minmax\(0,\s*1fr\);/,
  '.app-shell settings/account modes must declare 2-column layout: 160px minmax(0, 1fr)'
)

// 1.4 Grid children min-width: 0 protection against overflow blowout
assert.match(
  appCss,
  /\.app-sidebar\s*\{[^}]*min-width:\s*160px;[^}]*max-width:\s*160px;/,
  '.app-sidebar must remain fixed at 160px'
)
assert.match(
  appCss,
  /\.app-col-master\s*\{[^}]*min-width:\s*0;/,
  '.app-col-master must specify min-width: 0'
)
assert.match(
  appCss,
  /\.app-col-detail\s*\{[^}]*min-width:\s*0;/,
  '.app-col-detail must specify min-width: 0'
)

console.log('PASS Check 1: Layout column tokens and shell geometry verified')

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 2. Semantic Control Tokens & Palette Invariants
// ---------------------------------------------------------------------------
console.log('\n--- Check 2: Semantic Control Tokens & Palette Invariants ---')

// Helper function to extract token value
function checkChromaZero(tokenVal, tokenName) {
  assert.ok(tokenVal, `${tokenName} must be defined`)
  const m = tokenVal.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  if (m) {
    const chroma = parseFloat(m[2])
    assert.equal(chroma, 0, `${tokenName} (${tokenVal}) must have chroma 0`)
  }
}

// 2.1 Dark Theme Tokens
const darkBg = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-bg')
const darkCanvas = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-canvas')
const darkSurface = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-surface')
const darkSurfaceRaised = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-surface-raised')
const darkRail = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-rail')
const darkBorder = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-border')
const darkPrimary = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-primary')
const darkControlBg = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--control-bg')
const darkControlBorder = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--control-border')
const darkControlBorderFocus = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--control-border-focus')

assert.equal(darkBg, 'oklch(0.120 0 0)', 'Dark background token is chroma0')
assert.equal(darkCanvas, 'oklch(0.150 0 0)', 'Dark canvas token is chroma0')
assert.equal(darkSurface, 'oklch(0.190 0 0)', 'Dark surface token is chroma0')
assert.equal(darkSurfaceRaised, 'oklch(0.230 0 0)', 'Dark raised surface is chroma0')
assert.equal(darkRail, 'oklch(0.165 0 0)', 'Dark rail token is chroma0')
assert.equal(darkBorder, 'oklch(0.285 0 0)', 'Dark border token is chroma0')
assert.equal(darkPrimary, 'oklch(0.545 0.170 255)', 'Dark primary token matches v2')
assert.equal(darkControlBg, 'var(--color-surface)', 'Dark control background is same-luminance var(--color-surface)')
assert.equal(darkControlBorder, 'oklch(0.520 0 0)', 'Dark control border token is defined')
assert.equal(darkControlBorderFocus, 'oklch(0.680 0 0)', 'Dark control border focus token is defined')

// Verify chroma0 neutrals
for (const [name, val] of [
  ['--color-bg', darkBg],
  ['--color-canvas', darkCanvas],
  ['--color-surface', darkSurface],
  ['--color-surface-raised', darkSurfaceRaised],
  ['--color-rail', darkRail],
  ['--color-border', darkBorder],
]) {
  checkChromaZero(val, `Dark ${name}`)
}

// 2.2 Light Theme Tokens
const lightBg = extractToken(tokensCss, "\\[data-theme='light'\\]", '--color-bg')
const lightCanvas = extractToken(tokensCss, "\\[data-theme='light'\\]", '--color-canvas')
const lightSurface = extractToken(tokensCss, "\\[data-theme='light'\\]", '--color-surface')
const lightSurfaceRaised = extractToken(tokensCss, "\\[data-theme='light'\\]", '--color-surface-raised')
const lightRail = extractToken(tokensCss, "\\[data-theme='light'\\]", '--color-rail')
const lightBorder = extractToken(tokensCss, "\\[data-theme='light'\\]", '--color-border')
const lightPrimary = extractToken(tokensCss, "\\[data-theme='light'\\]", '--color-primary')
const lightControlBg = extractToken(tokensCss, "\\[data-theme='light'\\]", '--control-bg')
const lightControlBorder = extractToken(tokensCss, "\\[data-theme='light'\\]", '--control-border')
const lightControlBorderFocus = extractToken(tokensCss, "\\[data-theme='light'\\]", '--control-border-focus')

assert.equal(lightBg, 'oklch(0.985 0 0)', 'Light background token is chroma0')
assert.equal(lightCanvas, 'oklch(1 0 0)', 'Light canvas token is chroma0')
assert.equal(lightSurface, 'oklch(0.965 0 0)', 'Light surface token is chroma0')
assert.equal(lightSurfaceRaised, 'oklch(0.930 0 0)', 'Light raised surface is chroma0')
assert.equal(lightRail, 'oklch(0.945 0 0)', 'Light rail token is chroma0')
assert.equal(lightBorder, 'oklch(0.885 0 0)', 'Light border token is chroma0')
assert.equal(lightPrimary, 'oklch(0.520 0.190 255)', 'Light primary token matches v2')
assert.equal(lightControlBg, 'var(--color-surface)', 'Light control background is same-luminance var(--color-surface)')
assert.equal(lightControlBorder, 'oklch(0.610 0 0)', 'Light control border token is defined')
assert.equal(lightControlBorderFocus, 'oklch(0.420 0 0)', 'Light control border focus token is defined')

for (const [name, val] of [
  ['--color-bg', lightBg],
  ['--color-canvas', lightCanvas],
  ['--color-surface', lightSurface],
  ['--color-surface-raised', lightSurfaceRaised],
  ['--color-rail', lightRail],
  ['--color-border', lightBorder],
]) {
  checkChromaZero(val, `Light ${name}`)
}

// 2.3 Six Typography Font Tokens (11/12/13/15/20/12)
const textCaption = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--text-caption')
const textControl = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--text-control')
const textBody = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--text-body')
const textSection = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--text-section')
const textTitle = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--text-title')
const textMono = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--text-mono')

assert.equal(textCaption, '11px', '--text-caption must be 11px')
assert.equal(textControl, '12px', '--text-control must be 12px')
assert.equal(textBody, '13px', '--text-body must be 13px')
assert.equal(textSection, '15px', '--text-section must be 15px')
assert.equal(textTitle, '20px', '--text-title must be 20px')
assert.equal(textMono, '12px', '--text-mono must be 12px')

// 2.4 Control Heights Tokens
const heightNav = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--height-nav')
const heightBtn = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--height-btn')
const heightBtnSm = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--height-btn-sm')
const heightTab = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--height-tab')
const heightInput = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--height-input')

assert.equal(heightNav, '26px', '--height-nav must be 26px')
assert.equal(heightBtn, '24px', '--height-btn must be 24px')
assert.equal(heightBtnSm, '22px', '--height-btn-sm must be 22px')
assert.equal(heightTab, '24px', '--height-tab must be 24px')
assert.equal(heightInput, '28px', '--height-input must be 28px')

console.log('PASS Check 2: Semantic tokens, typography and palette invariants verified')

// ---------------------------------------------------------------------------
// 3. Same-Luminance Input Surfaces & Stronger Neutral Focus Borders
// ---------------------------------------------------------------------------
console.log('\n--- Check 3: Same-Luminance Input Surfaces & Neutral Focus Borders ---')

// Helper function to extract lightness from an oklch(...) string
function getOklchLightness(oklchStr) {
  const match = oklchStr.match(/oklch\(\s*([\d.]+)/)
  assert.ok(match, `Invalid oklch string: ${oklchStr}`)
  return parseFloat(match[1])
}

// 3.1 Dark theme: focus border must be stronger neutral than normal border (higher lightness in dark mode)
const darkBorderL = getOklchLightness(darkControlBorder)
const darkFocusBorderL = getOklchLightness(darkControlBorderFocus)
assert.ok(
  darkFocusBorderL > darkBorderL,
  `Dark focus border (${darkFocusBorderL}) must be stronger/brighter than rest border (${darkBorderL})`
)
checkChromaZero(darkControlBorder, 'Dark --control-border')
checkChromaZero(darkControlBorderFocus, 'Dark --control-border-focus')

// 3.2 Light theme: focus border must be stronger neutral than normal border (lower lightness / darker contrast in light mode)
const lightBorderL = getOklchLightness(lightControlBorder)
const lightFocusBorderL = getOklchLightness(lightControlBorderFocus)
assert.ok(
  lightFocusBorderL < lightBorderL,
  `Light focus border (${lightFocusBorderL}) must be stronger/darker than rest border (${lightBorderL})`
)
checkChromaZero(lightControlBorder, 'Light --control-border')
checkChromaZero(lightControlBorderFocus, 'Light --control-border-focus')

// Verify universal editable control binding in primitives.css
assert.match(
  primitivesCss,
  /background-color:\s*var\(--control-bg\);/,
  'Universal editable controls must bind background-color to var(--control-bg)'
)
assert.match(
  primitivesCss,
  /border:\s*1px solid var\(--control-border\);/,
  'Universal editable controls must bind border to var(--control-border)'
)
assert.match(
  primitivesCss,
  /border-color:\s*var\(--control-border-focus\);/,
  'Universal editable controls focus must bind border-color to var(--control-border-focus)'
)

// Non-input keyboard focus ring must be preserved
assert.match(
  primitivesCss,
  /:focus-visible:not\(input\)[^{]*\{[\s\S]*?outline:\s*1\.5px solid var\(--focus-ring\);/,
  'Non-input keyboard focus ring must be preserved with var(--focus-ring)'
)

// Verify no !important in migrated ui sources or appCss
assert.ok(
  !tokensCss.includes('!important'),
  'tokens.css must not contain !important declarations'
)
assert.ok(
  !primitivesCss.includes('!important'),
  'primitives.css must not contain !important declarations'
)
assert.ok(
  !appCss.includes('!important'),
  'appCss must not contain !important declarations'
)

// Primary chromatic token is restricted to button primary only
assert.match(
  primitivesCss,
  /\.btn--primary\s*\{[^}]*background-color:\s*var\(--color-primary\);/,
  'Primary token is allowed on .btn--primary'
)

console.log('PASS Check 3: Same-luminance input surfaces and neutral focus borders verified')

// ---------------------------------------------------------------------------
// 4. Exact Compact Heights & Rhythm Invariants
// ---------------------------------------------------------------------------
console.log('\n--- Check 4: Exact Compact Heights & Rhythm Invariants ---')

// 4.1 Nav Pill button height: exactly 26px (literal or var(--height-nav))
assert.match(
  primitivesCss,
  /\.nav-pill-btn\s*\{[^}]*height:\s*var\(--height-nav\);/,
  '.nav-pill-btn height must use var(--height-nav)'
)

// 4.2 Standard buttons: height 24px
assert.match(
  primitivesCss,
  /\.btn\s*\{[^}]*height:\s*var\(--height-btn\);/,
  '.btn height must use var(--height-btn)'
)
assert.match(
  appCss,
  /\.btn\s*\{[^}]*height:\s*(?:24px|var\(--height-btn\));/,
  '.btn height in appCss must be 24px or var(--height-btn)'
)
assert.match(
  accountsCss,
  /\.account-btn\s*\{[^}]*height:\s*(?:24px|var\(--height-btn\));/,
  '.account-btn height must be 24px or var(--height-btn)'
)

// 4.3 Small buttons: height 22px
assert.match(
  primitivesCss,
  /\.btn\.btn--sm\s*\{[^}]*height:\s*var\(--height-btn-sm\);/,
  '.btn.btn--sm height must use var(--height-btn-sm)'
)
assert.match(
  appCss,
  /\.btn--sm\s*\{[^}]*height:\s*(?:22px|var\(--height-btn-sm\));/,
  '.btn--sm height in appCss must be 22px or var(--height-btn-sm)'
)
assert.match(
  accountsCss,
  /\.account-btn--sm\s*\{[^}]*height:\s*(?:22px|var\(--height-btn-sm\));/,
  '.account-btn--sm height must be 22px or var(--height-btn-sm)'
)

// 4.4 Segmented tab container: height 24px
assert.match(
  primitivesCss,
  /\.master-tab-segmented\s*\{[^}]*height:\s*var\(--height-tab\);/,
  '.master-tab-segmented height must use var(--height-tab)'
)

// 4.5 Search & text inputs: height 28px
assert.match(
  primitivesCss,
  /:where\([\s\S]*?input\[type="text"\][\s\S]*?\)\s*\{[^}]*height:\s*var\(--height-input\);/,
  'Universal inputs in primitives.css must bind height to var(--height-input)'
)
assert.match(
  appCss,
  /\.master-search-input\s*\{[^}]*height:\s*(?:28px|var\(--height-input\));/,
  '.master-search-input height must be 28px or var(--height-input)'
)
assert.match(
  appCss,
  /\.dialog-capsule-input\s*\{[^}]*height:\s*(?:28px|var\(--height-input\));/,
  '.dialog-capsule-input height must be 28px or var(--height-input)'
)
assert.match(
  accountsCss,
  /\.account-input\s*\{[^}]*height:\s*(?:28px|var\(--height-input\));/,
  '.account-input height must be 28px or var(--height-input)'
)
assert.match(
  mcpCss,
  /\.mcp-input\s*\{[^}]*height:\s*(?:28px|var\(--height-input\));/,
  '.mcp-input height must be 28px or var(--height-input)'
)
assert.match(
  mcpCss,
  /\.mcp-select\s*\{[^}]*height:\s*(?:28px|var\(--height-input\));/,
  '.mcp-select height must be 28px or var(--height-input)'
)
assert.match(
  mcpCss,
  /\.mcp-arg-input\s*\{[^}]*min-height:\s*(?:28px|var\(--height-input\));/,
  '.mcp-arg-input must retain a 28px minimum while allowing multiline content'
)
assert.match(
  mcpCss,
  /\.mcp-kv-input\s*\{[^}]*height:\s*(?:28px|var\(--height-input\));/,
  '.mcp-kv-input height must be 28px or var(--height-input)'
)

// 4.6 Multiline editor corner radius: 6-8px
assert.match(
  appCss,
  /\.skill-md-editor-main\s*\{[^}]*border-radius:\s*(?:8px|var\(--radius-md\));/,
  '.skill-md-editor-main border-radius must be 8px'
)
assert.match(
  appCss,
  /\.skill-doc-textarea\s*\{[^}]*border-radius:\s*(?:8px|var\(--radius-md\));/,
  '.skill-doc-textarea border-radius must be 8px'
)
assert.match(
  accountsCss,
  /\.account-textarea\s*\{[^}]*border-radius:\s*(?:8px|var\(--radius-md(?:,\s*8px)?\));/,
  '.account-textarea border-radius must be 8px or var(--radius-md)'
)
assert.match(
  mcpCss,
  /\.mcp-textarea\s*\{[^}]*border-radius:\s*(?:8px|var\(--radius-md\));/,
  '.mcp-textarea border-radius must be 8px'
)

// 4.7 Maximum panel radius: 12px
assert.match(
  tokensCss,
  /--radius-lg:\s*12px;/,
  '--radius-lg must be 12px'
)
assert.match(
  tokensCss,
  /--radius-capsule:\s*12px;/,
  '--radius-capsule must be capped at 12px'
)
assert.match(
  appCss,
  /\.command-panel,\s*\.dialog-surface\s*\{[^}]*border-radius:\s*(?:12px|var\(--radius-lg\));/,
  '.command-panel and .dialog-surface radius must be 12px'
)
assert.match(
  accountsCss,
  /\.account-modal-box\s*\{[^}]*border-radius:\s*(?:12px|var\(--radius-lg\));/,
  '.account-modal-box radius must be 12px or var(--radius-lg)'
)

console.log('PASS Check 4: Exact compact heights and rhythm invariants verified')

// ---------------------------------------------------------------------------
// 5. No 780px Two-Column Shell Regression
// ---------------------------------------------------------------------------
console.log('\n--- Check 5: No 780px Two-Column Shell Regression ---')

// Electron BrowserWindow minWidth is 780px.
// Previously, @media (max-width: 860px) collapsed .app-shell to 2 columns (180px minmax(0, 1fr)),
// which broke windows sized between 780px and 860px.
const shellCollapseRegex = /@media\s*\([^{]*max-width:\s*8[0-9]{2}px[^{]*\)\s*\{[\s\S]*?\.app-shell\s*\{[^}]*grid-template-columns:\s*180px/
assert.ok(
  !shellCollapseRegex.test(appCss),
  'app.css must NOT have a media query <= 860px that collapses .app-shell to 2 columns'
)

// Ensure .app-shell definition maintains 3 columns
const appShellBlocks = appCss.match(/\.app-shell\s*\{[^}]*\}/g) || []
for (const block of appShellBlocks) {
  if (block.includes('grid-template-columns:')) {
    assert.ok(
      block.includes('160px') && block.includes('minmax(0, 1fr)'),
      `.app-shell block must preserve 160px sidebar and detail column: ${block}`
    )
  }
}

console.log('PASS Check 5: 3-column shell invariant preserved without 780px-860px regression')

// ---------------------------------------------------------------------------
// 6. Restrained Non-Bouncy Motion
// ---------------------------------------------------------------------------
console.log('\n--- Check 6: Restrained Non-Bouncy Motion ---')

// 6.1 --motion-standard must not have overshoot (parameter 2 <= 1.0)
const motionStandardValue = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--motion-standard')
assert.ok(motionStandardValue, '--motion-standard token must exist')
const bezierMatch = motionStandardValue.match(/cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/)
assert.ok(bezierMatch, `--motion-standard must be a valid cubic-bezier: ${motionStandardValue}`)
const p2 = parseFloat(bezierMatch[2])
const p4 = parseFloat(bezierMatch[4])
assert.ok(
  p2 <= 1.0 && p4 <= 1.0,
  `--motion-standard must not have elastic overshoot (y1=${p2} <= 1.0, y2=${p4} <= 1.0)`
)

// 6.2 Buttons must NOT have bouncy hover/active scaling
assert.ok(
  !/\.btn:hover\s*\{[^}]*transform:\s*scale\(1\.03\)/.test(appCss),
  '.btn:hover must not use bouncy scale(1.03) transform'
)
assert.ok(
  !/\.btn:active\s*\{[^}]*transform:\s*scale\(0\.93\)/.test(appCss),
  '.btn:active must not use bouncy scale(0.93) transform'
)
assert.ok(
  !/\.account-btn:active[^{]*\{[^}]*transform:\s*scale/.test(accountsCss),
  '.account-btn:active must not use bouncy scale transform'
)

// 6.3 Transition durations are restrained (<= 250ms)
const motionFast = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--motion-fast')
const motionBase = extractToken(tokensCss, ":root,\\s*\\[data-theme='dark'\\]", '--motion-base')
assert.ok(parseInt(motionFast, 10) <= 200, `--motion-fast (${motionFast}) must be <= 200ms`)
assert.ok(parseInt(motionBase, 10) <= 250, `--motion-base (${motionBase}) must be <= 250ms`)

console.log('PASS Check 6: Restrained non-bouncy motion verified')

// ---------------------------------------------------------------------------
// 7. Reduced-Motion Presence
// ---------------------------------------------------------------------------
console.log('\n--- Check 7: Reduced-Motion Presence ---')

// 7.1 primitives.css covers prefers-reduced-motion
assert.match(
  primitivesCss,
  /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?animation-duration:\s*0\.01ms[\s\S]*?\}/,
  'primitives.css must provide reduced-motion override minimizing animations'
)

// 7.2 updates.css covers prefers-reduced-motion
assert.match(
  updatesCss,
  /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?animation:\s*none[\s\S]*?\}/,
  'updates.css must provide reduced-motion override'
)

console.log('PASS Check 7: Reduced-motion presence verified')

console.log('\n=============================================================')
console.log('ALL OPC-58 UI SYSTEM CHECKS PASSED!')
console.log('=============================================================')
