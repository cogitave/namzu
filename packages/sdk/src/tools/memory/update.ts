import { z } from 'zod'
import { MemoryContentRejectedError, MemoryNameConflictError } from '../../store/memory/naming.js'
import type { MemoryStore } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { memoryFieldsSchema } from './fields.js'
import { resolveMemoryReference } from './resolve.js'

export function buildUpdateMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: 'update_memory',
		description:
			'Correct an existing memory in place, or archive an obsolete claim so it is no longer recalled. Prefer this to saving a second memory about the same thing. Identify it by the ID from search_memory or by its name from the memory index; current evidence should determine corrections.',
		inputSchema: z.object({
			id: z
				.string()
				.describe('Memory ID, or the memory name from the index, to correct or archive'),
			title: z.string().min(1).optional().describe('Corrected short descriptive title'),
			summary: z.string().min(1).optional().describe('Corrected brief summary (1-2 sentences)'),
			content: z.string().min(1).optional().describe('Corrected full content'),
			tags: z.array(z.string()).optional().describe('Replacement tags for categorization'),
			status: z
				.enum(['active', 'archived'])
				.optional()
				.describe('Set to archived to retire this memory without deleting it'),
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
			const reference = await resolveMemoryReference(store, id)
			if (!reference.found) {
				return {
					success: false,
					output: `No memory is named ${id}. Find it with search_memory, or save it with save_memory if it does not exist.`,
					error: 'Memory not found',
				}
			}
			const memoryId = reference.id
			// Patch only requested fields in one store operation. A read/merge of
			// provenance here would overwrite metadata from a concurrent writer.
			let entry: Awaited<ReturnType<MemoryStore['update']>>
			try {
				entry = await store.update(memoryId, updates)
			} catch (error) {
				if (error instanceof MemoryContentRejectedError) {
					return {
						success: false,
						output: error.message,
						error: 'Memory content rejected',
						data: { reason: error.reason },
					}
				}
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
				output: `Memory updated: ${memoryId}${entry.name ? ` (${entry.name})` : ''} — ${entry.title} (${entry.status}).`,
				data: {
					id: memoryId,
					status: entry.status,
					...(entry.name ? { name: entry.name } : {}),
				},
			}
		},
	})
}
