import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { FakeChild, recordingSpawn, settle } from './__fixtures__/fake-child.js'
import {
	type BuildInput,
	buildPackage,
	makeKey,
	makeLicense,
	sampleManifest,
	trustedFrom,
} from './__fixtures__/package-builder.js'
import { ExtensionError } from './errors.js'
import { ExtensionHost, type HostOptions, startToken } from './host.js'
import { cleanEnv } from './spawn.js'

const pub = makeKey('pub-test')
const lic = makeKey('lic-test')
const T0 = Date.parse('2026-06-01T00:00:00Z')

type Mut = (m: any) => void
let home: string
let clock: number
const hosts: ExtensionHost[] = []

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'ext-host-'))
	clock = T0
})
afterEach(async () => {
	for (const h of hosts.splice(0)) await h.stopSupervision()
	removeTempDir(home)
})

function newHost(
	opts: Partial<HostOptions> & { spawn?: HostOptions['spawn'] } = {},
): ExtensionHost {
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
const pkg = (mut?: Mut, version = '1.0.0', over: Partial<BuildInput> = {}) =>
	buildPackage({
		manifest: sampleManifest(mut as never, { version, keyId: pub.id }),
		publisherKey: pub,
		licenseKey: lic,
		...over,
	})
const ID = 'com.example.stub-recorder'
function editedLicense(): string {
	const l = JSON.parse(makeLicense(lic)) as { payload: string }
	const p = JSON.parse(Buffer.from(l.payload, 'base64url').toString())
	p.seats = 1000
	l.payload = Buffer.from(JSON.stringify(p)).toString('base64url')
	return JSON.stringify(l)
}
const code = (fn: () => unknown): string => {
	try {
		fn()
	} catch (e) {
		if (e instanceof ExtensionError) return e.code
		throw e
	}
	return 'ok'
}
/** Add, license, acknowledge exactly what the notice shows: a person who has said yes. */
function ready(h: ExtensionHost, mut?: Mut) {
	h.add(pkg(mut))
	h.setLicense(ID, makeLicense(lic))
	const n = h.notice(ID)
	h.acknowledge(ID, { noticeVersion: n.noticeVersion, scopeHash: n.scopeHash, locale: n.locale })
}

describe('E1, E3: nothing is written for a refused package', () => {
	it('an unknown signing key writes nothing under the extensions folder', () => {
		const h = newHost({ compiledKeys: [trustedFrom(makeKey('another'))] })
		expect(code(() => h.add(pkg()))).toBe('untrusted-publisher')
		expect(existsSync(join(home, 'extensions'))).toBe(false)
	})
	it('a tampered file writes nothing', () => {
		const h = newHost()
		expect(code(() => h.add(pkg(undefined, '1.0.0', { tamper: 'bin/stub.cjs' })))).toBe('tampered')
		expect(existsSync(join(home, 'extensions'))).toBe(false)
	})
	it('engines and platform outside the range are refused with the words', () => {
		const h = newHost({ hostVersion: '1.0.0' })
		expect(
			code(() =>
				h.add(
					pkg((m) => {
						m.engines.namzu = '>=53.5.0 <54'
					}),
				),
			),
		).toBe('engine')
		expect(code(() => newHost({ arch: 'riscv64' }).add(pkg()))).toBe('platform')
		expect(existsSync(join(home, 'extensions'))).toBe(false)
	})
})

describe('E4: add shows what it asks for and starts nothing', () => {
	it('prints each permission with its purposes, the network line, state added, and makes no data folder', () => {
		const h = newHost()
		const r = h.add(pkg())
		expect(r.view.state).toBe('added')
		expect(r.disclosure.permissions.map((p) => p.id)).toEqual([
			'os.foregroundWindow',
			'os.screenChange',
		])
		expect(r.disclosure.permissions[0]?.purposes[0]).toMatch(/count the time/)
		expect(r.disclosure.network).toBe('It does not use the network.')
		expect(r.disclosure.permissions[1]?.optional).toBe(true)
		expect(existsSync(join(home, 'extensions', ID, 'data'))).toBe(false)
		expect(h.status(ID).view.running).toBe(false)
	})
	it('versions are unpacked read-only and the audit says added', () => {
		const h = newHost()
		h.add(pkg())
		const v = join(home, 'extensions', ID, 'versions', '1.0.0')
		expect(statSync(join(v, 'namzu-extension.json')).mode & 0o222).toBe(0)
		expect(h.audit(ID).map((l) => l.event)).toContain('added')
	})
	it('the state folder is mode 700', () => {
		newHost().add(pkg())
		expect(statSync(join(home, 'extensions')).mode & 0o777).toBe(0o700)
	})
})

describe('E6: a licence is needed, and each bad one is named', () => {
	it('enable without a licence says needs-license', () => {
		const h = newHost()
		h.add(pkg())
		expect(code(() => h.enable(ID))).toBe('needs-license')
	})
	it.each([
		[
			'wrong extension',
			makeLicense(lic, { extensionId: 'com.example.other' }),
			'license-wrong-extension',
		],
		[
			'not yet valid',
			makeLicense(lic, { notBefore: '2027-01-01T00:00:00Z' }),
			'license-not-yet-valid',
		],
		['expired', makeLicense(lic, { expires: '2026-01-02T00:00:00Z' }), 'license-expired'],
		['edited', editedLicense(), 'license-signature'],
		['not even JSON', 'garbage', 'license-malformed'],
		['signed by the wrong key', makeLicense(makeKey('lic-test')), 'license-signature'],
	])('%s', (_n, text, want) => {
		const h = newHost()
		h.add(pkg())
		expect(code(() => h.setLicense(ID, text))).toBe(want)
		expect(h.view(ID).state).toBe('added')
	})
	it('a clock rolled back more than a day is named', () => {
		const h = newHost()
		h.add(pkg())
		h.setLicense(ID, makeLicense(lic))
		clock = T0 - 3 * 86_400_000
		expect(code(() => h.setLicense(ID, makeLicense(lic)))).toBe('license-clock-rolled-back')
	})
})

describe('E7, E8: the notice is asked once, and only a yes writes a record', () => {
	it('enable with no record needs the notice; declining writes no record and leaves it off', () => {
		const h = newHost()
		h.add(pkg())
		h.setLicense(ID, makeLicense(lic))
		expect(h.pendingNotice(ID)).toEqual({ staged: false })
		expect(code(() => h.enable(ID))).toBe('needs-notice')
		h.declined(ID)
		expect(h.consent.read(ID)).toBeUndefined()
		expect(h.view(ID).enabled).toBe(false)
		expect(h.audit(ID).map((l) => l.event)).toContain('declined')
	})
	it('an acknowledgement echoing another notice version or scope hash is refused', () => {
		const h = newHost()
		h.add(pkg())
		const n = h.notice(ID)
		expect(code(() => h.acknowledge(ID, { noticeVersion: '9.9', scopeHash: n.scopeHash }))).toBe(
			'stale-notice',
		)
		expect(
			code(() => h.acknowledge(ID, { noticeVersion: n.noticeVersion, scopeHash: 'f'.repeat(64) })),
		).toBe('stale-notice')
		expect(h.consent.read(ID)).toBeUndefined()
	})
	it('a yes writes the record with every field of the design', () => {
		const h = newHost()
		ready(h)
		const r = h.consent.read(ID)
		expect(r).toMatchObject({
			schema: 1,
			extensionId: ID,
			noticeVersion: '1.0',
			noticeLocale: 'en',
			firstVersion: '1.0.0',
			versionAtAcknowledgement: '1.0.0',
			via: 'cli',
			hostVersion: '53.5.0',
		})
		expect(r?.scopeHash).toMatch(/^[0-9a-f]{64}$/)
		expect(r?.wordingDigest).toMatch(/^[0-9a-f]{64}$/)
		expect(r?.person.osUserHash).toMatch(/^[0-9a-f]{64}$/)
		expect(r?.noticeSha256).toMatch(/^[0-9a-f]{64}$/)
		expect(statSync(join(home, 'extensions', ID, 'consent.json')).mode & 0o777).toBe(0o600)
		expect(h.pendingNotice(ID)).toBeNull()
		expect(h.view(ID).state).toBe('ready')
	})
	it('the person can reread the notice and see the record at any time, and reading changes nothing', () => {
		const h = newHost()
		ready(h)
		const before = readFileSync(join(home, 'extensions', ID, 'consent.json'), 'utf8')
		const n = h.notice(ID)
		expect(n.text).toContain('This is a test notice')
		expect(n.record?.acknowledgedAt).toBe(new Date(T0).toISOString())
		expect(h.notice(ID, { locale: 'tr' }).text).toContain('Notice in tr')
		expect(readFileSync(join(home, 'extensions', ID, 'consent.json'), 'utf8')).toBe(before)
	})
})

describe('E8: the process starts with a clean environment', () => {
	it('contains no NAMZU_ key but NAMZU_EXT_*, no API key, not the secret setting', async () => {
		const rec = recordingSpawn()
		const h = newHost({
			spawn: rec.spawn,
			env: {
				NAMZU_HOME: '/secret',
				OPENAI_API_KEY: 'sk-nope',
				ANTHROPIC_API_KEY: 'sk-nope2',
				PATH: '/x',
				HOME: '/home/me',
				LANG: 'en_US.UTF-8',
			},
		})
		ready(h)
		h.setKey(ID, 'openai', 'sk-model-key-1234')
		h.enable(ID)
		await settle()
		const env = rec.runs()[0]?.spec?.env ?? {}
		for (const k of Object.keys(env)) {
			if (k.startsWith('NAMZU_')) expect(k.startsWith('NAMZU_EXT_')).toBe(true)
			expect(k).not.toMatch(/API_KEY/)
		}
		expect(Object.values(env).join('|')).not.toContain('sk-model-key-1234')
		expect(Object.values(env).join('|')).not.toContain('sk-nope')
		expect(env.HOME).toBe(join(home, 'extensions', ID, 'data'))
		expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
		expect(env.NAMZU_EXT_ID).toBe(ID)
		expect(env.NAMZU_EXT_GRANTED).toBe('')
		expect(env.STUB_LOCALE).toBe('en')
		expect(rec.runs()[0]?.spec?.cwd).toBe(join(home, 'extensions', ID, 'versions', '1.0.0'))
		expect(h.view(ID).state).toBe('running')
	})
	it('the windows set is the minimal system variables', () => {
		const m: any = JSON.parse(
			readFileSync(
				new URL('./__fixtures__/vectors/reference-manifest.json', import.meta.url),
				'utf8',
			),
		)
		const env = cleanEnv({
			manifest: m,
			platform: 'win32',
			hostEnv: { SystemRoot: 'C:\\Windows', USERNAME: 'a', SECRET_TOKEN: 'x', NAMZU_X: '1' },
			extensionDir: 'C:\\e',
			dataDir: 'C:\\d',
			runDir: 'C:\\r',
			consentPath: 'c',
			licensePath: 'l',
			granted: [],
			queryAddr: 'p',
			locale: 'tr',
		})
		expect(env.SystemRoot).toBe('C:\\Windows')
		expect(env.LOCALAPPDATA).toBe('C:\\d')
		expect(env.SECRET_TOKEN).toBeUndefined()
		expect(env.NAMZU_X).toBeUndefined()
		expect(env.ACTIVITY_DATA).toBe('C:\\d')
		expect(env.ACTIVITY_LOCALE).toBe('tr')
	})
})

describe('E12: restarts, reboots and disable then enable never ask again', () => {
	it('a new host process starts it again, no question; disable then enable asks nothing', async () => {
		const rec = recordingSpawn()
		const h1 = newHost({ spawn: rec.spawn })
		ready(h1)
		h1.enable(ID)
		await settle()
		await h1.stopSupervision()
		// A reboot: a brand-new host object reading the same files.
		const rec2 = recordingSpawn()
		const h2 = newHost({ spawn: rec2.spawn })
		expect(h2.pendingNotice(ID)).toBeNull()
		h2.tick()
		await settle()
		expect(rec2.runs()).toHaveLength(1)
		await h2.disable(ID)
		expect(h2.view(ID).enabled).toBe(false)
		expect(() => h2.enable(ID)).not.toThrow()
		await settle()
		expect(rec2.runs()).toHaveLength(2)
		expect(h2.audit(ID, 100).filter((l) => l.event === 'acknowledged')).toHaveLength(1)
	})
	it('a record copied from another user or computer does not cover', () => {
		const h = newHost()
		ready(h)
		const copy = readFileSync(join(home, 'extensions', ID, 'consent.json'), 'utf8')
		removeTempDir(home)
		home = mkdtempSync(join(tmpdir(), 'ext-host-'))
		const other = newHost()
		other.add(pkg())
		other.setLicense(ID, makeLicense(lic))
		writeFileSync(join(home, 'extensions', ID, 'consent.json'), copy)
		expect(other.pendingNotice(ID)).toEqual({ staged: false })
		expect(code(() => other.enable(ID))).toBe('needs-notice')
	})
})

describe('E13: updates, the browser-extension way', () => {
	it('an update with the same scope swaps silently and asks nothing', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn })
		ready(h)
		h.enable(ID)
		await settle()
		const r = h.add(pkg(undefined, '1.1.0'))
		expect(r.update).toEqual({ waiting: false, reasons: [] })
		expect(h.view(ID).version).toBe('1.1.0')
		expect(h.view(ID).state).not.toBe('update-waiting')
		await settle()
		await settle()
		expect(existsSync(join(home, 'extensions', ID, 'versions', '1.0.0'))).toBe(false)
		expect(rec.runs().length).toBeGreaterThanOrEqual(2)
		expect(h.pendingNotice(ID)).toBeNull()
	})
	it('a narrower scope swaps silently and replaces the record', () => {
		const h = newHost()
		ready(h)
		const before = h.consent.read(ID)
		h.add(
			pkg((m) => {
				m.produces[0].retentionDays = 3
			}, '1.1.0'),
		)
		const after = h.consent.read(ID)
		expect(h.view(ID).version).toBe('1.1.0')
		expect(after?.scopeHash).not.toBe(before?.scopeHash)
		expect(after?.previous[0]?.scopeHash).toBe(before?.scopeHash)
		expect(after?.acknowledgedAt).toBe(before?.acknowledgedAt)
		expect(h.audit(ID, 100).map((l) => l.event)).toContain('record-narrowed')
		expect(h.pendingNotice(ID)).toBeNull()
	})
	it('an update with a new permission is held until acknowledged; the old version keeps running', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn })
		ready(h)
		h.enable(ID)
		await settle()
		const wide: Mut = (m) => {
			m.permissions.push({
				id: 'os.inputCounts',
				level: 'high',
				optional: false,
				personalData: true,
				summary: { en: 'Counts keys and clicks.' },
				purposes: [{ id: 'input-volume', text: { en: 'To count input.' } }],
			})
			m.produces.push({
				id: 'stub.input.minute',
				from: ['os.inputCounts'],
				description: { en: 'Input counts.' },
				grain: 'minute',
				fields: [
					{ name: 'minute', type: 'timestamp', description: { en: 'Minute' } },
					{ name: 'keys', type: 'integer', description: { en: 'Key count' } },
				],
				retentionDays: 7,
				leavesMachine: false,
			})
			m.legal.noticeVersion = '1.1'
		}
		const r = h.add(pkg(wide, '1.1.0'))
		expect(r.update?.waiting).toBe(true)
		expect(r.update?.reasons.join(' ')).toMatch(/new permission os\.inputCounts/)
		expect(r.update?.reasons.join(' ')).toMatch(/notice version 1\.0 -> 1\.1/)
		expect(h.view(ID).version).toBe('1.0.0')
		expect(h.view(ID).state).toBe('running')
		expect(h.view(ID).updateWaiting?.version).toBe('1.1.0')
		expect(h.pendingNotice(ID)).toEqual({ staged: true })
		expect(code(() => h.enable(ID))).toBe('needs-notice')
		const n = h.notice(ID, { staged: true })
		expect(n.diff?.join(' ')).toMatch(/os\.inputCounts/)
		// Acknowledging the OLD notice's numbers for the staged update is refused.
		expect(
			code(() => h.acknowledge(ID, { noticeVersion: '1.0', scopeHash: n.scopeHash, staged: true })),
		).toBe('stale-notice')
		h.acknowledge(ID, {
			noticeVersion: n.noticeVersion,
			scopeHash: n.scopeHash,
			locale: n.locale,
			staged: true,
		})
		expect(h.view(ID).version).toBe('1.1.0')
		expect(h.consent.read(ID)?.noticeVersion).toBe('1.1')
		expect(h.consent.read(ID)?.previous).toHaveLength(1)
		expect(h.pendingNotice(ID)).toBeNull()
	})
	it('a person who never acknowledges stays on the old version', () => {
		const h = newHost()
		ready(h)
		h.add(
			pkg((m) => {
				m.legal.noticeVersion = '1.1'
			}, '1.1.0'),
		)
		expect(h.view(ID).version).toBe('1.0.0')
		expect(h.status(ID).staged?.version).toBe('1.1.0')
	})
	it('wording changed under the same notice version is refused', () => {
		const h = newHost()
		ready(h)
		expect(
			code(() =>
				h.add(
					pkg((m) => {
						m.permissions[0].purposes[0].text.en += ' Also for something else.'
					}, '1.1.0'),
				),
			),
		).toBe('wording-changed')
		expect(h.view(ID).version).toBe('1.0.0')
	})
	it('a translation fix alone is not a wording change', () => {
		const h = newHost()
		ready(h)
		h.add(
			pkg((m) => {
				m.permissions[0].purposes[0].text.tr += ' (düzeltme)'
			}, '1.1.0'),
		)
		expect(h.view(ID).version).toBe('1.1.0')
	})
	it('the same bytes again are a no-op; the same version with other bytes, and a lower version, are refused', () => {
		const h = newHost()
		ready(h)
		const same = pkg()
		expect(h.add(same).noop).toBe(true)
		expect(
			code(() =>
				h.add(
					pkg((m) => {
						m.description.en = 'A different description entirely.'
					}),
				),
			),
		).toBe('version')
		h.add(pkg(undefined, '1.2.0'))
		expect(code(() => h.add(pkg(undefined, '1.1.0')))).toBe('version')
	})
	it('a newly added optional permission is staged like any new scope, and stays off until granted', () => {
		const h = newHost()
		ready(h)
		const r = h.add(
			pkg((m) => {
				m.legal.noticeVersion = '1.1'
				m.permissions.push({
					id: 'os.sessionEvents',
					level: 'low',
					optional: true,
					personalData: true,
					summary: { en: 'Lock and unlock.' },
					purposes: [{ id: 'day-boundaries', text: { en: 'To find the start and end of a day.' } }],
					prompt: { en: 'Allow lock and unlock events?' },
				})
				m.produces.push({
					id: 'stub.session.event',
					from: ['os.sessionEvents'],
					description: { en: 'Session events.' },
					grain: 'event',
					fields: [{ name: 'at', type: 'timestamp', description: { en: 'When' } }],
					retentionDays: 7,
					leavesMachine: false,
				})
			}, '1.1.0'),
		)
		expect(r.update?.waiting).toBe(true)
		expect(h.view(ID).version).toBe('1.0.0')
		expect(h.view(ID).grants).toEqual([])
	})
})

describe('grants: optional permissions are asked for later, one by one', () => {
	it('grant needs the optional permission, records it, and the process gets it through hello-ack', async () => {
		const rec = recordingSpawn({ uses: ['os.foregroundWindow', 'os.screenChange'] })
		const h = newHost({ spawn: rec.spawn })
		ready(h)
		expect(code(() => h.grant(ID, 'os.foregroundWindow'))).toBe('not-optional')
		expect(code(() => h.grant(ID, 'os.nothing'))).toBe('unknown-permission')
		h.enable(ID)
		await settle()
		// Without the grant, a process that uses the optional permission is refused (R4).
		expect(h.view(ID).state).toBe('failed')
		await h.stopSupervision()
		h.grant(ID, 'os.screenChange')
		expect(h.consent.read(ID)?.grants['os.screenChange']?.purposeIds).toEqual(['screen-activity'])
		h.startAgain(ID)
		await settle()
		expect(rec.runs().at(-1)?.spec?.env.NAMZU_EXT_GRANTED).toBe('os.screenChange')
		expect(h.view(ID).state).toBe('running')
		h.revoke(ID, 'os.screenChange')
		expect(h.consent.read(ID)?.grants).toEqual({})
	})
})

describe('E14: an expired licence stops the process', () => {
	it('stops it, says license-expired, runs maintenance, keeps the data, and a new licence resumes with no notice', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn })
		h.add(pkg())
		h.setLicense(ID, makeLicense(lic, { expires: '2026-06-10T00:00:00Z' }))
		const n = h.notice(ID)
		h.acknowledge(ID, { noticeVersion: n.noticeVersion, scopeHash: n.scopeHash, locale: n.locale })
		h.enable(ID)
		await settle()
		expect(h.view(ID).state).toBe('running')
		writeFileSync(join(home, 'extensions', ID, 'data', 'rows.db'), 'rows')
		clock = Date.parse('2026-06-11T00:00:00Z')
		h.tick()
		await settle()
		await settle()
		expect(rec.runs()[0]?.written.some((w) => w.includes('shutdown'))).toBe(true)
		const v = h.view(ID)
		expect(v.state).toBe('license-expired')
		expect(v.indicator?.label).toBe(
			'Stub Recorder stopped: the licence has expired. Nothing is being recorded.',
		)
		expect(rec.maintenance().length).toBeGreaterThanOrEqual(1)
		expect(h.audit(ID, 100).map((l) => l.event)).toEqual(
			expect.arrayContaining(['license-expired', 'maintenance']),
		)
		expect(readFileSync(join(home, 'extensions', ID, 'data', 'rows.db'), 'utf8')).toBe('rows')
		const runsBefore = rec.runs().length
		h.setLicense(ID, makeLicense(lic, { expires: '2027-06-10T00:00:00Z' }))
		await settle()
		expect(h.pendingNotice(ID)).toBeNull()
		expect(rec.runs().length).toBe(runsBefore + 1)
		expect(h.view(ID).state).toBe('running')
	})
})

describe('E17: disable, remove, and the kept record', () => {
	it('disable runs maintenance; remove with data deletion deletes data and keeps the record; re-adding while it covers asks nothing; after it is gone it asks once', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn })
		ready(h)
		h.enable(ID)
		await settle()
		writeFileSync(join(home, 'extensions', ID, 'data', 'rows.db'), 'rows')
		await h.disable(ID)
		expect(rec.maintenance().length).toBeGreaterThanOrEqual(1)
		expect(h.audit(ID, 100).map((l) => l.event)).toContain('maintenance')
		await h.remove(ID, true)
		expect(existsSync(join(home, 'extensions', ID))).toBe(false)
		expect(existsSync(join(home, 'extensions', '_removed', `${ID}.consent.json`))).toBe(true)
		// Back again: the kept record covers the same scope.
		h.add(pkg())
		h.setLicense(ID, makeLicense(lic))
		expect(h.pendingNotice(ID)).toBeNull()
		await h.remove(ID, false)
		expect(existsSync(join(home, 'extensions', ID, 'data'))).toBe(false)
		// After retainDays the record is deleted at the next host start, and the question comes back once.
		clock = T0 + 1826 * 86_400_000
		h.tick()
		expect(existsSync(join(home, 'extensions', '_removed', `${ID}.consent.json`))).toBe(false)
		h.add(pkg())
		h.setLicense(ID, makeLicense(lic, { expires: '2099-01-01T00:00:00Z' }))
		expect(h.pendingNotice(ID)).toEqual({ staged: false })
	})
	it('remove keeping data leaves the data folder', async () => {
		const h = newHost()
		ready(h)
		mkdtempSync(join(home, 'noop-'))
		const { mkdirSync } = await import('node:fs')
		mkdirSync(join(home, 'extensions', ID, 'data'), { recursive: true })
		writeFileSync(join(home, 'extensions', ID, 'data', 'a'), '1')
		await h.remove(ID, false)
		expect(existsSync(join(home, 'extensions', ID, 'data', 'a'))).toBe(true)
		expect(existsSync(join(home, 'extensions', ID, 'versions'))).toBe(false)
	})
})

describe('review fixes', () => {
	const adminFlip =
		(open: boolean): Mut =>
		(m) => {
			m.privacy.storage.adminCanRead = open
		}
	it('an update that lets an administrator read the data is held, though permissions and notice version are the same', () => {
		const h = newHost()
		ready(h, adminFlip(false))
		const r = h.add(pkg(adminFlip(true), '1.1.0'))
		expect(r.update?.waiting).toBe(true)
		expect(r.update?.reasons).toContain('an administrator can now read the data')
		expect(h.view(ID).version).toBe('1.0.0')
	})
	it('a tampered install can still be removed, and the record is kept', async () => {
		const h = newHost()
		ready(h)
		const { chmodSync } = await import('node:fs')
		const dir = join(home, 'extensions', ID, 'versions', '1.0.0', 'schemas')
		chmodSync(dir, 0o755)
		chmodSync(join(dir, 'counts.json'), 0o644)
		writeFileSync(join(dir, 'counts.json'), '{"type":"object"}')
		const after = newHost()
		expect(after.list()[0]?.why).toMatch(/^tampered: /)
		await after.remove(ID, true)
		expect(existsSync(join(home, 'extensions', ID))).toBe(false)
		const kept = JSON.parse(
			readFileSync(join(home, 'extensions', '_removed', `${ID}.consent.json`), 'utf8'),
		)
		expect(kept.retainDays).toBe(3650)
	})
	it('the kept record runs from the removal date, and a one-shot add drops an expired one', async () => {
		const h = newHost()
		ready(h)
		clock = T0 + 400 * 86_400_000
		await h.remove(ID, true)
		h.tick()
		expect(existsSync(join(home, 'extensions', '_removed', `${ID}.consent.json`))).toBe(true)
		clock = clock + 1900 * 86_400_000
		h.add(pkg())
		h.setLicense(ID, makeLicense(lic, { expires: '2099-01-01T00:00:00Z' }))
		expect(h.pendingNotice(ID)).toEqual({ staged: false })
	})
	it('a lock created by another host between our read and write is not taken', () => {
		const h = newHost()
		ready(h)
		const lock = join(home, 'extensions', ID, 'run', 'lock')
		mkdirSync(join(home, 'extensions', ID, 'run'), { recursive: true })
		const body = JSON.stringify({
			pid: process.ppid,
			token: startToken(process.ppid),
			kind: 'desktop',
		})
		writeFileSync(lock, body)
		h.enable(ID)
		h.tick()
		expect(readFileSync(lock, 'utf8')).toBe(body)
	})
	it('a same-scope update of a running extension stops it before the old folder goes, and survives a folder that will not go', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn })
		ready(h)
		h.enable(ID)
		await settle()
		const old = join(home, 'extensions', ID, 'versions', '1.0.0')
		h.add(pkg(undefined, '1.1.0'))
		await settle()
		await settle()
		expect(existsSync(old)).toBe(false)
		expect(h.view(ID).version).toBe('1.1.0')
	})
})

describe('E18: languages', () => {
	it('a person in English sees English; a person in French sees the default with the language line', () => {
		const h = newHost({ locale: () => 'en' })
		expect(h.add(pkg()).disclosure.name).toBe('Stub Recorder')
		const fr = newHost({ locale: () => 'fr' })
		const d = fr.view(ID)
		expect(d.shownLocale).toBe('en')
		expect(fr.notice(ID).languageNote).toMatch(/not available in your language\. Showing English\./)
	})
	it('a person in Turkish sees the Turkish texts and chips', () => {
		const h = newHost({ locale: () => 'tr' })
		h.add(pkg())
		expect(h.view(ID).name).toBe('Deneme Kaydedici')
		expect(h.view(ID).chip).toBe('Eklendi')
		expect(h.notice(ID).text).toContain('Notice in tr')
	})
	it('a package in one language only works, and the dialog shows everything', () => {
		const h = newHost({ locale: () => 'tr' })
		const one: Mut = (m) => {
			m.locales = ['en']
			const strip = (o: any): void => {
				if (!o || typeof o !== 'object') return
				if (Array.isArray(o)) {
					o.forEach(strip)
					return
				}
				if ('en' in o && 'tr' in o) o.tr = undefined
				for (const v of Object.values(o)) strip(v)
			}
			strip(m)
			m.legal.notices.tr = undefined
		}
		const r = h.add(pkg(one))
		expect(r.disclosure.languageNote).toMatch(/Showing English/)
		expect(r.disclosure.permissions.length).toBe(2)
	})
})

describe('E19: keys entered by hand', () => {
	it('are stored mode 600 apart from the person’s own keys, never returned, and not in the child environment', () => {
		const h = newHost()
		ready(h)
		const v = h.setKey(ID, 'openai', 'sk-abcdef-1234')
		expect(v).toEqual({ hasValue: true, masked: '********1234' })
		expect(statSync(join(home, 'extensions', ID, 'keys.json')).mode & 0o777).toBe(0o600)
		expect(JSON.stringify(h.getSetting(ID, 'modelKey', 'openai'))).not.toContain('sk-abcdef')
		expect(JSON.stringify(h.setSetting(ID, 'modelKey', 'sk-zzz-9999', 'openai'))).not.toContain(
			'sk-zzz',
		)
		expect(JSON.stringify(h.status(ID))).not.toContain('sk-')
		expect(h.setKey(ID, 'openai', null)).toEqual({ hasValue: false })
	})
	it('R7: a setting the manifest did not declare is refused', () => {
		const h = newHost()
		ready(h)
		expect(code(() => h.getSetting(ID, 'nothing'))).toBe('R7')
		expect(code(() => h.setSetting(ID, 'nothing', 'x'))).toBe('R7')
	})
	it('the person’s own provider code cannot select or read the extension key file', () => {
		const roots = [join(__dirname, '..', 'providers'), join(__dirname, '..', '..', 'decision')]
		const offenders: string[] = []
		const walk = (d: string) => {
			if (!existsSync(d)) return
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const p = join(d, e.name)
				if (e.isDirectory()) walk(p)
				else if (
					/\.tsx?$/.test(e.name) &&
					/integrations\/extensions|extensions\/[^'"]*keys\.json/.test(readFileSync(p, 'utf8'))
				)
					offenders.push(p)
			}
		}
		for (const r of roots) walk(r)
		expect(offenders).toEqual([])
	})
})

describe('E20: the indicator belongs to the host', () => {
	it('every host state has its fixed sentence, in English and Turkish', async () => {
		const events: string[] = []
		const rec = recordingSpawn()
		let loc = 'en'
		const h = newHost({
			locale: () => loc,
			spawn: rec.spawn,
			onState: (e) => events.push(`${e.state}:${e.indicator?.label ?? ''}`),
		})
		ready(h)
		h.enable(ID)
		await settle()
		expect(events.at(-1)).toBe('running:Stub Recorder is counting which program is in front.')
		loc = 'tr'
		expect(h.view(ID).indicator?.label).toBe('Deneme Kaydedici öndeki programı sayıyor.')
	})
	it('a notice that stops covering shows the host sentence "off until you read its notice"', () => {
		const h = newHost()
		ready(h)
		const st = join(home, 'extensions', ID, 'state.json')
		writeFileSync(st, JSON.stringify({ ...JSON.parse(readFileSync(st, 'utf8')), enabled: true }))
		const dir = join(home, 'extensions', ID, 'consent.json')
		const rec = JSON.parse(readFileSync(dir, 'utf8'))
		rec.person.osUserHash = 'x'
		writeFileSync(dir, JSON.stringify(rec))
		expect(h.view(ID).indicator?.label).toBe(
			'Stub Recorder is off until you read its notice. Nothing is being recorded.',
		)
	})
})

describe('E22: two hosts for one user run one process', () => {
	it('the second host only reads while the first owns it; when the owner is gone the second takes over without asking', async () => {
		const rec1 = recordingSpawn()
		const h1 = newHost({ spawn: rec1.spawn })
		ready(h1)
		h1.enable(ID)
		await settle()
		expect(rec1.runs()).toHaveLength(1)
		// A second host in the same OS user: same pid here, so stage the owner as another live process (our parent).
		const lock = join(home, 'extensions', ID, 'run', 'lock')
		writeFileSync(
			lock,
			JSON.stringify({ pid: process.ppid, token: startToken(process.ppid), kind: 'desktop' }),
		)
		await h1.stopSupervision()
		writeFileSync(
			lock,
			JSON.stringify({ pid: process.ppid, token: startToken(process.ppid), kind: 'desktop' }),
		)
		const rec2 = recordingSpawn()
		const h2 = newHost({ spawn: rec2.spawn })
		h2.tick()
		await settle()
		expect(rec2.runs()).toHaveLength(0)
		// The owner dies: a pid that is gone.
		const { spawnSync } = await import('node:child_process')
		const dead = spawnSync(process.execPath, [
			'-e',
			'process.stdout.write(String(process.pid))',
		]).stdout.toString()
		writeFileSync(lock, JSON.stringify({ pid: Number(dead), token: 'gone', kind: 'desktop' }))
		h2.tick()
		await settle()
		expect(rec2.runs()).toHaveLength(1)
		expect(h2.pendingNotice(ID)).toBeNull()
	})
})

describe('E2: a file changed on disk after install stops the next start with tampered', () => {
	it('never starts and says why', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn })
		ready(h)
		h.enable(ID)
		await settle()
		await h.stopSupervision()
		const { chmodSync } = await import('node:fs')
		const f = join(home, 'extensions', ID, 'versions', '1.0.0', 'schemas', 'counts.json')
		chmodSync(join(home, 'extensions', ID, 'versions', '1.0.0', 'schemas'), 0o755)
		chmodSync(f, 0o644)
		writeFileSync(f, '{"type":"object"}')
		const after = newHost({ spawn: rec.spawn })
		expect(code(() => after.enable(ID))).toBe('tampered')
		after.tick()
		await settle()
		expect(rec.runs()).toHaveLength(1)
		expect(after.list()[0]?.state).toBe('failed')
		expect(after.list()[0]?.why).toMatch(/tampered/)
	})
})

describe('queries: the host refuses what the manifest did not declare', () => {
	it('R1: an undeclared query is refused before anything is sent', async () => {
		const h = newHost()
		ready(h)
		await expect(h.query(ID, 'dump-everything')).rejects.toMatchObject({ code: 'R1' })
		expect(
			h.audit(ID, 20).some((l) => l.event === 'query-refused' && /R1/.test(l.detail ?? '')),
		).toBe(true)
	})
	it('a stopped extension cannot answer', async () => {
		const h = newHost()
		ready(h)
		await expect(h.query(ID, 'counts')).rejects.toMatchObject({ code: 'not-running' })
	})
})

describe('misc', () => {
	it('a FakeChild lives in memory', () => {
		expect(new FakeChild().pid).toBeGreaterThan(0)
	})
	it('the host digest is the sha256 of bytes', () => {
		expect(ExtensionHost.digest(Buffer.from('a'))).toHaveLength(64)
	})
})

describe('the host leaves nothing hidden behind', () => {
	it('emergencyStop kills what the host runs, at once, and frees the lock', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn })
		ready(h)
		h.enable(ID)
		await settle()
		expect(existsSync(join(home, 'extensions', ID, 'run', 'lock'))).toBe(true)
		h.emergencyStop()
		expect(rec.runs()[0]?.killed).toEqual([true])
		expect(existsSync(join(home, 'extensions', ID, 'run', 'lock'))).toBe(false)
	})
})

describe('who starts the process', () => {
	it('a one-shot command enables and says so, and never starts a process of its own', async () => {
		const rec = recordingSpawn()
		const h = newHost({ spawn: rec.spawn, oneShot: true })
		ready(h)
		h.enable(ID)
		await settle()
		expect(rec.runs()).toHaveLength(0)
		expect(h.view(ID).enabled).toBe(true)
		// A host that supervises (Desktop, a terminal session, `run`) picks it up on its next check.
		const owner = newHost({ spawn: rec.spawn })
		owner.tick()
		await settle()
		expect(rec.runs()).toHaveLength(1)
	})

	it('when another process swaps in a new version, the owner restarts on it at its next check', async () => {
		const rec = recordingSpawn()
		const owner = newHost({ spawn: rec.spawn })
		ready(owner)
		owner.enable(ID)
		await settle()
		expect(rec.runs()).toHaveLength(1)
		// A person's other terminal adds a same-scope update; it does not own the process.
		const other = newHost({ spawn: recordingSpawn().spawn, oneShot: true })
		other.add(pkg(undefined, '1.0.1'))
		owner.tick()
		await settle()
		await settle()
		expect(rec.runs()).toHaveLength(2)
		expect(rec.runs()[0]?.written.some((w) => w.includes('shutdown'))).toBe(true)
		expect(rec.runs()[1]?.spec?.cwd).toBe(join(home, 'extensions', ID, 'versions', '1.0.1'))
		expect(owner.view(ID).state).toBe('running')
	})
})
