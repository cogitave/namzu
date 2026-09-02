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
export { isWithin, resolveWithin, resolveWithinReal } from './tools/paths.js'
// A host that surfaces its own untrusted content to a model needs the same
// framing the kernel applies to connector prompts and delegated results.
export { neutralizeEnvelopeDelimiter, wrapUntrusted } from './tools/untrusted-envelope.js'
export { filterReadOnlyTools, filterToolsNamed } from './tools/roster.js'
export type { UntrustedEnvelope } from './tools/untrusted-envelope.js'

// ─── Built-in tools ──────────────────────────────────────────────────────

export { getBuiltinTools } from './tools/builtins/index.js'
// A host compiling operator permissions has a tool name and needs an argument
// to attach a pattern to. Without one it can only match against the serialised
// input, which is how an `allow` for `git status*` came to approve
// `git status && rm -rf ~`.
export { builtinCommandArguments, commandArgumentOf } from './tools/command-arguments.js'
export { ReadFileTool } from './tools/builtins/read-file.js'
export { WriteFileTool } from './tools/builtins/write-file.js'
export { EditTool } from './tools/builtins/edit.js'
export { BashTool } from './tools/builtins/bash.js'
export { LSP_TOOL_NAME, LspTool, getCodeNavigationTools } from './tools/builtins/lsp.js'
export { GlobTool } from './tools/builtins/glob.js'
export { GrepTool } from './tools/builtins/grep.js'
// Reads, lists and stops what `bash run_in_background` starts. Ships in
// the default builtin set alongside bash, because the two are one
// capability: an id with nothing that reads it is the unbacked suggestion
// that was removed from bash's schema.
export { JobTool } from './tools/builtins/job.js'
// Loads a skill's instructions, and adopts the tool scope it declares.
// NOT in the default builtin set: a run with no skills has nothing for it
// to do, and offering a tool that can only refuse is worse than not
// offering it. Hosts register it alongside a skills registry.
export { SKILL_TOOL_NAME, SkillTool, parseAllowedTools } from './tools/builtins/skill.js'
// Both declare `category: 'network'`, which is what the authorization
// presets branch on. NOT in the default builtin set: a run with no web
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
// when the tools are — guidance about tools a run does not have spends the
// cached prefix telling the model to cite a search it cannot run.
export {
	WEB_GUIDANCE_CONTRIBUTION_ID,
	webGuidanceContribution,
} from './tools/builtins/web-guidance.js'
// A program the model wrote, calling this run's own tools in a loop. Opt-in
// and NOT in the default builtin set: a run that does not need
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

// ─── Domain tool builders ────────────────────────────────────────────────

export {
	buildTaskCreateTool,
	buildTaskListTool,
	buildTaskTools,
	buildTaskUpdateTool,
} from './tools/task/index.js'
export { buildAdvisoryTools } from './tools/advisory/index.js'
export { buildMemoryTools } from './tools/memory/index.js'
export { buildCoordinatorTools } from './tools/coordinator/index.js'
export {
	buildAskUserQuestionTool,
	type AskUserQuestionToolOptions,
} from './tools/coordinator/ask-user-question.js'
export { buildAgentTool, type AgentToolOptions } from './tools/coordinator/agent.js'

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
