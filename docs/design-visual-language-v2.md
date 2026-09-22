# Trace 视觉语言 v2 提案

日期：2026-09-22。状态：**已实施（验收覆盖见 [design-visual-language-v2-validation.md](design-visual-language-v2-validation.md)）**（用户授权「落地吧」，对应 Linear 需求 [OPC-212](https://linear.app/overdev-0/issue/OPC-212)）。范围：`apps/desktop` + `packages/ui`，**不含 `apps/web`**（官网旧样式表保持原样，不纳入本轮视觉语言重构）。

本文是 DESIGN.md 第 1–7 节的替换标准，只改视觉层（色彩、字阶、表面深度、控件质感、动效、CSS 架构），**不改信息架构**：三栏业务布局、账号/设置双栏例外、第 8 节全部页面级布局方案原样保留。

---

## 0. 决策记录

| # | 决策 | 取值 |
| --- | --- | --- |
| 1 | 输入控件风格 | macOS 原生「同明度 + 边框」，取消凹陷式深底 |
| 2 | 字号 | 整体上调，接受单屏信息量下降 |
| 3 | 毛玻璃 | 退为实色，仅保留窗口结构表面 |
| 4 | 色相 | **重选**：中性色去彩，色彩仅表状态 |
| 5 | 范围 | 仅桌面端，官网不动 |

### 0.1 两条诊断结论（非选项）

**中性色必须与强调色解耦。** 旧色板 `--color-bg` 至 `--color-border` 全部挂在 hue 250、chroma 0.004–0.010，整个界面是淡蓝铸调，叠加钴蓝主色后所有元素糊成同一片蓝。v2 将中性色 chroma 归零。

**「色彩仅表状态」与「饱和填充主按钮」的调和。** chrome 层保留**唯一一个**有彩 token `--color-primary`，只服务于「每屏至多一个主操作按钮」的填充色，**不下放给选中态、焦点、hover、链接、徽章、导航**——这些一律无彩。其色相取 macOS 系统蓝 255，作为 OS 约定而非品牌色。旧色板的问题不是蓝，是「全都是蓝」；中性色去彩后，全屏唯一一处蓝成为精确信号。

---

## 1. 色板

全部数值经 OKLCH → sRGB → WCAG 相对亮度实测，34 组前景/背景组合全部达标。hex 仅作参考，实现必须写 OKLCH。

### 1.1 中性色（chroma = 0）

| Token | 深色 | hex | 浅色 | hex |
| --- | --- | --- | --- | --- |
| `--color-bg` | `oklch(0.120 0 0)` | `#060606` | `oklch(0.985 0 0)` | `#fafafa` |
| `--color-canvas` | `oklch(0.150 0 0)` | `#0b0b0b` | `oklch(1 0 0)` | `#ffffff` |
| `--color-surface` | `oklch(0.190 0 0)` | `#141414` | `oklch(0.965 0 0)` | `#f3f3f3` |
| `--color-surface-raised` | `oklch(0.230 0 0)` | `#1d1d1d` | `oklch(0.930 0 0)` | `#e8e8e8` |
| `--color-rail` | `oklch(0.165 0 0)` | `#0e0e0e` | `oklch(0.945 0 0)` | `#ededed` |
| `--color-ink` | `oklch(0.965 0 0)` | `#f3f3f3` | `oklch(0.180 0 0)` | `#121212` |
| `--color-muted` | `oklch(0.680 0 0)` | `#989898` | `oklch(0.470 0 0)` | `#5b5b5b` |
| `--color-subtle` | `oklch(0.520 0 0)` | `#696969` | `oklch(0.620 0 0)` | `#868686` |
| `--color-border` | `oklch(0.285 0 0)` | `#2a2a2a` | `oklch(0.885 0 0)` | `#d9d9d9` |
| `--color-border-subtle` | `oklch(0.225 0 0)` | — | `oklch(0.925 0 0)` | — |
| `--color-border-strong` | `oklch(0.360 0 0)` | — | `oklch(0.800 0 0)` | — |

> **校准说明（保留历史提案表，注记实际对比度微调）**：浅色 `--color-subtle` 在实际 token 实施落地中微调校准为 `oklch(0.615 0 0)`（确保在 surface-raised/rail 上满足 3:1 非文本/装饰对比度门槛）。

`--color-muted` 从旧值 0.620 提到 0.680（深色），确保在 surface 上达 6.41:1。
`--color-subtle` 从旧值 0.440 提到 0.520——**旧值实测仅 2.55:1，连 3:1 装饰门槛都不达标**。新值 3.57:1。它仍然只允许用于非必要装饰，禁止承载正文、表单标签、占位文字。

### 1.2 主操作色（chrome 层唯一有彩 token）

| Token | 深色 | hex | 浅色 | hex |
| --- | --- | --- | --- | --- |
| `--color-primary` | `oklch(0.545 0.170 255)` | `#136ed0` | `oklch(0.520 0.190 255)` | `#0065d2` |
| `--btn-primary-text` | `#ffffff` （5.02:1） | — | `#ffffff` （5.56:1） | — |
| `--btn-primary-hover` | `oklch(0.595 0.175 255)` | — | `oklch(0.470 0.195 255)` | — |

> **校准说明**：深色 `--btn-primary-hover` 在实际 token 中微调为 `oklch(0.570 0.175 255)`，以保证白色按钮文字在其悬停态下仍稳定保持 ≥ 4.5:1 对比度。

**使用边界（强制）**：仅用于当前视图的单个主操作按钮填充。选中态、焦点、hover、链接、徽章、导航激活态、进度条一律使用中性色。旧色板的 `--color-accent` / `--color-accent-subtle` / `--color-primary-subtle` **全部删除**，不提供替代。

### 1.3 状态色

| Token | 深色 | hex | on canvas | 浅色 | hex | on canvas |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--color-success` | `oklch(0.760 0.140 155)` | `#5ccb89` | 9.70:1 | `oklch(0.430 0.130 155)` | `#00632d` | 7.42:1 |
| `--color-waiting` | `oklch(0.790 0.135 80)` | `#e8b048` | 10.04:1 | `oklch(0.470 0.120 80)` | `#7d5100` | 6.90:1 |
| `--color-danger` | `oklch(0.680 0.190 25)` | `#f75d59` | 6.26:1 | `oklch(0.520 0.180 25)` | `#ba2b2e` | 6.05:1 |

> **校准说明**：
> - 浅色 `--color-danger` 在实际 token 中微调为 `oklch(0.490 0.180 25)`，以确保浅色半透背景叠加和浅色表面上的对比度达标。
> - 深色 `--color-danger-bg` 透明度校准为 alpha `0.12`（`oklch(0.680 0.190 25 / 0.12)`），避免高亮度红色底色过度冲淡前景红色文字对比度（实测 tinted 达成 4.62:1）。

每个状态提供三元组 `--color-<state>`（文字/图标）、`--color-<state>-bg`（同色 12–15% 透明）、`--color-<state>-border`（同色 30–35% 透明）。**旧色板缺 `-border`，导致组件各自硬编码边框色，是 200 处硬编码的主要来源之一，必须补齐。**

状态不得只靠颜色表达，须同时有图标或文字（PRODUCT.md 无障碍要求）。

### 1.4 控件色（决策 ① 的直接产物）

| Token | 深色 | 浅色 |
| --- | --- | --- |
| `--control-bg` | `var(--color-surface)` | `var(--color-surface)` |
| `--control-bg-hover` | `oklch(0.215 0 0)` | `oklch(0.945 0 0)` |
| `--control-border` | `oklch(0.500 0 0)` `#636363` | `oklch(0.640 0 0)` `#8c8c8c` |
| `--control-border-hover` | `oklch(0.600 0 0)` | `oklch(0.540 0 0)` |
| `--control-placeholder` | `oklch(0.620 0 0)` | `oklch(0.510 0 0)` |

> **校准说明**：
> - 深色 `--control-border` 校准为 `oklch(0.520 0 0)`（在 surface-raised 上实测达 3.07:1，严格满足 ≥ 3:1 阈值）。
> - 浅色 `--control-border` 校准为 `oklch(0.610 0 0)`（在 surface-raised 上实测达 3.08:1，严格满足 ≥ 3:1 阈值）。


**这是本次改动中观感变化最大的一处，务必预期：** 控件不再挖深井，边框成为控件的唯一可见性载体，按 WCAG 1.4.11 非文本对比度必须 ≥ 3:1。

- 新值实测：深色 3.08:1，浅色 3.04:1。
- 旧值实测：`--control-border` 0.260 on `--control-bg` 0.110 = **1.32:1**，严重不达标。旧设计靠「控件底色比表面深一截」代偿了边框的可见性职责；同明度方案下这个代偿消失，边框必须自己达标。
- 结果：边框比旧值显著更强（0.260 → 0.500），界面会明显更「有框」。这是决策 ① 的必然代价，不是实现偏差。

---

## 2. 字阶

**固定 6 档，全部 token 化，一律使用 `px`**（放弃 `rem`，旧代码 `rem`/`px` 混用是字号失控的技术原因之一）。

| Token | 值 | 行高 | 用途 |
| --- | --- | --- | --- |
| `--text-caption` | 11px | 1.45 | 元信息、状态、次级路径标签 |
| `--text-control` | 12px | 1.45 | 按钮、表单标签、说明文字 |
| `--text-body` | 13px | 1.50 | 正文、列表标题 |
| `--text-section` | 15px | 1.40 | 分组标题 |
| `--text-title` | 20px | 1.30 | 详情标题 |
| `--text-mono` | 12px | 1.65 | 代码、路径、编辑器 |

字重：常规 400 / 标签 500 / 标题 600。全局 `font-variant-numeric: tabular-nums lining-nums`。

**11px 是硬下限。** 当前代码有 93 处低于 11px 的字号声明（9px×33、9.5px×1、10px×59），其中 9px 正在承载关键信息：`.safe-delete-target-row`（删除影响清单）、`.perm-target-title`（权限目标）、`.env-link-status`（挂载状态）、`.workflow-graph-selection`（选中节点摘要）。这直接违反 DESIGN.md §5「避免 9px 状态文字承担关键信息」。

迁移映射：9px / 9.5px / 10px 状态与元信息 → `--text-caption`；10px 控件文字（含 `.btn` 自身）→ `--text-control`。

`.btn` 当前是 10px 文字配 24px 高度，提到 12px 后与 macOS small control（11–12pt）一致；按钮高度 26/24/22px 与输入 28px 维持不变（AGENTS.md §1.2 强制项）。

---

## 3. 表面深度与毛玻璃

深度由**明度台阶 + 1px 边框**表达，不由阴影表达。定义三级：

| 层级 | 阴影 | 用途 |
| --- | --- | --- |
| `--elevation-flat` | `none` | 列表行、字段组、内容分区。靠 `--color-border` 分隔 |
| `--elevation-raised` | `none` | hover / 选中。仅 `--color-surface` → `--color-surface-raised` 明度提升 |
| `--elevation-overlay` | 深色 `0 8px 24px oklch(0 0 0 / 0.40)`，浅色 `0 8px 24px oklch(0 0 0 / 0.14)`（配合独立 1px `--color-border` 边框，token 内无额外 shadow ring） | **唯一允许阴影的层级**：弹窗、下拉、toast、命令面板 |

当前代码 153 处 `box-shadow`（app 123 / accounts 16 / mcp 14），迁移后应仅剩 overlay 白名单类。

### 3.1 毛玻璃白名单（决策 ③）

`backdrop-filter` 当前出现 53 处，**收敛到 4 处窗口结构表面**：

1. `.app-shell`（窗口根，承接 macOS vibrancy）
2. `.app-sidebar`（导航 rail）
3. 弹窗遮罩层
4. 独立子窗口根（`SkillLinkManagerWindow`、`PermisoOverlay`）

其余 49 处全部退为实色。除性能收益外（Electron 下 `blur(40px) saturate(180%)` 是真实渲染成本），这也消除了与 PRODUCT.md anti-reference「不采用常见 AI SaaS 的玻璃卡片」的冲突。

`liquid-glass-*` / `liquid-pinned-*` / `liquid-skill-row` 等 12 种装饰性类名按语义重命名（如 `.panel` / `.list-row` / `.card`），装饰话术（「纯净液态玻璃」「高对比微晶」）从 UI 文案中移除——这一条 `docs/ui-minimalism-review.md` 已经提过。

---

## 4. 焦点反馈（§6 修订提案 — 需批准）

DESIGN.md §6 现规定：输入区无 outline、无 box-shadow 模拟环，且 `--control-border-focus` 必须等于 `--control-border`，焦点仅靠 `--control-bg-focus` 底色与光标反馈。

**决策 ① 使这条规则失去载体。** 旧方案中 `--control-bg`(0.110) 与 `--control-bg-focus`(0.095) 的差异之所以可感知，是因为控件本就是一口深井；同明度控件上，同等幅度的底色偏移几乎不可见，键盘用户将失去焦点指示。

提案修订为：

- 保留：无 `outline`、无 `box-shadow`、无外扩环、无光晕、**不引发布局位移**。
- 新增允许：**焦点时 `--control-border` 提升一档**（深色 0.500 → 0.680，浅色 0.640 → 0.420），配合 `--control-bg-focus` 轻微提升。边框宽度维持 1px 不变，因此无位移。
- 不变：错误态保留危险色边框与文本说明，焦点不覆盖错误含义；禁用态不响应 hover/focus 装饰；非输入控件（按钮、链接、Tab、拖拽分隔条）保留清晰的 `focus-visible` 指示；禁止全局 `* { outline: none }`。

**若不批准此修订**，同明度控件必须改为「焦点时控件底色比容器深一档」，即部分退回凹陷式，与决策 ① 冲突。两者必须二选一。

---

## 5. 动效

保留现有节奏，不改：`--motion-fast: 160ms`、`--motion-base: 220ms`、`cubic-bezier(0.2, 0, 0, 1)`。遵循 `prefers-reduced-motion`。按钮不因 hover 缩放或弹跳。

**新增约束**：仅 `color` / `background-color` / `border-color` / `opacity` / `transform` 允许过渡。禁止过渡 `width` / `height` / `padding`（`ui-minimalism-review.md` 的静态检测已标出 5 处布局属性动画；进度条宽度动画因有明确状态反馈目的，作为显式例外保留）。

`--motion-spring` 变量名误导（实际是 `cubic-bezier(0.2,0,0,1)`，无弹性），重命名为 `--motion-standard`。

---

## 6. CSS 架构（不做这条，前五节会反弹）

现状：`app.css` 8337 行 / 1178 个选择器 / 30 个分区，`!important` 35 处（app 25 / accounts 10）。DESIGN.md §10.1 已要求「禁止在文件末尾不断追加高优先级补丁」，但未落实。

分四层：

```
packages/ui/src/
  tokens.css       所有 :root / [data-theme] token，双主题，唯一色彩与字阶来源
  primitives.css   button / input / select / list-row / badge / dialog 骨架
  index.css        入口
apps/desktop/src/
  layout.css       三栏与双栏 shell、Master、详情容器
  modules/*.css    仅布局与场景差异，不得重定义 token 或 primitive
```

`!important` 归零。模块样式表不得出现颜色字面量与字号字面量。

---

## 7. 迁移清单（量化）

| 项目 | 现状 | 目标 |
| --- | --- | --- |
| 低于 11px 的字号声明 | 93 | 0 |
| 字号档位 | 20+ | 6 |
| 硬编码颜色（hex/rgba/hsl） | 200 | 0 |
| `box-shadow` | 153 | 仅 overlay 白名单 |
| `backdrop-filter` | 53 | 4 |
| `!important` | 35 | 0 |
| `app.css` 行数 / 选择器 | 8337 / 1178 | 拆为四层 |

---

## 8. 验收标准

### 8.1 机器可校验（应固化为 `scripts/verify-design-tokens.mjs`）

1. 扫描 `apps/desktop/src` 与 `packages/ui/src` 下全部 CSS：无低于 11px 的字号、无颜色字面量、`!important` 计数为 0。
2. 对比度回归：对本文所有「语义文字 × 语义背景」组合重算 WCAG 比值，正文 ≥ 4.5:1、装饰 ≥ 3:1、控件边框与非文本 UI 边界 ≥ 3:1。任一组合不达标即失败。
3. `backdrop-filter` 出现次数 ≤ 4 且命中白名单选择器；`box-shadow` 仅出现在 overlay 白名单类。
4. `pnpm typecheck` 与 `pnpm build` 通过。
5. 既有 `scripts/verify-opc58-ui-system.mjs` 的布局、控件高度、无双栏回退检查继续通过。

### 8.2 人工验收矩阵

深色 / 浅色 × 窗口 780×600 / 1020×680 / 1440×900 × Master 210px / 360px。逐项记录改造前后截图、实际详情宽度、对应条款、已验证状态、未覆盖状态。

重点检查项：

- 同明度控件在两个主题下边界清晰可辨，键盘 Tab 焦点可见且无位移。
- 全屏只有一处蓝色（当前视图的主操作按钮）；选中态、导航激活态、焦点均为无彩。
- 退玻璃后 sidebar 与内容区仍有明确层次，不糊成一片。
- 字号上调后 780×600 窗口（详情区最窄约 228px）仍能纵向访问全部字段与操作，无横向滚动、无逐字断行。
- 无可见滚动条、输入区无 outline/外扩环的既有强制项不回退。

不得仅凭构建通过或某个控件像素正确即宣称全页合格。

---

## 9. 决议状态（已决）

1. **§4 焦点反馈修订已获批准**：同明度输入采用焦点边框微提档（深色 0.520 → 0.680，浅色 0.610 → 0.420）配合底色微变与输入光标，保持 1px 无布局位移、无 outline、无 box-shadow 模拟环，错误状态红框与说明文字保留不被覆盖。
2. **主操作按钮保留 macOS 系统蓝（每屏至多一个）**：chrome 层唯一有彩 token `--color-primary`（深色 `oklch(0.545 0.170 255)` / 浅色 `oklch(0.520 0.190 255)`），仅用于主操作按钮填充，不下放给选中态、导航、焦点或链接。
3. **Linear 工单已登记**：需求登记于 Linear [OPC-212](https://linear.app/overdev-0/issue/OPC-212)（Trace 视觉语言 v2 重构与设计规范同步）。
4. **实施路径与授权**：用户已明确发出实施指令「落地吧」，正式授权 [OPC-212](https://linear.app/overdev-0/issue/OPC-212) 落地实施。

---

## 10. 实施约束与授权演进

本文最初作为提案提交时只更新文档、不构成代码实施授权。**随后用户已明确给出实施指令「落地吧」，正式授权 [OPC-212](https://linear.app/overdev-0/issue/OPC-212) 的代码落地与规范同步。**

后续工作继续严格遵守 AGENTS.md 准则：
- 默认直接在 `main` 分支上处理，不擅自创建或切换分支；
- 视觉层改造不修改 IPC、账号安全逻辑、跨进程协议或发布流程；
- 不得为简化界面删除标签、键盘焦点、可访问路径与安全确认；
- 最终验证声明必须等待协调测试与全矩阵审查完成，不得提前下发「最终通过」定论。

