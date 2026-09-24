// Public tools surface of `@namzu/sdk`.
//
// Consumer scenario: "I want to define a tool for my agent, use a built-in
// tool, or produce Tool objects from a connector / RAG store / task system."
//
// Every symbol here produces or defines a Tool in the agent-tool sense.
// Generic RAG runtime (vector stores, retrievers, embeddings, knowledge
// base) lives in `public-runtime.ts`; only `createRAGTool` belongs here.
//
// Ratified in ses_011-sdk-public-surface §4.3.

// ─── Tool definition primitive ───────────────────────────────────────────

export { defineTool } from './tools/defineTool.js'
// Containment, for a host or sibling package that resolves caller-supplied
// paths against a root. Both were internal while three call sites outside
// this file needed them.
export {
	OUTSIDE_ROOTS_GUIDANCE,
	isWithin,
	pathOutsideRoots,
	resolveWithin,
	resolveWithinReal,
	toolRoots,
} from './tools/paths.js'
// A host that surfaces its own untrusted content to a model needs the same
// framing the kernel applies to connector prompts and delegated results — and
// the reader for it, because a screen that judges a result has to reach past
// the frame without re-spelling the tag.
export {
	neutralizeEnvelopeDelimiter,
	untrustedEnvelopeBody,
	wrapUntrusted,
} from './tools/untrusted-envelope.js'
export { filterReadOnlyTools, filterToolsNamed } from './tools/roster.js'
export type { UntrustedEnvelope } from './tools/untrusted-envelope.js'

// ─── Built-in tools ──────────────────────────────────────────────────────

export { getBuiltinTools } from './tools/builtins/index.js'
export { buildResidentHistoryTools } from './tools/resident-history.js'
// A host compiling operator permissions has a tool name and needs an argument
// to attach a pattern to. Without one it can only match against the serialised
// input, which is how an `allow` for `git status*` came to approve
// `git status && rm -rf ~`.
export { builtinCommandArguments, commandArgumentOf } from './tools/command-arguments.js'
export { ReadFileTool } from './tools/builtins/read-file.js'
export { WriteFileTool } from './tools/builtins/write-file.js'
export { EditTool } from './tools/builtins/edit.js'
export { BashTool, SANDBOX_ESCAPE_NOT_APPROVED } from './tools/builtins/bash.js'
export { LSP_TOOL_NAME, LspTool, getCodeNavigationTools } from './tools/builtins/lsp.js'
export { GlobTool } from './tools/builtins/glob.js'
export { GrepTool } from './tools/builtins/grep.js'
// Reads, lists and stops what `bash run_in_background` starts. Ships in
// the default builtin set alongside bash, because the two are one
// capability: an id with nothing that reads it is the unbacked suggestion
// that was removed from bash's schema.
export { JobTool } from './tools/builtins/job.js'
// Blocks until a job `JobTool` started ends, instead of reading it in a
// loop. Ships in the default builtin set alongside `job` and `bash`, for
// the same reason `job` does: a job with nothing that can block on it is
// the same unbacked suggestion `job` itself exists to fix.
export { WaitForJobTool } from './tools/builtins/wait-for-job.js'
// Loads a skill's instructions, and pre-approves what its `allowed-tools`
// names for the rest of the turn (never narrowing the tool set).
// NOT in the default builtin set: a turn with no skills has nothing for it
// to do, and offering a tool that can only refuse is worse than not
// offering it. Hosts register it alongside a skills registry.
// `createSkillTool` takes what the host knows about where its model's tools
// run: `resolveModelDirectory` names the directory the model can open for
// each skill, which a sandboxed host's own path is not.
export {
	SKILL_TOOL_NAME,
	SkillTool,
	createSkillTool,
	parseAllowedTools,
} from './tools/builtins/skill.js'
export type {
	SkillDirectoryContext,
	SkillDirectoryRequest,
	SkillDirectoryResolver,
	SkillToolOptions,
} from './tools/builtins/skill.js'
// Both declare `category: 'network'`, which is what the authorization
// presets branch on. NOT in the default builtin set: a turn with no web
// provider has nothing for them to do, and only the `unattended` preset --
// the one requiring the sandbox to confine the network -- auto-approves
// them.
export {
	WEB_FETCH_TOOL_NAME,
	WEB_SEARCH_TOOL_NAME,
	WebFetchTool,
	WebSearchTool,
} from './tools/builtins/web.js'
// The paragraph neither tool owns: how to use the two together, and what a
// fetched page is. Registered with the prompt contribution registry only
// when the tools are — guidance about tools a turn does not have spends the
// cached prefix telling the model to cite a search it cannot run.
export {
	WEB_GUIDANCE_CONTRIBUTION_ID,
	webGuidanceContribution,
} from './tools/builtins/web-guidance.js'
// A program the model wrote, calling this turn's own tools in a loop. Opt-in
// and NOT in the default builtin set: a turn that does not need
// model-authored control flow should not have a way to execute
// model-authored text, and "the tool was there so it got used" is not a
// threat model.
export {
	RUN_CODE_TOOL_NAME,
	buildRunCodeTool,
} from './tools/builtins/run-code.js'
export type { RunCodeToolOptions } from './tools/builtins/run-code.js'
export { LsTool } from './tools/builtins/ls.js'
export { SearchToolsTool } from './tools/builtins/search-tools.js'
export { VerifyOutputsTool } from './tools/builtins/verify-outputs.js'
export {
	createStructuredOutputTool,
	STRUCTURED_OUTPUT_TOOL_NAME,
} from './tools/builtins/structuredOutput.js'
export {
	COMPUTER_USE_TOOL_NAME,
	createComputerUseTool,
} from './tools/builtins/computer-use.js'
// The browser contract: the two tools over a host a separate package
// provides, and the canonicalisers a host and a site-rule compiler must share
// with the tools so every party reads one spelling of an address.
export {
	BROWSER_ACT_TOOL_NAME,
	BROWSER_TOOL_NAME,
	browserHostErrorOf,
	createBrowserTools,
	formatBrowserPageHeader,
	isBrowserCallReadOnly,
} from './tools/builtins/browser.js'
export {
	BROWSER_URL_MAX_LENGTH,
	canonicalizeBrowserOrigin,
	canonicalizeBrowserSitePattern,
	canonicalizeBrowserUrl,
	isCloudMetadataHost,
} from './tools/builtins/browser-url.js'
export {
	BROWSER_FILL_FORM_MAX_FIELDS,
	BROWSER_SNAPSHOT_MAX_CHARS,
	BROWSER_WAIT_MAX_MS,
} from './types/browser/index.js'

// ─── Domain tool builders ────────────────────────────────────────────────

export {
	buildTaskCreateTool,
	buildTaskListTool,
	buildTaskTools,
	buildTaskUpdateTool,
} from './tools/task/index.js'
export { buildAdvisoryTools } from './tools/advisory/index.js'
export {
	buildMemoryTools,
	buildUpdateMemoryTool,
	buildDeleteMemoryTool,
} from './tools/memory/index.js'
export { buildCoordinatorTools } from './tools/coordinator/index.js'
export {
	buildAskUserQuestionTool,
	type AskUserQuestionToolOptions,
} from './tools/coordinator/ask-user-question.js'
export { buildAgentTool, type AgentToolOptions } from './tools/coordinator/agent.js'

// Scheduled jobs and in-session loops, over host callbacks: the host stores
// jobs, draws the confirmation and computes every field it shows. Register
// only where a person can confirm (never headless, scheduled or delegated).
export {
	buildScheduleTools,
	buildSessionLoopTools,
	revealHiddenCharacters,
	scanSchedulePrompt,
	SCHEDULE_TOOL_NAME,
	SESSION_LOOP_TOOL_NAME,
} from './tools/schedules/index.js'

// ─── RAG tool builder ────────────────────────────────────────────────────

export { createRAGTool } from './rag/index.js'

// ─── Connector tool bridge ───────────────────────────────────────────────

export {
	allConnectorTools,
	connectorInstanceToTools,
	connectorMethodToTool,
	ConnectorToolRouter,
	createConnectorExecuteTool,
	createConnectorListTool,
	createConnectorRouterTool,
	createConnectorTools,
} from './connector/tools/index.js'

export { createFileReadTracker } from './tools/file-read-tracker.js'
export type { LedgerReplayReport } from './runtime/query/file-evidence-replay.js'
/**
 * Rebuild a tracker from a conversation's own history, for a host that keeps
 * one per conversation across turns and has just restored one from a store.
 * Reads no file's content — only the paths the history names, canonicalized
 * the way the built-in tools canonicalize them so that the entries land where
 * those tools will look for them. See the SDK's tool-execution documentation
 * for what a replayed observation does and does not establish.
 */
export {
	type ObservationSeedContext,
	seedObservationLedger,
} from './runtime/query/file-evidence-seed.js'

export { buildResidentToolEvidenceTools } from './tools/resident-tool-evidence.js'
