import { z } from 'zod'
import { evidenceSearchInput, evidenceTermsSchema } from '../../store/evidence/search-input.js'
import { evidenceExclusionsSchema } from '../../store/evidence/selection.js'
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
	/** Host-enforced upper bound for resolveRun's document reads, charged in full.
	 * Required only when an operation supplies maxReadBytes. Zero asserts no
	 * document reads. This is a declared bound, not a measured receipt.
	 */
	readonly resolutionReadBytes?: number
	readonly resolveRun: (
		settled: ResidentSettledInvocation,
		signal?: AbortSignal,
	) => Promise<RunEvidenceSource>
}
/** @experimental An optional shared ceiling covers history, resolution and run evidence. */
export interface ResidentToolEvidenceSearchOptions {
	readonly query?: string
	/** Token discovery: 1–16 terms, matched case-insensitively. Combined query/filter JSON ≤512 UTF-8 bytes. */
	readonly terms?: readonly string[]
	/** Omit successful retrieval copies before they consume candidate slots. */
	readonly excludeSuccessfulTools?: readonly string[]
	/** Omit query/terms/filter to continue the exact captured search. */
	readonly cursor?: string
	readonly maxReadBytes?: number
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
	/** Present for bounded calls: history + declared resolution + run reads.
	 * Failed source reads without a receipt conservatively consume the remainder.
	 */
	readonly chargedBytes?: number
}
/** @experimental The revision is authorized anew on every read, including after restart. */
export interface ResidentToolEvidenceReadOptions
	extends Omit<RunEvidenceReadOptions, 'maxReadBytes'> {
	readonly revision: number
	/** Shared operation ceiling, at most 8 MiB; reserves at least 1 MiB for run reads. */
	readonly maxReadBytes?: number
}
/** @experimental Exact invocation text plus the settled claim that authorized access. */
export interface ResidentToolEvidenceReadResult extends RunEvidenceReadResult {
	readonly revision: number
	readonly claimId: string
	readonly chargedBytes?: number
}
/** @experimental A host must bind tool access to the executing run, not just this source. */
export interface ResidentToolEvidenceSource {
	readonly scope: ResidentToolEvidenceScope
	search(
		options?: ResidentToolEvidenceSearchOptions,
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
	const resolutionReadBytes = z
		.number()
		.int()
		.min(0)
		.max(8 * 1024 * 1024)
		.optional()
		.parse(options.resolutionReadBytes)
	function operationBudget(maxReadBytes: number | undefined) {
		if (maxReadBytes === undefined) return undefined
		if (resolutionReadBytes === undefined)
			throw new Error('Bounded resident retrieval requires a declared resolution read bound.')
		const limit = z
			.number()
			.int()
			.positive()
			.max(8 * 1024 * 1024)
			.parse(maxReadBytes)
		const historyLimit = limit - resolutionReadBytes - 1024 * 1024
		if (historyLimit < 1)
			throw new Error('Resident read budget cannot fit history, resolution and run reads.')
		let charged = 0
		return {
			historyLimit,
			get remaining() {
				return limit - charged
			},
			get chargedBytes() {
				return charged
			},
			charge(bytes: number, allowance: number) {
				if (
					!Number.isSafeInteger(bytes) ||
					bytes < 0 ||
					bytes > allowance ||
					charged + bytes > limit
				)
					throw new Error('Resident evidence returned an invalid read budget receipt.')
				charged += bytes
			},
			resolve() {
				charged += resolutionReadBytes
			},
			exhaust() {
				charged = limit
			},
		}
	}
	const scope = Object.freeze({
		...history.scope,
		projectId: z.string().uuid().parse(options.projectId),
	})
	const revision = z.number().int().min(1).max(scope.throughRevision).safe()
	const searchSchema = z
		.object({
			query: z.string().max(256).optional(),
			terms: evidenceTermsSchema,
			excludeSuccessfulTools: evidenceExclusionsSchema.optional(),
		})
		.strict()
	function searchInput(value: unknown) {
		const parsed = searchSchema.parse(value)
		const search = evidenceSearchInput({
			...parsed,
			...(parsed.terms ? { matchMode: 'token' as const } : {}),
		})
		const result: z.infer<typeof searchSchema> = {
			...(search.terms ? { terms: search.terms } : { query: search.query }),
			...(parsed.excludeSuccessfulTools?.length
				? { excludeSuccessfulTools: [...new Set(parsed.excludeSuccessfulTools)].sort() }
				: {}),
		}
		if (
			(search.terms || result.excludeSuccessfulTools) &&
			Buffer.byteLength(JSON.stringify(result)) > 512
		)
			throw new Error('Resident search terms and filters exceed 512 UTF-8 bytes.')
		return result
	}
	const cursorBase = {
		scope: z.literal(JSON.stringify(scope)),
		revision,
		runCursor: z.string().max(4096).optional(),
	}
	const cursorSchema = z.discriminatedUnion('version', [
		z.object({ ...cursorBase, version: z.literal(1), query: z.string().max(256) }).strict(),
		z.object({ ...cursorBase, version: z.literal(2), search: searchSchema }).strict(),
	])
	const encode = (value: z.infer<typeof cursorSchema>) => {
		const encoded = Buffer.from(JSON.stringify(cursorSchema.parse(value))).toString('base64url')
		if (encoded.length > 8192) throw new Error('Resident continuation exceeds its encoded bound.')
		return encoded
	}
	async function run(entry: ResidentSettledInvocation, signal?: AbortSignal) {
		signal?.throwIfAborted()
		const source = await resolveRun(entry, signal)
		signal?.throwIfAborted()
		if (source.scope.tenantId !== scope.tenantId || source.scope.projectId !== scope.projectId)
			throw new Error('Historical invocation belongs to a different owner.')
		const owner = z
			.object({
				tenantId: z.string().uuid(),
				projectId: z.string().uuid(),
				sessionId: z.string().uuid(),
				runId: z.string().uuid(),
			})
			.parse(source.scope)
		return { source, owner }
	}
	function assertOwner(
		page: { scope: RunEvidenceSource['scope'] },
		owner: RunEvidenceSource['scope'],
		signal?: AbortSignal,
	) {
		signal?.throwIfAborted()
		if (
			!page?.scope ||
			Object.entries(owner).some(([key, value]) => page.scope[key as keyof typeof owner] !== value)
		)
			throw new Error('Historical evidence result belongs to a different owner.')
	}
	return Object.freeze({
		scope,
		async search(input: ResidentToolEvidenceSearchOptions = {}, signal?: AbortSignal) {
			signal?.throwIfAborted()
			const budget = operationBudget(input.maxReadBytes)
			const prior = input.cursor
				? cursorSchema.parse(
						JSON.parse(
							Buffer.from(z.string().max(8192).parse(input.cursor), 'base64url').toString('utf8'),
						),
					)
				: undefined
			const supplied =
				input.query !== undefined ||
				input.terms !== undefined ||
				input.excludeSuccessfulTools !== undefined
			const previous = prior
				? searchInput(prior.version === 1 ? { query: prior.query } : prior.search)
				: undefined
			const search =
				supplied || !previous
					? searchInput({
							...(input.query !== undefined ? { query: input.query } : {}),
							...(input.terms !== undefined ? { terms: input.terms } : {}),
							...(input.excludeSuccessfulTools !== undefined
								? { excludeSuccessfulTools: input.excludeSuccessfulTools }
								: {}),
						})
					: previous
			if (previous && JSON.stringify(previous) !== JSON.stringify(search))
				throw new Error('Resident tool search query changed.')
			const cursor: z.infer<typeof cursorSchema> =
				prior ??
				(search.terms || search.excludeSuccessfulTools
					? {
							version: 2 as const,
							scope: JSON.stringify(scope),
							search,
							revision: scope.throughRevision,
						}
					: {
							version: 1 as const,
							scope: JSON.stringify(scope),
							query: search.query ?? '',
							revision: scope.throughRevision,
						})
			let selected: ResidentSettledInvocation | null = null
			let nextRevision: number | null = null
			let historyBytes = 0
			const unavailable = new Set<number>()
			if (cursor.runCursor) {
				const page = await history.read(
					{
						revision: cursor.revision,
						part: 0,
						...(budget ? { maxReadBytes: budget.historyLimit } : {}),
					},
					signal,
				)
				signal?.throwIfAborted()
				budget?.charge(page.scannedBytes, budget.historyLimit)
				selected = page.entry
				historyBytes += page.scannedBytes
				for (const missing of page.unavailableRevisions) unavailable.add(missing)
				nextRevision = cursor.revision > 2 ? cursor.revision - 1 : null
			} else {
				const page = await history.search(
					{
						cursor: cursor.revision,
						limit: 1,
						...(budget ? { maxReadBytes: budget.historyLimit } : {}),
					},
					signal,
				)
				signal?.throwIfAborted()
				budget?.charge(page.scannedBytes, budget.historyLimit)
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
					budget?.resolve()
					const { source, owner } = await run(selected, signal)
					const page = await source.search(
						{
							...search,
							...(search.terms ? { matchMode: 'token' as const, caseSensitive: false } : {}),
							...(cursor.runCursor ? { cursor: cursor.runCursor } : {}),
							...(budget ? { maxReadBytes: budget.remaining } : {}),
						},
						signal,
					)
					assertOwner(page, owner, signal)
					budget?.charge(page.scannedBytes, budget.remaining)
					evidence = page
				} catch {
					signal?.throwIfAborted()
					// A throwing host/source returned no reliable byte receipt. The
					// caller must not reuse that allowance for another automatic page.
					budget?.exhaust()
					unavailable.add(selected.revision)
				}
			}
			const nextCursor =
				evidence?.nextCursor && selected
					? encode({ ...cursor, revision: selected.revision, runCursor: evidence.nextCursor })
					: nextRevision
						? encode({ ...cursor, revision: nextRevision, runCursor: undefined })
						: null
			return {
				scope,
				revision: selected?.revision ?? null,
				claimId: selected?.claimId ?? null,
				evidence,
				nextCursor,
				incomplete: unavailable.size > 0 || !!evidence?.incomplete || nextCursor !== null,
				unavailableRevisions: [...unavailable],
				historyBytes,
				...(budget ? { chargedBytes: budget.chargedBytes } : {}),
			}
		},
		async read(input: ResidentToolEvidenceReadOptions, signal?: AbortSignal) {
			signal?.throwIfAborted()
			const budget = operationBudget(input.maxReadBytes)
			const page = await history.read(
				{
					revision: revision.parse(input.revision),
					part: 0,
					...(budget ? { maxReadBytes: budget.historyLimit } : {}),
				},
				signal,
			)
			signal?.throwIfAborted()
			budget?.charge(page.scannedBytes, budget.historyLimit)
			if (!page.entry) throw new Error('The requested settled claim is unavailable.')
			budget?.resolve()
			const { source, owner } = await run(page.entry, signal)
			const result = await source.read(
				{
					address: input.address,
					...(input.byteOffset !== undefined ? { byteOffset: input.byteOffset } : {}),
					...(budget ? { maxReadBytes: budget.remaining } : {}),
				},
				signal,
			)
			assertOwner(result, owner, signal)
			budget?.charge(result.scannedBytes, budget.remaining)
			return {
				...result,
				revision: page.entry.revision,
				claimId: page.entry.claimId,
				...(budget ? { chargedBytes: budget.chargedBytes } : {}),
			}
		},
	})
}
