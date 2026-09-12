import {
	type Message,
	type RunEvent,
	RunPersistence,
	type SessionId,
	generateRunId,
} from '@namzu/sdk'
import { cliLogger } from '../../logging.js'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'
import { type CliSessions, requireWritableConversation } from './store.js'

/** A zero-model maintenance record, separate from closed model invocations. */
export async function retainManualCompaction(
	sessions: CliSessions,
	sessionId: SessionId,
	messages: readonly Message[],
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted()
	await requireWritableConversation(sessions, sessionId, 'retain compacted history')
	if (!messages.length) return
	const sessionsDir = ensurePrivateStateDirectory(sessions.root, 'sessions')
	const sessionDir = ensurePrivateStateDirectory(sessionsDir, sessionId)
	const outputDir = ensurePrivateStateDirectory(sessionDir, 'runs')
	const persistence = new RunPersistence({
		runId: generateRunId(),
		agentId: 'manual-compaction',
		agentName: 'Manual compaction archive',
		providerId: 'host',
		runConfig: { model: 'none', timeoutMs: 0, tokenBudget: 0 },
		outputDir,
		log: cliLogger(),
		sessionId,
		topicId: sessions.topicId,
		tenantId: sessions.tenantId,
		projectId: sessions.projectId,
	})
	await persistence.init()
	const store = persistence.getRunStore()
	const append = async (event: RunEvent) => {
		signal?.throwIfAborted()
		const seq = persistence.nextEventSeq()
		await store.appendEvent({ ...event, seq })
		persistence.commitEventSeq(seq)
	}
	try {
		await append({ type: 'run_started', runId: persistence.id })
		// The SDK bounds large records and indexes their individual text parts.
		// Keep the same removed-message event shape as automatic compaction.
		await append({
			type: 'compaction_shed',
			runId: persistence.id,
			iteration: 0,
			reason: 'manual',
			messages: [...messages],
		})
		await append({ type: 'run_completed', runId: persistence.id, result: '' })
		persistence.markCompleted()
		// No model answer, checkpoint or global run-index row: this operation
		// archives evidence; it must not become a resumable agent invocation.
		await store.writeRunMeta(persistence.getRun())
		signal?.throwIfAborted()
	} catch (error) {
		persistence.markFailed('Manual compaction retention did not finish.')
		await store.writeRunMeta(persistence.getRun()).catch(() => {})
		throw error
	}
}
