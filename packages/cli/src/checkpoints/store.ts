/**
 * File history: the state of every file the model changed, before AND after
 * it changed it, per turn, kept on disk with the conversation it belongs to.
 *
 * Not git. The tool wrapper records a file immediately before an `edit` or
 * `write` runs, whatever the repository's state, and once more when the call
 * has settled; absence is recorded too, so a file the model created can be
 * taken away again. A turn is a manifest keyed by the journal's `TurnId`
 * (`<root>/turns/<turnId>.json`), its file bodies are content-addressed
 * blobs (`<root>/blobs/<sha256>`), and both are written temp-and-rename, so
 * the history survives the session, the process and a crash. Closing a
 * session releases memory and deletes nothing: history ends with the
 * conversation (`dispose`), by age, or by the size cap — never by a quit.
 *
 * Undoing a turn is a plan (`undo-plan.ts`) over these manifests and the
 * disk. It writes a file only while the disk still holds what the turn left
 * there; everything else is reported, not overwritten.
 */

import { randomUUID } from 'node:crypto'
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
	type BlobRef,
	BlobUnavailableError,
	type Manifest,
	type ManifestEntry,
	type SkipReason,
	type TurnStatus,
	blobExists,
	hashBytes,
	hashFile,
	isSafeTurnId,
	listBlobs,
	putBlob,
	readBlob,
	readManifests,
	referencedBlobs,
	removeBlob,
	removeManifest,
	shareBlob,
	writeManifest,
} from './manifest.js'
import {
	type ConflictReason,
	type DiskState,
	type PlanEntry,
	type PlanFile,
	type PlanInput,
	type PlanTurn,
	type UndoPlan,
	diskToken,
	planUndo,
} from './undo-plan.js'

export type { SkipReason, TurnStatus } from './manifest.js'
export type { ConflictReason, PlanAction, PlanFile, UndoPlan } from './undo-plan.js'

export interface CheckpointTurn {
	/** 1-based, in the order turns first recorded a change in this conversation. */
	readonly index: number
	readonly turnId: string
	/** The prompt that started the turn, cut to a line. */
	readonly label: string
	readonly startedAt: number
	readonly status: TurnStatus
	/** Host paths changed in this turn, first change first. */
	readonly files: readonly string[]
}

export interface SkippedPath {
	readonly path: string
	readonly reason: SkipReason
	/** The turn that was running when the path was skipped. */
	readonly turn: number
}

export type SnapshotResult = 'recorded' | 'already' | 'outside' | 'too-large'

export interface RestoreConflict {
	readonly path: string
	/** The turn (as `/restore` numbers it) whose change was left in place. */
	readonly turn: number
	readonly reason: ConflictReason
}

export interface RestoreReport {
	readonly turn: number
	/** Files written back to their pre-turn content. */
	readonly restored: readonly string[]
	/** Files removed because they did not exist before the turn. */
	readonly removed: readonly string[]
	/** Files left as they are, because putting them back could lose something. */
	readonly conflicts: readonly RestoreConflict[]
	/** Files whose write failed; they were left as they were. */
	readonly failed: readonly string[]
	/** Files the undone turns changed that no history covers. */
	readonly notCovered: readonly { path: string; reason: SkipReason }[]
	/** An undone turn also ran shell commands, which `/restore` cannot reverse. */
	readonly uncoveredShell: boolean
	/** Turns that were fully undone, newest first. */
	readonly undoneTurns: readonly number[]
	/** Turns some of whose files were left in place. They stay listed. */
	readonly partialTurns: readonly number[]
}

/** Which call a snapshot is for. All optional: a bare path still records. */
export interface SnapshotMeta {
	/** The journal turn the tool call belongs to. */
	readonly turnId?: string
	readonly tool?: string
	readonly toolUseId?: string
}

/** What a reply's undo stands at, from the manifests alone. */
export type TurnUndoState = TurnStatus | 'none' | 'expired'

export interface TurnUndoStatus {
	readonly turnId: string
	readonly status: TurnUndoState
	/** Files the reply changed that a history covers. */
	readonly files: number
	/** Of those, files the reply created. */
	readonly added: number
	/** Of those, files the reply deleted. */
	readonly removed: number
	readonly uncoveredShell: boolean
	readonly skipped: readonly { path: string; reason: SkipReason }[]
}

export type UndoFileResult = 'restored' | 'removed' | 'skipped' | 'failed' | 'noop'

export interface UndoPreview {
	readonly turnId: string
	readonly status: TurnStatus
	readonly planToken: string
	readonly files: readonly PlanFile[]
	readonly skipped: readonly { path: string; reason: SkipReason }[]
	readonly uncoveredShell: boolean
	/** Later replies that changed files this turn changed. */
	readonly laterTurnsOnSameFiles: readonly string[]
}

export interface UndoOptions {
	/** From the preview the operator saw. A different plan is refused, not applied. */
	readonly planToken: string
	readonly alsoUndoLater?: boolean
	/**
	 * Per path. A conflict is skipped unless it is `keep_copy`: the file as it
	 * is now is saved first, then the turn's version goes back.
	 */
	readonly resolutions?: Readonly<Record<string, 'skip' | 'keep_copy'>>
	readonly by?: string
}

export type UndoOutcome =
	| {
			readonly kind: 'applied'
			readonly turnId: string
			readonly status: TurnStatus
			/** The target turn's files. */
			readonly files: Readonly<Record<string, UndoFileResult>>
			/** Later replies undone along with it. */
			readonly later: Readonly<Record<string, Readonly<Record<string, UndoFileResult>>>>
			/** Files the operator had changed, saved before being replaced. */
			readonly copies: readonly { path: string; sha256: string }[]
			/** Every path that was written or removed: the model's picture of them is stale. */
			readonly changed: readonly string[]
	  }
	| { readonly kind: 'plan-changed'; readonly plan: UndoPreview }

/** Test seams: a fault between planning and writing. Never set in production. */
export interface StoreTestHooks {
	/** Before a step re-reads the disk. A change made here must abort that path. */
	beforeStep?(path: string): void | Promise<void>
	/** After the disk was re-checked, before the write. Throwing is a failed write. */
	beforeWrite?(path: string): void | Promise<void>
}

export interface StoreOptions {
	/** Retention: oldest turns are expired once their bodies exceed this. Default 512 MiB. */
	readonly maxBytes?: number
	/** Retention: a turn expires this long after its last edit. Default 30 days. */
	readonly maxAgeMs?: number
	readonly now?: () => number
	readonly hooks?: StoreTestHooks
}

/** Files larger than this are not snapshotted; the transcript says so. */
export const CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024
export const CHECKPOINT_RETENTION_BYTES = 512 * 1024 * 1024
export const CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const LABEL_CHARS = 72

/** One turn in memory: its manifest, and where that lives. */
interface Rec {
	readonly m: Manifest
	/** Fixed by the first write; undefined while the turn has recorded nothing. */
	root: string | undefined
}

interface History {
	readonly root: string
	/** In seq order. */
	readonly recs: Rec[]
	nextSeq: number
}

export class FileCheckpointStore {
	private readonly histories = new Map<string, Promise<History>>()
	/** The same histories once loaded, for the synchronous readers. */
	private readonly ready = new Map<string, History>()
	private readonly byId = new Map<string, Rec>()
	private readonly tails = new Map<string, Promise<unknown>>()
	private current: Rec | undefined
	private readonly now: () => number
	private readonly maxBytes: number
	private readonly maxAgeMs: number

	constructor(
		/**
		 * Where history goes: the session's `file-history/` (`SessionPaths.fileHistory`).
		 * A function is read at each turn's first write, so a store that
		 * outlives a conversation switch (`/resume`, `/new`) writes into the
		 * conversation the turn belongs to, not the one the process started in.
		 */
		private readonly root: string | (() => string),
		/** Only files under here are covered. */
		private readonly cwd: string,
		private readonly options: StoreOptions = {},
	) {
		this.now = options.now ?? Date.now
		this.maxBytes = options.maxBytes ?? CHECKPOINT_RETENTION_BYTES
		this.maxAgeMs = options.maxAgeMs ?? CHECKPOINT_RETENTION_MS
	}

	// -- ordering ---------------------------------------------------------------

	/** One operation at a time per conversation: a snapshot must not land mid-undo. */
	private locked<T>(root: string, fn: () => Promise<T>): Promise<T> {
		const tail = this.tails.get(root) ?? Promise.resolve()
		const run = tail.then(
			() => fn(),
			() => fn(),
		)
		this.tails.set(
			root,
			run.catch(() => undefined),
		)
		return run
	}

	private currentRoot(): string {
		return typeof this.root === 'function' ? this.root() : this.root
	}

	// -- paths ------------------------------------------------------------------

	private realCwdPromise: Promise<string> | undefined

	private realCwd(): Promise<string> {
		this.realCwdPromise ??= realExisting(resolve(this.cwd)).catch(() => resolve(this.cwd))
		return this.realCwdPromise
	}

	/**
	 * The file a path really is, symlinks resolved, or null when that lies
	 * outside the project. Entries are keyed by it: an edit written through
	 * a link changes the target, so that is what an undo must put back,
	 * and a link is never replaced by a regular file.
	 */
	private async canonical(path: string): Promise<string | null> {
		const link = await lstat(path).then(
			(s) => s.isSymbolicLink(),
			() => false,
		)
		// A dangling link throws here: there is nothing safe to record.
		const real = link ? await realpath(path) : await realExisting(path)
		return this.insideReal(real, await this.realCwd()) ? real : null
	}

	private insideReal(real: string, root: string): boolean {
		const rel = relative(root, real)
		return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
	}

	/** Whether a host path is one this store would cover. */
	covers(hostPath: string): boolean {
		const rel = relative(this.cwd, resolve(this.cwd, hostPath))
		return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
	}

	// -- turns ------------------------------------------------------------------

	/**
	 * The next tool writes belong to this turn. `turnId` is the journal's own;
	 * a caller with none (a test, a host command) gets a generated one.
	 * Returns the id.
	 */
	beginTurn(label: string, turnId?: string): string {
		const known = turnId === undefined ? undefined : this.byId.get(turnId)
		if (known) {
			this.current = known
			return known.m.turnId
		}
		const id = turnId ?? randomUUID()
		if (!isSafeTurnId(id)) throw new Error(`Cannot keep file history for turn id ${id}.`)
		this.current = this.newRec(id, firstLine(label).slice(0, LABEL_CHARS))
		return id
	}

	private newRec(turnId: string, label: string): Rec {
		const at = this.now()
		const rec: Rec = {
			m: {
				version: 1,
				turnId,
				seq: 0,
				label,
				startedAt: at,
				lastEditAt: at,
				status: 'applied',
				entries: [],
				skipped: [],
				uncoveredShell: false,
			},
			root: undefined,
		}
		this.byId.set(turnId, rec)
		return rec
	}

	/** The turn a write belongs to. Under the lock, after the history is loaded. */
	private resolveRec(turnId: string | undefined): Rec {
		if (turnId !== undefined) {
			// A resumed stream's turn, or one from before a restart, is its own turn:
			// it is never folded into whichever prompt began last.
			return this.byId.get(turnId) ?? this.newRec(turnId, '')
		}
		if (this.current) return this.current
		// A write outside any turn — a host command, say — gets a turn of its own.
		this.current = this.newRec(randomUUID(), '(outside a turn)')
		return this.current
	}

	private rootOf(turnId: string | undefined): string {
		const known = turnId !== undefined ? this.byId.get(turnId) : this.current
		return known?.root ?? this.currentRoot()
	}

	// -- loading, reconciliation, retention ------------------------------------

	/**
	 * Read this conversation's history, settle what a crash left half-done, and
	 * expire what retention says is old. Idempotent; the first call does the work.
	 */
	open(): Promise<void> {
		const root = this.currentRoot()
		return this.locked(root, async () => {
			await this.load(root)
		})
	}

	/** Call under `locked(root)`. */
	private load(root: string): Promise<History> {
		let loading = this.histories.get(root)
		if (!loading) {
			loading = this.read(root)
			this.histories.set(root, loading)
			loading.then(
				(h) => this.ready.set(root, h),
				() => this.histories.delete(root),
			)
		}
		return loading
	}

	private async read(root: string): Promise<History> {
		const { manifests, unreadable } = await readManifests(root)
		const recs: Rec[] = []
		for (const m of manifests.sort((a, b) => a.seq - b.seq)) {
			const rec: Rec = { m, root }
			recs.push(rec)
			this.byId.set(m.turnId, rec)
		}
		const history: History = {
			root,
			recs,
			nextSeq: recs.reduce((max, r) => Math.max(max, r.m.seq), 0) + 1,
		}
		await this.reconcile(history)
		await this.sweep(history, unreadable.length === 0)
		return history
	}

	/**
	 * A crash can leave an entry `pending`: the before body is saved, the call
	 * may or may not have written. The disk decides — still the before state
	 * means nothing happened and the entry goes; anything else is the result.
	 */
	private async reconcile(history: History): Promise<void> {
		for (const rec of history.recs) {
			let changed = false
			for (const entry of [...rec.m.entries]) {
				if (entry.state !== 'pending') continue
				const now = await this.capture(history.root, entry.path, true)
				if (sameContent(now, entry.before)) {
					rec.m.entries.splice(rec.m.entries.indexOf(entry), 1)
				} else {
					entry.after = now
					entry.state = 'done'
				}
				changed = true
			}
			if (changed) await writeManifest(history.root, rec.m)
		}
	}

	/** Expire by age, then by size, oldest first; then drop bodies nothing names. */
	private async sweep(history: History, collectOrphans: boolean): Promise<void> {
		const now = this.now()
		const live = () => history.recs.filter((r) => !r.m.pruned)
		for (const rec of [...history.recs]) {
			if (rec.m.pruned || now - rec.m.lastEditAt <= this.maxAgeMs) continue
			await this.expire(history, rec)
		}
		const blobs = await listBlobs(history.root)
		const total = () => {
			const named = new Set<string>()
			for (const r of live()) for (const sha of referencedBlobs(r.m)) named.add(sha)
			let sum = 0
			for (const sha of named) sum += blobs.get(sha) ?? 0
			return sum
		}
		while (total() > this.maxBytes) {
			const oldest = live().find((r) => r.m.entries.length > 0)
			if (!oldest) break
			await this.expire(history, oldest)
		}
		// A manifest this reader cannot parse (a newer version, a damaged file) may
		// still name bodies: with one present, nothing is judged an orphan.
		if (!collectOrphans) return
		const named = new Set<string>()
		for (const r of history.recs) for (const sha of referencedBlobs(r.m)) named.add(sha)
		for (const sha of blobs.keys()) if (!named.has(sha)) await removeBlob(history.root, sha)
	}

	private async expire(history: History, rec: Rec): Promise<void> {
		if (rec.m.entries.length === 0) {
			// Nothing to undo and nothing to say "expired" about.
			await removeManifest(history.root, rec.m.turnId)
			history.recs.splice(history.recs.indexOf(rec), 1)
			this.byId.delete(rec.m.turnId)
			return
		}
		rec.m.pruned = true
		await writeManifest(history.root, rec.m)
	}

	private async persist(history: History, rec: Rec): Promise<void> {
		// A reply that kept going after being undone has changes the undo never saw.
		if (rec.m.status === 'undone' && rec.m.entries.some((e) => e.state === 'pending')) {
			rec.m.status = 'partially_undone'
		}
		if (rec.m.seq === 0) {
			rec.m.seq = history.nextSeq++
			rec.root = history.root
			history.recs.push(rec)
		}
		await writeManifest(history.root, rec.m)
	}

	/** Bodies no entry names any more, other than `except`'s own. */
	private async collect(history: History, shas: readonly (string | undefined)[]): Promise<void> {
		const named = new Set<string>()
		for (const r of history.recs) for (const sha of referencedBlobs(r.m)) named.add(sha)
		for (const sha of shas) if (sha && !named.has(sha)) await removeBlob(history.root, sha)
	}

	/**
	 * The file's state as a ref. With `keep`, a body within the cap is saved;
	 * a larger one is identified by its hash alone.
	 */
	private async capture(root: string, path: string, keep: boolean): Promise<BlobRef | null> {
		let st: Awaited<ReturnType<typeof stat>>
		try {
			st = await stat(path)
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw err
		}
		const mode = st.mode & 0o7777
		if (st.size > CHECKPOINT_MAX_BYTES) {
			return { sha256: await hashFile(path), size: st.size, mode, stored: false }
		}
		let data: Buffer
		try {
			data = await readFile(path)
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw err
		}
		const sha256 = keep ? await putBlob(root, data) : hashBytes(data)
		return { sha256, size: data.byteLength, mode }
	}

	// -- recording --------------------------------------------------------------

	/**
	 * Record the file's current content before it changes. Once per path per
	 * turn: the first snapshot is the pre-turn state, and a second edit to the
	 * same file within a turn must not overwrite it.
	 */
	snapshot(hostPath: string, meta: SnapshotMeta = {}): Promise<SnapshotResult> {
		const root = this.rootOf(meta.turnId)
		return this.locked(root, async () => {
			const history = await this.load(root)
			return this.snapshotNow(history, this.resolveRec(meta.turnId), hostPath, meta)
		})
	}

	private async snapshotNow(
		history: History,
		rec: Rec,
		hostPath: string,
		meta: SnapshotMeta,
	): Promise<SnapshotResult> {
		const lexical = resolve(this.cwd, hostPath)
		if (!this.covers(lexical)) {
			await this.skipNow(history, rec, lexical, 'outside-cwd')
			return 'outside'
		}
		const path = await this.canonical(lexical)
		if (path === null) {
			await this.skipNow(history, rec, lexical, 'outside-cwd')
			return 'outside'
		}
		const existing = rec.m.entries.find((e) => sameFile(e.path, path))
		if (existing) {
			// Another write to a file this turn already changed: the entry is in
			// flight again until `settle` records where it ended.
			existing.state = 'pending'
			await this.persist(history, rec)
			return 'already'
		}
		const size = await stat(path).then(
			(s) => s.size,
			(err: NodeJS.ErrnoException) => {
				if (err.code === 'ENOENT') return null
				throw err
			},
		)
		if (size !== null && size > CHECKPOINT_MAX_BYTES) {
			await this.skipNow(history, rec, path, 'too-large')
			return 'too-large'
		}
		// The body is saved before the manifest names it: a manifest never points at nothing.
		const before = await this.capture(history.root, path, true)
		rec.m.entries.push({
			path,
			rel: relative(await this.realCwd(), path),
			root: 'cwd',
			before,
			after: null,
			tool: meta.tool ?? '',
			toolUseId: meta.toolUseId ?? '',
			state: 'pending',
		})
		rec.m.lastEditAt = this.now()
		await this.persist(history, rec)
		return 'recorded'
	}

	/**
	 * The call has settled: record where the file ended up. A failed call that
	 * left the file as it found it takes its entry back; one that changed it,
	 * even halfway, keeps it, because the undo is then real.
	 */
	settle(
		hostPath: string,
		outcome: { ok: boolean; first: boolean; turnId?: string },
	): Promise<void> {
		const root = this.rootOf(outcome.turnId)
		return this.locked(root, async () => {
			const history = await this.load(root)
			const rec = outcome.turnId !== undefined ? this.byId.get(outcome.turnId) : this.current
			if (!rec || rec.root === undefined) return
			const lexical = resolve(this.cwd, hostPath)
			const path = (await this.canonical(lexical).catch(() => null)) ?? lexical
			const entry = rec.m.entries.find((e) => sameFile(e.path, path))
			if (!entry) return
			const now = await this.capture(history.root, entry.path, true).catch(() => undefined)
			if (now === undefined) return
			if (!outcome.ok && outcome.first && sameContent(now, entry.before)) {
				rec.m.entries.splice(rec.m.entries.indexOf(entry), 1)
				await this.persist(history, rec)
				await this.collect(history, [entry.before?.sha256])
				return
			}
			entry.after = now
			entry.state = 'done'
			rec.m.lastEditAt = this.now()
			await this.persist(history, rec)
		})
	}

	/** Note a path no history covers. Once per path per reason per turn. */
	recordSkip(hostPath: string, reason: SkipReason, turnId?: string): Promise<void> {
		const root = this.rootOf(turnId)
		return this.locked(root, async () => {
			const history = await this.load(root)
			await this.skipNow(history, this.resolveRec(turnId), resolve(this.cwd, hostPath), reason)
		})
	}

	private async skipNow(
		history: History,
		rec: Rec,
		path: string,
		reason: SkipReason,
	): Promise<void> {
		if (rec.m.skipped.some((s) => sameFile(s.path, path) && s.reason === reason)) return
		rec.m.skipped.push({ path, reason })
		await this.persist(history, rec)
	}

	/**
	 * A shell call ran in this turn: whatever it changed is not covered. Saved
	 * with the turn once the turn has a manifest; until then it rides along.
	 */
	noteShell(turnId?: string): Promise<void> {
		const root = this.rootOf(turnId)
		return this.locked(root, async () => {
			const history = await this.load(root)
			const rec = this.resolveRec(turnId)
			if (rec.m.uncoveredShell) return
			rec.m.uncoveredShell = true
			if (rec.m.seq !== 0) await this.persist(history, rec)
		})
	}

	// -- reading ----------------------------------------------------------------

	private currentHistory(): History | undefined {
		return this.ready.get(this.currentRoot())
	}

	/** Turns of the current conversation that changed at least one file and can still be undone. */
	list(): readonly CheckpointTurn[] {
		const history = this.currentHistory()
		if (!history) return []
		return history.recs
			.filter((r) => !r.m.pruned && r.m.status !== 'undone' && changedEntries(r.m).length > 0)
			.map((r) => ({
				index: r.m.seq,
				turnId: r.m.turnId,
				label: r.m.label,
				startedAt: r.m.startedAt,
				status: r.m.status,
				files: changedEntries(r.m).map((e) => e.path),
			}))
	}

	/**
	 * Where each reply's undo stands. Reads the manifests only, never the disk,
	 * so it is cheap to ask on open. With `turnIds`, one row per id asked for
	 * (`none` for a reply that changed nothing here); without, every reply the
	 * history knows.
	 */
	undoStatus(turnIds?: readonly string[]): Promise<TurnUndoStatus[]> {
		const root = this.currentRoot()
		return this.locked(root, async () => {
			const history = await this.load(root)
			const row = (turnId: string, rec: Rec | undefined): TurnUndoStatus => {
				if (!rec)
					return {
						turnId,
						status: 'none',
						files: 0,
						added: 0,
						removed: 0,
						uncoveredShell: false,
						skipped: [],
					}
				const changed = changedEntries(rec.m)
				const status: TurnUndoState = rec.m.pruned
					? 'expired'
					: changed.length === 0 && rec.m.status === 'applied'
						? 'none'
						: rec.m.status
				return {
					turnId,
					status,
					files: changed.length,
					added: changed.filter((e) => e.before === null).length,
					removed: changed.filter((e) => e.before !== null && e.after === null).length,
					uncoveredShell: rec.m.uncoveredShell,
					skipped: rec.m.skipped,
				}
			}
			if (turnIds)
				return turnIds.map((id) =>
					row(
						id,
						history.recs.find((r) => r.m.turnId === id),
					),
				)
			return history.recs.map((r) => row(r.m.turnId, r))
		})
	}

	/** Paths no history covers, with why: an undo cannot bring them back. */
	skippedPaths(): readonly SkippedPath[] {
		const history = this.currentHistory()
		if (!history) return []
		return history.recs.flatMap((r) =>
			r.m.skipped.map((s) => ({ path: s.path, reason: s.reason, turn: r.m.seq })),
		)
	}

	// -- undo -------------------------------------------------------------------

	/** What undoing `turnId` would do, from the manifests and the disk. Writes nothing. */
	previewUndo(turnId: string, opts: { alsoUndoLater?: boolean } = {}): Promise<UndoPreview> {
		const root = this.rootOf(turnId)
		return this.locked(root, async () => {
			const history = await this.load(root)
			return (await this.plan(history, turnId, opts.alsoUndoLater === true)).preview
		})
	}

	private async plan(history: History, turnId: string, alsoUndoLater: boolean) {
		const target = history.recs.find((r) => r.m.turnId === turnId)
		if (!target) throw new Error(`No file history for turn ${turnId}.`)
		if (target.m.pruned) throw new Error('The undo history for this turn has expired.')
		const turns: PlanTurn[] = []
		const paths = new Set(target.m.entries.map((e) => e.path))
		const touches = (p: string) => [...paths].some((x) => sameFile(x, p))
		for (const r of history.recs) {
			if (r.m.seq < target.m.seq && r !== target) continue
			const entries: PlanEntry[] = []
			for (const e of r.m.entries) {
				if (r !== target && !touches(e.path)) continue
				// A later reply that took this file back already is no longer standing on it.
				if (
					r !== target &&
					r.m.status === 'partially_undone' &&
					r.m.undone?.files.some((p) => sameFile(p, e.path))
				)
					continue
				const beforeMissing =
					e.before !== null &&
					e.before.stored !== false &&
					!(await blobExists(history.root, e.before.sha256))
				entries.push({
					path: e.path,
					rel: e.rel,
					before: e.before,
					after: e.after,
					state: e.state,
					beforeMissing,
				})
			}
			turns.push({
				turnId: r.m.turnId,
				seq: r.m.seq,
				status: r.m.status,
				pruned: r.m.pruned === true,
				entries,
			})
		}
		const disk = new Map<string, DiskState>()
		for (const p of paths) disk.set(p, await this.diskState(p))
		const input: PlanInput = {
			turnId,
			alsoUndoLater,
			turns,
			disk,
			compareMode: process.platform !== 'win32',
		}
		const plan = planUndo(input)
		const preview: UndoPreview = {
			turnId,
			status: target.m.status,
			planToken: plan.planToken,
			files: plan.files,
			skipped: target.m.skipped,
			uncoveredShell: target.m.uncoveredShell,
			laterTurnsOnSameFiles: [
				...new Set(
					turns
						.filter((t) => t.turnId !== turnId && t.seq > target.m.seq && t.status !== 'undone')
						.filter((t) => t.entries.length > 0)
						.map((t) => t.turnId),
				),
			],
		}
		return { plan, preview, target }
	}

	/** What is on disk at a path now, never following a link. */
	private async diskState(path: string): Promise<DiskState> {
		try {
			const parent = await realExisting(dirname(path))
			if (!this.insideReal(join(parent, basename(path)), await this.realCwd())) {
				return { kind: 'outside' }
			}
			const st = await lstat(path)
			if (st.isSymbolicLink()) return { kind: 'symlink' }
			if (!st.isFile()) return { kind: 'other' }
			return { kind: 'file', sha256: await hashFile(path), mode: st.mode & 0o7777 }
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === 'ENOENT') return { kind: 'absent' }
			// An unreadable path, or a file where a directory should be: not ours to touch.
			return { kind: 'other' }
		}
	}

	/**
	 * Take back a turn's changes. Re-plans first and refuses a plan other than
	 * the one the operator saw; then, per file, re-reads the disk right before
	 * writing and leaves a file alone if it moved. Not all-or-nothing: what was
	 * restored, skipped and failed is reported, and a rerun finishes safely.
	 */
	undo(turnId: string, opts: UndoOptions): Promise<UndoOutcome> {
		const root = this.rootOf(turnId)
		return this.locked(root, async () => {
			const history = await this.load(root)
			const alsoUndoLater = opts.alsoUndoLater === true
			const { plan, preview } = await this.plan(history, turnId, alsoUndoLater)
			if (plan.planToken !== opts.planToken) return { kind: 'plan-changed', plan: preview }
			return this.applyPlan(history, plan, opts)
		})
	}

	private async applyPlan(
		history: History,
		plan: UndoPlan,
		opts: UndoOptions,
	): Promise<UndoOutcome> {
		const results = new Map<string, Map<string, UndoFileResult>>()
		const record = (turnId: string, path: string, r: UndoFileResult) => {
			const m = results.get(turnId) ?? new Map<string, UndoFileResult>()
			results.set(turnId, m)
			m.set(path, r)
		}
		const copies: { path: string; sha256: string; size: number; mode: number; at: number }[] = []
		const changed = new Set<string>()
		// A path whose chain stopped: the older steps on it must not run on a disk
		// they were not planned against.
		const stopped = new Set<string>()
		for (const file of plan.files) {
			const rec = history.recs.find((r) => r.m.turnId === file.turnId)
			const entry = rec?.m.entries.find((e) => sameFile(e.path, file.path))
			if (!rec || !entry) continue
			if (stopped.has(fileKey(file.path))) {
				record(file.turnId, file.path, 'skipped')
				continue
			}
			if (file.action === 'noop') {
				record(file.turnId, file.path, 'noop')
				continue
			}
			const forced =
				file.action === 'conflict' &&
				file.reason === 'drifted' &&
				opts.resolutions?.[file.path] === 'keep_copy'
			if (file.action === 'conflict' && !forced) {
				record(file.turnId, file.path, 'skipped')
				stopped.add(fileKey(file.path))
				continue
			}
			try {
				await this.options.hooks?.beforeStep?.(file.path)
				const now = await this.diskState(file.path)
				// A forced step accepts whatever file is there; the expectation is only
				// that it is still the file the operator was shown.
				if (diskToken(now, process.platform !== 'win32') !== file.cur) {
					record(file.turnId, file.path, 'skipped')
					stopped.add(fileKey(file.path))
					continue
				}
				if (forced) {
					if (now.kind === 'file') {
						const body = await readFile(file.path)
						const sha256 = await putBlob(history.root, body)
						const kept = {
							path: file.path,
							sha256,
							size: body.byteLength,
							mode: now.mode,
							at: this.now(),
						}
						copies.push(kept)
						// Named by a manifest before the file is replaced: a crash after the
						// write must not leave the operator's only copy to the orphan sweep.
						const owner = history.recs.find((r) => r.m.turnId === plan.turnId)
						if (owner) {
							owner.m.copies = [...(owner.m.copies ?? []), kept]
							await writeManifest(history.root, owner.m)
						}
					} else if (now.kind !== 'absent') {
						record(file.turnId, file.path, 'skipped')
						stopped.add(fileKey(file.path))
						continue
					}
				}
				const wasCreated = entry.before === null
				// What to write is read, and verified, before anything is touched.
				const body =
					entry.before !== null && entry.before.stored !== false
						? await readBlob(history.root, entry.before.sha256)
						: null
				if (entry.before !== null && body === null)
					throw new BlobUnavailableError(entry.before.sha256, 'not kept')
				await this.options.hooks?.beforeWrite?.(file.path)
				// The blob read above is the slow part: look once more, as close to the write as
				// the filesystem allows, so a file that landed meanwhile is not overwritten.
				const last = await this.diskState(file.path)
				if (
					diskToken(last, process.platform !== 'win32') !==
					diskToken(now, process.platform !== 'win32')
				) {
					record(file.turnId, file.path, 'skipped')
					stopped.add(fileKey(file.path))
					continue
				}
				if (wasCreated) {
					await unlink(file.path).catch((err: NodeJS.ErrnoException) => {
						if (err.code !== 'ENOENT') throw err
					})
					record(file.turnId, file.path, 'removed')
				} else if (body !== null) {
					await mkdir(dirname(file.path), { recursive: true })
					await writeAtomic(file.path, body, entry.before?.mode ?? null)
					record(file.turnId, file.path, 'restored')
				}
				changed.add(file.path)
			} catch {
				// A failed write leaves the file as it was (temp and rename); the rest go on.
				record(file.turnId, file.path, 'failed')
				stopped.add(fileKey(file.path))
			}
		}

		const by = opts.by ?? 'user'
		const at = this.now()
		for (const [turnId, files] of results) {
			const rec = history.recs.find((r) => r.m.turnId === turnId)
			if (!rec) continue
			const entries = rec.m.entries.filter((e) => e.state !== 'failed')
			const undone = entries.filter((e) => {
				const r = files.get(e.path)
				return r === 'restored' || r === 'removed' || r === 'noop'
			})
			const wrote = [...files.values()].some((r) => r === 'restored' || r === 'removed')
			const wroteBefore = (rec.m.undone?.files.length ?? 0) > 0
			const was = rec.m.status
			if (entries.length > 0 && undone.length === entries.length) rec.m.status = 'undone'
			else if (wrote || wroteBefore) rec.m.status = 'partially_undone'
			if (wrote || (rec.m.status === 'undone' && was !== 'undone')) {
				rec.m.undone = {
					at,
					by,
					files: [
						...new Set([
							...(rec.m.undone?.files ?? []),
							...[...files].filter(([, r]) => r === 'restored' || r === 'removed').map(([p]) => p),
						]),
					],
				}
			}
			await writeManifest(history.root, rec.m)
		}
		const target = history.recs.find((r) => r.m.turnId === plan.turnId)
		const later: Record<string, Record<string, UndoFileResult>> = {}
		for (const [turnId, files] of results) {
			if (turnId !== plan.turnId) later[turnId] = Object.fromEntries(files)
		}
		return {
			kind: 'applied',
			turnId: plan.turnId,
			status: target?.m.status ?? 'applied',
			files: Object.fromEntries(results.get(plan.turnId) ?? []),
			later,
			copies: copies.map((c) => ({ path: c.path, sha256: c.sha256 })),
			changed: [...changed],
		}
	}

	// -- `/restore` -------------------------------------------------------------

	/**
	 * Put the tree back to before turn `index`: undo that turn and every later
	 * one, newest first, each through the same drift-checked plan as a single
	 * undo. A file the operator (or a shell call) changed since is left alone
	 * and reported, never overwritten. Nothing is deleted: the undone turns
	 * keep their manifests and bodies, marked undone.
	 */
	restore(index: number): Promise<RestoreReport> {
		const root = this.currentRoot()
		return this.locked(root, async () => this.restoreNow(await this.load(root), index))
	}

	private async restoreNow(history: History, index: number): Promise<RestoreReport> {
		const turns = history.recs
			.filter((r) => r.m.seq >= index && !r.m.pruned && r.m.status !== 'undone')
			.filter((r) => changedEntries(r.m).length > 0)
			.sort((a, b) => b.m.seq - a.m.seq)
		if (!history.recs.some((r) => r.m.seq === index) || turns.length === 0) {
			throw new Error(`No checkpoint for turn ${index}.`)
		}
		const restored = new Set<string>()
		const removed = new Set<string>()
		const failed = new Set<string>()
		const conflicts: RestoreConflict[] = []
		const notCovered: { path: string; reason: SkipReason }[] = []
		const undoneTurns: number[] = []
		const partialTurns: number[] = []
		let uncoveredShell = false
		for (const rec of turns) {
			const { plan } = await this.plan(history, rec.m.turnId, false)
			const reasons = new Map(plan.files.map((f) => [fileKey(f.path), f.reason]))
			const outcome = await this.applyPlan(history, plan, { planToken: plan.planToken })
			if (outcome.kind !== 'applied') continue
			let kept = false
			for (const [path, result] of Object.entries(outcome.files)) {
				if (result === 'restored') {
					restored.add(path)
					removed.delete(path)
				} else if (result === 'removed') {
					removed.add(path)
					restored.delete(path)
				} else if (result === 'failed') {
					failed.add(path)
					kept = true
				} else if (result === 'skipped') {
					conflicts.push({ path, turn: rec.m.seq, reason: reasons.get(fileKey(path)) ?? 'drifted' })
					kept = true
				}
			}
			;(kept ? partialTurns : undoneTurns).push(rec.m.seq)
			if (rec.m.uncoveredShell) uncoveredShell = true
			for (const s of rec.m.skipped) {
				if (!notCovered.some((n) => sameFile(n.path, s.path) && n.reason === s.reason))
					notCovered.push({ path: s.path, reason: s.reason })
			}
		}
		return {
			turn: index,
			restored: [...restored],
			removed: [...removed],
			conflicts,
			failed: [...failed],
			notCovered,
			uncoveredShell,
			undoneTurns,
			partialTurns,
		}
	}

	// -- forks ------------------------------------------------------------------

	/**
	 * A fork starts with its parent's history up to the fork point: the same
	 * manifests, the same immutable bodies hard-linked rather than copied.
	 * `untilTurnId` is the last parent turn the fork keeps; none keeps all.
	 */
	adoptFork(parentRoot: string, opts: { untilTurnId?: string } = {}): Promise<number> {
		const root = this.currentRoot()
		return this.locked(root, async () => {
			const history = await this.load(root)
			const { manifests } = await readManifests(parentRoot)
			const sorted = manifests.sort((a, b) => a.seq - b.seq)
			const until =
				opts.untilTurnId === undefined
					? undefined
					: sorted.find((m) => m.turnId === opts.untilTurnId)
			if (opts.untilTurnId !== undefined && !until) return 0
			let adopted = 0
			for (const m of sorted) {
				if (until && m.seq > until.seq) break
				if (history.recs.some((r) => r.m.turnId === m.turnId)) continue
				for (const sha of referencedBlobs(m)) {
					await shareBlob(parentRoot, root, sha)
				}
				const copy: Manifest = { ...m, forkedFrom: parentRoot, seq: history.nextSeq++ }
				await writeManifest(root, copy)
				const rec: Rec = { m: copy, root }
				history.recs.push(rec)
				this.byId.set(copy.turnId, rec)
				adopted++
			}
			return adopted
		})
	}

	// -- lifetime ---------------------------------------------------------------

	/**
	 * The session is over: finish what is in flight and drop the memory. Every
	 * file stays — history belongs to the conversation, not the process.
	 */
	async release(): Promise<void> {
		await Promise.allSettled([...this.tails.values()])
		this.histories.clear()
		this.ready.clear()
		this.byId.clear()
		this.tails.clear()
		this.current = undefined
	}

	/**
	 * The conversation is gone (deleted or archived): remove its history. The
	 * only path that deletes any.
	 */
	async dispose(): Promise<void> {
		const roots = new Set([...this.histories.keys(), ...this.tails.keys(), this.currentRoot()])
		await this.release()
		for (const root of roots) await rm(root, { recursive: true, force: true })
	}
}

let tempCounter = 0

/** Windows paths differ by case only; two spellings are one file. */
function fileKey(p: string): string {
	return process.platform === 'win32' ? p.toLowerCase() : p
}

function sameFile(a: string, b: string): boolean {
	return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Entries that left the file different from how they found it. */
function changedEntries(m: Manifest): ManifestEntry[] {
	return m.entries.filter(
		(e) => e.state !== 'failed' && !(e.state === 'done' && sameContent(e.after, e.before)),
	)
}

function sameContent(a: BlobRef | null, b: BlobRef | null): boolean {
	if (a === null || b === null) return a === b
	return a.sha256 === b.sha256
}

/** realpath of the nearest existing ancestor, with the missing tail put back. */
async function realExisting(path: string): Promise<string> {
	try {
		return await realpath(path)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
		const parent = dirname(path)
		if (parent === path) throw err
		return join(await realExisting(parent), basename(path))
	}
}

/**
 * Publish `data` at `path` by temp-file-and-rename, with the original mode.
 * A reader, or a crash, sees the old file or the restored one, never half;
 * and a symlink at `path` is replaced rather than written through, so a
 * restore cannot reach a file outside the tree. The SDK's `atomicWriteFile`
 * is not public and writes text only; a restore is bytes.
 */
async function writeAtomic(path: string, data: Buffer, mode: number | null): Promise<void> {
	const temp = `${path}.${process.pid}.${tempCounter++}.namzu-restore.tmp`
	try {
		await writeFile(temp, data, mode === null ? undefined : { mode })
		// The creation mode is narrowed by the umask; the original is not.
		if (mode !== null) await chmod(temp, mode)
		await rename(temp, path)
	} catch (err) {
		await unlink(temp).catch(() => undefined)
		throw err
	}
}

function firstLine(text: string): string {
	const line = text.split('\n').find((l) => l.trim().length > 0) ?? ''
	return line.trim()
}

const SKIP_TEXT: Record<SkipReason, string> = {
	'too-large': 'too large',
	'outside-cwd': 'outside the project folder',
	sandbox: 'edited in the sandbox',
	'snapshot-failed': 'snapshot failed',
}

/** What `/restore` prints with no argument. */
export function renderCheckpoints(
	turns: readonly CheckpointTurn[],
	cwd: string,
	skipped: readonly SkippedPath[] = [],
): string {
	if (turns.length === 0 && skipped.length === 0) {
		return 'No checkpoints: no file has been changed by a tool this session.'
	}
	const lines = ['Checkpoints (files as they were before each turn):']
	for (const turn of turns) {
		const partly = turn.status === 'partially_undone' ? '  (partly undone)' : ''
		lines.push(`  ${turn.index}. ${turn.label || '(no prompt)'}${partly}`)
		for (const file of turn.files) lines.push(`       ${relative(cwd, file) || file}`)
	}
	if (turns.length === 0) lines.push('  (none)')
	if (skipped.length > 0) {
		lines.push('', 'Not covered, so /restore cannot bring these back:')
		for (const s of skipped) {
			lines.push(`  ${relative(cwd, s.path) || s.path}  (${SKIP_TEXT[s.reason]})`)
		}
	}
	lines.push(
		'',
		'/restore N undoes turn N and every later turn, newest first. A file changed since is left as it is and reported.',
	)
	return lines.join('\n')
}

const CONFLICT_TEXT: Record<ConflictReason, string> = {
	drifted: 'changed since the turn',
	'later-reply': 'a later turn changed it and could not be undone',
	unavailable: 'the saved copy is missing or the edit never finished',
	symlink: 'is now a symlink',
	'outside-cwd': 'now resolves outside the project',
}

/** What `/restore N` prints. */
export function renderRestore(report: RestoreReport, cwd: string): string {
	const rel = (p: string) => relative(cwd, p) || p
	const left = report.conflicts.length > 0 || report.failed.length > 0
	const wrote = report.restored.length + report.removed.length > 0
	const lines = [
		!left
			? `Restored the tree to before turn ${report.turn}.`
			: wrote
				? `Restored part of the tree to before turn ${report.turn}. Some files were left as they are.`
				: `Nothing could be put back to before turn ${report.turn}. Every file was left as it is.`,
	]
	for (const p of report.restored) lines.push(`  restored ${rel(p)}`)
	for (const p of report.removed) lines.push(`  removed  ${rel(p)}`)
	for (const c of report.conflicts) {
		lines.push(`  kept     ${rel(c.path)}  (turn ${c.turn}: ${CONFLICT_TEXT[c.reason]})`)
	}
	for (const p of report.failed)
		lines.push(`  failed   ${rel(p)}  (the write failed; the file is as it was)`)
	if (report.partialTurns.length > 0) {
		lines.push(
			`  Turns ${report.partialTurns.join(', ')} stay listed; run /restore ${report.turn} again after sorting out the files above.`,
		)
	}
	for (const s of report.notCovered) {
		lines.push(`  not covered ${rel(s.path)}  (${SKIP_TEXT[s.reason]})`)
	}
	if (report.uncoveredShell) {
		lines.push('  These turns also ran shell commands; /restore cannot reverse what they changed.')
	}
	return lines.join('\n')
}

/**
 * What the model reads before its next turn: the operator took files back,
 * so what it remembers of them is wrong, and the files left alone hold
 * someone else's content, not the pre-turn version.
 */
export function renderRestoreNote(report: RestoreReport, cwd: string): string {
	const lines = [`/restore ${report.turn}`, renderRestore(report, cwd)]
	if (report.conflicts.length > 0 || report.failed.length > 0) {
		lines.push(
			'The files marked kept or failed were not changed: they still hold what is on disk now. Read them again before editing.',
		)
	}
	return lines.join('\n')
}

export { sep as PATH_SEPARATOR }
