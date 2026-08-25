import { createFileRoute } from '@tanstack/react-router'
import { ArrowRight, Check, GitBranch, Layers3, LockKeyhole, Pause, Sparkles } from 'lucide-react'

export const Route = createFileRoute('/')({ component: LandingPage })

function WorkflowPreview() {
  return (
    <div className="workflow-preview" aria-label="工作流发现预览">
      <div className="preview-topbar">
        <div><strong>Trace</strong><span className="observing-dot" />观察中</div>
        <button type="button"><Pause size={14} />暂停</button>
      </div>
      <div className="preview-body">
        <span className="eyebrow">刚刚发现</span>
        <h3>整理周报并发送</h3>
        <p>在 5 次会话中识别到相同模式</p>
        <div className="preview-canvas">
          <div className="node">选择本周文件</div><span>→</span>
          <div className="node node--split"><GitBranch size={14} />并行准备</div><span>→</span>
          <div className="node node--accent">发送周报</div>
        </div>
        <div className="preview-footer">
          <span><Check size={14} />91% 可信度</span>
          <button type="button">保存为 Skill</button>
        </div>
      </div>
    </div>
  )
}

function LandingPage() {
  return (
    <main>
      <nav className="site-nav">
        <a className="brand" href="/" aria-label="Trace 首页"><img className="brand-mark" src="/trace-spirit-icon.png" alt="" />Trace</a>
        <div className="nav-links"><a href="#how">工作方式</a><a href="#privacy">隐私</a><a href="#how">设计原则</a></div>
        <a className="nav-cta" href="#download">加入内测 <ArrowRight size={15} /></a>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <div className="hero-label"><Sparkles size={15} />面向 macOS 与 Windows</div>
          <h1>重复工作，<br /><em>做过一次就够了。</em></h1>
          <p>Trace 在你工作时静默理解操作。当一个模式值得保留，它才会出现，并帮你沉淀成可复用的 Workflow 或 Skill。</p>
          <div className="hero-actions" id="download">
            <button type="button" className="primary-action">加入首批体验 <ArrowRight size={17} /></button>
            <a href="#how">看看它如何工作</a>
          </div>
          <small>本地优先 · 一次授权 · 随时暂停</small>
        </div>
        <WorkflowPreview />
      </section>

      <section className="principles" id="how" aria-label="设计原则">
        <article><span>01</span><Layers3 size={22} /><h2>持续理解，不打断</h2><p>只有达到重复度和可信度门槛后，才给出一条安静的提醒。</p></article>
        <article><span>02</span><GitBranch size={22} /><h2>理解真实工作结构</h2><p>等待、并行、条件分支与回环，都不被强行压成线性步骤。</p></article>
        <article id="privacy"><span>03</span><LockKeyhole size={22} /><h2>隐私边界清晰</h2><p>敏感应用默认排除，原始画面按策略在本地自动清理。</p></article>
      </section>

      <footer><span>Trace</span><p>让重复工作留下方法，而不是疲惫。</p><span>© 2026</span></footer>
    </main>
  )
}
