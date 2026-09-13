# 账号管理使用与验收（OPC-48）

入口：左侧「账号管理」。页面采用导航＋账号工作台两栏，顶部左侧按 Claude／Codex／Antigravity 切换工具，右侧添加账号；有可回滚记录时显示回滚按钮。下方直接以网格卡片显示账号名称、已知邮箱、当前配置与配额，每张卡片可刷新配额。命令面板也可搜索「账号管理」跳转；原「设置 → 常规与外观 → AI 账号管理」入口仍可使用，两处复用同一实现。切换只写目标工具的认证数据，不切换模型、MCP、Skill 或软链接。

## 工具接入

| 工具 | 导入内容和写入位置 | 当前边界 |
| --- | --- | --- |
| Codex | ChatGPT 登录的 `auth.json`；使用 `CODEX_HOME`（默认 `~/.codex`），仅修改 `config.toml` 顶层 `cli_auth_credentials_store = "file"` | 不接受 API Key。检测全局强制 API 登录、其他模型提供商和限定工作区冲突。新会话仍需核对身份；项目配置、管理策略和启动参数可能覆盖全局配置。 |
| Claude Code | OAuth 登录获得的完整 `claudeAiOauth` 凭据，或 `claude setup-token` 订阅令牌；切换时只将访问令牌写入 `~/.claude/settings.json` 的 `env.CLAUDE_CODE_OAUTH_TOKEN`（支持 `CLAUDE_CONFIG_DIR`） | 不读 Keychain，也不假定 `.credentials.json` 可强制文件登录。支持模型请求和本地 MCP；Remote Control、Claude.ai 连接器受限。完整 OAuth 登录保存已取得的账号、组织和有效期；单独的 setup-token 不能离线确认这些信息。认证环境变量、API Key、辅助程序和其他提供商冲突会阻止切换。 |
| Antigravity | CLI 的 Google consumer OAuth 文件，包含 `auth_method: "consumer"` 和 `token`；路径 `~/.gemini/antigravity-cli/antigravity-oauth-token` | 可导入保存。文件切换只用于 CLI 的真实 SSH 后备环境；原生 macOS 和桌面端暂不可用，界面明确提示。未伪造 SSH 环境或 keyring 超时标记，未改用 Gemini API Key。 |

Antigravity CLI 1.2.2 的本机静态检查确认 SSH 检测与上述 OAuth 文件路径。桌面 2.12.2 使用独立服务进程；CLI 文件后备路径不构成桌面端兼容证明。两者尚未完成真实双账号切换验收。

参考：[Codex 认证](https://developers.openai.com/codex/auth/)、[Codex 配置 Schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)、[Claude 认证](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)、[Claude 环境变量](https://code.claude.com/docs/en/env-vars)、[Antigravity CLI 安装](https://antigravity.google/docs/cli/install/)、[Antigravity 更新记录](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)。

## 保存、切换与恢复

1. 进入账号管理会自动扫描三种工具的本地文件登录；窗口重新获得焦点时最多每 30 秒扫描一次。按工具和可靠账号／工作区标识去重，保留自定义名称，凭据刷新后更新原卡片并使旧配额失效。无账号标识的令牌只按凭据匹配，不按邮箱合并；缺失的姓名／邮箱不会伪造。只存在于系统凭据库的登录无法读取，可通过 OAuth 添加。
2. 点击「添加账号」，默认选择「OAuth 登录」，再点击对应工具的登录按钮。浏览器完成授权后，Trace 交换并保存凭据、刷新卡片和配额。也可选择「导入凭据」粘贴内容并命名；输入默认遮盖，关闭或保存后清空。登录与自动导入只更新 Trace 保存的副本，不切换官方工具当前账号。
3. 点击账号卡片的切换按钮即可执行。Trace 先持久保存认证备份，再写入目标凭据，通知并刷新列表。「当前配置」仅表示本地文件匹配，不能代替服务端身份验证。
4. 关闭并新建工具会话，核对账号身份；运行中的会话不会被强制退出。Trace 尚未实现后台 refresh-token 自动续期；已知过期凭据会明确拒绝，可重新 OAuth 登录，或通过官方工具刷新后重新导入。
5. 「回滚上次切换」恢复切换前认证状态，包括原先缺失的凭据文件。只恢复认证字段，保留期间修改的模型、MCP 和其他配置。

外部工具刷新或改写了认证字段时，Trace 拒绝覆盖冲突内容。中断切换会显示恢复提示；恢复完成前阻止新的切换。损坏的账号或事务文件不会被自动删除，界面会明确报错。

删除列表中的账号只删除 Trace 保存的副本，不修改当前工具的凭据；相同当前登录的凭据指纹会持久忽略，避免下一次扫描立即重新建卡。工具刷新凭据或显式重新添加后可以再次导入；回滚备份可能仍含此前凭据。Trace 不承诺对磁盘执行安全擦除。

## OAuth 会话

三种工具使用固定提供商授权／令牌地址、随机 state、PKCE S256 和仅绑定 127.0.0.1 的本地回调。Codex 使用 1455 端口，Claude 和 Antigravity 使用临时端口。一次只允许一个登录会话；取消、超时、窗口销毁或导航会清理会话和监听器。令牌交换和用户资料请求有超时、响应大小及重定向限制；渲染进程只接收会话状态与账号 ID，不接收授权码或凭据。

直接实现 OAuth 协议，不执行可能间接写入 Keychain 的 CLI 登录命令。配置根据官方 Codex 登录源码、已安装 Claude Code 2.1.162 与 Antigravity CLI 1.2.2 的公开客户端参数核对；第三方服务的客户端许可、回调和权限仍以真实浏览器授权结果为准。

## 配额查询

账号工作台会为当前工具加载未查询或过期的配额快照，也可手动刷新。查询直接使用 Trace 保存的目标账号凭据，不切换当前工具账号，不改写认证文件。缓存位于主进程内存，重启后重新查询；失败时旧配额明确标记为过期数据。

| 工具 | 查询内容 | 当前边界 |
| --- | --- | --- |
| Codex | ChatGPT usage 的会话／周时间窗口、剩余百分比、重置时间与订阅档位 | 使用所选账号的 access token 和 ChatGPT 工作区标识。已过期或被服务端拒绝的令牌需在官方工具重新登录后保存。 |
| Claude Code | OAuth usage 的五小时、周和可用模型周配额 | 使用完整 OAuth 凭据中的访问令牌，兼容 setup-token。setup-token 可能没有 usage 权限；权限不足会明确显示。 |
| Antigravity | Google Code Assist 返回的模型配额、重置时间与可用订阅档位 | 配额查询和本机账号切换是独立能力；可查询不代表原生 macOS／桌面文件切换已支持。 |

配额缺失显示暂不可用，真实返回零才显示耗尽。区分令牌失效、权限不足、限流和请求失败。查询使用固定 HTTPS 服务地址，不跟随重定向，不接受任意自定义凭据转发地址；设置超时及响应大小限制，渲染进程仅收到校验后的配额元数据。

本轮参考 [ai-accounts-hub](https://github.com/murongg/ai-accounts-hub/tree/beb39efeef8b3a20c91431952fab80362a738b8a) 与 [AntigravityManager](https://github.com/Draculabo/AntigravityManager/tree/8e95ed65e644b8c2710b394b5f900fcaf584156d) 的接口行为，独立编写查询实现。内部 usage 接口可能随服务变化，返回权限错误时不会伪造配额或改用 Keychain。

## 本地存储与旧版本

- 账号：`~/.trace/accounts/<UUID>/manifest.json` 和 `credential.utf8` 或 `credential.<UUID>.utf8`；兼容旧版清单。刷新使用新凭据文件和原子 manifest 指针更新，避免半写入破坏旧账号。删除忽略记录位于私有 `.suppressions.json`，仅保存工具及 SHA-256 指纹。事务备份：`~/.trace/account-transactions/`。使用 Trace 自定义存储目录时位于对应目录下；账号存储目录须位于当前用户目录内。
- 明文文件权限 `600`，目录 `700`。每份账号凭据上限 5 MiB，支持超过旧版约 2 KB 的凭据。摘要与长度校验用于检测损坏，不是加密。
- 元数据、通知与返回渲染进程的结果不含凭据；仅导入时由渲染进程向主进程发送用户输入。未知底层异常转换为固定错误，避免 JSON 解析错误泄露原文。
- 旧 `profiles/` 快照保留原状，不自动迁移凭据。旧整组 Profile 界面、IPC、Keychain 实现与执行测试均已移除，不能再通过旧入口覆盖模型或 MCP。

## 开发验证与真实账号验收

```sh
pnpm verify:accounts
pnpm typecheck
pnpm build
```

自动验证只使用临时用户目录、合成凭据与模拟 HTTP 响应。覆盖独立工具切换、认证字段回滚、写入失败补偿、重启恢复、外部凭据冲突、权限、损坏数据、元数据保密、旧数据保留，以及三工具配额解析、错误状态、缓存隔离和查询不改变当前登录。另外覆盖自动扫描去重、更新原子性、删除忽略、完整凭据与访问令牌投影匹配，以及 OAuth 成功、取消、超时、重复回调、state／PKCE、提供商响应校验和保存竞态。禁止将合成凭据测试视为真实登录或真实配额查询通过。

三种提供商的真实 OAuth 浏览器同意与服务端返回仍需用户完成验收；模拟协议通过不能代替真实服务兼容验证。真实切换验收仍需为每个工具准备两个用户自有账号，依次切换并在新会话确认身份、执行一次普通请求，再回滚核对身份；同时确认模型、MCP、Skill 与其他工具账号不变。Antigravity 桌面与 CLI 分别验收，未完成者不得标记为通过。
