import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// ============================================================================
// 1. PostCSS Dynamic Loader (Fail-Closed, No Regex Fallback)
// ============================================================================

let cachedPostcss = null

export async function getPostcss() {
  if (cachedPostcss) return cachedPostcss

  const candidateDirs = [
    path.resolve('node_modules/.pnpm'),
    path.resolve('node_modules/postcss'),
    path.resolve('apps/desktop/node_modules'),
    path.resolve('packages/ui/node_modules'),
  ]

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue
    if (dir.endsWith('.pnpm')) {
      const match = fs.readdirSync(dir).find((d) => d.startsWith('postcss@'))
      if (match) {
        const libPath = path.join(dir, match, 'node_modules/postcss/lib/postcss.js')
        if (fs.existsSync(libPath)) {
          const mod = await import(pathToFileURL(libPath).href)
          cachedPostcss = mod.default || mod
          return cachedPostcss
        }
      }
    } else {
      const libPath = path.join(dir, 'lib/postcss.js')
      if (fs.existsSync(libPath)) {
        const mod = await import(pathToFileURL(libPath).href)
        cachedPostcss = mod.default || mod
        return cachedPostcss
      }
    }
  }

  throw new Error(
    'PostCSS dependency could not be resolved from node_modules. Fail-closed: actual CSS AST parser required for design token verification.'
  )
}

// ============================================================================
// 2. Color Science: OKLCH, sRGB Compositing & WCAG 2.1 Luminance
// ============================================================================

/**
 * Chromium / WebKit Normal Source-Over Compositing Model:
 * In CSS Compositing and Blending Level 1 and CSS Color 4, normal source-over
 * alpha blending is evaluated in the device display color space (standard non-linear sRGB):
 *   Csrgb_comp = Cfg_srgb * alpha_fg + Cbg_srgb * (1 - alpha_fg)
 * For WCAG 2.1 relative luminance calculation, the resulting composited sRGB color
 * is linearized:
 *   Clin = Csrgb <= 0.04045 ? Csrgb / 12.92 : ((Csrgb + 0.055) / 1.055) ** 2.4
 *   Y = 0.2126 * Rlin + 0.7152 * Glin + 0.0722 * Blin
 *
 * Known reference validation:
 *   50% white over black in sRGB yields sRGB 0.5, which converts to linear ~0.214.
 *   (In contrast to linear-light compositing which would yield 0.5 linear light,
 *   equivalent to ~0.735 sRGB).
 */

export function oklchToLinearSrgb(L, C, H) {
  const hRad = (((H % 360) + 360) % 360 * Math.PI) / 180
  const a = C * Math.cos(hRad)
  const b = C * Math.sin(hRad)

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  const rLin = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

  // Gamut channel clamp [0, 1]
  return [
    Math.max(0, Math.min(1, rLin)),
    Math.max(0, Math.min(1, gLin)),
    Math.max(0, Math.min(1, bLin)),
  ]
}

export function linearToSrgb(c) {
  const clamped = Math.max(0, Math.min(1, c))
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
}

export function srgbToLinear(c) {
  const clamped = Math.max(0, Math.min(1, c))
  return clamped <= 0.04045
    ? clamped / 12.92
    : Math.pow((clamped + 0.055) / 1.055, 2.4)
}

export function linearSrgbToHex(rLin, gLin, bLin) {
  const R = Math.round(linearToSrgb(rLin) * 255)
  const G = Math.round(linearToSrgb(gLin) * 255)
  const B = Math.round(linearToSrgb(bLin) * 255)
  return '#' + [R, G, B].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export function relativeLuminance(rLin, gLin, bLin) {
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin
}

export function contrastRatio(rgbLin1, rgbLin2) {
  const y1 = relativeLuminance(...rgbLin1)
  const y2 = relativeLuminance(...rgbLin2)
  const lighter = Math.max(y1, y2)
  const darker = Math.min(y1, y2)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Chromium-compatible source-over sRGB compositing:
 * Composites in non-linear sRGB space, then converts result to linear sRGB
 * for luminance calculations.
 */
export function compositeColorsSrgb(fgLinearRgb, fgAlpha, bgLinearRgb) {
  const fgSrgb = fgLinearRgb.map(linearToSrgb)
  const bgSrgb = bgLinearRgb.map(linearToSrgb)

  const compSrgb = [
    fgSrgb[0] * fgAlpha + bgSrgb[0] * (1 - fgAlpha),
    fgSrgb[1] * fgAlpha + bgSrgb[1] * (1 - fgAlpha),
    fgSrgb[2] * fgAlpha + bgSrgb[2] * (1 - fgAlpha),
  ]

  return compSrgb.map(srgbToLinear)
}

// ============================================================================
// 3. String & Selector Helpers (Balanced Parentheses)
// ============================================================================

export function splitBalanced(str, delimiter = ',') {
  const parts = []
  let buffer = ''
  let depth = 0
  for (let i = 0; i < str.length; i++) {
    const c = str[i]
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    if (c === delimiter && depth === 0) {
      parts.push(buffer.trim())
      buffer = ''
    } else {
      buffer += c
    }
  }
  if (buffer.trim()) parts.push(buffer.trim())
  return parts
}

/**
 * Extracts the subject (rightmost compound selector) from a CSS selector.
 * e.g. ".dialog-container > input:focus" -> "input"
 *      ".account-modal-box" -> ".account-modal-box"
 */
export function getSelectorSubject(selector) {
  // Strip pseudo-classes and pseudo-elements
  const clean = selector.replace(/::?[a-zA-Z0-9_-]+(?:\([^)]*\))?/g, '').trim()
  // Split on whitespace or combinators (>, +, ~)
  const tokens = clean.split(/[\s>+~]+/).filter(Boolean)
  return tokens.length > 0 ? tokens[tokens.length - 1] : ''
}

// ============================================================================
// 4. Color & Token Parser
// ============================================================================

export function parseResolvedColor(rawStr, tokenDict = {}) {
  let str = (rawStr || '').trim()

  // Recursively substitute var(--xyz) anywhere in the string
  let depth = 0
  while (str.includes('var(') && depth < 10) {
    const before = str
    str = str.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g, (match, varName) => {
      if (tokenDict[varName] !== undefined) {
        return tokenDict[varName].trim()
      }
      return match
    })
    if (str === before) break
    depth++
  }

  // OKLCH: oklch(L C H) or oklch(L C H / A)
  const oklchMatch = str.match(
    /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\s\S]+?))?\s*\)$/i
  )
  if (oklchMatch) {
    const L = parseFloat(oklchMatch[1])
    const C = parseFloat(oklchMatch[2])
    const H = parseFloat(oklchMatch[3])
    let alpha = 1.0
    if (oklchMatch[4]) {
      const aStr = oklchMatch[4].trim()
      if (aStr.endsWith('%')) {
        alpha = parseFloat(aStr) / 100
      } else {
        alpha = parseFloat(aStr)
      }
    }
    const linearRgb = oklchToLinearSrgb(L, C, H)
    return { linearRgb, alpha, raw: str }
  }

  // Hex: #ffffff or #fff
  const hexMatch = str.match(/^#([0-9a-f]{3,8})$/i)
  if (hexMatch) {
    let hex = hexMatch[1]
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.split('').map((c) => c + c).join('')
    }
    const r = parseInt(hex.slice(0, 2), 16) / 255
    const g = parseInt(hex.slice(2, 4), 16) / 255
    const b = parseInt(hex.slice(4, 6), 16) / 255
    let alpha = 1.0
    if (hex.length === 8) {
      alpha = parseInt(hex.slice(6, 8), 16) / 255
    }
    return {
      linearRgb: [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)],
      alpha,
      raw: str,
    }
  }

  // rgb/rgba
  const rgbMatch = str.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i
  )
  if (rgbMatch) {
    const r = parseFloat(rgbMatch[1]) / 255
    const g = parseFloat(rgbMatch[2]) / 255
    const b = parseFloat(rgbMatch[3]) / 255
    const alpha = rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1.0
    return {
      linearRgb: [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)],
      alpha,
      raw: str,
    }
  }

  if (str === 'transparent') {
    return { linearRgb: [0, 0, 0], alpha: 0.0, raw: str }
  }
  if (str === 'white') {
    return { linearRgb: [1, 1, 1], alpha: 1.0, raw: str }
  }
  if (str === 'black') {
    return { linearRgb: [0, 0, 0], alpha: 1.0, raw: str }
  }

  return null
}

export async function parseTokenDefinitions(tokensCssContent) {
  const postcss = await getPostcss()
  const root = postcss.parse(tokensCssContent, { from: 'packages/ui/src/tokens.css' })

  const darkTokens = {}
  const lightTokens = {}
  const declaredVariables = new Set()
  const typographyTokens = {}

  root.walkRules((rule) => {
    const sel = rule.selector
    const isDark =
      sel.includes(':root') ||
      sel.includes("[data-theme='dark']") ||
      sel.includes('[data-theme="dark"]')
    const isLight =
      sel.includes("[data-theme='light']") || sel.includes('[data-theme="light"]')

    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) {
        declaredVariables.add(decl.prop)
        if (isDark) {
          darkTokens[decl.prop] = decl.value
        }
        if (isLight) {
          lightTokens[decl.prop] = decl.value
        }
        if (decl.prop.startsWith('--text-') && !decl.prop.endsWith('-lh')) {
          const pxMatch = decl.value.match(/^([\d.]+)px$/)
          if (pxMatch) {
            typographyTokens[decl.prop] = {
              sizePx: parseFloat(pxMatch[1]),
              rawValue: decl.value,
            }
          }
        }
      }
    })
  })

  // Inherit dark tokens into light if light didn't re-declare them
  for (const [key, val] of Object.entries(darkTokens)) {
    if (lightTokens[key] === undefined) {
      lightTokens[key] = val
    }
  }

  return {
    darkTokens,
    lightTokens,
    declaredVariables,
    typographyTokens,
  }
}

// ============================================================================
// 5. Full Surface WCAG 2.1 Contrast Suite
// ============================================================================

export function evaluateContrastSuite(themeName, tokens) {
  const results = []

  function getResolvedRgb(tokenName, bgTokenForAlpha = '--color-surface') {
    const raw = tokens[tokenName]
    if (!raw) return null
    const parsed = parseResolvedColor(raw, tokens)
    if (!parsed) return null
    if (parsed.alpha < 1.0) {
      const bgParsed = parseResolvedColor(tokens[bgTokenForAlpha] || 'oklch(0 0 0)', tokens)
      const comp = compositeColorsSrgb(
        parsed.linearRgb,
        parsed.alpha,
        bgParsed ? bgParsed.linearRgb : [0, 0, 0]
      )
      return { rgb: comp, alpha: 1.0, isComposited: true, raw: parsed.raw }
    }
    return { rgb: parsed.linearRgb, alpha: parsed.alpha, isComposited: false, raw: parsed.raw }
  }

  function testPair(category, fgToken, bgToken, minRatio, description, underSurfaceToken = null) {
    let fgColor
    let bgColor

    if (underSurfaceToken) {
      // Background is translucent token composited over underSurfaceToken
      const underParsed = parseResolvedColor(tokens[underSurfaceToken] || 'oklch(0 0 0)', tokens)
      const tintParsed = parseResolvedColor(tokens[bgToken], tokens)
      if (!underParsed || !tintParsed) {
        results.push({
          theme: themeName,
          category,
          fgToken,
          bgToken,
          underSurface: underSurfaceToken,
          description,
          minRatio,
          ratio: null,
          pass: false,
          error: `Could not resolve colors for tinted composite`,
        })
        return
      }
      const compLinear = compositeColorsSrgb(
        tintParsed.linearRgb,
        tintParsed.alpha,
        underParsed.linearRgb
      )
      bgColor = { rgb: compLinear }
      fgColor = getResolvedRgb(fgToken)
    } else {
      fgColor = getResolvedRgb(fgToken, bgToken)
      bgColor = getResolvedRgb(bgToken, '--color-bg')
    }

    if (!fgColor || !bgColor) {
      results.push({
        theme: themeName,
        category,
        fgToken,
        bgToken,
        description,
        minRatio,
        ratio: null,
        pass: false,
        error: `Could not resolve colors: fg=${fgToken}(${tokens[fgToken]}), bg=${bgToken}(${tokens[bgToken]})`,
      })
      return
    }

    const rawRatio = contrastRatio(fgColor.rgb, bgColor.rgb)
    const pass = rawRatio >= minRatio
    results.push({
      theme: themeName,
      category,
      fgToken,
      bgToken,
      underSurface: underSurfaceToken || null,
      description,
      minRatio,
      ratio: Math.round(rawRatio * 100) / 100,
      rawRatio,
      pass,
    })
  }

  const ALL_SURFACES = [
    '--color-bg',
    '--color-canvas',
    '--color-surface',
    '--color-surface-raised',
    '--color-rail',
  ]

  // 1. Normal text >= 4.5 across semantic backgrounds
  const textTokens = ['--color-ink', '--color-muted']
  for (const fg of textTokens) {
    for (const bg of ALL_SURFACES) {
      testPair('Normal Text', fg, bg, 4.5, `Normal text ${fg} on ${bg}`)
    }
  }

  // 2. Subtle decorative >= 3.0 on all supported surfaces
  for (const bg of ALL_SURFACES) {
    testPair('Subtle Decorative', '--color-subtle', bg, 3.0, `Subtle decorative --color-subtle on ${bg}`)
  }

  // 3. Placeholder on base / hover / focus >= 4.5
  const controlBgs = ['--control-bg', '--control-bg-hover', '--control-bg-focus']
  for (const bg of controlBgs) {
    testPair('Placeholder', '--control-placeholder', bg, 4.5, `Placeholder --control-placeholder on ${bg}`)
  }

  // 4. Primary white text default + hover >= 4.5
  testPair(
    'Primary Action Button Text',
    '--btn-primary-text',
    '--color-primary',
    4.5,
    'Primary text on --color-primary'
  )
  testPair(
    'Primary Action Button Text',
    '--btn-primary-text',
    '--btn-primary-bg',
    4.5,
    'Primary text on --btn-primary-bg'
  )
  testPair(
    'Primary Action Button Text',
    '--btn-primary-text',
    '--btn-primary-hover',
    4.5,
    'Primary text on --btn-primary-hover'
  )

  // 5. Status fg on base surfaces (>= 4.5) and tinted bg over all supported surfaces (>= 4.5)
  const statuses = [
    { fg: '--color-success', bg: '--color-success-bg' },
    { fg: '--color-waiting', bg: '--color-waiting-bg' },
    { fg: '--color-danger', bg: '--color-danger-bg' },
  ]

  for (const s of statuses) {
    for (const base of ALL_SURFACES) {
      testPair('Status Base Surface', s.fg, base, 4.5, `Status fg ${s.fg} on base surface ${base}`)
      testPair(
        'Status Tinted Surface',
        s.fg,
        s.bg,
        4.5,
        `Status fg ${s.fg} on tinted bg ${s.bg} over ${base}`,
        base
      )
    }
  }

  // 6. Control borders normal / hover / focus vs backgrounds >= 3.0
  for (const bg of ALL_SURFACES) {
    testPair('Control Border Normal', '--control-border', bg, 3.0, `Control border --control-border on ${bg}`)
  }
  testPair(
    'Control Border Hover',
    '--control-border-hover',
    '--control-bg-hover',
    3.0,
    'Control border hover on hover bg'
  )
  testPair(
    'Control Border Focus',
    '--control-border-focus',
    '--control-bg-focus',
    3.0,
    'Control border focus on focus bg'
  )

  return results
}

// ============================================================================
// 6. Static AST Rule & Constraint Checkers
// ============================================================================

export const OBSERVED_RUNTIME_GEOMETRY_VARS = new Set([
  '--master-column-width',
  '--sidebar-width',
])

export const ALLOWED_TRANSITION_PROPERTIES = new Set([
  'color',
  'background-color',
  'border-color',
  'opacity',
  'transform',
])

export const OVERLAY_CONTAINER_REGEX = /(?:dialog-(?:container|box|surface|window)|modal-(?:box|container|surface|window)|overlay-(?:container|surface|box)|popup|popover|dropdown(?:-menu|-panel)?|toast|tooltip|context-menu|command-palette|^\.add-skill-dialog$|^\.projects-confirm$|^\.command-panel$|^\.permiso-panel-shell$|^\.link-window-shell$)/i

export const PROGRESS_SELECTOR_REGEX = /(?:progress|meter|loading-bar|progress-bar|\[role=["']?progressbar["']?\]|^\.account-quota-bar-fill$|^\.update-fill$)/i

export const BACKDROP_FILTER_WHITELIST = [
  { name: 'Shell', regex: /\.app-shell\b/ },
  { name: 'Sidebar', regex: /\.app-sidebar\b/ },
  {
    name: 'Overlay masks',
    regex: /(?:dialog-overlay|modal-backdrop|overlay-mask|perm-dialog-overlay|\[data-overlay\]|\.modal-backdrop|\.modal-overlay|\.skill-drawer-overlay|\.account-modal-overlay|\.mcp-dialog-overlay|dialog::backdrop)/,
  },
  {
    name: 'Child-window roots',
    regex: /(?:SkillLinkManagerWindow|PermisoOverlay|\.child-window|\.window-root|\.permiso-panel-shell|\.link-window-shell)/,
  },
]

export const BANNED_REMOVED_TOKEN_REGEX = /--(?:color-)?(?:accent(?:-subtle|-hover)?|primary-subtle)\b/

export const FUNCTIONAL_COLOR_LITERAL_REGEX = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\s*\(/i

export const NAMED_COLOR_KEYWORDS = new Set([
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'gray',
  'grey',
  'purple',
  'orange',
  'pink',
  'cyan',
  'magenta',
])

export const ALLOWED_COLOR_KEYWORDS = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'none',
])

export function checkDeclarationViolations({
  decl,
  filePath,
  isTokenSource,
  declaredTokens,
  locallyDeclaredProps = new Set(),
}) {
  const violations = []
  const file = path.relative(process.cwd(), filePath)
  const line = decl.source?.start?.line ?? 1
  const col = decl.source?.start?.column ?? 1
  const prop = decl.prop
  const val = decl.value

  // 1. !important
  if (decl.important) {
    violations.push({
      file,
      line,
      col,
      prop,
      rule: 'no-important',
      message: `Forbidden '!important' flag on '${prop}: ${val}'`,
    })
  }

  // 2. Banned removed tokens
  if (BANNED_REMOVED_TOKEN_REGEX.test(prop) || BANNED_REMOVED_TOKEN_REGEX.test(val)) {
    violations.push({
      file,
      line,
      col,
      prop,
      rule: 'no-removed-tokens',
      message: `Reference or declaration of removed token found in '${prop}: ${val}'`,
    })
  }

  // 3. Undefined var() references
  const varMatches = val.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)
  for (const m of varMatches) {
    const varName = m[1]
    if (
      !declaredTokens.has(varName) &&
      !locallyDeclaredProps.has(varName) &&
      !OBSERVED_RUNTIME_GEOMETRY_VARS.has(varName)
    ) {
      violations.push({
        file,
        line,
        col,
        prop,
        rule: 'no-undefined-var',
        message: `Undefined CSS variable reference '${varName}' in '${prop}: ${val}'`,
      })
    }
  }

  // 4. Token redeclaration in modules outside tokens.css
  if (!isTokenSource && prop.startsWith('--')) {
    if (
      prop.startsWith('--color-') ||
      prop.startsWith('--btn-') ||
      prop.startsWith('--control-') ||
      prop.startsWith('--state-') ||
      prop.startsWith('--text-') ||
      prop.startsWith('--font-') ||
      prop.startsWith('--elevation-') ||
      prop === '--focus-ring'
    ) {
      violations.push({
        file,
        line,
        col,
        prop,
        rule: 'no-token-redeclaration',
        message: `Token redeclaration forbidden in modules: '${prop}'`,
      })
    }
  }

  // 5. Numeric font-size outside tokens.css
  if (!isTokenSource) {
    if (prop === 'font-size') {
      if (!val.startsWith('var(--text-') && !['inherit', 'initial', 'unset'].includes(val)) {
        violations.push({
          file,
          line,
          col,
          prop,
          rule: 'no-numeric-font-size',
          message: `Numeric font-size outside tokens.css: '${prop}: ${val}' (must use var(--text-*))`,
        })
      }
    } else if (prop === 'font') {
      if (/\b\d+(?:px|rem|em|pt)\b/.test(val)) {
        violations.push({
          file,
          line,
          col,
          prop,
          rule: 'no-font-shorthand-size',
          message: `Numeric font size in font shorthand outside tokens.css: '${prop}: ${val}'`,
        })
      }
    }
  }

  // Check < 11px font sizes anywhere
  const pxSizes = val.matchAll(/\b([\d.]+)px\b/g)
  for (const px of pxSizes) {
    const num = parseFloat(px[1])
    if (
      (prop.includes('font') || prop.startsWith('--text-')) &&
      num < 11 &&
      !prop.endsWith('-lh')
    ) {
      violations.push({
        file,
        line,
        col,
        prop,
        rule: 'min-font-size-11px',
        message: `Font size ${num}px is below 11px hard lower bound in '${prop}: ${val}'`,
      })
    }
  }

  // 6. Color literals outside tokens.css
  if (!isTokenSource) {
    const isColorProp =
      prop.includes('color') ||
      prop.includes('background') ||
      prop.includes('border') ||
      prop.includes('outline') ||
      prop === 'fill' ||
      prop === 'stroke' ||
      prop.includes('shadow')

    if (isColorProp) {
      // Strip url(...) to avoid SVG hash / data URL false positives
      const cleanVal = val.replace(/url\([^)]+\)/gi, '')

      // Hex literals: #...
      if (/#[0-9a-fA-F]{3,8}\b/.test(cleanVal)) {
        violations.push({
          file,
          line,
          col,
          prop,
          rule: 'no-color-literals',
          message: `Hex color literal outside tokens.css: '${prop}: ${val}'`,
        })
      }

      // Functional color literals: rgb/rgba/hsl/hsla/oklch/oklab/lab/lch/color
      if (FUNCTIONAL_COLOR_LITERAL_REGEX.test(cleanVal)) {
        violations.push({
          file,
          line,
          col,
          prop,
          rule: 'no-color-literals',
          message: `Functional color literal outside tokens.css: '${prop}: ${val}'`,
        })
      }

      // color-mix with literal operands
      if (/\bcolor-mix\s*\(/i.test(cleanVal)) {
        const withoutVars = cleanVal.replace(/var\([^()]*\)/g, '')
        if (
          /#[0-9a-fA-F]{3,8}\b/.test(withoutVars) ||
          FUNCTIONAL_COLOR_LITERAL_REGEX.test(withoutVars) ||
          Array.from(NAMED_COLOR_KEYWORDS).some((k) =>
            new RegExp(`\\b${k}\\b`, 'i').test(withoutVars)
          )
        ) {
          violations.push({
            file,
            line,
            col,
            prop,
            rule: 'no-color-literals',
            message: `color-mix with color literal operands outside tokens.css: '${prop}: ${val}'`,
          })
        }
      }

      // Named color literals: strip all var() references FIRST
      let valWithoutVars = cleanVal
      let vDepth = 0
      while (valWithoutVars.includes('var(') && vDepth < 10) {
        const before = valWithoutVars
        valWithoutVars = valWithoutVars.replace(/var\([^()]*\)/g, '')
        if (valWithoutVars === before) break
        vDepth++
      }

      const words = valWithoutVars.toLowerCase().match(/[a-z0-9-]+/g) || []
      for (const word of words) {
        if (NAMED_COLOR_KEYWORDS.has(word) && !ALLOWED_COLOR_KEYWORDS.has(word)) {
          violations.push({
            file,
            line,
            col,
            prop,
            rule: 'no-color-literals',
            message: `Named color literal '${word}' outside tokens.css: '${prop}: ${val}'`,
          })
        }
      }
    }
  }

  // 7. Restrict --color-primary / --btn-primary-bg / --btn-primary-hover / --btn-primary-text
  if (!isTokenSource) {
    const hasPrimaryToken =
      val.includes('--color-primary') ||
      val.includes('--btn-primary-bg') ||
      val.includes('--btn-primary-hover') ||
      val.includes('--btn-primary-text')

    if (hasPrimaryToken) {
      const fullSelector = decl.parent?.selector || ''
      const selectorParts = splitBalanced(fullSelector, ',')
      const isPrimaryButton = selectorParts.every((sel) =>
        /(?:\.btn-primary|\.btn--primary|\.account-btn--primary|button\.primary|\[data-variant=["']?primary["']?\])/i.test(
          sel
        )
      )

      if (!isPrimaryButton) {
        violations.push({
          file,
          line,
          col,
          prop,
          rule: 'restrict-primary-token',
          message: `Primary color token '${val}' used outside primary button selector: '${fullSelector}'`,
        })
      }

      // Distinguish fill vs text: primary color token cannot be used as text color
      // Note: --btn-primary-text is the authorized text color for primary buttons
      if (prop === 'color' && !val.includes('--btn-primary-text')) {
        violations.push({
          file,
          line,
          col,
          prop,
          rule: 'no-primary-text-color',
          message: `Primary color token used for text color on '${fullSelector}': '${prop}: ${val}' (only fill/border allowed)`,
        })
      }
    }
  }

  return violations
}

export function checkRuleLevelViolations({ rule, filePath, isTokenSource }) {
  const violations = []
  const file = path.relative(process.cwd(), filePath)
  const line = rule.source?.start?.line ?? 1
  const col = rule.source?.start?.column ?? 1
  const selector = rule.selector || ''
  const individualSelectors = splitBalanced(selector, ',')

  // 1. Shadows: box-shadow non-none only on overlay containers
  // Validate EACH comma-separated selector. Do not allow ancestor match to cover button/input.
  rule.walkDecls(/^(?:-webkit-)?box-shadow$/, (decl) => {
    const val = decl.value.trim().toLowerCase()
    const isReset =
      val === 'none' ||
      val === '0 0 0 0 transparent' ||
      val === '0 0' ||
      val === '0 0 0 0'
    if (!isReset) {
      for (const sel of individualSelectors) {
        const subject = getSelectorSubject(sel)
        if (!OVERLAY_CONTAINER_REGEX.test(subject)) {
          violations.push({
            file,
            line: decl.source?.start?.line ?? line,
            col: decl.source?.start?.column ?? col,
            prop: decl.prop,
            rule: 'shadow-overlay-only',
            message: `Non-none box-shadow on non-overlay selector '${sel}' (subject: '${subject}'): '${decl.prop}: ${decl.value}'`,
          })
          break
        }
      }
    }
  })

  // 2. Allowed transitions: split comma-separated items with balanced parentheses
  rule.walkDecls(/^transition(?:-property)?$/, (decl) => {
    const val = decl.value.trim().toLowerCase()
    const parts = splitBalanced(val, ',')
    for (const part of parts) {
      const tokens = part.trim().split(/\s+/)
      const targetProp = tokens[0]
      if (!targetProp || targetProp === 'none') continue

      if (targetProp === 'all') {
        violations.push({
          file,
          line: decl.source?.start?.line ?? line,
          col: decl.source?.start?.column ?? col,
          prop: decl.prop,
          rule: 'allowed-transitions-only',
          message: `Transition 'all' is forbidden on '${selector}'`,
        })
        continue
      }

      if (targetProp === 'width') {
        const isProgress = individualSelectors.every((sel) =>
          PROGRESS_SELECTOR_REGEX.test(sel)
        )
        if (!isProgress) {
          violations.push({
            file,
            line: decl.source?.start?.line ?? line,
            col: decl.source?.start?.column ?? col,
            prop: decl.prop,
            rule: 'allowed-transitions-only',
            message: `Transition on 'width' is only permitted on explicit progress selectors, found on '${selector}'`,
          })
        }
      } else if (!ALLOWED_TRANSITION_PROPERTIES.has(targetProp)) {
        violations.push({
          file,
          line: decl.source?.start?.line ?? line,
          col: decl.source?.start?.column ?? col,
          prop: decl.prop,
          rule: 'allowed-transitions-only',
          message: `Forbidden transition property '${targetProp}' on '${selector}'`,
        })
      }
    }
  })

  return violations
}
