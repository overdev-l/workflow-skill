import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

console.log('=== OPC-58 Desktop UI Design System Verification ===\n')

const rootDir = process.cwd()
const stylesCssPath = path.join(rootDir, 'packages/ui/src/styles.css')
const appCssPath = path.join(rootDir, 'apps/desktop/src/app.css')
const accountsCssPath = path.join(rootDir, 'apps/desktop/src/accounts.css')
const mcpCssPath = path.join(rootDir, 'apps/desktop/src/mcp.css')
const updatesCssPath = path.join(rootDir, 'apps/desktop/src/updates.css')

const stylesCss = readFileSync(stylesCssPath, 'utf8')
const appCss = readFileSync(appCssPath, 'utf8')
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

// 1.3 Settings / Accounts 2-column mode: 160px + minmax(0, 1fr)
assert.match(
  appCss,
  /\.app-shell\.is-settings,\s*\.app-shell\.is-accounts\s*\{[^}]*grid-template-columns:\s*160px\s+minmax\(0,\s*1fr\);/,
  '.app-shell settings and accounts modes must declare 2-column layout: 160px minmax(0, 1fr)'
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
// 2. Semantic Control Tokens & Palette Invariants
// ---------------------------------------------------------------------------
console.log('\n--- Check 2: Semantic Control Tokens & Palette Invariants ---')

// 2.1 Dark Theme Tokens
const darkBg = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-bg')
const darkCanvas = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-canvas')
const darkSurface = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-surface')
const darkSurfaceRaised = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-surface-raised')
const darkRail = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-rail')
const darkBorder = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-border')
const darkPrimary = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-primary')
const darkAccent = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--color-accent')
const darkControlBg = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--control-bg')
const darkControlBorder = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--control-border')
const darkControlFocusRing = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--control-focus-ring')

assert.equal(darkBg, 'oklch(0.120 0.004 250)', 'Dark background token matches DESIGN.md')
assert.equal(darkCanvas, 'oklch(0.145 0.005 250)', 'Dark canvas token matches DESIGN.md')
assert.equal(darkSurface, 'oklch(0.175 0.006 250)', 'Dark surface token matches DESIGN.md')
assert.equal(darkSurfaceRaised, 'oklch(0.215 0.008 250)', 'Dark raised surface matches DESIGN.md')
assert.equal(darkRail, 'oklch(0.160 0.006 250)', 'Dark rail token matches DESIGN.md')
assert.equal(darkBorder, 'oklch(0.260 0.007 250)', 'Dark border token matches DESIGN.md')
assert.equal(darkPrimary, 'oklch(0.580 0.200 250)', 'Dark primary token matches Electric Cobalt')
assert.equal(darkAccent, 'oklch(0.780 0.130 210)', 'Dark accent token matches Electric Azure')
assert.ok(darkControlBg, 'Dark control background token is defined')
assert.ok(darkControlBorder, 'Dark control border token is defined')
assert.ok(darkControlFocusRing, 'Dark control focus ring is defined')

// 2.2 Light Theme Tokens
const lightBg = extractToken(stylesCss, "\\[data-theme='light'\\]", '--color-bg')
const lightCanvas = extractToken(stylesCss, "\\[data-theme='light'\\]", '--color-canvas')
const lightSurface = extractToken(stylesCss, "\\[data-theme='light'\\]", '--color-surface')
const lightSurfaceRaised = extractToken(stylesCss, "\\[data-theme='light'\\]", '--color-surface-raised')
const lightRail = extractToken(stylesCss, "\\[data-theme='light'\\]", '--color-rail')
const lightBorder = extractToken(stylesCss, "\\[data-theme='light'\\]", '--color-border')
const lightPrimary = extractToken(stylesCss, "\\[data-theme='light'\\]", '--color-primary')
const lightAccent = extractToken(stylesCss, "\\[data-theme='light'\\]", '--color-accent')
const lightControlBg = extractToken(stylesCss, "\\[data-theme='light'\\]", '--control-bg')
const lightControlBorder = extractToken(stylesCss, "\\[data-theme='light'\\]", '--control-border')
const lightControlFocusRing = extractToken(stylesCss, "\\[data-theme='light'\\]", '--control-focus-ring')

assert.equal(lightBg, 'oklch(0.985 0.002 250)', 'Light background token matches DESIGN.md')
assert.equal(lightCanvas, 'oklch(1 0 0)', 'Light canvas token matches DESIGN.md')
assert.equal(lightSurface, 'oklch(0.965 0.004 250)', 'Light surface token matches DESIGN.md')
assert.equal(lightSurfaceRaised, 'oklch(0.925 0.007 250)', 'Light raised surface matches DESIGN.md')
assert.equal(lightRail, 'oklch(0.940 0.005 250)', 'Light rail token matches DESIGN.md')
assert.equal(lightBorder, 'oklch(0.890 0.006 250)', 'Light border token matches DESIGN.md')
assert.equal(lightPrimary, 'oklch(0.520 0.210 250)', 'Light primary token matches Bold Royal Cobalt')
assert.equal(lightAccent, 'oklch(0.580 0.160 215)', 'Light accent token matches Electric Azure')
assert.ok(lightControlBg, 'Light control background token is defined')
assert.ok(lightControlBorder, 'Light control border token is defined')
assert.ok(lightControlFocusRing, 'Light control focus ring is defined')

console.log('PASS Check 2: Semantic tokens and palette invariants verified')

// ---------------------------------------------------------------------------
// 3. Dark & Light Theme Deeper Input Surfaces
// ---------------------------------------------------------------------------
console.log('\n--- Check 3: Dark & Light Theme Deeper Input Surfaces ---')

// Helper function to extract lightness from an oklch(...) string
function getOklchLightness(oklchStr) {
  const match = oklchStr.match(/oklch\(\s*([\d.]+)/)
  assert.ok(match, `Invalid oklch string: ${oklchStr}`)
  return parseFloat(match[1])
}

const darkControlL = getOklchLightness(darkControlBg)
const darkSurfaceL = getOklchLightness(darkSurface)
const darkCanvasL = getOklchLightness(darkCanvas)

// Dark theme: control surface must be deeper (lower lightness) than surface and canvas
assert.ok(
  darkControlL < darkSurfaceL,
  `Dark control background (${darkControlL}) must be darker than surface (${darkSurfaceL})`
)
assert.ok(
  darkControlL < darkCanvasL,
  `Dark control background (${darkControlL}) must be darker than canvas (${darkCanvasL})`
)

// Light theme: control surface must be distinctly darker (lower lightness) than surface and canvas
const lightControlL = getOklchLightness(lightControlBg)
const lightSurfaceL = getOklchLightness(lightSurface)
const lightCanvasL = getOklchLightness(lightCanvas)

assert.ok(
  lightControlL < lightSurfaceL,
  `Light control background (${lightControlL}) must be distinctly darker than surface (${lightSurfaceL})`
)
assert.ok(
  lightControlL < lightCanvasL,
  `Light control background (${lightControlL}) must be distinctly darker than canvas (${lightCanvasL})`
)
assert.notEqual(lightControlBg, 'oklch(1 0 0)', 'Light control background must NOT be pure white')

// Verify universal editable control binding in styles.css
assert.match(
  stylesCss,
  /input\[type="text"\],[\s\S]*?select\s*\{[\s\S]*?background:\s*var\(--control-bg\);/,
  'Universal input styles must bind background to var(--control-bg)'
)
assert.match(
  stylesCss,
  /input\[type="text"\],[\s\S]*?select\s*\{[\s\S]*?border:\s*1px solid var\(--control-border\);/,
  'Universal input styles must bind border to var(--control-border)'
)

// Verify no light mode override reverts controls back to pure white or translucent white
const forbiddenLightBgPatterns = [
  /\[data-theme='light'\]\s+\.account-input\s*\{[^}]*background:\s*oklch\(1\s+0\s+0/,
  /\[data-theme='light'\]\s+\.account-input\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255/,
  /\[data-theme='light'\]\s+\.account-textarea\s*\{[^}]*background:\s*oklch\(1\s+0\s+0/,
  /\[data-theme='light'\]\s+\.account-textarea\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255/,
  /\[data-theme='light'\]\s+\.skill-md-editor-main\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255/,
  /\[data-theme='light'\]\s+\.skill-md-preview-main\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255/,
]

for (const pattern of forbiddenLightBgPatterns) {
  assert.ok(!pattern.test(accountsCss), `accounts.css must not override control background with white: ${pattern}`)
  assert.ok(!pattern.test(appCss), `app.css must not override control background with white: ${pattern}`)
}

console.log('PASS Check 3: Dark and light theme deeper input surfaces verified')

// ---------------------------------------------------------------------------
// 4. Exact Compact Heights & Rhythm Invariants
// ---------------------------------------------------------------------------
console.log('\n--- Check 4: Exact Compact Heights & Rhythm Invariants ---')

// 4.1 Nav Pill button height: exactly 26px
assert.match(
  appCss,
  /\.nav-pill-btn\s*\{[^}]*height:\s*26px;/,
  '.nav-pill-btn height must be exactly 26px'
)

// 4.2 Standard buttons: height 24px
assert.match(
  appCss,
  /\.btn\s*\{[^}]*height:\s*24px;/,
  '.btn height must be exactly 24px'
)
assert.match(
  accountsCss,
  /\.account-btn\s*\{[^}]*height:\s*24px;/,
  '.account-btn height must be exactly 24px'
)

// 4.3 Small buttons: height 22px
assert.match(
  appCss,
  /\.btn--sm\s*\{[^}]*height:\s*22px;/,
  '.btn--sm height must be exactly 22px'
)
assert.match(
  accountsCss,
  /\.account-btn--sm\s*\{[^}]*height:\s*22px;/,
  '.account-btn--sm height must be exactly 22px'
)

// 4.4 Segmented tab container: height 24px
assert.match(
  appCss,
  /\.master-tab-segmented\s*\{[^}]*height:\s*24px;/,
  '.master-tab-segmented height must be exactly 24px'
)

// 4.5 Search & text inputs: height 28px
assert.match(
  appCss,
  /\.master-search-input\s*\{[^}]*height:\s*28px;/,
  '.master-search-input height must be exactly 28px'
)
assert.match(
  appCss,
  /\.dialog-capsule-input\s*\{[^}]*height:\s*28px;/,
  '.dialog-capsule-input height must be exactly 28px'
)
assert.match(
  accountsCss,
  /\.account-input\s*\{[^}]*height:\s*28px;/,
  '.account-input height must be exactly 28px'
)
assert.match(
  mcpCss,
  /\.mcp-input\s*\{[^}]*height:\s*28px;/,
  '.mcp-input height must be exactly 28px'
)
assert.match(
  mcpCss,
  /\.mcp-select\s*\{[^}]*height:\s*28px;/,
  '.mcp-select height must be exactly 28px'
)
assert.match(
  mcpCss,
  /\.mcp-arg-input\s*\{[^}]*height:\s*28px;/,
  '.mcp-arg-input height must be exactly 28px'
)
assert.match(
  mcpCss,
  /\.mcp-kv-input\s*\{[^}]*height:\s*28px;/,
  '.mcp-kv-input height must be exactly 28px'
)
assert.match(
  stylesCss,
  /input\[type="text"\],[\s\S]*?select\s*\{[\s\S]*?height:\s*28px;/,
  'Universal text inputs and selects in styles.css must be 28px'
)

// 4.6 Multiline editor corner radius: 6-8px
assert.match(
  appCss,
  /\.skill-md-editor-main\s*\{[^}]*border-radius:\s*8px;/,
  '.skill-md-editor-main border-radius must be 8px'
)
assert.match(
  appCss,
  /\.skill-doc-textarea\s*\{[^}]*border-radius:\s*8px;/,
  '.skill-doc-textarea border-radius must be 8px'
)
assert.match(
  accountsCss,
  /\.account-textarea\s*\{[^}]*border-radius:\s*var\(--radius-md,\s*8px\);/,
  '.account-textarea border-radius must be 8px'
)
assert.match(
  mcpCss,
  /\.mcp-textarea\s*\{[^}]*border-radius:\s*8px;/,
  '.mcp-textarea border-radius must be 8px'
)

// 4.7 Maximum panel radius: 12px
assert.match(
  stylesCss,
  /--radius-lg:\s*12px;/,
  '--radius-lg must be 12px'
)
assert.match(
  stylesCss,
  /--radius-capsule:\s*12px;/,
  '--radius-capsule must be capped at 12px'
)
assert.match(
  appCss,
  /\.command-glass-box,\s*\.glass-dialog-box\s*\{[^}]*border-radius:\s*12px;/,
  '.command-glass-box and .glass-dialog-box radius must be 12px'
)
assert.match(
  accountsCss,
  /\[data-theme='light'\]\s+\.account-modal-box\s*\{[^}]*border-radius:\s*12px;/,
  '.account-modal-box radius must be 12px'
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

// 6.1 --motion-spring must not have overshoot (parameter 2 <= 1.0)
const motionSpringValue = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--motion-spring')
assert.ok(motionSpringValue, '--motion-spring token must exist')
const bezierMatch = motionSpringValue.match(/cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/)
assert.ok(bezierMatch, `--motion-spring must be a valid cubic-bezier: ${motionSpringValue}`)
const p2 = parseFloat(bezierMatch[2])
const p4 = parseFloat(bezierMatch[4])
assert.ok(
  p2 <= 1.0 && p4 <= 1.0,
  `--motion-spring must not have elastic overshoot (y1=${p2} <= 1.0, y2=${p4} <= 1.0)`
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
const motionFast = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--motion-fast')
const motionBase = extractToken(stylesCss, ":root,\\s*\\[data-theme='dark'\\]", '--motion-base')
assert.ok(parseInt(motionFast, 10) <= 200, `--motion-fast (${motionFast}) must be <= 200ms`)
assert.ok(parseInt(motionBase, 10) <= 250, `--motion-base (${motionBase}) must be <= 250ms`)

console.log('PASS Check 6: Restrained non-bouncy motion verified')

// ---------------------------------------------------------------------------
// 7. Reduced-Motion Presence
// ---------------------------------------------------------------------------
console.log('\n--- Check 7: Reduced-Motion Presence ---')

// 7.1 styles.css covers prefers-reduced-motion
assert.match(
  stylesCss,
  /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?animation-duration:\s*1ms[\s\S]*?\}/,
  'styles.css must provide reduced-motion override minimizing animations'
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
