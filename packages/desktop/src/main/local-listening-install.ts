import { createHash, randomUUID } from 'node:crypto'
import {
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	rm,
	rmdir,
	writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { LocalListeningInstallProgress } from '../shared/local-listening-protocol.js'
import {
	LISTENING_ASSETS,
	LISTENING_MODEL_REVISION,
	type ListeningAsset,
} from './local-listening-assets.js'

export interface LocalListeningInstallation {
	v: 1
	modelRevision: string
	files: { name: string; bytes: number; sha256: string }[]
	diskBytes: number
	installedAt: string
}
export interface LocalListeningInstallOptions {
	/** The `local-listening` folder under the profile. */
	directory: string
	signal?: AbortSignal
	/** Native Electron net.fetch uses the host certificate store; never supplied by a renderer. */
	fetch?: typeof fetch
	onProgress?: (progress: LocalListeningInstallProgress) => void
	/** Test seam, never accepted from a renderer: the files to fetch. */
	assets?: readonly ListeningAsset[]
}
export interface LocalListeningModelPaths {
	encoder: string
	decoder: string
	tokens: string
	voiceActivity: string
}

const DAMAGED = 'The downloaded listening files are damaged. Download them again.'
const UNREACHABLE = 'Listening couldn’t be downloaded. Check the connection and try again.'
const INCOMPLETE = 'The saved listening files are incomplete. Download them again.'
const PART_SUFFIX = '.part'

export class LocalListeningInstallCancelled extends Error {
	constructor() {
		super('The listening download was cancelled.')
		this.name = 'LocalListeningInstallCancelled'
	}
}

export function localListeningModelsDirectory(directory: string): string {
	return join(directory, 'models')
}

export function localListeningModelPaths(directory: string): LocalListeningModelPaths {
	const models = localListeningModelsDirectory(directory)
	const path = (role: ListeningAsset['role']) => {
		const asset = LISTENING_ASSETS.find((candidate) => candidate.role === role)
		if (!asset) throw new Error(INCOMPLETE)
		return join(models, asset.name)
	}
	return {
		encoder: path('encoder'),
		decoder: path('decoder'),
		tokens: path('tokens'),
		voiceActivity: path('voiceActivity'),
	}
}

async function sha256File(path: string): Promise<string> {
	const file = await open(path, 'r')
	const hash = createHash('sha256')
	try {
		for await (const data of file.createReadStream({ autoClose: false })) hash.update(data)
	} finally {
		await file.close()
	}
	return hash.digest('hex')
}

async function isVerifiedFile(path: string, asset: ListeningAsset): Promise<boolean> {
	try {
		const metadata = await lstat(path)
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== asset.bytes)
			return false
		return (await sha256File(path)) === asset.sha256
	} catch {
		return false
	}
}

/** No network and no hashing: sizes only, so reading the state at startup stays cheap. */
export async function readLocalListeningInstallation(
	directory: string,
	assets: readonly ListeningAsset[] = LISTENING_ASSETS,
): Promise<LocalListeningInstallation | undefined> {
	let record: unknown
	try {
		const raw = await readFile(join(directory, 'installation.json'), 'utf8')
		if (raw.length > 8_192) throw new Error(INCOMPLETE)
		record = JSON.parse(raw)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw new Error(INCOMPLETE)
	}
	if (!record || typeof record !== 'object') throw new Error(INCOMPLETE)
	const value = record as LocalListeningInstallation
	if (
		value.v !== 1 ||
		value.modelRevision !== LISTENING_MODEL_REVISION ||
		!Number.isSafeInteger(value.diskBytes) ||
		value.diskBytes < 0 ||
		typeof value.installedAt !== 'string'
	)
		throw new Error(INCOMPLETE)
	const models = localListeningModelsDirectory(directory)
	for (const asset of assets) {
		const known = value.files?.find((file) => file.name === asset.name)
		if (known?.bytes !== asset.bytes || known.sha256 !== asset.sha256) throw new Error(INCOMPLETE)
		try {
			const metadata = await lstat(join(models, asset.name))
			if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== asset.bytes)
				throw new Error(INCOMPLETE)
		} catch {
			throw new Error(INCOMPLETE)
		}
	}
	return value
}

async function removeStaleParts(models: string): Promise<void> {
	let names: string[]
	try {
		names = await readdir(models)
	} catch {
		return
	}
	for (const name of names)
		if (name.endsWith(PART_SUFFIX)) await rm(join(models, name), { force: true })
}

/**
 * Streams one file to a private temporary name, checks its size and digest, and only then
 * renames it into place. A partial or mismatched file is deleted and never used.
 */
async function downloadAsset(
	asset: ListeningAsset,
	target: string,
	options: LocalListeningInstallOptions,
	before: number,
	total: number,
): Promise<void> {
	const part = `${target}.${randomUUID()}${PART_SUFFIX}`
	const cancelled = () => options.signal?.aborted === true
	let response: Response
	try {
		response = await (options.fetch ?? fetch)(asset.url, { signal: options.signal })
	} catch {
		if (cancelled()) throw new LocalListeningInstallCancelled()
		throw new Error(UNREACHABLE)
	}
	if (!response.ok || !response.body) throw new Error(UNREACHABLE)
	const file = await open(part, 'wx', 0o600)
	const hash = createHash('sha256')
	const reader = response.body.getReader()
	let bytes = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			bytes += value.byteLength
			if (bytes > asset.bytes) throw new Error(DAMAGED)
			hash.update(value)
			await file.writeFile(value)
			options.onProgress?.({
				step: 'downloading',
				downloadedBytes: before + bytes,
				totalBytes: total,
			})
		}
		if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error(DAMAGED)
		await file.close()
		await rename(part, target)
	} catch (error) {
		await file.close().catch(() => undefined)
		await rm(part, { force: true })
		if (cancelled()) throw new LocalListeningInstallCancelled()
		if (error instanceof Error && error.message === DAMAGED) throw error
		throw new Error(UNREACHABLE)
	} finally {
		await reader.cancel().catch(() => undefined)
	}
}

/** Explicit user action only. Nothing here runs at startup or when merely opening Settings. */
export async function installLocalListening(
	options: LocalListeningInstallOptions,
): Promise<LocalListeningInstallation> {
	const directory = resolve(options.directory)
	const assets = options.assets ?? LISTENING_ASSETS
	const total = assets.reduce((sum, asset) => sum + asset.bytes, 0)
	const models = localListeningModelsDirectory(directory)
	await mkdir(models, { recursive: true, mode: 0o700 })
	try {
		const existing = await readLocalListeningInstallation(directory, assets)
		if (existing) return existing
	} catch {
		// A damaged record is replaced below; files are re-verified by digest before reuse.
	}
	options.onProgress?.({ step: 'preparing' })
	await removeStaleParts(models)
	let before = 0
	for (const asset of assets) {
		if (options.signal?.aborted) throw new LocalListeningInstallCancelled()
		const target = join(models, asset.name)
		// A file that finished in an earlier attempt is kept only if it still hashes right.
		if (!(await isVerifiedFile(target, asset))) {
			await rm(target, { force: true })
			await downloadAsset(asset, target, options, before, total)
		}
		before += asset.bytes
		options.onProgress?.({
			step: 'downloading',
			downloadedBytes: before,
			totalBytes: total,
		})
	}
	options.onProgress?.({ step: 'checking' })
	const installation: LocalListeningInstallation = {
		v: 1,
		modelRevision: LISTENING_MODEL_REVISION,
		files: assets.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
		diskBytes: total,
		installedAt: new Date().toISOString(),
	}
	const temporary = join(directory, `installation-${randomUUID()}.tmp`)
	await writeFile(temporary, JSON.stringify(installation), { flag: 'wx', mode: 0o600 })
	await rename(temporary, join(directory, 'installation.json'))
	return installation
}

/** Removes exactly what this installer wrote; a foreign file in the folder is left alone. */
export async function uninstallLocalListening(
	directory: string,
	assets: readonly ListeningAsset[] = LISTENING_ASSETS,
): Promise<void> {
	const root = resolve(directory)
	const models = localListeningModelsDirectory(root)
	await rm(join(root, 'installation.json'), { force: true })
	let names: string[] = []
	try {
		names = await readdir(models)
	} catch {
		/* Nothing was downloaded. */
	}
	const owned = new Set(assets.map((asset) => asset.name))
	for (const name of names)
		if (owned.has(name) || name.endsWith(PART_SUFFIX)) await rm(join(models, name), { force: true })
	for (const folder of [models, root]) await rmdir(folder).catch(() => undefined)
}
