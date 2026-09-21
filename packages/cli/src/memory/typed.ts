/**
 * Stored memory: the typed, one-file-per-memory store the kernel's memory
 * tools read and write, as the CLI uses it.
 *
 * Three jobs live here. `saveTypedNote` is what `#note` and `/memory add`
 * write through. `composeStoredMemoryPrompt` turns the store's generated index
 * into the prompt section the model sees every turn. `migrateMemoryOnce`
 * moves what the two older shapes held — the project's curated bullets and
 * the JSON store — into typed files, once.
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
	type MemoryType,
	type RenderedMemoryIndex,
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
		'Memories saved in earlier sessions, one line each: `- [name](name.md) — description`. Read one with read_memory (by name) when it bears on the task. Correct or archive a wrong one with update_memory rather than saving a second copy. Memories are point-in-time: verify a file, function or flag a memory names against the current code before relying on it.',
		'',
		index.text,
	].join('\n')
}

/** What one launch's migration did, for the operator notice. */
export interface MemoryMigrationReport {
	readonly importedRecords: number
	readonly importedBullets: number
	/** The curated file the bullets came from, when any moved. */
	readonly curatedPath?: string
	/** Where the curated file's text before the move was kept. */
	readonly backupPath?: string
	/** Things that did not happen and why; the migration is retried next launch. */
	readonly problems: readonly string[]
}

/** Written once the curated bullets have moved, so later hand-written bullets stay curated. */
const MARKER = 'migration.json'
const BACKUP_SUFFIX = '.before-typed-memory'

interface MigrationMarker {
	readonly curatedBullets?: { readonly path: string; readonly at: string; readonly moved: number }
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

async function exists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

/** Move `path` aside to `path.migrated`, or a numbered name when that is taken. */
async function retire(path: string): Promise<void> {
	let target = `${path}.migrated`
	for (let n = 2; await exists(target); n++) target = `${path}.migrated-${n}`
	try {
		await rename(path, target)
	} catch (error) {
		// Another process retired it first.
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
}

/**
 * The single-line top-level bullets `appendMemory` wrote, and the text left
 * when they are removed. A bullet followed by a non-bullet, non-blank line is
 * left alone: a note typed over several lines was appended with its later
 * lines unindented, and they cannot be told apart from the operator's prose.
 */
export function splitCuratedBullets(text: string): { bullets: string[]; rest: string } {
	const lines = text.split('\n')
	const bullets: string[] = []
	const kept: string[] = []
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ''
		const match = /^- (\S.*)$/.exec(line.replace(/\r$/, ''))
		const next = (lines[i + 1] ?? '').replace(/\r$/, '')
		const ends = next.trim() === '' || /^- \S/.test(next)
		if (match?.[1] && ends) bullets.push(match[1].trim())
		else kept.push(line)
	}
	const rest = kept.join('\n').replace(/\n{3,}/g, '\n\n')
	return { bullets, rest: rest.trim() ? `${rest.trim()}\n` : '' }
}

/**
 * Move what the older memory shapes hold into typed files, once and safely
 * again: every step is idempotent, so a migration interrupted halfway is
 * finished by the next launch.
 *
 * 1. A JSON store (`index.json` + `content/`) in `directory` is imported
 *    record by record with its ids, timestamps and status, then moved aside
 *    to `index.json.migrated` and `content.migrated`.
 * 2. The project's curated `MEMORY.md` gives up its single-line bullets —
 *    what `#note` and `/memory add` used to append — as `project` memories.
 *    Its text before the move is kept beside it, and the file is rewritten
 *    without them only if nothing appended to it meanwhile. Headings, prose
 *    and multi-line notes stay. A marker then stops later hand-written
 *    bullets from moving: after this launch the file is the operator's again.
 *
 * The user-scope files are not touched: they hold what applies in every
 * project, and this store belongs to one.
 */
export async function migrateMemoryOnce(options: {
	readonly store: MarkdownMemoryStore
	/** The store's directory, where a JSON store would have lived. */
	readonly directory: string
	readonly cwd: string
}): Promise<MemoryMigrationReport> {
	const { store, directory, cwd } = options
	const problems: string[] = []
	let importedRecords = 0
	let importedBullets = 0
	let curatedPath: string | undefined
	let backupPath: string | undefined

	const indexPath = join(directory, 'index.json')
	if (await exists(indexPath)) {
		try {
			const disk = new DiskMemoryStore({ baseDir: directory, directory })
			const { entries } = await disk.list()
			for (const entry of entries) {
				const record = await disk.getRecord(entry.id)
				if (record && (await store.importRecord(record, { type: 'project' })) === 'imported') {
					importedRecords++
				}
			}
			await retire(indexPath)
			if (await exists(join(directory, 'content'))) await retire(join(directory, 'content'))
		} catch (error) {
			problems.push(
				`The JSON memory store in ${directory} was not migrated: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	const marker = await readMarker(directory).catch(() => ({}) as MigrationMarker)
	if (!marker.curatedBullets) {
		try {
			const location = projectMemoryLocation(cwd)
			const text = readMemoryFile(location)
			const { bullets, rest } =
				text === null ? { bullets: [], rest: '' } : splitCuratedBullets(text)
			if (text !== null && bullets.length > 0) {
				// Digests of bullets an interrupted earlier launch already moved.
				const moved = new Set<unknown>()
				for (const entry of (await store.list({})).entries) {
					moved.add((await store.get(entry.id))?.metadata?.sourceDigest)
				}
				for (const bullet of bullets) {
					const sourceDigest = digest(bullet)
					if (moved.has(sourceDigest)) continue
					await store.create({
						title: firstLine(bullet, 72),
						summary: firstLine(bullet, 300),
						description: firstLine(bullet, 150),
						content: bullet,
						type: 'project',
						metadata: { source: 'curated-bullet', sourceDigest, migratedFrom: location.path },
					})
					moved.add(sourceDigest)
					importedBullets++
				}
				backupPath = `${location.path}${BACKUP_SUFFIX}`
				writeMemoryBackup(backupPath, text)
				if (!replaceMemoryFile(location, text, rest)) {
					throw new Error(
						`${location.path} changed while its notes were being moved; retrying next launch`,
					)
				}
				curatedPath = location.path
			}
			await writeFile(
				join(directory, MARKER),
				`${JSON.stringify(
					{
						...marker,
						curatedBullets: {
							path: location.path,
							at: new Date().toISOString(),
							moved: bullets.length,
						},
					},
					null,
					2,
				)}\n`,
				{ mode: 0o600 },
			)
		} catch (error) {
			problems.push(
				`Project notes were not moved into stored memory: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	return {
		importedRecords,
		importedBullets,
		...(curatedPath ? { curatedPath } : {}),
		...(backupPath && curatedPath ? { backupPath } : {}),
		problems,
	}
}

/** Operator notices for a migration; empty when nothing moved and nothing failed. */
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
	if (report.importedBullets > 0 && report.curatedPath) {
		notices.push(
			`Stored memory: moved ${report.importedBullets} note${report.importedBullets === 1 ? '' : 's'} from ${report.curatedPath} into typed memory files in ${directory}${
				report.backupPath ? `; the file as it was is kept at ${report.backupPath}` : ''
			}. New #note and /memory add notes are saved there too.`,
		)
	}
	notices.push(...report.problems)
	return notices
}
