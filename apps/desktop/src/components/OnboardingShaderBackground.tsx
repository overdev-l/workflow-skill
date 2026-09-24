import { useEffect, useRef, useState, type JSX } from 'react';
import './OnboardingShaderBackground.css';

export interface OnboardingShaderBackgroundProps {
  className?: string;
}

// Fallback RGB defaults (from packages/ui/src/styles.css dark theme palette)
// Line 6:  --color-bg: oklch(0.120 0.004 250)
// Line 8:  --color-canvas: oklch(0.145 0.005 250)
// Line 9:  --color-surface: oklch(0.175 0.006 250)
// Line 23: --color-primary: oklch(0.580 0.200 250)
// Line 26: --color-accent: oklch(0.780 0.130 210)
const DEFAULT_PALETTE = {
  bg: [0.019, 0.023, 0.027] as [number, number, number],
  canvas: [0.034, 0.040, 0.048] as [number, number, number],
  surface: [0.057, 0.066, 0.075] as [number, number, number],
  primary: [0.0, 0.481, 0.916] as [number, number, number],
  accent: [0.133, 0.805, 0.898] as [number, number, number],
};

function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;

  const rLinear = +4.0767434036 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const gLinear = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bLinear = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;

  const toGamma = (val: number) => {
    const clamped = Math.max(0, Math.min(1, val));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  };

  return [toGamma(rLinear), toGamma(gLinear), toGamma(bLinear)];
}

function parseCssColor(colorStr: string, fallback: [number, number, number]): [number, number, number] {
  if (!colorStr) return fallback;
  const trimmed = colorStr.trim();
  const oklchMatch = trimmed.match(
    /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?(?:\s*\/\s*[\d.]+%?)?\s*\)/i
  );
  if (oklchMatch) {
    let l = parseFloat(oklchMatch[1]);
    if (oklchMatch[1].endsWith('%')) l /= 100;
    const c = parseFloat(oklchMatch[2]);
    const h = parseFloat(oklchMatch[3]);
    if (!Number.isNaN(l) && !Number.isNaN(c) && !Number.isNaN(h)) {
      return oklchToRgb(l, c, h);
    }
  }

  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return [r, g, b];
      }
    }
  }

  const rgbMatch = trimmed.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgbMatch) {
    const r = parseFloat(rgbMatch[1]) / 255;
    const g = parseFloat(rgbMatch[2]) / 255;
    const b = parseFloat(rgbMatch[3]) / 255;
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return [r, g, b];
    }
  }

  return fallback;
}

function getThemeColors(element: HTMLElement | null) {
  if (typeof window === 'undefined') return DEFAULT_PALETTE;
  try {
    const computed = window.getComputedStyle(element || document.documentElement);
    return {
      bg: parseCssColor(computed.getPropertyValue('--color-bg'), DEFAULT_PALETTE.bg),
      canvas: parseCssColor(computed.getPropertyValue('--color-canvas'), DEFAULT_PALETTE.canvas),
      surface: parseCssColor(computed.getPropertyValue('--color-surface'), DEFAULT_PALETTE.surface),
      primary: parseCssColor(computed.getPropertyValue('--color-primary'), DEFAULT_PALETTE.primary),
      accent: parseCssColor(computed.getPropertyValue('--color-accent'), DEFAULT_PALETTE.accent),
    };
  } catch {
    return DEFAULT_PALETTE;
  }
}

const VERTEX_SHADER_SRC = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SRC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 v_uv;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_colorBg;
uniform vec3 u_colorCanvas;
uniform vec3 u_colorSurface;
uniform vec3 u_colorPrimary;
uniform vec3 u_colorAccent;

vec2 hash(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(dot(hash(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
        dot(hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
    mix(dot(hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
        dot(hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.87758, 0.47942, -0.47942, 0.87758);
  for (int i = 0; i < 4; ++i) {
    v += a * noise(p);
    p = rot * p * 2.0 + vec2(100.0);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 st = (uv - 0.5) * vec2(aspect, 1.0);

  // Very slow, subtle domain warping
  float t = u_time * 0.05;
  vec2 q = vec2(fbm(st + vec2(0.0, t * 0.25)), fbm(st + vec2(5.2, 1.3 - t * 0.2)));
  vec2 r = vec2(fbm(st + 3.0 * q + vec2(1.7, 9.2 + t * 0.3)), fbm(st + 3.0 * q + vec2(8.3, 2.8 - t * 0.25)));
  float f = fbm(st + 2.5 * r);

  float n = clamp((f + 0.5) * 0.8, 0.0, 1.0);

  vec3 col = mix(u_colorBg, u_colorCanvas, uv.y * 0.6 + 0.2);
  col = mix(col, u_colorSurface, smoothstep(0.25, 0.75, n) * 0.35);

  float primaryMask = smoothstep(0.4, 0.9, length(q)) * 0.15;
  col = mix(col, u_colorPrimary, primaryMask);

  float accentMask = smoothstep(0.5, 0.95, length(r)) * 0.10;
  col = mix(col, u_colorAccent, accentMask);

  float vignette = smoothstep(1.5, 0.3, length(st));
  col *= (0.88 + 0.12 * vignette);

  gl_FragColor = vec4(col, 1.0);
}
`;

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(
  gl: WebGLRenderingContext,
  vertShader: WebGLShader,
  fragShader: WebGLShader
): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertShader);
  gl.attachShader(program, fragShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

export function OnboardingShaderBackground({ className }: { className?: string }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [useFallback, setUseFallback] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let gl: WebGLRenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let vertShader: WebGLShader | null = null;
    let fragShader: WebGLShader | null = null;
    let posBuffer: WebGLBuffer | null = null;
    let rafId: number | null = null;
    let isRunning = false;
    let lastTimestamp = performance.now();
    let elapsedTime = 0.0;
    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    let motionMediaQuery: MediaQueryList | null = null;
    let prefersReducedMotion = false;
    let currentColors = getThemeColors(container);

    const safeCleanup = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      isRunning = false;

      if (gl) {
        try {
          if (!gl.isContextLost()) {
            if (posBuffer) gl.deleteBuffer(posBuffer);
            if (program) gl.deleteProgram(program);
            if (vertShader) gl.deleteShader(vertShader);
            if (fragShader) gl.deleteShader(fragShader);
          }
        } catch {
          // Swallow any error during WebGL resource teardown
        }
      }
    };

    const triggerFallback = () => {
      safeCleanup();
      setUseFallback(true);
    };

    try {
      if (typeof window !== 'undefined' && window.matchMedia) {
        motionMediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        prefersReducedMotion = motionMediaQuery.matches;
      }
    } catch {
      prefersReducedMotion = false;
    }

    try {
      gl = (canvas.getContext('webgl', {
        alpha: false,
        depth: false,
        stencil: false,
        antialias: false,
        powerPreference: 'low-power',
      }) || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;

      if (!gl) {
        triggerFallback();
        return;
      }

      vertShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
      fragShader = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
      if (!vertShader || !fragShader) {
        triggerFallback();
        return;
      }

      program = createProgram(gl, vertShader, fragShader);
      if (!program) {
        triggerFallback();
        return;
      }

      gl.useProgram(program);

      posBuffer = gl.createBuffer();
      if (!posBuffer) {
        triggerFallback();
        return;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
      const positions = new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1,
      ]);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

      const aPositionLoc = gl.getAttribLocation(program, 'a_position');
      if (aPositionLoc === -1) {
        triggerFallback();
        return;
      }
      gl.enableVertexAttribArray(aPositionLoc);
      gl.vertexAttribPointer(aPositionLoc, 2, gl.FLOAT, false, 0, 0);

      const uResolutionLoc = gl.getUniformLocation(program, 'u_resolution');
      const uTimeLoc = gl.getUniformLocation(program, 'u_time');
      const uColorBgLoc = gl.getUniformLocation(program, 'u_colorBg');
      const uColorCanvasLoc = gl.getUniformLocation(program, 'u_colorCanvas');
      const uColorSurfaceLoc = gl.getUniformLocation(program, 'u_colorSurface');
      const uColorPrimaryLoc = gl.getUniformLocation(program, 'u_colorPrimary');
      const uColorAccentLoc = gl.getUniformLocation(program, 'u_colorAccent');

      const applyUniforms = (width: number, height: number, time: number) => {
        if (!gl || gl.isContextLost()) return;
        gl.uniform2f(uResolutionLoc, width, height);
        gl.uniform1f(uTimeLoc, time);
        gl.uniform3fv(uColorBgLoc, currentColors.bg);
        gl.uniform3fv(uColorCanvasLoc, currentColors.canvas);
        gl.uniform3fv(uColorSurfaceLoc, currentColors.surface);
        gl.uniform3fv(uColorPrimaryLoc, currentColors.primary);
        gl.uniform3fv(uColorAccentLoc, currentColors.accent);
      };

      const renderFrame = () => {
        if (!gl || gl.isContextLost()) return;
        gl.viewport(0, 0, canvas.width, canvas.height);
        applyUniforms(canvas.width, canvas.height, elapsedTime);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      };

      const renderLoop = (now: number) => {
        if (!isRunning) return;
        const delta = Math.min((now - lastTimestamp) * 0.001, 0.1);
        lastTimestamp = now;
        elapsedTime += delta;
        try {
          renderFrame();
        } catch {
          triggerFallback();
          return;
        }
        rafId = requestAnimationFrame(renderLoop);
      };

      const startLoop = () => {
        if (isRunning || prefersReducedMotion) return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        isRunning = true;
        lastTimestamp = performance.now();
        rafId = requestAnimationFrame(renderLoop);
      };

      const stopLoop = () => {
        if (!isRunning) return;
        isRunning = false;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      };

      const updateSize = () => {
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        const newWidth = Math.max(1, Math.floor(rect.width * dpr));
        const newHeight = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== newWidth || canvas.height !== newHeight) {
          canvas.width = newWidth;
          canvas.height = newHeight;
        }
        if (!isRunning) {
          try {
            renderFrame();
          } catch {
            triggerFallback();
          }
        }
      };

      const handleContextLost = (e: Event) => {
        e.preventDefault();
        triggerFallback();
      };
      canvas.addEventListener('webglcontextlost', handleContextLost, false);

      const handleBlur = () => {
        stopLoop();
      };
      const handleFocus = () => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          startLoop();
        }
      };
      const handleVisibilityChange = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
          startLoop();
        } else {
          stopLoop();
        }
      };
      window.addEventListener('blur', handleBlur);
      window.addEventListener('focus', handleFocus);
      document.addEventListener('visibilitychange', handleVisibilityChange);

      const handleMotionPreference = (e: MediaQueryListEvent) => {
        prefersReducedMotion = e.matches;
        if (prefersReducedMotion) {
          stopLoop();
          try {
            renderFrame();
          } catch {
            triggerFallback();
          }
        } else {
          startLoop();
        }
      };
      motionMediaQuery?.addEventListener('change', handleMotionPreference);

      if (typeof MutationObserver !== 'undefined') {
        themeObserver = new MutationObserver(() => {
          currentColors = getThemeColors(container);
          if (!isRunning) {
            try {
              renderFrame();
            } catch {
              triggerFallback();
            }
          }
        });
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme', 'class', 'style'],
        });
      }

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          updateSize();
        });
        resizeObserver.observe(container);
      } else {
        window.addEventListener('resize', updateSize);
      }

      updateSize();
      if (prefersReducedMotion) {
        try {
          renderFrame();
        } catch {
          triggerFallback();
        }
      } else {
        startLoop();
      }

      return () => {
        canvas.removeEventListener('webglcontextlost', handleContextLost);
        window.removeEventListener('blur', handleBlur);
        window.removeEventListener('focus', handleFocus);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        motionMediaQuery?.removeEventListener('change', handleMotionPreference);
        if (themeObserver) themeObserver.disconnect();
        if (resizeObserver) {
          resizeObserver.disconnect();
        } else {
          window.removeEventListener('resize', updateSize);
        }
        safeCleanup();
      };
    } catch {
      triggerFallback();
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className={['onboarding-shader-bg', className].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      <div className="onboarding-shader-bg__fallback" />
      {!useFallback && (
        <canvas
          ref={canvasRef}
          className="onboarding-shader-bg__canvas"
        />
      )}
      <div className="onboarding-shader-bg__overlay" />
    </div>
  );
}
