# OPC-66 — Skill 范围与添加交互

范围：主页面全局 / 项目切换，远程入口收进添加弹框；不包含 OPC-43 真实远程安装管线。

## 实现

- 全局复用现有共享资产发现列表；项目根据已登记项目的实际规范目录扫描，使用项目管理的有效性信息和活动项目；不再仅依赖 `targetProjects`。移除或失效的选择不自动换成另一个项目。
- 添加时固定范围。全局只保存中心资产，项目复用中心资产并调用既有 `injectSkill` 挂载 `.agents/skills`，不自动分发全部工具。
- 重复添加不覆盖中心资产。保存失败不挂载，挂载失败保留中心资产且如实报错，允许重试。项目在保存期间被移除时再次校验。
- 预置内容标注示例，不显示假认证、星数、下载量。仓库结果保持仅检索和复制命令能力。
- 空白新建同样沿用固定范围；添加和新建使用原生 dialog，阻止重复提交，错误留在弹框内。
- 资产保存后广播变更；异步文档读取和项目列表读取忽略过期结果。

## 检查

- `node --experimental-strip-types scripts/verify-opc66-skill-scope.mjs`：范围筛选、指定项目挂载、无隐式全工具分发、重复资产保留、项目失效/移除、保存失败、部分失败。
- `node --experimental-strip-types scripts/verify-opc56-unified-injection.mjs`：既有真实文件系统挂载、跨项目隔离等 12 组回归。
- `node --experimental-strip-types scripts/verify-opc64-project-management.mjs`：项目管理回归。
- `node scripts/verify-opc58-ui-system.mjs`：设计系统静态回归。

Antigravity 负责 AddSkillDialog.tsx / CSS；监督 Agent 负责范围接入、审阅、验证与提交。

最终验证：`pnpm typecheck`、`pnpm build` 均为 5/5 通过。构建保留既有大 chunk 提示。

原生 Electron 1020×680 深色界面检查：全局/项目 Tab、已登记 SoulScene 项目的空 Skill 列表、项目与全局添加目标、新建空白弹框的范围继承、Escape 返回原项目与焦点、示例过滤无结果及禁用添加。聚焦的搜索/新建输入无 outline，弹框无可见滚动条。未对用户真实项目写入测试 Skill；成功添加、重试及跨项目隔离使用临时目录中的真实挂载管理器验证。未执行真实远程安装（OPC-43 范围）。

监督审阅修正：关闭的原生 dialog 被 display:flex 意外显示；搜索词变化时旧结果和 searching 状态滞留；补齐卸载后的异步失效、输入可访问名称和列表键盘状态；复制命令参数加 shell 引号，并说明需自行确认目录与范围。Antigravity 最终已通过本任务 accept-edits 模式写入两个组件文件，无需扩大全局权限。


## 项目已有 Skill 漏显示修复

此前验收把空的 targetProjects 关联当成空项目，遗漏了已有本地目录。现在新增只读项目扫描与 IPC，遍历项目管理规定的六类 Skill 路径，识别真实目录和符号链接。按 canonical source 去重；同名不同物理来源使用不同稳定 ID。只有实际来源与中心库目录一致才认作中心资产，移除的链接不会因残留关联继续显示。

项目详情直接使用扫描所得 SKILL.md，避免读取同名全局资产。未经中心库管理的项目本地 Skill 只读展示，不提供中心资产删除/分发入口，不自动导入或复制。项目切换、应用重新聚焦、项目或 Skill 变更会重扫，旧请求结果失效；扫描错误单独显示并可重试。

验证：`verify-project-skill-discovery.mjs` 覆盖真实目录、符号链接、多路径去重、同名不同来源、A/B 隔离、中心库来源识别、原文优先、过期挂载记录、移除后刷新、无效根目录、部分元数据错误及扫描无写入。`verify-opc66-skill-scope.mjs` 回归通过；`pnpm typecheck` 和 `pnpm build` 5/5 通过。对 SoulScene 只读扫描返回 emil-design-eng、swiftui-pro、write-swift，errors=[]。本轮桌面自动化连续两次 timeoutReached，最终 UI 截图未复核；没有因此改写用户项目。

Antigravity 本轮因服务 503 / 连续 EOF 未产出代码，已停止其任务；扫描器、页面接入和验证由监督 Agent 完成。
