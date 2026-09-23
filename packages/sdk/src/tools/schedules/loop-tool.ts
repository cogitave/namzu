import { z } from 'zod'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { presentLoopCall, presentLoopResult } from './present.js'
import type { SessionLoopHost } from './types.js'

export const SESSION_LOOP_TOOL_NAME = 'session_loop'

const inputSchema = z.object({
	action: z.enum(['create', 'list', 'delete']),
	interval: z
		.string()
		.optional()
		.describe('create: how often, e.g. "5m", "1h", or a five-field cron expression'),
	prompt: z.string().min(1).max(4_000).optional().describe('create: the message to send each time'),
	id: z.string().optional().describe('delete: the loop id, or "all"'),
})

/**
 * The `session_loop` tool: re-send a prompt to THIS conversation on an
 * interval, between turns, while the session is open.
 *
 * `create` is an ordinary reviewed call — not exempt from review — so in
 * `prompt` mode the operator sees it before a loop exists; a loop a model
 * created is labelled as such wherever it is shown. `list` and `delete` only
 * read or remove loops.
 */
export function buildSessionLoopTools(host: SessionLoopHost): ToolDefinition[] {
	return [
		defineTool({
			name: SESSION_LOOP_TOOL_NAME,
			description:
				'Re-send a prompt to this conversation on an interval while the session stays open (between turns only; stops when the session closes; expires after 7 days). Use only when the user asks for something to repeat. Minimum interval one minute.',
			inputSchema,
			category: 'custom',
			permissions: [],
			readOnly: (input) => input.action !== 'create',
			destructive: false,
			concurrencySafe: false,
			presentCall: presentLoopCall,
			presentResult: presentLoopResult,
			async execute(input) {
				if (input.action === 'list') {
					const loops = host.list()
					return {
						success: true,
						output:
							loops.length === 0
								? 'No loops in this session.'
								: loops.map((l) => `${l.id} · ${l.schedule} · ${l.prompt.slice(0, 80)}`).join('\n'),
						data: { loops },
					}
				}
				if (input.action === 'delete') {
					if (!input.id) return { success: false, output: '', error: 'delete needs id (or "all").' }
					const stopped = await host.delete(input.id)
					return stopped === 0
						? { success: false, output: '', error: `No loop has id "${input.id}".` }
						: { success: true, output: `Stopped ${stopped} loop${stopped === 1 ? '' : 's'}.` }
				}
				if (!input.interval || !input.prompt) {
					return { success: false, output: '', error: 'create needs interval and prompt.' }
				}
				try {
					const loop = await host.create({
						interval: input.interval,
						prompt: input.prompt,
						createdBy: 'model',
					})
					return {
						success: true,
						output: `Loop ${loop.id} created: ${loop.schedule}. The operator can stop it with /loop stop ${loop.id}.`,
						data: { id: loop.id },
					}
				} catch (error) {
					return {
						success: false,
						output: '',
						error: error instanceof Error ? error.message : String(error),
					}
				}
			},
		}),
	]
}
