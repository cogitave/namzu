import { z } from 'zod'
import { MemoryRevisionConflictError } from '../../store/memory/revision.js'
import type { MemoryStore } from '../../types/memory/index.js'
import { hasConditionalMemoryWrites } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { asMemoryId } from '../../utils/id.js'
import { defineTool } from '../defineTool.js'

export function buildDeleteMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: 'delete_memory',
		description:
			'Permanently remove a memory by ID, for one that should not be kept at all. Use update_memory with status archived when the record should stay available to inspect. Past conversation transcripts are not changed. Pass the revision from read_memory when available, so a deletion of a memory that changed since you read it is refused. Returns a confirmation.',
		inputSchema: z.object({
			id: z.string().describe('Memory ID to permanently delete'),
			revision: z
				.string()
				.min(1)
				.optional()
				.describe('Opaque revision from read_memory; refuse deletion if the record changed'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: true,
		concurrencySafe: true,
		async execute({ id, revision }) {
			if (revision !== undefined && !hasConditionalMemoryWrites(store)) {
				return {
					success: false,
					output: 'This memory store does not support revision-checked deletion.',
					error: 'Conditional memory deletion unavailable',
				}
			}
			let removed: boolean
			try {
				if (revision === undefined) {
					removed = await store.delete(asMemoryId(id))
				} else if (hasConditionalMemoryWrites(store)) {
					await store.deleteIfRevision(asMemoryId(id), revision)
					removed = true
				} else throw new Error('Conditional memory support changed during the deletion.')
			} catch (error) {
				if (!(error instanceof MemoryRevisionConflictError)) throw error
				return {
					success: false,
					output: error.message,
					error: 'Memory changed since read',
					data: { reason: 'revision_conflict' },
				}
			}
			return {
				success: removed,
				output: removed ? `Memory deleted: ${id}.` : `Memory ${id} not found.`,
				...(removed ? {} : { error: 'Memory not found' }),
			}
		},
	})
}
