import { z } from 'zod'
import type { MemoryStore } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { asMemoryId } from '../../utils/id.js'
import { defineTool } from '../defineTool.js'

export function buildUpdateMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: 'update_memory',
		description:
			'Correct an existing memory in place, or archive an obsolete claim so it is no longer recalled. Use the ID from search_memory; current evidence should determine corrections.',
		inputSchema: z.object({
			id: z.string().describe('Memory ID to correct or archive'),
			title: z.string().min(1).optional(),
			summary: z.string().min(1).optional(),
			content: z.string().min(1).optional(),
			tags: z.array(z.string()).optional(),
			status: z.enum(['active', 'archived']).optional(),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		async execute({ id, ...updates }) {
			if (Object.values(updates).every((value) => value === undefined)) {
				return {
					success: false,
					output: 'Provide a correction or status to update.',
					error: 'No memory update supplied',
				}
			}
			const memoryId = asMemoryId(id)
			// Patch only requested fields in one store operation. A read/merge of
			// provenance here would overwrite metadata from a concurrent writer.
			const entry = await store.update(memoryId, updates)
			if (!entry)
				return {
					success: false,
					output: `Memory ${id} no longer exists.`,
					error: 'Memory not found',
				}
			return {
				success: true,
				output: `Memory updated: ${id} — ${entry.title} (${entry.status}).`,
				data: { id, status: entry.status },
			}
		},
	})
}
