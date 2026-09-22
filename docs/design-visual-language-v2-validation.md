# Trace 视觉语言 v2 验证与验收记录

**关联需求**：[OPC-212](https://linear.app/overdev-0/issue/OPC-212) (Trace 视觉语言 v2 重构与设计规范同步)  
**基础规范**：[DESIGN.md](../DESIGN.md) (§1–7 视觉语言 v2 标准)  
**源提案文档**：[design-visual-language-v2.md](design-visual-language-v2.md)  
**记录日期**：2026-09-22  
**状态**：代码已实施；自动化检查通过；人工视觉验收部分覆盖

---

## 1. 自动化检查与工程验证结果

- **Token 与静态 AST 规则**：执行 `node scripts/verify-design-tokens.mjs`
  - 13 项内置自测全部通过。
  - 116/116 组前景/背景对比度组合全部通过（达标率 100%，正文 ≥4.5:1，装饰/边框 ≥3:1）。
  - 19 个 CSS 文件扫描 0 项违规。
  - 字阶低于 11px 违规 0 处。
  - 非法硬编码颜色字面量 0 处。
  - `!important` 声明 0 处。
  - `backdrop-filter` 声明共 3 处（严格落在 ≤4 白名单规则内）。
- **旧系统与图谱兼容检查**：
  - 执行 `node scripts/verify-opc58-ui-system.mjs`：7 项检查全通过。
  - 执行 `node scripts/verify-workflow-graph.mjs`：独立验证脚本通过。
- **语义类名重构与 Git 差异**：
  - 完成 16 个类名在 11 个文件中的 63 处重命名替换。
  - `git diff` 检查通过。
- **构建与类型静态检查**：
  - `pnpm typecheck`：5/5 packages 全部通过。
  - `pnpm build`：初始因 21 处畸形 CSS 声明失败，针对性修复后 5/5 packages 全部构建通过。
  - 提示性告警：Turborepo 中 `@workflow-skill/ui` 打包无输出提示，以及常规 chunk > 500kB 信息。

---

## 2. 人工视觉核查与支持矩阵

### 2.1 覆盖范围走查事实
- **1020×680 浅色**：走查 Skill、Workflow、Accounts（含空状态）、设置页面以及账号 OAuth/导入弹窗；同明度边框与 28px 高度稳定，Tab 焦点环与输入聚焦正常。
- **1020×680 深色**：走查设置页面、MCP 模块（Master 栏 280px 及拖拽至 360px 排版正常）、Rules 空状态。
- **780×600 深色**：走查 MCP 模块，Master 自动收缩限制为 240px，按网格算术计算 Detail 外宽约为 380px（非 DOM 物理测量）；无横向不可控溢出。
- **环境恢复**：测试完成后，人工走查状态已恢复深色主题及折叠 Master 状态。

### 2.2 视口支持矩阵（12 单元格）

| 主题 | 窗口尺寸 | Master 210px (历史设计) | Master 360px (实际可拖拽上限) |
| --- | --- | --- | --- |
| **浅色 (Light)** | **780×600** | NOT APPLICABLE (系统最小 240px) | NOT APPLICABLE (780 窄窗自动 clamp 240px；且 780 浅色未测) |
| **浅色 (Light)** | **1020×680** | NOT APPLICABLE (系统最小 240px) | UNVERIFIED (浅色 360px 未走查记录) |
| **浅色 (Light)** | **1440×900** | NOT APPLICABLE (系统最小 240px) | UNVERIFIED (精确 1440 视口未走查) |
| **深色 (Dark)** | **780×600** | NOT APPLICABLE (系统最小 240px) | NOT APPLICABLE (780 窄窗自动 clamp 240px，无法展开至 360px) |
| **深色 (Dark)** | **1020×680** | NOT APPLICABLE (系统最小 240px) | PASS (MANUAL SUBSET) (走查 MCP 确认 360px 正常) |
| **深色 (Dark)** | **1440×900** | NOT APPLICABLE (系统最小 240px) | UNVERIFIED (精确 1440 视口未走查) |

> 状态说明：`NOT APPLICABLE` 为系统当前支持 240–360px（默认 280px），历史 210px 宽度不再生效，窄视口 780px 下限制为 240px；`PASS (MANUAL SUBSET)` 为人工抽样验证通过；`UNVERIFIED` 为未覆盖。

---

## 3. 已知局限与遗留事项

1. **未覆盖视口**：精确 1440×900 宽屏及 780×600 浅色视口未执行人工实机视觉走查。
2. **基线记录**：本次测试环境在重构后启动，无重构前历史基线对比截图，不捏造不存在的截图路径。
3. **复查中发现并修复的问题**：
   - 最终浅色设置截图曾发现激活选中的 Tab 呈现白字叠加中性灰底（white on neutral gray）。
   - 已修复并完成浅色实机复查，桌面构建再次通过；自动化检查无法保证所有实际渲染组合的对比度，不宣称具备端到端全量套件保证。
4. **测试环境复原**：走查结束后的深色主题与 Master 栏收缩状态由 Supervisor 协同负责确保完全恢复。
