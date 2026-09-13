import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
	type ResidentHistorySource,
	asRunId,
	asSessionId,
	createDiskRunEvidenceSource,
	createResidentToolEvidenceSource,
	isEntityId,
} from '@namzu/sdk'
import { CliPathBuilder } from '../sessions/paths.js'
import type { CliSessions } from '../sessions/store.js'

const ATTEMPT_DOCUMENT_BYTES = 65_536

function identity(value: unknown) {
	if (!value || typeof value !== 'object') throw new Error('Invalid attempt receipt.')
	const v = value as Record<string, unknown>
	if (
		v.version !== 1 ||
		!isEntityId(v.pursuitId, 'run') ||
		!isEntityId(v.claimId, 'run') ||
		typeof v.sessionId !== 'string' ||
		typeof v.runId !== 'string'
	)
		throw new Error('Invalid attempt identity.')
	return {
		pursuitId: v.pursuitId,
		claimId: v.claimId,
		sessionId: asSessionId(v.sessionId),
		runId: asRunId(v.runId),
		startedAt: v.startedAt,
		finishedAt: v.finishedAt,
		cleanup: v.cleanup,
	}
}

async function receipt(root: string, path: string, signal?: AbortSignal): Promise<unknown> {
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

/** CLI supplies attempt/Session authorization; SDK owns bounded retrieval and indexing. */
export function residentToolEvidence(
	history: ResidentHistorySource,
	sessions: CliSessions,
	artifactsRoot: string,
) {
	const root = resolve(artifactsRoot)
	const paths = new CliPathBuilder(sessions.root)
	if (history.scope.tenantId !== sessions.tenantId)
		throw new Error('Resident history tenant mismatch.')
	return createResidentToolEvidenceSource({
		history,
		projectId: sessions.projectId,
		// Start and finish documents are size-checked before reading. Reserve
		// their upper bound, not a fabricated measurement of database/stat I/O.
		resolutionReadBytes: 2 * ATTEMPT_DOCUMENT_BYTES,
		async resolveRun(settled, signal) {
			const claimId = settled.claimId
			if (!isEntityId(claimId, 'run')) throw new Error('Invalid claim id.')
			const start = identity(await receipt(root, join(root, claimId, 'start.json'), signal))
			const finish = identity(await receipt(root, join(root, claimId, 'finish.json'), signal))
			for (const record of [start, finish])
				if (
					record.claimId !== claimId ||
					record.pursuitId !== history.scope.pursuitId ||
					record.sessionId !== start.sessionId ||
					record.runId !== start.runId
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
			const sessionId = asSessionId(start.sessionId)
			// Resident invocations persist their own Run ledger, without creating a
			// resumable conversation row. An existing row must agree; the SDK always
			// requires the explicit tenant/project/Session/run scope in run.json.
			const session = await sessions.store.getSession(sessionId, sessions.tenantId)
			if (session && session.projectId !== sessions.projectId)
				throw new Error('Attempt Session belongs to a different project.')
			signal?.throwIfAborted()
			const runDir = join(paths.sessionDir(sessions.projectId, sessionId), 'runs', start.runId)
			const indexDir = join(runDir, 'evidence-index')
			return createDiskRunEvidenceSource({
				scope: {
					tenantId: sessions.tenantId,
					projectId: sessions.projectId,
					sessionId,
					runId: start.runId,
				},
				runDir,
				indexDir,
			})
		},
	})
}
