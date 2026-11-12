import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { KernelFs } from './fs.js'

/** files.json: the list every other file of a kernel folder is checked against. */

export const FILES_LIST_NAME = 'files.json'
export const KERNEL_FACTS_NAME = 'kernel.json'
const MAX_PATH_BYTES = 1024
const MAX_SEGMENT_BYTES = 255

export interface ListedFile {
	path: string
	size: number
	sha256: string
}

export interface FilesList {
	schema: 1
	files: ListedFile[]
}

export class FilesListError extends Error {
	constructor(
		readonly code: 'format' | 'name' | 'collision',
		message: string,
	) {
		super(message)
		this.name = 'FilesListError'
	}
}

const RESERVED_DEVICE =
	/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)$/iu

/** Why a name is not allowed in a kernel folder, or undefined when it is. */
export function refuseName(name: string): string | undefined {
	if (name.length === 0) return 'an empty name'
	const bytes = Buffer.byteLength(name, 'utf8')
	if (bytes > MAX_PATH_BYTES) return 'a name that is too long'
	if (Buffer.from(name, 'utf8').toString('utf8') !== name) return 'a name that is not text'
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
	if (/[\u0000-\u001f\u007f]/u.test(name)) return 'a control character in a name'
	if (name.startsWith('/')) return 'an absolute path'
	if (/^[A-Za-z]:/u.test(name)) return 'a drive letter'
	if (name.includes('\\')) return 'a backslash in a name'
	if (name.includes(':')) return 'a colon in a name'
	for (const segment of name.split('/')) {
		if (segment === '') return 'an empty segment in a name'
		if (segment === '.' || segment === '..') return 'a . or .. segment in a name'
		if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES) return 'a segment that is too long'
		if (/[. ]$/u.test(segment)) return 'a segment that ends with a dot or a space'
		// A device name is reserved with an extension and with spaces before it ("con .txt").
		const stem = (segment.split('.')[0] ?? '').replace(/ +$/u, '')
		if (/[<>|?*"]/u.test(segment)) return 'a character a Windows file name cannot hold'
		if (RESERVED_DEVICE.test(stem)) return 'a reserved device name'
	}
	return undefined
}

/** The key two names share when a case-insensitive disk would put them in one place. */
export function foldName(name: string): string {
	return name.normalize('NFC').toUpperCase().toLowerCase()
}

/** Refuses names that collide once case is folded, or where a file is also a folder. */
export function findCollision(names: readonly string[]): string | undefined {
	// files.json sits at the root of the folder, so a name that folds to it would be the same file.
	const files = new Set<string>([foldName(FILES_LIST_NAME)])
	const folders = new Set<string>()
	for (const name of names) {
		const key = foldName(name)
		if (files.has(key)) return `two names that are one after case folding (${name})`
		files.add(key)
		const parts = key.split('/')
		for (let end = 1; end < parts.length; end++) folders.add(parts.slice(0, end).join('/'))
	}
	for (const folder of folders)
		if (files.has(folder)) return `a name that is a file and a folder (${folder})`
	return undefined
}

function compareUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

/** Strict: fields, name rules, unique names, sorted by code unit order. */
export function parseFilesList(bytes: Uint8Array): FilesList {
	let value: unknown
	let text: string
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		value = JSON.parse(text)
	} catch {
		throw new FilesListError('format', 'files.json is not valid JSON.')
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new FilesListError('format', 'files.json is not an object.')
	const record = value as Record<string, unknown>
	for (const key of Object.keys(record))
		if (key !== 'schema' && key !== 'files')
			throw new FilesListError('format', `Unknown field ${key} in files.json.`)
	if (record.schema !== 1 || !Array.isArray(record.files))
		throw new FilesListError('format', 'files.json has an unknown shape.')
	const files: ListedFile[] = []
	let previous: string | undefined
	for (const raw of record.files as unknown[]) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw))
			throw new FilesListError('format', 'A file entry is not an object.')
		const entry = raw as Record<string, unknown>
		for (const key of Object.keys(entry))
			if (key !== 'path' && key !== 'size' && key !== 'sha256')
				throw new FilesListError('format', `Unknown field ${key} in a file entry.`)
		const { path, size, sha256 } = entry
		if (typeof path !== 'string') throw new FilesListError('format', 'A file path is not text.')
		const refusal = refuseName(path)
		if (refusal) throw new FilesListError('name', `files.json lists ${refusal}.`)
		if (path === FILES_LIST_NAME) throw new FilesListError('name', 'files.json lists itself.')
		if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
			throw new FilesListError('format', `Bad size for ${path}.`)
		if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256))
			throw new FilesListError('format', `Bad hash for ${path}.`)
		if (previous !== undefined && compareUnits(previous, path) >= 0)
			throw new FilesListError('format', 'files.json is not sorted, or repeats a path.')
		previous = path
		files.push({ path, size, sha256 })
	}
	const collision = findCollision(files.map((file) => file.path))
	if (collision) throw new FilesListError('collision', `files.json lists ${collision}.`)
	// One reading only (specification 3.2): JSON.stringify(value) and one newline, so a repeated key
	// or another layout cannot be read two ways.
	if (`${JSON.stringify({ schema: 1, files })}\n` !== text)
		throw new FilesListError(
			'format',
			'files.json is not serialised as JSON.stringify(value) and one newline.',
		)
	return { schema: 1, files }
}

export function sha512Hex(bytes: Uint8Array): string {
	return createHash('sha512').update(bytes).digest('hex')
}

export async function hashFile(
	fs: KernelFs,
	path: string,
): Promise<{ size: number; sha256: string }> {
	const hash = createHash('sha256')
	let size = 0
	for await (const chunk of fs.openRead(path)) {
		hash.update(chunk)
		size += chunk.length
	}
	return { size, sha256: hash.digest('hex') }
}

/** The path inside a kernel folder, with the platform's separators. */
export function inFolder(folder: string, relative: string): string {
	return join(folder, ...relative.split('/'))
}

async function checkOne(
	fs: KernelFs,
	folder: string,
	file: ListedFile,
): Promise<string | undefined> {
	const path = inFolder(folder, file.path)
	const info = await fs.stat(path)
	if (!info) return `${file.path} is missing`
	if (info.type !== 'file') return `${file.path} is not a plain file`
	if (info.size !== file.size) return `${file.path} has the wrong size`
	const actual = await hashFile(fs, path)
	if (actual.size !== file.size || actual.sha256 !== file.sha256)
		return `${file.path} does not match its hash`
	return undefined
}

/**
 * The full check after extraction: the folder holds exactly the listed files (and
 * files.json), every one with its size and hash, and nothing else, no link included.
 * Returns the first problem, or undefined.
 */
export async function verifyFolderFully(
	fs: KernelFs,
	folder: string,
	list: FilesList,
): Promise<string | undefined> {
	const expected = new Set<string>([FILES_LIST_NAME, ...list.files.map((file) => file.path)])
	const found: string[] = []
	async function walk(relative: string): Promise<string | undefined> {
		const here = relative === '' ? folder : inFolder(folder, relative)
		for (const name of await fs.readdir(here)) {
			const child = relative === '' ? name : `${relative}/${name}`
			const info = await fs.stat(inFolder(folder, child))
			if (!info) return `${child} vanished`
			if (info.type === 'directory') {
				const problem = await walk(child)
				if (problem) return problem
			} else if (info.type === 'file') found.push(child)
			else return `${child} is not a plain file`
		}
		return undefined
	}
	const walked = await walk('')
	if (walked) return walked
	for (const path of found) if (!expected.has(path)) return `${path} is not listed`
	for (const file of list.files) {
		const problem = await checkOne(fs, folder, file)
		if (problem) return problem
	}
	return undefined
}

/** The files the quick check hashes on every start: the entry, the package file, the facts, natives. */
export function quickCheckFiles(list: FilesList): ListedFile[] | string {
	const wanted = new Set(['dist/bin.js', 'package.json', KERNEL_FACTS_NAME])
	const picked = list.files.filter((file) => wanted.has(file.path) || file.path.endsWith('.node'))
	for (const name of wanted)
		if (!picked.some((file) => file.path === name)) return `${name} is not in the file list`
	return picked
}

export async function verifyQuickFiles(
	fs: KernelFs,
	folder: string,
	list: FilesList,
): Promise<string | undefined> {
	const picked = quickCheckFiles(list)
	if (typeof picked === 'string') return picked
	for (const file of picked) {
		const problem = await checkOne(fs, folder, file)
		if (problem) return problem
	}
	return undefined
}
