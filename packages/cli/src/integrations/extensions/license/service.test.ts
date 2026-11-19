import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFileSync as rf } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { FakeLicenseService } from '../__fixtures__/fake-license-service.js'
import { parseManifest } from '../manifest.js'
import type { Manifest } from '../types.js'
import { checkAnswer } from './answer.js'
import { DAY, computeState, nextAttemptAt, readCache } from './cache.js'
import type { LicenseVerifierKey } from './key.js'
import { machineHash } from './machine.js'
import {
	type LicenceAudit,
	REQUEST_TIMEOUT_MS,
	ServiceLicence,
	type Transport,
	nodeTransport,
} from './service.js'

const REF = rf(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'..',
		'__fixtures__',
		'vectors',
		'reference-manifest.json',
	),
	'utf8',
)
const EXT = 'com.cogitave.activity'
const T0 = Date.parse('2026-06-01T00:00:00Z')
const HOUR = 3_600_000

function manifestFor(
	svc: FakeLicenseService,
	over: { sends?: string[]; refreshHours?: number; offlineGraceDays?: number } = {},
): Manifest {
	const m = JSON.parse(REF)
	m.licensing = {
		kind: 'service',
		required: true,
		claims: ['customer', 'expires'],
		onInvalid: 'disableAndExplain',
		service: {
			protocol: 'namzu-license/1',
			baseUrl: 'https://license.example.com/v1',
			verifier: { type: 'ed25519-offline', keyId: svc.key.id, keyFile: 'keys/license-pub.json' },
			refreshHours: over.refreshHours ?? 24,
			offlineGraceDays: over.offlineGraceDays ?? 14,
			sends: over.sends ?? ['licenseKey', 'machineHash', 'extensionId', 'extensionVersion'],
			releaseOnRemove: true,
		},
	}
	m.network = {
		mode: 'declared',
		hosts: [
			{
				host: 'license.example.com',
				purpose: { tr: 'Lisans denetimi', en: 'Licence check' },
				for: ['license'],
			},
		],
	}
	m.privacy.leavesTheMachine = 'licence-check-only'
	const r = parseManifest(JSON.stringify(m))
	if (!r.ok) throw new Error(JSON.stringify(r.issues))
	return r.manifest
}

let dir: string
let clock: number
let svc: FakeLicenseService
let audits: [LicenceAudit, string | undefined][]

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'ext-lic-'))
	clock = T0
	audits = []
	svc = new FakeLicenseService(EXT, () => clock)
	await svc.listen()
})
afterEach(async () => {
	vi.useRealTimers()
	await svc.close()
	removeTempDir(dir)
})

function make(
	over: {
		sends?: string[]
		transport?: Transport
		highWater?: number
		devMode?: boolean
		hours?: number
		grace?: number
	} = {},
): ServiceLicence {
	const m = manifestFor(svc, {
		sends: over.sends,
		refreshHours: over.hours,
		offlineGraceDays: over.grace,
	})
	const vk: LicenseVerifierKey = {
		keyId: svc.key.id,
		algorithm: 'ed25519',
		publicKey: svc.key.publicB64,
	}
	return new ServiceLicence({
		manifest: m,
		verifierKey: vk,
		machineHash: machineHash('install-secret', EXT, '1000'),
		hostVersion: '53.5.0',
		cacheFile: join(dir, 'license.json'),
		secretFile: join(dir, 'license-secret.json'),
		transport: over.transport ?? nodeTransport('53.5.0'),
		now: () => clock,
		devMode: over.devMode ?? true,
		baseOverride: svc.url,
		audit: (e, d) => audits.push([e, d]),
		highWater: () => over.highWater,
	})
}

const activated = async (l = make()) => {
	const r = await l.activate(svc.goodKey)
	expect(r.ok).toBe(true)
	return l
}

describe('the machine code', () => {
	it('is stable for one person and extension, differs per extension and per person, and hides the secret', () => {
		const a = machineHash('secret', EXT, '1000')
		expect(machineHash('secret', EXT, '1000')).toBe(a)
		expect(machineHash('secret', 'com.other.thing', '1000')).not.toBe(a)
		expect(machineHash('secret', EXT, '1001')).not.toBe(a)
		expect(machineHash('another', EXT, '1000')).not.toBe(a)
		expect(a).not.toContain('secret')
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
	})
})

describe('a stored answer is checked again when it is read', () => {
	const edit = (
		fn: (c: {
			payload: Record<string, unknown>
			envelope: string
			validUntil: number
		}) => void,
	) => {
		const f = join(dir, 'license.json')
		const c = JSON.parse(readFileSync(f, 'utf8'))
		fn(c)
		writeFileSync(f, JSON.stringify(c))
	}
	it('editing the status or the lifetime in the file changes nothing', async () => {
		const l = await activated()
		clock += 40 * 86_400_000
		const lapsed = l.state().state
		expect(lapsed).not.toBe('ok')
		edit((c) => {
			c.payload.status = 'active'
			c.payload.expires = '2999-01-01T00:00:00Z'
			c.validUntil = clock + 900 * 86_400_000
		})
		expect(l.state().state).toBe(lapsed)
	})
	it('a file whose envelope is not signed by the publisher counts as no licence', async () => {
		const l = await activated()
		edit((c) => {
			c.envelope = JSON.stringify({
				...JSON.parse(c.envelope),
				signature: 'AAAA',
			})
		})
		expect(l.state().state).toBe('needs-license')
		expect(l.answerForExtension()).toBeUndefined()
	})
})

describe('activation', () => {
	it('sends exactly the fields the manifest lists, with no credentials header, and keeps the key in a private file', async () => {
		const l = await activated()
		expect(svc.calls).toHaveLength(1)
		const c = svc.calls[0]
		expect(c?.op).toBe('activate')
		expect(Object.keys(c?.body ?? {}).sort()).toEqual(
			['extensionId', 'extensionVersion', 'licenseKey', 'machineHash', 'nonce', 'op', 'v'].sort(),
		)
		expect(c?.body.extensionVersion).toBe('0.1.0')
		expect(c?.headers.authorization).toBeUndefined()
		expect(c?.headers.cookie).toBeUndefined()
		expect(c?.headers['user-agent']).toBe('namzu/53.5.0 license/1')
		expect(l.state().state).toBe('ok')
		expect(l.hasKey()).toBe(true)
		if (process.platform !== 'win32')
			expect(statSync(join(dir, 'license-secret.json')).mode & 0o077).toBe(0)
		expect(audits.map((a) => a[0])).toContain('license-activated')
	})
	it('sends only the key and the machine code when nothing else is listed', async () => {
		await activated(make({ sends: ['licenseKey', 'machineHash'] }))
		expect(Object.keys(svc.calls[0]?.body ?? {}).sort()).toEqual(
			['licenseKey', 'machineHash', 'nonce', 'op', 'v'].sort(),
		)
	})
	it('the extension reads the signed answer and claims, never the key and never the activation id', async () => {
		const l = await activated()
		const text = l.answerForExtension() ?? ''
		expect(text).not.toContain(svc.goodKey)
		expect(text).not.toContain('act-1')
		expect(JSON.parse(text).claims.customer.name).toBe('Example Customer')
		expect(JSON.parse(text).envelope).toBeUndefined()
		expect(JSON.parse(text).claims.activationId).toBeUndefined()
	})
	it('a wrong key is refused in Namzu words and nothing is stored', async () => {
		const l = make()
		const r = await l.activate('NOT-A-KEY')
		expect(r).toMatchObject({
			ok: false,
			code: 'invalid-key',
			message: 'That licence key was not found.',
		})
		expect(l.hasKey()).toBe(false)
		expect(readCache(join(dir, 'license.json'))).toBeUndefined()
		expect(l.state().state).toBe('needs-license')
	})
	it('all seats in use', async () => {
		svc.scenario = 'seats-exhausted'
		const r = await make().activate(svc.goodKey)
		expect(r).toMatchObject({ ok: false, code: 'seats-exhausted' })
	})
	it('a service that cannot be reached', async () => {
		svc.scenario = 'offline'
		const r = await make().activate(svc.goodKey)
		expect(r).toMatchObject({ ok: false, code: 'unreachable' })
	})
	it('a slow service ends in unreachable after ten seconds, on a fake clock', async () => {
		vi.useFakeTimers()
		const never: Transport = () => new Promise(() => {})
		const p = make({ transport: never }).activate(svc.goodKey)
		await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1)
		await expect(p).resolves.toMatchObject({ ok: false, code: 'unreachable' })
	})
	it('only one request is in flight per extension', async () => {
		const gate: { release: () => void } = { release: () => {} }
		const slow: Transport = (req) =>
			new Promise((resolve) => {
				gate.release = () => void nodeTransport('1')(req).then(resolve)
			})
		const l = make({ transport: slow })
		const first = l.activate(svc.goodKey)
		const second = await l.activate(svc.goodKey)
		expect(second).toMatchObject({ ok: false, code: 'unavailable' })
		gate.release()
		await expect(first).resolves.toMatchObject({ ok: true })
	})
	it('refuses to run with certificate checks switched off', async () => {
		const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
		try {
			const r = await make().activate(svc.goodKey)
			expect(r.ok).toBe(false)
			expect(svc.calls).toHaveLength(0)
			expect(audits.some((a) => a[1] === 'tls-checks-switched-off')).toBe(true)
		} finally {
			if (prev === undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = undefined
			else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev
		}
	})
	it('the test base address is ignored outside developer mode, and with a production key', async () => {
		const calls: string[] = []
		const spy: Transport = async (req) => {
			calls.push(req.url)
			throw new Error('no network in this test')
		}
		await make({ transport: spy, devMode: false }).activate(svc.goodKey)
		expect(calls[0]).toBe('https://license.example.com/v1/activate')
	})
})

describe('a signed answer is checked before it counts (spec 3.5)', () => {
	const bad = async (s: typeof svc.scenario, why: string) => {
		const l = await activated()
		const before = readFileSync(join(dir, 'license.json'), 'utf8')
		svc.scenario = s
		clock += 25 * HOUR
		const r = await l.refresh()
		expect(r.changed).toBe(false)
		expect(audits.some((a) => a[0] === 'license-answer-refused' && a[1] === why)).toBe(true)
		// The previous answer stays, and the failed attempt is only counted.
		expect(JSON.parse(readFileSync(join(dir, 'license.json'), 'utf8')).envelope).toBe(
			JSON.parse(before).envelope,
		)
		expect(readCache(join(dir, 'license.json'))?.failures).toBe(1)
	}
	it('a bad signature is refused', () => bad('bad-signature', 'bad-signature'))
	it('an answer for another nonce is refused', () => bad('wrong-nonce', 'wrong-nonce'))
	it('an old valid answer replayed for a new request is refused', async () => {
		const l = await activated()
		clock += 25 * HOUR
		await l.refresh() // a good refresh: the fake remembers this answer
		clock += 25 * HOUR
		svc.scenario = 'replayed'
		const r = await l.refresh()
		expect(r.changed).toBe(false)
		expect(audits.some((a) => a[0] === 'license-answer-refused' && a[1] === 'wrong-nonce')).toBe(
			true,
		)
	})
	it('an answer for another machine is refused', () => bad('wrong-machine', 'wrong-machine'))
	it('an answer for another extension is refused', () => bad('wrong-extension', 'wrong-extension'))
	it('an answer issued more than ten minutes away from now is refused as clock skew', () =>
		bad('old-issued-at', 'clock-skew'))
	it('a body that is not JSON, or too large, is refused', async () => {
		await bad('not-json', 'not-json')
	})
	it('an oversized answer is refused', async () => {
		await bad('oversized', 'too-large')
	})
	it('an answer that is not application/json is refused', async () => {
		await bad('wrong-content-type', 'content-type')
	})
	it('a lifetime over 30 days is clamped to 30 days and audited', async () => {
		svc.scenario = 'long-lifetime'
		const l = make()
		const r = await l.activate(svc.goodKey)
		expect(r.ok).toBe(true)
		const c = readCache(join(dir, 'license.json'))
		expect(c?.validUntil).toBe(T0 + 30 * DAY)
		expect(audits.some((a) => a[1] === 'lifetime-clamped')).toBe(true)
	})
	it('a signed answer of another kind, such as an offline licence prefix, never verifies', () => {
		const vk = { keyId: svc.key.id, algorithm: 'ed25519' as const, publicKey: svc.key.publicB64 }
		const payload = Buffer.from(JSON.stringify({ v: 1 }))
		const env = JSON.stringify({
			v: 1,
			keyId: svc.key.id,
			payload: payload.toString('base64url'),
			signature: 'AAAA',
		})
		expect(
			checkAnswer({
				text: env,
				verifierKey: vk,
				keyId: svc.key.id,
				extensionId: EXT,
				machineHash: 'x',
				op: 'refresh',
				nonce: 'n',
				now: T0,
				devMode: true,
			}),
		).toEqual({ ok: false, why: 'bad-signature' })
	})
	it('a dev key is refused outside developer mode', async () => {
		const l = make({ devMode: false, transport: nodeTransport('1') })
		const r = await l.activate(svc.goodKey)
		expect(r.ok).toBe(false)
	})
})

describe('refresh, the retry schedule and the grace period (fake clock)', () => {
	it('a refresh is due after refreshHours and not before', async () => {
		const l = await activated()
		expect(l.due()).toBe(false)
		clock = T0 + 24 * HOUR - 1
		expect(l.due()).toBe(false)
		clock = T0 + 24 * HOUR
		expect(l.due()).toBe(true)
		expect(l.nextAt()).toBe(T0 + 24 * HOUR)
		const r = await l.refresh()
		expect(r.changed).toBe(true)
		const c = readCache(join(dir, 'license.json'))
		expect(c?.payload.issuedAt).toBe(new Date(clock).toISOString())
		expect(l.due()).toBe(false)
		expect(svc.calls.at(-1)?.op).toBe('refresh')
		// A refresh carries the activation id and no key.
		expect(svc.calls.at(-1)?.body.activationId).toBe('act-1')
		expect(svc.calls.at(-1)?.body.licenseKey).toBeUndefined()
		expect(audits.map((a) => a[0])).toContain('license-refreshed')
	})
	it('a failed refresh retries after 1, 5 and 30 minutes, then every 2 hours', async () => {
		const l = await activated()
		svc.scenario = 'offline'
		clock = T0 + 24 * HOUR
		const waits: number[] = []
		for (let i = 0; i < 5; i++) {
			await l.refresh()
			const c = readCache(join(dir, 'license.json'))
			if (!c) throw new Error('no cache')
			waits.push((l.nextAt() ?? 0) - clock)
			clock = l.nextAt() ?? clock
		}
		expect(waits.map((w) => w / 60_000)).toEqual([1, 5, 30, 120, 120])
	})
	it('a rate-limited answer waits what the service says', async () => {
		const l = await activated()
		svc.scenario = 'rate-limited'
		clock = T0 + 24 * HOUR
		await l.refresh()
		expect(l.nextAt()).toBe(clock + 120_000)
		expect(l.due()).toBe(false)
	})
	it('keeps working offline after validUntil for the grace period, then stops', async () => {
		const l = await activated()
		svc.scenario = 'offline'
		clock = T0 + 24 * HOUR + 1
		expect(l.state().state).toBe('license-grace')
		const g = l.state()
		if (g.state === 'license-grace') expect(g.daysLeft).toBe(14)
		clock = T0 + 24 * HOUR + 13 * DAY + HOUR
		const g2 = l.state()
		expect(g2.state === 'license-grace' && g2.daysLeft).toBe(1)
		clock = T0 + 24 * HOUR + 14 * DAY
		expect(l.state()).toEqual({ state: 'license-expired', reason: 'grace-over' })
	})
	it('a good answer after a grace period brings the state back to ok', async () => {
		const l = await activated()
		clock = T0 + 2 * DAY
		expect(l.state().state).toBe('license-grace')
		const r = await l.refresh()
		expect(r.state.state).toBe('ok')
	})
	it('an unsigned error never changes a valid state, it only counts as could not check', async () => {
		const l = await activated()
		svc.scenario = 'unsigned-403-with-valid-cache'
		svc.goodKey = 'ROTATED' // the stored key no longer works for the one more activation either
		clock = T0 + 24 * HOUR
		const r = await l.refresh()
		expect(r.changed).toBe(false)
		expect(r.state.state === 'ok' || r.state.state === 'license-grace').toBe(true)
		expect(readCache(join(dir, 'license.json'))?.payload.status).toBe('active')
		expect(readCache(join(dir, 'license.json'))?.failures).toBeGreaterThan(0)
	})
	it('an unknown activation is activated once more with the stored key', async () => {
		const l = await activated()
		svc.scenario = 'invalid-key'
		clock = T0 + 24 * HOUR
		await l.refresh()
		expect(svc.calls.map((c) => c.op).slice(-2)).toEqual(['refresh', 'activate'])
		expect(svc.calls.at(-1)?.body.licenseKey).toBe(svc.goodKey)
	})
})

describe('revoked, suspended, expired and the clock', () => {
	for (const s of ['revoked', 'suspended'] as const) {
		it(`a signed ${s} answer stops the extension at once`, async () => {
			const l = await activated()
			svc.scenario = s
			clock += 25 * HOUR
			const r = await l.refresh()
			expect(r.changed).toBe(true)
			expect(r.state).toMatchObject({ state: 'license-revoked', reason: s })
			expect(audits.map((a) => a[0])).toContain('license-revoked')
		})
	}
	it('a signed expired answer is expired', async () => {
		const l = await activated()
		svc.scenario = 'expired'
		clock += 25 * HOUR
		const r = await l.refresh()
		expect(r.state).toEqual({ state: 'license-expired', reason: 'expired' })
	})
	it('a clock more than a day behind the last time Namzu saw it makes the licence invalid', async () => {
		await activated()
		const st = computeState({
			cache: readCache(join(dir, 'license.json')),
			offlineGraceDays: 14,
			now: T0,
			highWater: T0 + 2 * DAY,
		})
		expect(st).toEqual({ state: 'license-expired', reason: 'clock' })
	})
	it('release frees the seat and a failed release is reported, never thrown', async () => {
		const l = await activated()
		await expect(l.release()).resolves.toEqual({ released: true })
		expect(svc.calls.at(-1)?.op).toBe('release')
		svc.scenario = 'offline'
		await expect(l.release()).resolves.toEqual({ released: false })
	})
	it('the retry time never moves earlier than the due time', async () => {
		const l = await activated()
		const c = readCache(join(dir, 'license.json'))
		if (!c) throw new Error('no cache')
		expect(nextAttemptAt({ ...c, failures: 1, lastAttemptAt: T0 }, 24)).toBe(T0 + 24 * HOUR)
	})
})
