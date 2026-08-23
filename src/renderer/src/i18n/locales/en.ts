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
      appearance: 'Appearance',
      language: 'Language',
      keyboard: 'Keyboard Shortcuts',
      extensions: 'Extensions',
      update: 'Update',
      network: 'Network'
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
      select: 'Select an extension from the tree to view its settings'
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
      host: 'Host',
      port: 'Port',
      username: 'Username',
      password: 'Password',
      ignoreSSL: 'Ignore SSL certificate validation',
      noProxy: 'No-proxy list (one per line, e.g. localhost, 127.0.0.1)'
    },
    unsaved: 'Unsaved changes'
  },
  themes: {
    dark: 'Dark',
    light: 'Light'
  }
}
