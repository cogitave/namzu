/**
 * Test support: a session log on disk with one open turn, the way the
 * evidence sources read it (`<session-id>.jsonl`, with retained tool output
 * in `<session-id>/tool-results/`).
 *
 * Not a test file (no `.test.ts`): suites import it to build the log.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
	ProjectId,
	SessionId,
	TenantId,
	TopicId,
	TurnId,
} from '../../../../types/ids/index.js'
import { generateMessageId } from '../../../../utils/id.js'
import { DiskSessionLog, type SessionLease, type SessionLog } from '../../../session-log/index.js'
import {
	createAnchoredSessionTextEvidenceSource,
	createSessionEvidenceSource,
	createSessionTextEvidenceSource,
} from '../../disk.js'
import type { SessionEvidenceSourceOptions } from '../../types.js'

export type EvidenceRecordDraft = Parameters<SessionLog['append']>[1]

/** How a source reads the log: while the turn runs, after it closed, or anchored at a head. */
export type EvidenceMode = 'live' | 'closed' | 'snapshot'

export interface EvidenceSession {
	readonly scope: {
		readonly tenantId: TenantId
		readonly projectId: ProjectId
		readonly sessionId: SessionId
		readonly turnId: TurnId
	}
	readonly log: DiskSessionLog
	readonly lease: SessionLease
	/** `<session-id>.jsonl` */
	readonly logPath: string
	/** `<session-id>/` */
	readonly sessionDir: string
	/** `<session-id>/tool-results/`, where retained output is spilled. */
	readonly spillDir: string
	/** Append a record of the open turn. */
	append(draft: Record<string, unknown>): ReturnType<SessionLog['append']>
	/** Settle the turn, so a `closed` reader may open the log. */
	close(): ReturnType<SessionLog['append']>
	/** A text evidence source over the log, read the way `mode` says. */
	textSource(
		mode: EvidenceMode,
		options?: Partial<SessionEvidenceSourceOptions>,
	): Promise<ReturnType<typeof createSessionTextEvidenceSource>>
	/** A fresh text source over the log file, as another reader opens it. */
	openTextSource(
		options?: Partial<SessionEvidenceSourceOptions>,
	): ReturnType<typeof createSessionTextEvidenceSource>
	/** The tool-only view over the log. */
	toolSource(
		options?: Partial<SessionEvidenceSourceOptions>,
	): ReturnType<typeof createSessionEvidenceSource>
}

export async function evidenceSession(
	root: string,
	options: {
		/** The log's clock: every record's `ts` reads it. */
		readonly now?: () => number
	} = {},
): Promise<EvidenceSession> {
	const scope = {
		tenantId: randomUUID() as TenantId,
		projectId: randomUUID() as ProjectId,
		sessionId: randomUUID() as SessionId,
		turnId: randomUUID() as TurnId,
	}
	const logPath = join(root, `${scope.sessionId}.jsonl`)
	const sessionDir = join(root, scope.sessionId)
	const log = new DiskSessionLog({
		sessionId: scope.sessionId,
		file: logPath,
		sessionDir,
		...(options.now ? { now: options.now } : {}),
	})
	const lease = (await log.claim({ holder: 'evidence-test', ttlMs: 600_000 })) as SessionLease
	await log.append(lease, {
		type: 'session_started',
		projectId: scope.projectId,
		tenantId: scope.tenantId,
		topicId: randomUUID() as TopicId,
		cwd: root,
		agent: { id: 'evidence', name: 'Evidence' },
	} as EvidenceRecordDraft)
	await log.beginTurn(lease, {
		turnId: scope.turnId,
		userMessageId: generateMessageId(),
		config: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
	})
	const append = (draft: Record<string, unknown>) =>
		log.append(lease, { turnId: scope.turnId, ...draft } as EvidenceRecordDraft)
	const base = (
		options: Partial<SessionEvidenceSourceOptions> = {},
	): SessionEvidenceSourceOptions => ({
		scope,
		logPath,
		...options,
	})
	return {
		scope,
		log,
		lease,
		logPath,
		sessionDir,
		spillDir: join(sessionDir, 'tool-results'),
		append,
		close: () =>
			append({
				type: 'turn_completed',
				result: 'done',
				settlement: {
					status: 'completed',
					iterations: 1,
					usage: {
						promptTokens: 0,
						completionTokens: 0,
						totalTokens: 0,
						cachedTokens: 0,
						cacheWriteTokens: 0,
					},
					cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
					durationMs: 1,
					resultSource: 'model',
					abandonedTaskIds: [],
					abandonedJobIds: [],
				},
			}),
		async textSource(mode, options = {}) {
			if (mode === 'live') {
				const head = await log.head()
				if (!head) throw new Error('the log is empty')
				return createAnchoredSessionTextEvidenceSource(
					base({ consistency: 'snapshot', ...options }),
					head.pointer,
				)
			}
			return createSessionTextEvidenceSource(
				base(mode === 'snapshot' ? { consistency: 'snapshot', ...options } : options),
			)
		},
		openTextSource: (options = {}) => createSessionTextEvidenceSource(base(options)),
		toolSource: (options = {}) => createSessionEvidenceSource(base(options)),
	}
}
