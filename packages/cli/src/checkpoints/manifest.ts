/**
 * What a turn's file history looks like on disk.
 *
 *   <root>/turns/<turnId>.json   one manifest per turn, version 1
 *   <root>/blobs/<sha256>        content-addressed file bodies, before and after
 *
 * Every write is temp-file, fsync, rename: a reader, or a crash, sees the
 * old file or the new one, never half. Blobs are immutable, so two turns
 * (or a fork and its parent) share one body, and a body is verified against
 * its name before it is ever written back over a user's file.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const MANIFEST_VERSION = 1

export interface BlobRef {
	/** Full sha256, hex. */
	readonly sha256: string
	readonly size: number
	/** Permission bits, so an undo does not reset them. */
	readonly mode: number
	/** False when the body was too large to keep: the hash still identifies it. */
	readonly stored?: boolean
}

export type EntryState = 'pending' | 'done' | 'failed'

export interface ManifestEntry {
	/** Absolute, symlinks resolved. */
	path: string
	/** Relative to the project folder, for display. */
	rel: string
	/** `cwd`, or `additional:<n>` once extra directories are covered. */
	root: string
	before: BlobRef | null
	after: BlobRef | null
	tool: string
	toolUseId: string
	state: EntryState
}

export type SkipReason = 'too-large' | 'outside-cwd' | 'sandbox' | 'snapshot-failed'

export type TurnStatus = 'applied' | 'undone' | 'partially_undone'

export interface Manifest {
	version: 1
	turnId: string
	seq: number
	label: string
	startedAt: number
	/** Last time an edit settled in this turn; retention counts from here. */
	lastEditAt: number
	status: TurnStatus
	undone?: { at: number; by: string; files: string[] }
	/** Bodies saved when an undo went ahead over a file the operator had changed. */
	copies?: { path: string; sha256: string; size: number; mode: number; at: number }[]
	entries: ManifestEntry[]
	skipped: { path: string; reason: SkipReason }[]
	/** A shell call ran in this turn: undo cannot reverse what it changed. */
	uncoveredShell: boolean
	/** Retention removed this turn's bodies. */
	pruned?: boolean
	/** Set on a manifest a fork adopted from its parent. */
	forkedFrom?: string
}

const SHA = /^[0-9a-f]{64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** A turn id is a file name: refuse anything that could leave the directory. */
export function isSafeTurnId(id: string): boolean {
	return SAFE_ID.test(id) && !id.includes('..')
}

export const turnsDir = (root: string): string => join(root, 'turns')
export const blobsDir = (root: string): string => join(root, 'blobs')
export const manifestPath = (root: string, turnId: string): string =>
	join(turnsDir(root), `${turnId}.json`)
export const blobPath = (root: string, sha256: string): string => join(blobsDir(root), sha256)

export function hashBytes(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex')
}

/** Streams, so a file past the snapshot cap is identified without being held. */
export function hashFile(path: string): Promise<string> {
	return new Promise((resolveHash, reject) => {
		const h = createHash('sha256')
		createReadStream(path)
			.on('data', (chunk) => h.update(chunk))
			.on('error', reject)
			.on('end', () => resolveHash(h.digest('hex')))
	})
}

let tempCounter = 0
const tempName = (path: string): string =>
	`${path}.${process.pid}.${tempCounter++}.${randomBytes(3).toString('hex')}.tmp`

/** Publish `data` at `path`: fsynced temp file, then rename. */
export async function writeDurable(path: string, data: Uint8Array | string): Promise<void> {
	const temp = tempName(path)
	try {
		const handle = await open(temp, 'w')
		try {
			await handle.writeFile(data)
			await handle.sync()
		} finally {
			await handle.close()
		}
		await rename(temp, path)
	} catch (err) {
		await unlink(temp).catch(() => undefined)
		throw err
	}
}

export async function putBlob(root: string, data: Uint8Array): Promise<string> {
	const sha = hashBytes(data)
	const path = blobPath(root, sha)
	const present = await stat(path).then(
		(s) => s.size === data.byteLength,
		() => false,
	)
	if (present) return sha
	await mkdir(blobsDir(root), { recursive: true })
	await writeDurable(path, data)
	return sha
}

export class BlobUnavailableError extends Error {
	constructor(
		readonly sha256: string,
		why: string,
	) {
		super(`The saved copy ${sha256.slice(0, 12)} is ${why}.`)
		this.name = 'BlobUnavailableError'
	}
}

/** The body, checked against its name: a damaged blob is never written back. */
export async function readBlob(root: string, sha256: string): Promise<Buffer> {
	let data: Buffer
	try {
		data = await readFile(blobPath(root, sha256))
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new BlobUnavailableError(sha256, 'missing')
		}
		throw err
	}
	if (hashBytes(data) !== sha256) throw new BlobUnavailableError(sha256, 'damaged')
	return data
}

export const blobExists = (root: string, sha256: string): Promise<boolean> =>
	stat(blobPath(root, sha256)).then(
		(s) => s.isFile(),
		() => false,
	)

export async function writeManifest(root: string, manifest: Manifest): Promise<void> {
	if (!isSafeTurnId(manifest.turnId)) throw new Error(`Unsafe turn id ${manifest.turnId}.`)
	await mkdir(turnsDir(root), { recursive: true })
	await writeDurable(manifestPath(root, manifest.turnId), `${JSON.stringify(manifest)}\n`)
}

function isRef(v: unknown): v is BlobRef {
	if (v === null || typeof v !== 'object') return false
	const r = v as Record<string, unknown>
	return (
		typeof r.sha256 === 'string' &&
		SHA.test(r.sha256) &&
		typeof r.size === 'number' &&
		typeof r.mode === 'number'
	)
}

/** Structural check; null when the file is not a manifest this reader understands. */
export function parseManifest(text: string): Manifest | null {
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		return null
	}
	if (raw === null || typeof raw !== 'object') return null
	const m = raw as Record<string, unknown>
	if (m.version !== MANIFEST_VERSION) return null
	if (typeof m.turnId !== 'string' || !isSafeTurnId(m.turnId)) return null
	if (typeof m.seq !== 'number' || typeof m.startedAt !== 'number') return null
	if (typeof m.label !== 'string') return null
	if (m.status !== 'applied' && m.status !== 'undone' && m.status !== 'partially_undone') {
		return null
	}
	if (!Array.isArray(m.entries) || !Array.isArray(m.skipped)) return null
	for (const e of m.entries as Record<string, unknown>[]) {
		if (e === null || typeof e !== 'object') return null
		if (typeof e.path !== 'string' || typeof e.rel !== 'string') return null
		if (e.before !== null && !isRef(e.before)) return null
		if (e.after !== null && !isRef(e.after)) return null
		if (e.state !== 'pending' && e.state !== 'done' && e.state !== 'failed') return null
	}
	return {
		...(m as unknown as Manifest),
		lastEditAt: typeof m.lastEditAt === 'number' ? m.lastEditAt : (m.startedAt as number),
		uncoveredShell: m.uncoveredShell === true,
	}
}

/** Every readable manifest under `root`; files that do not parse are named, not fatal. */
export async function readManifests(
	root: string,
): Promise<{ manifests: Manifest[]; unreadable: string[] }> {
	const names = await readdir(turnsDir(root)).catch(() => [] as string[])
	const manifests: Manifest[] = []
	const unreadable: string[] = []
	for (const name of names.sort()) {
		if (!name.endsWith('.json')) continue
		const parsed = parseManifest(await readFile(join(turnsDir(root), name), 'utf8').catch(() => ''))
		if (parsed && `${parsed.turnId}.json` === name) manifests.push(parsed)
		else unreadable.push(name)
	}
	return { manifests, unreadable }
}

export async function removeManifest(root: string, turnId: string): Promise<void> {
	if (!isSafeTurnId(turnId)) return
	await rm(manifestPath(root, turnId), { force: true })
}

/** Bodies on disk, with their sizes. */
export async function listBlobs(root: string): Promise<Map<string, number>> {
	const out = new Map<string, number>()
	for (const name of await readdir(blobsDir(root)).catch(() => [] as string[])) {
		if (!SHA.test(name)) continue
		const size = await stat(join(blobsDir(root), name)).then(
			(s) => s.size,
			() => -1,
		)
		if (size >= 0) out.set(name, size)
	}
	return out
}

export async function removeBlob(root: string, sha256: string): Promise<void> {
	if (SHA.test(sha256)) await rm(blobPath(root, sha256), { force: true })
}

/** Every body a manifest names, kept ones only. */
export function referencedBlobs(manifest: Manifest): Set<string> {
	const out = new Set<string>()
	// A kept copy is the operator's own work, saved before an undo replaced it:
	// expiry takes the turn's bodies, never that.
	for (const c of manifest.copies ?? []) out.add(c.sha256)
	if (manifest.pruned) return out
	for (const e of manifest.entries) {
		if (e.state === 'failed') continue
		if (e.before && e.before.stored !== false) out.add(e.before.sha256)
		if (e.after && e.after.stored !== false) out.add(e.after.sha256)
	}
	return out
}

/** Share a body with another history: hard link, or a copy where links are refused. */
export async function shareBlob(from: string, to: string, sha256: string): Promise<void> {
	if (await blobExists(to, sha256)) return
	await mkdir(blobsDir(to), { recursive: true })
	try {
		await link(blobPath(from, sha256), blobPath(to, sha256))
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'EEXIST') return
		await putBlob(to, await readBlob(from, sha256))
	}
}
