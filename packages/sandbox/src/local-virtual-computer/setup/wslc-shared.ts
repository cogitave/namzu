import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, win32 } from 'node:path'
import type { WslcImageManifest, WslcSetupHost } from './contract.js'

/** The label every Pal computer image carries; it names the guest protocol. */
export const PROTOCOL_LABEL = 'org.namzu.local-computer.protocol'

/** Where the WSL package puts wslc. */
export function wslcBinaryOf(host: Pick<WslcSetupHost, 'env'>): string {
	const programFiles = host.env.ProgramFiles ?? 'C:\\Program Files'
	return win32.join(programFiles, 'WSL', 'wslc.exe')
}

/** Why a manifest was refused, in words safe to show. */
export class ManifestError extends Error {
	override readonly name = 'ManifestError'
}

const FORMATS = ['zst', 'xz', 'gz', 'tar']

function fail(why: string): never {
	throw new ManifestError(`The Pal computer image manifest is not valid: ${why}.`)
}

/** Validate a parsed manifest. Throws {@link ManifestError}. */
export function validateManifest(value: unknown): WslcImageManifest {
	if (typeof value !== 'object' || value === null) fail('it is not an object')
	const m = value as Record<string, unknown>
	const text = (key: string): string => {
		const v = m[key]
		if (typeof v !== 'string' || v === '') fail(`${key} is missing`)
		return v
	}
	const whole = (key: string): number => {
		const v = m[key]
		if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) fail(`${key} is missing`)
		return v
	}
	const revision = whole('revision')
	const imageRef = text('imageRef')
	if (imageRef !== `namzu-local-computer:${revision}`) fail('imageRef does not match the revision')
	const imageId = text('imageId')
	if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) fail('imageId is not a digest')
	const file = text('file')
	if (/[\\/]/.test(file) || file === '.' || file === '..' || file.includes('\0'))
		fail('file must be a plain file name')
	const sha256 = text('sha256')
	const tarSha256 = text('tarSha256')
	for (const digest of [sha256, tarSha256])
		if (!/^[0-9a-f]{64}$/.test(digest)) fail('a digest is not 64 hex characters')
	const stage = m.stage
	if (stage !== 'base' && stage !== 'creative') fail('stage is missing')
	const format = m.format
	if (typeof format !== 'string' || !FORMATS.includes(format)) fail('format is missing')
	return {
		revision,
		stage,
		imageRef,
		imageId,
		protocol: text('protocol'),
		file,
		sha256,
		tarSha256,
		sizeBytes: whole('sizeBytes'),
		compressedBytes: whole('compressedBytes'),
		format: format as WslcImageManifest['format'],
	}
}

export async function readManifest(manifestPath: string): Promise<WslcImageManifest> {
	let text: string
	try {
		text = await readFile(manifestPath, 'utf8')
	} catch {
		throw new ManifestError('The Pal computer image manifest could not be read.')
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new ManifestError('The Pal computer image manifest is not valid JSON.')
	}
	return validateManifest(parsed)
}

/** The archive lies beside its manifest. */
export function archivePathOf(manifestPath: string, manifest: WslcImageManifest): string {
	return join(dirname(manifestPath), manifest.file)
}

/** `[{ Id, Config: { Labels } }]` from `wslc image inspect -f json`. */
export function parseImageInspect(
	output: string,
): { id: string; protocol: string | undefined } | undefined {
	let value: unknown
	try {
		value = JSON.parse(output.replace(/^\uFEFF/, '').trim())
	} catch {
		return undefined
	}
	const first = Array.isArray(value) ? value[0] : value
	if (typeof first !== 'object' || first === null) return undefined
	const { Id, Config } = first as { Id?: unknown; Config?: { Labels?: Record<string, unknown> } }
	if (typeof Id !== 'string') return undefined
	const label = Config?.Labels?.[PROTOCOL_LABEL]
	return { id: Id, protocol: typeof label === 'string' ? label : undefined }
}

export interface WslcImageRecord {
	readonly imageRef: string
	readonly imageId: string
	readonly loadedAt: string
}

function recordPath(host: Pick<WslcSetupHost, 'stateDirectory'>): string {
	return join(host.stateDirectory, 'image.json')
}

export async function readImageRecord(
	host: Pick<WslcSetupHost, 'stateDirectory'>,
): Promise<WslcImageRecord | undefined> {
	try {
		const value = JSON.parse(await readFile(recordPath(host), 'utf8')) as Partial<WslcImageRecord>
		if (typeof value.imageRef === 'string' && typeof value.imageId === 'string')
			return value as WslcImageRecord
	} catch {
		// Absent or unreadable: nothing is recorded.
	}
	return undefined
}

export async function writeImageRecord(
	host: Pick<WslcSetupHost, 'stateDirectory'>,
	record: WslcImageRecord,
): Promise<void> {
	await mkdir(host.stateDirectory, { recursive: true })
	const target = recordPath(host)
	const temp = `${target}.${process.pid}.tmp`
	await writeFile(temp, `${JSON.stringify(record)}\n`, 'utf8')
	await rename(temp, target)
}
