import { sign } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
	type BuildInput,
	buildPackage,
	makeKey,
	makeZip,
	sampleManifest,
	trustedFrom,
} from './__fixtures__/package-builder.js'
import { canon } from './canon.js'
import { ExtensionError } from './errors.js'
import { devModeOn, trustedKeys } from './keys.js'
import { openPackage } from './package.js'
import { verifyPackage } from './verify.js'

const pub = makeKey('cogitave-test')
const lic = makeKey('lic-test')
const build = (over: Partial<BuildInput> = {}) =>
	buildPackage({
		manifest: sampleManifest(undefined, { keyId: pub.id }),
		publisherKey: pub,
		licenseKey: lic,
		...over,
	})
const check = (bytes: Buffer, keys = [trustedFrom(pub)]) => verifyPackage(openPackage(bytes), keys)
const code = (fn: () => unknown): string => {
	try {
		fn()
	} catch (e) {
		if (e instanceof ExtensionError) return `${e.code}/${e.check}`
		throw e
	}
	return 'ok'
}

describe('package verification', () => {
	it('accepts a package signed by a trusted key', () => {
		const v = check(build())
		expect(v.manifest.id).toBe('com.example.stub-recorder')
		expect(v.dev).toBe(false)
	})
	it('refuses a package signed by an unknown key (E1)', () => {
		expect(code(() => check(build(), [trustedFrom(makeKey('someone-else'))]))).toBe(
			'untrusted-publisher/trusted-key',
		)
	})
	it('says so when the build trusts no publisher at all', () => {
		expect(code(() => check(build(), []))).toBe('untrusted-publisher/trusted-key')
	})
	it('refuses a manifest changed by one byte (E2)', () => {
		expect(code(() => check(build({ tamper: 'namzu-extension.json' })))).toBe('tampered/signature')
	})
	it('refuses a file changed by one byte (E2)', () => {
		expect(code(() => check(build({ tamper: 'bin/stub.cjs' })))).toBe('tampered/file-hash')
	})
	it('refuses a file named like an Object.prototype member and any unlisted file under signatures/', () => {
		for (const name of ['toString', 'constructor', 'signatures/anything.bin'])
			expect(code(() => check(build({ extraEntries: [{ name, data: Buffer.from('x') }] })))).toBe(
				'tampered/unlisted-file',
			)
	})
	it('refuses an unlisted extra file and a missing listed file', () => {
		expect(
			code(() => check(build({ extraEntries: [{ name: 'extra.txt', data: Buffer.from('x') }] }))),
		).toBe('tampered/unlisted-file')
		const withoutSchema = openPackage(build())
		withoutSchema.delete('schemas/status.json')
		expect(code(() => verifyPackage(withoutSchema, [trustedFrom(pub)]))).toBe(
			'tampered/missing-file',
		)
	})
	it('refuses a signature that is not the three-line statement (kernel-style bare manifest signature)', () => {
		const files = openPackage(build())
		const bare = sign(
			null,
			files.get('namzu-extension.json')?.bytes as Buffer,
			pub.privateKey,
		).toString('base64')
		files.set('signatures/manifest.sig', {
			bytes: Buffer.from(
				`${canon({ schema: 1, keyId: pub.id, algorithm: 'ed25519', signature: bare })}\n`,
			),
			executable: false,
		})
		expect(code(() => verifyPackage(files, [trustedFrom(pub)]))).toBe('tampered/signature')
	})
	it('refuses a signature file that is not in the compact form', () => {
		const files = openPackage(build())
		files.set('signatures/manifest.sig', { bytes: Buffer.from('{"schema": 1}'), executable: false })
		expect(code(() => verifyPackage(files, [trustedFrom(pub)]))).toBe(
			'signature-invalid/signature-form',
		)
	})
	it('refuses a key that signs an id outside its prefixes, or for another publisher', () => {
		expect(code(() => check(build(), [trustedFrom(pub, 'example', ['org.other.'])]))).toBe(
			'untrusted-publisher/id-prefix',
		)
		expect(code(() => check(build(), [trustedFrom(pub, 'someone', ['com.example.'])]))).toBe(
			'untrusted-publisher/publisher',
		)
	})
	it('refuses a manifest whose signing key id differs from the signature key', () => {
		const p = buildPackage({
			manifest: sampleManifest(undefined, { keyId: 'other-key-id' }),
			publisherKey: pub,
			licenseKey: lic,
		})
		expect(code(() => check(p))).toBe('untrusted-publisher/key-id')
	})
	it('refuses a manifest with a permission that has no purpose, after a valid signature, naming the permission (E5)', () => {
		const p = buildPackage({
			manifest: sampleManifest(
				(m: any) => {
					m.permissions[0].purposes = []
				},
				{ keyId: pub.id },
			),
			publisherKey: pub,
			licenseKey: lic,
		})
		try {
			check(p)
			throw new Error('should refuse')
		} catch (e) {
			expect((e as ExtensionError).code).toBe('manifest-invalid')
			expect((e as ExtensionError).message).toMatch(/os\.foregroundWindow has no purpose/)
		}
	})
	it('refuses a notice whose hash or locale line does not match the manifest', () => {
		const p = buildPackage({
			manifest: sampleManifest(undefined, { keyId: pub.id }),
			publisherKey: pub,
			licenseKey: lic,
			files: { 'legal/notice.tr.md': '<!-- locale: en -->\nwrong language marker\n' },
		})
		expect(code(() => check(p))).toMatch(/manifest-invalid\/K1/)
	})
	it('refuses an executable that has no execute bit in the package (K2)', () => {
		if (process.platform === 'win32') return
		const files = openPackage(build())
		const f = files.get('bin/stub.cjs')
		if (!f) throw new Error('stub missing')
		files.set('bin/stub.cjs', { bytes: f.bytes, executable: false })
		expect(code(() => verifyPackage(files, [trustedFrom(pub)]))).toMatch(/manifest-invalid\/K1/)
	})
})

describe('zip safety: refused before anything is written', () => {
	const base = build()
	const with_ = (extra: Parameters<typeof makeZip>[0]) =>
		makeZip([{ name: 'a.txt', data: Buffer.from('a') }, ...extra])
	it('zip-slip', () => {
		expect(code(() => openPackage(with_([{ name: '../evil.txt', data: Buffer.from('x') }])))).toBe(
			'bad-package/zip-slip',
		)
		expect(code(() => openPackage(with_([{ name: 'a/../../evil', data: Buffer.from('x') }])))).toBe(
			'bad-package/zip-slip',
		)
	})
	it('absolute paths, drive letters, backslashes, control characters', () => {
		for (const name of ['/etc/passwd', 'C:/x', 'a\\b', 'a\u0001b'])
			expect(code(() => openPackage(with_([{ name, data: Buffer.from('x') }])))).toMatch(
				/^bad-package\/zip-name/,
			)
	})
	it('symlink and device entries', () => {
		expect(
			code(() =>
				openPackage(with_([{ name: 'link', data: Buffer.from('/etc/passwd'), mode: 0o120777 }])),
			),
		).toBe('bad-package/zip-link')
		expect(
			code(() => openPackage(with_([{ name: 'dev', data: Buffer.from(''), mode: 0o020666 }]))),
		).toBe('bad-package/zip-link')
	})
	it('names that differ only by case, and duplicate names', () => {
		expect(code(() => openPackage(with_([{ name: 'A.txt', data: Buffer.from('x') }])))).toBe(
			'bad-package/zip-case',
		)
		expect(code(() => openPackage(with_([{ name: 'a.txt', data: Buffer.from('x') }])))).toBe(
			'bad-package/zip-duplicate',
		)
	})
	it('a compression bomb (ratio above 100:1) and a lying size', () => {
		const bomb = Buffer.alloc(2 * 1024 * 1024, 0)
		expect(code(() => openPackage(with_([{ name: 'bomb.bin', data: bomb }])))).toBe(
			'bad-package/zip-bomb',
		)
		const small = Buffer.from('hello world, hello world')
		expect(code(() => openPackage(makeZip([{ name: 'x', data: small, claimSize: 5 }])))).toMatch(
			/^bad-package\/zip/,
		)
		expect(deflateRawSync(bomb).length).toBeLessThan(bomb.length / 100)
	})
	it('more than 500 entries', () => {
		const many = Array.from({ length: 501 }, (_, i) => ({
			name: `f${i}.txt`,
			data: Buffer.from('x'),
		}))
		expect(code(() => openPackage(makeZip(many)))).toBe('bad-package/zip-entries')
	})
	it('a file that is not a zip', () => {
		expect(
			code(() => openPackage(Buffer.from('not a zip at all, definitely not a zip file'))),
		).toBe('bad-package/zip')
	})
	it('a valid package opens', () => {
		expect(openPackage(base).has('namzu-extension.json')).toBe(true)
	})
})

describe('a dev key is trusted only with both switches (E23)', () => {
	const key = makeKey('dev-publisher-t')
	const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv
	it('is not trusted by default, nor with one switch', () => {
		expect(trustedKeys(env({}), [])).toEqual([])
		expect(trustedKeys(env({ NAMZU_EXTENSION_DEV: '1' }), [])).toEqual([])
		expect(
			trustedKeys(env({ NAMZU_EXTENSION_TEST_PUBLIC_KEY: `${key.id}:${key.publicB64}` }), []),
		).toEqual([])
	})
	it('is trusted with both, and marked dev', () => {
		const k = trustedKeys(
			env({
				NAMZU_EXTENSION_DEV: '1',
				NAMZU_EXTENSION_TEST_PUBLIC_KEY: `${key.id}:${key.publicB64}`,
			}),
			[],
		)
		expect(k).toHaveLength(1)
		expect(k[0]?.dev).toBe(true)
		expect(devModeOn(env({ NAMZU_EXTENSION_DEV: '1' }))).toBe(true)
	})
	it('a compiled key named dev- is never trusted', () => {
		expect(trustedKeys(env({}), [trustedFrom(key)])).toEqual([])
	})
	it('a malformed test key trusts nothing', () => {
		expect(
			trustedKeys(
				env({ NAMZU_EXTENSION_DEV: '1', NAMZU_EXTENSION_TEST_PUBLIC_KEY: 'dev-x:AAAA' }),
				[],
			),
		).toEqual([])
	})
	it('a package signed by a dev key is refused without the switches, accepted with them', () => {
		const p = buildPackage({
			manifest: sampleManifest(undefined, { keyId: key.id }),
			publisherKey: key,
			licenseKey: lic,
		})
		expect(code(() => verifyPackage(openPackage(p), trustedKeys(env({}), [])))).toBe(
			'untrusted-publisher/trusted-key',
		)
		const ok = verifyPackage(
			openPackage(p),
			trustedKeys(
				env({
					NAMZU_EXTENSION_DEV: '1',
					NAMZU_EXTENSION_TEST_PUBLIC_KEY: `${key.id}:${key.publicB64}`,
				}),
				[],
			),
		)
		expect(ok.dev).toBe(true)
	})
})
