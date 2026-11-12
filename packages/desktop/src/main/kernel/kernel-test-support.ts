import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { FeedFetch } from './check.js'
import type { BundledFacts } from './facts.js'
import type { ExpectedKernel } from './facts.js'
import type { FileSink, KernelFs } from './fs.js'
import { nodeFs } from './fs.js'
import type { KernelPublicKey } from './keys.js'
import { KernelManager } from './manager.js'
import { KernelStore } from './store.js'

/**
 * Test helpers. The archive and signed-pair builders follow sections 3.2 to 3.5 of the
 * specification as written, not the reader's code, so a reader bug cannot hide in a builder
 * that shares it.
 */

export interface TestKey extends KernelPublicKey {
	privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
}

export function makeKey(id = 'k1'): TestKey {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519')
	const der = publicKey.export({ format: 'der', type: 'spki' })
	return { id, publicKey: der.subarray(der.length - 32).toString('base64'), privateKey }
}

// --- tar ---------------------------------------------------------------------------------

export interface TarEntry {
	name: string
	data?: Buffer | string
	type?: string
	linkname?: string
	/** Extra pax records; `path` is added when the name is long, or always when `paxPath` is set. */
	pax?: Record<string, string>
	paxPath?: boolean
	prefix?: string
	/** Written as the size field instead of the real length. */
	sizeField?: number
	badChecksum?: boolean
}

function field(text: string, length: number): Buffer {
	const out = Buffer.alloc(length)
	out.write(text, 0, 'utf8')
	return out
}

function octalField(value: number, length: number): Buffer {
	return field(`${value.toString(8).padStart(length - 1, '0')}\0`, length)
}

function headerBlock(entry: {
	name: string
	size: number
	type: string
	linkname?: string
	prefix?: string
	badChecksum?: boolean
}): Buffer {
	const block = Buffer.alloc(512)
	const nameBytes = Buffer.from(entry.name, 'utf8').subarray(0, 100)
	nameBytes.copy(block, 0)
	octalField(0o644, 8).copy(block, 100)
	octalField(0, 8).copy(block, 108)
	octalField(0, 8).copy(block, 116)
	octalField(entry.size, 12).copy(block, 124)
	octalField(0, 12).copy(block, 136)
	block.fill(0x20, 148, 156)
	block.write(entry.type, 156, 'latin1')
	block.write(entry.linkname ?? '', 157, 'utf8')
	block.write('ustar\0', 257, 'latin1')
	block.write('00', 263, 'latin1')
	block.write(entry.prefix ?? '', 345, 'utf8')
	let sum = 0
	for (const byte of block) sum += byte
	block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
	if (entry.badChecksum) block.write('0000001\0', 148, 'latin1')
	return block
}

function padded(data: Buffer): Buffer {
	const pad = (512 - (data.length % 512)) % 512
	return Buffer.concat([data, Buffer.alloc(pad)])
}

function paxRecord(key: string, value: string): Buffer {
	const rest = ` ${key}=${value}\n`
	let length = Buffer.byteLength(rest) + 1
	while (String(length).length + Buffer.byteLength(rest) !== length)
		length = String(length).length + Buffer.byteLength(rest)
	return Buffer.from(`${length}${rest}`)
}

export function tarBytes(
	entries: TarEntry[],
	options: { endBlocks?: number; trailing?: Buffer } = {},
): Buffer {
	const parts: Buffer[] = []
	for (const entry of entries) {
		const data = Buffer.from(entry.data ?? '')
		const records: Buffer[] = []
		const tooLong = Buffer.byteLength(entry.name, 'utf8') > 100
		if (tooLong || entry.paxPath) records.push(paxRecord('path', entry.name))
		for (const [key, value] of Object.entries(entry.pax ?? {})) records.push(paxRecord(key, value))
		if (records.length > 0) {
			const body = Buffer.concat(records)
			parts.push(headerBlock({ name: 'PaxHeader', size: body.length, type: 'x' }), padded(body))
		}
		parts.push(
			headerBlock({
				name: entry.name,
				size: entry.sizeField ?? data.length,
				type: entry.type ?? '0',
				...(entry.linkname !== undefined ? { linkname: entry.linkname } : {}),
				...(entry.prefix !== undefined ? { prefix: entry.prefix } : {}),
				...(entry.badChecksum ? { badChecksum: true } : {}),
			}),
			padded(data),
		)
	}
	parts.push(Buffer.alloc(512 * (options.endBlocks ?? 2)))
	if (options.trailing) parts.push(options.trailing)
	return Buffer.concat(parts)
}

// --- kernel archive ----------------------------------------------------------------------

export function sha256(data: Buffer | string): string {
	return createHash('sha256').update(data).digest('hex')
}
export function sha512(data: Buffer | string): string {
	return createHash('sha512').update(data).digest('hex')
}

export function kernelFactsText(options: {
	commandLine: string
	engine: string
	desktopContract?: number
	dataEpoch?: number
	platform?: string
	arch?: string
}): string {
	return JSON.stringify({
		schema: 1,
		commandLine: options.commandLine,
		engine: options.engine,
		desktopContract: options.desktopContract ?? 1,
		dataEpoch: options.dataEpoch ?? 1,
		platform: options.platform ?? 'win32',
		arch: options.arch ?? 'x64',
	})
}

export function kernelFiles(
	commandLine: string,
	engine: string,
	options: { dataEpoch?: number; desktopContract?: number; extra?: Record<string, string> } = {},
): Record<string, string> {
	return {
		'dist/bin.js': `// bin ${commandLine}\n`,
		'package.json': JSON.stringify({ name: '@namzu/cli', version: commandLine }),
		'kernel.json': kernelFactsText({ commandLine, engine, ...options }),
		'node_modules/pty/pty.node': `native ${commandLine}`,
		'dist/chunk-one.js': 'export const one = 1\n',
		...(options.extra ?? {}),
	}
}

export interface BuiltArchive {
	gz: Buffer
	filesJson: Buffer
	file: string
	bundle: {
		file: string
		size: number
		sha512: string
		filesSha512: string
		fileCount: number
		unpackedSize: number
	}
}

function byCodeUnit(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

/** The files.json of section 3.2 for these files. */
export function filesJsonOf(files: Record<string, string | Buffer>): Buffer {
	const list = Object.keys(files)
		.sort(byCodeUnit)
		.map((path) => {
			const data = Buffer.from(files[path] as string | Buffer)
			return { path, size: data.length, sha256: sha256(data) }
		})
	return Buffer.from(`${JSON.stringify({ schema: 1, files: list })}\n`)
}

export function buildArchive(
	commandLine: string,
	files: Record<string, string | Buffer>,
	options: {
		filesJson?: Buffer
		entries?: (entries: TarEntry[]) => TarEntry[]
		endBlocks?: number
		trailing?: Buffer
		gzip?: (tar: Buffer) => Buffer
		platform?: string
		arch?: string
	} = {},
): BuiltArchive {
	const filesJson = options.filesJson ?? filesJsonOf(files)
	let entries: TarEntry[] = [
		{ name: 'files.json', data: filesJson },
		...Object.keys(files)
			.sort(byCodeUnit)
			.map((name) => ({ name, data: files[name] as string | Buffer })),
	]
	if (options.entries) entries = options.entries(entries)
	const tar = tarBytes(entries, {
		...(options.endBlocks !== undefined ? { endBlocks: options.endBlocks } : {}),
		...(options.trailing ? { trailing: options.trailing } : {}),
	})
	const gz = options.gzip ? options.gzip(tar) : gzipSync(tar)
	const file = `namzu-kernel-${commandLine}-${options.platform ?? 'win32'}-${options.arch ?? 'x64'}.tar.gz`
	let unpacked = 0
	for (const data of Object.values(files)) unpacked += Buffer.from(data).length
	return {
		gz,
		filesJson,
		file,
		bundle: {
			file,
			size: gz.length,
			sha512: sha512(gz),
			filesSha512: sha512(filesJson),
			fileCount: Object.keys(files).length,
			unpackedSize: unpacked,
		},
	}
}

// --- manifest and signature --------------------------------------------------------------

export interface ManifestInput {
	commandLine: string
	engine: string
	desktopContract?: number
	dataEpoch?: number
	bundles: Record<string, BuiltArchive['bundle']>
	channel?: string
	sequence?: number
	issuedAt?: string
	expiresAt?: string
	minimumKernel?: string
	withdrawn?: string[]
}

export function manifestObject(input: ManifestInput): Record<string, unknown> {
	return {
		schema: 1,
		channel: input.channel ?? 'latest',
		sequence: input.sequence ?? 1794480000,
		issuedAt: input.issuedAt ?? '2026-11-12T10:00:00Z',
		expiresAt: input.expiresAt ?? '2026-11-26T10:00:00Z',
		minimumKernel: input.minimumKernel ?? '51.0.0',
		withdrawn: input.withdrawn ?? [],
		kernel: {
			commandLine: input.commandLine,
			engine: input.engine,
			desktopContract: input.desktopContract ?? 1,
			dataEpoch: input.dataEpoch ?? 1,
			bundles: input.bundles,
		},
	}
}

export interface SignedPair {
	manifest: Buffer
	signature: Buffer
}

/** Signs the exact bytes of `manifest` (an object is serialised once, here). */
export function signPair(
	manifest: Record<string, unknown> | Buffer,
	key: TestKey,
	options: { keyId?: string; algorithm?: string } = {},
): SignedPair {
	const bytes = Buffer.isBuffer(manifest) ? manifest : Buffer.from(JSON.stringify(manifest))
	const signature = sign(null, bytes, key.privateKey).toString('base64')
	return {
		manifest: bytes,
		signature: Buffer.from(
			JSON.stringify({
				schema: 1,
				keyId: options.keyId ?? key.id,
				algorithm: options.algorithm ?? 'ed25519',
				signature,
			}),
		),
	}
}

// --- feed --------------------------------------------------------------------------------

export const FEED = 'https://feed.test/kernel-latest/'

export interface FakeFeed {
	fetch: FeedFetch
	requests: string[]
	headers: Record<string, string>[]
	files: Map<string, Buffer>
	/** Replace how one file is served (for endless, truncated, redirected answers). */
	serve: Map<
		string,
		() => { status?: number; body: AsyncIterable<Uint8Array> | null; url?: string }
	>
}

async function* once(data: Buffer, piece = 7000): AsyncGenerator<Uint8Array> {
	for (let offset = 0; offset < data.length; offset += piece)
		yield data.subarray(offset, offset + piece)
}

export function makeFeed(files: Record<string, Buffer> = {}): FakeFeed {
	const feed: FakeFeed = {
		requests: [],
		headers: [],
		files: new Map(Object.entries(files)),
		serve: new Map(),
		fetch: async (url, init) => {
			feed.requests.push(url)
			feed.headers.push(init.headers)
			const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
			const custom = feed.serve.get(name)
			if (custom) {
				const answer = custom()
				return {
					status: answer.status ?? 200,
					body: answer.body,
					...(answer.url ? { url: answer.url } : {}),
				}
			}
			const data = feed.files.get(name)
			if (!data) return { status: 404, body: null }
			return { status: 200, body: once(data) }
		},
	}
	return feed
}

export function chunks(data: Buffer, piece = 9000): AsyncIterable<Uint8Array> {
	return once(data, piece)
}

// --- file faults -------------------------------------------------------------------------

export interface FaultPlan {
	/** 1-based number of the mutating operation that fails. */
	at: number
	/** `crash`: it and every later mutating operation fail (power cut). `once`: only it fails. */
	mode: 'crash' | 'once'
}

export interface FaultyFs {
	fs: KernelFs
	/** Mutating operations seen so far, as `op path`. */
	ops: string[]
	/** True once a fault has fired. */
	fired: () => boolean
}

/** Wraps a file system so that one chosen mutating operation fails, or all from there on. */
export function faultyFs(real: KernelFs, plan?: FaultPlan): FaultyFs {
	const ops: string[] = []
	let fired = false
	function step(label: string): void {
		ops.push(label)
		if (!plan) return
		if (ops.length === plan.at || (plan.mode === 'crash' && ops.length > plan.at)) {
			fired = true
			throw Object.assign(new Error(`injected failure at ${ops.length}: ${label}`), { code: 'EIO' })
		}
	}
	const fs: KernelFs = {
		readFile: (path) => real.readFile(path),
		writeFile: async (path, data) => {
			step(`writeFile ${path}`)
			await real.writeFile(path, data)
		},
		appendFile: async (path, data) => {
			step(`appendFile ${path}`)
			await real.appendFile(path, data)
		},
		openWrite: async (path) => {
			step(`openWrite ${path}`)
			const sink = await real.openWrite(path)
			return {
				write: async (chunk: Uint8Array) => {
					step(`write ${path}`)
					await sink.write(chunk)
				},
				close: async () => {
					try {
						step(`close ${path}`)
					} catch (error) {
						// the process is gone; only the test's descriptor is released
						await sink.close().catch(() => undefined)
						throw error
					}
					await sink.close()
				},
			} satisfies FileSink
		},
		rename: async (from, to) => {
			step(`rename ${from} ${to}`)
			await real.rename(from, to)
		},
		rm: async (path) => {
			step(`rm ${path}`)
			await real.rm(path)
		},
		mkdir: async (path, options) => {
			step(`mkdir ${path}`)
			await real.mkdir(path, options)
		},
		readdir: (path) => real.readdir(path),
		stat: (path) => real.stat(path),
		openRead: (path) => real.openRead(path),
	}
	return { fs, ops, fired: () => fired }
}

// --- harness -----------------------------------------------------------------------------

export interface Clock {
	value: number
	now: () => number
}
export function makeClock(iso = '2026-11-12T12:00:00Z'): Clock {
	const clock: Clock = { value: Date.parse(iso), now: () => clock.value }
	return clock
}

export interface HarnessOptions {
	key?: TestKey
	keys?: KernelPublicKey[]
	bundled?: BundledFacts | undefined
	enabled?: boolean
	override?: string
	clock?: Clock
	fs?: KernelFs
	platform?: string
	arch?: string
	contractRange?: readonly [number, number]
}

export interface Harness {
	root: string
	kernelRoot: string
	key: TestKey
	clock: Clock
	flags: { enabled: boolean; override: string | undefined }
	bundledFacts: BundledFacts | undefined
	logs: { event: string; detail?: Record<string, unknown> }[]
	store: KernelStore
	manager: KernelManager
	/** A fresh store and manager on the same folder, as the next start of the app would make. */
	restart: (fs?: KernelFs) => Promise<{ store: KernelStore; manager: KernelManager }>
	dispose: () => Promise<void>
}

export const BUNDLED: BundledFacts = {
	commandLine: '51.1.0',
	engine: '62.13.0',
	dataEpoch: 1,
	desktopContract: 1,
}

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-kernel-test-'))
	const kernelRoot = join(root, 'kernel')
	const key = options.key ?? makeKey()
	const clock = options.clock ?? makeClock()
	const flags = { enabled: options.enabled ?? true, override: options.override }
	const logs: Harness['logs'] = []
	const bundledFacts = 'bundled' in options ? options.bundled : BUNDLED
	const build = async (fs: KernelFs) => {
		const store = new KernelStore({
			root: kernelRoot,
			fs,
			now: clock.now,
			log: (event, detail) => logs.push({ event, ...(detail ? { detail } : {}) }),
		})
		await store.open()
		const manager = new KernelManager({
			store,
			keys: options.keys ?? [key],
			bundledEntry: join(root, 'bundled', 'dist', 'bin.js'),
			bundledFacts: async () => bundledFacts,
			platform: options.platform ?? 'win32',
			arch: options.arch ?? 'x64',
			contractRange: options.contractRange ?? [1, 1],
			enabled: () => flags.enabled,
			override: () => flags.override,
		})
		return { store, manager }
	}
	const first = await build(options.fs ?? nodeFs)
	return {
		root,
		kernelRoot,
		key,
		clock,
		flags,
		bundledFacts,
		logs,
		store: first.store,
		manager: first.manager,
		restart: (fs) => build(fs ?? nodeFs),
		dispose: () => rm(root, { recursive: true, force: true }),
	}
}

export function expectedOf(commandLine: string, engine: string): ExpectedKernel {
	return { commandLine, engine, desktopContract: 1, dataEpoch: 1 }
}
