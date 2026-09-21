import type { CheckpointId } from '../../types/ids/index.js'
import type { Checkpoint } from '../../types/session/checkpoint.js'
import { asCheckpointId } from '../../utils/id.js'
import {
	type CheckpointLogView,
	type CheckpointScope,
	type CheckpointWriteReceipt,
	type SessionCheckpointStore,
	checkWriteOwner,
	parseStoredCheckpoint,
	serializeCheckpoint,
	validateCheckpointScope,
	verifyCheckpoint,
	writeReceipt,
} from './contract.js'
import { compareCheckpoints, selectStoredCheckpointsToPrune } from './prune.js'

export interface InMemorySessionCheckpointStoreOptions {
	/** The session log the checkpoints are verified and protected against. */
	readonly log: CheckpointLogView
}

/**
 * Process-local {@link SessionCheckpointStore}, keyed by the full
 * tenant/project/session/turn scope.
 *
 * It keeps the serialised bytes rather than the object, so `restore` hashes
 * exactly what `write` hashed and refuses exactly what the disk store
 * refuses. It is the parity partner of the disk store and the store an
 * in-memory session keeps its checkpoints in.
 */
export class InMemorySessionCheckpointStore implements SessionCheckpointStore {
	readonly #log: CheckpointLogView
	/** `tenant/project/session` → checkpoint id → stored text. */
	readonly #sessions = new Map<string, Map<CheckpointId, string>>()

	constructor(options: InMemorySessionCheckpointStoreOptions) {
		this.#log = options.log
	}

	#documents(scope: CheckpointScope): Map<CheckpointId, string> | undefined {
		const checked = validateCheckpointScope(scope)
		return this.#sessions.get([checked.tenantId, checked.projectId, checked.sessionId].join('/'))
	}

	async write(scope: CheckpointScope, checkpoint: Checkpoint): Promise<CheckpointWriteReceipt> {
		const checked = validateCheckpointScope(scope)
		const document = checkWriteOwner(checked, checkpoint)
		const key = [checked.tenantId, checked.projectId, checked.sessionId].join('/')
		let documents = this.#sessions.get(key)
		if (!documents) {
			documents = new Map()
			this.#sessions.set(key, documents)
		}
		if (documents.has(document.checkpointId)) {
			throw new Error(
				`Checkpoint ${document.checkpointId} already exists; a checkpoint is never replaced.`,
			)
		}
		const text = serializeCheckpoint(document)
		documents.set(document.checkpointId, text)
		return writeReceipt(document, text)
	}

	async read(scope: CheckpointScope, checkpointId: CheckpointId): Promise<Checkpoint | null> {
		return (await this.#readText(scope, checkpointId))?.checkpoint ?? null
	}

	async restore(scope: CheckpointScope, checkpointId: CheckpointId): Promise<Checkpoint | null> {
		const found = await this.#readText(scope, checkpointId)
		if (!found) return null
		return verifyCheckpoint(this.#log, scope, found.checkpoint, found.text)
	}

	async #readText(
		scope: CheckpointScope,
		checkpointId: CheckpointId,
	): Promise<{ checkpoint: Checkpoint; text: string } | null> {
		const id = asCheckpointId(checkpointId)
		const text = this.#documents(scope)?.get(id)
		if (text === undefined) return null
		const checkpoint = parseStoredCheckpoint(text, scope, id)
		// Another turn's checkpoint is not this turn's: absent, as the disk store answers.
		return checkpoint.turnId === scope.turnId ? { checkpoint, text } : null
	}

	async list(scope: CheckpointScope): Promise<Checkpoint[]> {
		const documents = this.#documents(scope)
		if (!documents) return []
		return [...documents]
			.map(([id, text]) => parseStoredCheckpoint(text, scope, id))
			.filter((checkpoint) => checkpoint.turnId === scope.turnId)
			.sort(compareCheckpoints)
	}

	async delete(scope: CheckpointScope, checkpointId: CheckpointId): Promise<void> {
		const id = asCheckpointId(checkpointId)
		if (await this.read(scope, id)) this.#documents(scope)?.delete(id)
	}

	async prune(scope: CheckpointScope, keepLast: number): Promise<CheckpointId[]> {
		const checked = validateCheckpointScope(scope)
		const doomed = await selectStoredCheckpointsToPrune(
			this.#log,
			checked,
			await this.list(checked),
			keepLast,
		)
		for (const id of doomed) await this.delete(checked, id)
		return doomed
	}
}
