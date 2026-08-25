import fs from 'fs';
import path from 'path';

// Let's create clean, robust, zero-dependency SVG React components for AIToolLogo.tsx
const code = `import React from 'react'

export function AIToolLogo({
  toolId,
  size = 18,
  color = true,
  className,
}: {
  toolId: string
  size?: number
  color?: boolean
  className?: string
}) {
  const normalized = (toolId || '').toLowerCase()

  if (normalized.includes('claude')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path
          d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
          fill={color ? "#D97757" : "currentColor"}
        />
      </svg>
    )
  }

  if (normalized.includes('cursor')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path
          d="M21.572 6.84L12.44 1.57a.89.89 0 0 0-.88 0L2.428 6.84a.885.885 0 0 0-.443.766v10.537c0 .316.168.608.443.766l9.132 5.271a.89.89 0 0 0 .88 0l9.132-5.271a.885.885 0 0 0 .443-.766V7.606a.885.885 0 0 0-.443-.766zM12 3.109l7.747 4.472-7.747 4.473-7.747-4.473L12 3.109zm-8.253 6.01L11.25 13.36v8.281L3.747 17.4V9.119zm9.75 12.522v-8.281l7.503-4.241v8.281l-7.503 4.241z"
          fill={color ? "#000000" : "currentColor"}
          style={color ? { filter: 'drop-shadow(0 0 1px rgba(255,255,255,0.4))' } : undefined}
        />
        {color ? (
          <path
            d="M12 3.109l7.747 4.472-7.747 4.473-7.747-4.473L12 3.109z"
            fill="#5E5CE6"
            opacity="0.85"
          />
        ) : null}
      </svg>
    )
  }

  if (normalized.includes('windsurf')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path
          d="M19.74 3.75C17.65 2.12 14.88 1.5 12 1.5c-4.2 0-7.9 1.7-10.5 4.5-.4.44-.35 1.12.1 1.5.45.4 1.13.35 1.53-.1C5.4 4.85 8.5 3.5 12 3.5c2.3 0 4.5.6 6.2 1.8 1.8 1.3 3 3.1 3.5 5.2.14.6.7.98 1.3.85.6-.13 1-.7.85-1.3-.6-2.6-2.1-4.8-4.11-6.3zM2.8 12.7c.6.1 1.15-.3 1.25-.9.4-2.4 1.9-4.4 4-5.5 2.1-1.1 4.6-1.1 6.8-.2.55.24 1.2 0 1.4-.55.25-.55 0-1.2-.55-1.4-2.8-1.2-6-.1-8.7 1.3-2.6 1.4-4.5 3.9-5 6.9-.1.6.3 1.15.9 1.25zM12 7.5c-2.5 0-4.5 2-4.5 4.5 0 1.2.5 2.3 1.3 3.2L6.4 19.3c-.4.4-.4 1 0 1.4.2.2.5.3.7.3s.5-.1.7-.3l2.4-2.4c.6.3 1.2.4 1.8.4 2.5 0 4.5-2 4.5-4.5s-2-4.5-4.5-4.5zm0 7c-1.4 0-2.5-1.1-2.5-2.5s1.1-2.5 2.5-2.5 2.5 1.1 2.5 2.5-1.1 2.5-2.5 2.5z"
          fill={color ? "#09B6A2" : "currentColor"}
        />
      </svg>
    )
  }

  if (normalized.includes('trae')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path
          d="M12 2L2 7.5v9L12 22l10-5.5v-9L12 2zm0 2.3l7.5 4.1L12 12.5 4.5 8.4 12 4.3zM4 9.8l7 3.9v7.4l-7-3.9V9.8zm9 11.3v-7.4l7-3.9v7.4l-7 3.9z"
          fill={color ? "#10B981" : "currentColor"}
        />
        {color ? (
          <path d="M12 4.3l7.5 4.1L12 12.5 4.5 8.4 12 4.3z" fill="#34D399" />
        ) : null}
      </svg>
    )
  }

  if (normalized.includes('antigravity') || normalized.includes('gemini')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <defs>
          <linearGradient id="geminiGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#1BA1E3" />
            <stop offset="50%" stopColor="#5468FF" />
            <stop offset="100%" stopColor="#BD34FE" />
          </linearGradient>
        </defs>
        <path
          d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12z"
          fill={color ? "url(#geminiGrad)" : "currentColor"}
        />
      </svg>
    )
  }

  if (normalized.includes('cline')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <rect x="3" y="5" width="18" height="14" rx="4" fill={color ? "#3B82F6" : "currentColor"} />
        <circle cx="8.5" cy="11.5" r="2" fill="#FFFFFF" />
        <circle cx="15.5" cy="11.5" r="2" fill="#FFFFFF" />
        <rect x="7" y="15" width="10" height="1.5" rx="0.75" fill="#FFFFFF" />
        <path d="M12 2v3M9 2h6" stroke={color ? "#3B82F6" : "currentColor"} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }

  if (normalized.includes('roo')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path
          d="M12 3C8.5 3 6 5.5 6 9c0 2 .8 3.8 2.2 5.1L7 21h10l-1.2-6.9C17.2 12.8 18 11 18 9c0-3.5-2.5-6-6-6z"
          fill={color ? "#F59E0B" : "currentColor"}
        />
        <circle cx="9.5" cy="8.5" r="1.5" fill="#FFFFFF" />
        <circle cx="14.5" cy="8.5" r="1.5" fill="#FFFFFF" />
        <path d="M10 13c1 .8 3 .8 4 0" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }

  if (normalized.includes('codex') || normalized.includes('openai')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path
          d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zM8.307 13.628l2.457-1.417 2.457 1.417v2.834l-2.457 1.417-2.457-1.417v-2.834z"
          fill={color ? "#10A37F" : "currentColor"}
        />
      </svg>
    )
  }

  if (normalized.includes('copilot')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path
          d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.53 1.03 1.53 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"
          fill={color ? "#238636" : "currentColor"}
        />
      </svg>
    )
  }

  // Default LobeHub
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <defs>
        <linearGradient id="lobeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#EB791E" />
          <stop offset="50%" stopColor="#F44341" />
          <stop offset="100%" stopColor="#8E3FE9" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="10" fill={color ? "url(#lobeGrad)" : "currentColor"} />
      <path d="M7 12a5 5 0 0 1 10 0 5 5 0 0 1-10 0z" fill="#FFFFFF" opacity="0.9" />
    </svg>
  )
}
`

fs.writeFileSync('apps/desktop/src/AIToolLogo.tsx', code, 'utf8');
console.log("Successfully wrote clean AIToolLogo.tsx!");
