/**
 * 中文语言包（宿主 UI + 内置扩展共用）。
 * key 约定：app.* 布局框架、ext-manager.* 扩展管理器、app-ext.* 应用、settings.* 设置。
 */
export default {
  app: {
    title: 'Obox'
  },
  common: {
    cancel: '取消',
    confirm: '确认',
    close: '关闭',
    search: '搜索',
    name: '名称',
    version: '版本',
    author: '作者',
    description: '简介',
    empty: '暂无内容',
    enabled: '已启用',
    disabled: '已禁用',
    builtin: '内置',
    user: '用户',
    debug: '调试中',
    install: '安装',
    uninstall: '卸载',
    restart: '立即重启'
  },
  titlebar: {
    minimize: '最小化',
    maximize: '最大化',
    restore: '还原'
  },
  navbar: {
    extensions: '扩展',
    apps: '应用',
    settings: '设置'
  },
  statusbar: {
    ready: '就绪'
  },
  palette: {
    placeholder: '输入命令…',
    empty: '无匹配命令',
    prefix: '>',
    showCommands: '显示命令面板'
  },
  content: {
    empty: '选择一个导航项开始'
  },
  extManager: {
    title: '扩展管理器',
    installBtn: '安装扩展',
    installing: '安装中…',
    searchPlaceholder: '搜索扩展（名称/作者）…',
    sortName: '按名称',
    sortInstalled: '按安装时间',
    count: '个扩展',
    showBuiltin: '显示内置',
    dropHint: '松开以安装 .oix 扩展包',
    unknownAuthor: '未知作者',
    noDescription: '暂无简介',
    invalidManifest: '清单无效',
    back: '← 返回列表',
    fields: {
      author: '作者',
      description: '简介',
      identifier: 'Identifier',
      source: 'Source',
      lastUpdated: 'Last Updated',
      dependencies: '依赖',
      status: '状态'
    },
    states: {
      activationFailed: '激活失败',
      invalidManifest: '清单无效',
      pendingRestart: '变更待重启生效',
      running: '运行中',
      disabled: '已禁用',
      enabled: '已启用'
    },
    validations: '校验信息',
    actions: {
      disable: '禁用',
      enable: '启用',
      uninstall: '卸载'
    },
    uninstallConfirm: {
      title: '确认卸载',
      body: '确定要卸载「{name}」吗？将删除其目录，重启后生效，此操作不可恢复。',
      uninstall: '确认卸载'
    },
    notices: {
      installed: '「{name}」v{version} 安装成功并已激活（立即生效）',
      installFailed: '安装失败: {msg}',
      uninstalledHot: '已卸载（立即生效）',
      uninstalledRestart: '已卸载，点击"立即重启"生效',
      toggledHot: '已{action}（立即生效）',
      toggledRestart: '已{action}，点击"立即重启"生效',
      dragOnlyOix: '请拖入 .oix 扩展包文件'
    }
  },
  appExt: {
    title: '应用',
    searchPlaceholder: '搜索应用（名称/作者/简介）…',
    count: '个应用',
    openHint: '点击打开独立窗口',
    empty: '暂无已注册的应用',
    emptyHint: '扩展可通过 api.app.register 注册插件卡片',
    notFound: '未找到应用「{appId}」（可能已被移除或禁用）',
    emptyContent: '空内容'
  },
  settings: {
    title: '设置',
    tree: {
      appearance: '外观',
      language: '语言',
      keyboard: '快捷键',
      extensions: '扩展',
      update: '更新',
      network: '网络'
    },
    appearance: {
      title: '外观',
      theme: '主题',
      themeDesc: '选择界面主题（由主题扩展提供）'
    },
    language: {
      title: '语言',
      locale: '语言',
      localeDesc: '选择界面语言，切换后立即生效'
    },
    keyboard: {
      title: '快捷键',
      desc: '修改内置命令的快捷键组合',
      command: '命令',
      keybinding: '按键',
      edit: '编辑',
      conflict: '按键冲突：{key} 已被「{command}」占用',
      captureHint: '按下新的按键组合…（Esc 取消）',
      reset: '重置'
    },
    extensionsSection: {
      title: '扩展',
      empty: '暂无扩展设置项',
      select: '从左侧选择扩展以查看其设置'
    },
    update: {
      title: '更新',
      provider: '更新提供者扩展',
      providerDesc: '选择提供 obox 更新能力的非内置扩展（只能一个生效）。未选择时不检查更新。',
      noProvider: '暂无更新提供者扩展',
      selected: '当前生效',
      currentVersion: '当前版本',
      checkBtn: '检查更新',
      checking: '检查中…',
      upToDate: '已是最新版本',
      updateAvailable: '发现新版本 {version}',
      downloadBtn: '下载更新',
      downloading: '下载中… {percent}%',
      downloaded: '更新已下载',
      installBtn: '重启并安装',
      noFeed: '该更新扩展未配置更新源'
    },
    network: {
      title: '网络',
      proxy: '代理',
      proxyDesc: 'obox 与内置扩展使用此代理；非内置扩展可选使用（api.proxy）。',
      enabled: '启用代理',
      host: '主机',
      port: '端口',
      username: '用户名',
      password: '密码',
      ignoreSSL: '忽略 SSL 证书校验',
      noProxy: '排除列表（每行一个，如 localhost, 127.0.0.1）'
    },
    unsaved: '未保存的更改'
  },
  themes: {
    dark: '深色',
    light: '浅色'
  }
}
