import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { ArchiveError, extractArchive } from './archive.js'
import { runCheck } from './check.js'
import { verifyFolderFully } from './files-list.js'
import { parseFilesList } from './files-list.js'
import { nodeFs } from './fs.js'
import {
	FEED,
	type Harness,
	type TarEntry,
	buildArchive,
	chunks,
	kernelFiles,
	makeFeed,
	makeHarness,
	manifestBytesOf,
	signPair,
	tarBytes,
} from './kernel-test-support.js'
import { ManifestError, verifyManifest } from './manifest.js'

/**
 * The publisher (scripts/kernel/*.mjs) and the app (this folder) were built apart from the same text.
 * These tests make them meet: what one writes the other reads, and every deliberately broken archive
 * and signed pair, whoever built the bytes, is refused by both readers. The broken cases are DATA in
 * scripts/__tests__/kernel-cases.mjs, shared with the publisher's own tests.
 */

const here = import.meta.url
const load = async <T>(relative: string): Promise<T> =>
	(await import(/* @vite-ignore */ new URL(relative, here).href)) as T

interface Cases {
	FILES: Record<string, string>
	archiveCases: () => CaseData[]
	limitsOf: (testCase: CaseData) => { fileCount: number; unpackedSize: number }
	renderWithPublisherBuilder: (testCase: CaseData) => Buffer
	pairCases: () => {
		label: string
		make: (ctx: PairContext) => { manifest: Buffer; signature: Buffer }
	}[]
	makePairKey: (id?: string) => PairKey
	goodManifest: () => Record<string, unknown>
	signedPair: (
		manifest: Record<string, unknown>,
		key: PairKey,
	) => { manifest: Buffer; signature: Buffer }
	manifestText: (manifest: Record<string, unknown>) => Buffer
	publicOnly: (key: PairKey) => { id: string; publicKey: string }
	GOOD_NAMES: string[]
	filesJsonOf: (files: Record<string, string>) => Buffer
	goodEntries: (files: Record<string, string>) => CaseEntry[]
	sha512: (data: Buffer | string) => string
}
interface PairKey {
	id: string
	publicKey: string
	privateKey: ReturnType<typeof import('node:crypto').generateKeyPairSync>['privateKey']
}
interface PairContext {
	key: PairKey
	other: PairKey
	good: { manifest: Buffer; signature: Buffer }
}
interface CaseEntry {
	name: string
	data?: Buffer | string
	type?: string
	linkname?: string
	prefix?: string
	magic?: string
	badChecksum?: boolean
	sizeField?: number
	pax?: [string, string][]
}
interface CaseData {
	label: string
	files?: Record<string, string>
	entries?: CaseEntry[]
	endBlocks?: number
	trailing?: Buffer
	cutGz?: number
	cutTar?: number
	raw?: Buffer
	limits?: { fileCount: number; unpackedSize: number }
}

interface PublisherReader {
	ArchiveRefusal: new (message: string) => Error
	readArchive: (
		path: string,
		options?: {
			limits?: { fileCount: number; unpackedSize: number }
			sink?: unknown
		},
	) => Promise<{ files: Map<string, unknown> }>
}
interface PublisherWriter {
	writeArchive: (options: {
		root: string
		archivePath: string
		filesJsonPath?: string
	}) => Promise<{
		list: { files: { path: string }[] }
		bundle: {
			size: number
			sha512: string
			filesSha512: string
			fileCount: number
			unpackedSize: number
		}
	}>
	filesJsonBytes: (list: unknown) => Buffer
}
interface PublisherVerify {
	describeArchive: (
		path: string,
		options?: { limits?: { fileCount: number; unpackedSize: number } },
	) => Promise<{
		target: string
		kernel: Record<string, unknown>
		bundle: Record<string, unknown>
	}>
	verifyRelease: (options: {
		manifestPath: string
		signaturePath: string
		keysPath: string
		archivePath: string
		now: number
	}) => Promise<string[]>
}
interface PublisherManifest {
	assembleManifest: (options: Record<string, unknown>) => Record<string, unknown>
	manifestBytes: (manifest: Record<string, unknown>) => Buffer
	parseManifest: (bytes: Buffer) => unknown
}
interface PublisherSigning {
	makeKeyPair: (id: string) => { privatePem: string; entry: { id: string; publicKey: string } }
	privateKeyFromText: (text: string) => PairKey['privateKey']
	signManifest: (bytes: Buffer, privateKey: PairKey['privateKey'], keyId: string) => Buffer
	verifySignature: (bytes: Buffer, signature: Buffer, keys: unknown[]) => { keyId: string }
	parseKeyList: (text: string) => unknown[]
}

const dirs: string[] = []
const harnesses: Harness[] = []
afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((h) => h.dispose()))
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-cross-'))
	dirs.push(dir)
	return dir
}
async function writeFolder(root: string, files: Record<string, string>): Promise<void> {
	for (const [path, data] of Object.entries(files)) {
		const full = join(root, ...path.split('/'))
		await mkdir(join(full, '..'), { recursive: true })
		await writeFile(full, data)
	}
}
async function folderContents(root: string, prefix = ''): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	for (const name of await readdir(join(root, prefix))) {
		const relative = prefix ? `${prefix}/${name}` : name
		if ((await stat(join(root, relative))).isDirectory())
			Object.assign(out, await folderContents(root, relative))
		else out[relative] = (await readFile(join(root, relative))).toString()
	}
	return out
}

const KERNEL = { commandLine: '51.3.0', engine: '62.14.0' }
/** A kernel folder as the staging step leaves it, plus names that need a pax header, non-ASCII letters and an empty file. */
function kernelFolder(): Record<string, string> {
	return kernelFiles(KERNEL.commandLine, KERNEL.engine, {
		extra: {
			[`node_modules/${'deep-'.repeat(25)}package/a-file-with-a-long-name-to-need-a-pax-header.js`]:
				'// long\n',
			'skills/ünïcode.md': '# unicode name\n',
			'dist/empty.txt': '',
			'dist/big.bin': 'x'.repeat(200_000),
		},
	})
}

async function appRefuses(
	bytes: Buffer,
	files: Record<string, string> | undefined,
	testCase: CaseData,
	cases: Cases,
): Promise<string> {
	const dir = await scratch()
	const listed = testCase.entries?.find((entry) => entry.name === 'files.json')
	const filesJson = listed
		? Buffer.from(listed.data ?? '')
		: cases.filesJsonOf(files ?? cases.FILES)
	const limits = { ...cases.limitsOf(testCase), filesSha512: cases.sha512(filesJson) }
	try {
		await extractArchive({
			source: chunks(bytes),
			target: join(dir, 'x'),
			fs: nodeFs,
			limits,
		})
	} catch (error) {
		if (error instanceof ArchiveError) {
			// a refusal leaves nothing behind
			expect(await stat(join(dir, 'x')).catch(() => undefined)).toBeUndefined()
			return error.code
		}
		throw error
	}
	return ''
}

async function publisherRefuses(
	bytes: Buffer,
	testCase: CaseData,
	cases: Cases,
	reader: PublisherReader,
): Promise<string> {
	const dir = await scratch()
	await writeFile(join(dir, 'a.tar.gz'), bytes)
	try {
		await reader.readArchive(join(dir, 'a.tar.gz'), { limits: cases.limitsOf(testCase) })
	} catch (error) {
		if (error instanceof reader.ArchiveRefusal) return error.message
		throw error
	}
	return ''
}

/** The case as the app's own test builder writes it. */
function renderWithAppBuilder(testCase: CaseData, cases: Cases): Buffer {
	if (testCase.raw) return testCase.raw
	const entries = testCase.entries ?? cases.goodEntries(testCase.files ?? cases.FILES)
	const rendered: TarEntry[] = entries.map((entry) => {
		const base: TarEntry = {
			name: entry.name,
			data: entry.data ?? '',
			...(entry.type !== undefined && entry.type !== 'x' ? { type: entry.type } : {}),
			...(entry.linkname ? { linkname: entry.linkname } : {}),
			...(entry.prefix ? { prefix: entry.prefix } : {}),
			...(entry.magic ? { magic: entry.magic } : {}),
			...(entry.badChecksum ? { badChecksum: true } : {}),
			...(entry.sizeField !== undefined ? { sizeField: entry.sizeField } : {}),
			...(entry.pax ? { paxRecords: entry.pax } : {}),
		}
		return entry.type === 'x' ? { ...base, paxOnly: true } : base
	})
	let tar = tarBytes(rendered, {
		...(testCase.endBlocks !== undefined ? { endBlocks: testCase.endBlocks } : {}),
		...(testCase.trailing ? { trailing: testCase.trailing } : {}),
	})
	if (testCase.cutTar !== undefined) tar = tar.subarray(0, testCase.cutTar)
	let gz = gzipSync(tar)
	if (testCase.cutGz !== undefined) gz = gz.subarray(0, gz.length - testCase.cutGz)
	return gz
}

describe('a folder packed, described and signed by the publisher is read by the app', () => {
	it('is accepted by the reader, installed by the store, and passes the quick check', async () => {
		const writer = await load<PublisherWriter>('../../../scripts/kernel/archive-writer.mjs')
		const verify = await load<PublisherVerify>('../../../scripts/kernel/verify.mjs')
		const manifests = await load<PublisherManifest>('../../../scripts/kernel/manifest.mjs')
		const signing = await load<PublisherSigning>('../../../scripts/kernel/signing.mjs')

		const dir = await scratch()
		const source = join(dir, 'source')
		const files = kernelFolder()
		await writeFolder(source, files)
		const archivePath = join(dir, 'namzu-kernel-51.3.0-win32-x64.tar.gz')
		await writer.writeArchive({ root: source, archivePath })
		const described = await verify.describeArchive(archivePath)
		expect(described.target).toBe('win32-x64')

		const made = signing.makeKeyPair('k1')
		const manifest = manifests.assembleManifest({
			entries: [{ target: described.target, kernel: described.kernel, bundle: described.bundle }],
			issuedAt: '2026-11-12T10:00:00Z',
		})
		const manifestBytes = manifests.manifestBytes(manifest)
		const signature = signing.signManifest(
			manifestBytes,
			signing.privateKeyFromText(made.privatePem),
			'k1',
		)
		// The publisher's own last check passes on what it made.
		const keysPath = join(dir, 'kernel-keys.json')
		await writeFile(keysPath, JSON.stringify([made.entry]))
		await writeFile(join(dir, 'kernel-latest.json'), manifestBytes)
		await writeFile(join(dir, 'kernel-latest.json.sig'), signature)
		await verify.verifyRelease({
			manifestPath: join(dir, 'kernel-latest.json'),
			signaturePath: join(dir, 'kernel-latest.json.sig'),
			keysPath,
			archivePath,
			now: Date.parse('2026-11-12T12:00:00Z'),
		})

		// The app reads the signed pair ...
		const read = verifyManifest(manifestBytes, signature, [made.entry])
		expect(read.keyId).toBe('k1')
		const bundle = read.manifest.kernel.bundles['win32-x64']
		expect(bundle).toBeDefined()
		if (!bundle) return
		// ... and its reader takes the archive, byte for byte the folder that was packed.
		const target = join(dir, 'unpacked')
		const extracted = await extractArchive({
			source: chunks(await readFile(archivePath)),
			target,
			fs: nodeFs,
			limits: {
				fileCount: bundle.fileCount,
				unpackedSize: bundle.unpackedSize,
				filesSha512: bundle.filesSha512,
			},
		})
		expect(await verifyFolderFully(nodeFs, target, extracted.list)).toBeUndefined()
		const { 'files.json': _list, ...unpacked } = await folderContents(target)
		expect(unpacked).toEqual(files)

		// The whole background check on a feed that serves the publisher's files installs it.
		const h = await makeHarness({ keys: [made.entry] })
		harnesses.push(h)
		const feed = makeFeed({
			'kernel-latest.json': manifestBytes,
			'kernel-latest.json.sig': signature,
			[bundle.file]: await readFile(archivePath),
		})
		const result = await runCheck({
			manager: h.manager,
			feedBase: FEED,
			channel: 'latest',
			fetch: feed.fetch,
			now: h.clock.now,
			selfCheck: async () => undefined,
		})
		expect(result).toMatchObject({ kind: 'ready', version: KERNEL.commandLine })
		expect(h.store.snapshot().pending).toBe(KERNEL.commandLine)
		const resolved = await h.manager.resolve()
		expect(resolved).toMatchObject({ source: 'managed', version: KERNEL.commandLine })
		expect(await h.manager.quickCheck(KERNEL.commandLine, h.bundledFacts as never)).toMatchObject({
			ok: true,
		})
		expect(
			parseFilesList(
				await readFile(join(h.kernelRoot, 'versions', KERNEL.commandLine, 'files.json')),
			).files,
		).toHaveLength(Object.keys(files).length)
	})

	it('gives the same bytes as the app test builder for the same folder (files.json, tar and gzip)', async () => {
		const writer = await load<PublisherWriter>('../../../scripts/kernel/archive-writer.mjs')
		const dir = await scratch()
		const source = join(dir, 'source')
		const files = kernelFolder()
		await writeFolder(source, files)
		const archivePath = join(dir, 'a.tar.gz')
		const { list } = await writer.writeArchive({ root: source, archivePath })
		const built = buildArchive(KERNEL.commandLine, files)
		expect(writer.filesJsonBytes(list).equals(built.filesJson)).toBe(true)
		const publisherBytes = await readFile(archivePath)
		// The whole file is equal: both write the same tar, and gzip with the same fixed settings.
		expect(publisherBytes.equals(built.gz)).toBe(true)
	})

	it('gives the same signed pair as the app test signer, and the same manifest text as the shared case file', async () => {
		const manifests = await load<PublisherManifest>('../../../scripts/kernel/manifest.mjs')
		const signing = await load<PublisherSigning>('../../../scripts/kernel/signing.mjs')
		const cases = await load<Cases>('../../../scripts/__tests__/kernel-cases.mjs')
		const key = cases.makePairKey('k1')
		const object = cases.goodManifest()
		const pairFromApp = signPair(object, key)
		const text = manifests.manifestBytes(object)
		expect(pairFromApp.manifest.equals(text)).toBe(true)
		expect(cases.manifestText(object).equals(text)).toBe(true)
		expect(manifestBytesOf(object).equals(text)).toBe(true)
		// Ed25519 is deterministic, so the same key over the same bytes is the same signature file.
		expect(signing.signManifest(text, key.privateKey, 'k1').equals(pairFromApp.signature)).toBe(
			true,
		)
		// Both read the other's.
		expect(() => manifests.parseManifest(pairFromApp.manifest)).not.toThrow()
		expect(verifyManifest(text, pairFromApp.signature, [cases.publicOnly(key)]).keyId).toBe('k1')
	})
})

describe('every broken archive is refused by both readers, whoever built the bytes', () => {
	it('accepts the good archive built by either builder, and every name the text allows', async () => {
		const cases = await load<Cases>('../../../scripts/__tests__/kernel-cases.mjs')
		const reader = await load<PublisherReader>('../../../scripts/kernel/archive-reader.mjs')
		const good: CaseData = { label: 'good' }
		for (const bytes of [
			cases.renderWithPublisherBuilder(good),
			renderWithAppBuilder(good, cases),
		]) {
			expect(await appRefuses(bytes, undefined, good, cases)).toBe('')
			expect(await publisherRefuses(bytes, good, cases, reader)).toBe('')
		}
		for (const name of cases.GOOD_NAMES) {
			const named: CaseData = { label: name, files: { [name]: 'x' } }
			const bytes = renderWithAppBuilder(named, cases)
			expect(await appRefuses(bytes, named.files, named, cases)).toBe('')
			expect(await publisherRefuses(bytes, named, cases, reader)).toBe('')
		}
	})

	it('refuses every case, in both readers, built both ways', async () => {
		const cases = await load<Cases>('../../../scripts/__tests__/kernel-cases.mjs')
		const reader = await load<PublisherReader>('../../../scripts/kernel/archive-reader.mjs')
		const list = cases.archiveCases()
		expect(list.length).toBeGreaterThan(100)
		const failures: string[] = []
		for (const testCase of list) {
			const builders: [string, Buffer][] = [
				['publisher builder', cases.renderWithPublisherBuilder(testCase)],
				['app builder', renderWithAppBuilder(testCase, cases)],
			]
			for (const [builder, bytes] of builders) {
				if ((await appRefuses(bytes, testCase.files, testCase, cases)) === '')
					failures.push(`app reader accepted: ${testCase.label} (${builder})`)
				if ((await publisherRefuses(bytes, testCase, cases, reader)) === '')
					failures.push(`publisher reader accepted: ${testCase.label} (${builder})`)
			}
		}
		expect(failures).toEqual([])
		// Over a hundred cases, each built twice and read twice, each read
		// unpacking into a folder of its own on disk: about a second on a quiet
		// machine and past the five-second default on a runner that is running
		// the other packages' suites beside this one. Nothing here waits on a
		// clock; the room is for real gzip and filesystem work.
	}, 30_000)
})

describe('every broken signed pair is refused by both verifiers', () => {
	it('accepts the good pair and refuses every case', async () => {
		const cases = await load<Cases>('../../../scripts/__tests__/kernel-cases.mjs')
		const manifests = await load<PublisherManifest>('../../../scripts/kernel/manifest.mjs')
		const signing = await load<PublisherSigning>('../../../scripts/kernel/signing.mjs')
		const key = cases.makePairKey('k1')
		const other = cases.makePairKey('k1')
		const good = cases.signedPair(cases.goodManifest(), key)
		const trusted = [cases.publicOnly(key)]
		const appSays = (pair: { manifest: Buffer; signature: Buffer }): string => {
			try {
				verifyManifest(pair.manifest, pair.signature, trusted)
			} catch (error) {
				if (error instanceof ManifestError) return error.code
				throw error
			}
			return ''
		}
		const publisherSays = (pair: { manifest: Buffer; signature: Buffer }): string => {
			try {
				signing.verifySignature(
					pair.manifest,
					pair.signature,
					signing.parseKeyList(JSON.stringify(trusted)),
				)
				manifests.parseManifest(pair.manifest)
			} catch (error) {
				return error instanceof Error ? error.message : String(error)
			}
			return ''
		}
		expect(appSays(good)).toBe('')
		expect(publisherSays(good)).toBe('')
		const failures: string[] = []
		for (const testCase of cases.pairCases()) {
			const pair = testCase.make({ key, other, good })
			if (appSays(pair) === '') failures.push(`app verifier accepted: ${testCase.label}`)
			if (publisherSays(pair) === '')
				failures.push(`publisher verifier accepted: ${testCase.label}`)
		}
		expect(failures).toEqual([])
	})

	it("also refuses the app signer's pair when it is bent, in the publisher", async () => {
		const cases = await load<Cases>('../../../scripts/__tests__/kernel-cases.mjs')
		const manifests = await load<PublisherManifest>('../../../scripts/kernel/manifest.mjs')
		const key = cases.makePairKey('k1')
		const object = cases.goodManifest()
		// The app's signer given a compact object serialisation: signed, but not the exact bytes of the text.
		const compact = signPair(Buffer.from(JSON.stringify(object)) as never, key)
		expect(() => manifests.parseManifest(compact.manifest)).toThrow()
		expect(() =>
			verifyManifest(compact.manifest, compact.signature, [cases.publicOnly(key)]),
		).toThrow(ManifestError)
	})
})
