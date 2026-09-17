# OPC-54 代码缺口关闭与验证报告

本文档记录针对 Linear [OPC-54](https://linear.app/overdev-0/issue/OPC-54) 最新要求所完成的代码修复、错误映射优化、测试覆盖与仍需用户手动验证的真实账号项。

---

## 1. 核心要求与代码落地核对

| 需求项 | 落地文件与实现机制 | 验证状态 |
| --- | --- | --- |
| **1. 渲染层结构化中文业务结果，杜绝 IPC 包装** | 在 `packages/workflow-model/src/accounts.ts` 增加 `cleanAccountErrorMessage()`，剥离 `Error invoking remote method '[^']+': (?:Error: )?` 包装；在 `apps/desktop/src/components/AccountSettings.tsx` 补全 `zh-CN` / `en-US` 字典的 `switchFailure`、`rollbackFailure` 等本地化回退文本，避免出现英文或技术栈包装。主进程 `main.ts` 中的 `accountActionCall` 统一将操作异常包装为 `{ success: false, error: ... }` 业务结果。 | 已通过合成测试与类型检查验证 |
| **2. 用户主动切换/回滚放行 CLI，客户端退出→写入→重启** | `apps/desktop/electron/antigravity-runtime.ts` 的 `withAntigravityAccountSwitch`：通过 `AsyncLocalStorage` 作用域赋予主动切换租约，在写入阶段允许放行现有 `agy` CLI；正在运行的客户端通过 AppleScript 正常请求退出，确认退出后执行原子写入，随后自动重新启动客户端、等待就绪并核验身份。超时或取消时执行 `restoreIfVerifiedGone` 重新拉起客户端，不写入任何凭据，绝不强杀用户任务。 | 已覆盖 36 项运行时生命周期测试 |
| **3. 后台续期维持严格运行保护** | `apps/desktop/electron/account-adapters.ts` 中 `assertCanRefresh()` 显式调用 `assertAntigravityStoppedStrict()`，强制参数 `ignoreCli: false`。若存在 `agy` CLI 或客户端正在运行，直接拒绝续期，绝不继承主动切换的 CLI 放行策略。 | 已覆盖租约隔离与严格断言测试 |
| **4. 隔离测试覆盖全部指定场景** | 包含客户端运行、CLI 运行、两者均退出、退出取消/超时、身份不匹配回滚、IPC 错误映射。全部测试仅使用独立临时目录和合成凭据。 | 全部 14 套测试脚本通过（100% 合成隔离） |

---

## 2. 证据路径与已有测试清单

### 代码证据路径
- **IPC 错误解包与中文业务提示**：
  - `packages/workflow-model/src/accounts.ts` (`cleanAccountErrorMessage`)
  - `apps/desktop/src/components/AccountSettings.tsx` (`formatErrorMessage`, `handleDirectSwitch`, `handleRollback`)
  - `apps/desktop/electron/main.ts` (`accountActionCall`)
- **客户端平滑退出、写入、重启与 CLI 放行**：
  - `apps/desktop/electron/antigravity-runtime.ts` (`withAntigravityAccountSwitch`, `scanAntigravityProcesses`, `checkAntigravityStopped`)
- **严格后台续期保护**：
  - `apps/desktop/electron/account-adapters.ts` (`assertCanRefresh`)
  - `apps/desktop/electron/antigravity-runtime.ts` (`assertAntigravityStoppedStrict`)

### 已有测试套件与覆盖点
- **`scripts/verify-antigravity-switch-runtime.mjs`**（共 36 个独立测试套件）：
  - `Suite 3`: CLI 运行下主动切换成功，CLI 进程不被终止或启动。
  - `Suite 4 & 6`: 后台严格保护与主动切换租约隔离，CLI 运行时后台续期严格拒绝。
  - `Suite 7`: 客户端运行下的退出 → 写入 → 重启严格时序。
  - `Suite 8 & 9 & 10`: 取消/超时不写凭据，已退出客户端安全恢复，不发起多余进程。
  - `Suite 20 & 21`: 启动就绪等待与重启后身份一致性探测。
  - `Suite 22, 27, 28, 30, 31, 32, 33`: 重启后身份不匹配/探测失效/就绪超时触发自动回滚，回滚完成后安全重新拉起客户端，并诚实报告失败。
  - `Suite 35`: 客户端与 CLI 两者均退出时，切换立即执行，不触发任何退出或启动调用。
  - `Suite 36`: IPC 错误映射——自动剥离 `Error invoking remote method` 包装与嵌套 `Error:` 前缀，无错误正文时使用中文回退，模拟 IPC 封装返回结构化失败对象。
- **`scripts/verify-account-switch-lifecycle.mjs`**：
  - 测试取消、租约限制写入、身份更新、重启告警、回滚恢复原字节、写入失败补偿、无效参数保护。
  - 测试桌面客户端会话身份不匹配检测、诚实展示 `activeAccountId: undefined`、自动回滚以及成功匹配。
  - 测试客户端与 CLI 两者均退出时的切换与回滚。
  - 测试 `accountActionCall` 封装下 IPC 错误映射为结构化失败结果，无技术包装泄露。

---

## 3. 仍只能由用户完成的真实 A→B→A 验收项

受限于自动化测试无法也不能访问用户真实 Google / Antigravity 账号及系统 Keychain，以下验收项目**必须由用户在真实环境手动完成**：

1. **真实客户端运行中的切换**：
   - 打开 Antigravity 客户端并保持登录账号 A。
   - 在 Trace 账号管理界面点击切换至账号 B。
   - 观察客户端是否正常关闭退出、Trace 写入凭据、客户端重新启动并呈现账号 B 身份。
2. **真实存续 CLI 会话验证**：
   - 打开终端运行 `agy` 命令保持前台或后台任务。
   - 在 Trace 点击切换账号。
   - 验证现有终端中的 `agy` 会话未被强行杀掉或退出，且新开终端中的 `agy` 会话读取到新账号。
3. **真实 A → B → A 回滚与闭环**：
   - 点击「回滚上次切换」。
   - 验证客户端与 Keychain 凭据精确还原回账号 A，新会话及配额卡片同步刷新为账号 A。
