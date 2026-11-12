// The deliberately broken archives and signed pairs of the engine delivery, as DATA, so one list serves
// every reader and every builder: the publisher's reader and its test builder (kernel-helpers.mjs), and
// the app's reader and its test builder (src/main/kernel/kernel-test-support.ts) render the same cases.
// A case says WHAT is wrong, never how a particular reader finds out; every case must be refused by
// every reader, whoever built the bytes (the cross-format tests in src/main/kernel/cross-format.test.ts
// and scripts/__tests__/kernel-archive.test.mjs run the whole list).
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { END, archive, paxEntry, tarEntry } from './kernel-helpers.mjs'

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
export const sha512 = (data) => createHash('sha512').update(data).digest('hex')
const codeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export const FILES = { 'a.txt': 'alpha', 'b/c.txt': 'gamma' }

/** The list file of `files` in the exact serialisation of the text, with fields bent by `overrides`. */
export function filesJsonOf(files, overrides = {}) {
	const list = Object.keys(files)
		.sort(codeUnits)
		.map((path) => ({
			path,
			size: Buffer.byteLength(files[path]),
			sha256: sha256(files[path]),
		}))
	return Buffer.from(`${JSON.stringify({ schema: 1, files: list, ...overrides })}\n`)
}

/** A list file from explicit entries, compact JSON and one newline. */
export const listFrom = (files) => Buffer.from(`${JSON.stringify({ schema: 1, files })}\n`)

/** The entries of a good archive: files.json first, then every file in the order of the list. */
export function goodEntries(files) {
	return [
		{ name: 'files.json', data: filesJsonOf(files) },
		...Object.keys(files)
			.sort(codeUnits)
			.map((name) => ({ name, data: Buffer.from(files[name]) })),
	]
}

/**
 * One case: `{ label, files, entries, endBlocks, trailing, cutGz, cutTar, raw, limits }`.
 * `entries` are `{ name, data, type, linkname, prefix, magic, badChecksum, sizeField, pax: [[key, value]] }`;
 * a name longer than 100 bytes gets its pax path from the builder, as the text says.
 */
export function limitsOf(testCase) {
	const files = testCase.files ?? FILES
	return (
		testCase.limits ?? {
			fileCount: Object.keys(files).length,
			unpackedSize: Object.values(files).reduce((sum, data) => sum + Buffer.byteLength(data), 0),
		}
	)
}

const insert = (entries, at, ...added) => [...entries.slice(0, at), ...added, ...entries.slice(at)]

export const ENTRY_TYPES = [
	['a symbolic link', '2'],
	['a hard link', '1'],
	['a directory', '5'],
	['a character device', '3'],
	['a global pax header', 'g'],
	['a GNU long name', 'L'],
	['a sparse entry', 'S'],
	['an old-style regular file (type NUL)', '\0'],
]

/** Names no archive may carry, with what is wrong with each. */
export const BAD_NAMES = [
	['/etc/passwd', 'an absolute path'],
	['C:/win/x', 'a drive letter'],
	['C:x', 'a drive letter'],
	['a\\b', 'a backslash'],
	['dir/file:stream', 'a colon'],
	['a//b', 'an empty segment'],
	['./a', 'a dot segment'],
	['a/./b', 'a dot segment'],
	['a/../b', 'a dot-dot segment'],
	['../b', 'a dot-dot segment'],
	['CON', 'a reserved name'],
	['con.txt', 'a reserved name with an extension'],
	['dir/NUL.x.y', 'a reserved name in a folder'],
	['Aux', 'a reserved name'],
	['COM1', 'a reserved name'],
	['lpt9.log', 'a reserved name'],
	['dir./file', 'a segment ending in a dot'],
	['trailing-space /file', 'a segment ending in a space'],
	['file.', 'a name ending in a dot'],
	['con .txt', 'a device name followed by a space before the extension'],
	['CONIN$', 'a console input device name'],
	['conout$.log', 'a console output device name with an extension'],
	['CLOCK$', 'a clock device name'],
	['COM\u00b9', 'a superscript device name'],
	['dir/LPT\u00b2.txt', 'a superscript printer name in a folder'],
	['a\u0001b', 'a control character'],
	['a\u007fb', 'a delete character'],
	['dir/what?.js', 'a character Windows cannot hold'],
	['dir/a*b.js', 'a character Windows cannot hold'],
	['dir/a"b.js', 'a character Windows cannot hold'],
	['dir/a<b>.js', 'a character Windows cannot hold'],
	['dir/a|b.js', 'a character Windows cannot hold'],
	[`dir/${'x'.repeat(256)}`, 'a segment longer than 255 bytes'],
	[`${'d/'.repeat(520)}f`, 'a name longer than 1024 bytes'],
]

/** Names the readers accept (the control for the list above). */
export const GOOD_NAMES = [
	'a',
	'dir/file.js',
	'.hidden',
	'a/.b',
	'node_modules/@scope/pkg/x.node',
	'console.js',
	'aux-file',
	'comm1',
	'a b/c',
]

/** Pairs of names that are one name on a case-insensitive disk. */
export const FOLD_TWINS = [
	['File.txt', 'file.txt'],
	['dist/\u03c3.js', 'dist/\u03c2.js'],
	['dist/stra\u00dfe.js', 'dist/STRASSE.js'],
	['dist/\u00e9.js', 'dist/e\u0301.js'],
	['dist/k.js', 'dist/\u212a.js'],
]

export function archiveCases() {
	const cases = []
	const add = (label, rest) => cases.push({ label, ...rest })
	const good = goodEntries(FILES)

	for (const [label, type] of ENTRY_TYPES)
		add(`an entry that is ${label}`, {
			entries: insert(good, 2, { name: 'extra', type, data: '' }),
		})
	add('a pax key other than path', {
		entries: insert(good, 1, { name: 'PaxHeader', type: 'x', pax: [['mtime', '1']] }),
	})
	add('a pax header with an extra key beside the path', {
		entries: insert(good, 2, {
			name: 'PaxHeader',
			type: 'x',
			pax: [
				['path', 'a.txt'],
				['uid', '5'],
			],
		}),
	})
	add('a pax header that carries path twice', {
		entries: insert(
			good,
			2,
			{
				name: 'PaxHeader',
				type: 'x',
				pax: [
					['path', 'first.txt'],
					['path', 'second.txt'],
				],
			},
			{ name: 'short', data: 'x' },
		),
	})
	add('a name given in a pax header that escapes', {
		entries: insert(
			good,
			2,
			{ name: 'PaxHeader', type: 'x', pax: [['path', '../escape']] },
			{ name: 'short', data: 'x' },
		),
	})

	for (const [name, why] of BAD_NAMES) {
		add(`a name that is ${why} (${JSON.stringify(name).slice(0, 40)}) in the stream`, {
			entries: insert(good, 2, { name, data: 'x' }),
		})
		const ok = { 'ok.txt': 'ok' }
		const listed = [
			{ path: name, size: 2, sha256: sha256('ok') },
			{ path: 'ok.txt', size: 2, sha256: sha256('ok') },
		].sort((x, y) => codeUnits(x.path, y.path))
		add(`a name that is ${why} (${JSON.stringify(name).slice(0, 40)}) in files.json`, {
			files: ok,
			entries: [
				{ name: 'files.json', data: listFrom(listed) },
				{ name: 'ok.txt', data: 'ok' },
			],
			limits: { fileCount: 2, unpackedSize: 4 },
		})
	}

	for (const [a, b] of FOLD_TWINS) {
		add(`two names equal after case folding, both listed (${a} / ${b})`, {
			files: { [a]: 'one', [b]: 'two' },
			entries: goodEntries({ [a]: 'one', [b]: 'two' }),
		})
		add(`a stream entry equal after case folding to a listed name (${a} / ${b})`, {
			files: { [a]: 'one' },
			entries: insert(goodEntries({ [a]: 'one' }), 2, { name: b, data: 'one' }),
		})
	}
	add('an entry that folds to files.json', {
		entries: insert(good, 1, { name: 'FILES.JSON', data: 'x' }),
	})
	add('a name that is a file and a folder', {
		files: { a: 'x', 'a/b': 'y' },
		entries: goodEntries({ a: 'x', 'a/b': 'y' }),
	})

	add('a file the list does not name', {
		entries: insert(good, 3, { name: 'extra.txt', data: 'x' }),
	})
	add('a listed file that is missing at the end', { entries: good.slice(0, 2) })
	add('a listed file that is missing in the middle', {
		files: { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' },
		entries: goodEntries({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' }).filter(
			(entry) => entry.name !== 'b.txt',
		),
	})
	add('a size that differs from files.json', {
		entries: [good[0], { name: 'a.txt', data: 'alphaX' }, good[2]],
	})
	add('a sha256 that differs from files.json', {
		entries: [good[0], { name: 'a.txt', data: 'ALPHA' }, good[2]],
	})
	add('the same file twice', { entries: [...good, good[1]] })
	add('files.json twice', { entries: insert(good, 2, good[0]) })
	add('more files than the manifest states', { limits: { fileCount: 1, unpackedSize: 1000 } })
	add('more unpacked bytes than the manifest states', { limits: { fileCount: 2, unpackedSize: 9 } })
	add('bytes after the end blocks', { trailing: Buffer.from('trailing') })
	add('a whole entry after the end blocks', {
		trailing: tarEntry({ name: 'late.txt', data: 'x' }),
	})
	add('one end block instead of two', { endBlocks: 1 })
	add('no end blocks', { endBlocks: 0 })
	add('a gzip stream cut short', { cutGz: 30 })
	add('a tar stream cut inside a file', { cutTar: 512 + 512 + 512 + 100 })
	add('bytes that are not gzip', { raw: Buffer.from('this is not an archive at all') })

	add('files.json that is not first', { entries: [good[1], good[0], good[2]] })
	add('no files.json', { entries: good.slice(1) })
	add('a files.json in pretty JSON', {
		entries: [
			{ name: 'files.json', data: Buffer.from(JSON.stringify(JSON.parse(good[0].data), null, 2)) },
			...good.slice(1),
		],
	})
	add('a files.json without its newline', {
		entries: [{ name: 'files.json', data: good[0].data.subarray(0, -1) }, ...good.slice(1)],
	})
	add('a files.json that is {}', { entries: [{ name: 'files.json', data: '{}\n' }] })
	add('a files.json with a repeated key', {
		entries: [
			{
				name: 'files.json',
				data: good[0].data.toString().replace('{"schema":1,', '{"schema":1,"schema":1,'),
			},
			...good.slice(1),
		],
	})
	add('a files.json with an unknown field', {
		entries: [{ name: 'files.json', data: filesJsonOf(FILES, { extra: true }) }, ...good.slice(1)],
	})
	const a = { path: 'a.txt', size: 5, sha256: sha256('alpha') }
	const b = { path: 'b/c.txt', size: 5, sha256: sha256('gamma') }
	add('a files.json that is unsorted', {
		entries: [{ name: 'files.json', data: listFrom([b, a]) }],
	})
	add('a files.json that lists itself', {
		entries: [
			{
				name: 'files.json',
				data: listFrom([{ path: 'files.json', size: 1, sha256: sha256('x') }]),
			},
		],
	})
	add('a files.json with a bad hash', {
		entries: [{ name: 'files.json', data: listFrom([{ ...a, sha256: 'xyz' }]) }],
	})
	add('a files.json with a negative size', {
		entries: [{ name: 'files.json', data: listFrom([{ ...a, size: -1 }]) }],
	})
	add('a files.json that lists a path twice', {
		entries: [{ name: 'files.json', data: listFrom([a, a]) }],
	})

	add('a header with a bad checksum', {
		entries: [{ ...good[0], badChecksum: true }, ...good.slice(1)],
	})
	add('a header that is not ustar', {
		entries: [{ ...good[0], magic: 'GNUtar' }, ...good.slice(1)],
	})
	add('a header with a name prefix', { entries: [{ ...good[0], prefix: 'x' }, ...good.slice(1)] })
	add('a regular file that names a link target', {
		entries: [good[0], { ...good[1], linkname: 'elsewhere' }, good[2]],
	})

	const three = { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' }
	const threeEntries = goodEntries(three)
	add('entries in another order than files.json (two swapped)', {
		files: three,
		entries: [threeEntries[0], threeEntries[2], threeEntries[1], threeEntries[3]],
	})
	add('entries in reverse order', {
		files: three,
		entries: [threeEntries[0], threeEntries[3], threeEntries[2], threeEntries[1]],
	})
	return cases
}

/** Renders a case with the PUBLISHER's test builder (kernel-helpers.mjs). Returns the bytes of the file. */
export function renderWithPublisherBuilder(testCase) {
	if (testCase.raw) return testCase.raw
	const entries = testCase.entries ?? goodEntries(testCase.files ?? FILES)
	const parts = []
	for (const entry of entries) {
		const name = entry.name
		const records = [...(entry.pax ?? [])]
		if (Buffer.byteLength(name) > 100 && entry.type !== 'x' && !records.some(([k]) => k === 'path'))
			records.unshift(['path', name])
		if (records.length > 0) parts.push(paxEntry(records))
		if (entry.type === 'x' && entry.pax) continue
		parts.push(
			tarEntry({
				name: Buffer.from(name).subarray(0, 100).toString('utf8'),
				data: entry.data ?? '',
				...(entry.type !== undefined ? { type: entry.type } : {}),
				...(entry.linkname ? { linkname: entry.linkname } : {}),
				...(entry.prefix ? { prefix: entry.prefix } : {}),
				...(entry.magic ? { magic: entry.magic } : {}),
				...(entry.badChecksum ? { badSum: true } : {}),
				...(entry.sizeField !== undefined ? { size: entry.sizeField } : {}),
			}),
		)
	}
	parts.push(Buffer.alloc(512 * (testCase.endBlocks ?? 2)))
	if (testCase.trailing) parts.push(Buffer.from(testCase.trailing))
	let tar = Buffer.concat(parts)
	if (testCase.cutTar !== undefined) tar = tar.subarray(0, testCase.cutTar)
	let gz = archive([tar])
	if (testCase.cutGz !== undefined) gz = gz.subarray(0, gz.length - testCase.cutGz)
	return gz
}

export { END }

// --- signed pairs --------------------------------------------------------------------------

/** A key pair for a test: `{ id, publicKey (base64 of 32 raw bytes), privateKey (KeyObject) }`. */
export function makePairKey(id = 'k1') {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519')
	return {
		id,
		publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
		privateKey,
	}
}

export const GOOD_BUNDLE = {
	file: 'namzu-kernel-51.3.0-win32-x64.tar.gz',
	size: 1234,
	sha512: 'a'.repeat(128),
	filesSha512: 'b'.repeat(128),
	fileCount: 5,
	unpackedSize: 4321,
}

export function goodManifest() {
	return {
		schema: 1,
		channel: 'latest',
		sequence: 1794480000,
		issuedAt: '2026-11-12T10:00:00Z',
		expiresAt: '2026-11-26T10:00:00Z',
		minimumKernel: '51.0.0',
		withdrawn: [],
		kernel: {
			commandLine: '51.3.0',
			engine: '62.14.0',
			desktopContract: 1,
			dataEpoch: 1,
			bundles: { 'win32-x64': { ...GOOD_BUNDLE } },
		},
	}
}

/** The exact bytes of the text (7.6), written here independently of both builders. */
export function manifestText(manifest) {
	const bundles = Object.fromEntries(
		Object.keys(manifest.kernel.bundles)
			.sort()
			.map((name) => [name, manifest.kernel.bundles[name]]),
	)
	return Buffer.from(
		`${JSON.stringify({ ...manifest, kernel: { ...manifest.kernel, bundles } }, null, 2)}\n`,
	)
}

/** A signature file of the text (3.5, 7.6), signed over exactly `manifestBytes`. */
export function signatureFile(manifestBytes, key, { keyId = key.id, ...bend } = {}) {
	const signature = sign(null, manifestBytes, key.privateKey).toString('base64')
	return Buffer.from(
		`${JSON.stringify({ schema: 1, keyId, algorithm: 'ed25519', signature, ...bend })}\n`,
	)
}

export const publicOnly = (key) => ({ id: key.id, publicKey: key.publicKey })

/** A pair whose manifest is `manifest` (object, laid out exactly) signed by `key`. */
export function signedPair(manifest, key) {
	const bytes = manifestText(manifest)
	return { manifest: bytes, signature: signatureFile(bytes, key) }
}

/**
 * Every broken pair. Each is `{ label, make(ctx) -> { manifest, signature } }`, where `ctx` is
 * `{ key, other, good }`: the trusted key, a key nobody trusts under the same id, and the good pair.
 * Every pair must be refused by every verifier (signature check, then strict read).
 */
export function pairCases() {
	const cases = []
	const add = (label, make) => cases.push({ label, make })
	const edited = (change) => (ctx) => {
		const manifest = goodManifest()
		change(manifest)
		return signedPair(manifest, ctx.key)
	}
	const rawManifest = (text) => (ctx) => {
		const bytes = Buffer.from(text(manifestText(goodManifest()).toString()))
		return { manifest: bytes, signature: signatureFile(bytes, ctx.key) }
	}
	const tweakedSignature = (change) => (ctx) => {
		const value = JSON.parse(ctx.good.signature.toString())
		return { manifest: ctx.good.manifest, signature: Buffer.from(change(value)) }
	}

	add('a signature made by another key under the same id', (ctx) =>
		signedPair(goodManifest(), { ...ctx.other, id: ctx.key.id }),
	)
	add('a key id that is not trusted', (ctx) => ({
		manifest: ctx.good.manifest,
		signature: signatureFile(ctx.good.manifest, ctx.key, { keyId: 'k2' }),
	}))
	add('a manifest changed by one byte after signing', (ctx) => {
		const bytes = Buffer.from(ctx.good.manifest)
		bytes[bytes.indexOf('latest')] = 0x4c // "latest" -> "Latest"

		return { manifest: bytes, signature: ctx.good.signature }
	})
	add(
		'a signature changed by one character',
		tweakedSignature((v) => {
			v.signature = `${v.signature[0] === 'A' ? 'B' : 'A'}${v.signature.slice(1)}`
			return `${JSON.stringify(v)}\n`
		}),
	)
	add(
		'an unknown algorithm',
		tweakedSignature((v) => `${JSON.stringify({ ...v, algorithm: 'rsa' })}\n`),
	)
	add(
		'another signature schema',
		tweakedSignature((v) => `${JSON.stringify({ ...v, schema: 2 })}\n`),
	)
	add(
		'an extra field in the signature file',
		tweakedSignature((v) => `${JSON.stringify({ ...v, extra: 1 })}\n`),
	)
	add(
		'a signature that is not 64 bytes',
		tweakedSignature((v) => `${JSON.stringify({ ...v, signature: 'AAAA' })}\n`),
	)
	add('a signature file that is not JSON', () => ({
		manifest: Buffer.from('x'),
		signature: Buffer.from('nope'),
	}))
	add(
		'a signature file in pretty JSON',
		tweakedSignature((v) => `${JSON.stringify(v, null, 2)}\n`),
	)
	add(
		'a signature file without its newline',
		tweakedSignature((v) => JSON.stringify(v)),
	)
	add(
		'a signature file with two newlines',
		tweakedSignature((v) => `${JSON.stringify(v)}\n\n`),
	)
	add(
		'a signature file with its fields in another order',
		tweakedSignature(
			(v) =>
				`${JSON.stringify({ keyId: v.keyId, schema: 1, algorithm: v.algorithm, signature: v.signature })}\n`,
		),
	)
	add(
		'a signature file with a repeated key',
		tweakedSignature(
			(v) => `${JSON.stringify(v).replace('"schema":1,', '"schema":1,"schema":1,')}\n`,
		),
	)

	add(
		'a manifest in compact JSON (signed)',
		rawManifest((t) => JSON.stringify(JSON.parse(t))),
	)
	add(
		'a manifest without its newline (signed)',
		rawManifest((t) => t.trimEnd()),
	)
	add(
		'a manifest with two newlines (signed)',
		rawManifest((t) => `${t}\n`),
	)
	add(
		'a manifest with CRLF line ends (signed)',
		rawManifest((t) => t.replace(/\n/g, '\r\n')),
	)
	add(
		'a manifest indented with tabs (signed)',
		rawManifest((t) => t.replace(/ {2}/g, '\t')),
	)
	add(
		'a manifest with a repeated key (signed)',
		rawManifest((t) =>
			t.replace('"channel": "latest",', '"channel": "x",\n  "channel": "latest",'),
		),
	)
	add('a manifest with its fields in another order (signed)', (ctx) => {
		const m = goodManifest()
		const bytes = Buffer.from(`${JSON.stringify({ channel: m.channel, ...m }, null, 2)}\n`)
		return { manifest: bytes, signature: signatureFile(bytes, ctx.key) }
	})
	add('a manifest with bundle keys that are not sorted (signed)', (ctx) => {
		const m = goodManifest()
		m.kernel.bundles = {
			'win32-x64': m.kernel.bundles['win32-x64'],
			'linux-x64': { ...GOOD_BUNDLE },
		}
		const bytes = Buffer.from(`${JSON.stringify(m, null, 2)}\n`)
		return { manifest: bytes, signature: signatureFile(bytes, ctx.key) }
	})
	add('a manifest that is not JSON (signed)', (ctx) => {
		const bytes = Buffer.from('not json')
		return { manifest: bytes, signature: signatureFile(bytes, ctx.key) }
	})

	add(
		'an unknown top-level field (signed)',
		edited((m) => {
			m.extra = 1
		}),
	)
	add(
		'an unknown field in kernel (signed)',
		edited((m) => {
			m.kernel.extra = 1
		}),
	)
	add(
		'an unknown field in a bundle (signed)',
		edited((m) => {
			m.kernel.bundles['win32-x64'].extra = 1
		}),
	)
	add(
		'a missing field (signed)',
		edited((m) => {
			m.withdrawn = undefined
		}),
	)
	add(
		'another manifest schema (signed)',
		edited((m) => {
			m.schema = 2
		}),
	)
	add(
		'a channel that is not a name (signed)',
		edited((m) => {
			m.channel = 'Latest!'
		}),
	)
	add(
		'a sequence of 0 (signed)',
		edited((m) => {
			m.sequence = 0
		}),
	)
	add(
		'a sequence that is not a whole number (signed)',
		edited((m) => {
			m.sequence = 1.5
		}),
	)
	add(
		'a time that is not seconds in UTC (signed)',
		edited((m) => {
			m.issuedAt = '2026-11-12 10:00:00'
		}),
	)
	add(
		'an expiry before the issue time (signed)',
		edited((m) => {
			m.expiresAt = '2026-11-01T00:00:00Z'
		}),
	)
	add(
		'a prerelease command line version (signed)',
		edited((m) => {
			m.kernel.commandLine = '51.3.0-rc.1'
		}),
	)
	add(
		'a prerelease engine version (signed)',
		edited((m) => {
			m.kernel.engine = '62.14.0-beta'
		}),
	)
	add(
		'a prerelease withdrawn version (signed)',
		edited((m) => {
			m.withdrawn = ['51.0.0-rc.1']
		}),
	)
	add(
		'a floor with build metadata (signed)',
		edited((m) => {
			m.minimumKernel = '51.0.0+b1'
		}),
	)
	add(
		'a version with a leading zero (signed)',
		edited((m) => {
			m.kernel.commandLine = '051.3.0'
		}),
	)
	add(
		'a withdrawn version listed twice (signed)',
		edited((m) => {
			m.withdrawn = ['50.0.0', '50.0.0']
		}),
	)
	add(
		'a floor above the engine offered (signed)',
		edited((m) => {
			m.minimumKernel = '99.0.0'
		}),
	)
	add(
		'a bundle name that is not a platform (signed)',
		edited((m) => {
			m.kernel.bundles = { 'plan9-x64': { ...GOOD_BUNDLE } }
		}),
	)
	add(
		'no bundles (signed)',
		edited((m) => {
			m.kernel.bundles = {}
		}),
	)
	add(
		'a bundle file that is a path (signed)',
		edited((m) => {
			m.kernel.bundles['win32-x64'].file = 'a/b.tar.gz'
		}),
	)
	add(
		'a bundle file that is a URL (signed)',
		edited((m) => {
			m.kernel.bundles['win32-x64'].file = 'https://x.test/a.tar.gz'
		}),
	)
	add(
		'a bundle file name over 128 characters (signed)',
		edited((m) => {
			m.kernel.bundles['win32-x64'].file = `${'a'.repeat(130)}.tar.gz`
		}),
	)
	add(
		'a sha512 that is not 128 hex digits (signed)',
		edited((m) => {
			m.kernel.bundles['win32-x64'].sha512 = 'zz'
		}),
	)
	add(
		'a bundle size of 0 (signed)',
		edited((m) => {
			m.kernel.bundles['win32-x64'].size = 0
		}),
	)
	add(
		'a bundle file count of 0 (signed)',
		edited((m) => {
			m.kernel.bundles['win32-x64'].fileCount = 0
		}),
	)
	add(
		'a bundle larger than 2 GiB (signed)',
		edited((m) => {
			m.kernel.bundles['win32-x64'].size = 2 * 1024 ** 3 + 1
		}),
	)
	add(
		'more unpacked bytes than 8 GiB (signed)',
		edited((m) => {
			m.kernel.bundles['win32-x64'].unpackedSize = 8 * 1024 ** 3 + 1
		}),
	)
	add(
		'more files than 200000 (signed)',
		edited((m) => {
			m.kernel.bundles['win32-x64'].fileCount = 200001
		}),
	)
	add(
		'a data epoch of 0 (signed)',
		edited((m) => {
			m.kernel.dataEpoch = 0
		}),
	)
	add(
		'a desktop contract that is not a number (signed)',
		edited((m) => {
			m.kernel.desktopContract = '1'
		}),
	)
	return cases
}
