/**
 * What Desktop Settings does with the person's own memory: the standing instructions every
 * conversation starts from, and the project's saved memories (see, edit, delete). Both read the
 * same files the terminal app reads, so a change here is a change there.
 *
 * Nothing here calls a model and nothing is sent anywhere. A project's own files cannot reach
 * these methods: they act on the person's Namzu home only.
 */

import { createHash } from 'node:crypto'
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { MarkdownMemoryStore, SessionPaths } from '@namzu/sdk'
import { INSTRUCTIONS_FILENAME, MAX_BYTES_TO_READ, MAX_CHARS_PER_FILE } from '../context/project.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { findProject } from '../integrations/state/project-lookup.js'
import { cliProjectRoot } from '../integrations/state/project.js'
import {
	type ManagedMemory,
	deleteManagedMemory,
	loadManagedMemories,
	readMemoryBody,
	updateManagedMemory,
} from '../memory/manage.js'

/** What a saved memory's text may hold when it is edited here. */
export const MEMORY_TEXT_MAX = 8_000
const MEMORY_TITLE_MAX = 120
const MEMORY_SUMMARY_MAX = 240
const EXCERPT_MAX = 400

export interface StandingInstructionsAnswer {
	readonly text: string
	/** How many characters are followed; more is cut when a conversation reads the file. */
	readonly limit: number
	/** A fingerprint of the text read; saving names it, and is refused when the file moved on. */
	readonly revision: string
	/** Set when a save was refused because the file changed since it was read: the text is the current one. */
	readonly changed?: true
	/** The file cannot be edited here (a link, or a folder in its place); the person edits it by hand. */
	readonly locked?: true
}

const revisionOf = (text: string): string => createHash('sha256').update(text).digest('hex')

function instructionsPath(): string {
	return join(resolveNamzuHome(), INSTRUCTIONS_FILENAME)
}

/** The person's own instructions file, read as it is now (never a copy). */
export function readStandingInstructions(): StandingInstructionsAnswer {
	const file = instructionsPath()
	let stat: ReturnType<typeof lstatSync>
	try {
		stat = lstatSync(file)
	} catch {
		return { text: '', limit: MAX_CHARS_PER_FILE, revision: revisionOf('') }
	}
	if (!stat.isFile() || stat.size > MAX_BYTES_TO_READ)
		return { text: '', limit: MAX_CHARS_PER_FILE, revision: revisionOf(''), locked: true }
	const text = readFileSync(file, 'utf8')
	return { text, limit: MAX_CHARS_PER_FILE, revision: revisionOf(text) }
}

/**
 * Saves the text as the person's instructions; empty text removes the file. When `revision` is
 * given and the file is no longer the version it names, nothing is written and the current text
 * comes back marked `changed`, so an edit made elsewhere is never overwritten unseen.
 */
export function writeStandingInstructions(
	text: unknown,
	revision?: unknown,
): StandingInstructionsAnswer {
	if (typeof text !== 'string') throw new Error('Invalid text.')
	if (revision !== undefined && (typeof revision !== 'string' || revision.length > 200))
		throw new Error('Invalid revision.')
	if (text.length > MAX_CHARS_PER_FILE)
		throw new Error(`Standing instructions can hold ${MAX_CHARS_PER_FILE} characters.`)
	const file = instructionsPath()
	if (lstatSafe(file) && !lstatSync(file).isFile())
		throw new Error('This file is a link or a folder; edit it by hand.')
	if (revision !== undefined) {
		const now = readStandingInstructions()
		if (now.revision !== revision) return { ...now, changed: true }
	}
	if (text.trim() === '') {
		if (lstatSafe(file)) unlinkSync(file)
		return { text: '', limit: MAX_CHARS_PER_FILE, revision: revisionOf('') }
	}
	// The Namzu home is owner-only when Namzu is the one creating it.
	mkdirSync(resolveNamzuHome(), { recursive: true, mode: 0o700 })
	// Written beside the file and moved into place, so a reader never sees half of it.
	const staging = `${file}.${process.pid}.tmp`
	try {
		writeFileSync(staging, text, { encoding: 'utf8', mode: 0o600 })
		renameSync(staging, file)
	} catch (error) {
		if (lstatSafe(staging)) unlinkSync(staging)
		throw error
	}
	return { text, limit: MAX_CHARS_PER_FILE, revision: revisionOf(text) }
}

function lstatSafe(file: string): boolean {
	try {
		lstatSync(file)
		return true
	} catch {
		return false
	}
}

export interface SavedMemoryView {
	readonly id: string
	readonly title: string
	readonly type?: string
	/** `you`, `namzu` or `conversation`: who saved it. */
	readonly origin: 'you' | 'namzu' | 'conversation'
	readonly state: 'active' | 'set-aside' | 'retired'
	readonly createdAt: number
	readonly updatedAt: number
	readonly revision: string
	readonly excerpt: string
}

export interface SavedMemoriesAnswer {
	/** False when this folder has no project yet: there is nothing saved to show. */
	readonly project: boolean
	readonly memories: readonly SavedMemoryView[]
}

function originOf(item: ManagedMemory): SavedMemoryView['origin'] {
	if (item.origin === 'operator') return 'you'
	if (item.origin === 'model') return 'namzu'
	return 'conversation'
}

async function openStore(cwd: string): Promise<MarkdownMemoryStore | undefined> {
	const root = resolveNamzuHome()
	const project = await findProject(root, cliProjectRoot(await realpath(resolve(cwd))))
	if (!project) return undefined
	const directory = join(
		new SessionPaths({ home: root, slug: project.slug }).projectDir(),
		'memory',
	)
	if (!existsSync(directory)) return undefined
	const entry = lstatSync(directory)
	if (entry.isSymbolicLink() || !entry.isDirectory())
		throw new Error('Saved memory is not in a folder Namzu can use.')
	return new MarkdownMemoryStore({ directory })
}

const flat = (text: string, max: number): string => {
	const line = text.replace(/\s+/g, ' ').trim()
	return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Looks up one listed memory, so a change names exactly what the person saw. */
function target(params: Record<string, unknown>): { id: ManagedMemory['id']; revision: string } {
	const { id, revision } = params
	if (typeof id !== 'string' || id === '' || id.length > 200) throw new Error('Invalid id.')
	if (typeof revision !== 'string' || revision === '' || revision.length > 200)
		throw new Error('Invalid revision.')
	return { id: id as ManagedMemory['id'], revision }
}

export const MEMORY_HOST_METHODS = [
	'namzu/instructions/get',
	'namzu/instructions/set',
	'namzu/memory/list',
	'namzu/memory/read',
	'namzu/memory/update',
	'namzu/memory/delete',
] as const

export function createMemoryHost(cwd: string, pal: () => unknown) {
	const refusePal = () => {
		if (pal()) throw new Error('Pals do not use the person’s own memory.')
	}
	const only = (params: Record<string, unknown>, keys: readonly string[], what: string) => {
		if (!params || typeof params !== 'object' || Array.isArray(params))
			throw new Error(`Invalid ${what} request.`)
		if (Object.keys(params).some((key) => !keys.includes(key)))
			throw new Error(`Invalid ${what} request.`)
	}
	return {
		'namzu/instructions/get': (params: Record<string, unknown> = {}) => {
			refusePal()
			only(params, [], 'instructions')
			return readStandingInstructions()
		},
		'namzu/instructions/set': (params: Record<string, unknown>) => {
			refusePal()
			only(params, ['text', 'revision'], 'instructions')
			return writeStandingInstructions(params.text, params.revision)
		},
		'namzu/memory/list': async (
			params: Record<string, unknown> = {},
		): Promise<SavedMemoriesAnswer> => {
			refusePal()
			only(params, [], 'memory')
			const store = await openStore(cwd)
			if (!store) return { project: false, memories: [] }
			const items = await loadManagedMemories(store, '')
			const memories: SavedMemoryView[] = []
			for (const item of items) {
				const body = (await readMemoryBody(store, item.id)) ?? ''
				memories.push({
					id: item.id,
					title: item.title,
					...(item.type ? { type: item.type } : {}),
					origin: originOf(item),
					state: item.state ?? 'active',
					createdAt: item.createdAt,
					updatedAt: item.updatedAt,
					revision: item.revision,
					excerpt: flat(body, EXCERPT_MAX),
				})
			}
			return { project: true, memories }
		},
		/** One memory whole, with the version an edit or delete must name. */
		'namzu/memory/read': async (params: Record<string, unknown>) => {
			refusePal()
			only(params, ['id'], 'memory')
			const { id } = params
			if (typeof id !== 'string' || id === '' || id.length > 200) throw new Error('Invalid id.')
			const store = await openStore(cwd)
			const record = store ? await store.getVersionedRecord(id as ManagedMemory['id']) : undefined
			if (!record) return { found: false as const }
			return {
				found: true as const,
				id,
				title: record.entry.title,
				text: record.content.content,
				revision: record.revision,
				updatedAt: record.entry.updatedAt,
			}
		},
		'namzu/memory/update': async (params: Record<string, unknown>) => {
			refusePal()
			only(params, ['id', 'revision', 'text', 'title'], 'memory')
			const item = target(params)
			const { text, title } = params
			if (typeof text !== 'string' || text.trim() === '' || text.length > MEMORY_TEXT_MAX)
				throw new Error('Invalid text.')
			if (
				title !== undefined &&
				(typeof title !== 'string' || title.trim() === '' || title.length > MEMORY_TITLE_MAX)
			)
				throw new Error('Invalid title.')
			const store = await openStore(cwd)
			if (!store) return { outcome: 'gone' as const }
			const outcome = await updateManagedMemory(store, item, {
				content: text,
				...(title === undefined ? {} : { title: title.trim() }),
				summary: flat(text, MEMORY_SUMMARY_MAX),
				// The index line every later prompt carries must not keep the wording that was replaced.
				description: flat(text, MEMORY_SUMMARY_MAX),
			})
			return { outcome }
		},
		/** Final for this one memory; the conversation's own log keeps a copy until it is cleared. */
		'namzu/memory/delete': async (params: Record<string, unknown>) => {
			refusePal()
			only(params, ['id', 'revision'], 'memory')
			const item = target(params)
			const store = await openStore(cwd)
			if (!store) return { outcome: 'gone' as const }
			return { outcome: await deleteManagedMemory(store, item) }
		},
	}
}
