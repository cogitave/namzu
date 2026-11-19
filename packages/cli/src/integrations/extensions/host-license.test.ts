import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { recordingSpawn, settle } from './__fixtures__/fake-child.js'
import { FakeLicenseService } from './__fixtures__/fake-license-service.js'
import {
	buildPackage,
	makeKey,
	sampleManifest,
	trustedFrom,
} from './__fixtures__/package-builder.js'
import { ExtensionHost, type HostOptions } from './host.js'

/** The three licence kinds through the host: none runs, key is round 1, service is checked by Namzu. */
const pub = makeKey('pub-test')
const ID = 'com.example.stub-recorder'
const T0 = Date.parse('2026-06-01T00:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

type Mut = (m: Record<string, any>) => void
let home: string
let clock: number
let svc: FakeLicenseService
const hosts: ExtensionHost[] = []

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), 'ext-hostlic-'))
	clock = T0
	svc = new FakeLicenseService(ID, () => clock)
	await svc.listen()
})
afterEach(async () => {
	for (const h of hosts.splice(0)) await h.stopSupervision()
	await svc.close()
	removeTempDir(home)
})

function newHost(opts: Partial<HostOptions> = {}): ExtensionHost {
	const h = new ExtensionHost({
		home,
		hostVersion: '53.5.0',
		kind: 'cli',
		env: { NAMZU_EXTENSION_DEV: '1', NAMZU_EXTENSION_TEST_LICENSE_BASE: svc.url },
		now: () => clock,
		locale: () => 'en',
		compiledKeys: [trustedFrom(pub)],
		...opts,
	})
	hosts.push(h)
	return h
}

const asNone: Mut = (m) => {
	m.licensing = { kind: 'none' }
}
const asService: Mut = (m) => {
	m.licensing = {
		kind: 'service',
		required: true,
		claims: ['customer', 'expires'],
		onInvalid: 'disableAndExplain',
		service: {
			protocol: 'namzu-license/1',
			baseUrl: 'https://license.example.com/v1',
			verifier: { type: 'ed25519-offline', keyId: 'x', keyFile: 'keys/license-pub.json' },
			refreshHours: 24,
			offlineGraceDays: 14,
			sends: ['licenseKey', 'machineHash', 'extensionId'],
			releaseOnRemove: true,
		},
	}
	m.network = {
		mode: 'declared',
		hosts: [
			{
				host: 'license.example.com',
				purpose: { en: 'Licence check', tr: 'Lisans denetimi' },
				for: ['license'],
			},
		],
	}
	m.privacy.leavesTheMachine = 'licence-check-only'
}
const pkg = (mut: Mut, version = '1.0.0') =>
	buildPackage({
		manifest: sampleManifest(mut as never, { version, keyId: pub.id }),
		publisherKey: pub,
		licenseKey: svc.key,
		files: { 'keys/license-pub.json': svc.keyFile },
	})
function acknowledge(h: ExtensionHost): void {
	const n = h.notice(ID)
	h.acknowledge(ID, { noticeVersion: n.noticeVersion, scopeHash: n.scopeHash, locale: n.locale })
}

describe('licence kind none: an unlicensed extension runs', () => {
	it('needs no licence screen, no key and no licence state; enabling after the notice starts it', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn })
		const r = h.add(pkg(asNone))
		expect(r.view.licenceKind).toBe('none')
		expect(r.view.needs).toEqual(['notice'])
		expect(r.disclosure.licence).toBe('No licence needed.')
		expect(r.disclosure.licenseRequired).toBe(false)
		acknowledge(h)
		expect(h.view(ID).needs).toEqual([])
		h.enable(ID)
		await settle()
		expect(rec.runs()).toHaveLength(1)
		expect(h.view(ID).state).toBe('running')
		expect(rec.runs()[0]?.spec?.env.NAMZU_EXT_LICENSE).toBe('')
	})
	it('refuses a licence file and a licence key for it, in words', async () => {
		const h = newHost()
		h.add(pkg(asNone))
		expect(() => h.setLicense(ID, '{}')).toThrow(/needs no licence/)
		await expect(h.setLicenseKey(ID, 'KEY')).rejects.toThrow(/does not check/)
	})
})

describe('licence kind service: Namzu keeps the secret and checks the signed answer', () => {
	async function ready(h: ExtensionHost): Promise<void> {
		h.add(pkg(asService))
		const out = await h.setLicenseKey(ID, svc.goodKey)
		expect(out.ok).toBe(true)
		acknowledge(h)
	}

	it('the install dialog says what the check sends, from the manifest only', () => {
		const h = newHost()
		const r = h.add(pkg(asService))
		expect(r.disclosure.licence).toBe(
			'Licence check: contacts license.example.com to check your licence key. It sends: your licence key, a code for this computer and the extension name. It checks every 24 hours and keeps working offline for 14 days. It sends nothing else.',
		)
		expect(r.disclosure.network).toContain('license.example.com (license)')
		expect(r.view.needs).toEqual(['license', 'notice'])
		expect(r.view.licenceKind).toBe('service')
	})
	it('activation, then the extension runs; the key is in a private file and in no view, state or environment', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn })
		await ready(h)
		h.enable(ID)
		await settle()
		expect(h.view(ID).state).toBe('running')
		expect(h.view(ID).licence?.customer).toBe('Example Customer')
		const everything = JSON.stringify([h.view(ID), h.list(), h.status(ID), h.audit(ID)])
		expect(everything).not.toContain(svc.goodKey)
		expect(everything).not.toContain('act-1')
		const env = rec.runs()[0]?.spec?.env ?? {}
		expect(Object.values(env).join('|')).not.toContain(svc.goodKey)
		const answer = env.NAMZU_EXT_LICENSE ?? ''
		expect(answer.endsWith('license-answer.json')).toBe(true)
		const body = readFileSync(answer, 'utf8')
		expect(body).not.toContain(svc.goodKey)
		expect(body).not.toContain('act-1')
		expect(JSON.parse(body).claims.customer.name).toBe('Example Customer')
		// The key itself is kept by Namzu, outside the extension's data and run folders.
		expect(readFileSync(join(home, 'extensions', ID, 'license-secret.json'), 'utf8')).toContain(
			svc.goodKey,
		)
	})
	it('a signed revoked answer stops the running extension at once', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn })
		await ready(h)
		h.enable(ID)
		await settle()
		expect(h.view(ID).running).toBe(true)
		svc.scenario = 'revoked'
		clock += 25 * HOUR
		h.tick() // a refresh is due and is made by the supervisor
		await settle()
		await settle()
		h.tick()
		await settle()
		expect(h.view(ID).state).toBe('license-revoked')
		expect(h.view(ID).indicator?.label).toMatch(/publisher withdrew the licence/)
		expect(rec.runs()[0]?.written.some((l) => l.includes('shutdown'))).toBe(true)
	})
	it('keeps running through the offline grace with a visible notice, then stops', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn })
		await ready(h)
		h.enable(ID)
		await settle()
		svc.scenario = 'offline'
		clock += 2 * DAY
		h.tick()
		await settle()
		const v = h.view(ID)
		expect(v.running).toBe(true)
		expect(v.licenceGraceDaysLeft).toBeGreaterThan(0)
		expect(v.indicator?.label).toMatch(/licence not checked, \d+ days left/)
		clock += 20 * DAY
		h.tick()
		await settle()
		expect(h.view(ID).state).toBe('license-expired')
	})
	it('only an enabled extension refreshes: a disabled one sends nothing', async () => {
		const h = newHost()
		await ready(h)
		const calls = svc.calls.length
		clock += 3 * DAY
		h.tick()
		await settle()
		expect(svc.calls.length).toBe(calls)
	})
	it('a refresh is made by tick when due and its answer replaces the cached one', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn })
		await ready(h)
		h.enable(ID)
		await settle()
		clock += 24 * HOUR
		h.tick()
		await settle()
		await settle()
		expect(svc.calls.at(-1)?.op).toBe('refresh')
		expect(h.view(ID).state).toBe('running')
	})
	it('Check now and Release this computer go through the host; the result carries no key', async () => {
		const h = newHost()
		await ready(h)
		const a = await h.licenseAction(ID, 'check')
		expect(a.done).toBe(true)
		expect(JSON.stringify(a)).not.toContain(svc.goodKey)
		const b = await h.licenseAction(ID, 'release')
		expect(b.done).toBe(true)
		expect(existsSync(join(home, 'extensions', ID, 'license-secret.json'))).toBe(false)
		expect(h.view(ID).needs).toContain('license')
	})
	it('remove frees the seat at the publisher and never waits on a service that is down', async () => {
		const h = newHost()
		await ready(h)
		await h.remove(ID, false)
		expect(svc.calls.at(-1)?.op).toBe('release')
		expect(existsSync(join(home, 'extensions', ID, 'license-secret.json'))).toBe(false)
		const h2 = newHost()
		await ready(h2)
		svc.scenario = 'offline'
		await expect(h2.remove(ID, false)).resolves.toBeUndefined()
	})
	it('a bad key is refused in words, nothing is stored, and the audit records the failure', async () => {
		const h = newHost()
		h.add(pkg(asService))
		const out = await h.setLicenseKey(ID, 'WRONG')
		expect(out).toMatchObject({ ok: false, code: 'invalid-key' })
		expect(existsSync(join(home, 'extensions', ID, 'license-secret.json'))).toBe(false)
		expect(h.audit(ID).map((l) => l.event)).toContain('license-failed')
	})
	it('a service licence answer with a bad signature is refused', async () => {
		const h = newHost()
		h.add(pkg(asService))
		svc.scenario = 'bad-signature'
		const out = await h.setLicenseKey(ID, svc.goodKey)
		expect(out.ok).toBe(false)
		expect(h.view(ID).needs).toContain('license')
		expect(h.audit(ID).some((l) => l.event === 'license-answer-refused')).toBe(true)
	})
})
