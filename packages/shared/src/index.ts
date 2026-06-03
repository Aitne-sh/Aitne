// Date utilities
export {
  localDateStr,
  nowInTimezone,
  getAgentDayBoundsUtc,
  getAgentDayDateStr,
  getAgentDayProgressMinutes,
  getAgentDaySqlShiftModifier,
  nextActiveHoursStart,
  formatSqliteDatetime,
  parseSqliteUtcMs,
} from "./date-utils.js";

// Types
export {
  EventPriority,
  createEvent,
  isMessageEvent,
  isDocsQAMessage,
  isCalendarChangeEvent,
  isRoutineEvent,
  isAgentTaskEvent,
  isScheduledDmEvent,
  isScheduledBrowserTaskEvent,
  isScheduledEvent,
  isKnowledgeImportEvent,
} from "./types.js";
export type {
  Event,
  MessageEvent,
  AttachmentRef,
  CalendarChangeEvent,
  RoutineEvent,
  AgentTaskEvent,
  ScheduledDmEvent,
  ScheduledBrowserTaskEvent,
  KnowledgeImportEvent,
  AgentResult,
} from "./types.js";

// Notifications Center alert types — see docs/design/20-notifications-center.md
export type { Alert, AlertSeverity, AlertSource } from "./alerts.js";

// Brand identity (single source of truth for product name / role anchor /
// tagline — substituted into agent-asset markdown and consumed directly
// by TS imports across daemon + dashboard). See `branding.ts`.
export {
  APP_NAME,
  AGENT_ROLE_DESCRIPTOR,
  APP_TAGLINE,
  joinTaglineWithSentence,
  substituteBrandTokens,
} from "./branding.js";

// Multi-backend shared types
export {
  BACKEND_IDS,
  EXECUTION_PERMISSION_MODES,
  RUNTIME_AVAILABLE_BACKEND_IDS,
  WEB_SEARCH_CAPABLE_BACKENDS,
  getBackendIds,
  isBackendId,
  isRuntimeAvailableBackendId,
} from "./backend.js";
export type {
  BackendId,
  BackendCostSource,
  BackendModel,
  BackendModelTier,
  BackendUsage,
  ExecutionPermissionMode,
} from "./backend.js";

// Per-backend provider auth config (direct API key / Bedrock / Vertex /
// Foundry / Codex Azure / Gemini Vertex). See `backend-api-key-config.ts`.
export {
  CLAUDE_API_KEY_PROVIDERS,
  CODEX_API_KEY_PROVIDERS,
  GEMINI_API_KEY_PROVIDERS,
  OPENCODE_API_KEY_PROVIDERS,
  API_KEY_PROVIDERS_BY_BACKEND,
  RECOMMENDED_PINNED_MODELS_BY_PROVIDER,
  DEFAULT_AZURE_OPENAI_API_VERSION,
  defaultApiKeyProvider,
  isApiKeyProviderForBackend,
  backendApiKeyConfigSchema,
  anthropicApiKeyConfigSchema,
  bedrockApiKeyConfigSchema,
  vertexApiKeyConfigSchema,
  foundryApiKeyConfigSchema,
  openaiApiKeyConfigSchema,
  azureOpenAiApiKeyConfigSchema,
  googleApiKeyConfigSchema,
  opencodeServerApiKeyConfigSchema,
  buildCodexAzureConfigToml,
  getManagedApiKeyEnvVars,
  getApiKeyEnvAssignments,
  parseBackendApiKeyConfig,
  serializeBackendApiKeyConfig,
  validateBackendApiKeyConfigFormat,
  isPlausibleAnthropicApiKey,
  isPlausibleOpenAiApiKey,
  isPlausibleGeminiApiKey,
} from "./backend-api-key-config.js";
export type {
  ApiKeyProvider,
  ClaudeApiKeyProvider,
  CodexApiKeyProvider,
  GeminiApiKeyProvider,
  OpencodeApiKeyProvider,
  AnthropicApiKeyConfig,
  BedrockApiKeyConfig,
  VertexApiKeyConfig,
  FoundryApiKeyConfig,
  OpenAiApiKeyConfig,
  AzureOpenAiApiKeyConfig,
  GoogleApiKeyConfig,
  OpencodeServerApiKeyConfig,
  PinnedModelDefaults,
  BackendApiKeyConfig,
} from "./backend-api-key-config.js";

export { buildOpencodePermission } from "./opencode-permission.js";
export type {
  OpencodeBashPermission,
  OpencodeMcpLocalServerConfig,
  OpencodeMcpRemoteServerConfig,
  OpencodeMcpServerConfig,
  OpencodePermissionBuildInput,
  OpencodePermissionBuildResult,
  OpencodePermissionConfig,
  OpencodePermissionValue,
  OpencodeRuntimeConfig,
} from "./opencode-config.js";

// Process-key helpers
export {
  CONFIGURABLE_PROCESS_KEYS,
  DELEGATED_TASK_HARD_CAPS,
  TIER_LOCKED_PROCESS_KEYS,
  customRoutineKey,
  customRoutineSlugFromKey,
  getDefaultTierForProcessKey,
  isAutonomousProcessKey,
  isConfigurableProcessKey,
  isCustomRoutineKey,
  isProcessKey,
  isProcessTier,
  resolveProcessKey,
} from "./process-key.js";
export type {
  ProcessKey,
  ProcessModelTier,
} from "./process-key.js";

// Browser History integration shared contracts
export {
  browserHistoryBrowserKeySchema,
  browserHistoryDetectionStatusSchema,
  browserHistoryCategorySchema,
  browserHistoryBrowserOverrideSchema,
  browserHistoryPerBrowserLifecycleConfigSchema,
  browserHistoryLifecycleConfigSchema,
  browserHistoryLifecycleStateValueSchema,
  browserHistoryCapabilityDetailSchema,
  browserHistoryCapabilitiesSchema,
  browserHistoryLifecycleBrowserStateSchema,
  browserHistoryLifecycleStateSchema,
  browserHistoryClusterStatusSchema,
  browserHistoryClusterListItemSchema,
  browserHistoryResearchClustersResponseSchema,
  yesterdayResearchSummarySchema,
  browserHistoryStatusResponseSchema,
  browserShoppingSessionSchema,
  browserShoppingDateResponseSchema,
  browserReloadEntrySchema,
  browserReloadsTodayResponseSchema,
  browserReloadsWeeklyResponseSchema,
  browserHistoryDomainLabelSchema,
  browserHistoryClusterDetailSchema,
  browserHistoryClusterDeltaEntrySchema,
  browserHistoryClusterDeltaResponseSchema,
  browserHistoryOfferKindSchema,
  browserHistoryPendingOfferSchema,
  browserHistoryPendingOffersResponseSchema,
  browserHistoryAcceptOfferRequestSchema,
  browserHistoryAcceptOfferResponseSchema,
  browserHistoryWikiWrittenResponseSchema,
  weeklyInterestsClusterStatusSchema,
  weeklyInterestsClusterStatusChangeSchema,
  weeklyInterestsClusterSnapshotSchema,
  weeklyInterestsDormantEntrySchema,
  weeklyInterestsProjectMatchSchema,
  weeklyInterestsSummaryResponseSchema,
  refreshInterestsReflectionSkipReasonSchema,
  refreshInterestsReflectionResponseSchema,
  cleanupInterestsReflectionRequestSchema,
  cleanupInterestsReflectionResponseSchema,
  preMorningDigestClusterEntrySchema,
  preMorningDigestShoppingEntrySchema,
  preMorningDigestReloadEntrySchema,
  preMorningDigestPendingOfferSchema,
  preMorningDigestSchema,
  managedChromiumStateValueSchema,
  managedChromiumStatusResponseSchema,
  managedChromiumSetupStatusResponseSchema,
  managedChromiumEnableRequestSchema,
  managedChromiumActionResponseSchema,
  chromiumInstallStateSchema,
  chromiumInstallStatusResponseSchema,
  chromiumInstallStartResponseSchema,
  // BROWSER_TASK_REDESIGN_PLAN.md §9 Phase 6 + Phase 6.5 follow-up —
  // Phase B-2 / B-3 workflow + approval + observation-gate + allowlist
  // schemas removed alongside the routes that consumed them. The
  // B-2.5 site schemas below stay; B-4 purchase + lite-final-confirm
  // surfaces live further down in the file.
  browserAutomationSiteConnectionStateSchema,
  browserAutomationSiteSummarySchema,
  browserAutomationSitesResponseSchema,
  browserAutomationSiteStatusResponseSchema,
  browserAutomationSiteActionResponseSchema,
} from "./browser-history-schemas.js";
export type {
  BrowserHistoryBrowserKey,
  BrowserHistoryDetectionStatus,
  BrowserHistoryCategory,
  BrowserHistoryBrowserOverride,
  BrowserHistoryPerBrowserLifecycleConfig,
  BrowserHistoryLifecycleConfig,
  BrowserHistoryLifecycleStateValue,
  BrowserHistoryCapabilityDetail,
  BrowserHistoryCapabilities,
  BrowserHistoryLifecycleBrowserState,
  BrowserHistoryLifecycleState,
  BrowserHistoryClusterStatus,
  BrowserHistoryClusterListItem,
  BrowserHistoryResearchClustersResponse,
  YesterdayResearchSummary,
  BrowserHistoryStatusResponse,
  BrowserShoppingSession,
  BrowserShoppingDateResponse,
  BrowserReloadEntry,
  BrowserReloadsTodayResponse,
  BrowserReloadsWeeklyResponse,
  BrowserHistoryClusterDetail,
  BrowserHistoryClusterDeltaResponse,
  BrowserHistoryOfferKind,
  BrowserHistoryPendingOffer,
  BrowserHistoryPendingOffersResponse,
  BrowserHistoryAcceptOfferRequest,
  BrowserHistoryAcceptOfferResponse,
  BrowserHistoryWikiWrittenResponse,
  WeeklyInterestsClusterStatus,
  WeeklyInterestsClusterStatusChange,
  WeeklyInterestsClusterSnapshot,
  WeeklyInterestsDormantEntry,
  WeeklyInterestsProjectMatch,
  WeeklyInterestsSummaryResponse,
  RefreshInterestsReflectionResponse,
  CleanupInterestsReflectionRequest,
  CleanupInterestsReflectionResponse,
  PreMorningDigestClusterEntry,
  PreMorningDigestShoppingEntry,
  PreMorningDigestReloadEntry,
  PreMorningDigestPendingOffer,
  PreMorningDigest,
  ManagedChromiumStateValue,
  ManagedChromiumStatusResponse,
  ManagedChromiumSetupStatusResponse,
  ManagedChromiumEnableRequest,
  ManagedChromiumActionResponse,
  ChromiumInstallState,
  ChromiumInstallStatusResponse,
  ChromiumInstallStartResponse,
  BrowserAutomationSiteConnectionState,
  BrowserAutomationSiteSummary,
  BrowserAutomationSitesResponse,
  BrowserAutomationSiteStatusResponse,
  BrowserAutomationSiteActionResponse,
} from "./browser-history-schemas.js";

// Wiki builder shared contract
export {
  WIKI_BRIDGE_OUTCOMES,
  WIKI_PROCESS_KEYS,
  wikiBridgeProposalSchema,
  wikiBridgeTriggerSchema,
  wikiCompileModeSchema,
  wikiDispatchModeSchema,
  wikiFilePatchSchema,
  wikiFilePostSchema,
  wikiImportDecisionSchema,
  wikiReplyTargetSchema,
  wikiVaultModeSchema,
  wikiWorkspaceCreateSchema,
  wikiWorkspacePatchSchema,
  wikiWorkspaceProbeSchema,
  wikiWriteStrategySchema,
} from "./wiki.js";
export type {
  WikiBridgeOutcome,
  WikiBridgeProposal,
  WikiBridgeResult,
  WikiBridgeTrigger,
  WikiCompileMode,
  WikiCompilePreview,
  WikiCostEstimate,
  WikiCostEstimateFile,
  WikiCostEstimateMethod,
  WikiDispatchMode,
  WikiFilePatch,
  WikiFilePost,
  WikiImportDecision,
  WikiProcessKey,
  WikiReplyTarget,
  WikiVaultMode,
  WikiWorkspaceCreate,
  WikiWorkspacePatch,
  WikiWorkspaceProbeInput,
  WikiWriteStrategy,
} from "./wiki.js";

// Schemas
export {
  contextPutSchema,
  contextPatchSchema,
  notifyRequestSchema,
  scheduleRequestSchema,
  scheduleUpdateRequestSchema,
  scheduleDmRequestSchema,
  scheduleBatchRequestSchema,
  scheduleBatchRowSchema,
  scheduleBatchTaskContextSchema,
  actionLogRequestSchema,
  skillNameSchema,
  skillCreateSchema,
  skillUpdateSchema,
  calendarCreateEventSchema,
  calendarUpdateEventSchema,
  calendarFreeBusySchema,
  recurrenceRuleSchema,
  recurringScheduleCreateSchema,
  recurringScheduleUpdateSchema,
  triggerCreateSchema,
  triggerUpdateSchema,
  SCHEDULE_PROMPT_MAX_CHARS,
  SCHEDULE_DESCRIPTION_MAX_CHARS,
} from "./schemas.js";
export type {
  NotifyRequest,
  ScheduleRequest,
  ScheduleUpdateRequest,
  ScheduleDmRequest,
  ScheduleBatchRequest,
  ScheduleBatchRow,
  ScheduleBatchTaskContext,
  ActionLogRequest,
  SkillCreateRequest,
  SkillUpdateRequest,
  SkillSummary,
  SkillDetail,
  RecurrenceRule,
  TriggerCreateRequest,
  TriggerUpdateRequest,
} from "./schemas.js";

// Agent identity helpers
export {
  DEFAULT_AGENT_DISPLAY_NAME,
  normalizeAgentDisplayName,
  validateAgentDisplayName,
  formatAgentOutboundLabel,
} from "./agent-identity.js";

// Agent Definitions — declarative `agent.md` frontmatter contract
// (AGENT_DEFINITIONS_DESIGN.md §4.3). Single typed source of truth imported by
// the daemon loader/registry/stores, the `/api/agents` routes, and the
// dashboard editor.
export {
  AGENT_KINDS,
  AGENT_TIERS,
  SCHEDULE_KINDS,
  AGENT_SLUG_PATTERN,
  stopWarningSchema,
  successCriterionSchema,
  agentScheduleSchema,
  agentDefinitionSchema,
  OVERRIDE_EDIT_PATHS,
} from "./agent-definitions.js";
export type {
  AgentKind,
  AgentTier,
  ScheduleKind,
  StopWarning,
  SuccessCriterion,
  AgentDefinition,
  OverrideEditPath,
} from "./agent-definitions.js";

// Log entry types (shared between daemon buffer and dashboard)
export type { LogEntry, SystemLogsResponse } from "./log-entry.js";

// Secret redaction helpers
export {
  redactSensitiveString,
  SENSITIVE_KEY_PATTERN,
} from "./secret-redaction.js";

// Chat sidebar scope list (shared between daemon delete helper and
// dashboard useConversations filter — must never drift)
export {
  CHAT_SIDEBAR_SCOPES,
  CHAT_SIDEBAR_SCOPE_PARAM,
  isChatSidebarScope,
} from "./chat-session-scope.js";
export type { ChatSidebarScope } from "./chat-session-scope.js";

// Editable config key definitions (shared between daemon and dashboard)
export {
  EDITABLE_RUNTIME_KEY_TUPLE,
  EDITABLE_BOOTSTRAP_KEY_TUPLE,
  RESTART_REQUIRED_KEY_TUPLE,
} from "./editable-config-keys.js";
export type {
  EditableRuntimeKey,
  EditableBootstrapKey,
  EditableConfigKey,
  RestartRequiredKey,
} from "./editable-config-keys.js";

// Integration delegation framework (shared between daemon registry +
// dashboard cards — single source of truth for mode vocabulary)
export {
  INTEGRATION_KEYS,
  INTEGRATION_MODES,
  INTEGRATION_DESCRIPTORS,
  NATIVE_CONNECTOR_BACKEND_IDS,
  defaultIntegrationsMap,
  getIntegrationDescriptor,
  integrationPatchSchema,
  integrationStateSchema,
  integrationsMapSchema,
  isIntegrationKey,
  isIntegrationMode,
  listIntegrationDescriptors,
  selectSkillVariantFile,
  selectTaskFlowVariantSuffix,
  delegatedIntegrationsForProcessKey,
  nativeIntegrationsForProcessKey,
  getObservationSourcePrefixesForKind,
  buildSourcePrefixFilter,
  supportedNativeBackends,
  backendHasIntegrationConnector,
  validateDeniedTools,
  filterDeniedToolsForBackend,
  matchToolPattern,
  collectSessionDeniedTools,
  recommendedStarterDeniedTools,
  destructiveTaskTools,
  destructiveTaskToolsBare,
  applyIntegrationModeFilter,
  INTEGRATION_MODE_PREDICATES,
  MCP_PATTERN_REGEX,
  matchRunAllowedToolPattern,
  validateRunAllowedTool,
  validateRunAllowedTools,
  HIGH_SENSITIVITY_INTEGRATIONS,
  BROWSER_HISTORY_PROCESS_KEYS,
  getBrowserHistorySafetyFloor,
} from "./integrations.js";
export type { ValidateRunAllowedToolsResult } from "./integrations.js";
export type {
  IntegrationBackendConnector,
  IntegrationDescriptor,
  IntegrationDirectSetup,
  IntegrationKey,
  IntegrationMode,
  IntegrationModePredicate,
  IntegrationPatch,
  IntegrationState,
  IntegrationsMap,
  ObservationKind,
  ValidateDeniedToolsResult,
  BackendSafetyFloor,
  BackendSafetyFloorBackend,
} from "./integrations.js";

// INTEGRATION_NATIVE_MODE_DESIGN.md §8.3 — server-side content hash util
// shared between observations route, delegated-sync-worker, and direct
// pollers so `delegated → native` flips dedup on identical thread state.
export { computeObservationHash } from "./observations-hash.js";

// Integration drift-detection snapshot normalizers
// (INTEGRATION-DRIFT-DETECTION-PLAN.md §5.2)
export {
  INTEGRATION_WRITE_TTL_MS,
  SNAPSHOT_NORMALIZERS,
  getSnapshotNormalizer,
  hasSnapshotNormalizer,
  listSnapshotNormalizers,
  stableStringify,
} from "./integrations-snapshot.js";
export type {
  CalendarSnapshotPayload,
  IntegrationNormalizer,
  SnapshotActorHint,
} from "./integrations-snapshot.js";

// Docs & QA frontmatter schema (shared between daemon indexer + dashboard
// renderer/page-doc-map drift guard — single source of truth)
export {
  DOCS_SCHEMA_VERSION,
  docsFrontmatterSchema,
  slugifyAnchor,
  parseCitationTokens,
} from "./docs-schema.js";
export type {
  DocCategory,
  DocStatus,
  DocsFrontmatter,
  ParsedCitationToken,
} from "./docs-schema.js";
export {
  FrontmatterParseError,
  parseFrontmatter,
} from "./docs-frontmatter.js";
export type { ParsedFrontmatter } from "./docs-frontmatter.js";

// Advisor model allowlist (Claude Agent SDK constraint, shared between
// daemon validators + dashboard dropdown)
export {
  ADVISOR_ALLOWED_MODELS,
  DEFAULT_ADVISOR_MODEL,
  isAdvisorModel,
} from "./advisor-models.js";
export type { AdvisorModel } from "./advisor-models.js";

// Whisper-supported language registry — shared between daemon
// runtime-settings validator, voice routes, and dashboard install dialog.
// See docs/design/appendices/voice-transcription.md.
export {
  VOICE_LANGUAGE_FULL,
  VOICE_LANGUAGE_TOP,
  isSupportedVoiceLanguage,
  localeToVoiceLanguage,
} from "./voice-languages.js";
export type { VoiceLanguage } from "./voice-languages.js";

// Management Registry — domain enum, entity-type map, path validators,
// and Zod schemas. Shared between daemon (api/routes/managed-tasks,
// core/management-registry, core/entity-mirror), dashboard (Settings →
// Management page, entity browser), and skill prompts. See
// `docs/design/21-management-registry-and-entities.md`.
export {
  APP_MAX_LENGTH,
  DOMAINS,
  ENTITY_TYPES,
  INTENT_MAX_LENGTH,
  LAST_RESULT_MAX_LENGTH,
  MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING,
  MANAGEMENT_FAILURE_NOTIFY_THRESHOLD_DEFAULT,
  MANAGEMENT_MAX_ACTIVE_TASKS_DEFAULT,
  MANAGEMENT_MIN_CADENCE_MINUTES_DEFAULT,
  TYPE_PLURALS,
  entitySchema,
  entitySourceEntrySchema,
  formatManagedTaskId,
  isDomain,
  isEntityType,
  isValidManagedTaskId,
  isValidOutputPath,
  isValidSlug,
  managedTaskCreateSchema,
  managedTaskPatchSchema,
  managedTaskRunResultSchema,
  managedTaskSchema,
  normalizeAppLabel,
  parseEntityPath,
  pluralToType,
  sotBindingSchema,
  sotBindingsSchema,
  validateAppLabel,
  validateIntent,
} from "./management-domains.js";
export type {
  Domain,
  Entity,
  EntityPathParts,
  EntitySourceEntry,
  EntityType,
  ManagedTask,
  ManagedTaskCreate,
  ManagedTaskPatch,
  ManagedTaskRunResult,
  SotBinding,
  SotBindings,
} from "./management-domains.js";

// Skill-curation typed payloads (P22 §1.4) — appendix p22-skill-self-optimization.md.
export {
  BYTE_BUDGET as SKILL_CURATION_BYTE_BUDGET,
  ConventionNote,
  ConventionNotesPayload,
  CrossReference,
  CrossReferencesPayload,
  CurationDeclaration,
  CurationDeclarationSection,
  CurationPayload,
  DEFAULT_SKILL_CURATION_CONFIG,
  FrontmatterConventionalField,
  FrontmatterFileType,
  FrontmatterRequiredField,
  FrontmatterSchemaPayload,
  KnowledgeLayoutFile,
  KnowledgeLayoutPayload,
  KnowledgeLayoutSection,
  OverlayEnvelope,
  RoutingTablePayload,
  RoutingTableRule,
  SECTION_KINDS,
  SKILL_CURATION_SCHEMA_VERSION,
  SearchRecipe,
  SearchRecipesPayload,
  SkillCurationConfig,
  SubmitProposalRequest,
  ManualRunRequest,
  DiscardOrphanRequest,
} from "./skill-curation/schemas.js";
export type {
  ConventionNotesValue,
  CrossReferencesValue,
  CurationDeclarationSectionValue,
  CurationDeclarationValue,
  CurationPayloadValue,
  FrontmatterSchemaValue,
  KnowledgeLayoutValue,
  OverlayEnvelopeValue,
  RoutingTableValue,
  SearchRecipesValue,
  SectionKind,
  SkillCurationConfigValue,
  SubmitProposalRequestValue,
  ManualRunRequestValue,
  DiscardOrphanRequestValue,
} from "./skill-curation/schemas.js";
export {
  containsDecisionLanguage,
  noDecisionLanguage,
  noEmbeddedMarkers,
  DECISION_LANGUAGE_MESSAGE,
  EMBEDDED_MARKER_MESSAGE,
} from "./skill-curation/decision-language.js";

// Network ports — single source of truth for default API/dashboard ports.
// Mirror for the launcher (pre-build .mjs) lives in scripts/lib/ports.mjs;
// kept in lockstep by packages/shared/src/ports.test.ts.
export {
  DEFAULT_API_PORT,
  DEFAULT_DASHBOARD_PORT,
  resolveApiPort,
  resolveDashboardPort,
  loopbackOrigins,
} from "./ports.js";
