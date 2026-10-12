import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WslcSetupProgress } from '../contract.js'
import { loadWslcImage } from '../image.js'
import {
	IMAGE_ID,
	IMAGE_REF,
	failure,
	fakeHost,
	fakeRunner,
	inspectJson,
	tempDirectory,
	writeBundle,
} from './fakes.js'

const CONTENT = Buffer.from('pretend this is a zstd archive of an image')
const SHA = createHash('sha256').update(CONTENT).digest('hex')
const INSPECT = 'wslc image inspect -f json namzu-local-computer:2'
const LOAD = (archive: string) => `wslc load -q -i ${archive}`

let directory: string
beforeEach(async () => {
	directory = await tempDirectory()
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

describe('loadWslcImage', () => {
	it('checks the archive, loads it, checks what loaded and records it', async () => {
		const bundle = await writeBundle(directory, CONTENT, SHA)
		let loaded = false
		const runner = fakeRunner({
			[INSPECT]: () => (loaded ? inspectJson(IMAGE_ID) : failure(1, ['WSLC_E_IMAGE_NOT_FOUND'])),
			[LOAD(bundle.archivePath)]: () => {
				loaded = true
				return ''
			},
		})
		const progress: WslcSetupProgress[] = []
		const result = await loadWslcImage({
			manifestPath: bundle.manifestPath,
			host: fakeHost({ stateDirectory: directory, runner }),
			onProgress: (p) => progress.push(p),
		})
		expect(result).toEqual({ outcome: 'loaded' })
		expect(runner.calls).toEqual([INSPECT, LOAD(bundle.archivePath), INSPECT])
		expect(progress.at(-1)).toEqual({
			step: 'load-image',
			phase: 'progress',
			done: CONTENT.byteLength,
			total: CONTENT.byteLength,
			unit: 'bytes',
		})
		const record = JSON.parse(await readFile(join(directory, 'image.json'), 'utf8'))
		expect(record).toEqual({
			imageRef: IMAGE_REF,
			imageId: IMAGE_ID,
			loadedAt: '2026-10-12T12:00:00.000Z',
		})
	})

	it('does not read the archive when the image is already loaded', async () => {
		const bundle = await writeBundle(directory, CONTENT, SHA)
		await rm(bundle.archivePath)
		const runner = fakeRunner({ [INSPECT]: inspectJson(IMAGE_ID) })
		const result = await loadWslcImage({
			manifestPath: bundle.manifestPath,
			host: fakeHost({ stateDirectory: directory, runner }),
		})
		expect(result).toEqual({ outcome: 'already-loaded' })
		expect(runner.calls).toEqual([INSPECT])
		expect((await readFile(join(directory, 'image.json'), 'utf8')).includes(IMAGE_ID)).toBe(true)
	})

	it('loads again when the reference holds a different image', async () => {
		const bundle = await writeBundle(directory, CONTENT, SHA)
		let loaded = false
		const runner = fakeRunner({
			[INSPECT]: () => inspectJson(loaded ? IMAGE_ID : `sha256:${'d'.repeat(64)}`),
			[LOAD(bundle.archivePath)]: () => {
				loaded = true
				return ''
			},
		})
		const result = await loadWslcImage({
			manifestPath: bundle.manifestPath,
			host: fakeHost({ stateDirectory: directory, runner }),
		})
		expect(result.outcome).toBe('loaded')
	})

	it('refuses a truncated archive without loading it', async () => {
		const bundle = await writeBundle(directory, CONTENT, SHA)
		await writeFile(bundle.archivePath, CONTENT.subarray(0, 10))
		const runner = fakeRunner({ [INSPECT]: failure(1, ['WSLC_E_IMAGE_NOT_FOUND']) })
		const result = await loadWslcImage({
			manifestPath: bundle.manifestPath,
			host: fakeHost({ stateDirectory: directory, runner }),
		})
		expect(result).toMatchObject({ outcome: 'failed', code: 'image-corrupt' })
		expect(runner.calls).toEqual([INSPECT])
	})

	it('refuses an archive of the right size with the wrong digest', async () => {
		const bundle = await writeBundle(directory, CONTENT, SHA)
		await writeFile(bundle.archivePath, Buffer.alloc(CONTENT.byteLength, 1))
		const runner = fakeRunner({ [INSPECT]: failure(1, ['WSLC_E_IMAGE_NOT_FOUND']) })
		const result = await loadWslcImage({
			manifestPath: bundle.manifestPath,
			host: fakeHost({ stateDirectory: directory, runner }),
		})
		expect(result).toMatchObject({ outcome: 'failed', code: 'image-corrupt' })
		expect(runner.calls).toEqual([INSPECT])
	})

	it('refuses a missing archive', async () => {
		const bundle = await writeBundle(directory, CONTENT, SHA)
		await rm(bundle.archivePath)
		const runner = fakeRunner({ [INSPECT]: failure(1, ['WSLC_E_IMAGE_NOT_FOUND']) })
		const result = await loadWslcImage({
			manifestPath: bundle.manifestPath,
			host: fakeHost({ stateDirectory: directory, runner }),
		})
		expect(result).toMatchObject({ outcome: 'failed', code: 'image-corrupt' })
	})

	it('reports a failing load in plain words, without engine output', async () => {
		const bundle = await writeBundle(directory, CONTENT, SHA)
		const runner = fakeRunner({
			[INSPECT]: failure(1, ['WSLC_E_IMAGE_NOT_FOUND']),
			[LOAD(bundle.archivePath)]: failure(1, ['0x80070005']),
		})
		const result = await loadWslcImage({
			manifestPath: bundle.manifestPath,
			host: fakeHost({ stateDirectory: directory, runner }),
		})
		expect(result).toEqual({
			outcome: 'failed',
			code: 'image-load-failed',
			detail: 'Windows could not load the Pal computer image.',
		})
	})

	it('names a virtualization problem when the session cannot start', async () => {
		const bundle = await writeBundle(directory, CONTENT, SHA)
		const runner = fakeRunner({ [INSPECT]: failure(1, ['0x80370102']) })
		const result = await loadWslcImage({
			manifestPath: bundle.manifestPath,
			host: fakeHost({ stateDirectory: directory, runner }),
		})
		expect(result).toMatchObject({ outcome: 'failed', code: 'image-load-failed' })
		expect((result as { detail?: string }).detail).toMatch(/virtualization/)
	})

	it.each([
		['another image id', inspectJson(`sha256:${'e'.repeat(64)}`)],
		['another protocol', inspectJson(IMAGE_ID, '9')],
	])('reports %s after the load as a mismatch and records nothing', async (_label, after) => {
		const bundle = await writeBundle(directory, CONTENT, SHA)
		let loaded = false
		const runner = fakeRunner({
			[INSPECT]: () => (loaded ? after : failure(1, ['WSLC_E_IMAGE_NOT_FOUND'])),
			[LOAD(bundle.archivePath)]: () => {
				loaded = true
				return ''
			},
		})
		const result = await loadWslcImage({
			manifestPath: bundle.manifestPath,
			host: fakeHost({ stateDirectory: directory, runner }),
		})
		expect(result).toMatchObject({ outcome: 'failed', code: 'image-mismatch' })
		await expect(readFile(join(directory, 'image.json'), 'utf8')).rejects.toThrow()
	})

	describe('manifest validation', () => {
		const cases: [string, Record<string, unknown>][] = [
			['a path separator in the file name', { file: '../evil.tar.zst' }],
			['a backslash in the file name', { file: 'sub\\evil.tar.zst' }],
			['an image reference that is not the revision', { imageRef: 'namzu-local-computer:3' }],
			['a test tag', { imageRef: 'namzu-spike-slim:1' }],
			['an image id that is not a digest', { imageId: 'abc' }],
			['a missing size', { compressedBytes: 0 }],
			['an unknown format', { format: 'rar' }],
		]
		it.each(cases)('refuses %s', async (_label, patch) => {
			const bundle = await writeBundle(directory, CONTENT, SHA)
			await writeFile(bundle.manifestPath, JSON.stringify({ ...bundle.manifest, ...patch }))
			const runner = fakeRunner({})
			const result = await loadWslcImage({
				manifestPath: bundle.manifestPath,
				host: fakeHost({ stateDirectory: directory, runner }),
			})
			expect(result).toMatchObject({ outcome: 'failed', code: 'image-corrupt' })
			expect(runner.calls).toEqual([])
		})

		it('refuses a manifest that is not JSON or not there', async () => {
			const bundle = await writeBundle(directory, CONTENT, SHA)
			await writeFile(bundle.manifestPath, '{nope')
			const host = fakeHost({ stateDirectory: directory, runner: fakeRunner({}) })
			expect(await loadWslcImage({ manifestPath: bundle.manifestPath, host })).toMatchObject({
				code: 'image-corrupt',
			})
			expect(
				await loadWslcImage({ manifestPath: join(directory, 'none.json'), host }),
			).toMatchObject({
				code: 'image-corrupt',
			})
		})
	})
})
