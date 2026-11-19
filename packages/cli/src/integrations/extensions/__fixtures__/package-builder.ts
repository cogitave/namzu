import {
	type KeyObject,
	createHash,
	createPrivateKey,
	createPublicKey,
	sign as edSign,
	generateKeyPairSync,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { canon, sha256Hex } from '../canon.js'
import type { TrustedKey } from '../keys.js'

/**
 * Test-only: builds a signed `.nzx` package around a stub extension, with EPHEMERAL keys made per test.
 * It is not the activity extension and nothing here ships (the build excludes `__fixtures__`).
 */

const HERE = dirname(fileURLToPath(import.meta.url))
export const STUB_SOURCE = readFileSync(join(HERE, 'stub-extension.cjs.txt'), 'utf8')

export interface TestKey {
	readonly id: string
	readonly privateKey: KeyObject
	readonly publicB64: string
}

export function makeKey(id: string): TestKey {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519')
	const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
	return {
		id,
		privateKey,
		publicB64: spki.subarray(spki.length - 32).toString('base64'),
	}
}

export const trustedFrom = (
	k: TestKey,
	publisher = 'example',
	idPrefixes: string[] = ['com.example.'],
	dev = false,
): TrustedKey => ({
	id: k.id,
	publisher,
	idPrefixes,
	publicKey: k.publicB64,
	...(dev ? { dev } : {}),
})

const crcTable = (() => {
	const t = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		t[n] = c >>> 0
	}
	return t
})()
const crc32 = (b: Buffer): number => {
	let c = 0xffffffff
	for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntryIn {
	name: string
	data: Buffer
	/** Unix mode bits for the external attributes (default 0o100644). */
	mode?: number
	/** Store instead of deflate. */
	store?: boolean
	/** Lie about the uncompressed size in the central directory (zip bomb test). */
	claimSize?: number
}

export function makeZip(entries: ZipEntryIn[]): Buffer {
	const parts: Buffer[] = []
	const central: Buffer[] = []
	let offset = 0
	for (const e of entries) {
		const name = Buffer.from(e.name, 'utf8')
		const body = e.store === false || e.store === undefined ? deflateRawSync(e.data) : e.data
		const method = e.store === false || e.store === undefined ? 8 : 0
		const crc = crc32(e.data)
		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4)
		local.writeUInt16LE(method, 8)
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(body.length, 18)
		local.writeUInt32LE(e.data.length, 22)
		local.writeUInt16LE(name.length, 26)
		parts.push(local, name, body)
		const c = Buffer.alloc(46)
		c.writeUInt32LE(0x02014b50, 0)
		c.writeUInt16LE((3 << 8) | 20, 4)
		c.writeUInt16LE(20, 6)
		c.writeUInt16LE(method, 10)
		c.writeUInt32LE(crc, 16)
		c.writeUInt32LE(body.length, 20)
		c.writeUInt32LE(e.claimSize ?? e.data.length, 24)
		c.writeUInt16LE(name.length, 28)
		c.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38)
		c.writeUInt32LE(offset, 42)
		central.push(c, name)
		offset += local.length + name.length + body.length
	}
	const dir = Buffer.concat(central)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(entries.length, 8)
	end.writeUInt16LE(entries.length, 10)
	end.writeUInt32LE(dir.length, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...parts, dir, end])
}

type Json = Record<string, unknown>
const t = (en: string, tr?: string): Record<string, string> => (tr ? { en, tr } : { en })

export const platformKey = (): string => `${process.platform}-${process.arch}`

/** A small valid manifest: two permissions (one optional), two data kinds, three queries. */
export function sampleManifest(
	overrides: (m: Json) => void = () => {},
	opts: { version?: string; keyId?: string; platform?: string } = {},
): Json {
	const pl = opts.platform ?? platformKey()
	const cmd = { exe: 'bin/stub.cjs', args: [] as string[] }
	const m: Json = {
		manifestVersion: 1,
		id: 'com.example.stub-recorder',
		defaultLocale: 'en',
		locales: ['en', 'tr'],
		name: t('Stub Recorder', 'Deneme Kaydedici'),
		description: t(
			'A test extension that records nothing real.',
			'Gerçek hiçbir şey kaydetmeyen bir deneme uzantısı.',
		),
		version: opts.version ?? '1.0.0',
		publisher: {
			id: 'example',
			name: 'Example Publisher',
			contact: 'privacy@example.test',
		},
		license: 'Proprietary',
		engines: { namzu: '>=1.0.0', extensionApi: '1' },
		platforms: [pl],
		entry: {
			process: {
				id: 'recorder',
				command: { [pl]: cmd },
				cwd: '${extensionDir}',
				env: { STUB_LOCALE: '${locale}' },
				scope: 'per-user-session',
				start: 'onEnable',
				restart: {
					policy: 'onFailure',
					backoffMs: [1000, 5000],
					maxPerHour: 3,
					stableAfterMs: 60000,
				},
				stopGraceMs: 2000,
			},
			maintenance: {
				command: { [pl]: { exe: 'bin/stub.cjs', args: ['purge'] } },
				runWhen: ['hostStart', 'onDisable', 'onLicenseExpired'],
				timeoutMs: 10000,
			},
		},
		contributes: {
			endpoint: {
				protocol: 'namzu-ext-query/1',
				name: 'stub-recorder',
				queries: [
					{
						id: 'status',
						returns: [],
						schema: 'schemas/status.json',
						maxBytes: 4096,
						purpose: t(
							'So Namzu can show whether the recorder is working.',
							'Namzu kaydedicinin çalıştığını gösterebilsin diye.',
						),
					},
					{
						id: 'counts',
						returns: ['stub.app.minute'],
						schema: 'schemas/counts.json',
						maxBytes: 4096,
						purpose: t('So the page can show counts.'),
					},
					{
						id: 'rows',
						returns: ['stub.app.minute'],
						schema: 'schemas/rows.json',
						maxBytes: 4096,
						purpose: t('So the person can see the stored rows.'),
					},
				],
			},
			settings: [
				{
					key: 'modelKey',
					type: 'secret',
					perProvider: true,
					storage: 'hostKeysFile',
					usedBy: 'none',
					label: t('Model API key'),
					purpose: t('Stored for a later release; nothing uses it now.'),
				},
			],
			pages: [
				{
					id: 'what-is-collected',
					title: t('What is collected', 'Neler toplanıyor'),
					location: 'desktop.settings',
					view: 'builtin:what-is-collected',
					source: { kind: 'privacy', counts: 'query:counts' },
				},
			],
			indicator: {
				id: 'recording',
				locations: ['desktop.titlebar', 'cli.statusline'],
				alwaysVisibleWhenRunning: true,
				states: {
					collecting: {
						label: t(
							'Stub Recorder is counting which program is in front.',
							'Deneme Kaydedici öndeki programı sayıyor.',
						),
					},
					degraded: { label: t('Stub Recorder has gaps.') },
				},
			},
		},
		permissions: [
			{
				id: 'os.foregroundWindow',
				level: 'medium',
				optional: false,
				personalData: true,
				summary: t('Sees which program is in front.', 'Öndeki programı görür.'),
				purposes: [
					{
						id: 'time-per-app',
						text: t(
							'To count the time spent in each program.',
							'Her programda geçen süreyi saymak için.',
						),
					},
				],
			},
			{
				id: 'os.screenChange',
				level: 'high',
				optional: true,
				personalData: true,
				summary: t('Compares a tiny grey grid of the screen.'),
				purposes: [
					{
						id: 'screen-activity',
						text: t('To keep one number for how much the screen changed.'),
					},
				],
				prompt: t('Allow the screen-change number?'),
			},
		],
		network: { mode: 'none' },
		files: [
			{
				path: '${dataDir}',
				access: 'readWrite',
				purpose: t('Its own folder for the stored rows.'),
			},
		],
		produces: [
			{
				id: 'stub.app.minute',
				from: ['os.foregroundWindow'],
				description: t(
					'Seconds per program in each minute.',
					'Her dakikada program başına saniye.',
				),
				grain: 'minute',
				fields: [
					{
						name: 'minute',
						type: 'timestamp',
						description: t('The minute (UTC)'),
					},
					{ name: 'exe', type: 'text', description: t('Program file name') },
					{
						name: 'seconds',
						type: 'integer',
						description: t('Seconds in front'),
					},
				],
				retentionDays: 7,
				leavesMachine: false,
			},
			{
				id: 'stub.screen.minute',
				from: ['os.screenChange'],
				description: t('How much the screen changed in a minute.'),
				grain: 'minute',
				fields: [
					{
						name: 'minute',
						type: 'timestamp',
						description: t('The minute (UTC)'),
					},
					{
						name: 'meanScore',
						type: 'integer',
						description: t('Mean change score'),
					},
				],
				retentionDays: 7,
				leavesMachine: false,
			},
		],
		privacy: {
			doesNotCollect: [
				t('Which keys are pressed', 'Hangi tuşlara basıldığı'),
				t('Screenshots or any image'),
			],
			doesNotDo: [t('Send anything off this computer')],
			storage: {
				where: t('This computer, in its own data folder.'),
				encryption: t('A private file.'),
				adminCanRead: true,
			},
			leavesTheMachine: 'nothing',
			controller: t('Your employer, named in the notice.'),
			rights: { view: true, delete: t('On request to your employer.') },
			monitoringKind: 'employee-activity',
		},
		legal: {
			noticeVersion: '1.0',
			notices: {
				en: { file: 'legal/notice.en.md', sha256: '0'.repeat(64) },
				tr: { file: 'legal/notice.tr.md', sha256: '0'.repeat(64) },
			},
			acknowledgement: { mode: 'inform-and-acknowledge', retainDays: 1825 },
			jurisdictions: ['TR'],
		},
		licensing: {
			kind: 'key',
			required: true,
			verifier: {
				type: 'ed25519-offline',
				keyId: 'dev-license-t',
				keyFile: 'keys/license-pub.json',
			},
			claims: ['customer', 'seats'],
			onInvalid: 'disableAndExplain',
			graceDays: 0,
		},
		resources: {
			maxMemoryMB: 30,
			cpuSharePercent: 2,
			maxDiskMB: 25,
			onExceed: 'report',
			enforcement: 'report',
		},
		updates: {
			channel: 'stable',
			permissionChange: 'askAgain',
			autoUpdate: 'never',
		},
		signing: {
			publisherKeyId: opts.keyId ?? 'dev-pub-t',
			manifestSignature: 'signatures/manifest.sig',
			files: 'files.sha256.json',
		},
	}
	overrides(m)
	return m
}

export interface BuildInput {
	manifest: Json
	publisherKey: TestKey
	licenseKey: TestKey
	/** Extra or replaced package files. A value of `null` removes one. */
	files?: Record<string, Buffer | string | null>
	noticeBody?: { en?: string; tr?: string }
	/** Zip-level damage for the refusal tests. */
	extraEntries?: ZipEntryIn[]
	/** Change a byte of this file after signing. */
	tamper?: string
	signWith?: TestKey
}

export function buildPackage(input: BuildInput): Buffer {
	const m = JSON.parse(JSON.stringify(input.manifest)) as Json & {
		legal: { notices: Record<string, { file: string; sha256: string }> }
		licensing: {
			kind: string
			verifier?: { keyId: string }
			service?: { verifier: { keyId: string } }
		}
	}
	if (m.licensing.kind === 'key' && m.licensing.verifier)
		m.licensing.verifier.keyId = input.licenseKey.id
	if (m.licensing.kind === 'service' && m.licensing.service)
		m.licensing.service.verifier.keyId = input.licenseKey.id
	const files = new Map<string, Buffer>()
	const exec = new Set<string>()
	files.set('bin/stub.cjs', Buffer.from(`#!${process.execPath}\n${STUB_SOURCE}`))
	exec.add('bin/stub.cjs')
	const nb = input.noticeBody ?? {}
	for (const [loc, n] of Object.entries(m.legal.notices)) {
		const body = Buffer.from(
			`<!-- locale: ${loc} -->\n${nb[loc as 'en' | 'tr'] ?? `Notice in ${loc}. This is a test notice.`}\n`,
		)
		files.set(n.file, body)
		n.sha256 = sha256Hex(body)
	}
	files.set(
		'schemas/status.json',
		Buffer.from(
			JSON.stringify({
				type: 'object',
				required: ['signals'],
				properties: { signals: { type: 'object' } },
				additionalProperties: false,
			}),
		),
	)
	files.set(
		'schemas/counts.json',
		Buffer.from(
			JSON.stringify({
				type: 'object',
				required: ['kind', 'count'],
				properties: { kind: { type: 'string' }, count: { type: 'integer' } },
				additionalProperties: false,
			}),
		),
	)
	files.set(
		'schemas/rows.json',
		Buffer.from(
			JSON.stringify({
				type: 'object',
				required: ['kind', 'columns', 'rows'],
				properties: {
					kind: { type: 'string' },
					columns: { type: 'array', items: { type: 'string' } },
					rows: { type: 'array' },
				},
				additionalProperties: false,
			}),
		),
	)
	files.set(
		'keys/license-pub.json',
		Buffer.from(
			JSON.stringify({
				keyId: input.licenseKey.id,
				algorithm: 'ed25519',
				publicKey: input.licenseKey.publicB64,
			}),
		),
	)
	for (const [name, v] of Object.entries(input.files ?? {})) {
		if (v === null) files.delete(name)
		else files.set(name, Buffer.isBuffer(v) ? v : Buffer.from(v))
	}
	const manifestBytes = Buffer.from(`${JSON.stringify(m, null, 2)}\n`)
	const list = {
		schema: 1,
		files: Object.fromEntries(
			[...files.keys()].sort().map((k) => [
				k,
				{
					sha256: sha256Hex(files.get(k) as Buffer),
					size: (files.get(k) as Buffer).length,
				},
			]),
		),
	}
	const listBytes = Buffer.from(`${canon(list)}\n`)
	const statement = Buffer.from(
		`namzu-extension/1\nmanifest-sha256:${sha256Hex(manifestBytes)}\nfiles-sha256:${sha256Hex(listBytes)}\n`,
	)
	const key = input.signWith ?? input.publisherKey
	const sig = edSign(null, statement, key.privateKey).toString('base64')
	const sigFile = Buffer.from(
		`${canon({ schema: 1, keyId: key.id, algorithm: 'ed25519', signature: sig })}\n`,
	)
	if (input.tamper) {
		const f = files.get(input.tamper)
		if (f) files.set(input.tamper, Buffer.concat([f, Buffer.from(' ')]))
		else if (input.tamper === 'namzu-extension.json') {
			const entries = zipOf(Buffer.concat([manifestBytes, Buffer.from(' ')]))
			return makeZip(entries)
		}
	}
	return makeZip(zipOf(manifestBytes))

	function zipOf(mb: Buffer): ZipEntryIn[] {
		const out: ZipEntryIn[] = [
			{ name: 'namzu-extension.json', data: mb },
			{ name: 'files.sha256.json', data: listBytes },
			{ name: 'signatures/manifest.sig', data: sigFile },
		]
		for (const [name, data] of files)
			out.push({ name, data, mode: exec.has(name) ? 0o100755 : 0o100644 })
		return [...out, ...(input.extraEntries ?? [])]
	}
}

/** A signed licence for the stub extension. */
export function makeLicense(
	key: TestKey,
	over: Partial<{
		extensionId: string
		expires: string
		notBefore: string
		seats: number
	}> = {},
): string {
	const payload = {
		v: 1,
		licenseId: '00000000-0000-4000-8000-000000000001',
		extensionId: over.extensionId ?? 'com.example.stub-recorder',
		customer: { id: 'test-company', name: 'Test Company' },
		seats: over.seats ?? 25,
		issuedAt: '2026-01-01T00:00:00Z',
		notBefore: over.notBefore ?? '2026-01-01T00:00:00Z',
		expires: over.expires ?? '2099-01-01T00:00:00Z',
		features: [],
	}
	const pb = Buffer.from(canon(payload))
	const sig = edSign(
		null,
		Buffer.concat([Buffer.from('namzu-license/1\n'), pb]),
		key.privateKey,
	).toString('base64')
	return `${canon({ schema: 1, keyId: key.id, algorithm: 'ed25519', payload: pb.toString('base64url'), signature: sig })}\n`
}

export { createHash, createPrivateKey, createPublicKey }
