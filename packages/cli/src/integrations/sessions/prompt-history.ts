/**
 * Prompt history across conversations: `$NAMZU_HOME/history.jsonl`.
 *
 * The terminal app's Up arrow and Ctrl+R used to know only the prompts of the
 * conversation on screen, so a new conversation started with nothing to bring
 * back. Every prompt a person sends from the box is now also one line of this
 * file, and a new conversation recalls the earlier prompts of the same project
 * (the checkout root), newest last.
 *
 * One JSON object per line:
 *
 * ```json
 * {"display":"fix the failing test","project":"/home/me/app","sessionId":"…","timestamp":1763740800000}
 * ```
 *
 * `display` is what was typed. Pasted text is never copied here: it is cut out
 * of `display`, and `pasted` says where each stretch goes back
 * (`{ offset, length, sha256 }`). Recall reads the stretch from the
 * conversation's own log, which already holds it; a line whose conversation is
 * gone, or whose paste cannot be found, is not recalled (a prompt with a hole in
 * it is not the prompt that was sent).
 *
 * The file is private (0600), refused when it is a link or not a regular file,
 * and appended under `history.jsonl.lock`, the same lock a rewrite takes, so a
 * line written while the file is trimmed is never lost. It keeps the newest
 * {@link PROMPT_HISTORY_KEEP} lines. Prompts that carry a credential shape,
 * sign-in codes, prompts typed into a process a session started, and anything
 * after `promptHistory: false` are not written.
 */

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
	LOG_SECRET_PATTERNS,
	type Message,
	type SessionId,
	asSessionId,
	isEntityId,
	startedBySession,
	withAccountLock,
} from '@namzu/sdk'
import { type LoadConfigOptions, loadBootstrapConfigWithProvenance } from '../../config/load.js'
import { type CliSessions, openConversationLog, readConversationRecords } from './store.js'

/** The file under `NAMZU_HOME`. */
export const PROMPT_HISTORY_FILE = 'history.jsonl'
/** Lines the file keeps; older ones are dropped when it is trimmed. */
export const PROMPT_HISTORY_KEEP = 2000
/** The file is trimmed once it holds this many more lines than it keeps. */
const TRIM_SLACK = 500
/** Earlier prompts of one project the box is given. */
export const PROMPT_HISTORY_RECALL = 500
/** A longer prompt is kept for its own conversation only. */
export const PROMPT_HISTORY_MAX_CHARS = 64 * 1024
/** The newest conversations of a project whose prompts seed the file once. */
export const PROMPT_HISTORY_SEED_SESSIONS = 20
/** The per-project marker that says the seed ran. */
export const PROMPT_HISTORY_SEEDED_MARKER = '.history-seeded'
/** The largest file read; a larger one is read from its last bytes. */
const MAX_READ_BYTES = 16 * 1024 * 1024
/** Conversations whose logs are opened to find pasted text for one recall. */
const MAX_PASTE_SESSIONS = 20

/** Where a pasted stretch goes back into `display`. */
export interface PromptHistoryPaste {
	/** Offset in `display`, in UTF-16 units. */
	readonly offset: number
	/** Length of the pasted text, in UTF-16 units. */
	readonly length: number
	/** SHA-256 of the pasted text, lowercase hex. */
	readonly sha256: string
}

/** One line of the file. */
export interface PromptHistoryEntry {
	readonly display: string
	readonly pasted?: readonly PromptHistoryPaste[]
	/** The canonical project root the prompt was sent in. */
	readonly project: string
	readonly sessionId: string
	/** Epoch milliseconds. */
	readonly timestamp: number
}

/** A pasted stretch of a sent message: `[start, end)` in the message. */
export interface PastedRange {
	readonly start: number
	readonly end: number
}

export function promptHistoryPath(home: string): string {
	return join(home, PROMPT_HISTORY_FILE)
}

function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The credential shapes the kernel keeps out of its logs, without the `g` flag. */
const CREDENTIAL_SHAPES: readonly RegExp[] = LOG_SECRET_PATTERNS.map(
	([, pattern]) => new RegExp(pattern.source, pattern.flags.replace('g', '')),
)

/**
 * Whether a prompt stays out of the file: it carries a credential shape (a
 * vendor key, a bearer header, a private key block), or it is `/login` with
 * the code or address it was given. A check that throws counts as a match.
 */
export function promptLooksSensitive(text: string): boolean {
	if (/^\s*\/login\s+\S/.test(text)) return true
	try {
		return CREDENTIAL_SHAPES.some((shape) => shape.test(text))
	} catch {
		return true
	}
}

/** Whether nothing is written here at all: the box belongs to a process a session started. */
export function promptHistorySkipped(env: NodeJS.ProcessEnv = process.env): boolean {
	return startedBySession(env)
}

/**
 * Whether the history is kept (`promptHistory`, read from the user's own file and the managed
 * file). A file that cannot be read keeps it off for this start: nothing is written that the
 * person may have turned off.
 */
export function promptHistoryEnabled(
	options: Pick<LoadConfigOptions, 'home' | 'env'> = {},
): boolean {
	try {
		return loadBootstrapConfigWithProvenance(options).config.promptHistory !== false
	} catch {
		return false
	}
}

/**
 * The line for one sent prompt, or `undefined` when it is not kept: empty,
 * too long, sensitive, or with pasted ranges that do not fit the text.
 */
export function promptHistoryEntryFor(input: {
	readonly text: string
	readonly pasted?: readonly PastedRange[]
	readonly project: string
	readonly sessionId: string
	readonly timestamp: number
}): PromptHistoryEntry | undefined {
	const { text } = input
	if (text.trim().length === 0) return undefined
	const ranges = [...(input.pasted ?? [])].sort((a, b) => a.start - b.start)
	let display = ''
	let at = 0
	const pasted: PromptHistoryPaste[] = []
	for (const range of ranges) {
		if (
			!Number.isSafeInteger(range.start) ||
			!Number.isSafeInteger(range.end) ||
			range.start < at ||
			range.end <= range.start ||
			range.end > text.length
		)
			return undefined
		display += text.slice(at, range.start)
		const piece = text.slice(range.start, range.end)
		pasted.push({ offset: display.length, length: piece.length, sha256: sha256Hex(piece) })
		at = range.end
	}
	display += text.slice(at)
	if (display.length > PROMPT_HISTORY_MAX_CHARS) return undefined
	if (promptLooksSensitive(display)) return undefined
	return {
		display,
		...(pasted.length > 0 ? { pasted } : {}),
		project: input.project,
		sessionId: input.sessionId,
		timestamp: input.timestamp,
	}
}

function isPaste(value: unknown): value is PromptHistoryPaste {
	if (typeof value !== 'object' || value === null) return false
	const v = value as Record<string, unknown>
	return (
		Number.isSafeInteger(v.offset) &&
		(v.offset as number) >= 0 &&
		Number.isSafeInteger(v.length) &&
		(v.length as number) > 0 &&
		typeof v.sha256 === 'string' &&
		/^[0-9a-f]{64}$/.test(v.sha256)
	)
}

/** One line read back, or `undefined` for a line that is not one. */
export function parsePromptHistoryLine(line: string): PromptHistoryEntry | undefined {
	let value: unknown
	try {
		value = JSON.parse(line)
	} catch {
		return undefined
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
	const v = value as Record<string, unknown>
	if (
		typeof v.display !== 'string' ||
		typeof v.project !== 'string' ||
		typeof v.sessionId !== 'string' ||
		typeof v.timestamp !== 'number' ||
		!Number.isFinite(v.timestamp)
	)
		return undefined
	let pasted: PromptHistoryPaste[] | undefined
	if (v.pasted !== undefined) {
		if (!Array.isArray(v.pasted) || !v.pasted.every(isPaste)) return undefined
		pasted = [...v.pasted].sort((a, b) => a.offset - b.offset)
		if (pasted.some((paste) => paste.offset > (v.display as string).length)) return undefined
	}
	return {
		display: v.display,
		...(pasted && pasted.length > 0 ? { pasted } : {}),
		project: v.project,
		sessionId: v.sessionId,
		timestamp: v.timestamp,
	}
}

export interface PromptHistoryLockOptions {
	/** Tries for the lock before giving up. Default 50. */
	readonly attempts?: number
	/** Waits between tries; injected so a test never depends on the clock. Default 20 ms. */
	readonly wait?: (attempt: number) => Promise<void>
}

const realWait = () => new Promise<void>((resolveWait) => setTimeout(resolveWait, 20))

function withHistoryLock<T>(
	home: string,
	operation: () => Promise<T>,
	options: PromptHistoryLockOptions = {},
): Promise<T> {
	return withAccountLock(`${promptHistoryPath(home)}.lock`, operation, {
		attempts: options.attempts ?? 50,
		wait: options.wait ?? realWait,
	})
}

/** `undefined` when the path is free or a regular file; a reason when it is something else. */
async function notARegularFile(path: string): Promise<string | undefined> {
	try {
		const entry = await lstat(path)
		if (entry.isSymbolicLink()) return 'it is a link'
		if (!entry.isFile()) return 'it is not a regular file'
		return undefined
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0

async function appendLines(home: string, lines: readonly string[]): Promise<void> {
	if (lines.length === 0) return
	const path = promptHistoryPath(home)
	const refused = await notARegularFile(path)
	if (refused) throw new Error(`${path} is not used: ${refused}.`)
	const handle = await open(
		path,
		constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW,
		0o600,
	)
	try {
		const entry = await handle.stat()
		if (!entry.isFile()) throw new Error(`${path} is not used: it is not a regular file.`)
		if (process.platform !== 'win32' && (entry.mode & 0o077) !== 0) await handle.chmod(0o600)
		// One write per call: an append of one buffer is not interleaved with another process's.
		await handle.write(lines.map((line) => `${line}\n`).join(''))
	} finally {
		await handle.close()
	}
}

/**
 * Append one line. Returns whether it was written; a lock held too long, a
 * file that is not ours to write, or a full disk costs this line, never the
 * prompt.
 */
export async function appendPromptHistory(
	home: string,
	entry: PromptHistoryEntry,
	options: PromptHistoryLockOptions = {},
): Promise<boolean> {
	try {
		await mkdir(home, { recursive: true, mode: 0o700 })
		await withHistoryLock(home, () => appendLines(home, [JSON.stringify(entry)]), options)
		return true
	} catch {
		return false
	}
}

export interface PromptHistoryRead {
	readonly entries: readonly PromptHistoryEntry[]
	/** Every non-empty line, a line that is not an entry included. */
	readonly lines: number
}

/** Read the file. A missing file, a link or a non-regular file reads as empty. */
export async function readPromptHistory(home: string): Promise<PromptHistoryRead> {
	const path = promptHistoryPath(home)
	let text: string
	try {
		if (await notARegularFile(path)) return { entries: [], lines: 0 }
		const handle = await open(path, constants.O_RDONLY | NOFOLLOW)
		try {
			const size = (await handle.stat()).size
			const start = Math.max(0, size - MAX_READ_BYTES)
			const buffer = Buffer.alloc(size - start)
			await handle.read(buffer, 0, buffer.length, start)
			text = buffer.toString('utf8')
			// A read that starts inside the file starts inside a line: skip to the next one.
			if (start > 0) text = text.slice(text.indexOf('\n') + 1)
		} finally {
			await handle.close()
		}
	} catch {
		return { entries: [], lines: 0 }
	}
	const entries: PromptHistoryEntry[] = []
	let lines = 0
	for (const line of text.split('\n')) {
		if (line.trim().length === 0) continue
		lines += 1
		const entry = parsePromptHistoryLine(line)
		if (entry) entries.push(entry)
	}
	return { entries, lines }
}

/** One prompt a person typed, as a conversation's log keeps it. */
export interface LoggedPrompt {
	readonly content: string
	readonly pasted?: readonly PastedRange[]
	readonly timestamp: number
}

/**
 * The prompts a person typed into one conversation, in order, from its log:
 * user messages with no host `source` (the same rule the box uses for a
 * resumed conversation), a spilled message read back in full. A log that
 * cannot be read gives none.
 */
export async function loggedPromptsOf(
	s: Pick<CliSessions, 'paths'>,
	sessionId: SessionId,
): Promise<LoggedPrompt[]> {
	let records: Awaited<ReturnType<typeof readConversationRecords>>
	try {
		records = await readConversationRecords(s, sessionId, 'tolerant')
	} catch {
		return []
	}
	if (!records) return []
	const log = openConversationLog(s, sessionId)
	const out: LoggedPrompt[] = []
	for (const record of records.records) {
		if (record.type !== 'message' || record.role !== 'user') continue
		let message: Message = record.content
		if (record.spill) {
			try {
				message = JSON.parse(await log.readSpill(record.spill)) as Message
			} catch {
				continue
			}
		}
		if (message.role !== 'user' || message.source || typeof message.content !== 'string') continue
		if (message.content.trim().length === 0) continue
		const at = Date.parse(record.ts)
		out.push({
			content: message.content,
			...(message.pasted?.length
				? { pasted: message.pasted.map(({ start, end }) => ({ start, end })) }
				: {}),
			timestamp: Number.isFinite(at) ? at : 0,
		})
	}
	return out
}

/** The pasted stretches one conversation's log holds, by the SHA-256 of their text. */
export async function pastedTextsOf(
	s: Pick<CliSessions, 'paths'>,
	sessionId: SessionId,
): Promise<ReadonlyMap<string, string>> {
	const out = new Map<string, string>()
	for (const prompt of await loggedPromptsOf(s, sessionId)) {
		for (const range of prompt.pasted ?? []) {
			const piece = prompt.content.slice(range.start, range.end)
			if (piece.length > 0) out.set(sha256Hex(piece), piece)
		}
	}
	return out
}

/** Put the pasted stretches back; `undefined` when one is missing or does not match. */
function rebuild(
	entry: PromptHistoryEntry,
	pastes: ReadonlyMap<string, string>,
): string | undefined {
	if (!entry.pasted?.length) return entry.display
	let out = ''
	let at = 0
	for (const paste of entry.pasted) {
		const piece = pastes.get(paste.sha256)
		if (piece === undefined || piece.length !== paste.length || paste.offset < at) return undefined
		out += entry.display.slice(at, paste.offset) + piece
		at = paste.offset
	}
	return out + entry.display.slice(at)
}

export interface RecallOptions {
	readonly home: string
	/** The canonical project root. */
	readonly project: string
	/** Lines written at or after this time are left out: they are this process's own. */
	readonly before?: number
	/** A conversation whose prompts the box already holds (a resumed one). */
	readonly excludeSession?: string
	readonly limit?: number
	/** The pasted stretches a conversation's log holds; see {@link pastedTextsOf}. */
	readonly pastesOf: (sessionId: SessionId) => Promise<ReadonlyMap<string, string>>
}

/**
 * The earlier prompts of one project, oldest first, newest last, each whole:
 * what the box gives Up and Ctrl+R before this conversation's own prompts.
 * Repeats in a row are given once.
 */
export async function recallPromptHistory(options: RecallOptions): Promise<string[]> {
	const { entries } = await readPromptHistory(options.home)
	const limit = options.limit ?? PROMPT_HISTORY_RECALL
	const mine = entries
		.filter(
			(entry) =>
				entry.project === options.project &&
				entry.sessionId !== options.excludeSession &&
				(options.before === undefined || entry.timestamp < options.before),
		)
		.sort((a, b) => a.timestamp - b.timestamp)
		.slice(-limit)
	const needed = [...new Set(mine.filter((e) => e.pasted?.length).map((e) => e.sessionId))]
		.slice(-MAX_PASTE_SESSIONS)
		.filter((id) => isEntityId(id, 'session'))
	const pastes = new Map<string, ReadonlyMap<string, string>>()
	for (const id of needed) {
		try {
			pastes.set(id, await options.pastesOf(asSessionId(id)))
		} catch {
			pastes.set(id, new Map())
		}
	}
	const out: string[] = []
	for (const entry of mine) {
		const text = rebuild(entry, pastes.get(entry.sessionId) ?? new Map())
		if (text === undefined || text === out.at(-1)) continue
		out.push(text)
	}
	return out
}

/**
 * Write the file again with only the lines `keep` accepts, under the lock: a
 * private temporary file is written and flushed, renamed over the old one, and
 * read back. A line that is not an entry is kept as it was. When the result
 * would equal the file, nothing is written. Returns how many lines were dropped.
 */
export async function rewritePromptHistory(
	home: string,
	keep: (
		entry: PromptHistoryEntry,
		index: number,
		entries: readonly PromptHistoryEntry[],
	) => boolean,
	options: PromptHistoryLockOptions = {},
): Promise<number> {
	const path = promptHistoryPath(home)
	return await withHistoryLock(
		home,
		async () => {
			if (await notARegularFile(path)) return 0
			let text: string
			try {
				text = await readFile(path, 'utf8')
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
				throw error
			}
			const raw = text.split('\n').filter((line) => line.trim().length > 0)
			const parsed = raw.map((line) => parsePromptHistoryLine(line))
			const entries = parsed.filter((entry): entry is PromptHistoryEntry => entry !== undefined)
			const kept: string[] = []
			let index = 0
			let dropped = 0
			for (let i = 0; i < raw.length; i++) {
				const entry = parsed[i]
				if (entry === undefined) {
					kept.push(raw[i] as string)
					continue
				}
				if (keep(entry, index++, entries)) kept.push(raw[i] as string)
				else dropped += 1
			}
			if (dropped === 0) return 0
			const body = kept.map((line) => `${line}\n`).join('')
			const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
			const handle = await open(temporary, 'wx', 0o600)
			try {
				await handle.writeFile(body, 'utf8')
				await handle.sync()
			} finally {
				await handle.close()
			}
			try {
				if ((await readFile(temporary, 'utf8')) !== body)
					throw new Error('the new copy did not read back as written')
				await rename(temporary, path)
			} catch (error) {
				await unlink(temporary).catch(() => undefined)
				throw error
			}
			return dropped
		},
		options,
	)
}

/** Keep the newest {@link PROMPT_HISTORY_KEEP} lines once the file has grown well past them. */
export async function trimPromptHistory(
	home: string,
	lines: number,
	options: PromptHistoryLockOptions = {},
): Promise<number> {
	if (lines <= PROMPT_HISTORY_KEEP + TRIM_SLACK) return 0
	try {
		return await rewritePromptHistory(
			home,
			(_entry, index, entries) => index >= entries.length - PROMPT_HISTORY_KEEP,
			options,
		)
	} catch {
		return 0
	}
}

export interface SeedOptions extends PromptHistoryLockOptions {
	readonly home: string
	readonly project: string
	/** The project's folder under `projects/`, where the marker is written. */
	readonly projectDir: string
	/** The project's conversations to seed from, newest first, as ids. */
	readonly conversations: () => Promise<readonly SessionId[]>
	readonly promptsOf: (sessionId: SessionId) => Promise<readonly LoggedPrompt[]>
}

/**
 * Seed the file from the project's newest {@link PROMPT_HISTORY_SEED_SESSIONS}
 * conversations, once per project: an installation from before this file
 * existed already has every prompt in its logs, so the first new conversation
 * can recall them. Lines are only added, never changed; a line already in the
 * file (same conversation, same text, same pastes) is not added again; and the
 * marker is written under the same lock after the lines, so two processes
 * starting at once seed once. Returns the lines added.
 */
export async function seedPromptHistory(options: SeedOptions): Promise<number> {
	const marker = join(options.projectDir, PROMPT_HISTORY_SEEDED_MARKER)
	const seeded = async () => {
		try {
			await stat(marker)
			return true
		} catch {
			return false
		}
	}
	if (await seeded()) return 0
	const ids = (await options.conversations()).slice(0, PROMPT_HISTORY_SEED_SESSIONS)
	const candidates: PromptHistoryEntry[] = []
	for (const id of ids) {
		for (const prompt of await options.promptsOf(id)) {
			const entry = promptHistoryEntryFor({
				text: prompt.content,
				...(prompt.pasted ? { pasted: prompt.pasted } : {}),
				project: options.project,
				sessionId: id,
				timestamp: prompt.timestamp,
			})
			if (entry) candidates.push(entry)
		}
	}
	const key = (entry: PromptHistoryEntry) =>
		JSON.stringify([
			entry.sessionId,
			entry.display,
			(entry.pasted ?? []).map((paste) => paste.sha256),
		])
	await mkdir(options.home, { recursive: true, mode: 0o700 })
	return await withHistoryLock(
		options.home,
		async () => {
			if (await seeded()) return 0
			// Counted, not just seen: a prompt sent twice in one conversation is two lines, and a
			// line already written for one of them stands for that one only.
			const present = new Map<string, number>()
			for (const entry of (await readPromptHistory(options.home)).entries) {
				const k = key(entry)
				present.set(k, (present.get(k) ?? 0) + 1)
			}
			const fresh = candidates
				.sort((a, b) => a.timestamp - b.timestamp)
				.filter((entry) => {
					const k = key(entry)
					const left = present.get(k) ?? 0
					if (left === 0) return true
					present.set(k, left - 1)
					return false
				})
				.slice(-PROMPT_HISTORY_KEEP)
			await appendLines(
				options.home,
				fresh.map((entry) => JSON.stringify(entry)),
			)
			await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600, flag: 'w' })
			return fresh.length
		},
		options,
	)
}
