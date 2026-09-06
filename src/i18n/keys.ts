// Centralized localization messages (English defaults) used in runtime code.
// Use vscode.l10n.t(I18N.something) to translate. In the default
// language (en), vscode.l10n returns the message as-is.

import { DEFAULT_PIPELINE_TEXT } from '../ui/pipelineDisplay';

export const L10N_KEYS = {
  statusBar: {
    tooltipConfigured: 'Git Commit Genie: {0}',
    tooltipNeedConfig: 'Git Commit Genie: {0} — click to configure models',
    selectModel: 'Select Model',
    chainBadge: ' · Thinking',
    analysisModel: 'Repository Analysis Model: {0}'
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
    currentLabel: 'Current',
    useDefaultModel: 'Use default model',
    useDefaultModelDesc: 'Follow the general commit message model',
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
    evidenceReady: 'Change evidence collected…',
    evidenceRouted: 'Preparing {0}…',
    summarizingStart: 'Analyzing changes…',
    summarizingProgress: 'Analyzing changes ({0}/{1})…',
    summarizingFailed: 'Evidence compaction failed…',
    changeExtraction: 'Extracting changed symbols…',
    investigationPlan: 'Planning repository investigation…',
    investigationStart: 'Investigating the repository…',
    investigationStep: 'Investigating the repository ({0}/{1})…',
    investigationComplete: 'Repository evidence collected…',
    investigationSkipped: 'Repository investigation skipped…',
    semanticAnalysis: 'Analyzing what this change means…',
    informationSelection: 'Selecting what to express…',
    ragDisabled: 'RAG disabled; continuing to draft…',
    ragPrepared: 'RAG query ready…',
    ragRetrievalStart: 'Searching commit history…',
    ragRetrieved: 'RAG references ready ({0})…',
    ragSkipped: 'RAG unavailable; continuing to draft…',
    draftStart: 'Drafting commit message…',
    classifyDraft: 'Drafting commit message…',
    validationStart: 'Validating against rules…',
    validateFix: 'Validating against rules…',
    strictFixStart: 'Fixing format issues…',
    strictFix: 'Fixing format issues…',
    enforceLanguageStart: 'Enforcing target language…',
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
    noGitRepository: 'No Git repository found.',
    onlyOneRepository: 'Only one repository available'
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
    toggleThinking: '$(thinking) Enable / Disable thinking mode',
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
  },
  cost: {
    noCostRecorded: 'No Genie usage cost recorded for this repository yet.',
    totalCost: 'Total Genie usage cost for this repository: ${0}',
    totalCostFree: 'Total Genie usage cost for this repository: Free',
    totalCostPartial: 'Total Genie usage cost for this repository: ${0} (incomplete)',
    failedToGetCost: 'Failed to get repository cost: {0}',
    resetConfirmation: 'Are you sure you want to reset the cost tracking for this repository? This action cannot be undone.',
    reset: 'Reset',
    cancel: 'Cancel',
    resetSuccess: 'Repository cost has been reset to $0.00',
    failedToReset: 'Failed to reset repository cost: {0}',
    free: 'Free',
    unpriced: 'Unpriced',
    unavailable: 'Cost unavailable',
    incompleteMarker: 'incomplete',
  },
  dashboard: {
    repositoryList: 'Repository List',
    logs: 'Logs',
    noLogsYet: 'No logs yet',
    clearLogs: 'Clear logs',
    analyzing: 'Analyzing {0}…',
    repairRagEmbeddings: 'Repair RAG Embeddings'
  },
  pipeline: DEFAULT_PIPELINE_TEXT,
  rag: {
    enterEmbeddingKeyTitle: 'Configure RAG Embedding API Key',
    enterEmbeddingKeyPrompt: 'Enter your embedding API key',
    embeddingKeySaved: 'RAG embedding API key saved.',
    embeddingKeyCleared: 'RAG embedding API key cleared.',
    backendNotConfigured: 'RAG embedding backend is not configured. Please configure the API key and model first.',
    indexingAlreadyRunning: 'RAG indexing is already running for "{0}".',
    indexingStarted: 'RAG indexing started for "{0}".',
    statusImporting: 'Importing commits…',
    statusIndexingCancelled: 'Indexing cancelled',
    indexingCancelled: 'RAG indexing cancelled for "{0}".',
    indexingCompleted: 'RAG indexing completed for "{0}".',
    statusImportFailed: 'RAG import failed: {0}',
    statusImportFailedShort: 'Import failed',
    indexingFailed: 'RAG indexing failed for "{0}": {1}',
    indexingNothingToCancel: 'No active RAG indexing to cancel.',
    indexingCancelRequested: 'Cancel requested for "{0}". Indexing will stop after the current batch.',
    embeddingRepairCompleted: 'RAG embedding repair completed: {0} embedding(s) repaired.',
    embeddingRepairFailed: 'RAG embedding repair failed: {0}',
    statusDisabled: 'RAG disabled',
    statusEmbedding: 'Generating embeddings…',
    statusEmbeddingRepairNeeded: 'Embedding repair needed',
    statusPreparingStore: 'Preparing store…',
    statusStoreReady: 'Store ready ({0} commits)',
    statusStoreRebuilt: 'Store rebuilt',
    statusReady: '{0} commits indexed',
    statusReadyWithVectors: '{0} commits, {1} vectors indexed',
    statusIndexingProgress: 'Indexing commits ({0}/{1})…',
    statusIndexingProgressDetail: 'Indexing commits ({0}/{1}), {2} remaining'
  }
} as const;

export type L10N_KEY = typeof L10N_KEYS;
