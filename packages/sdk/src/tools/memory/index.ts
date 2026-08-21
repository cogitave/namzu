import type { MemoryIndex, MemoryStore } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { buildReadMemoryTool } from './read.js'
import { buildSaveMemoryTool } from './save.js'
import { buildSearchMemoryTool, buildStoreSearchMemoryTool } from './search.js'

/**
 * Build memory tools over one authoritative store.
 *
 * This is the safe default for asynchronous or lazy stores: `search_memory`
 * crosses the store's own `list()` boundary, so a fresh disk-backed instance
 * loads its durable index before answering the first search.
 */
export function buildMemoryTools(store: MemoryStore): ToolDefinition[]

/**
 * Build memory tools with a caller-owned search index.
 *
 * The index is deliberately authoritative in this form. It may be remote,
 * pre-populated or otherwise unrelated to the content store, so searching it
 * must not first call `store.list()` and invent a readiness dependency that
 * this contract never promised.
 */
export function buildMemoryTools(store: MemoryStore, index: MemoryIndex): ToolDefinition[]

export function buildMemoryTools(store: MemoryStore, index?: MemoryIndex): ToolDefinition[] {
	return [
		index ? buildSearchMemoryTool(index) : buildStoreSearchMemoryTool(store),
		buildReadMemoryTool(store),
		buildSaveMemoryTool(store),
	]
}

export { buildSearchMemoryTool } from './search.js'
export { buildReadMemoryTool } from './read.js'
export { buildSaveMemoryTool } from './save.js'
