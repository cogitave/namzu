export { ReadFileTool } from './read-file.js'
export { WriteFileTool } from './write-file.js'
export { EditTool } from './edit.js'
export { BashTool } from './bash.js'
export { GlobTool } from './glob.js'
export { GrepTool } from './grep.js'
export { JobTool } from './job.js'
export { SKILL_TOOL_NAME, SkillTool, parseAllowedTools } from './skill.js'
export {
	WEB_FETCH_TOOL_NAME,
	WEB_SEARCH_TOOL_NAME,
	WebFetchTool,
	WebSearchTool,
} from './web.js'
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
import { JobTool } from './job.js'
import { ReadFileTool } from './read-file.js'
import { VerifyOutputsTool } from './verify-outputs.js'
import { WriteFileTool } from './write-file.js'
// Note: createStructuredOutputTool is not included in getBuiltinTools()
// because it requires a schema parameter and is created per-use case.
//
// `LsTool` and `SearchToolsTool` are still exported for direct use but are
// NOT in the default builtin set. A directory listing is already reachable
// through `bash` + `glob`, and `search_tools` answers a question the tool
// catalog in the prompt has already answered. Offering a model two ways to
// do one thing costs a decision on every turn and buys nothing. File
// extension is canonical `edit` with `insertLine: "end"` — the legacy
// `Append` tool is gone.
// Hosts that genuinely want LS/search can still register them explicitly.

export function getBuiltinTools(): ToolDefinition[] {
	// `job` ships alongside `bash` rather than being opt-in, because the two
	// are one capability. `bash run_in_background` returns an id, and an id
	// with no tool that reads it is the exact shape of the suggestion that
	// was removed from bash's schema for being unbacked.
	//
	// It costs nothing where the host provides no registry: the tool refuses
	// and says so, which is a truthful answer rather than a missing one.
	return [
		BashTool,
		EditTool,
		GlobTool,
		GrepTool,
		JobTool,
		ReadFileTool,
		VerifyOutputsTool,
		WriteFileTool,
	]
}
