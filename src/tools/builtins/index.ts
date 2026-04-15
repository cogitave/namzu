export { ReadFileTool } from './read-file.js'
export { WriteFileTool } from './write-file.js'
export { EditTool } from './edit.js'
export { BashTool } from './bash.js'
export { GlobTool } from './glob.js'
export { GrepTool } from './grep.js'
export { LsTool } from './ls.js'
export { SearchToolsTool } from './search-tools.js'
export { createStructuredOutputTool, STRUCTURED_OUTPUT_TOOL_NAME } from './structuredOutput.js'
export { createComputerUseTool, COMPUTER_USE_TOOL_NAME } from './computer-use.js'

import type { ToolDefinition } from '../../types/tool/index.js'
import { BashTool } from './bash.js'
import { EditTool } from './edit.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { LsTool } from './ls.js'
import { ReadFileTool } from './read-file.js'
import { SearchToolsTool } from './search-tools.js'
import { WriteFileTool } from './write-file.js'
// Note: createStructuredOutputTool is not included in getBuiltinTools()
// because it requires a schema parameter and is created per-use case

export function getBuiltinTools(): ToolDefinition[] {
	return [
		ReadFileTool,
		WriteFileTool,
		EditTool,
		BashTool,
		GlobTool,
		GrepTool,
		LsTool,
		SearchToolsTool,
	]
}
