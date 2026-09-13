import {
	type EvidenceRecallCandidate,
	type EvidenceRecallContinuation,
	type PrepareStep,
	type SessionId,
	createEvidenceRecallStep,
	refineEvidenceRecallTerms,
} from '@namzu/sdk'
import { retainLiveConversationSearch, searchConversationTerms } from './conversation-search.js'
import type { ConversationContext } from './store.js'

// These host-owned tools quote archived observations; successful results are
// not new observations for automatic discovery. New explicit searches remain unfiltered.
const EXCLUDE_RETRIEVAL_RESULTS = ['read_conversation', 'search_conversation'] as const

interface RecallScan {
	terms: readonly string[]
	excludeDerivedSummaries?: boolean
	cursor?: string
	started: boolean
	omitted: boolean
}

function newScan(terms: readonly string[]): RecallScan {
	return { terms, started: false, omitted: false }
}

// At most one focused scan per source class. It spends an existing page and
// leaves the broader cursor intact. Completing a subset cannot exhaust it.
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
	// Spend the existing refinement page on source records when derived text
	// fills discovery. Preserve the general cursor and its summary candidates.
	if (hasDerivedSummaries) {
		scans.push({ ...newScan(scan.terms), excludeDerivedSummaries: true })
		return
	}
	const focused = refineEvidenceRecallTerms(scan.terms, excerpts)
	if (focused) scans.push(newScan(focused))
}

/** A stable hook per conversation keeps timed-out reads from piling up across turns. */
export function createConversationEvidenceRecall(
	sessions: ConversationContext,
	sessionId: SessionId,
	assertOwner: (runId: string) => void,
): PrepareStep {
	const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId }
	return createEvidenceRecallStep({
		scope,
		async retrieve({ runId, terms, signal, maxReadBytes, maxCandidates, captureRunEvidence }) {
			assertOwner(runId)
			const candidates: EvidenceRecallCandidate[] = []
			let scannedBytes = 0
			let incomplete = false
			let excludedToolResults = 0
			let excludedSummaries = 0
			let pages = 0
			// Reserve at least two of the four pages for earlier invocations. The
			// current writer is visited directly, never rediscovered as a disk run.
			const liveScans = [newScan(terms)]
			if (captureRunEvidence) {
				for (let livePage = 0; livePage < 2; livePage++) {
					const scan = [...liveScans].reverse().find((s) => !s.started || s.cursor)
					if (!scan) break
					signal.throwIfAborted()
					const remaining = maxReadBytes - scannedBytes
					if (remaining < 1024 * 1024) {
						incomplete = true
						break
					}
					const source = await captureRunEvidence(remaining)
					assertOwner(runId)
					if (!source) {
						if (liveScans.some((s) => s.cursor))
							throw new Error('The active evidence source disappeared.')
						incomplete = true
						break
					}
					const owner = { ...scope, runId }
					if (
						Object.entries(owner).some(
							([key, value]) => source.scope[key as keyof typeof owner] !== value,
						)
					)
						throw new Error('The active evidence source has a different owner.')
					const page = await source.search(
						{
							terms: scan.terms,
							matchMode: 'token',
							excludeSuccessfulTools: EXCLUDE_RETRIEVAL_RESULTS,
							excludeDerivedSummaries: scan.excludeDerivedSummaries,
							caseSensitive: false,
							cursor: scan.cursor,
							limit: 4,
						},
						signal,
					)
					assertOwner(runId)
					if (
						!Number.isSafeInteger(page.scannedBytes) ||
						page.scannedBytes < 0 ||
						page.scannedBytes > remaining ||
						page.matches.length > 4
					)
						throw new Error('The active evidence page exceeded its retrieval bounds.')
					if (
						Object.entries(owner).some(
							([key, value]) => page.scope[key as keyof typeof owner] !== value,
						)
					)
						throw new Error('The active evidence page has a different owner.')
					pages++
					scannedBytes += page.scannedBytes
					excludedToolResults += page.excludedToolResults ?? 0
					excludedSummaries += page.excludedSummaries ?? 0
					scan.omitted ||= page.incomplete || page.unavailable.length > 0
					for (const match of page.matches)
						candidates.push({
							scope: owner,
							seq: match.seq,
							recordedAt: match.recordedAt,
							part: match.part,
							source: match.source,
							toolName: match.toolName,
							isError: match.isError,
							retained: match.retained,
							excerpt: match.excerpt,
							...(match.characterOffset === undefined ? {} : { byteOffset: match.byteOffset }),
						})
					advanceScan(
						liveScans,
						scan,
						page.nextCursor ?? undefined,
						page.matches.map((match) => match.excerpt),
						page.matches.some((match) => match.source === 'compaction_shed:summary'),
						livePage < 1,
					)
				}
				incomplete ||= liveScans.some((s) => s.omitted || s.cursor !== undefined)
			}
			const historyScans = [newScan(terms)]
			for (; pages < 4; pages++) {
				const scan = [...historyScans].reverse().find((s) => !s.started || s.cursor)
				if (!scan) break
				signal.throwIfAborted()
				const remaining = maxReadBytes - scannedBytes
				if (remaining < 6 * 1024 * 1024) {
					incomplete = true
					break
				}
				const page = await searchConversationTerms(
					sessions,
					sessionId,
					{
						terms: scan.terms,
						matchMode: 'token',
						excludeSuccessfulTools: EXCLUDE_RETRIEVAL_RESULTS,
						excludeDerivedSummaries: scan.excludeDerivedSummaries,
						excludeRunId: runId,
						maxReadBytes: remaining,
						cursor: scan.cursor,
					},
					signal,
				)
				assertOwner(runId)
				scannedBytes += page.scannedBytes
				excludedToolResults += page.excludedToolResults ?? 0
				excludedSummaries += page.excludedSummaries ?? 0
				// Continuation alone is not permanent incompleteness; unavailable
				// source data stays incomplete even after all bounded pages are read.
				incomplete ||= page.unavailableRuns > 0 || (page.incomplete && !page.nextCursor)
				for (const match of page.matches) {
					if (candidates.length >= maxCandidates) {
						incomplete = true
						break
					}
					candidates.push({
						scope: { ...scope, runId: match.runId },
						seq: match.seq,
						recordedAt: match.recordedAt,
						part: match.part,
						source: match.source,
						toolName: match.toolName,
						isError: match.isError,
						retained: match.retained ?? 'preview',
						excerpt: match.text,
						byteOffset: match.byteOffset,
					})
				}
				advanceScan(
					historyScans,
					scan,
					page.nextCursor,
					page.matches.map((match) => match.text),
					page.matches.some((match) => match.source === 'compaction_shed:summary'),
					pages < 3,
				)
				if (candidates.length >= maxCandidates) break
			}
			assertOwner(runId)
			signal.throwIfAborted()
			const continuations: EvidenceRecallContinuation[] = []
			for (const scan of [...liveScans].reverse()) {
				if (!scan.cursor) continue
				continuations.push({
					toolName: 'search_conversation',
					input: {
						cursor: retainLiveConversationSearch(
							sessions,
							sessionId,
							runId,
							scan.terms,
							scan.cursor,
							scan.omitted,
							'token',
							EXCLUDE_RETRIEVAL_RESULTS,
							scan.excludeDerivedSummaries,
						),
					},
				})
			}
			for (const scan of [...historyScans].reverse())
				if (scan.cursor)
					continuations.push({ toolName: 'search_conversation', input: { cursor: scan.cursor } })
			return {
				candidates,
				scannedBytes,
				incomplete: incomplete || historyScans.some((s) => s.cursor !== undefined),
				continuations,
				...(excludedToolResults ? { excludedToolResults } : {}),
				...(excludedSummaries ? { excludedSummaries } : {}),
			}
		},
	})
}
