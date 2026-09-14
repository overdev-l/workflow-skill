# Trace 应用自动更新（OPC-53）

实现参考本地 Paprwork（`fe04bb0`）的更新体验与 Worker/R2 发布方式。使用 electron-updater 6.8.9、electron-builder 26.15.3。Trace 使用独立的更新域名与 R2 bucket，不复用 Paprwork 的生产资源。

## 应用行为

- 已配置更新源的安装版启动 3 秒后检查，此后每 4 小时检查。仅支持 macOS Apple Silicon 和 Windows x64。
- 发现更新才显示侧栏按钮；用户点击下载，显示进度，完成后显示“重启并安装”。设置 → 关于显示真实应用版本，可手动检查。
- 下载完成后，用户主动重启或稍后正常退出均经过同一个安装检查。后台不会强制重启。
- 未保存工作流/MCP 编辑、新建技能与账号对话框、录制、账号操作或凭据续期进行中，会阻止安装并保留应用运行。
- 安装准备期间禁用主窗口输入，关闭浏览器捕获并等待原生录制进程结束。失败恢复窗口与录制服务，允许重试。
- `autoDownload=false`，`autoInstallOnAppQuit=false`。正常退出安装由 Trace 自己协调，避免 electron-updater 的退出监听绕过保护。仅 `will-quit` 销毁更新服务。
- 检查/下载请求去重；下载完成状态不会被后台检查覆盖；错误不向渲染进程暴露原始网络地址或凭据。

## 开发验证

```sh
pnpm verify:updates
pnpm typecheck
pnpm build
TRACE_SIMULATE_UPDATE=1 pnpm dev:desktop
```

Windows PowerShell 可用 `$env:TRACE_SIMULATE_UPDATE='1'; pnpm dev:desktop`。

模拟模式明确标注“模拟更新”，使用离线版本号与进度；点击安装不退出、不停止录制、不安装文件。它不验证真实安装保护或系统签名接受情况。普通开发模式和未配置更新源的安装包均禁用更新。

## 打包与更新源

在目标平台本机执行：

```sh
pnpm package:desktop
```

这会构建原生资源、前端和 Electron 主进程，并打包到 `dist/desktop`；默认不发布。macOS 构建 Swift recorder 和 Keychain helper；Windows 用 .NET 8 发布完整的 win-x64 self-contained 录制器。资源先复制至被忽略的 `apps/desktop/release-resources`，再放入安装包的 `Resources/recorders` 和 `Resources/native-bin`。

macOS 签名针对打包副本，保留开发目录 Keychain helper 的缓存及授权身份。第一次安装签名版可能需要系统对新签名身份重新授权。

打包前设置 `TRACE_UPDATE_URL` 为实际部署的 HTTPS Worker 根地址。禁止用户名、密码、query 和 fragment。electron-builder 将其写入 `app-update.yml`；使用 generic provider、`useMultipleRangeRequest=false`。不设置 URL 时不生成更新源配置。

设置 `TRACE_RELEASE=1` 时强制代码签名；macOS 同时强制公证凭据。发布所需配置：

| 配置 | 用途 |
| --- | --- |
| GitHub variable `TRACE_UPDATE_URL` | 独立 Trace Worker 的 HTTPS 根地址 |
| GitHub variable `TRACE_UPDATE_BUCKET` | Worker 实际绑定的 R2 bucket，必须与发布目标一致 |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | macOS Developer ID 证书及密码 |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | macOS 公证 |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows Authenticode 证书及密码 |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | CI 向 R2 上传；不进入应用安装包 |

必须先发布一个签名稳定的基线版本 N；旧的开发包/未签名包不能作为真实升级验收基线。后续 macOS 版本使用相同 Developer ID 身份，Windows 使用匹配发布者的有效签名。

## 发布产物与流水线

| 平台 | 产物 |
| --- | --- |
| macOS arm64 | `Trace-<version>-mac-arm64.dmg`、`.zip`、对应 `.blockmap`、`latest-mac.yml` |
| Windows x64 | `Trace-<version>-win-x64.exe`、`.exe.blockmap`、`latest.yml` |

`.github/workflows/release-desktop.yml` 支持手动构建和稳定 `vX.Y.Z` tag。tag 必须与 `apps/desktop/package.json` 版本一致。两个平台都完成类型检查、更新测试、打包和签名校验后，独立发布 job 合并产物并上传。electron-builder 始终带 `--publish never`，仅由专用脚本控制上传顺序。

```sh
# 只校验，默认没有写操作；目录需包含两个平台的完整产物
node scripts/publish-desktop-updates.mjs --dir dist/desktop --version X.Y.Z

# 发布配置齐备后执行；本次实施未执行此命令
node scripts/publish-desktop-updates.mjs --dir dist/desktop --version X.Y.Z --publish
```

校验要求两个 manifest 版本一致，文件名匹配平台和版本，所有安装包大小/SHA-512 正确，blockmap 为合法压缩 JSON，拒绝路径穿越、重复条目、符号链接、混入其他版本的文件。

发布前经 Worker 对所有不可变文件做 HEAD/GET 校验：404 允许新增；相同 SHA-512 允许断点续传并跳过；内容不同或权限/网络错误即停止。确保 URL 与 bucket 指向同一套资源，并只通过串行发布 job 更新该 bucket。

全部版本化文件上传成功后，最后上传两个 manifest。任一产物失败都不会发布 manifest。两个 manifest 的切换不是跨对象原子事务；其中一个失败时可重试，已发布的 manifest 只会引用完整产物。

## Worker

`infra/update-worker` 只暴露 GET/HEAD，不提供列表、写入或删除接口。支持单 Range 的 206/416、If-None-Match 的 304、If-Range；manifest 不缓存，版本化产物缓存一年；错误响应不缓存。下载别名 `/download/mac`、`/download/windows` 仅在目标存在时重定向。

先在自己的 Cloudflare 账号配置 R2 bucket 与 `TRACE_UPDATES` 绑定，核对 `wrangler.jsonc` 后部署。以下命令从仓库根目录执行，部署需要单独发布授权：

```sh
pnpm --filter @workflow-skill/web exec wrangler deploy --config ../../infra/update-worker/wrangler.jsonc
```

当前仓库只提供配置与代码；未创建 bucket、部署 Worker、上传生产产物或创建 tag。

## 验收记录与剩余条件

本地完成：更新服务/退出协调器、模拟界面流程、Worker 内存 HTTP 测试、发布校验与上传顺序测试、账号回归、类型检查、生产构建及未签名 macOS DMG/ZIP 打包。

仍需实际发布环境验证：签名/公证安装包、Windows 实机、macOS 与 Windows 各自 N → N+1 的增量下载、断网重试、普通退出安装、安装后版本和本地数据保留。未签名本地包和模拟进度均不代表这些验收已完成。
