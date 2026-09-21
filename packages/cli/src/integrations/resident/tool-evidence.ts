import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
	type ResidentHistorySource,
	SessionPaths,
	asSessionId,
	asTurnId,
	createResidentToolEvidenceSource,
	createSessionEvidenceSource,
	isEntityId,
} from '@namzu/sdk'
import type { CliSessions } from '../sessions/store.js'
import { SESSION_HEAD_BYTES, readSessionStart } from './session-log-reads.js'

const ATTEMPT_DOCUMENT_BYTES = 65_536

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu

/** Pursuit and claim ids are UUIDs the resident agenda minted; they name no kernel entity. */
export function isResidentUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID.test(value)
}

function identity(value: unknown) {
	if (!value || typeof value !== 'object') throw new Error('Invalid attempt receipt.')
	const v = value as Record<string, unknown>
	if (
		v.version !== 1 ||
		!isResidentUuid(v.pursuitId) ||
		!isResidentUuid(v.claimId) ||
		!isEntityId(v.sessionId, 'session') ||
		!isEntityId(v.turnId, 'turn')
	)
		throw new Error('Invalid attempt identity.')
	return {
		pursuitId: v.pursuitId,
		claimId: v.claimId,
		sessionId: asSessionId(v.sessionId),
		turnId: asTurnId(v.turnId),
		startedAt: v.startedAt,
		finishedAt: v.finishedAt,
		cleanup: v.cleanup,
	}
}

export async function readResidentAttemptReceipt(
	root: string,
	path: string,
	signal?: AbortSignal,
): Promise<unknown> {
	signal?.throwIfAborted()
	const suffix = relative(root, path)
	if (suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('Invalid attempt path.')
	let current = root
	for (const part of ['', ...suffix.split(sep)]) {
		current = join(current, part)
		if ((await lstat(current)).isSymbolicLink()) throw new Error('Attempt symlinks are refused.')
	}
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const before = await file.stat()
		if (!before.isFile() || before.size > ATTEMPT_DOCUMENT_BYTES)
			throw new Error('Invalid attempt receipt size.')
		const bytes = Buffer.alloc(before.size)
		let offset = 0
		while (offset < bytes.length) {
			signal?.throwIfAborted()
			const read = await file.read(bytes, offset, bytes.length - offset, offset)
			if (!read.bytesRead) throw new Error('Attempt receipt shortened.')
			offset += read.bytesRead
		}
		const after = await file.stat()
		if (
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new Error('Attempt receipt changed.')
		return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes))
	} finally {
		await file.close()
	}
}

/** CLI supplies attempt/session authorization; SDK owns bounded retrieval and indexing. */
export function residentToolEvidence(
	history: ResidentHistorySource,
	sessions: Pick<CliSessions, 'root' | 'projectId' | 'tenantId'>,
	projectSlug: string,
	artifactsRoot: string,
) {
	const root = resolve(artifactsRoot)
	const paths = new SessionPaths({ home: sessions.root, slug: projectSlug })
	if (history.scope.tenantId !== sessions.tenantId)
		throw new Error('Resident history tenant mismatch.')
	return createResidentToolEvidenceSource({
		history,
		projectId: sessions.projectId,
		// Start and finish documents are size-checked before reading, and the
		// log's first record is read to attribute it. Reserve their upper bound,
		// not a fabricated measurement of stat I/O.
		resolutionReadBytes: 2 * ATTEMPT_DOCUMENT_BYTES + SESSION_HEAD_BYTES,
		async resolveTurn(settled: { readonly claimId: string }, signal?: AbortSignal) {
			const claimId = settled.claimId
			if (!isResidentUuid(claimId)) throw new Error('Invalid claim id.')
			const start = identity(
				await readResidentAttemptReceipt(root, join(root, claimId, 'start.json'), signal),
			)
			const finish = identity(
				await readResidentAttemptReceipt(root, join(root, claimId, 'finish.json'), signal),
			)
			for (const record of [start, finish])
				if (
					record.claimId !== claimId ||
					record.pursuitId !== history.scope.pursuitId ||
					record.sessionId !== start.sessionId ||
					record.turnId !== start.turnId
				)
					throw new Error('Attempt identity does not match its settled claim.')
			if (
				finish.cleanup !== 'confirmed' ||
				typeof start.startedAt !== 'number' ||
				!Number.isFinite(start.startedAt) ||
				typeof finish.finishedAt !== 'number' ||
				!Number.isFinite(finish.finishedAt) ||
				finish.finishedAt < start.startedAt
			)
				throw new Error('Invalid attempt receipt order.')
			// A resident step is its own root session. Its log names the project
			// and tenant it was opened under, and both must be this resident's.
			const logPath = paths.sessionLog({ sessionId: start.sessionId })
			const opened = await readSessionStart(sessions.root, logPath, signal)
			if (!opened) throw new Error('Attempt session log is missing.')
			if (
				opened.sessionId !== start.sessionId ||
				opened.projectId !== sessions.projectId ||
				(opened.tenantId !== undefined && opened.tenantId !== sessions.tenantId)
			)
				throw new Error('Attempt session belongs to a different project.')
			signal?.throwIfAborted()
			return createSessionEvidenceSource({
				scope: {
					tenantId: sessions.tenantId,
					projectId: sessions.projectId,
					sessionId: start.sessionId,
					turnId: start.turnId,
				},
				logPath,
			})
		},
	})
}
