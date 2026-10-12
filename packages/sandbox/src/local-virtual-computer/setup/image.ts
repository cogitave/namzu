import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { LocalComputerSetupError } from '../engine.js'
import { mapWslcFailure } from '../wslc-engine.js'
import type { LoadWslcImage, WslcImageManifest } from './contract.js'
import { createWslcSetupHost } from './host.js'
import {
	ManifestError,
	archivePathOf,
	parseImageInspect,
	readManifest,
	writeImageRecord,
	wslcBinaryOf,
} from './wslc-shared.js'

const HASH_CHUNK_BYTES = 4 * 1024 * 1024

async function sha256Of(
	path: string,
	total: number,
	onProgress: ((done: number) => void) | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const hash = createHash('sha256')
	let done = 0
	const stream = createReadStream(path, { highWaterMark: HASH_CHUNK_BYTES, signal })
	for await (const chunk of stream) {
		hash.update(chunk as Buffer)
		done += (chunk as Buffer).byteLength
		onProgress?.(Math.min(done, total))
	}
	return hash.digest('hex')
}

/** The image the engine reports under `ref`, or undefined when it has none. */
async function inspectImage(
	host: ReturnType<typeof createWslcSetupHost>,
	ref: string,
	signal: AbortSignal | undefined,
): Promise<
	| { readonly kind: 'found'; readonly id: string; readonly protocol: string | undefined }
	| { readonly kind: 'absent' }
	| { readonly kind: 'engine'; readonly detail: string }
> {
	try {
		const output = await host.runner.run(
			wslcBinaryOf(host),
			['image', 'inspect', '-f', 'json', ref],
			{ signal },
		)
		const parsed = parseImageInspect(output)
		return parsed ? { kind: 'found', id: parsed.id, protocol: parsed.protocol } : { kind: 'absent' }
	} catch (error) {
		signal?.throwIfAborted()
		const mapped = mapWslcFailure(error)
		if (mapped === undefined) return { kind: 'absent' }
		if (mapped.code === 'image-missing') return { kind: 'absent' }
		return { kind: 'engine', detail: mapped.message }
	}
}

/**
 * Check the bundled archive against its manifest, load it with `wslc load`,
 * and check what loaded. Nothing is loaded that failed a check.
 */
export const loadWslcImage: LoadWslcImage = async (options) => {
	const host = createWslcSetupHost(options.host)
	const { signal } = options
	let manifest: WslcImageManifest
	try {
		manifest = await readManifest(options.manifestPath)
	} catch (error) {
		if (error instanceof ManifestError)
			return { outcome: 'failed', code: 'image-corrupt', detail: error.message }
		throw error
	}
	const record = async (): Promise<void> => {
		await writeImageRecord(host, {
			imageRef: manifest.imageRef,
			imageId: manifest.imageId,
			loadedAt: host.now().toISOString(),
		})
	}

	const existing = await inspectImage(host, manifest.imageRef, signal)
	if (existing.kind === 'engine')
		return { outcome: 'failed', code: 'image-load-failed', detail: existing.detail }
	if (existing.kind === 'found' && existing.id === manifest.imageId) {
		await record()
		return { outcome: 'already-loaded' }
	}

	const archive = archivePathOf(options.manifestPath, manifest)
	let size: number
	try {
		size = (await stat(archive)).size
	} catch {
		return {
			outcome: 'failed',
			code: 'image-corrupt',
			detail: 'The Pal computer image file is missing from this installation.',
		}
	}
	if (size !== manifest.compressedBytes)
		return {
			outcome: 'failed',
			code: 'image-corrupt',
			detail: 'The Pal computer image file is incomplete or damaged.',
		}
	const digest = await sha256Of(
		archive,
		manifest.compressedBytes,
		(done) =>
			options.onProgress?.({
				step: 'load-image',
				phase: 'progress',
				done,
				total: manifest.compressedBytes,
				unit: 'bytes',
			}),
		signal,
	)
	if (digest !== manifest.sha256)
		return {
			outcome: 'failed',
			code: 'image-corrupt',
			detail: 'The Pal computer image file is incomplete or damaged.',
		}

	try {
		await host.runner.run(wslcBinaryOf(host), ['load', '-q', '-i', archive], { signal })
	} catch (error) {
		signal?.throwIfAborted()
		const mapped = mapWslcFailure(error)
		return {
			outcome: 'failed',
			code: 'image-load-failed',
			detail:
				mapped instanceof LocalComputerSetupError
					? mapped.message
					: 'Windows could not load the Pal computer image.',
		}
	}

	const loaded = await inspectImage(host, manifest.imageRef, signal)
	if (
		loaded.kind !== 'found' ||
		loaded.id !== manifest.imageId ||
		loaded.protocol !== manifest.protocol
	)
		return {
			outcome: 'failed',
			code: 'image-mismatch',
			detail: 'The image that loaded is not the one this version of Namzu expects.',
		}
	await record()
	return { outcome: 'loaded' }
}
