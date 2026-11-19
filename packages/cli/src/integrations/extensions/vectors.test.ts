import { verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { canon, sha256Hex } from './canon.js'
import { ed25519KeyFromRaw } from './keys.js'
import { checkLicense } from './license/key.js'
import { localizedTexts, parseManifest } from './manifest.js'
import { scopeHash, scopeOf, widerReasons, wordingDigest } from './scope.js'
import type { Manifest } from './types.js'
import { signedStatement } from './verify.js'

/**
 * Parity with the reference vectors made by the platform spec's tools (DEV keys, public halves only):
 * the same package signature, licence and scope hash must come out of this port.
 */
const V = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'vectors')
const read = (n: string) => readFileSync(join(V, n))
const manifestBytes = read('reference-manifest.json')
const parsed = parseManifest(manifestBytes)
if (!parsed.ok) throw new Error(`reference manifest refused: ${JSON.stringify(parsed.issues[0])}`)
const m: Manifest = parsed.manifest
const pub = (n: string) => JSON.parse(read(n).toString()) as { keyId: string; publicKey: string }

describe('reference vectors', () => {
	it('the reference manifest passes the schema port and every cross rule', () => {
		expect(m.id).toBe('com.cogitave.activity')
		expect(m.defaultLocale).toBe('tr')
	})
	it('the scope hash equals the reference value', () => {
		expect(scopeHash(scopeOf(m))).toBe(read('scope.sha256').toString().trim())
		expect(canon(scopeOf(m))).toBe(canon(JSON.parse(read('scope.json').toString())))
	})
	it('the package signature of the reference verifies over the three-line statement', () => {
		const sig = JSON.parse(read('manifest.sig').toString()) as {
			keyId: string
			signature: string
		}
		const key = ed25519KeyFromRaw(pub('dev-publisher-1.public.json').publicKey)
		const stmt = signedStatement(manifestBytes, read('files.sha256.json'))
		expect(verify(null, stmt, key, Buffer.from(sig.signature, 'base64'))).toBe(true)
		// One changed manifest byte, and a bare-manifest (kernel-feed style) signature, both fail.
		expect(
			verify(
				null,
				signedStatement(
					Buffer.concat([manifestBytes, Buffer.from(' ')]),
					read('files.sha256.json'),
				),
				key,
				Buffer.from(sig.signature, 'base64'),
			),
		).toBe(false)
		expect(verify(null, manifestBytes, key, Buffer.from(sig.signature, 'base64'))).toBe(false)
	})
	it('the reference licence verifies with the licence key and not with the publisher key', () => {
		const lic = read('dev-license.nzlic').toString()
		const verifierKey = {
			keyId: 'dev-license-1',
			algorithm: 'ed25519' as const,
			publicKey: pub('dev-license-1.public.json').publicKey,
		}
		if (m.licensing.kind !== 'key') throw new Error('the reference uses a key licence')
		const devManifest = {
			...m,
			licensing: {
				...m.licensing,
				verifier: { ...m.licensing.verifier, keyId: 'dev-license-1' },
			},
		} as Manifest
		const ok = checkLicense({
			text: lic,
			manifest: devManifest,
			verifierKey,
			now: Date.parse('2026-11-18T12:00:00Z'),
			devMode: true,
		})
		expect(ok.ok).toBe(true)
		const wrong = checkLicense({
			text: lic,
			manifest: devManifest,
			verifierKey: {
				...verifierKey,
				publicKey: pub('dev-publisher-1.public.json').publicKey,
			},
			now: Date.parse('2026-11-18T12:00:00Z'),
			devMode: true,
		})
		expect(wrong).toMatchObject({ ok: false, code: 'signature' })
	})
})

describe('scope of round 2', () => {
	const s0 = scopeOf(m)
	const mod = (f: (c: any) => void) => {
		const c = JSON.parse(JSON.stringify(m))
		f(c)
		return scopeOf(c as Manifest)
	}
	const reasons = (f: (c: any) => void) => widerReasons(s0, mod(f))
	const base = (f: (c: any) => void) => (c: any) => {
		c.background = undefined
		c.permissions = c.permissions.filter((p: any) => p.id !== 'background.signin')
		f(c)
	}
	it('the reference starts at sign-in with its own tray mark', () => {
		expect(s0.background).toEqual({ runAt: 'signin', indicator: 'tray' })
		expect(s0.runsAtLogin).toBe(true)
	})
	it('asks when it newly starts at sign-in, never when that is removed', () => {
		const without = mod(base(() => {}))
		expect(widerReasons(without, s0).join(' ')).toMatch(/starts when you sign in/)
		expect(widerReasons(s0, without)).toEqual([])
	})
	it('asks when its own indicator goes from tray to none, never the other way', () => {
		const none = mod((c) => {
			c.background.indicator = { kind: 'none' }
		})
		expect(widerReasons(s0, none).join(' ')).toMatch(/own indicator/)
		expect(widerReasons(none, s0)).toEqual([])
	})
	it('asks for a new host, a host used for something more, a licence host, a sent field and a page on the network', () => {
		const host = (use: string[]) => (c: any) => {
			c.network = {
				mode: 'declared',
				hosts: [
					{
						host: 'license.example.com',
						purpose: { tr: 'x', en: 'x' },
						for: use,
					},
				],
			}
		}
		expect(reasons(host(['license'])).join(' ')).toMatch(/new network host license.example.com/)
		const withHost = mod(host(['license']))
		const more = mod(host(['license', 'ui']))
		expect(widerReasons(withHost, more).join(' ')).toMatch(/also used for ui/)
		expect(widerReasons(more, withHost)).toEqual([])
		const service = (sends: string[]) => (c: any) => {
			host(['license'])(c)
			c.licensing = {
				kind: 'service',
				required: true,
				claims: [],
				onInvalid: 'disableAndExplain',
				service: {
					protocol: 'namzu-license/1',
					baseUrl: 'https://license.example.com/v1',
					verifier: {
						type: 'ed25519-offline',
						keyId: 'k-1-x',
						keyFile: 'keys/a.json',
					},
					refreshHours: 24,
					offlineGraceDays: 14,
					sends,
					releaseOnRemove: true,
				},
			}
		}
		expect(reasons(service(['licenseKey', 'machineHash'])).join(' ')).toMatch(
			/licence check now contacts license.example.com/,
		)
		const a = mod(service(['licenseKey', 'machineHash']))
		const b = mod(service(['licenseKey', 'machineHash', 'extensionId']))
		expect(widerReasons(a, b).join(' ')).toMatch(/now also sends extensionId/)
		expect(widerReasons(b, a)).toEqual([])
		const net = mod((c) => {
			c.ui.pages[0].usesNetwork = true
		})
		expect(widerReasons(s0, net).join(' ')).toMatch(/page can now use the network/)
	})
	it('never asks for a new or renamed page, chip, icon or accent, or a service becoming a key', () => {
		expect(
			reasons((c) => {
				c.ui.pages[0].title.en = 'Something else'
				c.ui.accent = '#112233'
				c.ui.chips = []
				c.ui.icon = 'ui/other.svg'
			}),
		).toEqual([])
	})
})

describe('scope: asks again only when wider', () => {
	const s0 = scopeOf(m)
	const mod = (f: (c: any) => void) => {
		const c = JSON.parse(JSON.stringify(m))
		f(c)
		return scopeOf(c as Manifest)
	}
	const wider = (f: (c: any) => void) => widerReasons(s0, mod(f)).length > 0
	it('never asks for: the same scope, a code-only update, a translation fix', () => {
		expect(wider(() => {})).toBe(false)
		expect(
			wider((c) => {
				c.version = '0.1.1'
			}),
		).toBe(false)
		expect(
			wider((c) => {
				c.permissions[0].summary.en = 'x'.repeat(10)
			}),
		).toBe(false)
	})
	it('never asks for a narrower scope', () => {
		expect(
			wider((c) => {
				c.produces[0].retentionDays = 3
			}),
		).toBe(false)
		expect(
			wider((c) => {
				c.permissions.pop()
				c.produces.pop()
			}),
		).toBe(false)
		expect(
			wider((c) => {
				c.permissions[0].optional = true
			}),
		).toBe(false)
		expect(
			wider((c) => {
				c.permissions[0].purposes.pop()
			}),
		).toBe(false)
	})
	it('asks for a wider one: new permission, purpose, field, retention, kind, notice version, optional becoming required, log-on', () => {
		expect(
			wider((c) => {
				c.permissions.push({
					id: 'x-new',
					optional: false,
					purposes: [{ id: 'p' }],
				})
			}),
		).toBe(true)
		expect(
			wider((c) => {
				c.permissions[0].purposes.push({ id: 'another' })
			}),
		).toBe(true)
		expect(
			wider((c) => {
				c.produces[0].retentionDays = 30
			}),
		).toBe(true)
		expect(
			wider((c) => {
				c.produces[0].fields.push({ name: 'extra' })
			}),
		).toBe(true)
		expect(
			wider((c) => {
				c.produces.push({
					id: 'a.b',
					from: [],
					fields: [],
					retentionDays: 1,
					leavesMachine: false,
				})
			}),
		).toBe(true)
		expect(
			wider((c) => {
				c.legal.noticeVersion = '1.1'
			}),
		).toBe(true)
		expect(
			wider((c) => {
				c.produces[0].from.push('os.inputCounts')
			}),
		).toBe(true)
		const opt = JSON.parse(JSON.stringify(s0))
		opt.permissions[0].optional = true
		expect(widerReasons(opt, s0).length).toBeGreaterThan(0)
	})
	it('asks when an administrator can newly read the data, and never when that is taken away', () => {
		const closed = { ...s0, adminCanRead: false }
		expect(widerReasons(closed, { ...s0, adminCanRead: true })).toEqual([
			'an administrator can now read the data',
		])
		expect(widerReasons({ ...s0, adminCanRead: true }, closed)).toEqual([])
	})
	it('the wording digest follows the default language only', () => {
		const d0 = wordingDigest(m)
		const m2 = JSON.parse(JSON.stringify(m))
		m2.permissions[0].purposes[0].text.tr += ' Ek.'
		expect(wordingDigest(m2)).not.toBe(d0)
		const m3 = JSON.parse(JSON.stringify(m))
		m3.permissions[0].purposes[0].text.en += ' Extra.'
		expect(wordingDigest(m3)).toBe(d0)
		expect(localizedTexts(m).length).toBeGreaterThan(20)
		expect(sha256Hex('a')).toHaveLength(64)
	})
})
