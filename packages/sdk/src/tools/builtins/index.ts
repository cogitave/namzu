export { ReadFileTool } from './read-file.js'
export { WriteFileTool } from './write-file.js'
export { EditTool } from './edit.js'
export { BashTool } from './bash.js'
export { GlobTool } from './glob.js'
export { GrepTool } from './grep.js'
export { LsTool } from './ls.js'
export { SearchToolsTool } from './search-tools.js'
export { VerifyOutputsTool } from './verify-outputs.js'
export { createStructuredOutputTool, STRUCTURED_OUTPUT_TOOL_NAME } from './structuredOutput.js'
export { createComputerUseTool, COMPUTER_USE_TOOL_NAME } from './computer-use.js'

import type { ToolDefinition } from '../../types/tool/index.js'
import { BashTool } from './bash.js'
import { EditTool } from './edit.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { ReadFileTool } from './read-file.js'
import { VerifyOutputsTool } from './verify-outputs.js'
import { WriteFileTool } from './write-file.js'
// Note: createStructuredOutputTool is not included in getBuiltinTools()
// because it requires a schema parameter and is created per-use case.
//
// `LsTool` and `SearchToolsTool` are still exported for direct use but
// are NOT in the default builtin set. Claude Code's training distribution
// (per `code.claude.com/docs/en/tools-reference`) does NOT include `LS`
// — directory listing is canonical `Bash` + `Glob`. `search_tools`
// has no Claude analogue at all. Including either in the defaults gives
// the model two tools that look right but degrade alignment. Hosts that
// genuinely want them can still register them explicitly.

export function getBuiltinTools(): ToolDefinition[] {
	return [
		BashTool,
		EditTool,
		GlobTool,
		GrepTool,
		ReadFileTool,
		VerifyOutputsTool,
		WriteFileTool,
	]
}
