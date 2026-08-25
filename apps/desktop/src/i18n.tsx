import React, { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Locale = 'zh-CN' | 'en-US' | 'system'
export type ResolvedLocale = 'zh-CN' | 'en-US'

export const translations = {
  'zh-CN': {
    brand: {
      name: 'Trace',
      tagline: '静默提炼与工作流沉淀',
    },
    nav: {
      skill: 'Skill',
      workflow: 'Workflow',
      settings: '设置',
      backToApp: '返回应用',
      general: '常规与外观',
      shortcuts: '快捷键',
      permissions: '隐私与权限',
      about: '关于 Trace',
    },
    skills: {
      title: 'Skill',
      subtitle: '已沉淀的结构化工作流资产',
      tabLocal: '本地',
      tabRemote: '远程',
      newSkill: '新建 Skill',
      searchPlaceholder: '搜索 Skill 名称、应用或描述…',
      pinnedSection: '常用固定',
      allSection: '全部 Skills',
      viewFlow: '查看流程',
      versionPrefix: 'v',
      customFrameworkDesc: '自定义工作流技能框架',
      createDialogTitle: '新建 Skill 资产',
      createDialogDesc: '创建一个新的结构化工作流资产模板',
      skillNameLabel: '技能名称',
      skillNamePlaceholder: '例如: 导出每日周报与汇总',
      cancelBtn: '取消',
      confirmCreateBtn: '确认创建',
      createdToast: (name: string) => `已创建“${name}”`,
      emptySearch: '未搜索到匹配的 Skill 资产',
      emptySearchDesc: (q: string) => `没有找到与 “${q}” 相关的 Skill 资产，尝试更换关键词`,
      clearSearchBtn: '清除搜索条件',
      emptyLocalTitle: '暂无本地 Skill 资产',
      emptyLocalDesc: '在后台保持静默观察以自动沉淀高频操作，或点击下方「新建 Skill」创建资产模板。',
      openLocalDirBtn: '打开本地存储目录',
      emptyRemoteTitle: '暂无远程 Skill 资产',
      emptyRemoteDesc: '尚未配置远程 Skill 仓库源。后续配置后可一键同步与发现团队自动化资产。',

      remoteLibraryTitle: '远程 Skill 资产库',
      remoteLibrarySub: '探索、同步与分发跨应用自动化操作模式',
      remoteLibraryNoticeTitle: '远程 Skill 库正在接入中',
      remoteLibraryNoticeDesc: '后续将支持配置远程 Git / HTTPS 资产仓库或云端市场源，实现团队资产一键同步与自动下发。',
      remoteConfigureBtn: '配置远程源…',
      remoteDocsBtn: 'Skill 协议规范',
      remoteSearchPlaceholder: '搜索远程 Skill 库资产、应用或指令…',
      remoteTagAll: '全部',
      remoteTagFeatured: '推荐精选',
      remoteTagDev: '开发与工程',
      remoteTagOffice: '办公协同',
      remoteInstallBtn: '获取',
      remoteInstalled: '已安装',
      remoteVersion: (v: string) => `v${v}`,
      remoteComingSoonToast: '远程 Skill 库源配置即将支持',
    },
    workflows: {
      title: 'Workflow',
      subtitle: '跨应用高频自动化流与复发模式',
      confidenceBadge: (pct: number) => `${pct}% 可信`,
      saveAsSkill: '保存为 Skill',
      savedAsSkill: '已保存',
      dismissAction: '忽略该工作流',
      savedToast: (name: string) => `“${name}”已成功沉淀为 Skill`,
      dismissedToast: '已忽略该工作流',
      emptyTitle: '暂无新发现的工作流模式',
      emptyDesc: 'Trace 正在后台静默观察重复操作，捕获后将自动生成结构化工作流。',
      observingLiveHint: '静默观察中 · 自动提炼操作流',
      observingPausedHint: '静默观察已暂停',
    },
    detail: {
      back: '返回概览',
      runsMeta: (runs: number, mins: number) => `复发 ${runs} 次 · 耗时约 ${mins} 分钟`,
      saveSkillBtn: '保存为 Skill',
      savedSkillBtn: '已保存为 Skill',
      exportCodeBtn: '导出代码',
      stepInspectorTitle: '步骤语义审查',
      stepSelectedPrefix: '选中步骤: ',
      stepNameLabel: '操作指令',
      stepAppLabel: '归属应用',
      stepConfidenceLabel: 'AI 语义置信度',
      stepDetailLabel: '上下文参数',
      exportDialogTitle: '导出工作流资产代码',
      exportDialogDesc: '将该工作流导出为可执行代码或标准协议规范',
      copyClipboardBtn: '复制到剪贴板',
      copiedClipboardBtn: '已复制到剪贴板',
      copiedToast: '代码已复制到剪贴板',
    },
    settings: {
      title: '设置',
      generalTab: '常规与外观',
      generalSub: '个性化界面主题与语言设定',
      themeTitle: '界面外观主题',
      themeSubtitle: '配色方案',
      themeDesc: '选择纯净液态玻璃与高对比微晶排版风格',
      themeLight: '浅色',
      themeDark: '深色',
      themeSystem: '跟随系统',
      themeStatusDark: '深色模式',
      themeStatusLight: '浅色模式',
      themeStatusSystem: (resolved: string) => `跟随系统 (${resolved})`,

      langTitle: '界面语言',
      langSubtitle: '多语言设定',
      langDesc: '选择应用展示语言或自动跟随 macOS 系统设定',
      langZhCN: '简体中文',
      langEnUS: 'English',
      langZhTW: '繁體中文',
      langSystem: '跟随系统',
      langStatusSystem: (resolved: string) => `跟随系统 (${resolved})`,

      dataStoragePathTitle: '本地数据存储路径',
      dataStoragePathDesc: '存放工作区配置、Skill 资产、Workflow 流程与录制缓存的根目录',
      dataStoragePathPlaceholder: '未设置存储路径',
      dataStoragePathSelectBtn: '更改目录…',
      dataStoragePathRevealBtnMac: '在访达中打开',
      dataStoragePathRevealBtnWin: '在文件资源管理器中打开',
      dataStoragePathResetBtn: '恢复默认',
      dataStoragePathChangedToast: '存储路径已更新',

      shortcutsTab: '键盘快捷键',
      shortcutsSub: '自定义全局操作与应用内高效交互快捷键',
      resetShortcutsBtn: '恢复默认',
      recordingShortcut: '按下快捷键组合…',
      unassignedShortcut: '未分配',
      editShortcutTooltip: '修改快捷键',
      clearShortcutTooltip: '清除快捷键',
      shortcutUpdatedToast: '快捷键已更新',
      shortcutResetToast: '快捷键已恢复默认',

      shortcutsGroupGlobal: '全局与窗口管理',
      shortcutsGroupEngine: '观察与工作流引擎',
      shortcutsGroupNav: '视图与上下文跳转',

      shortcutCmdKTitle: '全局指令面板',
      shortcutCmdKDesc: '快速搜索操作、执行指令与跨界面跳转',
      shortcutNewSkillTitle: '新建 Skill 资产',
      shortcutNewSkillDesc: '创建自定义结构化工作流资产模板',
      shortcutSearchTitle: '聚焦搜索与筛选',
      shortcutSearchDesc: '快速聚焦当前资产或工作流的搜索输入框',
      shortcutEscTitle: '退出或返回上一级',
      shortcutEscDesc: '关闭浮层、弹窗或返回上一级工作流列表',
      shortcutToggleObserveTitle: '暂停 / 恢复静默观察',
      shortcutToggleObserveDesc: '快捷切换 ScreenCaptureKit 本地录制与分析状态',
      shortcutSaveSkillTitle: '将当前工作流保存为 Skill',
      shortcutSaveSkillDesc: '将选中的高频复发操作模式沉淀为结构化资产',
      shortcutExportCodeTitle: '导出工作流资产代码',
      shortcutExportCodeDesc: '呼出工作流代码导出与协议复制窗口',
      shortcutSkillsNavTitle: '切换到 Skill 资产库',
      shortcutSkillsNavDesc: '查看与管理已沉淀的所有结构化工作流',
      shortcutWorkflowsNavTitle: '切换到 Workflow 模式库',
      shortcutWorkflowsNavDesc: '查看后台捕获的高频复发自动化路径',
      shortcutSettingsNavTitle: '打开偏好设置',
      shortcutSettingsNavDesc: '配置界面主题、外观语言与系统级授权',

      engineTab: '引擎与观察',
      engineSub: '原生 ScreenCaptureKit 行为模式分析引擎',
      engineStateTitle: '引擎运行状态',
      engineObserving: '正在本地静默观察',
      enginePaused: '观察已挂起',
      engineVersion: (v: string) => `原生引擎 ${v} · ScreenCaptureKit 已就绪`,
      engineReady: 'ScreenCaptureKit 原生采集器已就绪，所有元数据在内存本地处理。',
      pauseBtn: '暂停观察',
      resumeBtn: '恢复观察',
      engineParamsTitle: '引擎配置参数',
      captureFrameworkLabel: '采集框架',
      semanticParserLabel: '语义层解析',
      sandboxLabel: '分析沙箱',
      sandboxVal: '100% 内存纯本地',
      networkLabel: '网络请求',
      networkVal: '0 网络外传',

      permissionsTab: '隐私与权限',
      permissionsSub: '系统级授权与本地纯离线数据安全保障',
      permissionsReadyHeadline: '系统授权全部就绪 · 处于本地安全运行状态',
      permissionsMissingHeadline: '需要完成 macOS 授权以开启完整工作流提炼',
      permissionsReadyDesc: 'ScreenCaptureKit 与 AXUIElement 权限已就绪，所有元数据在本地内存中实时提取。',
      permissionsMissingDesc: '请在 macOS 系统设置中为 Trace 开启屏幕录制与辅助功能权限。',
      requestPermissionsBtn: '请求系统授权',
      refreshPermissionsBtn: '刷新授权状态',
      sectionSystemPerms: 'macOS 系统级权限',
      sectionGuarantees: '本地数据安全与隐私合规保障',
      screenRecordingTitle: '屏幕录制 (ScreenCaptureKit)',
      screenRecordingDesc: '捕获跨应用操作时的视窗状态与界面流转，用于识别复发模式',
      accessibilityTitle: '辅助功能与 UI 语义 (AXUIElement)',
      accessibilityDesc: '提取应用程序的按钮名称、菜单与交互上下文，提炼结构化步骤',
      sandboxTitle: '纯本地内存沙盒',
      sandboxDesc: '所有视窗元数据仅在本地 RAM 临时提取归纳，不向磁盘写入原始录屏文件',
      sandboxBadge: '100% 内存本地',
      networkTitle: '网络隔离与零外传',
      networkDesc: '无需连接外部服务器，完全离线运行，工作流资产代码 100% 保存在本机',
      networkBadge: '0 网络外发',
      sensitiveTitle: '敏感应用与密码保护',
      sensitiveDesc: '自动跳过 1Password、Bitwarden、系统密码输入框与无痕浏览器视窗',
      sensitiveBadge: '默认开启',
      authorized: '已授权',
      waitingAuth: '待授权',
      verifyingToast: '正在验证系统授权…',
      authSuccessToast: '系统授权已完成，开始观察',
      authFailToast: '请在系统设置中允许权限后重试',

      permModalTitle: '授予 macOS 辅助功能与屏幕录制权限',
      permModalSubtitle: '已为您唤起系统设置并贴靠窗口，请拖拽 Trace 或开启对应授权开关',
      permModalDragBadge: '可拖拽应用',
      permModalDragTip: '拖动图标到系统设置列表',
      permModalOrLocate: '或在访达中显示应用文件',
      permModalLocateBtn: '在访达中定位 Trace.app',
      permModalOpenSettingsBtn: '重新唤起系统设置',
      permModalSettingsMockTitle: '隐私与安全性 > 辅助功能 / 屏幕录制',
      permModalSettingsMockRow: '允许 Trace 观察跨应用操作语义',
      permModalListening: '正在实时检测授权状态…',
      permModalSuccess: '🎉 权限已成功获取！正在开启提炼引擎…',
      permModalDoneBtn: '完成授权',
      permStep1Title: '系统设置已在屏幕右侧打开',
      permStep1Desc: '若未弹出，可点击下方「重新唤起系统设置」',
      permStep2Title: '按住并拖拽 Trace 图标到设置列表中',
      permStep2Desc: '直接按住上方 Trace.app 图标拖入右侧系统设置窗口列表中',
      permStep3Title: '开启授权开关',
      permStep3Desc: '在列表中将 Trace 对应的开关切换为启用状态，系统将自动感知并完成',

      aboutTab: '关于 Trace',
      aboutSub: '版本信息与设计理念',
      aboutAppVersion: '应用版本',
      aboutReleaseBadge: 'RELEASE PRO',
      aboutTitle: 'Trace Desktop Workspace',
      aboutBuild: 'v1.0.0 (Build 2026.08)',
      aboutManifesto:
        'Trace 致力于为专业开发者与创作者打造下一代静默、无感、纯本地的跨应用工作流提炼与技能沉淀工具。遵循 Liquid Glass 极简设计美学与 Benji Taylor《Honkish》物理交互哲学。',
    },
    command: {
      searchPlaceholder: '搜索操作或执行命令… (↑↓ 移动, Enter 执行)',
      jumpSkills: '跳转到: Skill 资产库',
      jumpSkillsHint: '管理和导出已沉淀的结构化工作流',
      jumpWorkflows: '跳转到: Workflow 模式',
      jumpWorkflowsHint: '查看近期捕获的复发模式与自动化流',
      newSkill: '新建 Skill…',
      newSkillHint: '创建新的工作流资产模板',
      openSettings: '打开设置与偏好',
      openSettingsHint: '配置界面外观、引擎与系统授权',
      pauseObserve: '暂停本地观察',
      resumeObserve: '恢复本地观察',
      pauseObserveHint: '挂起 ScreenCaptureKit 录制',
      resumeObserveHint: '开始静默分析重复操作',
      themeLight: '外观: 切换为浅色模式',
      themeLightHint: '晶莹冰白高反差排版',
      themeDark: '外观: 切换为深色模式',
      themeDarkHint: '深炭液态玻璃低反光外观',
      themeSystem: '外观: 跟随系统设置',
      themeSystemHint: '自动同步 macOS 系统深浅模式',
      empty: '未找到匹配的指令',
    },
    toast: {
      nativeNotReady: '原生采集器未就绪',
      observePaused: '本地观察已暂停',
      observeResumed: '已恢复本地静默观察',
    },
  },

  'en-US': {
    brand: {
      name: 'Trace',
      tagline: 'Silent Workflow Distillation',
    },
    nav: {
      skill: 'Skill',
      workflow: 'Workflow',
      settings: 'Settings',
      backToApp: 'Back to App',
      general: 'General',
      shortcuts: 'Shortcuts',
      permissions: 'Privacy & Permissions',
      about: 'About Trace',
    },
    skills: {
      title: 'Skill',
      subtitle: 'Distilled and structured workflow assets',
      tabLocal: 'Local',
      tabRemote: 'Remote',
      newSkill: 'New Skill',
      searchPlaceholder: 'Search skills, apps, or descriptions…',
      pinnedSection: 'Pinned',
      allSection: 'All Skills',
      viewFlow: 'View Flow',
      versionPrefix: 'v',
      customFrameworkDesc: 'Custom workflow skill template',
      createDialogTitle: 'Create New Skill',
      createDialogDesc: 'Create a new structured workflow template asset',
      skillNameLabel: 'Skill Name',
      skillNamePlaceholder: 'e.g. Export Daily Summary & Report',
      cancelBtn: 'Cancel',
      confirmCreateBtn: 'Create Skill',
      createdToast: (name: string) => `Created “${name}”`,
      emptySearch: 'No matching skills found',
      emptySearchDesc: (q: string) => `No skill assets matched “${q}”. Try a different search term.`,
      clearSearchBtn: 'Clear search',
      emptyLocalTitle: 'No local skill assets yet',
      emptyLocalDesc: 'Keep silent observation active in the background to auto-distill workflows, or create a skill template below.',
      openLocalDirBtn: 'Open Local Directory',
      emptyRemoteTitle: 'No remote skill assets yet',
      emptyRemoteDesc: 'No remote skill source configured yet. Connect a remote repository to sync assets.',

      remoteLibraryTitle: 'Remote Skill Hub',
      remoteLibrarySub: 'Discover, sync, and distribute cross-app automation patterns',
      remoteLibraryNoticeTitle: 'Remote Skill Hub Coming Soon',
      remoteLibraryNoticeDesc: 'Future updates will support connecting remote Git / HTTPS repositories and cloud hubs for seamless skill syncing.',
      remoteConfigureBtn: 'Configure Remote Source…',
      remoteDocsBtn: 'Skill Protocol Specs',
      remoteSearchPlaceholder: 'Search remote skills, apps, or commands…',
      remoteTagAll: 'All',
      remoteTagFeatured: 'Featured',
      remoteTagDev: 'Dev & Engineering',
      remoteTagOffice: 'Productivity',
      remoteInstallBtn: 'Get',
      remoteInstalled: 'Installed',
      remoteVersion: (v: string) => `v${v}`,
      remoteComingSoonToast: 'Remote Skill Hub configuration coming soon',
    },
    workflows: {
      title: 'Workflow',
      subtitle: 'Discovered cross-app automation patterns',
      confidenceBadge: (pct: number) => `${pct}% Confidence`,
      saveAsSkill: 'Save as Skill',
      savedAsSkill: 'Saved',
      dismissAction: 'Dismiss Workflow',
      savedToast: (name: string) => `“${name}” saved as Skill`,
      dismissedToast: 'Workflow dismissed',
      emptyTitle: 'No newly discovered patterns',
      emptyDesc: 'Trace is silently observing repetitive actions in the background.',
      observingLiveHint: 'Observing silently · Auto-distilling patterns',
      observingPausedHint: 'Observation paused',
    },
    detail: {
      back: 'Back',
      runsMeta: (runs: number, mins: number) => `Occurred ${runs} times · ~${mins} mins`,
      saveSkillBtn: 'Save as Skill',
      savedSkillBtn: 'Saved as Skill',
      exportCodeBtn: 'Export Code',
      stepInspectorTitle: 'Step Inspector',
      stepSelectedPrefix: 'Selected Step: ',
      stepNameLabel: 'Instruction',
      stepAppLabel: 'Target App',
      stepConfidenceLabel: 'AI Confidence',
      stepDetailLabel: 'Context Parameters',
      exportDialogTitle: 'Export Workflow Code',
      exportDialogDesc: 'Export this workflow as executable code or standard schemas',
      copyClipboardBtn: 'Copy to Clipboard',
      copiedClipboardBtn: 'Copied to Clipboard',
      copiedToast: 'Code copied to clipboard',
    },
    settings: {
      title: 'Settings',
      generalTab: 'General',
      generalSub: 'Personalized theme, appearance, and language preferences',
      themeTitle: 'Theme Appearance',
      themeSubtitle: 'Color Scheme',
      themeDesc: 'Choose crystalline liquid glass or high-contrast typography',
      themeLight: 'Light',
      themeDark: 'Dark',
      themeSystem: 'System',
      themeStatusDark: 'Dark Mode',
      themeStatusLight: 'Light Mode',
      themeStatusSystem: (resolved: string) => `System (${resolved})`,

      langTitle: 'Language',
      langSubtitle: 'Interface Language',
      langDesc: 'Select display language or automatically match macOS system settings',
      langZhCN: '简体中文',
      langEnUS: 'English',
      langZhTW: '繁體中文',
      langSystem: 'System',
      langStatusSystem: (resolved: string) => `System (${resolved})`,

      dataStoragePathTitle: 'Data Storage Path',
      dataStoragePathDesc: 'Root directory for workspace configuration, skills, workflows, and observation data',
      dataStoragePathPlaceholder: 'No storage path configured',
      dataStoragePathSelectBtn: 'Change Directory…',
      dataStoragePathRevealBtnMac: 'Reveal in Finder',
      dataStoragePathRevealBtnWin: 'Open in File Explorer',
      dataStoragePathResetBtn: 'Reset to Default',
      dataStoragePathChangedToast: 'Storage path updated',

      shortcutsTab: 'Keyboard Shortcuts',
      shortcutsSub: 'Customize global hotkeys and rapid in-app workflows',
      resetShortcutsBtn: 'Reset Defaults',
      recordingShortcut: 'Press shortcut keys…',
      unassignedShortcut: 'Unassigned',
      editShortcutTooltip: 'Edit shortcut',
      clearShortcutTooltip: 'Clear shortcut',
      shortcutUpdatedToast: 'Shortcut updated',
      shortcutResetToast: 'Shortcuts reset to defaults',

      shortcutsGroupGlobal: 'Global & Window Management',
      shortcutsGroupEngine: 'Observe & Workflow Engine',
      shortcutsGroupNav: 'Views & Context Switching',

      shortcutCmdKTitle: 'Command Palette',
      shortcutCmdKDesc: 'Quick search, run commands, and jump anywhere',
      shortcutNewSkillTitle: 'New Skill Asset',
      shortcutNewSkillDesc: 'Create a structured workflow skill template',
      shortcutSearchTitle: 'Focus Search & Filter',
      shortcutSearchDesc: 'Quickly focus search input in current view',
      shortcutEscTitle: 'Escape or Go Back',
      shortcutEscDesc: 'Close modals, drawers, or return to overview',
      shortcutToggleObserveTitle: 'Pause / Resume Silent Observe',
      shortcutToggleObserveDesc: 'Toggle ScreenCaptureKit local recording & analysis',
      shortcutSaveSkillTitle: 'Save Current Workflow as Skill',
      shortcutSaveSkillDesc: 'Distill recurring workflow pattern into reusable asset',
      shortcutExportCodeTitle: 'Export Workflow Code',
      shortcutExportCodeDesc: 'Open workflow code export and schema dialog',
      shortcutSkillsNavTitle: 'Switch to Skills Library',
      shortcutSkillsNavDesc: 'Manage and view all distilled workflow assets',
      shortcutWorkflowsNavTitle: 'Switch to Workflow Patterns',
      shortcutWorkflowsNavDesc: 'View captured recurring automation paths',
      shortcutSettingsNavTitle: 'Open Settings & Preferences',
      shortcutSettingsNavDesc: 'Configure appearance, languages, and permissions',

      engineTab: 'Engine & Observe',
      engineSub: 'Native ScreenCaptureKit pattern analysis engine',
      engineStateTitle: 'Engine Status',
      engineObserving: 'Observing Silently',
      enginePaused: 'Observation Suspended',
      engineVersion: (v: string) => `Native Engine ${v} · ScreenCaptureKit Ready`,
      engineReady: 'ScreenCaptureKit native recorder is active. Processing memory locally.',
      pauseBtn: 'Pause Observation',
      resumeBtn: 'Resume Observation',
      engineParamsTitle: 'Configuration Parameters',
      captureFrameworkLabel: 'Capture Framework',
      semanticParserLabel: 'Semantic Parser',
      sandboxLabel: 'Analysis Sandbox',
      sandboxVal: '100% In-Memory Local',
      networkLabel: 'Network Access',
      networkVal: '0 Remote Outbound',

      permissionsTab: 'Privacy & Permissions',
      permissionsSub: 'System authorizations & local offline data security guarantees',
      permissionsReadyHeadline: 'All System Permissions Granted · Safe Local In-Memory Mode',
      permissionsMissingHeadline: 'Action Required · Grant macOS Permissions for Workflow Capture',
      permissionsReadyDesc: 'ScreenCaptureKit and AXUIElement permissions are active. Data is processed in local RAM.',
      permissionsMissingDesc: 'Please grant Screen Recording and Accessibility permissions in macOS System Settings.',
      requestPermissionsBtn: 'Request Permissions',
      refreshPermissionsBtn: 'Refresh Status',
      sectionSystemPerms: 'macOS System Permissions',
      sectionGuarantees: 'Local Data Security & Privacy Guarantees',
      screenRecordingTitle: 'Screen Recording (ScreenCaptureKit)',
      screenRecordingDesc: 'Captures window transitions and app contexts to detect workflow patterns',
      accessibilityTitle: 'Accessibility Semantics (AXUIElement)',
      accessibilityDesc: 'Extracts UI element labels, menu paths, and semantic hierarchy',
      sandboxTitle: 'In-Memory Local Sandbox',
      sandboxDesc: 'All metadata is parsed in local RAM. Raw video streams are never saved to disk.',
      sandboxBadge: '100% In-Memory',
      networkTitle: 'Zero Network Egress',
      networkDesc: 'Runs completely offline. Workflow definitions and code remain 100% on your Mac.',
      networkBadge: '0 Remote Outbound',
      sensitiveTitle: 'Sensitive Apps Exclusion',
      sensitiveDesc: 'Automatically bypasses password managers, keychain dialogs, and incognito windows.',
      sensitiveBadge: 'Active by Default',
      authorized: 'Granted',
      waitingAuth: 'Required',
      verifyingToast: 'Verifying system permissions…',
      authSuccessToast: 'Permissions granted. Observation started.',
      authFailToast: 'Please grant permissions in System Settings and retry',

      permModalTitle: 'Grant macOS Accessibility & Screen Recording',
      permModalSubtitle: 'System Settings opened and window repositioned. Drag Trace or toggle the switch ON',
      permModalDragBadge: 'Draggable App',
      permModalDragTip: 'Drag icon into System Settings',
      permModalOrLocate: 'Or locate application binary in Finder',
      permModalLocateBtn: 'Reveal Trace.app in Finder',
      permModalOpenSettingsBtn: 'Re-open System Settings',
      permModalSettingsMockTitle: 'Privacy & Security > Accessibility / Screen Recording',
      permModalSettingsMockRow: 'Allow Trace to observe semantic actions',
      permModalListening: 'Listening for system permission status…',
      permModalSuccess: '🎉 Permissions Granted! Initializing engine…',
      permModalDoneBtn: 'Done',
      permStep1Title: 'System Settings opened on the right',
      permStep1Desc: 'If not visible, click “Re-open System Settings” below',
      permStep2Title: 'Drag Trace icon into the settings list',
      permStep2Desc: 'Click and drag the Trace.app icon above directly into the macOS list',
      permStep3Title: 'Toggle permission switch to ON',
      permStep3Desc: 'Turn on the toggle next to Trace; the app will auto-detect and complete',

      aboutTab: 'About Trace',
      aboutSub: 'Version information and design philosophy',
      aboutAppVersion: 'Version',
      aboutReleaseBadge: 'RELEASE PRO',
      aboutTitle: 'Trace Desktop Workspace',
      aboutBuild: 'v1.0.0 (Build 2026.08)',
      aboutManifesto:
        'Trace is built for developers and creators to distill silent, seamless, 100% local cross-app workflows into reusable skills. Crafted with Liquid Glass aesthetics and tactile spring physics.',
    },
    command: {
      searchPlaceholder: 'Search actions or run commands… (↑↓ Move, Enter Execute)',
      jumpSkills: 'Jump to: Skill',
      jumpSkillsHint: 'Manage and export structured workflow assets',
      jumpWorkflows: 'Jump to: Workflow',
      jumpWorkflowsHint: 'View recently captured patterns and discovery streams',
      newSkill: 'New Skill…',
      newSkillHint: 'Create a new workflow asset template',
      openSettings: 'Open Settings & Preferences',
      openSettingsHint: 'Configure theme, engine, and system permissions',
      pauseObserve: 'Pause Observation',
      resumeObserve: 'Resume Observation',
      pauseObserveHint: 'Suspend ScreenCaptureKit recording',
      resumeObserveHint: 'Start silently analyzing repetitive actions',
      themeLight: 'Theme: Switch to Light Mode',
      themeLightHint: 'Crisp crystalline light appearance',
      themeDark: 'Theme: Switch to Dark Mode',
      themeDarkHint: 'Deep charcoal low-glare liquid glass',
      themeSystem: 'Theme: Follow System',
      themeSystemHint: 'Auto-sync with macOS system theme',
      empty: 'No matching commands found',
    },
    toast: {
      nativeNotReady: 'Native capture engine not ready',
      observePaused: 'Local observation paused',
      observeResumed: 'Local silent observation resumed',
    },
  },

}

type DeepString<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => string
    ? (...args: A) => string
    : T[K] extends object
      ? DeepString<T[K]>
      : string
}

export type TranslationKeys = DeepString<typeof translations['zh-CN']>

export function getSystemLocale(): ResolvedLocale {
  if (typeof navigator !== 'undefined') {
    const lang = navigator.language.toLowerCase()
    if (lang.startsWith('en')) {
      return 'en-US'
    }
  }
  return 'zh-CN'
}

interface I18nContextType {
  locale: Locale
  resolvedLocale: ResolvedLocale
  setLocale: (locale: Locale) => void
  t: TranslationKeys
}

const I18nContext = createContext<I18nContextType | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('trace_locale') as Locale
      if (saved && (saved === 'zh-CN' || saved === 'en-US' || saved === 'system')) {
        return saved
      }
    }
    return 'system'
  })

  const resolvedLocale: ResolvedLocale = useMemo(() => {
    return locale === 'system' ? getSystemLocale() : locale
  }, [locale])

  const setLocale = (newLocale: Locale) => {
    if (newLocale === locale) return

    if (typeof window !== 'undefined') {
      const doc = window.document as unknown as { startViewTransition?: (cb: () => void) => void }
      if (typeof doc?.startViewTransition === 'function') {
        doc.startViewTransition(() => {
          setLocaleState(newLocale)
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('trace_locale', newLocale)
          }
        })
        return
      }
    }

    setLocaleState(newLocale)
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('trace_locale', newLocale)
    }
  }

  const t = useMemo(() => translations[resolvedLocale] || translations['zh-CN'], [resolvedLocale])

  return (
    <I18nContext.Provider value={{ locale, resolvedLocale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    throw new Error('useI18n must be used within an I18nProvider')
  }
  return ctx
}
