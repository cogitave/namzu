export { ReadFileTool } from './read-file.js'
export { WriteFileTool } from './write-file.js'
export { BashTool } from './bash.js'
export { GlobTool } from './glob.js'
export { SearchToolsTool } from './search-tools.js'

import type { ToolDefinition } from '../../types/tool/index.js'
import { BashTool } from './bash.js'
import { GlobTool } from './glob.js'
import { ReadFileTool } from './read-file.js'
import { SearchToolsTool } from './search-tools.js'
import { WriteFileTool } from './write-file.js'

export function getBuiltinTools(): ToolDefinition[] {
	return [ReadFileTool, WriteFileTool, BashTool, GlobTool, SearchToolsTool]
}
