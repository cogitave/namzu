import { createHash } from 'node:crypto'
import type { CheckpointId, SessionId, TenantId, TurnId } from '../../types/ids/index.js'
import { type Checkpoint, parseCheckpoint } from '../../types/session/checkpoint.js'
import type { ProjectId } from '../../types/session/ids.js'
import { asCheckpointId, asProjectId, asSessionId, asTenantId, asTurnId } from '../../utils/id.js'

/**
 * The turn whose checkpoints are addressed.
 *
 * A checkpoint belongs to one turn of one session. Tenant and project are
 * part of the key so a shared backend can enforce isolation; the built-in
 * disk store is rooted in one project of one tenant's `NAMZU_HOME` and
 * addresses by session only.
 */
export interface CheckpointScope {
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly sessionId: SessionId
	readonly turnId: TurnId
	/**
	 * The session's ancestors, root first, when it is a child session. A
	 * layout hint only: the disk store nests a child's directory under
	 * `<parent>/subagents/`, and a store keyed by id ignores it.
	 */
	readonly ancestors?: readonly SessionId[]
}

/**
 * What a write hands back: exactly the payload of the `checkpoint_written`
 * record the caller appends next. The document is on disk before this
 * resolves, so the record never names a file that is not there.
 */
export interface CheckpointWriteReceipt {
	readonly checkpointId: CheckpointId
	readonly iteration: number
	readonly throughSeq: number
	readonly throughSha256: string
	/** Relative to the session directory: `checkpoints/<id>.json`. */
	readonly path: string
	/** SHA-256 (lowercase hex) of the document's stored bytes. */
	readonly docSha256: string
}

/**
 * What a checkpoint store needs from the session log, injected so the store
 * does not depend on one log implementation.
 *
 * Every member answers from the log of `scope.sessionId`.
 */
export interface CheckpointLogView {
	/**
	 * True when the record at `throughSeq` exists and hashes to
	 * `throughSha256`. A checkpoint's context is the fold of the log through
	 * that seq, so a log truncated or edited below it restores a context the
	 * checkpoint never saw.
	 */
	verifyThrough(scope: CheckpointScope, throughSeq: number, throughSha256: string): Promise<boolean>
	/** `docSha256` of the `checkpoint_written` record for `checkpointId`, or null when there is none. */
	writtenDocSha256(scope: CheckpointScope, checkpointId: CheckpointId): Promise<string | null>
	/**
	 * Checkpoints named by a `decision_requested` record that has no
	 * `decision_resolved` or `decision_expired` yet. `prune` never deletes one.
	 */
	openDecisionCheckpoints(scope: CheckpointScope): Promise<Iterable<CheckpointId>>
}

/** Why a restore refused a checkpoint. */
export type CheckpointRefusalReason =
	/** No `checkpoint_written` record names it: it was never committed to the log. */
	| 'not-recorded'
	/** The stored bytes do not hash to the record's `docSha256`. */
	| 'document-mismatch'
	/** The record at `throughSeq` is missing or does not hash to `throughSha256`. */
	| 'through-mismatch'

/** A checkpoint that exists but cannot be trusted to restore the turn it describes. */
export class CheckpointIntegrityError extends Error {
	override readonly name = 'CheckpointIntegrityError'
	constructor(
		readonly checkpointId: CheckpointId,
		readonly reason: CheckpointRefusalReason,
	) {
		super(`Refusing checkpoint ${checkpointId}: ${REASONS[reason]}`)
	}
}

const REASONS: Record<CheckpointRefusalReason, string> = {
	'not-recorded': 'no checkpoint_written record names it in the session log.',
	'document-mismatch':
		'its stored bytes do not match the docSha256 of its checkpoint_written record.',
	'through-mismatch':
		'the session log record it was taken through is missing or no longer matches throughSha256.',
}

/**
 * Checkpoint persistence for one project: documents under
 * `<session-id>/checkpoints/`, addressed by turn.
 *
 * Reads return `null` or an empty list when nothing exists; `delete` of an
 * absent checkpoint is a no-op. A write never replaces an existing document:
 * the log records the hash of the bytes first written, and a replacement
 * would make that record lie.
 *
 * Writes are not fenced here. The document is inert until its
 * `checkpoint_written` record is appended, and that append is what the
 * session lease fences; a stale writer's document is refused on restore as
 * `not-recorded`.
 */
export interface SessionCheckpointStore {
	/** Persist a new checkpoint of `scope.turnId` and return the record payload that commits it. */
	write(scope: CheckpointScope, checkpoint: Checkpoint): Promise<CheckpointWriteReceipt>
	/** Read one of the turn's checkpoints without checking it against the log. */
	read(scope: CheckpointScope, checkpointId: CheckpointId): Promise<Checkpoint | null>
	/**
	 * Read one of the turn's checkpoints for a resume: refused with
	 * {@link CheckpointIntegrityError} unless its record exists, its bytes
	 * hash to the record's `docSha256`, and the log still holds the record it
	 * was taken through.
	 */
	restore(scope: CheckpointScope, checkpointId: CheckpointId): Promise<Checkpoint | null>
	/** The turn's checkpoints, oldest first (`createdAt`, then id). */
	list(scope: CheckpointScope): Promise<Checkpoint[]>
	delete(scope: CheckpointScope, checkpointId: CheckpointId): Promise<void>
	/**
	 * Delete the turn's oldest committed checkpoints until `keepLast` newer
	 * committed ones remain, never one an open decision references. Only a
	 * checkpoint a `checkpoint_written` record names is counted or deleted: a
	 * document no record commits is inert and left alone, so it can never
	 * stand in for the turn's resume point. Returns the deleted ids, oldest
	 * first, for the `checkpoint_pruned` record (none: append nothing).
	 */
	prune(scope: CheckpointScope, keepLast: number): Promise<CheckpointId[]>
}

/** Validate every id of a scope, so none can reach a path or a key unchecked. */
export function validateCheckpointScope(scope: CheckpointScope): CheckpointScope {
	return {
		tenantId: asTenantId(scope.tenantId),
		projectId: asProjectId(scope.projectId),
		sessionId: asSessionId(scope.sessionId),
		turnId: asTurnId(scope.turnId),
		...(scope.ancestors === undefined ? {} : { ancestors: scope.ancestors.map(asSessionId) }),
	}
}

/** The one serialisation every store writes and hashes. */
export function serializeCheckpoint(checkpoint: Checkpoint): string {
	return `${JSON.stringify(checkpoint)}\n`
}

export function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The record `path` of a checkpoint, relative to its session directory. */
export function checkpointRecordPath(checkpointId: CheckpointId): string {
	return `checkpoints/${asCheckpointId(checkpointId)}.json`
}

/**
 * Parse a document and check it belongs where it was found: a document
 * whose session or id differs from its address is damage, not a miss.
 */
export function parseStoredCheckpoint(
	text: string,
	scope: CheckpointScope,
	checkpointId: CheckpointId,
): Checkpoint {
	const checkpoint = parseCheckpoint(JSON.parse(text))
	if (checkpoint.sessionId !== scope.sessionId || checkpoint.checkpointId !== checkpointId) {
		throw new CheckpointOwnerError(
			`Checkpoint document ${checkpointId} names session ${checkpoint.sessionId} and id ${checkpoint.checkpointId}; it is stored under session ${scope.sessionId}.`,
		)
	}
	return checkpoint
}

/** A checkpoint document stored under an address it does not name, or written for another scope. */
export class CheckpointOwnerError extends Error {
	override readonly name = 'CheckpointOwnerError'
}

/** Refuse a write whose document names another session or turn than its scope. */
export function checkWriteOwner(scope: CheckpointScope, checkpoint: Checkpoint): Checkpoint {
	const parsed = parseCheckpoint(checkpoint)
	if (parsed.sessionId !== scope.sessionId || parsed.turnId !== scope.turnId) {
		throw new CheckpointOwnerError(
			`Checkpoint ${parsed.checkpointId} belongs to session ${parsed.sessionId} turn ${parsed.turnId}; it cannot be written under session ${scope.sessionId} turn ${scope.turnId}.`,
		)
	}
	return parsed
}

/** Build the receipt a successful write returns. */
export function writeReceipt(checkpoint: Checkpoint, text: string): CheckpointWriteReceipt {
	return {
		checkpointId: checkpoint.checkpointId,
		iteration: checkpoint.iteration,
		throughSeq: checkpoint.throughSeq,
		throughSha256: checkpoint.throughSha256,
		path: checkpointRecordPath(checkpoint.checkpointId),
		docSha256: sha256Hex(text),
	}
}

/**
 * The restore rule, shared by every store: the checkpoint's bytes must be
 * the ones its record committed, and the log prefix it covers must be intact.
 */
export async function verifyCheckpoint(
	log: CheckpointLogView,
	scope: CheckpointScope,
	checkpoint: Checkpoint,
	text: string,
): Promise<Checkpoint> {
	const recorded = await log.writtenDocSha256(scope, checkpoint.checkpointId)
	if (recorded === null) throw new CheckpointIntegrityError(checkpoint.checkpointId, 'not-recorded')
	if (recorded !== sha256Hex(text)) {
		throw new CheckpointIntegrityError(checkpoint.checkpointId, 'document-mismatch')
	}
	if (!(await log.verifyThrough(scope, checkpoint.throughSeq, checkpoint.throughSha256))) {
		throw new CheckpointIntegrityError(checkpoint.checkpointId, 'through-mismatch')
	}
	return checkpoint
}
