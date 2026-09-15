# 账号管理使用与验收（OPC-48）

入口：左侧「账号管理」。页面采用导航＋账号工作台两栏，顶部左侧按 Claude／Codex／Antigravity 切换工具，右侧添加账号；有可回滚记录时显示回滚按钮。下方直接以网格卡片显示账号名称、已知邮箱、当前配置与配额，每张卡片可刷新配额。命令面板也可搜索「账号管理」跳转；原「设置 → 常规与外观 → AI 账号管理」入口仍可使用，两处复用同一实现。切换只写目标工具的认证数据，不切换模型、MCP、Skill 或软链接。

## 工具接入

| 工具 | 导入内容和写入位置 | 当前边界 |
| --- | --- | --- |
| Codex | ChatGPT 登录的 `auth.json`；使用 `CODEX_HOME`（默认 `~/.codex`），仅修改 `config.toml` 顶层 `cli_auth_credentials_store = "file"` | 不接受 API Key。检测全局强制 API 登录、其他模型提供商和限定工作区冲突。新会话仍需核对身份；项目配置、管理策略和启动参数可能覆盖全局配置。 |
| Claude Code | OAuth 登录获得的完整 `claudeAiOauth` 凭据，或 `claude setup-token` 订阅令牌；切换时只将访问令牌写入 `~/.claude/settings.json` 的 `env.CLAUDE_CODE_OAUTH_TOKEN`（支持 `CLAUDE_CONFIG_DIR`） | 不读 Keychain，也不假定 `.credentials.json` 可强制文件登录。支持模型请求和本地 MCP；Remote Control、Claude.ai 连接器受限。完整 OAuth 登录保存已取得的账号、组织和有效期；单独的 setup-token 不能离线确认这些信息。认证环境变量、API Key、辅助程序和其他提供商冲突会阻止切换。 |
| Antigravity | 原生 macOS CLI 与客户端使用 Keychain 的 `service=gemini / account=antigravity`；真实 SSH 环境保留 CLI 后备文件适配 | 自动读取 Google consumer OAuth 并查询身份。主动切换／回滚时正常退出并重新打开正在运行的客户端；保留现有 `agy` CLI 会话，新会话生效。只改 Antigravity 认证项，不访问其他工具的 Keychain。 |

Antigravity CLI 1.2.2 与客户端 2.12.2 的原生路径共用该系统认证项；新版客户端由 Electron Hub 启动独立 language server，不使用旧 IDE 的 `state.vscdb` 登录缓存。2026-09-14 用户明确允许这项限定 Keychain 接入，Trace 账号库仍采用本地文件。真实 SSH 的文件切换仅影响 CLI，不代表原生客户端切换。两端真实双账号验收单独记录。

参考：[Codex 认证](https://developers.openai.com/codex/auth/)、[Codex 配置 Schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)、[Claude 认证](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)、[Claude 环境变量](https://code.claude.com/docs/en/env-vars)、[Antigravity CLI 安装](https://antigravity.google/docs/cli/install/)、[Antigravity 更新记录](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)。

## 保存、切换与恢复

1. 进入账号管理会自动扫描三种工具支持的本地登录来源（Antigravity 原生使用限定 Keychain 项）；窗口重新获得焦点时最多每 30 秒扫描一次。按工具和可靠账号／工作区标识去重，保留自定义名称，凭据刷新后更新原卡片并使旧配额失效。无账号标识的令牌只按凭据匹配，不按邮箱合并；缺失的姓名／邮箱不会伪造。Claude 等未接入的系统凭据库登录仍不能读取，可通过 OAuth 添加。Antigravity 当前凭据缺少身份时，通过 Google userinfo 查询已验证邮箱；查询失败明确反馈，原生凭据不作修改。
2. 点击「添加账号」，默认选择「OAuth 登录」，再点击对应工具的登录按钮。浏览器完成授权后，Trace 交换并保存凭据、刷新卡片和配额。也可选择「导入凭据」粘贴内容并命名；输入默认遮盖，关闭或保存后清空。登录与自动导入只更新 Trace 保存的副本，不切换官方工具当前账号。
3. 点击账号卡片的切换按钮即可执行。Trace 先持久保存认证备份，再写入目标凭据，通知并刷新列表。「当前配置」仅表示认证存储匹配，不能代替服务端身份验证。
4. 关闭并新建工具会话，核对账号身份；CLI 会话不会被强制退出。Antigravity 主动切换／回滚会正常退出并重新打开正在运行的客户端；客户端取消退出或超时则不写凭据，提示处理后再次点击切换。现有 CLI 会话继续使用其内存凭据，新 CLI 会话读取所选账号。Trace 会对支持的 OAuth 凭据自动续期，规则见下节；无法续期的过期凭据仍会拒绝切换。
5. 「回滚上次切换」恢复切换前认证状态，包括原先缺失的凭据文件或 Antigravity 认证项。只恢复认证字段，保留期间修改的模型、MCP 和其他配置。

外部工具刷新或改写了认证字段时，Trace 拒绝覆盖冲突内容。中断切换会显示恢复提示；恢复完成前阻止新的切换。损坏的账号或事务文件不会被自动删除，界面会明确报错。

删除列表中的账号只删除 Trace 保存的副本，不修改当前工具的凭据；相同当前登录的凭据指纹会持久忽略，避免下一次扫描立即重新建卡。工具刷新凭据或显式重新添加后可以再次导入；回滚备份可能仍含此前凭据。Trace 不承诺对磁盘执行安全擦除。

## OAuth 会话

三种工具使用固定提供商授权／令牌地址、随机 state、PKCE S256 和仅绑定 127.0.0.1 的本地回调。Codex 使用 1455 端口，Claude 和 Antigravity 使用临时端口。一次只允许一个登录会话；取消、超时、窗口销毁或导航会清理会话和监听器。令牌交换和用户资料请求有超时、响应大小及重定向限制；渲染进程只接收会话状态与账号 ID，不接收授权码或凭据。

直接实现 OAuth 协议，不执行可能间接写入 Keychain 的 CLI 登录命令。配置根据官方 Codex 登录源码、已安装 Claude Code 2.1.162 与 Antigravity CLI 1.2.2 的公开客户端参数核对；第三方服务的客户端许可、回调和权限仍以真实浏览器授权结果为准。

## 自动续期

Trace 运行时在启动、每 60 秒、系统唤醒和窗口重新获得焦点时检查账号，在访问令牌到期前 5 分钟尝试续期。刷新配额或切换账号前也会检查；服务端返回令牌失效时最多强制续期一次并重试配额一次。退出 Trace 后不运行独立后台服务。

完整 OAuth 凭据需要有效的 refresh token 和可确认的 OAuth 客户端来源。Antigravity 经 Trace OAuth 添加的账号保存了对应客户端信息；缺少该信息的原生导入凭据不猜测来源，需重新 OAuth 登录。Claude setup-token 没有 refresh token，无法自动续期。网络故障与限流采用 30 秒起、最高 10 分钟的退避；授权被撤销后停止重复请求，重新授权或更换凭据后恢复。

与官方工具共用当前刷新令牌时，Antigravity 自动续期仍必须先退出客户端和全部 CLI 会话；主动切换放行现有 CLI 不放宽此刷新保护。续期先保存前向恢复记录，再更新 Trace 和原生认证项；中途失败会保留新令牌，重启后继续同步，原生内容被外部改写则拒绝覆盖。尚未接入运行状态保护的 Codex／Claude 当前共用授权会在请求令牌前停止自动续期，可通过 OAuth 添加独立授权；退出工具本身不能解除这项限制。独立授权只更新 Trace 副本。

续期保留账号 ID、自定义名称和身份信息，更新访问令牌、有效期及服务端返回的轮换刷新令牌；服务端未返回新刷新令牌时保留原值。账号已删除或重新授权时，较早的续期结果不能覆盖新状态。界面显示正在续期、已续期、等待重试、需要重新授权或阻塞原因，不展示原始凭据和接口错误正文。

## 配额查询

账号工作台会为当前工具加载未查询或过期的配额快照，也可手动刷新。查询直接使用 Trace 保存的目标账号凭据，不切换当前工具账号，不改写认证文件。缓存位于主进程内存，重启后重新查询；失败时旧配额明确标记为过期数据。

| 工具 | 查询内容 | 当前边界 |
| --- | --- | --- |
| Codex | ChatGPT usage 的会话／周时间窗口、剩余百分比、重置时间与订阅档位 | 使用所选账号的 access token 和 ChatGPT 工作区标识。支持的 OAuth 凭据会在查询前续期；授权被撤销时需重新登录。 |
| Claude Code | OAuth usage 的五小时、周和可用模型周配额 | 使用完整 OAuth 凭据中的访问令牌，兼容 setup-token。setup-token 可能没有 usage 权限；权限不足会明确显示。 |
| Antigravity | `fetchAvailableModels` 返回每个模型的 5 小时额度，`retrieveUserQuotaSummary` 返回 Gemini 与 Claude/GPT 模型组共享的周额度、重置时间与可用订阅档位 | 周额度按模型组映射并可能在同组模型间重复展示；接口缺失或无法分类时显示未知，不伪造额度。配额查询和本机账号切换是独立能力；可查询不代表 CLI 和客户端新会话身份已通过验收。 |

配额缺失显示暂不可用，真实返回零才显示耗尽。区分令牌失效、权限不足、限流和请求失败。查询使用固定 HTTPS 服务地址，不跟随重定向，不接受任意自定义凭据转发地址；设置超时及响应大小限制，渲染进程仅收到校验后的配额元数据。

本轮参考 [ai-accounts-hub](https://github.com/murongg/ai-accounts-hub/tree/beb39efeef8b3a20c91431952fab80362a738b8a) 与 [AntigravityManager](https://github.com/Draculabo/AntigravityManager/tree/8e95ed65e644b8c2710b394b5f900fcaf584156d) 的接口行为，独立编写查询实现。内部 usage 接口可能随服务变化，返回权限错误时不会伪造配额或改用其他账号。

## 本地存储与旧版本

- 账号：`~/.trace/accounts/<UUID>/manifest.json` 和 `credential.utf8` 或 `credential.<UUID>.utf8`；兼容旧版清单。刷新使用新凭据文件和原子 manifest 指针更新，避免半写入破坏旧账号。删除忽略记录位于私有 `.suppressions.json`，仅保存工具及 SHA-256 指纹。事务备份：`~/.trace/account-transactions/`。续期待恢复记录：`~/.trace/pending-sync/<UUID>.json`，同样包含敏感凭据，使用私有文件权限；仅在新凭据保存及所需原生同步验证完成后删除。使用 Trace 自定义存储目录时位于对应目录下；账号存储目录须位于当前用户目录内。
- 明文文件权限 `600`，目录 `700`。每份账号凭据上限 5 MiB，支持超过旧版约 2 KB 的凭据。摘要与长度校验用于检测损坏，不是加密。
- 元数据、通知与返回渲染进程的结果不含凭据；仅导入时由渲染进程向主进程发送用户输入。未知底层异常转换为固定错误，避免 JSON 解析错误泄露原文。
- 旧 `profiles/` 快照保留原状，不自动迁移凭据。旧整组 Profile 界面、IPC、整组 Keychain 恢复实现与执行测试均已移除，不能再通过旧入口覆盖模型或 MCP。

## Antigravity 原生助手

开发启动与构建会编译 `native/account-keychain/main.swift` 到 `apps/desktop/native-bin/trace-account-keychain`；分发时须将助手放在应用 Resources/native-bin（或对应 asar.unpacked 路径），缺失时明确禁用原生切换。仅 macOS 编译，其他平台跳过。

助手固定访问上述 Antigravity 项，通过标准输入传递凭据，不放入命令行参数；读取保留原始字节文本，写入更新现有项并保留访问控制，不授予所有应用访问权。自动扫描不弹出授权窗口；权限不足时可点击「允许读取账号」触发系统授权。取消、锁定或拒绝均报告错误，不以历史文件代替当前账号。

原生事务使用 `account-transactions/antigravity-native.json`，旧 CLI 文件事务继续保存在 `antigravity.json`，不会跨存储重放回滚。Keychain 备份只进入 Trace 私有事务文件；CLI 与客户端共用一个原生认证目标，不能宣称可独立保持两个不同原生账号。

## 开发验证与真实账号验收

```sh
pnpm verify:accounts
pnpm typecheck
pnpm build
```

自动验证只使用临时用户目录、合成凭据与模拟 HTTP 响应。覆盖独立工具切换、认证字段回滚、写入失败补偿、重启恢复、外部凭据冲突、权限、损坏数据、元数据保密、旧数据保留，以及三工具配额解析、错误状态、缓存隔离和查询不改变当前登录。另外覆盖自动扫描去重、更新原子性、删除忽略、完整凭据与访问令牌投影匹配，以及自动续期的令牌轮换、失败退避、重新授权／删除竞态、并发去重、HTTP 边界和状态通知；以及 OAuth 成功、取消、超时、重复回调、state／PKCE、提供商响应校验和保存竞态。禁止将合成凭据测试视为真实登录或真实配额查询通过。

三种提供商的真实 OAuth 浏览器同意与服务端返回仍需用户完成验收；模拟协议通过不能代替真实服务兼容验证。真实切换验收仍需为每个工具准备两个用户自有账号，依次切换并在新会话确认身份、执行一次普通请求，再回滚核对身份；同时确认模型、MCP、Skill 与其他工具账号不变。Antigravity 桌面与 CLI 分别验收，未完成者不得标记为通过。

2026-09-14 本机验证：限定原生助手经系统授权后可无弹窗读取；Trace 自动导入当前 Antigravity 账号并识别邮箱及当前配置，真实额度查询返回 ready 与 20 个模型的原始窗口，前后原生凭据保持一致。隔离界面确认自动导入、当前卡片、模型剩余额度及未知值显示。原生写入／回滚已通过模拟 Keychain 事务测试；尚未执行真实双账号切换及 CLI／客户端新会话身份验证。

账号卡片的「当前账号」以本机认证存储匹配为准，对应切换按钮禁用；新增 OAuth 只保存账号，不使其自动成为当前账号。Antigravity 在令牌不同但 Google 验证身份相同时也可匹配当前账号。套餐与模型配额分别显示：Google 未返回当前套餐时显示「权益暂未确认」，返回 RESTRICTED_AGE 时明确提示年龄资格限制；不将 allowedTiers 或模型额度当作 Pro 订阅证明。

2026-09-14 自动续期验收：提供商测试 20 项、服务集成测试 19 项及独立边界测试通过，完整账号回归、类型检查和构建通过。隔离 UI 验证重新授权入口、状态提示、当前／失效账号禁用切换及固定卡片内模型滚动。实际项目已启动，但本机旧 Antigravity 导入账号缺少 OAuth 客户端来源且 Keychain 拒绝访问，未执行真实续期；需要先恢复限定 Keychain 访问并重新 OAuth 授权。不能将模拟续期测试视为真实服务验收通过。

2026-09-15 额度展示修复：Antigravity 每个可识别模型分别显示 5 小时与周额度；周额度来自 `retrieveUserQuotaSummary` 的 Gemini／Claude-GPT 模型组，查询失败只将周额度标为未知，不影响有效的 5 小时额度。Codex 与 Claude Code 的既有周期展示保持不变。

2026-09-16 Antigravity UI 展示修复：账号管理按当前模型选择器的 7 个可见模型收敛展示——Gemini 3.8/3.7/3.6 Flash、Gemini 3.1 Pro Low、Claude Sonnet/Opus Thinking、GPT-OSS 120B；兼容接口返回的 3.8/3.7 tiered key，每个模型作为一个紧凑分组，组内显示周额度与 5 小时额度，不再平铺内部模型变体或重复模型名称。

### OPC-54 主动切换与进程生命周期

参考 ai-accounts-hub `beb39efe` 的按账号认证写入与 AntigravityManager `8e95ed65` 的 `switchFlow.ts`：CLI 不执行关闭／启动，客户端退出后切换并重启。Trace 保留认证事务、逐次写入 CAS 及回滚，不修改设备指纹。客户端退出采用正常退出请求，取消、超时或残留进程会阻止写入，不强杀任务；只重新打开本来就在运行的客户端。重启失败但凭据已提交时仍报告切换成功，同时提示手动打开客户端。主动操作的 CLI 放行仅限本次异步作用域，结束后撤销；后台刷新始终检查客户端与 CLI。
