/**
 * File checkpoints: the state of every file the model changed, before it
 * changed it, per turn — so `/restore N` puts the working tree back to
 * where it was before turn N.
 *
 * Not git. A checkpoint is taken by the tool wrapper immediately before an
 * `edit` or `write` runs, whatever the repository's state, and it records
 * absence too, so a file the model created is removed on restore. Kept per
 * session under the project's private state and dropped when the session
 * closes: a checkpoint outlives a turn, not a session — the conversation
 * can be forked and resumed, and its files are the working tree's.
 */

import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface CheckpointTurn {
	/** 1-based, in the order turns began. */
	readonly index: number
	/** The prompt that started the turn, cut to a line. */
	readonly label: string
	readonly startedAt: number
	/** Host paths snapshotted in this turn, first change first. */
	readonly files: readonly string[]
}

interface Entry {
	readonly path: string
	/** Blob file under the turn's directory, or null when the file did not exist. */
	readonly blob: string | null
}

interface Turn {
	readonly index: number
	readonly label: string
	readonly startedAt: number
	readonly entries: Entry[]
}

export interface RestoreReport {
	readonly turn: number
	/** Files written back to their pre-turn content. */
	readonly restored: readonly string[]
	/** Files removed because they did not exist before the turn. */
	readonly removed: readonly string[]
}

/** Files larger than this are not snapshotted; the transcript says so. */
export const CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024
const LABEL_CHARS = 72

export class FileCheckpointStore {
	private readonly turns: Turn[] = []
	private current: Turn | undefined
	private readonly skipped = new Set<string>()

	constructor(
		/** Where blobs go, e.g. `<state>/checkpoints/<sessionId>`. */
		private readonly root: string,
		/** Only files under here are checkpointed. */
		private readonly cwd: string,
	) {}

	/** The next tool write belongs to this turn. Returns its index. */
	beginTurn(label: string): number {
		const index = this.turns.length + 1
		this.current = {
			index,
			label: firstLine(label).slice(0, LABEL_CHARS),
			startedAt: Date.now(),
			entries: [],
		}
		this.turns.push(this.current)
		return index
	}

	/** Whether a host path is one this store would checkpoint. */
	covers(hostPath: string): boolean {
		const rel = relative(this.cwd, resolve(this.cwd, hostPath))
		return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
	}

	/**
	 * Record the file's current content before it changes. Once per path
	 * per turn: the first snapshot is the pre-turn state, and a second edit
	 * to the same file within a turn must not overwrite it.
	 */
	async snapshot(hostPath: string): Promise<'recorded' | 'already' | 'outside' | 'too-large'> {
		const turn = this.current ?? this.turnForStrayWrite()
		const path = resolve(this.cwd, hostPath)
		if (!this.covers(path)) return 'outside'
		if (turn.entries.some((e) => e.path === path)) return 'already'
		let content: Buffer | null
		try {
			content = await readFile(path)
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') content = null
			else throw err
		}
		if (content !== null && content.byteLength > CHECKPOINT_MAX_BYTES) {
			this.skipped.add(path)
			return 'too-large'
		}
		let blob: string | null = null
		if (content !== null) {
			const dir = join(this.root, String(turn.index))
			await mkdir(dir, { recursive: true })
			blob = join(dir, `${turn.entries.length}.blob`)
			await writeFile(blob, content)
		}
		turn.entries.push({ path, blob })
		return 'recorded'
	}

	/** Turns that changed at least one file. */
	list(): readonly CheckpointTurn[] {
		return this.turns
			.filter((t) => t.entries.length > 0)
			.map((t) => ({
				index: t.index,
				label: t.label,
				startedAt: t.startedAt,
				files: t.entries.map((e) => e.path),
			}))
	}

	/** Paths that were too large to checkpoint, so a restore cannot bring them back. */
	skippedPaths(): readonly string[] {
		return [...this.skipped]
	}

	/**
	 * Put every file back to its state before turn `index`, undoing that
	 * turn and every later one. Later turns are applied first, so a file
	 * touched in several turns ends at its oldest recorded state.
	 */
	async restore(index: number): Promise<RestoreReport> {
		const target = this.turns.find((t) => t.index === index)
		if (!target || !this.turns.some((t) => t.index >= index && t.entries.length > 0)) {
			throw new Error(`No checkpoint for turn ${index}.`)
		}
		const restored = new Set<string>()
		const removed = new Set<string>()
		for (const turn of [...this.turns].filter((t) => t.index >= index).reverse()) {
			for (const entry of turn.entries) {
				if (entry.blob === null) {
					await unlink(entry.path).catch((err: NodeJS.ErrnoException) => {
						if (err.code !== 'ENOENT') throw err
					})
					removed.add(entry.path)
					restored.delete(entry.path)
				} else {
					await mkdir(dirname(entry.path), { recursive: true })
					await writeFile(entry.path, await readFile(entry.blob))
					restored.add(entry.path)
					removed.delete(entry.path)
				}
			}
		}
		// The undone turns are gone: their snapshots describe a state the
		// tree no longer builds on.
		const dropped = this.turns.splice(this.turns.findIndex((t) => t.index === index))
		for (const turn of dropped) {
			await rm(join(this.root, String(turn.index)), { recursive: true, force: true })
		}
		this.current = undefined
		return { turn: index, restored: [...restored], removed: [...removed] }
	}

	/** Drop every blob. The session is over. */
	async close(): Promise<void> {
		await rm(this.root, { recursive: true, force: true })
	}

	/** A write outside any turn — a host command, say — gets a turn of its own. */
	private turnForStrayWrite(): Turn {
		this.beginTurn('(outside a turn)')
		return this.current as Turn
	}
}

function firstLine(text: string): string {
	const line = text.split('\n').find((l) => l.trim().length > 0) ?? ''
	return line.trim()
}

/** What `/restore` prints with no argument. */
export function renderCheckpoints(turns: readonly CheckpointTurn[], cwd: string): string {
	if (turns.length === 0) return 'No checkpoints: no file has been changed by a tool this session.'
	const lines = ['Checkpoints (files as they were before each turn):']
	for (const turn of turns) {
		lines.push(`  ${turn.index}. ${turn.label || '(no prompt)'}`)
		for (const file of turn.files) lines.push(`       ${relative(cwd, file) || file}`)
	}
	lines.push(
		'',
		'/restore N puts every file back to before turn N, undoing N and every later turn.',
	)
	return lines.join('\n')
}

/** What `/restore N` prints. */
export function renderRestore(report: RestoreReport, cwd: string): string {
	const rel = (p: string) => relative(cwd, p) || p
	const lines = [`Restored the tree to before turn ${report.turn}.`]
	for (const p of report.restored) lines.push(`  restored ${rel(p)}`)
	for (const p of report.removed) lines.push(`  removed  ${rel(p)}`)
	return lines.join('\n')
}

export { sep as PATH_SEPARATOR }
