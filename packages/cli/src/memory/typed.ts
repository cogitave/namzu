/**
 * Stored memory: the typed, one-file-per-memory store the kernel's memory
 * tools read and write, as the CLI uses it.
 *
 * Four jobs live here. `saveTypedNote` is what `#note` and `/memory add`
 * write through. `composeStoredMemoryPrompt` turns the store's generated index
 * into the prompt section the model sees every turn. `migrateMemoryOnce`
 * moves the JSON store into typed files, once, and offers the project's
 * curated bullets; `importCuratedNotes` copies those when the operator asks,
 * never editing the curated file.
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

import { readMemoryFile } from './io.js'
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
		'Memories saved in earlier sessions, one line each: `- [name](name.md) — description`. Read one with read_memory (by name) when it bears on the task. Correct or archive a wrong one with update_memory rather than saving a second copy. Memories are point-in-time: verify a file, function or flag a memory names against the current code before relying on it. What earlier turns recorded on their own is not listed here; search_memory finds it.',
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
	 * The project's curated file holds top-level bullets, offered once per
	 * file: nothing is copied until the operator runs `/memory import-notes`,
	 * and the file itself is never changed.
	 */
	readonly notesOffer?: { readonly path: string; readonly count: number }
	/** Things that did not happen and why; the migration is retried next launch. */
	readonly problems: readonly string[]
}

/** What `/memory import-notes` did. The curated file is never changed. */
export interface CuratedNotesImport {
	readonly path: string
	/** Top-level bullets the file holds, each counted once. */
	readonly found: number
	/** Memories created by this turn. */
	readonly copied: number
	/** Bullets already in stored memory, by an earlier import, a `#note`, or by hand. */
	readonly alreadyStored: number
}

/** Records per curated file when it was offered and imported, so a launch offers it once. */
const MARKER = 'migration.json'

interface CuratedFileState {
	readonly offeredAt?: string
	readonly importedAt?: string
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

/**
 * The text of every top-level bullet (`- text`) in a curated file, each once,
 * in order. No bullet is judged to be a note or not: the file is never
 * changed, so copying one the operator wrote costs a memory they can archive,
 * never a line of their file. A nested bullet belongs to its parent and is not
 * taken; only a bullet's first line is.
 */
export function curatedBullets(text: string): string[] {
	const bullets = new Set<string>()
	for (const line of text.split('\n')) {
		const match = /^- (\S.*)$/.exec(line.replace(/\r$/, ''))
		const bullet = match?.[1]?.trim()
		if (bullet) bullets.add(bullet)
	}
	return [...bullets]
}

/**
 * Create the memory for one curated bullet, false when it is already stored.
 *
 * Under the name its text slugs to, first: the store refuses a taken name
 * inside its lock, so two turns copying the same bullet at once write it once,
 * the second finding the first's record by its source digest. A name held by
 * a memory with the same text is that bullet already stored; one held by an
 * unrelated memory falls back to a suffixed name.
 */
async function copyBullet(
	store: MarkdownMemoryStore,
	bullet: string,
	sourceDigest: string,
	importedFrom: string,
): Promise<boolean> {
	const params = {
		title: firstLine(bullet, 72),
		summary: firstLine(bullet, 300),
		description: firstLine(bullet, 150),
		content: bullet,
		type: 'project' as const,
		metadata: { source: 'curated-bullet', sourceDigest, importedFrom },
	}
	const name = slugifyMemoryName(bullet)
	try {
		await store.create({ ...params, name })
		return true
	} catch (error) {
		if (!(error instanceof MemoryNameConflictError)) throw error
	}
	const holder = await store.getByName(name)
	if (
		holder?.content.metadata?.sourceDigest === sourceDigest ||
		holder?.content.content.trim() === bullet
	) {
		return false
	}
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
 * 2. The project's curated `MEMORY.md` is never changed. When it holds
 *    top-level bullets — some may be notes `#note` used to append — the
 *    report offers them once per file, since the checkout's file and a
 *    subdirectory's own `.namzu/MEMORY.md` are different files, and
 *    `/memory import-notes` copies them into typed memories when the
 *    operator asks. They stay curated, read into every turn as before, until
 *    the operator deletes them from the file.
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
		if (!state?.offeredAt && !state?.importedAt) {
			const text = readMemoryFile(location)
			const bullets = text === null ? [] : curatedBullets(text)
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
 * Copy the project's curated bullets into typed memory files, because the
 * operator asked (`/memory import-notes`). The curated file is read, never
 * written: deleting a bullet from it is the operator's call. Idempotent: a
 * bullet already stored — by an earlier or concurrent import, as a `#note`
 * with the same text, or under its name with the same text — is not copied
 * again.
 */
export async function importCuratedNotes(options: {
	readonly store: MarkdownMemoryStore
	readonly directory: string
	readonly cwd: string
}): Promise<CuratedNotesImport> {
	const { store, directory, cwd } = options
	const location = projectMemoryLocation(cwd)
	const text = readMemoryFile(location)
	const bullets = text === null ? [] : curatedBullets(text)
	if (bullets.length === 0) {
		return { path: location.path, found: 0, copied: 0, alreadyStored: 0 }
	}
	// Digests of what is stored already, archived memories included: a copy
	// the operator archived stays archived rather than coming back.
	const stored = new Set<unknown>()
	for (const entry of (await store.list({})).entries) {
		const metadata = (await store.get(entry.id))?.metadata
		stored.add(metadata?.sourceDigest)
		stored.add(metadata?.noteDigest)
	}
	let copied = 0
	for (const bullet of bullets) {
		const sourceDigest = digest(bullet)
		if (stored.has(sourceDigest)) continue
		if (await copyBullet(store, bullet, sourceDigest, location.path)) copied++
		stored.add(sourceDigest)
	}
	await markCuratedFile(directory, location.path, { importedAt: new Date().toISOString() })
	return {
		path: location.path,
		found: bullets.length,
		copied,
		alreadyStored: bullets.length - copied,
	}
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
			`Stored memory: ${path} has ${count} top-level bullet${count === 1 ? '' : 's'}, some perhaps notes #note saved before notes became typed memory files. They stay curated and still reach every turn. Run /memory import-notes to copy them into ${directory} as typed memories; the curated file is never changed. New #note and /memory add notes are saved there already.`,
		)
	}
	notices.push(...report.problems)
	return notices
}

/** The operator's report for `/memory import-notes`. */
export function describeCuratedNotesImport(result: CuratedNotesImport, directory: string): string {
	if (result.found === 0) {
		return `No top-level bullets to copy in ${result.path}; it is unchanged.`
	}
	const plural = (n: number) => (n === 1 ? '' : 's')
	const already =
		result.alreadyStored > 0
			? ` ${result.alreadyStored} ${result.alreadyStored === 1 ? 'was' : 'were'} already stored and not copied again.`
			: ''
	return `Copied ${result.copied} of ${result.found} bullet${plural(result.found)} from ${result.path} into typed memory files in ${directory}.${already} ${result.path} is unchanged: its bullets are still curated text in every turn. Delete the ones you no longer want there yourself.`
}
