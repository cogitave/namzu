import { z } from 'zod'
import type {
	RunEvidenceReadOptions,
	RunEvidenceReadResult,
	RunEvidenceSearchResult,
	RunEvidenceSource,
} from '../../store/evidence/types.js'
import type {
	ResidentHistoryMatch,
	ResidentHistoryScope,
	ResidentHistorySource,
} from './history.js'

/** @experimental Host authority for one pursuit, project and admission boundary. */
export interface ResidentToolEvidenceScope extends ResidentHistoryScope {
	readonly projectId: string
}
/** @experimental Identity of an agenda-verified settlement, not a fabricated transcript. */
export type ResidentSettledInvocation = Pick<
	ResidentHistoryMatch,
	'revision' | 'claimId' | 'step' | 'kind'
>
/** @experimental Settlement is checked before the host resolves the attempt's invocation. */
export interface ResidentToolEvidenceOptions {
	readonly history: ResidentHistorySource
	readonly projectId: string
	readonly resolveRun: (
		settled: ResidentSettledInvocation,
		signal?: AbortSignal,
	) => Promise<RunEvidenceSource>
}
/** @experimental Tool records from at most one settled invocation per bounded search page. */
export interface ResidentToolEvidenceSearchResult {
	readonly scope: ResidentToolEvidenceScope
	readonly revision: number | null
	readonly claimId: string | null
	readonly evidence: RunEvidenceSearchResult | null
	readonly nextCursor: string | null
	readonly incomplete: boolean
	readonly unavailableRevisions: readonly number[]
	readonly historyBytes: number
}
/** @experimental The revision is authorized anew on every read, including after restart. */
export interface ResidentToolEvidenceReadOptions
	extends Omit<RunEvidenceReadOptions, 'maxReadBytes'> {
	readonly revision: number
}
/** @experimental Exact invocation text plus the settled claim that authorized access. */
export interface ResidentToolEvidenceReadResult extends RunEvidenceReadResult {
	readonly revision: number
	readonly claimId: string
}
/** @experimental A host must bind tool access to the executing run, not just this source. */
export interface ResidentToolEvidenceSource {
	readonly scope: ResidentToolEvidenceScope
	search(
		options?: { query?: string; cursor?: string },
		signal?: AbortSignal,
	): Promise<ResidentToolEvidenceSearchResult>
	read(
		options: ResidentToolEvidenceReadOptions,
		signal?: AbortSignal,
	): Promise<ResidentToolEvidenceReadResult>
}

/** @experimental Reuses the immutable agenda boundary; it never enumerates arbitrary sessions. */
export function createResidentToolEvidenceSource(
	options: ResidentToolEvidenceOptions,
): ResidentToolEvidenceSource {
	const { history, resolveRun } = options
	const scope = Object.freeze({
		...history.scope,
		projectId: z.string().uuid().parse(options.projectId),
	})
	const revision = z.number().int().min(1).max(scope.throughRevision).safe()
	const cursorSchema = z
		.object({
			version: z.literal(1),
			scope: z.literal(JSON.stringify(scope)),
			query: z.string().max(256),
			revision,
			runCursor: z.string().max(4096).optional(),
		})
		.strict()
	const encode = (value: z.infer<typeof cursorSchema>) =>
		Buffer.from(JSON.stringify(value)).toString('base64url')
	async function run(entry: ResidentSettledInvocation, signal?: AbortSignal) {
		signal?.throwIfAborted()
		const source = await resolveRun(entry, signal)
		if (source.scope.tenantId !== scope.tenantId || source.scope.projectId !== scope.projectId)
			throw new Error('Historical invocation belongs to a different owner.')
		return source
	}
	return Object.freeze({
		scope,
		async search(input: { query?: string; cursor?: string } = {}, signal?: AbortSignal) {
			const query = z
				.string()
				.max(256)
				.parse(input.query ?? '')
			const cursor = input.cursor
				? cursorSchema.parse(
						JSON.parse(
							Buffer.from(z.string().max(8192).parse(input.cursor), 'base64url').toString('utf8'),
						),
					)
				: {
						version: 1 as const,
						scope: JSON.stringify(scope),
						query,
						revision: scope.throughRevision,
					}
			if (cursor.query !== query) throw new Error('Resident tool search query changed.')
			let selected: ResidentSettledInvocation | null = null
			let nextRevision: number | null = null
			let historyBytes = 0
			const unavailable = new Set<number>()
			if (cursor.runCursor) {
				const page = await history.read({ revision: cursor.revision, part: 0 }, signal)
				selected = page.entry
				historyBytes += page.scannedBytes
				for (const missing of page.unavailableRevisions) unavailable.add(missing)
				nextRevision = cursor.revision > 2 ? cursor.revision - 1 : null
			} else {
				const page = await history.search({ cursor: cursor.revision, limit: 1 }, signal)
				historyBytes += page.scannedBytes
				for (const missing of page.unavailableRevisions) unavailable.add(missing)
				nextRevision = page.nextCursor
				const match = page.matches[0]
				// Browse always selects the settled summary (part 0). The bounded history
				// source has already verified both sides of this settlement transition.
				if (match) selected = match
			}
			let evidence: RunEvidenceSearchResult | null = null
			if (selected) {
				try {
					evidence = await (await run(selected, signal)).search(
						{ query, ...(cursor.runCursor ? { cursor: cursor.runCursor } : {}) },
						signal,
					)
				} catch {
					signal?.throwIfAborted()
					unavailable.add(selected.revision)
				}
			}
			const nextCursor =
				evidence?.nextCursor && selected
					? encode({ ...cursor, revision: selected.revision, runCursor: evidence.nextCursor })
					: nextRevision
						? encode({ version: 1, scope: JSON.stringify(scope), query, revision: nextRevision })
						: null
			return {
				scope,
				revision: selected?.revision ?? null,
				claimId: selected?.claimId ?? null,
				evidence,
				nextCursor,
				incomplete: unavailable.size > 0 || !!evidence?.incomplete,
				unavailableRevisions: [...unavailable],
				historyBytes,
			}
		},
		async read(input: ResidentToolEvidenceReadOptions, signal?: AbortSignal) {
			const page = await history.read({ revision: revision.parse(input.revision), part: 0 }, signal)
			if (!page.entry) throw new Error('The requested settled claim is unavailable.')
			const result = await (await run(page.entry, signal)).read(
				{
					address: input.address,
					...(input.byteOffset !== undefined ? { byteOffset: input.byteOffset } : {}),
				},
				signal,
			)
			return { ...result, revision: page.entry.revision, claimId: page.entry.claimId }
		},
	})
}
