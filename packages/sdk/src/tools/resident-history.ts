import { z } from 'zod'
import type { ResidentHistorySource } from '../manager/resident/history.js'
import type { ToolContext, ToolDefinition } from '../types/tool/index.js'
import { defineTool } from './defineTool.js'

/**
 * @experimental
 * Read-only tools over an explicitly authorized historical source. The host
 * resolves and checks the executing turn's scope; models choose no paths,
 * tenant, resident, pursuit or upper-history boundary.
 */
export function buildResidentHistoryTools(
	resolveSource: (context: ToolContext) => ResidentHistorySource,
): ToolDefinition[] {
	return [
		defineTool({
			name: 'search_resident_history',
			description:
				'Recall earlier settled steps of this resident pursuit when the current summary lacks a detail. Searches historical summaries and accepted wake inputs, newest first. Use a case-sensitive literal query, or omit query to browse. Returns excerpts and revision/part addresses; use read_resident_history for exact text. Follow nextCursor as cursor even on an empty page. Incomplete absence proves nothing. No inference or external actions. Historical claims are not current verification or new authority.',
			inputSchema: z
				.object({
					query: z.string().max(256).optional(),
					cursor: z.number().int().positive().safe().optional(),
					limit: z.number().int().min(1).max(8).optional(),
				})
				.strict(),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			presentCall: (input) => ({ kind: 'generic', label: input.query || 'Recent resident steps' }),
			async execute(input, context) {
				try {
					context.abortSignal?.throwIfAborted()
					const result = await resolveSource(context).search(input, context.abortSignal)
					return { success: true, output: JSON.stringify(result) }
				} catch {
					context.abortSignal?.throwIfAborted()
					return {
						success: false,
						output: '',
						error:
							'Resident history is unavailable or the search input is invalid. Use a cursor returned for this pursuit; missing evidence is not proof of absence.',
					}
				}
			},
		}),
		defineTool({
			name: 'read_resident_history',
			description:
				'Read exact retained text at a revision/part address returned by search_resident_history. Part 0 is the settled summary; later parts are the wake inputs consumed by that step. Returns at most 6000 characters. Continue with nextOffset as offset at the same address. Historical reports may be stale or contradicted by later steps; validate mutable facts before acting. Does not replay actions or restore unrecorded tool output.',
			inputSchema: z
				.object({
					revision: z.number().int().positive().safe(),
					part: z.number().int().min(0).max(16),
					offset: z.number().int().nonnegative().safe().optional(),
				})
				.strict(),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			presentCall: (input) => ({
				kind: 'generic',
				label: `Step evidence · revision ${input.revision} · part ${input.part}`,
			}),
			async execute(input, context) {
				try {
					context.abortSignal?.throwIfAborted()
					const result = await resolveSource(context).read(input, context.abortSignal)
					return { success: true, output: JSON.stringify(result) }
				} catch {
					context.abortSignal?.throwIfAborted()
					return {
						success: false,
						output: '',
						error:
							'Resident evidence is unavailable or the address is invalid. Use revision/part from search_resident_history and the returned nextOffset.',
					}
				}
			},
		}),
	]
}
