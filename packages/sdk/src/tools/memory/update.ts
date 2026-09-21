import { z } from 'zod'
import { MemoryNameConflictError } from '../../store/memory/naming.js'
import type { MemoryStore } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { asMemoryId } from '../../utils/id.js'
import { defineTool } from '../defineTool.js'
import { memoryFieldsSchema } from './fields.js'

export function buildUpdateMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: 'update_memory',
		description:
			'Correct an existing memory in place, or archive an obsolete claim so it is no longer recalled. Prefer this to saving a second memory about the same thing. Use the ID from search_memory; current evidence should determine corrections.',
		inputSchema: z.object({
			id: z.string().describe('Memory ID to correct or archive'),
			title: z.string().min(1).optional(),
			summary: z.string().min(1).optional(),
			content: z.string().min(1).optional(),
			tags: z.array(z.string()).optional(),
			status: z.enum(['active', 'archived']).optional(),
			...memoryFieldsSchema,
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
			let entry: Awaited<ReturnType<MemoryStore['update']>>
			try {
				entry = await store.update(memoryId, updates)
			} catch (error) {
				if (!(error instanceof MemoryNameConflictError)) throw error
				return {
					success: false,
					output: `Another memory is already named "${error.memoryName}" (${error.existingId}). Choose a different name, or update that memory instead.`,
					error: 'Memory name already exists',
					data: { existingId: error.existingId, name: error.memoryName },
				}
			}
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
