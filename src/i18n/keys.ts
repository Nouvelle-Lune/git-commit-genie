// Centralized localization messages (English defaults) used in runtime code.
// Use vscode.l10n.t(I18N.something) to translate. In the default
// language (en), vscode.l10n returns the message as-is.

export const L10N_KEYS = {
  statusBar: {
    tooltipConfigured: 'Git Commit Genie: {0} / {1}',
    tooltipNeedConfig: 'Git Commit Genie: {0} — click to configure models',
    selectModel: 'Select Model',
    chainBadge: ' · Chain'
  },
  manageModels: {
    selectProvider: 'Select a provider…',
    savedKeyDetected: 'Saved {0} API Key detected',
    reuseSavedKey: 'Reuse saved key ({0})',
    replaceKey: 'Replace key',
    clearReenter: 'Clear & re-enter',
    cancel: 'Cancel',
    enterNewKeyTitle: 'Enter new {0} API Key',
    enterKeyTitle: 'Enter {0} API Key',
    listingModels: 'Listing {0} models using saved key…',
    validatingKey: 'Validating {0} API Key…',
    noModels: 'No models available.',
    selectModel: 'Select a {0} model…',
    configured: 'Configured {0}: {1}',
    currentSuffix: ' (current)',
    currentLabel: 'Current'
  },
  chain: {
    toggled: 'Chain prompting {0}.',
    enabled: 'enabled',
    disabled: 'disabled'
  },
  generation: {
    progressTitle: 'AI Generating Commit Message…',
    noStagedChanges: 'No staged changes found.',
    cancelled: 'AI generation cancelled.',
    errorGenerating: 'Error generating commit message: {0}',
    failedToGenerate: 'Failed to generate commit message: {0}'
  },
  actions: {
    openSettings: 'Open Settings',
    dismiss: 'Dismiss'
  },
  rateLimit: {
    hit: 'Rate limit hit for {0} ({1}). Consider lowering chain concurrency ({2}) or upgrading your plan.'
  },
  settings: {
    chainMaxParallelLabel: 'Max Parallel Chains'
  }
} as const;

export type L10N_KEY = typeof L10N_KEYS;
