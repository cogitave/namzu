import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
	LISTENING_ASSETS,
	LISTENING_DOWNLOAD_BYTES,
	LISTENING_MODEL_REVISION,
	type ListeningAsset,
} from './local-listening-assets.js'
import {
	LocalListeningInstallCancelled,
	installLocalListening,
	localListeningModelPaths,
	readLocalListeningInstallation,
	uninstallLocalListening,
} from './local-listening-install.js'

const directories: string[] = []
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true })
})
async function directory(): Promise<string> {
	const result = await mkdtemp(join(tmpdir(), 'namzu-listening-install-'))
	directories.push(result)
	return result
}

const bodies: Record<string, Uint8Array> = {
	'encoder.bin': new Uint8Array(1_000).fill(1),
	'decoder.bin': new Uint8Array(700).fill(2),
	'tokens.txt': new TextEncoder().encode('a 0\nb 1\n'),
	'vad.bin': new Uint8Array(300).fill(3),
}
const roles = ['encoder', 'decoder', 'tokens', 'voiceActivity'] as const
const assets: ListeningAsset[] = Object.entries(bodies).map(([name, body], index) => ({
	name,
	role: roles[index] as ListeningAsset['role'],
	url: `https://models.test/${name}`,
	bytes: body.byteLength,
	sha256: createHash('sha256').update(body).digest('hex'),
}))
const TOTAL = assets.reduce((sum, asset) => sum + asset.bytes, 0)

function streamOf(body: Uint8Array, chunk = 256, failAt?: number): ReadableStream<Uint8Array> {
	let at = 0
	return new ReadableStream({
		pull(controller) {
			if (failAt !== undefined && at >= failAt) {
				controller.error(new Error('connection dropped'))
				return
			}
			if (at >= body.byteLength) {
				controller.close()
				return
			}
			controller.enqueue(body.slice(at, at + chunk))
			at += chunk
		},
	})
}
function fakeFetch(
	override: (name: string) => Uint8Array | undefined = () => undefined,
): typeof fetch & { calls: string[] } {
	const calls: string[] = []
	const impl = async (input: RequestInfo | URL) => {
		const name = String(input).split('/').pop() as string
		calls.push(name)
		const body = override(name) ?? bodies[name]
		return new Response(body ? streamOf(body) : null, { status: body ? 200 : 404 })
	}
	return Object.assign(impl, { calls }) as typeof fetch & { calls: string[] }
}

it('pins the real model files with sizes, digests and the model host revision', () => {
	expect(LISTENING_ASSETS.map((asset) => asset.name)).toEqual([
		'turbo-encoder.int8.onnx',
		'turbo-decoder.int8.onnx',
		'turbo-tokens.txt',
		'silero_vad.onnx',
	])
	expect(LISTENING_DOWNLOAD_BYTES).toBe(1_037_257_645)
	for (const asset of LISTENING_ASSETS) {
		expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
		expect(asset.url.startsWith('https://')).toBe(true)
	}
	expect(LISTENING_ASSETS[0]?.url).toContain(`/resolve/${LISTENING_MODEL_REVISION}/`)
})

it('downloads, verifies, installs atomically and reads the receipt back', async () => {
	const root = await directory()
	const progress: string[] = []
	const installation = await installLocalListening({
		directory: root,
		assets,
		fetch: fakeFetch(),
		onProgress: (step) => progress.push(step.step),
	})
	expect(installation.diskBytes).toBe(TOTAL)
	expect(progress[0]).toBe('preparing')
	expect(progress.at(-1)).toBe('checking')
	expect(await readdir(join(root, 'models'))).toEqual([...assets.map((a) => a.name)].sort())
	expect(await readLocalListeningInstallation(root, assets)).toMatchObject({ v: 1 })
	expect(JSON.parse(await readFile(join(root, 'installation.json'), 'utf8')).modelRevision).toBe(
		LISTENING_MODEL_REVISION,
	)
})

it('reports downloaded bytes across files up to the total', async () => {
	const root = await directory()
	const seen: number[] = []
	await installLocalListening({
		directory: root,
		assets,
		fetch: fakeFetch(),
		onProgress: (p) => {
			if (p.downloadedBytes !== undefined) {
				expect(p.totalBytes).toBe(TOTAL)
				seen.push(p.downloadedBytes)
			}
		},
	})
	expect([...seen].sort((a, b) => a - b)).toEqual(seen)
	expect(seen.at(-1)).toBe(TOTAL)
})

it('does nothing when already installed', async () => {
	const root = await directory()
	await installLocalListening({ directory: root, assets, fetch: fakeFetch() })
	const again = fakeFetch()
	await installLocalListening({ directory: root, assets, fetch: again })
	expect(again.calls).toEqual([])
})

it('deletes a file whose digest does not match and installs nothing', async () => {
	const root = await directory()
	const wrong = new Uint8Array(bodies['decoder.bin'] as Uint8Array).fill(9)
	await expect(
		installLocalListening({
			directory: root,
			assets,
			fetch: fakeFetch((name) => (name === 'decoder.bin' ? wrong : undefined)),
		}),
	).rejects.toThrow(/damaged/)
	const left = await readdir(join(root, 'models'))
	expect(left).not.toContain('decoder.bin')
	expect(left.some((name) => name.endsWith('.part'))).toBe(false)
	await expect(stat(join(root, 'installation.json'))).rejects.toThrow()
	await expect(readLocalListeningInstallation(root, assets)).resolves.toBeUndefined()
})

it('refuses a body longer than the pinned size and a shorter one', async () => {
	for (const body of [new Uint8Array(1_001).fill(1), new Uint8Array(999).fill(1)]) {
		const root = await directory()
		await expect(
			installLocalListening({
				directory: root,
				assets,
				fetch: fakeFetch((name) => (name === 'encoder.bin' ? body : undefined)),
			}),
		).rejects.toThrow(/damaged/)
		expect(await readdir(join(root, 'models'))).toEqual([])
	}
})

it('says the connection failed in plain words when the host errors or drops', async () => {
	const dropped = (async () =>
		new Response(streamOf(bodies['encoder.bin'] as Uint8Array, 100, 300))) as typeof fetch
	const other = await directory()
	await expect(installLocalListening({ directory: other, assets, fetch: dropped })).rejects.toThrow(
		/Check the connection/,
	)
	expect(await readdir(join(other, 'models'))).toEqual([])
	const missing = (async () => new Response(null, { status: 404 })) as typeof fetch
	await expect(
		installLocalListening({ directory: await directory(), assets, fetch: missing }),
	).rejects.toThrow(/Check the connection/)
})

it('removes stale partial files and re-downloads only what is missing or damaged', async () => {
	const root = await directory()
	await installLocalListening({ directory: root, assets, fetch: fakeFetch() })
	await rm(join(root, 'installation.json'))
	await writeFile(join(root, 'models', 'tokens.txt'), 'tampered contents')
	await writeFile(join(root, 'models', 'encoder.bin.old.part'), 'half')
	const fetcher = fakeFetch()
	await installLocalListening({ directory: root, assets, fetch: fetcher })
	expect(fetcher.calls).toEqual(['tokens.txt'])
	expect((await readdir(join(root, 'models'))).some((name) => name.endsWith('.part'))).toBe(false)
	expect(await readFile(join(root, 'models', 'tokens.txt'))).toEqual(
		Buffer.from(bodies['tokens.txt'] as Uint8Array),
	)
})

it('cancels mid-download, leaving no partial file and a distinguishable error', async () => {
	const root = await directory()
	const controller = new AbortController()
	const slow = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		let at = 0
		const body = bodies['encoder.bin'] as Uint8Array
		return new Response(
			new ReadableStream<Uint8Array>({
				pull(stream) {
					if (at === 256) controller.abort()
					if (init?.signal?.aborted) {
						stream.error(new DOMException('aborted', 'AbortError'))
						return
					}
					stream.enqueue(body.slice(at, at + 128))
					at += 128
				},
			}),
		)
	}) as typeof fetch
	await expect(
		installLocalListening({ directory: root, assets, fetch: slow, signal: controller.signal }),
	).rejects.toBeInstanceOf(LocalListeningInstallCancelled)
	expect(await readdir(join(root, 'models'))).toEqual([])
})

it('rejects an incomplete or foreign receipt instead of trusting it', async () => {
	const root = await directory()
	await installLocalListening({ directory: root, assets, fetch: fakeFetch() })
	await writeFile(join(root, 'models', 'vad.bin'), 'short')
	await expect(readLocalListeningInstallation(root, assets)).rejects.toThrow(/incomplete/)
	await writeFile(join(root, 'installation.json'), '{"v":2}')
	await expect(readLocalListeningInstallation(root, assets)).rejects.toThrow(/incomplete/)
})

it('uninstalls only what it wrote', async () => {
	const root = await directory()
	await installLocalListening({ directory: root, assets, fetch: fakeFetch() })
	await writeFile(join(root, 'models', 'mine.txt'), 'keep')
	await uninstallLocalListening(root, assets)
	expect(await readdir(join(root, 'models'))).toEqual(['mine.txt'])
	await expect(stat(join(root, 'installation.json'))).rejects.toThrow()
	await rm(join(root, 'models', 'mine.txt'))
	await uninstallLocalListening(root, assets)
	await expect(stat(root)).rejects.toThrow()
})

it('gives the worker the four model paths under the models folder', () => {
	const paths = localListeningModelPaths('/data/local-listening')
	expect(paths.voiceActivity.replaceAll('\\', '/')).toBe(
		'/data/local-listening/models/silero_vad.onnx',
	)
	expect(paths.encoder.replaceAll('\\', '/')).toContain('/models/turbo-encoder.int8.onnx')
})
