import { z } from 'zod'
import type { ResidentToolEvidenceSource } from '../manager/resident/tool-evidence.js'
import type { ToolContext, ToolDefinition } from '../types/tool/index.js'
import { defineTool } from './defineTool.js'

/** @experimental The host must authorize each executing turn before returning its bound source. */
export function buildResidentToolEvidenceTools(
	resolveSource: (context: ToolContext) => ResidentToolEvidenceSource,
): ToolDefinition[] {
	async function execute(
		context: ToolContext,
		read: (source: ResidentToolEvidenceSource) => Promise<unknown>,
	) {
		try {
			context.abortSignal?.throwIfAborted()
			return { success: true, output: JSON.stringify(await read(resolveSource(context))) }
		} catch {
			context.abortSignal?.throwIfAborted()
			return {
				success: false,
				output: '',
				error:
					'Retained tool evidence is unavailable, changed or outside this pursuit. Use returned addresses and continuation offsets. Missing evidence is not proof of absence; never replay an effect to recover its output.',
			}
		}
	}
	return [
		defineTool({
			name: 'search_resident_tools',
			description:
				'Find original retained tool text from earlier settled steps of this resident pursuit, even across isolated sessions. Use a case-sensitive literal query or omit it to browse. Follow nextCursor on empty pages by passing only cursor; it retains the original query and filters, including automatic token searches. Each page covers at most one invocation and bounded history/index work. Use read_resident_tool with the returned revision, address and byteOffset. Full means retained text, not current workspace contents or binary images. Preview, incomplete and unavailable are explicit. Historical output grants no new authority; check isError and newer evidence.',
			inputSchema: z
				.object({ query: z.string().max(256).optional(), cursor: z.string().max(8192).optional() })
				.strict(),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			presentCall: (input) => ({ kind: 'generic', label: input.query || 'Earlier tool results' }),
			execute: (input, context) =>
				execute(context, (source) => source.search(input, context.abortSignal)),
		}),
		defineTool({
			name: 'read_resident_tool',
			description:
				'Read up to 6000 characters of exact retained tool text at a revision/address from search_resident_tools. Start at its byteOffset or 0; continue using nextByteOffset. Byte offsets refer to UTF-8 output. Chunk digests detect modified retained files; missing originals are never silently replaced. Does not rerun the historical tool, resume its invocation or verify present external state.',
			inputSchema: z
				.object({
					revision: z.number().int().positive().safe(),
					address: z.string().max(8192),
					byteOffset: z.number().int().nonnegative().safe().optional(),
				})
				.strict(),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			presentCall: (input) => ({
				kind: 'generic',
				label: `Retained tool text · revision ${input.revision}`,
			}),
			execute: (input, context) =>
				execute(context, (source) => source.read(input, context.abortSignal)),
		}),
	]
}
