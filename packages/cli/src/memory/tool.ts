/**
 * The `remember` tool — lets the agent curate its own long-term memory.
 *
 * When the model learns a durable fact worth carrying into future sessions
 * (a stable user preference, a project fact, a decision) it can call this
 * to append the fact to `~/.namzu/MEMORY.md`, which is injected into every
 * later turn (see ./store.ts). Built from the SDK's public `defineTool` +
 * `mcpJsonSchemaToZod`, so the cli needs no direct zod dependency.
 */

import { type ToolDefinition, defineTool, mcpJsonSchemaToZod } from '@namzu/sdk'

import { appendMemory } from './store.js'

export const REMEMBER_TOOL_NAME = 'remember'

export function buildRememberTool(home?: string): ToolDefinition {
	const inputSchema = mcpJsonSchemaToZod({
		type: 'object',
		properties: {
			fact: {
				type: 'string',
				description: 'A single concise, durable fact to remember.',
			},
		},
		required: ['fact'],
	} as Parameters<typeof mcpJsonSchemaToZod>[0])

	return defineTool({
		name: REMEMBER_TOOL_NAME,
		description:
			'Save a durable fact to long-term memory so it is recalled in future sessions. Use for stable user preferences, project facts, and decisions — not transient task details. The fact is appended to ~/.namzu/MEMORY.md.',
		inputSchema,
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		execute: async (input) => {
			const fact =
				input && typeof (input as { fact?: unknown }).fact === 'string'
					? (input as { fact: string }).fact.trim()
					: ''
			if (fact.length === 0) {
				return { success: false, output: '', error: 'remember: a non-empty `fact` is required' }
			}
			appendMemory(fact, home)
			return { success: true, output: `Remembered: ${fact}` }
		},
	})
}
