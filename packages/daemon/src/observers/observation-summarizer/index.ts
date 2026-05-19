/**
 * Public surface for the observation summarizer subsystem.
 *
 * Wired from `index.ts` startup: build the LLM client matching the
 * configured `observation.summarize` ProcessKey row, register the
 * worker on the ObserverManager.
 */

export {
  ObservationSummarizerWorker,
  OBSERVATION_SUMMARIZER_OBSERVER_NAME,
  type ObservationSummarizerWorkerOptions,
} from "./worker.js";
export {
  preFilterObservation,
  DEFAULT_LARGE_FILE_BYTES,
  type PreFilterConfig,
  type PreFilterDecision,
  type PreFilterObservationInput,
  type SkipReason,
} from "./pre-filter.js";
export {
  buildSummarizerPrompt,
  type SummarizerPrompt,
  type SummarizerPromptInput,
  type SummarizerSource,
} from "./summarizer-prompts.js";
export {
  parseSummarizerResponse,
  applyNoveltyFloor,
  SUMMARY_MAX_CHARS,
  type ParsedSummary,
  type ParseSummaryResult,
  type ParseFailureReason,
} from "./response-parser.js";
export {
  AnthropicSummarizerClient,
  UnsupportedSummarizerClient,
  type SummarizerLlmClient,
  type SummarizerLlmRequest,
  type SummarizerLlmResult,
  type SummarizerLlmErrorClass,
  type AnthropicSummarizerClientOptions,
} from "./summarizer-client.js";
