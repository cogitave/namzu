import { type Hash, createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { CONFIG_FILE, CONFIG_SECTIONS, entryKind } from './folder-settings.js'

/**
 * A digest of what a folder carries that runs code or widens what may run: the same nine
 * `namzu.config.json` sections and the `.namzu` trees the CLI's project digest covers
 * (`packages/cli/src/schedule/store/digest.ts`) plus the skills and agents it loads. Desktop cannot import the CLI, so the list
 * is shared with `folder-settings.ts` and a test compares it with the CLI's source.
 *
 * `parts` keeps one hash per piece so a change can be named, not only noticed. A link records its target and
 * the content behind it; a part too large to read is reported changed every time.
 */
export interface FolderFingerprint {
	algo: 'sha256'
	digest: string
	parts: Record<string, string>
}

/** Past these the content is not read; the part is then reported as changed every time. */
const FILE_CAP = 64 * 1024 * 1024
const BYTES_CAP = 256 * 1024 * 1024
const ENTRIES = 20000
const CONFIG_BYTES = 32 * 1024 * 1024
const TREES = ['commands', 'plugins', 'skills', 'agents'] as const

function sha(text: string | Buffer): string {
	return createHash('sha256').update(text).digest('hex')
}

/**
 * A part that cannot be checked (too large, too many entries). A fresh value each time, so it
 * never equals a stored one and the folder is asked about instead of trusted unseen.
 */
function uncheckable(): string {
	return `uncheckable:${randomUUID()}`
}

/** Key order must not matter: an editor that reorders keys is not a change. */
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
	if (value && typeof value === 'object')
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
			.join(',')}}`
	return JSON.stringify(value) ?? 'null'
}

interface Walk {
	budget: number
	seen: number
	over: boolean
}

async function hashFile(path: string, size: number, hash: Hash, walk: Walk): Promise<void> {
	if (size > FILE_CAP || size > walk.budget) {
		walk.over = true
		return
	}
	walk.budget -= size
	try {
		await pipeline(createReadStream(path), async (source) => {
			for await (const chunk of source) hash.update(chunk as Buffer)
		})
	} catch {
		hash.update('unreadable')
	}
}

/**
 * Hash one entry by what it holds. A link records where it points and then what is behind
 * it, since the CLI reads through links.
 */
async function hashEntry(path: string, walk: Walk, hash: Hash, depth: number): Promise<void> {
	let info: Awaited<ReturnType<typeof lstat>>
	try {
		info = await lstat(path)
	} catch {
		hash.update('gone')
		return
	}
	if (info.isSymbolicLink()) {
		let target = ''
		try {
			target = await readlink(path)
		} catch {
			// An unreadable link still counts as a link.
		}
		hash.update(`link:${target}:`)
		if (depth >= 8) {
			walk.over = true
			return
		}
		let real: string
		try {
			real = await realpath(path)
		} catch {
			hash.update('dangling')
			return
		}
		await hashEntry(real, walk, hash, depth + 1)
		return
	}
	if (info.isDirectory()) {
		hash.update('dir{')
		let names: string[]
		try {
			names = (await readdir(path)).sort()
		} catch {
			hash.update('unreadable}')
			return
		}
		for (const name of names) {
			if (name === 'node_modules' || name === '.git') {
				hash.update(`skip:${name}\0`)
				continue
			}
			if (walk.seen++ >= ENTRIES) {
				walk.over = true
				return
			}
			hash.update(`${name}=`)
			await hashEntry(join(path, name), walk, hash, depth)
			hash.update('\0')
		}
		hash.update('}')
		return
	}
	if (info.isFile()) {
		hash.update(`file:${info.size}:`)
		await hashFile(path, info.size, hash, walk)
		return
	}
	hash.update('other')
}

async function treeParts(
	directory: string,
	prefix: string,
	parts: Record<string, string>,
): Promise<void> {
	const walk: Walk = { budget: BYTES_CAP, seen: 0, over: false }
	const kind = await entryKind(directory)
	if (kind === undefined) return
	if (kind === 'link') {
		const hash = createHash('sha256')
		await hashEntry(directory, walk, hash, 0)
		parts[prefix] = walk.over ? uncheckable() : hash.digest('hex')
		return
	}
	if (kind !== 'directory') return
	let top: string[]
	try {
		top = (await readdir(directory)).sort()
	} catch {
		parts[prefix] = 'unreadable'
		return
	}
	if (top.length > ENTRIES) {
		parts[prefix] = uncheckable()
		return
	}
	for (const name of top) {
		const hash = createHash('sha256')
		await hashEntry(join(directory, name), walk, hash, 0)
		parts[`${prefix}/${name}`] = walk.over ? uncheckable() : hash.digest('hex')
		if (walk.over) walk.over = false
	}
}

export async function folderFingerprint(folder: string): Promise<FolderFingerprint> {
	const parts: Record<string, string> = {}
	const config = join(folder, CONFIG_FILE)
	const kind = await entryKind(config)
	if (kind === 'link' || kind === 'file') {
		// Through a link too: the CLI reads the file it points at.
		const walk: Walk = { budget: CONFIG_BYTES, seen: 0, over: false }
		if (kind === 'link') {
			const hash = createHash('sha256')
			await hashEntry(config, walk, hash, 0)
			parts.config = walk.over ? uncheckable() : `link:${hash.digest('hex')}`
		}
		try {
			const text = await readFile(config, 'utf8')
			if (Buffer.byteLength(text) > CONFIG_BYTES) parts.config = uncheckable()
			else {
				let parsed: unknown
				try {
					parsed = JSON.parse(text)
				} catch {
					parts.config = `invalid:${sha(text)}`
				}
				if (parsed && typeof parsed === 'object') {
					for (const [key] of CONFIG_SECTIONS) {
						const value = (parsed as Record<string, unknown>)[key]
						if (value === undefined || value === null) continue
						if (typeof value === 'object' && Object.keys(value as object).length === 0) continue
						parts[`config:${key}`] = sha(stable(value))
					}
				}
			}
		} catch {
			parts.config ??= 'unreadable'
		}
	}
	const state = join(folder, '.namzu')
	if ((await entryKind(state)) === 'link') {
		const walk: Walk = { budget: BYTES_CAP, seen: 0, over: false }
		const hash = createHash('sha256')
		await hashEntry(state, walk, hash, 0)
		parts['.namzu'] = walk.over ? uncheckable() : `link:${hash.digest('hex')}`
	} else for (const tree of TREES) await treeParts(join(state, tree), tree, parts)
	const digest = sha(
		Object.keys(parts)
			.sort()
			.map((key) => `${key}=${parts[key]}`)
			.join('\n'),
	)
	return { algo: 'sha256', digest, parts }
}

const SECTION_LABEL: Record<string, string> = {
	hooks: 'hooks',
	mcpServers: 'MCP servers',
	plugins: 'plugins',
	permissions: 'permission rules',
	permissionChecks: 'permission checks',
	sandbox: 'sandbox settings',
	web: 'web settings',
	additionalDirectories: 'extra directories',
	profiles: 'profiles',
}

/** The words for a part key, e.g. `config:hooks` reads "hooks", `plugins/a.js` "plugin a.js". */
export function partLabel(key: string): string {
	if (key === 'config') return CONFIG_FILE
	if (key === '.namzu') return '.namzu'
	if (key.startsWith('config:')) {
		const section = key.slice('config:'.length)
		return SECTION_LABEL[section] ?? section
	}
	const slash = key.indexOf('/')
	if (slash < 0) return `.namzu/${key}`
	const head = key.slice(0, slash)
	const kind =
		head === 'plugins'
			? 'plugin'
			: head === 'skills'
				? 'skill'
				: head === 'agents'
					? 'agent'
					: 'command'
	return `${kind} ${key.slice(slash + 1).slice(0, 80)}`
}

/** Sentences-in-pieces naming what differs, in a stable order; empty when nothing does. */
export function fingerprintChanges(
	stored: Pick<FolderFingerprint, 'parts'>,
	now: Pick<FolderFingerprint, 'parts'>,
): string[] {
	const out: string[] = []
	for (const key of [
		...new Set([...Object.keys(stored.parts), ...Object.keys(now.parts)]),
	].sort()) {
		const before = stored.parts[key]
		const after = now.parts[key]
		if (before === after) continue
		out.push(
			`${partLabel(key)} ${before === undefined ? 'added' : after === undefined ? 'removed' : 'changed'}`,
		)
	}
	return out
}

export { SECTION_LABEL }
