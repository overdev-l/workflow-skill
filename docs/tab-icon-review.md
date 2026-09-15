# Tab 宽度与图标对齐补修（OPC-60）

## 修复

- Skill 全局/项目按钮等宽填满切换器；添加按钮固定 24×24px。
- 原生项目 select 使用独立 12px ChevronDown，垂直居中、右侧 10px，文字右侧预留 32px；箭头不拦截点击。
- 紧凑控件 SVG 块级显示、不参与 flex 压缩；Tab 文字单行。
- DESIGN.md §4.1 明确内容/填充两种宽度模式与对齐验收。

## 验证

- Electron 独立控件渲染使用仓库实际共享 CSS、桌面 CSS 与对应控件结构：深浅主题 × Master 210/360px × 短/长项目名，共8组。
- 测量通过：两个 Tab 等宽、高24px；添加按钮24×24px且图标中心偏差0；箭头右侧10px、垂直中心偏差0；无横向溢出。截图目视检查长项目名省略后没有覆盖箭头。
- pnpm typecheck、pnpm build、现有 verify-opc58-ui-system、git diff --check 通过。
- 验证边界：本次为隔离控件渲染，未宣称完整运行应用全页面回归；原生下拉菜单键盘选择、触控板与全部业务切换状态未实测。未改变 select 的值绑定、onChange、选项或业务逻辑。
- Antigravity 启动因 Google Eligibility check 请求 EOF 失败，未产生修改；主 Agent 合并共享工作区同范围修复并完成审阅与验证。
