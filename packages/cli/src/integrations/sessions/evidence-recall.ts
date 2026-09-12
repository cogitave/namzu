import {
	type EvidenceRecallCandidate,
	type EvidenceRecallContinuation,
	type PrepareStep,
	type SessionId,
	createEvidenceRecallStep,
} from '@namzu/sdk'
import { retainLiveConversationSearch, searchConversationTerms } from './conversation-search.js'
import type { CliSessions } from './store.js'

/** A stable hook per conversation keeps timed-out reads from piling up across turns. */
export function createConversationEvidenceRecall(
	sessions: CliSessions,
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
			let pages = 0
			// Reserve at least two of the four pages for earlier invocations. The
			// current writer is visited directly, never rediscovered as a disk run.
			let liveCursor: string | undefined
			if (captureRunEvidence) {
				for (let livePage = 0; livePage < 2; livePage++) {
					signal.throwIfAborted()
					const remaining = maxReadBytes - scannedBytes
					if (remaining < 1024 * 1024) {
						incomplete = true
						break
					}
					const source = await captureRunEvidence(remaining)
					assertOwner(runId)
					if (!source) {
						if (liveCursor) throw new Error('The active evidence source disappeared.')
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
						{ terms, caseSensitive: false, cursor: liveCursor, limit: 4 },
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
					incomplete ||= page.incomplete || page.unavailable.length > 0
					for (const match of page.matches)
						candidates.push({
							scope: owner,
							seq: match.seq,
							part: match.part,
							source: match.source,
							toolName: match.toolName,
							isError: match.isError,
							retained: match.retained,
							excerpt: match.excerpt,
							...(match.characterOffset === undefined ? {} : { byteOffset: match.byteOffset }),
						})
					liveCursor = page.nextCursor ?? undefined
					if (!liveCursor) break
				}
				incomplete ||= liveCursor !== undefined
			}
			let cursor: string | undefined
			for (; pages < 4; pages++) {
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
						terms,
						excludeRunId: runId,
						maxReadBytes: remaining,
						cursor,
					},
					signal,
				)
				assertOwner(runId)
				scannedBytes += page.scannedBytes
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
						part: match.part,
						source: match.source,
						toolName: match.toolName,
						isError: match.isError,
						retained: match.retained ?? 'preview',
						excerpt: match.text,
						byteOffset: match.byteOffset,
					})
				}
				cursor = page.nextCursor
				if (!cursor || candidates.length >= maxCandidates) break
			}
			assertOwner(runId)
			signal.throwIfAborted()
			const continuations: EvidenceRecallContinuation[] = []
			if (liveCursor)
				continuations.push({
					toolName: 'search_conversation',
					input: {
						cursor: retainLiveConversationSearch(sessions, sessionId, runId, terms, liveCursor),
					},
				})
			if (cursor) continuations.push({ toolName: 'search_conversation', input: { cursor } })
			return {
				candidates,
				scannedBytes,
				incomplete: incomplete || cursor !== undefined,
				continuations,
			}
		},
	})
}
