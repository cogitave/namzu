import type { MemoryIndex, MemoryStore } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { buildReadMemoryTool } from './read.js'
import { buildSaveMemoryTool } from './save.js'
import { buildSearchMemoryTool } from './search.js'

export function buildMemoryTools(store: MemoryStore, index: MemoryIndex): ToolDefinition[] {
	return [buildSearchMemoryTool(index), buildReadMemoryTool(store), buildSaveMemoryTool(store)]
}

export { buildSearchMemoryTool } from './search.js'
export { buildReadMemoryTool } from './read.js'
export { buildSaveMemoryTool } from './save.js'
