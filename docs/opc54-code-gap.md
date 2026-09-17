# OPC-54 代码缺口关闭与验证报告

本文档记录针对 Linear [OPC-54](https://linear.app/overdev-0/issue/OPC-54) 客户端运行中切换成功并自动更新状态所完成的代码修复、凭据真值判定优化、测试覆盖与仍需用户手动验证的真实账号项。

---

## 1. 核心要求与代码落地核对

| 需求项 | 落地文件与实现机制 | 验证状态 |
| --- | --- | --- |
| **1. 原生凭据为准，杜绝依据 lastLoginUsername 误回滚** | `apps/desktop/electron/antigravity-runtime.ts` 的 `withAntigravityAccountSwitch`：切换成功与否以原生凭据写入为准。客户端重启后探测 `lastLoginUsername` 为旧值、缺失或异常时，仅作为非阻断提示（`warning`），**严禁**误将已成功的原生凭据写入回滚。 | 已覆盖 36 项运行时套件验证 |
| **2. 重启等待就绪基于「目标凭据已写入且进程已起来」** | `apps/desktop/electron/antigravity-runtime.ts` 的 `defaultDeps.waitForReadiness` 与 `resolveDeps`：主动轮询 `getPsOutputAsync` 验证 Antigravity GUI 进程已拉起（`scanAntigravityProcesses`）；若启动超时，提供中文业务失败并自动安全回滚。 | 已通过启动等待及超时回滚测试验证 |
| **3. getOverview 依据凭据匹配决定 activeAccountId** | `apps/desktop/electron/account-manager.ts` 的 `getOverview`：只要原生凭据与保存的账号匹配，即刻标定 `activeAccountId` 为该账号 ID，绝不因 `lastLoginUsername` 滞后而清空 `activeAccountId` 或阻止目标账号成为当前账号；滞后会话仅以 `warning` 呈现非阻断提示。并在 `packages/workflow-model/src/accounts.ts` 的 `AccountToolState` 中增补 `warning?: string` 字段。 | 已通过生命周期及状态识别测试验证 |
| **4. 切换成功自动触发列表与配额刷新** | `apps/desktop/src/components/AccountSettings.tsx` 中 `handleDirectSwitch` 与 `handleRollback`：在 `loadData()` 成功后立即调用 `enqueueVisibleQuotasRef.current?.(true)`，实现切换即刷新配额，用户无需手动点「刷新全部」；同时在界面舒适呈现非阻断同步提示。 | 已通过组件逻辑与类型检查验证 |
| **5. 后台续期维持严格运行保护** | `apps/desktop/electron/account-adapters.ts` 中 `assertCanRefresh()` 保持显式调用 `assertAntigravityStoppedStrict()`（`ignoreCli: false`），CLI 或客户端运行中严格拒绝后台续期，绝不继承主动切换放行。 | 已通过租约隔离与严格断言测试验证 |
| **6. 隔离测试覆盖全部指定场景** | 包含客户端运行下退出→写入→重启且 lastLoginUsername 滞后不回滚、lastLoginUsername 缺失/空、取消/超时恢复客户端且不写凭据、CLI 在跑放行且不杀任务、两者均退出直接写入。全部测试 100% 隔离合成测试。 | 全部 14 套测试脚本通过（100% 合成隔离） |

---

## 2. 证据路径与已有测试清单

### 代码证据路径
- **原生凭据真值判定与非阻断探测**：
  - `apps/desktop/electron/antigravity-runtime.ts` (`withAntigravityAccountSwitch`, `waitForReadiness`)
  - `packages/workflow-model/src/accounts.ts` (`AccountToolState.warning`)
- **凭据匹配当前配置与不丢 activeAccountId**：
  - `apps/desktop/electron/account-manager.ts` (`getOverview`)
  - `apps/desktop/src/components/AccountSettings.tsx` (`currentToolState.warning`)
- **切换后自动刷新列表与配额**：
  - `apps/desktop/src/components/AccountSettings.tsx` (`handleDirectSwitch`, `handleRollback`)
- **严格后台续期保护**：
  - `apps/desktop/electron/account-adapters.ts` (`assertCanRefresh`)
  - `apps/desktop/electron/antigravity-runtime.ts` (`assertAntigravityStoppedStrict`)

### 已有测试套件与覆盖点
- **`scripts/verify-antigravity-switch-runtime.mjs`**（共 36 个独立测试套件）：
  - `Suite 3`: CLI 运行下主动切换成功，CLI 进程不被终止或启动。
  - `Suite 4 & 6`: 后台严格保护与主动切换租约隔离，CLI 运行时后台续期严格拒绝。
  - `Suite 7`: 客户端运行下的退出 → 写入 → 重启严格时序。
  - `Suite 8 & 9 & 10`: 取消/超时不写凭据，已退出客户端安全恢复，不发起多余进程。
  - `Suite 20 & 21`: 启动就绪等待与重启后身份探测。
  - `Suite 22`: 重启后 `lastLoginUsername` 为旧值时不触发回滚，返回 `success: true` 与非阻断告警。
  - `Suite 23, 30, 31, 32, 33`: `lastLoginUsername` 缺失、空白、报错时不阻断切换，返回 `success: true`。
  - `Suite 24, 27, 28, 29`: 启动就绪超时触发安全回滚并诚实报告中文失败与 `recoveryNeeded`。
  - `Suite 34`: 启动 spawn 失败时触发回滚并恢复客户端。
  - `Suite 35`: 客户端与 CLI 两者均退出时，切换立即执行，不触发任何退出或启动调用。
  - `Suite 36`: IPC 错误映射——自动剥离 `Error invoking remote method` 包装。
- **`scripts/verify-account-switch-lifecycle.mjs`**：
  - 测试取消、租约限制写入、身份更新、重启告警、回滚恢复原字节、写入失败补偿、无效参数保护。
  - 测试桌面客户端会话身份滞后时不影响 `activeAccountId`，凭据匹配即标定为目标账号。
  - 测试客户端与 CLI 两者均退出时的切换与回滚。
  - 测试客户端就绪超时触发回滚与失败补偿。

---

## 3. 仍只能由用户完成的真实 A→B→A 验收项

受限于自动化测试无法也不能访问用户真实 Google / Antigravity 账号及系统 Keychain，以下验收项目**必须由用户在真实环境手动完成**：

1. **真实客户端运行中的切换**：
   - 打开 Antigravity 客户端并保持登录账号 A。
   - 在 Trace 账号管理界面点击切换至账号 B。
   - 观察客户端是否正常关闭退出、Trace 写入凭据、客户端重新启动并呈现账号 B 身份，卡片状态与当前配置立即更新为账号 B，配额自动刷新。
2. **真实存续 CLI 会话验证**：
   - 打开终端运行 `agy` 命令保持前台或后台任务。
   - 在 Trace 点击切换账号。
   - 验证现有终端中的 `agy` 会话未被强行杀掉或退出，且新开终端中的 `agy` 会话读取到新账号。
3. **真实 A → B → A 回滚与闭环**：
   - 点击「回滚上次切换」。
   - 验证客户端与 Keychain 凭据精确还原回账号 A，新会话及配额卡片同步刷新为账号 A。
