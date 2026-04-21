// Public SDK surface — split into three focused files by scenario:
//   - public-types.ts    : every type a consumer type-checks against
//   - public-runtime.ts  : every runtime value (classes, functions, consts, schemas)
//   - public-tools.ts    : tool-definition primitive + builtins + builders
//
// ses_011 (2026-04-21): this file is now a thin bootstrap. Do not add symbols
// here directly — extend the appropriate bucket file.

export type * from './public-types.js'
export * from './public-runtime.js'

// Tools bucket lands in ses_011 commit 4. Until then, the tool-related
// exports stay inline below so the public surface remains intact.

export { defineTool } from './tools/defineTool.js'
export { getBuiltinTools } from './tools/builtins/index.js'
export { ReadFileTool } from './tools/builtins/read-file.js'
export { WriteFileTool } from './tools/builtins/write-file.js'
export { EditTool } from './tools/builtins/edit.js'
export { BashTool } from './tools/builtins/bash.js'
export { GlobTool } from './tools/builtins/glob.js'
export { GrepTool } from './tools/builtins/grep.js'
export { LsTool } from './tools/builtins/ls.js'
export { SearchToolsTool } from './tools/builtins/search-tools.js'
export {
	createStructuredOutputTool,
	STRUCTURED_OUTPUT_TOOL_NAME,
} from './tools/builtins/structuredOutput.js'
export {
	COMPUTER_USE_TOOL_NAME,
	createComputerUseTool,
} from './tools/builtins/computer-use.js'

export {
	buildTaskCreateTool,
	buildTaskListTool,
	buildTaskTools,
	buildTaskUpdateTool,
} from './tools/task/index.js'
export { buildAdvisoryTools } from './tools/advisory/index.js'
export { buildMemoryTools } from './tools/memory/index.js'
export { buildCoordinatorTools } from './tools/coordinator/index.js'

export { createRAGTool } from './rag/index.js'

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
