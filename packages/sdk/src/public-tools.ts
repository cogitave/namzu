// Public tools surface of `@namzu/sdk`.
//
// Consumer scenario: "I want to define a tool for my agent, use a built-in
// tool, or produce Tool objects from a connector / RAG store / task system."
//
// Every symbol here produces or defines a Tool in the agent-tool sense.
// Generic RAG runtime (vector stores, retrievers, embeddings, knowledge
// base) lives in `public-runtime.ts`; only `createRAGTool` belongs here.
//
// See §4.3 of `docs.local/sessions/ses_011-sdk-public-surface/design.md`.

// ─── Tool definition primitive ───────────────────────────────────────────

export { defineTool } from './tools/defineTool.js'

// ─── Built-in tools ──────────────────────────────────────────────────────

export { getBuiltinTools } from './tools/builtins/index.js'
export { ReadFileTool } from './tools/builtins/read-file.js'
export { WriteFileTool } from './tools/builtins/write-file.js'
export { EditTool } from './tools/builtins/edit.js'
export { BashTool } from './tools/builtins/bash.js'
export { GlobTool } from './tools/builtins/glob.js'
export { GrepTool } from './tools/builtins/grep.js'
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
} from './bridge/tools/connector/index.js'
