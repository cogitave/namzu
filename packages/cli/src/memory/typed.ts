/**
 * Stored memory: the typed, one-file-per-memory store the kernel's memory
 * tools read and write, as the CLI uses it.
 *
 * Four jobs live here. `saveTypedNote` is what `#note` and `/memory add`
 * write through. `composeStoredMemoryPrompt` turns the store's generated index
 * into the prompt section the model sees every turn. `migrateMemoryOnce`
 * moves the JSON store into typed files, once, and offers the project's
 * curated bullets; `importCuratedNotes` moves those when the operator asks.
 *
 * The CURATED files (`USER.md`, `MEMORY.md` in the application home and the
 * project) stay what they were: operator-authored text read into every turn.
 * The two are never given the same heading in the prompt.
 */

import { createHash } from 'node:crypto'
import { access, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
	DiskMemoryStore,
	type MarkdownMemoryStore,
	MemoryContentRejectedError,
	MemoryNameConflictError,
	type MemoryType,
	type RenderedMemoryIndex,
	slugifyMemoryName,
} from '@namzu/sdk'

import { readMemoryFile, replaceMemoryFile, writeMemoryBackup } from './io.js'
import { projectMemoryLocation } from './store.js'

export interface TypedNoteResult {
	/** False when the note was empty or an identical memory already exists. */
	readonly saved: boolean
	readonly name?: string
	readonly type: MemoryType
	/** The memory file, or the existing duplicate's file. */
	readonly path?: string
	/** Set when an active memory with this exact text already existed. */
	readonly duplicate?: boolean
}

function firstLine(text: string, limit: number): string {
	const line = (text.split(/\r?\n/).find((part) => part.trim()) ?? '').replace(/\s+/g, ' ').trim()
	if (line.length <= limit) return line
	let head = line.slice(0, limit - 1)
	if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
	return `${head.trimEnd()}…`
}

function digest(text: string): string {
	return createHash('sha256').update(text).digest('hex')
}

/**
 * Save an operator note as a typed memory, default type `project`. A note
 * whose exact text an active memory already holds is not saved twice; the
 * result names the one that holds it.
 */
export async function saveTypedNote(
	store: MarkdownMemoryStore,
	text: string,
	type: MemoryType = 'project',
): Promise<TypedNoteResult> {
	const note = text.trim()
	if (!note) return { saved: false, type }
	const candidates = await store.list({ query: note, status: 'active', limit: 20 })
	for (const entry of candidates.entries) {
		const record = await store.getRecord(entry.id)
		if (record?.entry.status === 'active' && record.content.content.trim() === note) {
			return {
				saved: false,
				duplicate: true,
				type: record.entry.type ?? type,
				...(record.entry.name
					? { name: record.entry.name, path: join(store.path, `${record.entry.name}.md`) }
					: {}),
			}
		}
	}
	const { entry } = await store.create({
		title: firstLine(note, 72),
		summary: firstLine(note, 300),
		description: firstLine(note, 150),
		content: note,
		type,
		metadata: { source: 'operator-note', noteDigest: digest(note) },
	})
	return {
		saved: true,
		type,
		...(entry.name ? { name: entry.name, path: join(store.path, `${entry.name}.md`) } : {}),
	}
}

/**
 * The prompt section for the stored-memory index, or null when the store
 * holds no active memory. Named so it can never be mistaken for the curated
 * sections beside it.
 */
export function composeStoredMemoryPrompt(index: RenderedMemoryIndex): string | null {
	if (!index.text) return null
	return [
		'## Stored memories (index)',
		'',
		'Memories saved in earlier sessions, one line each: `- [name](name.md) — description`. Read one with read_memory (by name) when it bears on the task. Correct or archive a wrong one with update_memory rather than saving a second copy. Memories are point-in-time: verify a file, function or flag a memory names against the current code before relying on it. What earlier runs recorded on their own is not listed here; search_memory finds it.',
		'',
		index.text,
	].join('\n')
}

/** What one launch's migration did, for the operator notice. */
export interface MemoryMigrationReport {
	readonly importedRecords: number
	/** JSON records the Markdown store refused (too large, a NUL byte); kept in the retired files. */
	readonly skippedRecords: readonly string[]
	/**
	 * The project's curated file holds bullets that look like old `#note`s,
	 * offered once per file: nothing moves until the operator runs
	 * `/memory import-notes`.
	 */
	readonly notesOffer?: { readonly path: string; readonly count: number }
	/** Things that did not happen and why; the migration is retried next launch. */
	readonly problems: readonly string[]
}

/** What `/memory import-notes` did with the curated file. */
export interface CuratedNotesImport {
	readonly path: string
	readonly moved: number
	/**
	 * Top-level bullets left in the file: those in a list that starts on the
	 * line after a heading (the operator's own section), and those followed by
	 * a line that is neither blank nor a bullet (a note that runs on, or a
	 * bullet with a nested list). Prose and nested bullets always stay and are
	 * not counted.
	 */
	readonly kept: number
	/**
	 * Where the file's text before this run's move was kept. Every run that
	 * finds bullets writes one: `MEMORY.md.before-typed-memory`, or a numbered
	 * name beside it when an earlier run's copy of different text is there.
	 */
	readonly backupPath?: string
}

/** Records per curated file what has been offered and moved, so neither repeats. */
const MARKER = 'migration.json'
const BACKUP_SUFFIX = '.before-typed-memory'

interface CuratedFileState {
	readonly offeredAt?: string
	readonly movedAt?: string
	readonly moved?: number
}

interface MigrationMarker {
	readonly curatedFiles?: Readonly<Record<string, CuratedFileState>>
}

async function readMarker(directory: string): Promise<MigrationMarker> {
	try {
		const parsed = JSON.parse(await readFile(join(directory, MARKER), 'utf8')) as unknown
		return parsed !== null && typeof parsed === 'object' ? (parsed as MigrationMarker) : {}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
		throw error
	}
}

/** Merge `state` into the marker's record for `path`, re-reading it first. */
async function markCuratedFile(
	directory: string,
	path: string,
	state: CuratedFileState,
): Promise<void> {
	const marker = await readMarker(directory).catch(() => ({}) as MigrationMarker)
	const files = { ...(marker.curatedFiles ?? {}) }
	files[path] = { ...(files[path] ?? {}), ...state }
	await writeFile(
		join(directory, MARKER),
		`${JSON.stringify({ ...marker, curatedFiles: files }, null, 2)}\n`,
		{ mode: 0o600 },
	)
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

/** Move `path` aside to `path.migrated`, or a numbered name when that is taken. */
async function retire(path: string): Promise<string> {
	let target = `${path}.migrated`
	for (let n = 2; await exists(target); n++) target = `${path}.migrated-${n}`
	try {
		await rename(path, target)
	} catch (error) {
		// Another process retired it first.
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	return target
}

const HEADING = /^#{1,6}\s/

/**
 * The single-line top-level bullets `appendMemory` wrote, and the text left
 * when they are removed.
 *
 * `appendMemory` wrote `- <note>` at the end of the file and never a heading,
 * so what cannot be one of its notes stays:
 * - a bullet followed by a line that is neither blank nor a bullet — a note
 *   typed over several lines was appended with its later lines unindented,
 *   and they cannot be told apart from the operator's prose; a bullet with a
 *   nested list stays for the same reason;
 * - a bullet in a list that starts on the line directly under a Markdown
 *   heading — that list is a section the operator wrote (`## Conventions`
 *   then `- use tabs`), and taking its bullets would leave the heading empty
 *   and lose the grouping. A blank line ends that list: bullets after it are
 *   what `appendMemory` leaves at the end of a file whose last section is a
 *   heading, so they are offered.
 *
 * Everything else — a bullet after a blank line, at the top of the file, or
 * directly under a line of prose (which `appendMemory` also produced when
 * the file ended in prose) — is offered. A note appended straight onto a
 * heading's list, with no blank line between, cannot be told from the list
 * and stays. Nothing here can prove a bullet was a `#note`; the rules only
 * keep what provably was not. That is why moving is the operator's call, not
 * a launch's.
 */
export function splitCuratedBullets(text: string): {
	bullets: string[]
	rest: string
	kept: number
} {
	const lines = text.split('\n')
	const bullets: string[] = []
	const out: string[] = []
	let kept = 0
	// What the current list hangs from: a heading directly above it, or
	// anything else. A blank line starts over, so it ends a heading's list.
	let context: 'start' | 'heading' | 'other' = 'start'
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ''
		const bare = line.replace(/\r$/, '')
		const match = /^- (\S.*)$/.exec(bare)
		if (match?.[1]) {
			const next = (lines[i + 1] ?? '').replace(/\r$/, '')
			const ends = next.trim() === '' || /^- \S/.test(next)
			if (ends && context !== 'heading') {
				bullets.push(match[1].trim())
				continue
			}
			kept++
			out.push(line)
			continue
		}
		if (bare.trim() === '') context = 'start'
		else if (!/^\s+- /.test(bare)) context = HEADING.test(bare) ? 'heading' : 'other'
		out.push(line)
	}
	const rest = out.join('\n').replace(/\n{3,}/g, '\n\n')
	return { bullets, rest: rest.trim() ? `${rest.trim()}\n` : '', kept }
}

/**
 * Create the memory for one curated bullet, false when it already exists.
 *
 * Under the name its text slugs to, first: the store refuses a taken name
 * inside its lock, so two runs moving the same bullet at once write it once,
 * the second finding the first's record by its source digest. A name held by
 * an unrelated memory falls back to a suffixed one.
 */
async function moveBullet(
	store: MarkdownMemoryStore,
	bullet: string,
	sourceDigest: string,
	migratedFrom: string,
): Promise<boolean> {
	const params = {
		title: firstLine(bullet, 72),
		summary: firstLine(bullet, 300),
		description: firstLine(bullet, 150),
		content: bullet,
		type: 'project' as const,
		metadata: { source: 'curated-bullet', sourceDigest, migratedFrom },
	}
	const name = slugifyMemoryName(bullet)
	try {
		await store.create({ ...params, name })
		return true
	} catch (error) {
		if (!(error instanceof MemoryNameConflictError)) throw error
	}
	const holder = await store.getByName(name)
	if (holder?.content.metadata?.sourceDigest === sourceDigest) return false
	await store.create(params)
	return true
}

/**
 * Move what the JSON store held into typed files, once and safely again, and
 * say once per curated file whether it holds notes that could move.
 *
 * 1. A JSON store (`index.json` + `content/`) in `directory` is imported
 *    record by record with its ids, timestamps and status, then moved aside
 *    to `index.json.migrated` and `content.migrated`. A record the Markdown
 *    store refuses to write — over its size limit, or holding a NUL byte —
 *    is reported and stays in the retired files; stopping on it would leave
 *    `index.json` in place and the store refusing every operation for good.
 *    Any other failure leaves the JSON store where it is, to retry next launch.
 * 2. The project's curated `MEMORY.md` is NOT rewritten. When it holds
 *    single-line bullets that could be notes `#note` used to append, the
 *    report offers them — once per file, since the checkout's file and a
 *    subdirectory's own `.namzu/MEMORY.md` are different files — and
 *    `/memory import-notes` moves them when the operator asks. Until then
 *    they stay curated, read into every turn as before.
 */
export async function migrateMemoryOnce(options: {
	readonly store: MarkdownMemoryStore
	/** The store's directory, where a JSON store would have lived. */
	readonly directory: string
	readonly cwd: string
}): Promise<MemoryMigrationReport> {
	const { store, directory, cwd } = options
	const problems: string[] = []
	const skippedRecords: string[] = []
	let importedRecords = 0
	let notesOffer: MemoryMigrationReport['notesOffer']

	const indexPath = join(directory, 'index.json')
	if (await exists(indexPath)) {
		try {
			const disk = new DiskMemoryStore({ baseDir: directory, directory })
			const { entries } = await disk.list()
			const refused: { id: string; title: string; reason: string }[] = []
			for (const entry of entries) {
				const record = await disk.getRecord(entry.id)
				if (!record) continue
				try {
					if ((await store.importRecord(record, { type: 'project' })) === 'imported') {
						importedRecords++
					}
				} catch (error) {
					if (!(error instanceof MemoryContentRejectedError)) throw error
					refused.push({
						id: entry.id,
						title: entry.title,
						reason: error.message,
					})
				}
			}
			await retire(indexPath)
			const content = join(directory, 'content')
			const retiredContent = (await exists(content)) ? await retire(content) : content
			for (const record of refused) {
				skippedRecords.push(
					`"${record.title}" (${record.id}) was not moved: ${record.reason} It is kept in ${join(retiredContent, `${record.id}.json`)}.`,
				)
			}
		} catch (error) {
			problems.push(
				`The JSON memory store in ${directory} was not migrated: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	try {
		const location = projectMemoryLocation(cwd)
		const marker = await readMarker(directory)
		const state = marker.curatedFiles?.[location.path]
		if (!state?.offeredAt && !state?.movedAt) {
			const text = readMemoryFile(location)
			const { bullets } = text === null ? { bullets: [] } : splitCuratedBullets(text)
			if (bullets.length > 0) {
				notesOffer = { path: location.path, count: bullets.length }
				await markCuratedFile(directory, location.path, {
					offeredAt: new Date().toISOString(),
				})
			}
		}
	} catch (error) {
		problems.push(
			`Could not check the project's curated memory for notes: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	return {
		importedRecords,
		skippedRecords,
		...(notesOffer ? { notesOffer } : {}),
		problems,
	}
}

/**
 * Move the project's curated `#note`-shaped bullets into typed memory files,
 * because the operator asked (`/memory import-notes`). Idempotent: a bullet
 * already moved — by an interrupted earlier run or a concurrent one — is not
 * moved twice. The file's text before the move is kept beside it, and the
 * file is rewritten without the moved bullets only if nothing changed it
 * meanwhile.
 */
export async function importCuratedNotes(options: {
	readonly store: MarkdownMemoryStore
	readonly directory: string
	readonly cwd: string
}): Promise<CuratedNotesImport> {
	const { store, directory, cwd } = options
	const location = projectMemoryLocation(cwd)
	const text = readMemoryFile(location)
	if (text === null) return { path: location.path, moved: 0, kept: 0 }
	const { bullets, rest, kept } = splitCuratedBullets(text)
	if (bullets.length === 0) return { path: location.path, moved: 0, kept }
	// Digests of bullets an interrupted earlier run already moved.
	const moved = new Set<unknown>()
	for (const entry of (await store.list({})).entries) {
		moved.add((await store.get(entry.id))?.metadata?.sourceDigest)
	}
	let count = 0
	for (const bullet of bullets) {
		const sourceDigest = digest(bullet)
		if (moved.has(sourceDigest)) continue
		if (await moveBullet(store, bullet, sourceDigest, location.path)) count++
		moved.add(sourceDigest)
	}
	// This run's text, always: a second run moving bullets appended since the
	// first must not claim the first run's copy as "the file as it was".
	const backupPath = writeMemoryBackup(`${location.path}${BACKUP_SUFFIX}`, text)
	// A concurrent run that already rewrote it to the same text has done this
	// run's work; anything else is an edit to keep.
	if (!replaceMemoryFile(location, text, rest) && readMemoryFile(location) !== rest) {
		throw new Error(
			`${location.path} changed while its notes were being moved; the memories were saved, run /memory import-notes again to remove them from the file`,
		)
	}
	const earlier = (await readMarker(directory).catch(() => ({}) as MigrationMarker)).curatedFiles?.[
		location.path
	]
	await markCuratedFile(directory, location.path, {
		movedAt: new Date().toISOString(),
		// Memories this file's bullets became, across runs: what was created,
		// not what was found (an interrupted run's bullets are not counted twice).
		moved: (earlier?.moved ?? 0) + count,
	})
	return { path: location.path, moved: count, kept, backupPath }
}

/** Operator notices for a migration; empty when nothing moved, nothing is offered and nothing failed. */
export function describeMemoryMigration(
	report: MemoryMigrationReport,
	directory: string,
): string[] {
	const notices: string[] = []
	if (report.importedRecords > 0) {
		notices.push(
			`Stored memory: moved ${report.importedRecords} record${report.importedRecords === 1 ? '' : 's'} from the JSON store into Markdown files in ${directory}.`,
		)
	}
	for (const skipped of report.skippedRecords) notices.push(`Stored memory: ${skipped}`)
	if (report.notesOffer) {
		const { path, count } = report.notesOffer
		notices.push(
			`Stored memory: ${path} has ${count} single-line bullet${count === 1 ? '' : 's'} that may be notes #note saved before notes became typed memory files. They stay curated and still reach every turn. Run /memory import-notes to move them into ${directory} (the file as it was is kept beside it). New #note and /memory add notes are saved there already.`,
		)
	}
	notices.push(...report.problems)
	return notices
}

/** The operator's report for `/memory import-notes`. */
export function describeCuratedNotesImport(result: CuratedNotesImport, directory: string): string {
	const keptNote =
		result.kept > 0
			? ` ${result.kept} bullet${result.kept === 1 ? '' : 's'} stayed: a list starting directly under a heading is a section you wrote, and a bullet followed by a line that is not a bullet may run on into it. Prose and nested bullets always stay.`
			: ''
	if (!result.backupPath) {
		return `No single-line notes to move in ${result.path}.${keptNote}`
	}
	return `Moved ${result.moved} note${result.moved === 1 ? '' : 's'} from ${result.path} into typed memory files in ${directory}; the file as it was before this move is kept at ${result.backupPath}.${keptNote}`
}
