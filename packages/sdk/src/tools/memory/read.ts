import { z } from 'zod'
import type { MemoryStore } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { asMemoryId } from '../../utils/id.js'
import { defineTool } from '../defineTool.js'

export function buildReadMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: 'read_memory',
		description: 'Read the full content of a specific memory by its ID.',
		inputSchema: z.object({
			id: z.string().describe('Opaque memory ID returned by a memory search or save'),
		}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute({ id }) {
			// Validate model-authored input before using it as a store key.
			const memoryId = asMemoryId(id)
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
