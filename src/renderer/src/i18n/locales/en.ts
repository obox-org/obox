/**
 * English language pack (host UI + builtin extensions).
 * Keys mirror zh.ts.
 */
export default {
  app: {
    title: 'Obox'
  },
  common: {
    cancel: 'Cancel',
    confirm: 'Confirm',
    close: 'Close',
    search: 'Search',
    name: 'Name',
    version: 'Version',
    author: 'Author',
    description: 'Description',
    empty: 'Nothing here',
    enabled: 'Enabled',
    disabled: 'Disabled',
    builtin: 'Built-in',
    user: 'User',
    debug: 'Debugging',
    install: 'Install',
    uninstall: 'Uninstall',
    restart: 'Reload Now'
  },
  titlebar: {
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore'
  },
  navbar: {
    extensions: 'Extensions',
    apps: 'Apps',
    settings: 'Settings'
  },
  statusbar: {
    ready: 'Ready'
  },
  palette: {
    placeholder: 'Type a command…',
    empty: 'No matching commands',
    prefix: '>',
    showCommands: 'Show Command Palette'
  },
  content: {
    empty: 'Select an item from the navigation'
  },
  extManager: {
    title: 'Extension Manager',
    installBtn: 'Install Extension',
    installing: 'Installing…',
    searchPlaceholder: 'Search extensions (name/author)…',
    sortName: 'By name',
    sortInstalled: 'By install time',
    count: 'extensions',
    showBuiltin: 'Show built-in',
    dropHint: 'Drop to install .oix extension package',
    unknownAuthor: 'Unknown author',
    noDescription: 'No description',
    invalidManifest: 'Invalid manifest',
    back: '← Back to list',
    fields: {
      author: 'Author',
      description: 'Description',
      identifier: 'Identifier',
      source: 'Source',
      lastUpdated: 'Last Updated',
      dependencies: 'Dependencies',
      status: 'Status'
    },
    states: {
      activationFailed: 'Activation failed',
      invalidManifest: 'Invalid manifest',
      pendingRestart: 'Pending restart',
      running: 'Running',
      disabled: 'Disabled',
      enabled: 'Enabled'
    },
    validations: 'Validation Messages',
    actions: {
      disable: 'Disable',
      enable: 'Enable',
      uninstall: 'Uninstall'
    },
    uninstallConfirm: {
      title: 'Confirm Uninstall',
      body: 'Are you sure you want to uninstall "{name}"? Its directory will be deleted and the change takes effect after restart. This cannot be undone.',
      uninstall: 'Uninstall'
    },
    notices: {
      installed: '"{name}" v{version} installed and activated (effective immediately)',
      installFailed: 'Install failed: {msg}',
      uninstalledHot: 'Uninstalled (effective immediately)',
      uninstalledRestart: 'Uninstalled. Click "Reload Now" to apply',
      toggledHot: '{action} (effective immediately)',
      toggledRestart: '{action}. Click "Reload Now" to apply',
      dragOnlyOix: 'Please drop a .oix extension package'
    }
  },
  appExt: {
    title: 'Apps',
    searchPlaceholder: 'Search apps (name/author/description)…',
    count: 'apps',
    openHint: 'Click to open in a new window',
    empty: 'No apps registered yet',
    emptyHint: 'Extensions can register app cards via api.app.register',
    notFound: 'App "{appId}" not found (may have been removed or disabled)',
    emptyContent: 'Empty content'
  },
  settings: {
    title: 'Settings',
    tree: {
      general: 'General',
      appearance: 'Appearance',
      language: 'Language',
      keyboard: 'Keyboard Shortcuts',
      extensions: 'Extensions',
      update: 'Update',
      network: 'Network',
      ai: 'AI',
      notification: 'Notifications'
    },
    appearance: {
      title: 'Appearance',
      theme: 'Theme',
      themeDesc: 'Choose the interface theme (provided by theme extensions)'
    },
    language: {
      title: 'Language',
      locale: 'Language',
      localeDesc: 'Choose the interface language. Takes effect immediately.'
    },
    keyboard: {
      title: 'Keyboard Shortcuts',
      desc: 'Modify keybindings for built-in commands',
      command: 'Command',
      keybinding: 'Keybinding',
      edit: 'Edit',
      conflict: 'Keybinding conflict: {key} is already used by "{command}"',
      captureHint: 'Press the new key combination… (Esc to cancel)',
      reset: 'Reset'
    },
    extensionsSection: {
      title: 'Extensions',
      empty: 'No extension settings',
      select: 'Select an extension from the tree to view its settings',
      browse: 'Browse…',
      noValue: '(none)'
    },
    update: {
      title: 'Update',
      provider: 'Update Provider Extension',
      providerDesc:
        'Choose the non-builtin extension that provides obox update capability (only one active). Updates are not checked when none is selected.',
      noProvider: 'No update provider extensions',
      selected: 'Active',
      currentVersion: 'Current version',
      checkBtn: 'Check for Updates',
      checking: 'Checking…',
      upToDate: 'You are up to date',
      updateAvailable: 'Update {version} available',
      downloadBtn: 'Download Update',
      downloading: 'Downloading… {percent}%',
      downloaded: 'Update downloaded',
      installBtn: 'Restart to Install',
      noFeed: 'This update extension has no feed URL configured'
    },
    network: {
      title: 'Network',
      proxy: 'Proxy',
      proxyDesc:
        'obox and builtin extensions use this proxy; non-builtin extensions may opt in (api.proxy).',
      enabled: 'Enable proxy',
      url: 'Proxy URL',
      urlPlaceholder: 'http://127.0.0.1:7890',
      // ⚠️ `@` must be escaped as {'@'}: vue-i18n reads a bare `@` as linked-message syntax (@:key),
      // which throws "Message compilation error: Invalid linked format" and blanks the whole page.
      urlHint:
        "Supports http / https / socks4 / socks5; credentials may be embedded in the URL (http://user:pass{'@'}host:8080); leave empty for a direct connection.",
      ignoreSSL: 'Ignore SSL certificate validation',
      noProxy: 'No-proxy list (one per line, e.g. localhost, 127.0.0.1)'
    },
    // AI (OpenAI-compatible endpoint parameters): all five settings live in stateStore under `ai.`.
    // This page only stores and displays them (nothing consumes them yet); the only action is the
    // connection test. Connection results are produced by the main process in Chinese.
    ai: {
      title: 'AI',
      intro:
        'Configure an OpenAI-compatible endpoint. This release only stores and displays these values — no feature consumes them yet. "Test connection" sends one real request with the current settings.',
      baseUrl: 'baseUrl (API root)',
      baseUrlPlaceholder: 'https://api.openai.com/v1',
      baseUrlHint:
        'Root URL of an OpenAI-compatible endpoint, usually ending with /v1; a trailing slash is fine.',
      apiKey: 'apiKey (secret key)',
      apiKeyEmpty: '(not set)',
      apiKeyHint:
        'The key is stored in plain text in this machine’s local config (persisted via localStorage, like every other setting). Leave it empty to send no Authorization header — some local endpoints need no key, but endpoints that do will answer 401.',
      show: 'Show',
      hide: 'Hide',
      model: 'model',
      modelPlaceholder: 'gpt-4o-mini',
      contextLen: 'contextLen (max context length)',
      contextLenHint:
        'In tokens. Empty or invalid falls back to the default {default}; values above the cap {max} are clamped.',
      dailyLimit: 'Daily limit (requests)',
      dailyLimitHint:
        'Leave empty for unlimited (stored as empty); 0 means a quota of zero — the two differ.',
      test: 'Test connection',
      testing: 'Testing…',
      testHint:
        'Sends one GET request to “API root + /models” to check connectivity (through the host proxy, 10s timeout).',
      // Renderer-side fast fail (no request at all): same rule as the main process, minus the round trip
      needBaseUrl: 'Please fill in baseUrl first',
      invalidBaseUrl: 'baseUrl must start with http:// or https://',
      testFailed: 'Connection test failed: {msg}'
    },
    notification: {
      title: 'Notifications',
      desc: 'Control system notifications per extension (extensions show them via api.notification.show). Disabled extensions will not pop notifications.',
      empty: 'No extensions'
    },
    general: {
      title: 'General',
      closeBehavior: 'When closing the main window',
      closeAsk: 'Always ask (hide to tray or quit)',
      closeHide: 'Hide to tray',
      closeQuit: 'Quit the app',
      closeBehaviorDesc:
        'obox keeps running in the notification area: hiding keeps extensions alive and the window can be reopened from the tray icon; quitting ends all extensions and child processes.',
      autoStart: 'Launch obox at login',
      autoStartDesc:
        'Launching at login is **silent**: no main window, just the tray icon (open it from there). Development builds do not register this.',
      windowsOnly: 'This platform has no system tray; the option is Windows-only.'
    },
    unsaved: 'Unsaved changes'
  },
  themes: {
    dark: 'Dark',
    light: 'Light'
  }
}
