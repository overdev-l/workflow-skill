# 账号配置使用与验收

入口为「设置 → 常规与外观 → 账号配置」。每个配置同时包含 Claude Code 与 Codex 的凭据、模型设置和全局 MCP；项目 MCP 与 Skill 软链不随账号切换。

## 保存和切换

1. 在 Claude Code、Codex 中登录并配置工作账号，然后在 Trace 点击「保存当前配置」，命名为「工作账号」。
2. 在这两个工具中登录并配置个人账号，再保存一份「个人账号」。两种工具的当前配置会整组保存。
3. 点击目标配置的「切换」并确认。Trace 先保存切换前备份，再应用目标配置；在新的工具会话中检查账号、模型与 MCP。
4. 点击「回滚上次切换」恢复切换前状态。原先不存在的配置文件也会恢复为不存在。

如果外部工具在切换后刷新了凭据或改写了配置，回滚会报告冲突，避免覆盖更新后的状态。若显示未完成切换，先使用「立即恢复」；恢复完成前不能发起新的切换。

## 存储和边界

- 默认目录为 `~/.trace/profiles/<id>/`；更改 Trace 数据存储目录后，使用该目录下的 `profiles/`。
- 快照包含明文凭据。目录权限为 `700`、文件为 `600`，界面与 IPC 仅返回名称、日期、能力摘要和操作结果。
- Claude Code 凭据来自 macOS Keychain 的 `Claude Code-credentials`；Codex 凭据来自 `~/.codex/auth.json`。
- Claude 的全局 MCP 切换保留 `.claude.json` 中其他项目和历史记录；回滚恢复切换前的完整字节。Codex 的 `config.toml` 整体快照；其他工具及项目的禁用 MCP 记录保持不变。
- Keychain 适配器通过标准输入写入，凭据不会出现在进程参数中。由于 macOS `security -i` 对命令长度有限制，当前实现会在写入前拒绝超过 4,000 字节的完整命令；十六进制编码使可容纳的凭据略少于 2 KB。超限会明确失败并保持原状态，不截断凭据。

## 验证

```sh
pnpm verify:profiles
pnpm verify:profile-keychain
pnpm --filter @workflow-skill/desktop typecheck
pnpm build
```

`verify:profiles` 使用临时目录和模拟 Keychain，覆盖整组切换、逐字节回滚、原本缺失的文件、权限、Skill 软链、写入失败补偿、持久恢复、配置冲突、并发和错误脱敏。

`verify:profile-keychain` 仅在 macOS 运行，创建唯一名称的测试 Keychain 项目，测试 Unicode、JSON、更新、读回与超限保护，结束时删除该测试项目；不会写入真实 Claude Code 凭据。

渲染界面已使用隔离目录及模拟凭据验证保存、切换、回滚与通知。**OPC-48 验收第 5 项仍待完成**：需要用户准备两套真实登录状态，按上述步骤切换、在新会话确认身份并回滚。模拟凭据和原生适配器测试不代表真实账号验收通过。
