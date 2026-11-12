import { describe, expect, it } from 'vitest'
import {
	buildArchive,
	kernelFiles,
	makeKey,
	manifestBytesOf,
	manifestObject,
	signPair,
} from './kernel-test-support.js'
import {
	KERNEL_PUBLIC_KEYS,
	feedBase,
	isAllowedFeedUrl,
	parseTestKey,
	trustedKeys,
} from './keys.js'
import { ManifestError, parseManifest, verifyManifest } from './manifest.js'

const files = kernelFiles('51.3.0', '62.14.0')
const archive = buildArchive('51.3.0', files)
const input = { commandLine: '51.3.0', engine: '62.14.0', bundles: { 'win32-x64': archive.bundle } }

function codeOf(run: () => unknown): string | undefined {
	try {
		run()
	} catch (error) {
		return error instanceof ManifestError ? error.code : `other:${String(error)}`
	}
	return undefined
}

describe('compiled keys', () => {
	it('are empty in the repository', () => {
		expect(KERNEL_PUBLIC_KEYS).toEqual([])
		expect(trustedKeys({ isPackaged: true, env: {} })).toEqual([])
	})

	it('take a test key only from an unpackaged app', () => {
		const key = makeKey('t1')
		const env = { NAMZU_KERNEL_TEST_PUBLIC_KEY: `${key.id}:${key.publicKey}` }
		expect(trustedKeys({ isPackaged: false, env }).map((entry) => entry.id)).toEqual(['t1'])
		expect(trustedKeys({ isPackaged: true, env })).toEqual([])
		expect(parseTestKey('t1:AAAA')).toBeUndefined()
		expect(parseTestKey('nocolon')).toBeUndefined()
	})

	it('allow https anywhere and http only to this machine', () => {
		expect(isAllowedFeedUrl('https://example.com/x/')).toBe(true)
		expect(isAllowedFeedUrl('http://127.0.0.1:4000/')).toBe(true)
		expect(isAllowedFeedUrl('http://localhost/')).toBe(true)
		expect(isAllowedFeedUrl('http://example.com/')).toBe(false)
		expect(isAllowedFeedUrl('ftp://127.0.0.1/')).toBe(false)
		expect(isAllowedFeedUrl('https://user:pw@example.com/')).toBe(false)
		expect(feedBase({ isPackaged: true, override: 'https://elsewhere.test/a' })).toMatch(/github/u)
		expect(feedBase({ isPackaged: true, override: 'http://127.0.0.1:1/f' })).toBe(
			'http://127.0.0.1:1/f/',
		)
		expect(feedBase({ isPackaged: false, override: 'https://elsewhere.test/a' })).toBe(
			'https://elsewhere.test/a/',
		)
	})
})

describe('signature', () => {
	it('accepts a manifest signed by a trusted key and reads it', () => {
		const key = makeKey()
		const pair = signPair(manifestObject(input), key)
		const { manifest } = verifyManifest(pair.manifest, pair.signature, [key])
		expect(manifest.kernel.commandLine).toBe('51.3.0')
		expect(manifest.kernel.bundles['win32-x64']?.fileCount).toBe(archive.bundle.fileCount)
	})

	it('refuses a signature made by another key under the same id', () => {
		const key = makeKey()
		const pair = signPair(manifestObject(input), makeKey())
		expect(codeOf(() => verifyManifest(pair.manifest, pair.signature, [key]))).toBe('bad-signature')
	})

	it('refuses a key id that is not trusted', () => {
		const key = makeKey()
		const pair = signPair(manifestObject(input), key, { keyId: 'other' })
		expect(codeOf(() => verifyManifest(pair.manifest, pair.signature, [key]))).toBe('unknown-key')
	})

	it('refuses a manifest changed by one byte', () => {
		const key = makeKey()
		const pair = signPair(manifestObject(input), key)
		const changed = Buffer.from(pair.manifest)
		const at = changed.indexOf('latest')
		changed[at] = 'L'.charCodeAt(0)
		expect(codeOf(() => verifyManifest(changed, pair.signature, [key]))).toBe('bad-signature')
		// whitespace is not free either: the signature covers the bytes as served
		expect(
			codeOf(() =>
				verifyManifest(Buffer.concat([pair.manifest, Buffer.from('\n')]), pair.signature, [key]),
			),
		).toBe('bad-signature')
	})

	it('refuses an unknown algorithm, schema, extra field or malformed signature text', () => {
		const key = makeKey()
		const pair = signPair(manifestObject(input), key)
		const tweak = (change: (value: Record<string, unknown>) => void) => {
			const value = JSON.parse(pair.signature.toString())
			change(value)
			return Buffer.from(JSON.stringify(value))
		}
		expect(
			codeOf(() =>
				verifyManifest(
					pair.manifest,
					tweak((v) => {
						v.algorithm = 'rsa'
					}),
					[key],
				),
			),
		).toBe('signature-format')
		expect(
			codeOf(() =>
				verifyManifest(
					pair.manifest,
					tweak((v) => {
						v.schema = 2
					}),
					[key],
				),
			),
		).toBe('signature-format')
		expect(
			codeOf(() =>
				verifyManifest(
					pair.manifest,
					tweak((v) => {
						v.extra = 1
					}),
					[key],
				),
			),
		).toBe('signature-format')
		expect(
			codeOf(() =>
				verifyManifest(
					pair.manifest,
					tweak((v) => {
						v.signature = 'AAAA'
					}),
					[key],
				),
			),
		).toBe('signature-format')
		expect(codeOf(() => verifyManifest(pair.manifest, Buffer.from('nope'), [key]))).toBe(
			'signature-format',
		)
	})
})

describe('manifest', () => {
	const key = makeKey()
	function parseWith(change: (value: Record<string, any>) => void) {
		const value = structuredClone(manifestObject(input)) as Record<string, any>
		change(value)
		const pair = signPair(value, key)
		return () => verifyManifest(pair.manifest, pair.signature, [key])
	}

	it('refuses unknown fields at every level, even when signed', () => {
		expect(
			codeOf(
				parseWith((v) => {
					v.extra = 1
				}),
			),
		).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.kernel.extra = 1
				}),
			),
		).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.kernel.bundles['win32-x64'].extra = 1
				}),
			),
		).toBe('manifest-format')
	})

	it('refuses a missing field, another schema, bad versions and times', () => {
		expect(
			codeOf(
				parseWith((v) => {
					v.withdrawn = undefined
				}),
			),
		).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.schema = 2
				}),
			),
		).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.kernel.commandLine = '51.3'
				}),
			),
		).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.withdrawn = ['x']
				}),
			),
		).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.issuedAt = 'yesterday'
				}),
			),
		).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.expiresAt = v.issuedAt
				}),
			),
		).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.sequence = 1.5
				}),
			),
		).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.kernel.dataEpoch = 0
				}),
			),
		).toBe('manifest-format')
	})

	it('refuses a file that is not a bare name, and bad hashes or sizes', () => {
		for (const file of [
			'../x.tar.gz',
			'a/b.tar.gz',
			'https://x/y.tar.gz',
			'a\\b.tar.gz',
			'..',
			'.hidden',
			'a?b',
		])
			expect(
				codeOf(
					parseWith((v) => {
						v.kernel.bundles['win32-x64'].file = file
					}),
				),
				file,
			).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.kernel.bundles['win32-x64'].sha512 = 'abc'
				}),
			),
		).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.kernel.bundles['win32-x64'].size = 0
				}),
			),
		).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.kernel.bundles = {}
				}),
			),
		).toBe('manifest-format')
		expect(
			codeOf(
				parseWith((v) => {
					v.kernel.bundles['Win 32'] = v.kernel.bundles['win32-x64']
				}),
			),
		).toBe('manifest-format')
	})

	it('reads times as milliseconds', () => {
		const parsed = parseManifest(manifestBytesOf(manifestObject(input)))
		expect(parsed.issuedAt).toBe(Date.parse('2026-11-12T10:00:00Z'))
	})

	it('accepts only the exact bytes of the text (specification 7.6)', () => {
		const object = manifestObject(input) as Record<string, any>
		const exact = manifestBytesOf(object)
		expect(() => parseManifest(exact)).not.toThrow()
		const refused = (bytes: Buffer | string) => {
			try {
				parseManifest(Buffer.from(bytes))
			} catch (error) {
				return error instanceof ManifestError ? error.code : 'other'
			}
			return 'accepted'
		}
		// compact, no newline, a second newline, CRLF, tabs, a repeated key, a reordered field
		expect(refused(JSON.stringify(object))).toBe('manifest-format')
		expect(refused(exact.toString().trimEnd())).toBe('manifest-format')
		expect(refused(`${exact.toString()}\n`)).toBe('manifest-format')
		expect(refused(exact.toString().replace(/\n/g, '\r\n'))).toBe('manifest-format')
		expect(refused(exact.toString().replace(/ {2}/g, '\t'))).toBe('manifest-format')
		expect(
			refused(
				exact.toString().replace('"channel": "latest",', '"channel": "x",\n  "channel": "latest",'),
			),
		).toBe('manifest-format')
		const reordered = { channel: object.channel, schema: 1, ...object }
		expect(refused(`${JSON.stringify(reordered, null, 2)}\n`)).toBe('manifest-format')
		// bundle keys unsorted
		const two = structuredClone(object)
		const bundle = two.kernel.bundles['win32-x64']
		two.kernel.bundles = { 'win32-x64': bundle, 'linux-x64': bundle }
		expect(refused(`${JSON.stringify(two, null, 2)}\n`)).toBe('manifest-format')
		expect(refused(manifestBytesOf(two))).toBe('accepted')
	})

	it('accepts only plain x.y.z versions, a sequence of 1 or more, and a floor not above the engine', () => {
		const withChange = (change: (value: Record<string, any>) => void) => {
			const value = structuredClone(manifestObject(input)) as Record<string, any>
			change(value)
			try {
				parseManifest(manifestBytesOf(value))
			} catch (error) {
				return error instanceof ManifestError ? error.code : 'other'
			}
			return 'accepted'
		}
		expect(
			withChange((v) => {
				v.kernel.commandLine = '51.3.0-rc.1'
			}),
		).toBe('manifest-format')
		expect(
			withChange((v) => {
				v.kernel.engine = '62.14.0-beta'
			}),
		).toBe('manifest-format')
		expect(
			withChange((v) => {
				v.withdrawn = ['51.0.0-rc.1']
			}),
		).toBe('manifest-format')
		expect(
			withChange((v) => {
				v.minimumKernel = '51.0.0+build'
			}),
		).toBe('manifest-format')
		expect(
			withChange((v) => {
				v.kernel.commandLine = '051.3.0'
			}),
		).toBe('manifest-format')
		expect(
			withChange((v) => {
				v.sequence = 0
			}),
		).toBe('manifest-format')
		expect(
			withChange((v) => {
				v.withdrawn = ['50.0.0', '50.0.0']
			}),
		).toBe('manifest-format')
		expect(
			withChange((v) => {
				v.minimumKernel = '99.0.0'
			}),
		).toBe('manifest-format')
		expect(
			withChange((v) => {
				v.kernel.bundles['win32-x64'].fileCount = 0
			}),
		).toBe('manifest-format')
		expect(withChange(() => undefined)).toBe('accepted')
	})

	it('accepts only the bundle names the publisher writes', () => {
		const withKey = (name: string) => {
			const value = structuredClone(manifestObject(input)) as Record<string, any>
			value.kernel.bundles = { [name]: Object.values(value.kernel.bundles)[0] }
			try {
				parseManifest(manifestBytesOf(value))
			} catch {
				return 'refused'
			}
			return 'accepted'
		}
		expect(withKey('win32-x64')).toBe('accepted')
		expect(withKey('plan9-x64')).toBe('refused')
		expect(withKey('win32-mips')).toBe('refused')
	})

	it('reads a signature file only in its exact bytes (compact JSON, fields in order, one newline)', () => {
		const key = makeKey()
		const pair = signPair(manifestObject(input), key)
		const value = JSON.parse(pair.signature.toString())
		const run = (bytes: string) => {
			try {
				verifyManifest(pair.manifest, Buffer.from(bytes), [key])
			} catch (error) {
				return error instanceof ManifestError ? error.code : 'other'
			}
			return 'accepted'
		}
		expect(run(pair.signature.toString())).toBe('accepted')
		expect(run(pair.signature.toString().trimEnd())).toBe('signature-format')
		expect(run(`${pair.signature.toString()}\n`)).toBe('signature-format')
		expect(run(`${JSON.stringify(value, null, 2)}\n`)).toBe('signature-format')
		expect(
			run(
				`${JSON.stringify({ keyId: value.keyId, schema: 1, algorithm: 'ed25519', signature: value.signature })}\n`,
			),
		).toBe('signature-format')
	})
})
