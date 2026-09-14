# Trace 构建、发布与自动更新

## 仓库分工

- `overdev-l/workflow-skill`：私有源码仓库，保持不开源。
- [`overdev-l/trace-releases`](https://github.com/overdev-l/trace-releases)：独立公开 CI / 发布仓库，只保存工作流、构建辅助脚本和发布文件。
- GitHub Actions 在 CI 仓库执行 macOS arm64 与 Windows x64 构建，GitHub Releases 托管安装包、blockmap 和正式更新清单。已替换原 Worker/R2 更新托管；官网的现有运行时不受影响。

客户端使用 electron-updater 6.8.9 的公开 GitHub provider，不需要也不携带访问私有仓库的 GitHub Token。electron-builder 26.15.3 自动生成 `app-update.yml`。默认发布仓库为 `overdev-l/trace-releases`，可在打包时用 `TRACE_RELEASE_REPOSITORY=owner/repo` 显式配置。

## 构建与发布

在 CI 仓库的 **Actions → Build Trace → Run workflow** 选择：

| 输入 | 含义 |
| --- | --- |
| `source_ref` | 私有源码 `main` 或完整 commit SHA；启动时固定 SHA，两个平台使用同一份源码 |
| `mode=build` | 仅构建 CI artifacts，保留 7 天 |
| `mode=preview` | 构建未签名预览包，发布为 prerelease，不能成为正式更新通道 |
| `mode=stable` | 强制签名，macOS 还必须完成公证；发布完整正式更新 |

也可以从本机触发：

```sh
gh workflow run build.yml --repo overdev-l/trace-releases --ref main -f source_ref=main -f mode=preview
gh run list --repo overdev-l/trace-releases
```

CI 只接受主分支上的维护者手动触发，不响应外部 PR。私有源码使用专属只读 deploy key，私钥存于 CI 仓库 `TRACE_SOURCE_DEPLOY_KEY` secret；不使用个人全权限 GitHub Token。源码、私有构建日志和 source map 不上传。GitHub 自动附带的 “Source code” 下载只包含 CI 仓库配置。

普通依赖安装、校验与构建输出写入 runner 临时文件，公开日志只显示阶段结果与诊断错误码；失败时应在受控环境使用相同源码提交重现。不得为排错直接把整个私有目录或日志上传至公开 artifact。

两个平台都成功后，发布器先严格校验版本、文件名、SHA-512、大小和 blockmap；创建 draft release，上传完整允许列表中的文件并验证，再公开 Release。已有正式发布不允许覆盖；失败的 draft 可以安全重试。预览包不上传正式 `latest*.yml`，客户端始终排除 prerelease。

正式签名 secrets（配置在 CI 仓库）：

- macOS：`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。
- Windows：`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`。

签名凭据只传给 stable 的打包阶段。当前未配置证书；预览包不等于签名升级基线。首个正式版本 N 和后续 N+1 必须使用匹配的签名身份，实机验证升级后本地数据保留。

## 产物

| 平台 | 文件 |
| --- | --- |
| macOS arm64 | `Trace-<version>-mac-arm64.dmg`、`.zip`、对应 `.blockmap` |
| Windows x64 | `Trace-<version>-win-x64.exe`、`.exe.blockmap` |
| 正式更新 | `latest-mac.yml`、`latest.yml` |

安装包包含 `Resources/recorders` 下的原生录制器和 macOS `Resources/native-bin/trace-account-keychain`。macOS 签名操作只处理打包副本，不重新签名开发目录的 Keychain helper。Windows 录制器使用完整的 .NET 8 win-x64 self-contained 发布结果。

## 本地开发和验证

```sh
pnpm typecheck
pnpm verify:updates
pnpm build
pnpm package:desktop
TRACE_SIMULATE_UPDATE=1 pnpm dev:desktop
```

默认本地/预览打包将 `traceUpdatesEnabled` 写为 false；只有 `TRACE_RELEASE=1` 且签名配置齐备的正式包才启用应用更新。即使存在 `app-update.yml`，预览包也不会自行升级。

开发模拟明确标记“模拟更新”，使用离线版本号和进度，不安装、不退出、不停止录制。PowerShell 可先执行 `$env:TRACE_SIMULATE_UPDATE='1'`。

## 正式客户端行为

- 启动 3 秒后检查，每 4 小时再次检查；设置 → 关于显示真实版本并提供手动检查。
- 发现新版本才展示侧栏按钮，点击下载后显示进度，完成后提供“重启并安装”。
- 不强制后台重启。正常退出与手动安装统一检查录制、未保存编辑、账号操作/凭据续期。
- 安装准备时禁用主窗口输入，等待录制器退出；失败恢复窗口与录制服务，允许重试。
- 检查/下载去重，下载完成状态不被后台事件覆盖；退出保护由 Trace 统一管理，因此 transport 使用 `autoInstallOnAppQuit=false`。

真实签名包的 macOS/Windows N→N+1 增量下载、断网重试、退出安装、版本确认和数据保留，仍须发布环境单独验收。
