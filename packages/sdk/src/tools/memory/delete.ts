import { z } from 'zod'
import type { MemoryStore } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { asMemoryId } from '../../utils/id.js'
import { defineTool } from '../defineTool.js'

export function buildDeleteMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: 'delete_memory',
		description:
			'Permanently delete a stored memory by ID. Use update_memory with status archived when the record should remain available for inspection. Deletion does not erase past conversation transcripts.',
		inputSchema: z.object({
			id: z.string().describe('Memory ID to permanently delete'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: true,
		concurrencySafe: true,
		async execute({ id }) {
			const removed = await store.delete(asMemoryId(id))
			return {
				success: removed,
				output: removed ? `Memory deleted: ${id}.` : `Memory ${id} not found.`,
				...(removed ? {} : { error: 'Memory not found' }),
			}
		},
	})
}
