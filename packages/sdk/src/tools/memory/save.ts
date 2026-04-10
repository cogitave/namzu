import { z } from 'zod'
import type { MemoryStore } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

export function buildSaveMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: 'save_memory',
		description: 'Save a new memory with title, summary, and full content for future reference.',
		inputSchema: z.object({
			title: z.string().min(1).describe('Short descriptive title'),
			summary: z.string().min(1).describe('Brief summary (1-2 sentences)'),
			content: z.string().min(1).describe('Full content to store'),
			tags: z.array(z.string()).optional().describe('Tags for categorization'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		async execute({ title, summary, content, tags }) {
			const { entry } = await store.create({
				title,
				summary,
				content,
				tags,
			})

			return {
				success: true,
				output: `Memory saved: ${entry.id} — "${title}"`,
				data: {
					id: entry.id,
					title: entry.title,
					tags: entry.tags,
				},
			}
		},
	})
}
