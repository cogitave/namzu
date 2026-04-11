export { ReadFileTool } from './read-file.js'
export { WriteFileTool } from './write-file.js'
export { EditTool } from './edit.js'
export { BashTool } from './bash.js'
export { GlobTool } from './glob.js'
export { GrepTool } from './grep.js'
export { LsTool } from './ls.js'
export { SearchToolsTool } from './search-tools.js'

import type { ToolDefinition } from '../../types/tool/index.js'
import { BashTool } from './bash.js'
import { EditTool } from './edit.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { LsTool } from './ls.js'
import { ReadFileTool } from './read-file.js'
import { SearchToolsTool } from './search-tools.js'
import { WriteFileTool } from './write-file.js'

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
