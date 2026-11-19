import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	buildPackage,
	makeKey,
	makeLicense,
	sampleManifest,
	trustedFrom,
} from './__fixtures__/package-builder.js'
import { disclose, disclosureText } from './disclosure.js'
import { ExtensionError } from './errors.js'
import { ExtensionHost, type HostOptions } from './host.js'
import { LOCK_FILE, secondsWord, waitAfter } from './lock.js'
import { parseManifest } from './manifest.js'
import { scopeOf, widerReasons } from './scope.js'

/** The administrator lock: declared in the manifest, set when it is turned on, asked for by every way off. */
const pub = makeKey('pub-test')
const lic = makeKey('lic-test')
const ID = 'com.example.stub-recorder'
const T0 = Date.parse('2026-06-01T00:00:00Z')
const PW = 'correct horse battery'

type Mut = (m: Record<string, any>) => void
let home: string
let clock: number
const hosts: ExtensionHost[] = []

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'ext-lock-'))
	clock = T0
})
afterEach(async () => {
	for (const h of hosts.splice(0)) await h.stopSupervision()
	removeTempDir(home)
})

const newHost = (opts: Partial<HostOptions> = {}): ExtensionHost => {
	const h = new ExtensionHost({
		home,
		hostVersion: '53.5.0',
		kind: 'cli',
		env: {},
		now: () => clock,
		locale: () => 'en',
		compiledKeys: [trustedFrom(pub)],
		...opts,
	})
	hosts.push(h)
	return h
}
const managed: Mut = (m) => {
	m.management = {
		lock: 'administrator-password',
		purpose: { en: 'Your organisation keeps this on so its records stay complete.' },
	}
}
const pkg = (mut: Mut = managed, version = '1.0.0') =>
	buildPackage({
		manifest: sampleManifest(mut as never, { version, keyId: pub.id }),
		publisherKey: pub,
		licenseKey: lic,
	})
const code = async (fn: () => unknown): Promise<string> => {
	try {
		await fn()
	} catch (e) {
		if (e instanceof ExtensionError) return e.code
		throw e
	}
	return 'ok'
}
/** Added, licensed and acknowledged, not yet turned on. */
function ready(h: ExtensionHost, mut: Mut = managed): void {
	h.add(pkg(mut))
	h.setLicense(ID, makeLicense(lic))
	const n = h.notice(ID)
	h.acknowledge(ID, { noticeVersion: n.noticeVersion, scopeHash: n.scopeHash, locale: n.locale })
}
const on = (h: ExtensionHost): void => {
	ready(h)
	h.enable(ID, { admin: PW })
}

describe('the manifest declares the lock', () => {
	const parse = (mut: Mut) =>
		parseManifest(JSON.stringify(sampleManifest(mut as never, { keyId: pub.id })))
	it('accepts administrator-password with a purpose sentence', () => {
		expect(parse(managed).ok).toBe(true)
	})
	it('refuses another kind of lock, a missing purpose and a purpose with no default-language text', () => {
		expect(
			parse((m) => {
				m.management = { lock: 'pin', purpose: { en: 'Because.' } }
			}).ok,
		).toBe(false)
		expect(
			parse((m) => {
				m.management = { lock: 'administrator-password' }
			}).ok,
		).toBe(false)
		expect(
			parse((m) => {
				m.management = { lock: 'administrator-password', purpose: { tr: 'Çünkü.' } }
			}).ok,
		).toBe(false)
		expect(
			parse((m) => {
				m.management = { lock: 'administrator-password', purpose: { en: 'A reason.' }, x: 1 }
			}).ok,
		).toBe(false)
	})
	it('is part of the scope only when declared, so every older scope keeps its hash', () => {
		const plain = parseManifest(JSON.stringify(sampleManifest(undefined, { keyId: pub.id })))
		const locked = parse(managed)
		if (!plain.ok || !locked.ok) throw new Error('manifest refused')
		expect('management' in scopeOf(plain.manifest)).toBe(false)
		expect(scopeOf(locked.manifest).management).toEqual({ lock: 'administrator-password' })
		expect(widerReasons(scopeOf(plain.manifest), scopeOf(locked.manifest)).join(' ')).toContain(
			'administrator password',
		)
		expect(widerReasons(scopeOf(locked.manifest), scopeOf(plain.manifest))).toEqual([])
	})
	it('the notice says only the administrator can turn it off', () => {
		const locked = parse(managed)
		if (!locked.ok) throw new Error('manifest refused')
		const d = disclose(locked.manifest, 'en', '/data')
		expect(d.management?.line).toContain('Only the administrator can turn this off')
		expect(d.management?.purpose).toBe(
			'Your organisation keeps this on so its records stay complete.',
		)
		expect(disclosureText(d)).toContain('Only the administrator can turn this off')
	})
})

describe('turning it on sets the password; only a slow salted hash is kept', () => {
	it('refuses to turn it on without a password, and a short one', () => {
		const h = newHost()
		ready(h)
		expect(h.view(ID).management).toMatchObject({ lock: 'administrator-password', locked: false })
		return Promise.all([
			expect(code(() => h.enable(ID))).resolves.toBe('admin-needed'),
			expect(code(() => h.enable(ID, { admin: 'short' }))).resolves.toBe('admin-weak'),
		]).then(() => expect(h.view(ID).enabled).toBe(false))
	})
	it('sets it, shows the lock in the view, and keeps no password in any file', () => {
		const h = newHost()
		on(h)
		expect(h.view(ID)).toMatchObject({
			enabled: true,
			management: {
				lock: 'administrator-password',
				locked: true,
				purpose: 'Your organisation keeps this on so its records stay complete.',
			},
		})
		const file = join(home, 'extensions', ID, LOCK_FILE)
		const raw = readFileSync(file, 'utf8')
		const rec = JSON.parse(raw)
		expect(raw).not.toContain(PW)
		expect(rec).toMatchObject({ kdf: 'scrypt', N: 32768, r: 8, p: 1 })
		expect(rec.salt).toMatch(/^[0-9a-f]{32}$/)
		expect(rec.hash).toMatch(/^[0-9a-f]{64}$/)
		expect(h.audit(ID).map((l) => l.event)).toContain('lock-set')
		// nothing of the password is in the audit lines either
		expect(JSON.stringify(h.audit(ID))).not.toContain(PW)
	})
	it('gives each extension its own salt, so the same password is a different hash', () => {
		const h = newHost()
		on(h)
		const other = 'com.example.other-recorder'
		h.add(
			buildPackage({
				manifest: sampleManifest(
					((m: Record<string, any>) => {
						managed(m)
						m.id = other
						m.licensing = { kind: 'none' }
						m.contributes.endpoint.name = 'other-recorder'
					}) as never,
					{ keyId: pub.id },
				),
				publisherKey: pub,
				licenseKey: lic,
			}),
		)
		const n = h.notice(other)
		h.acknowledge(other, {
			noticeVersion: n.noticeVersion,
			scopeHash: n.scopeHash,
			locale: n.locale,
		})
		h.enable(other, { admin: PW })
		const read = (id: string) =>
			JSON.parse(readFileSync(join(home, 'extensions', id, LOCK_FILE), 'utf8'))
		expect(read(ID).salt).not.toBe(read(other).salt)
		expect(read(ID).hash).not.toBe(read(other).hash)
	})
	it('an extension that declares no lock is turned on as before, with no password', () => {
		const h = newHost()
		ready(h, () => {})
		h.enable(ID)
		expect(h.view(ID).management).toBeUndefined()
		expect(existsSync(join(home, 'extensions', ID, LOCK_FILE))).toBe(false)
	})
})

describe('while locked, every way off needs the password', () => {
	it('disable: refused with none and with a wrong one, allowed with the right one', async () => {
		const h = newHost()
		on(h)
		expect(await code(() => h.disable(ID))).toBe('admin-locked')
		expect(await code(() => h.disable(ID, { admin: 'not the password' }))).toBe('admin-wrong')
		expect(h.view(ID).enabled).toBe(true)
		clock += 5000
		expect(await code(() => h.disable(ID, { admin: PW }))).toBe('ok')
		expect(h.view(ID).enabled).toBe(false)
	})
	it('remove (also with the data), licence change and release, revoke and keys all ask', async () => {
		const h = newHost()
		on(h)
		const n = h.notice(ID)
		h.acknowledge(ID, { noticeVersion: n.noticeVersion, scopeHash: n.scopeHash, locale: n.locale })
		h.grant(ID, 'os.screenChange')
		expect(await code(() => h.remove(ID, true))).toBe('admin-locked')
		expect(await code(() => h.setLicense(ID, makeLicense(lic)))).toBe('admin-locked')
		expect(await code(() => h.licenseAction(ID, 'release'))).toBe('admin-locked')
		expect(await code(() => h.revoke(ID, 'os.screenChange'))).toBe('admin-locked')
		expect(await code(() => h.setKey(ID, 'p', 'abcdefgh'))).toBe('admin-locked')
		expect(await code(() => h.setSetting(ID, 'modelKey', 'abcdefgh', 'p'))).toBe('admin-locked')
		expect(h.view(ID).grants).toContain('os.screenChange')
		// and with the password each goes through
		expect(await code(() => h.setKey(ID, 'p', 'abcdefgh', 'modelKey', { admin: PW }))).toBe('ok')
		expect(await code(() => h.revoke(ID, 'os.screenChange', { admin: PW }))).toBe('ok')
		expect(await code(() => h.setLicense(ID, makeLicense(lic), { admin: PW }))).toBe('ok')
	})
	it('turning a permission on or reading a licence is not a way off and needs nothing', async () => {
		const h = newHost()
		on(h)
		expect(await code(() => h.grant(ID, 'os.screenChange'))).toBe('ok')
		expect(await code(() => h.licenseAction(ID, 'check'))).toBe('license-kind')
		expect(await code(() => h.enable(ID))).toBe('ok')
	})
	it('remove with the password removes it and the lock file with it', async () => {
		const h = newHost()
		on(h)
		await h.remove(ID, false, { admin: PW })
		expect(h.exists(ID)).toBe(false)
		expect(existsSync(join(home, 'extensions', ID, LOCK_FILE))).toBe(false)
	})
	it('a refused try is written to the event history, with the operation and never the password', async () => {
		const h = newHost()
		on(h)
		await code(() => h.disable(ID, { admin: 'wrong password!' }))
		const line = h.audit(ID).find((l) => l.event === 'unlock-failed')
		expect(line?.detail).toBe('disable: admin-wrong')
		expect(JSON.stringify(h.audit(ID))).not.toContain('wrong password!')
	})
})

describe('a wrong password makes the next try wait, and the wait grows', () => {
	it('1 s, 2 s, 4 s ... up to a minute', () => {
		expect([1, 2, 3, 4, 7, 20].map(waitAfter)).toEqual([1000, 2000, 4000, 8000, 60000, 60000])
	})
	it('says the wait in words: 1 second, 2 seconds', () => {
		expect([1, 900, 1000].map(secondsWord)).toEqual(['1 second', '1 second', '1 second'])
		expect([1001, 2000, 60000].map(secondsWord)).toEqual(['2 seconds', '2 seconds', '60 seconds'])
	})
	it('inside the wait even the right password is not looked at; after it the right one works and resets', async () => {
		const h = newHost()
		on(h)
		expect(await code(() => h.disable(ID, { admin: 'wrong one 1' }))).toBe('admin-wrong')
		expect(h.view(ID).management?.waitSeconds).toBe(1)
		expect(await code(() => h.disable(ID, { admin: PW }))).toBe('admin-wait')
		clock += 1001
		expect(await code(() => h.disable(ID, { admin: 'wrong one 2' }))).toBe('admin-wrong')
		expect(h.view(ID).management?.waitSeconds).toBe(2)
		clock += 1500
		expect(await code(() => h.disable(ID, { admin: PW }))).toBe('admin-wait')
		clock += 600
		expect(await code(() => h.disable(ID, { admin: PW }))).toBe('ok')
		// the count starts again after a right one
	})
	it('the wait is kept on disk, so another process (the app, the runner) honours it', async () => {
		const h = newHost()
		on(h)
		await code(() => h.disable(ID, { admin: 'wrong one 1' }))
		const other = newHost()
		expect(await code(() => other.disable(ID, { admin: PW }))).toBe('admin-wait')
	})
})

describe('unlock removes the lock and needs the password', () => {
	it('asks for it, drops the lock, writes it to the history, and then it can be turned off freely', async () => {
		const h = newHost()
		on(h)
		expect(await code(() => h.unlock(ID))).toBe('admin-locked')
		expect(await code(() => h.unlock(ID, { admin: PW }))).toBe('ok')
		expect(h.view(ID).management?.locked).toBe(false)
		expect(h.audit(ID).map((l) => l.event)).toContain('lock-released')
		expect(await code(() => h.disable(ID))).toBe('ok')
		expect(await code(() => h.unlock(ID, { admin: PW }))).toBe('not-locked')
		// turning it on again asks for a new password
		expect(await code(() => h.enable(ID))).toBe('admin-needed')
	})
})

describe('an update that adds the lock to an extension that is already on', () => {
	const plainOn = (h: ExtensionHost): void => {
		ready(h, () => {})
		h.enable(ID)
	}
	const addLock: Mut = (m) => {
		managed(m)
		m.legal.noticeVersion = '2.0'
	}
	const stage = (h: ExtensionHost): { noticeVersion: string; scopeHash: string } => {
		const r = h.add(pkg(addLock, '1.1.0'))
		expect(r.update?.waiting).toBe(true)
		const n = h.notice(ID, { staged: true })
		return { noticeVersion: n.noticeVersion, scopeHash: n.scopeHash }
	}

	it('is refused without a password, and nothing changes', () => {
		const h = newHost()
		plainOn(h)
		const n = stage(h)
		let c = ''
		try {
			h.acknowledge(ID, { ...n, staged: true })
		} catch (e) {
			c = (e as ExtensionError).code
		}
		expect(c).toBe('admin-needed')
		expect(h.view(ID).version).toBe('1.0.0')
		expect(h.isLocked(ID)).toBe(false)
	})

	it('refuses a password that is too short', () => {
		const h = newHost()
		plainOn(h)
		const n = stage(h)
		expect(() => h.acknowledge(ID, { ...n, staged: true, admin: 'short' })).toThrow(
			/at least 8 characters/,
		)
		expect(h.view(ID).version).toBe('1.0.0')
	})

	it('sets the password with the acknowledgement, writes it to the history, and then turning it off asks', async () => {
		const h = newHost()
		plainOn(h)
		const n = stage(h)
		h.acknowledge(ID, { ...n, staged: true, admin: PW })
		expect(h.isLocked(ID)).toBe(true)
		expect(h.view(ID).version).toBe('1.1.0')
		expect(h.view(ID).enabled).toBe(true)
		expect(h.audit(ID).map((l) => l.event)).toContain('lock-set')
		expect(await code(() => h.disable(ID))).toBe('admin-locked')
		expect(await code(() => h.disable(ID, { admin: PW }))).toBe('ok')
	})

	it('needs no password when the extension is off: turning it on sets it', () => {
		const h = newHost()
		ready(h, () => {})
		const n = stage(h)
		h.acknowledge(ID, { ...n, staged: true })
		expect(h.isLocked(ID)).toBe(false)
	})
})
