import { type PrepareStep, type SessionId, createEvidenceRecallStep } from '@namzu/sdk'
import { searchConversationTerms } from './conversation-search.js'
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
		async retrieve({ runId, terms, signal, maxReadBytes, maxCandidates }) {
			assertOwner(runId)
			const candidates = []
			let scannedBytes = 0
			let incomplete = false
			let cursor: string | undefined
			for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
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
			return { candidates, scannedBytes, incomplete: incomplete || cursor !== undefined }
		},
	})
}
