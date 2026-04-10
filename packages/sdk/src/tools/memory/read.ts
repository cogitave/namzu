import { z } from 'zod'
import type { MemoryId } from '../../types/ids/index.js'
import type { MemoryStore } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

export function buildReadMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: 'read_memory',
		description: 'Read the full content of a specific memory by its ID.',
		inputSchema: z.object({
			id: z.string().describe('Memory ID (mem_xxx format)'),
		}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute({ id }) {
			const memoryId = id as MemoryId
			const content = await store.get(memoryId)

			if (!content) {
				return {
					success: false,
					output: `Memory ${id} not found.`,
					error: `Memory ${id} not found`,
				}
			}

			return {
				success: true,
				output: content.content,
				data: {
					id: content.id,
					format: content.format,
					metadata: content.metadata,
				},
			}
		},
	})
}
