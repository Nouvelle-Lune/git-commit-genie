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
    dismiss: 'Dismiss',
    manageModels: 'Manage Models',
    replaceKey: 'Replace Key'
  },
  errors: {
    invalidApiKey: '{0} API key appears invalid or revoked.'
  },
  common: {
    noWorkspace: 'No workspace folder is open.',
    apiKeyUpdated: '{0} API key updated. Please retry.'
  },
  rateLimit: {
    hit: 'Rate limit hit for {0} ({1}). Consider lowering chain concurrency ({2}) or upgrading your plan.'
  },
  settings: {
    chainMaxParallelLabel: 'Max Parallel Chains'
  },
  genieMenu: {
    placeholder: 'Git Commit Genie',
    manageModels: '$(gear) Manage Models',
    cancelAnalysis: '$(stop-circle) Cancel Analysis',
    refreshAnalysis: '$(refresh) Refresh Analysis',
    openMarkdown: '$(file) Open repository-analysis.md'
  },
  repoAnalysis: {
    running: 'Repository analysis in progress…',
    missing: 'Repository analysis missing. Click to re-analyze.',
    idle: 'Repository analysis is up to date.',
    initGitToEnable: 'Initialize a Git repository to enable analysis.',
    promptInitialize: 'Repository analysis not found. Would you like to initialize it?',
    initialize: 'Initialize',
    initializingTitle: 'Initializing repository analysis...',
    refreshingTitle: 'Refreshing repository analysis...',
    refreshed: 'Repository analysis refreshed successfully.',
    mdNotFound: 'repository-analysis.md not found. Use Refresh Analysis to generate it.',
    missingApiKey: 'LLM API key not set. Configure models to enable repository analysis.',
    missingModel: 'LLM model not selected. Configure models to enable repository analysis.'
  },
  templates: {
    pickWorkspaceFolder: 'Pick a workspace folder',
    quickPickPlaceholder: 'Select / manage templates',
    createNew: '$(add) Create new template…',
    deactivate: '$(x) Deactivate current template',
    workspaceFolderLabel: '.gitgenie/templates',
    userDataFolderLabel: 'User data folder',
    activeSuffix: 'Active',
    buttonRename: 'Rename template',
    buttonDelete: 'Delete template',
    buttonOpen: 'Open template',
    chooseLocation: 'Choose where to save the template',
    locationWorkspace: 'Workspace (.gitgenie/templates)',
    locationUser: 'User data folder',
    enterName: 'Enter template name (file will be <name>.md)',
    enterNewName: 'Enter new template name (no extension)',
    templateCreated: 'Template created: {0}',
    templateSelected: 'Template selected: {0}',
    templateDeactivated: 'Template deactivated.',
    deleteFailed: 'Failed to delete template: {0}',
    renameExists: 'A template with that name already exists.',
    renameFailed: 'Rename failed: {0}',
    openFailed: 'Failed to open template: {0}'
  },
  costNotification: {
    commitMessageGeneration: 'Commit message generation: ${0} | Cache hit: {1}%',
    repositoryAnalysis: 'Repository analysis: ${0} | Cache hit: {1}%'
  },
  cost: {
    noCostRecorded: 'No AI usage cost recorded for this repository yet.',
    totalCost: 'Total AI usage cost for this repository: ${0}',
    failedToGetCost: 'Failed to get repository cost: {0}',
    resetConfirmation: 'Are you sure you want to reset the cost tracking for this repository? This action cannot be undone.',
    reset: 'Reset',
    cancel: 'Cancel',
    resetSuccess: 'Repository cost has been reset to $0.00',
    failedToReset: 'Failed to reset repository cost: {0}'
  }
} as const;

export type L10N_KEY = typeof L10N_KEYS;
