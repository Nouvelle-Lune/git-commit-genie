// Centralized localization messages (English defaults) used in runtime code.
// Use vscode.l10n.t(I18N.something) to translate. In the default
// language (en), vscode.l10n returns the message as-is.

export const L10N_KEYS = {
  statusBar: {
    tooltipConfigured: 'Git Commit Genie: {0} / {1}',
    tooltipNeedConfig: 'Git Commit Genie: {0} — click to configure models',
    selectModel: 'Select Model',
    chainBadge: ' · Thinking',
    analysisModel: 'Repository Analysis Model: {0} / {1}'
  },
  manageModels: {
    selectProvider: 'Select a provider…',
    configureRepoAnalysisModel: 'Configure Repository Analysis Model',
    configureRepoAnalysisModelDesc: 'For repository analysis feature',
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
    selectRepoAnalysisModel: 'Select a model for repository analysis…',
    configured: 'Configured {0}: {1}',
    repoAnalysisConfigured: 'Repository analysis model configured: {0} / {1}',
    currentSuffix: ' (current)',
    currentLabel: 'Current',
    useDefaultModel: 'Use default model',
    useDefaultModelDesc: 'Follow the general commit message model',
    qwenRegionSelect: 'Select Qwen API Region',
    qwenRegionIntl: 'International',
    qwenRegionIntlDesc: 'For international API keys',
    qwenRegionChina: 'China',
    qwenRegionChinaDesc: 'For mainland China API keys'
  },
  chain: {
    toggled: 'Chain prompting {0}.',
    enabled: 'enabled',
    disabled: 'disabled'
  },
  generation: {
    progressTitle: 'Genie Generating Commit Message…',
    noStagedChanges: 'No staged changes found.',
    cancelled: 'Genie generation cancelled.',
    errorGenerating: 'Error generating commit message: {0}',
    failedToGenerate: 'Failed to generate commit message: {0}'
  },
  stages: {
    title: 'AI Thinking…',
    summarizingStart: 'Analyzing changes…',
    summarizingProgress: 'Analyzing changes ({0}/{1})…',
    classifyDraft: 'Drafting commit message…',
    validateFix: 'Validating against rules…',
    strictFix: 'Fixing format issues…',
    enforceLanguage: 'Enforcing target language…',
    done: 'Done',
    cancelled: 'Cancelled'
  },
  actions: {
    openSettings: 'Open Settings',
    dismiss: 'Dismiss',
    manageModels: 'Manage Models',
    replaceKey: 'Replace Key',
    enterKey: 'Enter Key'
  },
  errors: {
    invalidApiKey: '{0} API key appears invalid or revoked.'
  },
  provider: {
    // API key errors
    apiKeyNotSet: '{0} API key is not set. Please set it in the settings.',
    clientNotInitialized: '{0} client is not initialized',
    // Model errors
    modelNotSelected: '{0} model is not selected. Please configure it via Manage Models.',
    modelNotConfigured: '{0} model is not configured',
    // Service errors
    serviceNotAvailable: '{0} service is not available',
    methodNotSupported: 'Provider does not support {0} method',
    // Chat errors
    chatFailed: '{0} chat failed after retries',
    // Validation errors
    validationFailed: 'Failed to validate structured response from {0}.',
    commitMessageValidationFailed: 'Failed to validate structured commit message from {0}.',
    // Generic errors
    unknownError: 'An unknown error occurred with the {0} API.',
    operationCancelled: 'Operation cancelled',
    invalidResponse: 'Invalid response from {0}',
  },
  common: {
    noWorkspace: 'No workspace folder is open.',
    apiKeyUpdated: '{0} API key updated.',
    generationRunning: 'Generation already running for this repository.',
    noGitRepository: 'No Git repository found.'
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
    openMarkdown: '$(go-to-file) Open repository-analysis.md',
    toggleThingking: '$(thinking) Enable / Disable thinking mode',
  },
  repoAnalysis: {
    running: 'Repository analysis in progress…',
    runningWithRepo: 'Repository analysis in progress for "{0}"…',
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
    missingModel: 'LLM model not selected. Configure models to enable repository analysis.',
    clearConfirm: 'This will delete cached JSON repository analysis for this repository. Continue?',
    clear: 'Clear',
    cleared: 'Repository analysis cache cleared.',
    selectRepository: 'Select a repository',
    resetStepNotification: 'Repository analysis request limit reached, reset request count and continue task?',
    resetAndContinue: 'Reset and continue',
    cancel: 'Cancel'
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
    openFailed: 'Failed to open template: {0}',
    createDirFailed: 'Failed to create template directory'
  },
  costNotification: {
    commitMessageGeneration: 'Commit message generation: ${0} | Cache hit: {1}%',
    repositoryAnalysis: 'Repository analysis: ${0} | Cache hit: {1}%'
  },
  cost: {
    noCostRecorded: 'No Genie usage cost recorded for this repository yet.',
    totalCost: 'Total Genie usage cost for this repository: ${0}',
    failedToGetCost: 'Failed to get repository cost: {0}',
    resetConfirmation: 'Are you sure you want to reset the cost tracking for this repository? This action cannot be undone.',
    reset: 'Reset',
    cancel: 'Cancel',
    resetSuccess: 'Repository cost has been reset to $0.00',
    failedToReset: 'Failed to reset repository cost: {0}'
  }
} as const;

export type L10N_KEY = typeof L10N_KEYS;
