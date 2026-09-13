import { z } from 'zod'
import {
	type EvidenceRecallRequest,
	type ScopedEvidenceRecallBatch,
	type ScopedEvidenceRecallCandidate,
	createScopedEvidenceRecallStep,
	evidenceRecallQueryTokens,
	refineEvidenceRecallTerms,
} from '../../run/evidence-recall.js'
import type { RunEvidenceScope } from '../../store/evidence/types.js'
import type { PrepareStep } from '../../types/run/prepare-step.js'
import { evidenceTokenKey } from '../../utils/evidence-tokens.js'
import { type ResidentState, residentStateSchema } from './store.js'
import type { ResidentToolEvidenceSource } from './tool-evidence.js'

/** @experimental Automatic original-tool recall for exactly one admitted resident run. */
export interface ResidentEvidenceRecallOptions {
	readonly source: ResidentToolEvidenceSource
	/** Already admitted state; summaries supply search words, never new observations. */
	readonly state: ResidentState
	/** The current executor, distinct from historical Session/run addresses. */
	readonly scope: RunEvidenceScope
	readonly maxChars?: number
	readonly maxPassages?: number
	readonly timeoutMs?: number
	/** Host tool names whose successful archival copies should not occupy result slots. */
	readonly excludeSuccessfulTools?: readonly string[]
}

const ownerSchema = z.object({
	tenantId: z.string().uuid(),
	projectId: z.string().uuid(),
	sessionId: z.string().uuid(),
	runId: z.string().uuid(),
})
const historicalScopeSchema = ownerSchema.omit({ sessionId: true, runId: true }).extend({
	agentKey: z.string().min(1).max(200),
	pursuitId: z.string().uuid(),
	throughRevision: z.number().int().positive().safe(),
})

// Sample both ends without merging or manufacturing a word at the cut. The
// field still contributes at most 4000 characters; its omitted middle is not
// inspected. Alternating ends also gives late corrections a term slot.
function residentQueryWords(text: string): string[] {
	const words =
		text.length <= 4000
			? evidenceRecallQueryTokens(text)
			: [
					...evidenceRecallQueryTokens(
						text
							.slice(0, 2000)
							.replace(/[\uD800-\uDBFF]$/u, '')
							.replace(/[\p{L}\p{N}_]+$/u, ''),
					),
					...evidenceRecallQueryTokens(
						text
							.slice(-2000)
							.replace(/^[\uDC00-\uDFFF]/u, '')
							.replace(/^[\p{L}\p{N}_]+/u, ''),
					),
				]
	const result: string[] = []
	for (let left = 0, right = words.length - 1; left <= right; left++, right--) {
		const first = words[left]
		const last = words[right]
		if (first) result.push(first)
		if (left !== right && last) result.push(last)
	}
	return result
}

/**
 * Reuses the shared bounded ranking/rendering engine while retaining the
 * pursuit's settlement authority. No arbitrary Session discovery, saved fact
 * cache, inference, workspace reread or action replay is performed here.
 */
export function createResidentEvidenceRecallStep(
	options: ResidentEvidenceRecallOptions,
): PrepareStep {
	const state = residentStateSchema.parse(options.state)
	const owner = Object.freeze(ownerSchema.parse(options.scope))
	const source = options.source
	const historicalScope = Object.freeze(historicalScopeSchema.parse(source.scope))
	if (
		state.phase !== 'running' ||
		!state.claimId ||
		state.tenantId !== owner.tenantId ||
		state.tenantId !== historicalScope.tenantId ||
		owner.projectId !== historicalScope.projectId ||
		state.agentKey !== historicalScope.agentKey ||
		state.pursuitId !== historicalScope.pursuitId
	)
		throw new Error('Resident recall requires one admitted pursuit and its authorized source.')
	const exclusions = options.excludeSuccessfulTools
		? [...new Set(options.excludeSuccessfulTools)].sort()
		: undefined
	if (
		exclusions &&
		(exclusions.length > 16 ||
			exclusions.some((name) => typeof name !== 'string' || !name.length || name.length > 256))
	)
		throw new Error('Resident recall exclusions are invalid.')
	if (
		Buffer.byteLength(
			JSON.stringify({
				terms: ['x'],
				...(exclusions?.length ? { excludeSuccessfulTools: exclusions } : {}),
			}),
		) > 512
	)
		throw new Error('Resident recall exclusions leave no bounded search room.')
	const snapshot = JSON.stringify(historicalScope)
	function assertSource() {
		if (JSON.stringify(historicalScopeSchema.parse(source.scope)) !== snapshot)
			throw new Error('Resident recall source changed ownership or admission boundary.')
	}

	// Round-robin categories keep a long objective or derived summary from
	// monopolizing all search terms. Within wakes, newer accepted inputs start
	// first; their original committed index is retained in query metadata.
	const wakes = (state.wakeEvidence ?? [])
		.map((wake, index) => ({
			kind: 'accepted_wake' as const,
			index,
			words: residentQueryWords(wake.reason),
		}))
		.reverse()
	const wakeWords: { term: string; source: string; wakeIndex?: number }[] = []
	for (let word = 0; word < 256; word++)
		for (const wake of wakes) {
			const term = wake.words[word]
			if (term) wakeWords.push({ term, source: wake.kind, wakeIndex: wake.index })
		}
	const groups = [
		wakeWords,
		residentQueryWords(state.objective).map((term) => ({ term, source: 'objective' })),
		residentQueryWords(state.summary ?? '').map((term) => ({
			term,
			source: 'derived_summary',
		})),
	]
	const selected: { term: string; source: string; wakeIndex?: number }[] = []
	const seen = new Set<string>()
	const offsets = [0, 0, 0]
	for (let round = 0; round < 16; round++) {
		for (const [i, group] of groups.entries()) {
			while ((offsets[i] ?? 0) < group.length && selected.length < 16) {
				const entry = group[offsets[i] ?? 0]
				offsets[i] = (offsets[i] ?? 0) + 1
				if (!entry || seen.has(evidenceTokenKey(entry.term))) continue
				const terms = [...selected.map((item) => item.term), entry.term]
				if (
					Buffer.byteLength(
						JSON.stringify({
							terms,
							...(exclusions?.length ? { excludeSuccessfulTools: exclusions } : {}),
						}),
					) > 512
				)
					continue
				selected.push(entry)
				seen.add(evidenceTokenKey(entry.term))
				break
			}
		}
	}
	const query = {
		terms: selected.map(({ term }) => term),
		metadata: {
			kind: 'literal_resident_state',
			terms: selected,
			throughRevision: historicalScope.throughRevision,
			guidance:
				'Words select historical tool records only. Objective/wakes are accepted inputs; derived_summary is a prior claim, not a new observation. Selection may omit relevant words. Fields over 4000 characters contribute their first/last 2000 characters; terms alternate ends. Query/ranking do not resolve ambiguous references or establish truth, freshness or completeness. Use read_resident_tool with revision/address/byteOffset for exact retained text.',
		},
	}
	const addresses = new WeakMap<ScopedEvidenceRecallCandidate, Readonly<Record<string, unknown>>>()
	const search = source.search.bind(source)
	const retrieve = async (request: EvidenceRecallRequest): Promise<ScopedEvidenceRecallBatch> => {
		if (request.runId !== owner.runId)
			throw new Error('Resident recall called from a different run.')
		assertSource()
		const candidates: ScopedEvidenceRecallCandidate[] = []
		let scannedBytes = 0
		let incomplete = false
		const scans: {
			terms: readonly string[]
			started: boolean
			cursor?: string
			refineTerms?: readonly string[]
		}[] = [{ terms: request.terms, started: false }]
		let excludedToolResults = 0
		for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
			const scan = [...scans].reverse().find((entry) => !entry.started || entry.cursor)
			if (!scan) break
			request.signal.throwIfAborted()
			const allowance = request.maxReadBytes - scannedBytes
			if (allowance <= 1024 * 1024 || candidates.length >= request.maxCandidates) break
			const page = await search(
				{
					...(scan.cursor
						? {
								cursor: scan.cursor,
								...(scan.refineTerms ? { refineTerms: scan.refineTerms } : {}),
							}
						: {
								terms: [...scan.terms],
								...(exclusions?.length ? { excludeSuccessfulTools: exclusions } : {}),
							}),
					maxReadBytes: allowance,
				},
				request.signal,
			)
			request.signal.throwIfAborted()
			assertSource()
			if (
				JSON.stringify(historicalScopeSchema.parse(page.scope)) !== snapshot ||
				!Number.isSafeInteger(page.chargedBytes) ||
				(page.chargedBytes ?? -1) < 0 ||
				(page.chargedBytes ?? Number.POSITIVE_INFINITY) > allowance ||
				typeof page.incomplete !== 'boolean' ||
				!Array.isArray(page.unavailableRevisions) ||
				page.unavailableRevisions.some(
					(revision) =>
						!Number.isSafeInteger(revision) ||
						revision < 1 ||
						revision > historicalScope.throughRevision,
				) ||
				(page.nextCursor !== null &&
					(typeof page.nextCursor !== 'string' ||
						!page.nextCursor.length ||
						page.nextCursor.length > 8192))
			)
				throw new Error('Resident recall received an invalid bounded page.')
			scannedBytes += page.chargedBytes ?? 0
			// A page with a continuation is locally incomplete even when all
			// records visited so far are valid. Clearing traversal later is safe;
			// unavailable evidence stays incomplete for this entire pass.
			incomplete ||=
				(page.incomplete && !page.nextCursor) ||
				page.unavailableRevisions.length > 0 ||
				!!page.evidence?.incomplete
			const evidence = page.evidence
			if (evidence) {
				const original = ownerSchema.parse(evidence.scope)
				if (
					original.tenantId !== owner.tenantId ||
					original.projectId !== owner.projectId ||
					original.runId === owner.runId ||
					!Number.isSafeInteger(page.revision) ||
					(page.revision ?? 0) < 1 ||
					(page.revision ?? Number.POSITIVE_INFINITY) > historicalScope.throughRevision ||
					!z.string().uuid().safeParse(page.claimId).success ||
					page.claimId === state.claimId ||
					!Array.isArray(evidence.matches) ||
					evidence.matches.length > 24
				)
					throw new Error('Resident recall returned an unauthorized invocation.')
				if (
					evidence.excludedToolResults !== undefined &&
					(!Number.isSafeInteger(evidence.excludedToolResults) || evidence.excludedToolResults < 0)
				)
					throw new Error('Resident recall returned an invalid exclusion count.')
				excludedToolResults += evidence.excludedToolResults ?? 0
				for (const match of evidence.matches) {
					if (
						typeof match.address !== 'string' ||
						!match.address.length ||
						match.address.length > 8192
					)
						throw new Error('Resident recall returned an invalid archive address.')
					const candidate: ScopedEvidenceRecallCandidate = {
						scope: original,
						seq: match.seq,
						recordedAt: match.recordedAt,
						source: 'tool_completed',
						toolName: match.toolName,
						isError: match.isError,
						retained: match.retained,
						excerpt: match.excerpt,
						excerptComplete: match.excerptComplete,
						byteOffset: match.byteOffset,
					}
					addresses.set(candidate, {
						sessionId: original.sessionId,
						runId: original.runId,
						seq: match.seq,
						pursuitId: historicalScope.pursuitId,
						revision: page.revision,
						claimId: page.claimId,
						address: match.address,
						byteOffset: match.byteOffset,
					})
					candidates.push(candidate)
				}
			}
			scan.started = true
			scan.cursor = page.nextCursor ?? undefined
			scan.refineTerms = undefined
			// One strict-subset scan spends the SAME page/byte allowance. Keep
			// the broad cursor: finishing a subset never exhausts the full query.
			if (
				scans.length === 1 &&
				scan.cursor &&
				pageNumber < 3 &&
				(evidence?.matches.length ?? 0) >= 4
			) {
				const focused = refineEvidenceRecallTerms(
					scan.terms,
					candidates.map((candidate) => candidate.excerpt),
				)
				if (focused)
					scans.push({
						terms: focused,
						started: false,
						...(source.supportsTermRefinement === true
							? { cursor: scan.cursor, refineTerms: focused }
							: {}),
					})
			}
		}
		const continuations = scans.flatMap((scan) =>
			scan.started && scan.cursor
				? [{ toolName: 'search_resident_tools', input: { cursor: scan.cursor } }]
				: [],
		)
		return {
			candidates,
			scannedBytes,
			incomplete: incomplete || scans.some((scan) => !scan.started || !!scan.cursor),
			excludedToolResults,
			continuations,
		}
	}
	const step = createScopedEvidenceRecallStep(
		{
			retrieve,
			maxChars: options.maxChars,
			maxPassages: options.maxPassages,
			timeoutMs: options.timeoutMs,
		},
		{
			kind: 'resident',
			selectQuery: () => query,
			validate(candidate) {
				assertSource()
				if (!addresses.has(candidate)) throw new Error('Unowned resident evidence candidate.')
			},
			address(candidate) {
				const address = addresses.get(candidate)
				if (!address) throw new Error('Missing resident evidence address.')
				return address
			},
		},
	)
	return async (context) => {
		if (context.runId !== owner.runId)
			throw new Error('Resident recall called from a different run.')
		assertSource()
		return step(context)
	}
}
