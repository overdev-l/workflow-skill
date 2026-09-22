import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  BACKDROP_FILTER_WHITELIST,
  checkDeclarationViolations,
  checkRuleLevelViolations,
  compositeColorsSrgb,
  contrastRatio,
  evaluateContrastSuite,
  getPostcss,
  linearToSrgb,
  oklchToLinearSrgb,
  parseResolvedColor,
  parseTokenDefinitions,
  splitBalanced,
  srgbToLinear,
} from './lib/design-token-helpers.mjs'

const rootDir = process.cwd()

// ============================================================================
// Synthetic Self-Test Suite
// ============================================================================

export async function runSelfTests() {
  console.log('=== Running Verification Tooling Self-Tests ===\n')

  const postcss = await getPostcss()

  // 1. Chromium sRGB Compositing Reference: 50% white over black
  // In Chromium/WebKit sRGB source-over: 1*0.5 + 0*0.5 = 0.5 sRGB
  // Linear luminance conversion: srgbToLinear(0.5) ~= 0.21404
  const whiteLin = [1, 1, 1]
  const blackLin = [0, 0, 0]
  const compLin50 = compositeColorsSrgb(whiteLin, 0.5, blackLin)
  const compSrgb50 = compLin50.map(linearToSrgb)
  assert.ok(
    Math.abs(compSrgb50[0] - 0.5) < 0.001,
    `50% white/black sRGB expected 0.5, got ${compSrgb50[0]}`
  )
  assert.ok(
    Math.abs(compLin50[0] - 0.214) < 0.002,
    `50% white/black linear expected ~0.214, got ${compLin50[0]}`
  )
  console.log('✔ Self-test 1: Verified Chromium sRGB source-over model (50% white/black -> sRGB 0.5, linear ~0.214)')

  // 2. Semi-transparent OKLCH tint compositing case
  const testTintLin = oklchToLinearSrgb(0.760, 0.140, 155) // success
  const testSurfLin = oklchToLinearSrgb(0.190, 0, 0) // surface
  const tintedCompLin = compositeColorsSrgb(testTintLin, 0.15, testSurfLin)
  const tintRatio = contrastRatio(testTintLin, tintedCompLin)
  assert.ok(
    tintRatio >= 4.5,
    `Semi-transparent OKLCH tint expected >= 4.5 contrast under sRGB compositing, got ${tintRatio}`
  )
  console.log(`✔ Self-test 2: Verified semi-transparent OKLCH tint compositing (ratio: ${tintRatio.toFixed(2)}:1 >= 4.5:1)`)

  // 3. Synthetic Undefined Variable
  const syntheticUndefinedVarCss = `
    .my-component {
      color: var(--some-nonexistent-token);
    }
  `
  const root3 = postcss.parse(syntheticUndefinedVarCss, { from: 'synthetic-test-3.css' })
  let violations3 = []
  root3.walkDecls((decl) => {
    violations3.push(
      ...checkDeclarationViolations({
        decl,
        filePath: 'synthetic-test-3.css',
        isTokenSource: false,
        declaredTokens: new Set(['--color-ink']),
      })
    )
  })
  assert.equal(
    violations3.some((v) => v.rule === 'no-undefined-var'),
    true,
    'Self-test failed: did not catch undefined CSS variable'
  )
  console.log('✔ Self-test 3: Successfully caught synthetic undefined variable')

  // 4. Synthetic Low Contrast
  const lowContrastTokens = {
    '--color-bg': 'oklch(0.200 0 0)',
    '--color-ink': 'oklch(0.250 0 0)',
  }
  const colorBg = parseResolvedColor(lowContrastTokens['--color-bg'])
  const colorInk = parseResolvedColor(lowContrastTokens['--color-ink'])
  const ratio = contrastRatio(colorInk.linearRgb, colorBg.linearRgb)
  assert.ok(ratio < 4.5, `Contrast ratio ${ratio} expected to be below 4.5 threshold`)
  console.log(`✔ Self-test 4: Successfully flagged low-contrast pair (ratio ${ratio.toFixed(2)} < 4.5)`)

  // 5. Synthetic !important
  const syntheticImportantCss = `
    .button {
      color: var(--color-ink) !important;
    }
  `
  const root5 = postcss.parse(syntheticImportantCss, { from: 'synthetic-test-5.css' })
  let violations5 = []
  root5.walkDecls((decl) => {
    violations5.push(
      ...checkDeclarationViolations({
        decl,
        filePath: 'synthetic-test-5.css',
        isTokenSource: false,
        declaredTokens: new Set(['--color-ink']),
      })
    )
  })
  assert.equal(
    violations5.some((v) => v.rule === 'no-important'),
    true,
    'Self-test failed: did not catch !important'
  )
  console.log('✔ Self-test 5: Successfully caught forbidden !important')

  // 6. Synthetic font-size < 11px
  const syntheticSmallFontCss = `
    .status-text {
      font-size: 9px;
    }
  `
  const root6 = postcss.parse(syntheticSmallFontCss, { from: 'synthetic-test-6.css' })
  let violations6 = []
  root6.walkDecls((decl) => {
    violations6.push(
      ...checkDeclarationViolations({
        decl,
        filePath: 'synthetic-test-6.css',
        isTokenSource: false,
        declaredTokens: new Set(),
      })
    )
  })
  assert.equal(
    violations6.some((v) => v.rule === 'min-font-size-11px'),
    true,
    'Self-test failed: did not catch font-size < 11px'
  )
  console.log('✔ Self-test 6: Successfully caught font size < 11px')

  // 7. Synthetic illegal transition & balanced comma parsing inside cubic-bezier
  const syntheticTransitionCss = `
    .panel-valid {
      transition: color 160ms cubic-bezier(0.2, 0, 0, 1), transform 220ms ease;
    }
    .panel-invalid {
      transition: height 200ms ease;
    }
  `
  const root7 = postcss.parse(syntheticTransitionCss, { from: 'synthetic-test-7.css' })
  let violations7 = []
  root7.walkRules((rule) => {
    violations7.push(
      ...checkRuleLevelViolations({
        rule,
        filePath: 'synthetic-test-7.css',
        isTokenSource: false,
      })
    )
  })
  assert.equal(
    violations7.filter((v) => v.rule === 'allowed-transitions-only').length,
    1,
    'Self-test failed: cubic-bezier comma caused false positive or height transition missed'
  )
  console.log('✔ Self-test 7: Correctly preserved cubic-bezier commas and caught invalid layout transition')

  // 8. Synthetic mixed backdrop-filter selector (.app-shell, .card) MUST fail
  const syntheticMixedBackdropCss = `
    .app-shell, .card {
      backdrop-filter: blur(20px);
    }
  `
  const root8 = postcss.parse(syntheticMixedBackdropCss, { from: 'synthetic-test-8.css' })
  let violations8 = []
  root8.walkRules((rule) => {
    const parts = splitBalanced(rule.selector, ',')
    const allMatch = parts.every((sel) =>
      BACKDROP_FILTER_WHITELIST.some((group) => group.regex.test(sel))
    )
    if (!allMatch) {
      violations8.push({ rule: 'backdrop-filter-whitelist' })
    }
  })
  assert.equal(
    violations8.length,
    1,
    'Self-test failed: mixed selector .app-shell, .card did not fail whitelist check'
  )
  console.log('✔ Self-test 8: Successfully rejected mixed backdrop-filter selector (.app-shell, .card)')

  // 9. Non-overlay subject shadow (e.g. .dialog-container input) MUST fail
  const syntheticAncestorShadowCss = `
    .dialog-container input {
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
  `
  const root9 = postcss.parse(syntheticAncestorShadowCss, { from: 'synthetic-test-9.css' })
  let violations9 = []
  root9.walkRules((rule) => {
    violations9.push(
      ...checkRuleLevelViolations({
        rule,
        filePath: 'synthetic-test-9.css',
        isTokenSource: false,
      })
    )
  })
  assert.equal(
    violations9.some((v) => v.rule === 'shadow-overlay-only'),
    true,
    'Self-test failed: did not catch shadow on input despite ancestor having dialog in selector'
  )
  console.log('✔ Self-test 9: Successfully caught shadow on dialog child element (input)')

  // 10. Variable name containing named color (e.g. var(--color-white)) MUST NOT flag
  const syntheticVarNamedColorCss = `
    .nav-item {
      color: var(--color-white);
    }
  `
  const root10 = postcss.parse(syntheticVarNamedColorCss, { from: 'synthetic-test-10.css' })
  let violations10 = []
  root10.walkDecls((decl) => {
    violations10.push(
      ...checkDeclarationViolations({
        decl,
        filePath: 'synthetic-test-10.css',
        isTokenSource: false,
        declaredTokens: new Set(['--color-white']),
      })
    )
  })
  assert.equal(
    violations10.some((v) => v.rule === 'no-color-literals'),
    false,
    'Self-test failed: var(--color-white) was falsely flagged as a named color literal'
  )
  console.log('✔ Self-test 10: Verified var(--color-white) is not falsely flagged as named color')

  // 11. Synthetic valid actual overlay/dialog/mask classes pass, non-overlay siblings fail
  const syntheticOverlayCss = `
    .add-skill-dialog {
      box-shadow: var(--elevation-overlay);
    }
    .projects-confirm {
      box-shadow: var(--elevation-overlay);
    }
    .command-panel {
      box-shadow: var(--elevation-overlay);
    }
    .permiso-panel-shell {
      box-shadow: var(--elevation-overlay);
    }
    .add-skill-dialog-sidebar {
      box-shadow: var(--elevation-overlay);
    }
  `
  const root11 = postcss.parse(syntheticOverlayCss, { from: 'synthetic-test-11.css' })
  let violations11 = []
  root11.walkRules((rule) => {
    violations11.push(
      ...checkRuleLevelViolations({
        rule,
        filePath: 'synthetic-test-11.css',
        isTokenSource: false,
      })
    )
  })
  const shadowFails = violations11.filter((v) => v.rule === 'shadow-overlay-only')
  assert.equal(
    shadowFails.length,
    1,
    'Self-test 11 failed: exactly 1 violation expected for non-overlay sibling .add-skill-dialog-sidebar'
  )
  assert.ok(
    shadowFails[0].message.includes('.add-skill-dialog-sidebar'),
    'Self-test 11 failed: non-overlay sibling .add-skill-dialog-sidebar was not flagged'
  )
  console.log('✔ Self-test 11: Verified valid actual overlay classes pass and non-overlay siblings fail')

  // 12. Synthetic valid progress classes pass width transition, non-progress fails
  const syntheticProgressCss = `
    .account-quota-bar-fill {
      transition: width 220ms ease;
    }
    .update-fill {
      transition: width 220ms ease;
    }
    .account-quota-bar-track {
      transition: width 220ms ease;
    }
  `
  const root12 = postcss.parse(syntheticProgressCss, { from: 'synthetic-test-12.css' })
  let violations12 = []
  root12.walkRules((rule) => {
    violations12.push(
      ...checkRuleLevelViolations({
        rule,
        filePath: 'synthetic-test-12.css',
        isTokenSource: false,
      })
    )
  })
  const progressFails = violations12.filter((v) => v.rule === 'allowed-transitions-only')
  assert.equal(
    progressFails.length,
    1,
    'Self-test 12 failed: exactly 1 violation expected for non-progress sibling .account-quota-bar-track'
  )
  assert.ok(
    progressFails[0].message.includes('.account-quota-bar-track'),
    'Self-test 12 failed: non-progress sibling .account-quota-bar-track was not flagged'
  )
  console.log('✔ Self-test 12: Verified valid progress classes pass width transition and non-progress fails')

  // 13. Synthetic valid primary button passes primary token, non-primary fails
  const syntheticPrimaryCss = `
    .account-btn--primary {
      background: var(--btn-primary-bg);
    }
    .account-btn--secondary {
      background: var(--btn-primary-bg);
    }
  `
  const root13 = postcss.parse(syntheticPrimaryCss, { from: 'synthetic-test-13.css' })
  let violations13 = []
  root13.walkDecls((decl) => {
    violations13.push(
      ...checkDeclarationViolations({
        decl,
        filePath: 'synthetic-test-13.css',
        isTokenSource: false,
        declaredTokens: new Set(['--btn-primary-bg']),
      })
    )
  })
  const primaryFails = violations13.filter((v) => v.rule === 'restrict-primary-token')
  assert.equal(
    primaryFails.length,
    1,
    'Self-test 13 failed: exactly 1 violation expected for .account-btn--secondary'
  )
  console.log('✔ Self-test 13: Verified genuine primary button passes and non-primary fails')

  console.log('\nAll self-tests passed cleanly!\n')
}

// ============================================================================
// Main Verification Runner
// ============================================================================

export async function verifyDesignTokens() {
  const isSelfTestOnly = process.argv.includes('--self-test-only')

  await runSelfTests()
  if (isSelfTestOnly) {
    return { pass: true, violations: [] }
  }

  console.log('=== OPC-212 Design Token & Visual Language v2 Verification ===\n')

  const allViolations = []
  const postcss = await getPostcss()

  // --------------------------------------------------------------------------
  // Check 1: Explicitly prove Desktop does NOT import legacy web-only styles.css
  // --------------------------------------------------------------------------
  console.log('--- Check 1: Desktop legacy styles.css import boundary ---')
  const desktopSrcDir = path.join(rootDir, 'apps/desktop/src')
  function scanDesktopFilesForStylesImport(dir) {
    if (!fs.existsSync(dir)) return
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scanDesktopFilesForStylesImport(fullPath)
      } else if (/\.(tsx?|jsx?|css|html)$/.test(entry.name)) {
        const content = fs.readFileSync(fullPath, 'utf8')
        const lines = content.split('\n')
        lines.forEach((line, idx) => {
          if (
            line.includes('styles.css') &&
            (line.includes('@workflow-skill/ui') ||
              line.includes('packages/ui') ||
              line.includes('ui/styles.css'))
          ) {
            allViolations.push({
              file: path.relative(rootDir, fullPath),
              line: idx + 1,
              col: 1,
              prop: 'import',
              rule: 'no-legacy-styles-import',
              message: `Desktop illegally imports legacy web-only styles.css: '${line.trim()}'`,
            })
          }
        })
      }
    }
  }
  scanDesktopFilesForStylesImport(desktopSrcDir)
  const legacyImportViolations = allViolations.filter(
    (v) => v.rule === 'no-legacy-styles-import'
  )
  if (legacyImportViolations.length === 0) {
    console.log('✔ Proved: Desktop does NOT import legacy packages/ui/src/styles.css')
  } else {
    console.log(
      `✘ Desktop imports legacy styles.css in ${legacyImportViolations.length} place(s)`
    )
  }

  // --------------------------------------------------------------------------
  // Check 2: Parse tokens.css and verify exact semantic font tokens scale
  // --------------------------------------------------------------------------
  console.log('\n--- Check 2: Source tokens & semantic font scale in tokens.css ---')
  const tokensCssPath = path.join(rootDir, 'packages/ui/src/tokens.css')
  if (!fs.existsSync(tokensCssPath)) {
    throw new Error(`tokens.css not found at ${tokensCssPath}`)
  }
  const tokensCssContent = fs.readFileSync(tokensCssPath, 'utf8')
  const {
    darkTokens,
    lightTokens,
    declaredVariables,
    typographyTokens,
  } = await parseTokenDefinitions(tokensCssContent)

  const expectedFontTokens = {
    '--text-caption': 11,
    '--text-control': 12,
    '--text-body': 13,
    '--text-section': 15,
    '--text-title': 20,
    '--text-mono': 12,
  }

  let fontScalePass = true

  // Verify exact six typography definitions (no extra, no missing)
  const definedFontTokens = Object.keys(typographyTokens)
  const expectedKeys = Object.keys(expectedFontTokens)

  for (const expectedKey of expectedKeys) {
    if (!typographyTokens[expectedKey]) {
      allViolations.push({
        file: 'packages/ui/src/tokens.css',
        line: 1,
        col: 1,
        prop: expectedKey,
        rule: 'required-font-token',
        message: `Missing required semantic font token '${expectedKey}'`,
      })
      fontScalePass = false
    } else if (typographyTokens[expectedKey].sizePx !== expectedFontTokens[expectedKey]) {
      allViolations.push({
        file: 'packages/ui/src/tokens.css',
        line: 1,
        col: 1,
        prop: expectedKey,
        rule: 'font-token-size-mismatch',
        message: `Font token '${expectedKey}' value ${typographyTokens[expectedKey].sizePx}px does not match design spec ${expectedFontTokens[expectedKey]}px`,
      })
      fontScalePass = false
    }
  }

  for (const definedKey of definedFontTokens) {
    if (!expectedFontTokens[definedKey]) {
      allViolations.push({
        file: 'packages/ui/src/tokens.css',
        line: 1,
        col: 1,
        prop: definedKey,
        rule: 'exact-font-tokens-only',
        message: `Unexpected extra font size token '${definedKey}' in tokens.css (only exact 6 allowed)`,
      })
      fontScalePass = false
    }
  }

  // Check no font token < 11px
  for (const [token, data] of Object.entries(typographyTokens)) {
    if (data.sizePx < 11) {
      allViolations.push({
        file: 'packages/ui/src/tokens.css',
        line: 1,
        col: 1,
        prop: token,
        rule: 'min-font-size-11px',
        message: `Font token '${token}' (${data.sizePx}px) is below 11px hard lower bound`,
      })
      fontScalePass = false
    }
  }

  if (fontScalePass) {
    console.log('✔ Verified: Exactly 6 semantic font size tokens defined and all >= 11px')
  }

  // --------------------------------------------------------------------------
  // Check 3: WCAG Relative Luminance & Contrast Regression (All Surfaces)
  // --------------------------------------------------------------------------
  console.log('\n--- Check 3: WCAG Relative Luminance & Contrast Regression (Both Themes & All Surfaces) ---')
  const darkContrastResults = evaluateContrastSuite('dark', darkTokens)
  const lightContrastResults = evaluateContrastSuite('light', lightTokens)
  const allContrastResults = [...darkContrastResults, ...lightContrastResults]

  let contrastFailures = 0
  for (const r of allContrastResults) {
    const status = r.pass ? 'PASS' : 'FAIL'
    const targetDesc = r.underSurface
      ? `${r.fgToken} on (${r.bgToken} over ${r.underSurface})`
      : `${r.fgToken} on ${r.bgToken}`

    console.log(
      `[${r.theme.toUpperCase()}] ${r.category}: ${targetDesc} => ${r.rawRatio ? r.rawRatio.toFixed(2) : 'ERR'}:1 (min ${r.minRatio}:1) [${status}]`
    )
    if (!r.pass) {
      contrastFailures++
      allViolations.push({
        file: 'packages/ui/src/tokens.css',
        line: 1,
        col: 1,
        prop: targetDesc,
        rule: 'contrast-ratio-fail',
        message: `[${r.theme}] Contrast violation: ${r.description} ratio ${r.rawRatio ? r.rawRatio.toFixed(2) : 'ERR'}:1 < ${r.minRatio}:1 required`,
      })
    }
  }
  console.log(
    `\nContrast check summary: ${allContrastResults.length - contrastFailures}/${allContrastResults.length} pairs passed.`
  )

  // --------------------------------------------------------------------------
  // Check 4: Scan all desktop CSS and active shared v2 CSS
  // --------------------------------------------------------------------------
  console.log('\n--- Check 4: Static AST Scan (desktop CSS + active shared v2 CSS) ---')

  const cssFilesToScan = []

  function collectCssFiles(dir, exemptFiles = []) {
    if (!fs.existsSync(dir)) return
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        collectCssFiles(fullPath, exemptFiles)
      } else if (entry.name.endsWith('.css')) {
        if (!exemptFiles.some((ex) => fullPath.endsWith(ex))) {
          cssFilesToScan.push(fullPath)
        }
      }
    }
  }

  collectCssFiles(path.join(rootDir, 'packages/ui/src'), [
    'packages/ui/src/styles.css',
  ])
  collectCssFiles(path.join(rootDir, 'apps/desktop/src'))

  console.log(`Discovered ${cssFilesToScan.length} CSS files to scan:`)
  cssFilesToScan.forEach((f) => console.log(`  - ${path.relative(rootDir, f)}`))

  let totalBackdropFilterRules = 0

  for (const filePath of cssFilesToScan) {
    const isTokenSource =
      path.resolve(filePath) === path.resolve(rootDir, 'packages/ui/src/tokens.css')
    const content = fs.readFileSync(filePath, 'utf8')
    const root = postcss.parse(content, { from: filePath })

    // Collect locally declared custom properties in file
    const locallyDeclaredProps = new Set()
    root.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) {
        locallyDeclaredProps.add(decl.prop)
      }
    })

    root.walkDecls((decl) => {
      const declViolations = checkDeclarationViolations({
        decl,
        filePath,
        isTokenSource,
        declaredTokens: declaredVariables,
        locallyDeclaredProps,
      })
      allViolations.push(...declViolations)
    })

    root.walkRules((rule) => {
      // Check backdrop-filter declaration rules
      let hasBackdrop = false
      rule.walkDecls(/^(?:-webkit-)?backdrop-filter$/, () => {
        hasBackdrop = true
      })

      if (hasBackdrop) {
        totalBackdropFilterRules++
        const selector = rule.selector || ''
        const parts = splitBalanced(selector, ',')
        const allMatch = parts.every((sel) =>
          BACKDROP_FILTER_WHITELIST.some((group) => group.regex.test(sel))
        )
        if (!allMatch) {
          allViolations.push({
            file: path.relative(rootDir, filePath),
            line: rule.source?.start?.line ?? 1,
            col: rule.source?.start?.column ?? 1,
            prop: 'backdrop-filter',
            rule: 'backdrop-filter-whitelist',
            message: `backdrop-filter selector '${selector}' has parts outside the 4 allowed whitelist groups (shell, sidebar, overlay masks, child-window roots)`,
          })
        }
      }

      const ruleViolations = checkRuleLevelViolations({
        rule,
        filePath,
        isTokenSource,
      })
      allViolations.push(...ruleViolations)
    })
  }

  // Backdrop filter count check across all files
  if (totalBackdropFilterRules > 4) {
    allViolations.push({
      file: 'apps/desktop/src',
      line: 1,
      col: 1,
      prop: 'backdrop-filter',
      rule: 'backdrop-filter-rule-count',
      message: `Total backdrop-filter declaration rules (${totalBackdropFilterRules}) exceeds maximum permitted limit of 4`,
    })
  } else {
    console.log(
      `✔ Verified: backdrop-filter declaration rules count is ${totalBackdropFilterRules} (<= 4)`
    )
  }

  // --------------------------------------------------------------------------
  // Summary & Diagnostic Reporting
  // --------------------------------------------------------------------------
  console.log('\n============================================================================')
  console.log('                        VERIFICATION REPORT SUMMARY                         ')
  console.log('============================================================================\n')

  const violationsByRule = {}
  for (const v of allViolations) {
    violationsByRule[v.rule] = (violationsByRule[v.rule] || 0) + 1
  }

  console.log(`Total Violations Found: ${allViolations.length}`)
  console.log('Breakdown by Rule:')
  for (const [ruleName, count] of Object.entries(violationsByRule)) {
    console.log(`  - ${ruleName.padEnd(28)}: ${count}`)
  }

  if (allViolations.length > 0) {
    console.log('\nDetailed Violation List (First 50 shown):')
    allViolations.slice(0, 50).forEach((v, idx) => {
      console.log(
        `[${idx + 1}] ${v.file}:${v.line}:${v.col} [${v.rule}] (${v.prop}) => ${v.message}`
      )
    })
    if (allViolations.length > 50) {
      console.log(`... and ${allViolations.length - 50} more violations.`)
    }
  }

  const pass = allViolations.length === 0
  if (pass) {
    console.log('\n✔ ALL DESIGN TOKEN & VISUAL LANGUAGE V2 CHECKS PASSED!')
  } else {
    console.log(
      '\n✘ VERIFICATION FAILED: Codebase currently contains design token / visual language violations.'
    )
  }

  return { pass, violations: allViolations }
}

const isDirectRun =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === path.resolve('scripts/verify-design-tokens.mjs') ||
    path.basename(process.argv[1]) === 'verify-design-tokens.mjs')

if (isDirectRun) {
  verifyDesignTokens()
    .then(({ pass }) => {
      if (!pass) {
        process.exitCode = 1
      }
    })
    .catch((err) => {
      console.error('Fatal error during verification:', err)
      process.exit(1)
    })
}
