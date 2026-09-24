# Trace / Workflow-Skill Agent 指南与架构规范 (AGENTS.md)

本文件规定了在本项目中进行需求沟通、代码开发、UI/UX 设计、界面重构以及功能演进时的**强制性协作流程、设计规范与架构准则**。所有在此代码库工作的 AI Agent 必须严格遵守以下规则。

---

## 0. 需求登记与实施授权 (Requirements & Implementation Authorization)

**标准流程：先确认需求 → 登记 Linear → 用户明确要求落地 → 开始实现。**

### 0.1 需求沟通

- 先与用户确认目标、范围和验收标准，明确本次需求要解决的问题与交付边界。
- 沟通期间可以读取代码、文档和现有 Linear 需求，进行只读排查并提出方案；未获实施授权前不能提前修改代码。

### 0.2 Linear 登记

- 需求确认后，在对应 Linear 项目创建或更新需求，记录已确认的目标、范围、方案和验收标准；已有对应工单时优先更新，避免重复登记。
- 本仓库对应项目为 OpcWork 团队的 [Trace / Workflow-Skill](https://linear.app/overdev-0/project/trace-workflow-skill-968c73260ce7)，项目 ID 为 `4cb769f2-c831-406c-bde4-c2fda35349db`。
- **认可方案、创建工单、分配任务，都不等于代码实施授权。** 不得把这些行为解释为允许开始实现。

### 0.3 代码实施

- 只有用户明确指定某个需求并要求实施后，才能开始修改代码。用户可以使用工单编号、需求名称或明确的上下文指代；上下文唯一时，仅说“落地”也构成有效授权。
- 若“落地”对应多个可能的需求，先确认具体对象，不自行选择或扩展实施范围。
- 实施前读取对应 Linear 需求的最新描述及相关讨论，核对目标、范围、验收标准和已有授权，确认实施方案；若最新需求与已确认范围不一致，先沟通差异。
- 获得授权后，在已确认范围内完成实现、审阅、验证和 Git 提交，并将结果、验证情况和提交信息更新到对应 Linear 需求。

### 0.4 授权持续性与范围变化

- **已有授权持续有效。** 同一需求、已确认范围内的实现、必要修正、审阅、验证和提交，不重复请求批准；切换会话或执行工具不使已有授权失效。
- 新增需求或扩大范围需重新确认，并取得相应实施授权；发现相邻问题可以只读排查、记录和沟通，不能顺手实施。

### 0.5 纯文档与协作规范维护例外

- 用户要求的纯文档或协作规范维护可以直接执行，无需先创建 Linear 工单，也无需额外请求代码实施授权。
- 例如维护 `AGENTS.md`、更新协作说明、创建指向 `AGENTS.md` 的 `CLAUDE.md` 软链接。
- 此例外只覆盖文档和协作规范维护，不包含借此修改产品代码或扩大功能范围。

### 0.6 默认主分支与分支使用授权

- **默认直接在主分支 `main` 上处理需求开发、Bug 修复、验证和提交。** 不因接到需求或修复任务而自动创建、检出或切换分支。
- **只有用户明确要求使用分支时，才允许按其指示创建或检出分支。** 「落地」「实现」「修复 Bug」等实施授权不包含分支使用授权；不得自行执行 `git checkout`、`git switch`，或通过创建 worktree 绕过此规则。
- 开始工作前只读确认当前分支。若当前不在 `main`，且没有仍然有效的用户分支指示，应先说明现状并确认处理方式，不自行切换分支，也不默认在该分支继续实施。
- 此规则同样适用于受委派 Agent；委派任务时必须明确分支约束。

---

## 1. 界面布局与设计语言规范 (Design Language & Layout Standards)

### 1.1 页面栏目布局准则 (Layout Hierarchy)
- **业务主工作台必须保持 macOS Pro 三栏架构 (3-Column Layout)，账号管理按下述双栏例外执行**：
  - **Column 1 (Sidebar Rail)**: 宽度固定为 `160px`。承载品牌/返回按钮、一级模块导航（Skill 资产库、高频工作流、AI 环境目录）与左下角系统设置入口。
  - **Column 2 (Master List)**: 宽度固定为 `210px`。承载列表检索与一级分类/Tab 切换（如 `[ 本地 | 远程 ]`、`[ 全局 | 项目 ]`），禁止冗余的次级过滤条或多余统计角标。AI 环境列表项直接呈现 [官方矢量品牌 Logo + AI 纯净名称]，通用型环境统一展示为 `agents`，无多余圆点或角标。
  - **Column 3 (Detail Stage)**: 宽度自适应（`minmax(0, 1fr)`）。承载详情 Hero 头部、操作工具栏、物理环境分发矩阵、`SKILL.md` 编辑器与工作流执行图谱。
- **设置页必须保持 macOS 原生双栏偏好设置架构 (2-Column Settings Layout)**：
  - 进入设置模式（`inSettings === true`）时，网格切换为 `grid-template-columns: 160px minmax(0, 1fr)`；
  - 彻底隐藏中间栏，左侧 Sidebar 切换为设置导航（`通用`、`快捷键`、`权限`、`关于`），右侧主舞台（`.app-main-stage`）以全宽舒适排版呈现配置卡片。

- **账号管理是用户明确指定的双栏例外**：保留 `160px minmax(0, 1fr)` 的 Sidebar + 全宽账号工作台，顶部 AI 工具 Tab、下方账号卡片网格；不显示 Master 列和列宽拖拽，不改回三栏。切换工具自动刷新该工具的配额，保留去重、并发限制和失败冷却。

### 1.2 胶囊元素与紧凑视觉节奏 (Capsule Rhythm & Compression)
- **严格遵循紧凑 macOS 视觉节奏，禁止过大的胶囊高度**：
  - 侧边栏导航胶囊（`.nav-pill-btn`）：高度固定为 `26px`。
  - 标准按钮（`.btn` / `.btn--capsule`）：高度固定为 `24px`；小号按钮（`.btn--sm`）固定为 `22px`。
  - 分段 Tab 切换器（`.master-tab-segmented` / `.master-tab-btn`）：高度固定为 `24px`。
  - 输入搜索框（`.master-search-input` / `.dialog-capsule-input`）：高度固定为 `28px`。
- **无冗余边框与高质感毛玻璃 (Liquid Glass Surfaces)**：
  - 背景统一采用 OKLCH 暗黑/亮白毛玻璃（`backdrop-filter: blur(40px) saturate(180%)`）；
  - 深度依赖显式表面亮度差与 `1px` 微弱透光边框，杜绝厚重的实体阴影与突兀的分割线。

---

## 2. AI 环境探测与路径管理机制 (Environment Detection Principles)

### 2.1 全局环境 (Global Scope)
- **扫描基准**：用户宿主主目录 `os.homedir()`。
- **检测逻辑**：
  - 扫描全量支持的全局规范路径：
    - `~/.agents/skills`（.agents 通用全局环境）
    - `~/.claude/skills`（Claude Code 全局环境）
    - `~/.cursor/skills`（Cursor IDE 全局环境）
    - `~/.gemini/antigravity/skills` 或 `~/.gemini/config/skills`（Google Antigravity & Gemini CLI）
    - `~/.trae/skills`（Trae IDE 全局环境）
    - `~/.roo/skills`（Roo Code 全局环境）
    - `~/.cline/skills`（Cline 全局环境）
    - `~/.codex/skills`（Codex CLI 全局环境）
    - `~/.config/opencode/skills`（OpenCode 全局环境）
    - `~/.windsurf/skills`（Windsurf IDE 全局环境）
  - 判断 `existsSync(toolDir)`，统计物理技能子目录数量（`itemCount`），并在中间栏即时高亮就绪状态。

### 2.2 项目工作区环境 (Project Scope)
- **扫描基准**：当前项目工作区根目录（`projectWorkspace`）。
- **工作区判定顺序**：
  1. 优先读取 `~/.trace/config.json` 中用户手动配置并持久化的 `projectWorkspace`；
  2. 若未配置或路径失效，默认回退到应用启动时的工作目录 `process.cwd()`；
  3. 提供 macOS 原生文件夹选择器（`dialog.showOpenDialog`），允许用户随时切换目标项目仓库。
- **检测与自动挂载**：
  - 扫描工作区相对路径：
    - `<projectRoot>/.agents/skills`
    - `<projectRoot>/.claude/skills`
    - `<projectRoot>/.cursor/skills`
    - `<projectRoot>/.github/skills`
    - `<projectRoot>/.trae/skills`
    - `<projectRoot>/.gemini/skills`
  - 若目录不存在，标记为 `待挂载自动创建`；用户触发挂载时，主进程将自动执行 `mkdirSync(..., { recursive: true })` 并创建指向中心库 `~/.trace/skills/{id}` 的符号链接（Windows 下使用 NTFS Junction）。

---

## 3. 代码架构与开发准则 (Engineering Discipline)

- **Monorepo 依赖边界**：
  - 数据模型与协议接口必须定义在 `packages/workflow-model` 或 `packages/capture-protocol` 中；
  - 任何针对协议的修改，必须运行 `pnpm build` 或 `tsc` 保证跨包类型一致性。
- **IPC 安全与响应式状态**：
  - 渲染进程通过 `window.workflowSkill` contextBridge 调用 Electron API；
  - 任何数据变更（如新建技能、切换工作区、挂载环境）必须触发通知并刷新状态。
