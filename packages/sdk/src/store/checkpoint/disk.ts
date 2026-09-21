import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { SessionLocator, SessionPaths } from '../../session/paths.js'
import type { CheckpointId } from '../../types/ids/index.js'
import type { Checkpoint } from '../../types/session/checkpoint.js'
import { syncDirectory, temporaryPathFor } from '../../utils/atomic-write.js'
import { asCheckpointId, isEntityId } from '../../utils/id.js'
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
import { compareCheckpoints, selectSessionCheckpointsToPrune } from './prune.js'

export interface DiskSessionCheckpointStoreOptions {
	/** The project whose sessions hold the checkpoints. */
	readonly paths: SessionPaths
	/** The session log the checkpoints are verified and protected against. */
	readonly log: CheckpointLogView
}

const DOCUMENT = /^(.+)\.json$/

/**
 * {@link SessionCheckpointStore} at `<session-dir>/checkpoints/<id>.json`.
 *
 * A write is durable before it resolves: the document is written to a private
 * sidecar, fsynced, linked to its final name (which fails rather than
 * replacing an existing document), and the directory is fsynced. The caller
 * appends `checkpoint_written` only after that, so the record never names a
 * file a power loss could take back.
 *
 * Directories are mode 0700 and documents 0600.
 */
export class DiskSessionCheckpointStore implements SessionCheckpointStore {
	readonly #paths: SessionPaths
	readonly #log: CheckpointLogView

	constructor(options: DiskSessionCheckpointStoreOptions) {
		this.#paths = options.paths
		this.#log = options.log
	}

	#locator(scope: CheckpointScope): SessionLocator {
		return {
			sessionId: scope.sessionId,
			...(scope.ancestors === undefined ? {} : { ancestors: scope.ancestors }),
		}
	}

	async write(scope: CheckpointScope, checkpoint: Checkpoint): Promise<CheckpointWriteReceipt> {
		const checked = validateCheckpointScope(scope)
		const document = checkWriteOwner(checked, checkpoint)
		const locator = this.#locator(checked)
		const directory = this.#paths.checkpoints(locator)
		const path = this.#paths.checkpointFile(locator, document.checkpointId)
		const text = serializeCheckpoint(document)
		await mkdir(directory, { recursive: true, mode: 0o700 })
		const temporary = temporaryPathFor(path)
		let handle: FileHandle | undefined
		try {
			handle = await open(temporary, 'wx', 0o600)
			await handle.writeFile(text, 'utf8')
			await handle.sync()
			await handle.close()
			handle = undefined
			// `link` publishes atomically and, unlike `rename`, refuses an existing target.
			await link(temporary, path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
				throw new Error(
					`Checkpoint ${document.checkpointId} already exists; a checkpoint is never replaced.`,
				)
			}
			throw error
		} finally {
			await handle?.close().catch(() => undefined)
			await unlink(temporary).catch(() => undefined)
		}
		await syncDirectory(directory)
		return writeReceipt(document, text)
	}

	async read(scope: CheckpointScope, checkpointId: CheckpointId): Promise<Checkpoint | null> {
		return (await this.#readText(scope, checkpointId))?.checkpoint ?? null
	}

	async restore(scope: CheckpointScope, checkpointId: CheckpointId): Promise<Checkpoint | null> {
		const found = await this.#readText(scope, checkpointId)
		if (!found) return null
		return verifyCheckpoint(this.#log, validateCheckpointScope(scope), found.checkpoint, found.text)
	}

	async #readText(
		scope: CheckpointScope,
		checkpointId: CheckpointId,
	): Promise<{ checkpoint: Checkpoint; text: string } | null> {
		const checked = validateCheckpointScope(scope)
		const id = asCheckpointId(checkpointId)
		const text = await readIfPresent(this.#paths.checkpointFile(this.#locator(checked), id))
		if (text === null) return null
		const checkpoint = parseStoredCheckpoint(text, checked, id)
		// Another turn's checkpoint in the same session directory is not this turn's.
		return checkpoint.turnId === checked.turnId ? { checkpoint, text } : null
	}

	async list(scope: CheckpointScope): Promise<Checkpoint[]> {
		const checked = validateCheckpointScope(scope)
		const locator = this.#locator(checked)
		let names: string[]
		try {
			names = await readdir(this.#paths.checkpoints(locator))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
			throw error
		}
		const checkpoints: Checkpoint[] = []
		for (const name of names) {
			// Sidecars (`<id>.json.<pid>.<n>.<hex>.tmp`) and strangers are not documents.
			const id = DOCUMENT.exec(name)?.[1]
			if (id === undefined || !isEntityId(id, 'checkpoint')) continue
			const text = await readIfPresent(this.#paths.checkpointFile(locator, id))
			// Deleted between the listing and the read: a concurrent prune, not damage.
			if (text === null) continue
			const checkpoint = parseStoredCheckpoint(text, checked, id)
			if (checkpoint.turnId === checked.turnId) checkpoints.push(checkpoint)
		}
		return checkpoints.sort(compareCheckpoints)
	}

	async delete(scope: CheckpointScope, checkpointId: CheckpointId): Promise<void> {
		const checked = validateCheckpointScope(scope)
		const id = asCheckpointId(checkpointId)
		// Only this turn's checkpoint: a scope must not reach into another turn.
		if (!(await this.read(checked, id))) return
		try {
			await unlink(this.#paths.checkpointFile(this.#locator(checked), id))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
	}

	async prune(scope: CheckpointScope, keepLast: number): Promise<CheckpointId[]> {
		const checked = validateCheckpointScope(scope)
		const doomed = selectSessionCheckpointsToPrune(
			await this.list(checked),
			keepLast,
			new Set(await this.#log.openDecisionCheckpoints(checked)),
		)
		for (const id of doomed) await this.delete(checked, id)
		return doomed
	}
}

async function readIfPresent(path: string): Promise<string | null> {
	try {
		return await readFile(path, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
}
