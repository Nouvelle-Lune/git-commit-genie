// Centralized localization keys used in runtime code.
// Use vscode.l10n.t(keys.something) to translate.

export const L10N_KEYS = {
  statusBar: {
    tooltipConfigured: 'status.tooltip.configured',
    tooltipNeedConfig: 'status.tooltip.needConfig',
    selectModel: 'gitCommitGenie.statusBar.selectModel',
    chainBadge: 'status.chainBadge'
  },
  manageModels: {
    selectProvider: 'manageModels.selectProvider',
    savedKeyDetected: 'manageModels.savedKeyDetected',
    reuseSavedKey: 'manageModels.reuseSavedKey',
    replaceKey: 'manageModels.replaceKey',
    clearReenter: 'manageModels.clearReenter',
    cancel: 'manageModels.cancel',
    enterNewKeyTitle: 'manageModels.enterNewKeyTitle',
    enterKeyTitle: 'manageModels.enterKeyTitle',
    listingModels: 'manageModels.listingModels',
    validatingKey: 'manageModels.validatingKey',
    noModels: 'manageModels.noModels',
    selectModel: 'manageModels.selectModel',
    configured: 'manageModels.configured',
    currentSuffix: 'manageModels.currentSuffix'
  },
  chain: {
    toggled: 'chain.toggled',
    enabled: 'chain.enabled',
    disabled: 'chain.disabled'
  },
  generation: {
    progressTitle: 'generation.progressTitle',
    noStagedChanges: 'generation.noStagedChanges',
    cancelled: 'generation.cancelled',
    errorGenerating: 'generation.errorGenerating',
    failedToGenerate: 'generation.failedToGenerate'
  },
  actions: {
    openSettings: 'action.openSettings',
    dismiss: 'action.dismiss'
  },
  rateLimit: {
    hit: 'rateLimit.hit'
  }
} as const;

export type L10N_KEY = typeof L10N_KEYS;
