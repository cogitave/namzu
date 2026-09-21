import {
	type PrepareStep,
	type SessionEvidenceScope,
	type SessionId,
	type SessionTextEvidenceSource,
	createEvidenceRecallStep,
	refineEvidenceRecallTerms,
} from '@namzu/sdk'
import {
	type ActiveEvidence,
	CONVERSATION_RETRIEVAL_TOOLS,
	searchConversationTerms,
} from './conversation-search.js'
import type { ConversationContext } from './store.js'

/**
 * What the kernel's recall step hands the host for one retrieval: the terms
 * it wants, its ceilings, and — inside a running turn — that turn's own
 * evidence snapshot, which covers the whole session log up to now.
 */
export interface ConversationRecallRequest {
	readonly turnId?: string
	readonly captureSessionEvidence?: (
		maxReadBytes?: number,
	) => Promise<SessionTextEvidenceSource | undefined>
	readonly terms: readonly string[]
	readonly maxReadBytes: number
	readonly maxCandidates: number
	readonly signal: AbortSignal
}

/** One authenticated historical passage, never a current-state assertion. */
export interface ConversationRecallCandidate {
	readonly scope: SessionEvidenceScope
	readonly seq: number
	readonly recordedAt?: number
	readonly part: number
	readonly source: string
	readonly toolName?: string
	readonly isError?: boolean
	readonly retained: 'full' | 'preview'
	readonly excerpt: string
	readonly excerptComplete?: boolean
	readonly byteOffset?: number
}

export interface ConversationRecallBatch {
	readonly candidates: readonly ConversationRecallCandidate[]
	readonly scannedBytes: number
	readonly incomplete: boolean
	readonly excludedToolResults?: number
	readonly excludedSummaries?: number
	readonly continuations?: readonly {
		readonly toolName: string
		readonly input: Readonly<Record<string, string | number | boolean | null>>
	}[]
}

interface RecallScan {
	terms: readonly string[]
	excludeDerivedSummaries?: boolean
	cursor?: string
	started: boolean
}

function newScan(terms: readonly string[]): RecallScan {
	return { terms, started: false }
}

// At most one focused scan. It spends an existing page and leaves the broader
// cursor intact. Completing a subset cannot exhaust it.
function advanceScan(
	scans: RecallScan[],
	scan: RecallScan,
	nextCursor: string | undefined,
	excerpts: readonly string[],
	hasDerivedSummaries: boolean,
	canRefine: boolean,
): void {
	scan.started = true
	scan.cursor = nextCursor
	if (!canRefine || scans.length !== 1 || !nextCursor) return
	// Spend the refinement page on source records when derived text fills
	// discovery. Preserve the general cursor and its summary candidates.
	if (hasDerivedSummaries) {
		scans.push({ ...newScan(scan.terms), excludeDerivedSummaries: true })
		return
	}
	const focused: readonly string[] | undefined = refineEvidenceRecallTerms(scan.terms, excerpts)
	if (focused) scans.push(newScan(focused))
}

/** Pages of one recall; the kernel's own ceiling bounds the bytes. */
const RECALL_PAGES = 4

/** A stable hook per conversation keeps timed-out reads from piling up across turns. */
export function createConversationEvidenceRecall(
	sessions: ConversationContext,
	sessionId: SessionId,
	assertOwner: (turnId: string | undefined) => void,
	resolveQuery = false,
): PrepareStep {
	const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId }
	return createEvidenceRecallStep({
		scope,
		resolveQuery,
		async retrieve(request: ConversationRecallRequest): Promise<ConversationRecallBatch> {
			const { turnId, terms, signal, maxReadBytes, maxCandidates, captureSessionEvidence } = request
			assertOwner(turnId)
			// Inside a turn its own snapshot covers the whole log, the running turn
			// included; outside one the log is read as a snapshot.
			const active: ActiveEvidence | undefined =
				captureSessionEvidence && turnId !== undefined
					? {
							sessionId,
							turnId: turnId as ActiveEvidence['turnId'],
							captureSessionEvidence: (bytes) => captureSessionEvidence(bytes),
						}
					: undefined
			const candidates: ConversationRecallCandidate[] = []
			let scannedBytes = 0
			let incomplete = false
			let excludedToolResults = 0
			let excludedSummaries = 0
			const scans = [newScan(terms)]
			for (let pages = 0; pages < RECALL_PAGES; pages++) {
				const scan = [...scans].reverse().find((s) => !s.started || s.cursor)
				if (!scan) break
				signal.throwIfAborted()
				const remaining = maxReadBytes - scannedBytes
				if (remaining < 1024 * 1024) {
					incomplete = true
					break
				}
				const page = await searchConversationTerms(
					sessions,
					sessionId,
					{
						terms: scan.terms,
						matchMode: 'token',
						excludeSuccessfulTools: CONVERSATION_RETRIEVAL_TOOLS,
						excludeDerivedSummaries: scan.excludeDerivedSummaries ?? false,
						maxReadBytes: remaining,
						...(scan.cursor ? { cursor: scan.cursor } : {}),
					},
					signal,
					active,
				)
				assertOwner(turnId)
				scannedBytes += page.scannedBytes
				excludedToolResults += page.excludedToolResults ?? 0
				excludedSummaries += page.excludedSummaries ?? 0
				// Continuation alone is not permanent incompleteness; unavailable
				// source data stays incomplete even after all bounded pages are read.
				incomplete ||= page.unavailable > 0 || (page.incomplete && !page.nextCursor)
				for (const match of page.matches) {
					if (candidates.length >= maxCandidates) {
						incomplete = true
						break
					}
					candidates.push({
						scope,
						seq: match.seq,
						recordedAt: match.recordedAt,
						part: match.part,
						source: match.source,
						toolName: match.toolName,
						isError: match.isError,
						retained: match.retained ?? 'preview',
						excerpt: match.text,
						excerptComplete: match.excerptComplete,
						...(match.byteOffset === undefined ? {} : { byteOffset: match.byteOffset }),
					})
				}
				advanceScan(
					scans,
					scan,
					page.nextCursor,
					page.matches.map((match) => match.text),
					page.matches.some((match) => match.source === 'compaction_shed:summary'),
					pages < RECALL_PAGES - 1,
				)
				if (candidates.length >= maxCandidates) break
			}
			assertOwner(turnId)
			signal.throwIfAborted()
			const continuations = [...scans]
				.reverse()
				.filter((scan) => scan.cursor !== undefined)
				.map((scan) => ({
					toolName: 'search_conversation',
					input: { cursor: scan.cursor as string },
				}))
			return {
				candidates,
				scannedBytes,
				incomplete: incomplete || continuations.length > 0,
				continuations,
				...(excludedToolResults ? { excludedToolResults } : {}),
				...(excludedSummaries ? { excludedSummaries } : {}),
			}
		},
	})
}
