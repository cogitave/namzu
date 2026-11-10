/**
 * The durable inbox between a turn and the curator.
 *
 * A turn that learned something does not write a memory itself. When it
 * settles it appends one line to a file here, which takes a few
 * milliseconds and needs no model. A later drain, off the turn's path,
 * hands those lines to the curator in small batches. Two properties follow
 * from keeping the queue in a file:
 *
 * - **Nothing is lost on a crash.** A line is on disk before the turn is
 *   released. A process that dies after the append and before any drain
 *   leaves the line for the next process.
 * - **An item leaves the inbox only after its outcome was applied.** A drain
 *   renames the inbox aside (a claim), so a line appended while it works
 *   lands in a fresh file; it handles the claim a batch at a time and
 *   rewrites what remains after each; whatever is left comes back to the
 *   inbox. A claim a dead process left behind is adopted once it is old
 *   enough that its owner cannot still be working. If a crash makes a batch
 *   run twice, the second run finds the first one's records among the
 *   neighbours and the content digest, so it writes nothing new.
 *
 * Pure of the terminal and of the model: the clock and the id source are
 * handed in, and a test uses a directory of its own.
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { SessionMemoryCandidate } from '@namzu/sdk'

/** The most lines one drain hands to the curator at once. */
export const INBOX_BATCH_SIZE = 8
/** The most batches one drain takes; the rest wait for the next. */
export const INBOX_MAX_BATCHES = 3
/** How long a claim may sit before another drain presumes its owner is gone. */
export const INBOX_CLAIM_STALE_MS = 120_000
/** A line that failed this many drains is dropped rather than retried for ever. */
export const INBOX_MAX_ATTEMPTS = 3
const CLAIM_PATTERN = /\.claim-(\d+)-[0-9a-f-]+\.jsonl$/u
const CLAIM_FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

export interface InboxEntry {
	readonly id: string
	/** When it was appended, ms. */
	readonly at: number
	/** How many drains failed to apply it. */
	readonly attempts: number
	readonly candidate: SessionMemoryCandidate
}

export interface InboxDeps {
	/** The inbox file: `<NAMZU_HOME>/memory-inbox/<project-slug>.jsonl`. */
	readonly file: string
	readonly now: () => number
	readonly newId?: () => string
}

export type DrainHandler = (entries: readonly InboxEntry[]) => Promise<void>

export interface DrainResult {
	/** Entries whose outcome was applied and which left the inbox. */
	readonly applied: number
	/** Entries that stayed for a later drain (a failed batch, or past the batch limit). */
	readonly kept: number
	/** Entries given up on after too many failed drains. */
	readonly dropped: number
}

function parseLines(text: string): InboxEntry[] {
	const out: InboxEntry[] = []
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		try {
			const raw = JSON.parse(line) as Partial<InboxEntry> | null
			if (
				raw === null ||
				typeof raw !== 'object' ||
				typeof raw.id !== 'string' ||
				typeof raw.at !== 'number' ||
				raw.candidate === null ||
				typeof raw.candidate !== 'object'
			) {
				continue
			}
			out.push({
				id: raw.id,
				at: raw.at,
				attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
				candidate: raw.candidate,
			})
		} catch {
			// A torn or foreign line is not an item.
		}
	}
	return out
}

const serialize = (entries: readonly InboxEntry[]): string =>
	entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')

async function readIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
}

export class MemoryInbox {
	readonly #file: string
	readonly #now: () => number
	readonly #newId: () => string
	#draining: Promise<DrainResult> | undefined

	constructor(deps: InboxDeps) {
		this.#file = deps.file
		this.#now = deps.now
		this.#newId = deps.newId ?? randomUUID
	}

	get file(): string {
		return this.#file
	}

	async #ensureDirectory(): Promise<void> {
		await mkdir(dirname(this.#file), { recursive: true, mode: DIRECTORY_MODE })
	}

	/** Append one candidate. One write of one line, so a concurrent append never interleaves. */
	async append(candidate: SessionMemoryCandidate): Promise<string> {
		await this.#ensureDirectory()
		const entry: InboxEntry = { id: this.#newId(), at: this.#now(), attempts: 0, candidate }
		await appendFile(this.#file, serialize([entry]), { mode: CLAIM_FILE_MODE })
		return entry.id
	}

	/** The entries waiting now, claims included, oldest first. */
	async pending(): Promise<readonly InboxEntry[]> {
		const claims = await this.#claimFiles()
		const texts = await Promise.all([
			...claims.map((claim) => readIfPresent(claim.path)),
			readIfPresent(this.#file),
		])
		return dedupe(texts.flatMap((text) => (text === undefined ? [] : parseLines(text))))
	}

	async #claimFiles(): Promise<readonly { path: string; at: number }[]> {
		let names: string[]
		try {
			names = await readdir(dirname(this.#file))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
			throw error
		}
		const prefix = `${basename(this.#file, '.jsonl')}.claim-`
		const out: { path: string; at: number }[] = []
		for (const name of names) {
			if (!name.startsWith(prefix)) continue
			const match = CLAIM_PATTERN.exec(name)
			if (!match) continue
			out.push({ path: join(dirname(this.#file), name), at: Number(match[1]) })
		}
		return out.sort((a, b) => a.at - b.at)
	}

	/**
	 * Hand the waiting entries to `handle`, a batch at a time. A batch that
	 * resolves is applied and leaves the inbox; one that rejects stays, with
	 * its attempt count raised. Only one drain runs at a time in this
	 * process: a second caller shares the first one's result.
	 */
	drain(
		handle: DrainHandler,
		options: { readonly batchSize?: number; readonly maxBatches?: number } = {},
	): Promise<DrainResult> {
		if (this.#draining) return this.#draining
		const run = this.#drain(handle, options).finally(() => {
			this.#draining = undefined
		})
		this.#draining = run
		return run
	}

	async #drain(
		handle: DrainHandler,
		options: { readonly batchSize?: number; readonly maxBatches?: number },
	): Promise<DrainResult> {
		const batchSize = options.batchSize ?? INBOX_BATCH_SIZE
		const maxBatches = options.maxBatches ?? INBOX_MAX_BATCHES
		const now = this.#now()
		const stale = (await this.#claimFiles()).filter(
			(claim) => now - claim.at >= INBOX_CLAIM_STALE_MS,
		)
		const claimPath = join(
			dirname(this.#file),
			`${basename(this.#file, '.jsonl')}.claim-${now}-${this.#newId()}.jsonl`,
		)
		let renamed = false
		try {
			await rename(this.#file, claimPath)
			renamed = true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
		const texts = await Promise.all([
			...stale.map((claim) => readIfPresent(claim.path)),
			renamed ? readIfPresent(claimPath) : undefined,
		])
		let pending = dedupe(texts.flatMap((text) => (text === undefined ? [] : parseLines(text))))
		if (pending.length === 0) {
			await Promise.all([
				...stale.map((claim) => unlink(claim.path).catch(() => {})),
				renamed ? unlink(claimPath).catch(() => {}) : undefined,
			])
			return { applied: 0, kept: 0, dropped: 0 }
		}
		// Adopted claims fold into this drain's own claim before they are removed.
		if (stale.length > 0) {
			await atomicWrite(claimPath, serialize(pending))
			await Promise.all(stale.map((claim) => unlink(claim.path).catch(() => {})))
		}

		let applied = 0
		let dropped = 0
		const failed: InboxEntry[] = []
		let batches = 0
		while (pending.length > 0 && batches < maxBatches) {
			const batch = pending.slice(0, batchSize)
			batches += 1
			try {
				await handle(batch)
				applied += batch.length
			} catch {
				for (const entry of batch) {
					const next = { ...entry, attempts: entry.attempts + 1 }
					if (next.attempts >= INBOX_MAX_ATTEMPTS) dropped += 1
					else failed.push(next)
				}
			}
			pending = pending.slice(batch.length)
			// What is left is on disk before the next batch begins.
			await atomicWrite(claimPath, serialize([...failed, ...pending]))
		}

		const keep = [...failed, ...pending]
		if (keep.length > 0) {
			await this.#ensureDirectory()
			await appendFile(this.#file, serialize(keep), { mode: CLAIM_FILE_MODE })
		}
		await unlink(claimPath).catch(() => {})
		return { applied, kept: keep.length, dropped }
	}
}

function dedupe(entries: readonly InboxEntry[]): InboxEntry[] {
	const seen = new Set<string>()
	const out: InboxEntry[] = []
	for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
		if (seen.has(entry.id)) continue
		seen.add(entry.id)
		out.push(entry)
	}
	return out
}

/** Write `text` to `path` by writing a sibling and renaming it over. */
async function atomicWrite(path: string, text: string): Promise<void> {
	const temp = `${path}.${randomUUID()}.tmp`
	await writeFile(temp, text, { mode: CLAIM_FILE_MODE })
	await rename(temp, path)
}
