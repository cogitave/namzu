import { z } from 'zod'
import { MemoryContentRejectedError, MemoryNameConflictError } from '../../store/memory/naming.js'
import { AGENT_MEMORY_SOURCE } from '../../store/memory/origin.js'
import type { MemoryStore } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { memoryFieldsSchema } from './fields.js'

export function buildSaveMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: 'save_memory',
		description: [
			'Save one memory for later sessions in this project: a single fact that the code, the history and the docs do not already hold.',
			'Choose a type: user (who the person is and how they like to work), feedback (a rule they gave about how to work), project (a fact or decision about the work), reference (where to look for something).',
			'For feedback and project memories, write the rule or fact first, then a line starting "Why:" and a line starting "How to apply:".',
			'Link a related memory by writing [[its-name]] in the content.',
			'The name must be new: a name another memory holds is refused, and the reply points to update_memory.',
			"Returns the saved memory's id and name.",
		].join(' '),
		inputSchema: z.object({
			title: z.string().min(1).describe('Short descriptive title'),
			summary: z.string().min(1).describe('Brief summary (1-2 sentences)'),
			content: z.string().min(1).describe('Full content to store'),
			tags: z.array(z.string()).optional().describe('Tags for categorization'),
			...memoryFieldsSchema,
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		async execute({ title, summary, content, tags, name, description, type }, context) {
			try {
				const { entry } = await store.create({
					title,
					summary,
					content,
					tags,
					...(name !== undefined ? { name } : {}),
					...(description !== undefined ? { description } : {}),
					...(type !== undefined ? { type } : {}),
					metadata: {
						source: AGENT_MEMORY_SOURCE,
						sessionId: context.sessionId,
						turnId: context.turnId,
					},
				})

				return {
					success: true,
					output: `Memory saved: ${entry.id} — "${title}"${entry.name ? ` as ${entry.name}` : ''}`,
					data: {
						id: entry.id,
						title: entry.title,
						tags: entry.tags,
						...(entry.name !== undefined ? { name: entry.name } : {}),
						...(entry.type !== undefined ? { type: entry.type } : {}),
					},
				}
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
					output: `A memory named "${error.memoryName}" already exists (${error.existingId}). Read it with read_memory and correct it with update_memory instead of saving a duplicate.`,
					error: 'Memory name already exists',
					data: { existingId: error.existingId, name: error.memoryName },
				}
			}
		},
	})
}
