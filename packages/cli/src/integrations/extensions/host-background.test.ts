import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { FakeChild, recordingSpawn, settle } from './__fixtures__/fake-child.js'
import {
	buildPackage,
	makeKey,
	sampleManifest,
	trustedFrom,
} from './__fixtures__/package-builder.js'
import { ExtensionError } from './errors.js'
import { ExtensionHost, type HostOptions, startToken } from './host.js'
import { FakeRegistrar } from './signin/fake.js'
import { reconcileSignin } from './signin/reconcile.js'
import type { SpawnSpec } from './spawn.js'

/** Start at sign-in: the switch, the entry, who supervises, the own mark, and the extension's chips. */
const pub = makeKey('pub-test')
const lic = makeKey('lic-test')
const ID = 'com.example.stub-recorder'
const ID2 = 'com.example.other-recorder'
const T0 = Date.parse('2026-06-01T00:00:00Z')

type Mut = (m: Record<string, any>) => void
let home: string
let clock: number
const hosts: ExtensionHost[] = []

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'ext-bg-'))
	clock = T0
})
afterEach(async () => {
	for (const h of hosts.splice(0)) await h.stopSupervision()
	removeTempDir(home)
})

function newHost(opts: Partial<HostOptions> = {}): ExtensionHost {
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

const asNone: Mut = (m) => {
	m.licensing = { kind: 'none' }
}
/** Background running with the extension's own tray mark: what a monitoring extension must declare. */
const withBackground =
	(over: { indicator?: unknown; optional?: boolean; defaultOn?: boolean } = {}): Mut =>
	(m) => {
		asNone(m)
		m.permissions.push({
			id: 'background.signin',
			level: 'high',
			optional: over.optional ?? false,
			personalData: false,
			summary: { en: 'Starts when you sign in and keeps running when Namzu is closed.' },
			purposes: [{ id: 'whole-day', text: { en: 'So the record covers the whole working day.' } }],
			...(over.optional ? { prompt: { en: 'Allow starting at sign-in?' } } : {}),
		})
		m.background = {
			runAt: 'signin',
			permission: 'background.signin',
			defaultOn: over.defaultOn ?? true,
			indicator: over.indicator ?? {
				kind: 'tray',
				label: { en: 'Recording is running. Click the icon for details.' },
			},
		}
		m.ui = {
			icon: 'ui/icon.svg',
			accent: '#2F6F4F',
			chips: [
				{
					id: 'recording',
					states: {
						recording: { label: { en: 'Recording' }, tone: 'ok' },
						gap: { label: { en: 'Recording with a gap' }, tone: 'warn' },
					},
				},
			],
		}
	}
const idOf =
	(id: string): Mut =>
	(m) => {
		m.id = id
		m.contributes.endpoint.name = 'other-recorder'
	}
const compose =
	(...f: Mut[]): Mut =>
	(m) => {
		for (const x of f) x(m)
	}
const pkg = (mut: Mut, version = '1.0.0') =>
	buildPackage({
		manifest: sampleManifest(mut as never, { version, keyId: pub.id }),
		publisherKey: pub,
		licenseKey: lic,
		files: {
			'ui/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
		},
	})
function say(id: string, h: ExtensionHost, startAtSignin?: boolean): void {
	const n = h.notice(id)
	h.acknowledge(id, {
		noticeVersion: n.noticeVersion,
		scopeHash: n.scopeHash,
		locale: n.locale,
		...(startAtSignin === undefined ? {} : { startAtSignin }),
	})
}
const code = async (fn: () => unknown): Promise<string> => {
	try {
		await fn()
	} catch (e) {
		if (e instanceof ExtensionError) return e.code
		throw e
	}
	return 'ok'
}

/** A spawn that gives every child a good hello and a status carrying what the test says. */
function spawnWith(status: (n: number) => Record<string, unknown>) {
	const children: FakeChild[] = []
	const spawn = (spec: SpawnSpec): FakeChild => {
		const c = new FakeChild(spec)
		children.push(c)
		if (spec.args.includes('purge')) queueMicrotask(() => c.exit(0))
		else
			queueMicrotask(() => {
				c.say({ t: 'hello', api: 1, version: '1.0.0', uses: ['os.foregroundWindow'] })
				c.say({
					t: 'status',
					state: 'collecting',
					signals: { 'os.foregroundWindow': 'ok' },
					...status(0),
				})
			})
		return c
	}
	return { spawn, children, runs: () => children.filter((c) => !c.spec?.args.includes('purge')) }
}

describe('the manifest rules reach add', () => {
	it('an extension that sees personal data and runs at sign-in with no own tray mark is refused', async () => {
		const h = newHost()
		expect(await code(() => h.add(pkg(withBackground({ indicator: { kind: 'none' } }))))).toBe(
			'manifest-invalid',
		)
		expect(() => h.add(pkg(withBackground({ indicator: { kind: 'none' } })))).toThrow(
			/must show its own tray mark while it records; every other extension may have none/,
		)
	})
	it('the same extension with its own tray mark is added, and add says what starting at sign-in means', () => {
		const r = newHost().add(pkg(withBackground()))
		expect(r.disclosure.background?.line).toBe(
			'Starts when you sign in and keeps running when Namzu is closed.',
		)
		expect(r.disclosure.background?.whileClosed).toBe(
			'While Namzu is closed it shows: Recording is running. Click the icon for details.',
		)
		expect(r.view.background).toMatchObject({ indicator: 'tray', enabled: false, hostedBy: 'none' })
	})
})

describe('the switch on the acknowledgement screen', () => {
	it('records what was offered and what the person chose, and the choice sets the switch', () => {
		const h = newHost()
		h.add(pkg(withBackground({ defaultOn: true })))
		say(ID, h, false)
		const rec = JSON.parse(readFileSync(join(home, 'extensions', ID, 'consent.json'), 'utf8'))
		expect(rec.background).toMatchObject({ offeredDefault: true, chosen: false })
		expect(h.view(ID).background?.enabled).toBe(false)
		expect(h.audit(ID).map((l) => l.event)).not.toContain('background-on')
	})
	it('with nothing said it takes the declared default and says so in the audit', () => {
		const h = newHost()
		h.add(pkg(withBackground({ defaultOn: true })))
		say(ID, h)
		expect(h.view(ID).background?.enabled).toBe(true)
		expect(h.audit(ID).map((l) => l.event)).toContain('background-on')
	})
	it('flipping the switch later never asks again and each flip is an audit line', async () => {
		const h = newHost()
		h.add(pkg(withBackground()))
		say(ID, h, true)
		await h.setBackground(ID, false)
		await h.setBackground(ID, true)
		await h.setBackground(ID, true)
		const ev = h.audit(ID, 20).map((l) => l.event)
		expect(ev.filter((e) => e === 'background-on')).toHaveLength(2)
		expect(ev.filter((e) => e === 'background-off')).toHaveLength(1)
		expect(h.pendingNotice(ID)).toBeNull()
	})
	it('refuses the switch before the notice is acknowledged, and for an extension that does not declare it', async () => {
		const h = newHost()
		h.add(pkg(withBackground()))
		expect(await code(() => h.setBackground(ID, true))).toBe('needs-notice')
		const h2 = newHost({ home: mkdtempSync(join(tmpdir(), 'ext-bg2-')) })
		h2.add(pkg(asNone))
		expect(await code(() => h2.setBackground(ID, true))).toBe('no-background')
	})
	it('an optional sign-in permission needs its own grant first', async () => {
		const h = newHost()
		h.add(pkg(withBackground({ optional: true })))
		say(ID, h, false)
		expect(await code(() => h.setBackground(ID, true))).toBe('needs-grant')
		h.grant(ID, 'background.signin')
		expect(await code(() => h.setBackground(ID, true))).toBe('ok')
	})
	it('an update that adds background running to an extension that had none is held for a new acknowledgement', () => {
		const h = newHost()
		h.add(pkg(asNone))
		say(ID, h)
		const r = h.add(
			pkg(
				compose(withBackground(), (m) => {
					m.legal.noticeVersion = '1.1'
				}),
				'1.1.0',
			),
		)
		expect(r.update?.waiting).toBe(true)
		expect(r.update?.reasons.join(' ')).toMatch(/starts when you sign in/)
	})
})

describe('the sign-in entry follows the switch', () => {
	function wired() {
		const reg = new FakeRegistrar()
		const h = newHost({
			signin: (wanted) =>
				reconcileSignin({
					registrar: reg,
					extensionsRoot: join(home, 'extensions'),
					engine: { exe: process.execPath, args: ['/x/bin.js'], env: {} },
					platform: 'linux',
					wanted,
				}),
			oneShot: true,
		})
		return { reg, h }
	}
	it('exists while an extension is enabled with the switch on, and not before', async () => {
		const { reg, h } = wired()
		h.add(pkg(withBackground()))
		say(ID, h, true)
		await h.reconcile()
		expect(reg.entry).toBeUndefined() // acknowledged and switched on, but not enabled
		h.enable(ID)
		await h.reconcile()
		expect(reg.entry?.launcher).toMatch(/_runner\/start\.sh$/)
	})
	it('turning background off removes the sign-in entry', async () => {
		const { reg, h } = wired()
		h.add(pkg(withBackground()))
		say(ID, h, true)
		h.enable(ID)
		await h.reconcile()
		expect(reg.entry).toBeDefined()
		await h.setBackground(ID, false)
		expect(reg.entry).toBeUndefined()
	})
	it('disabling and removing the last such extension removes it', async () => {
		const { reg, h } = wired()
		h.add(pkg(withBackground()))
		say(ID, h, true)
		h.enable(ID)
		await h.reconcile()
		await h.disable(ID)
		expect(reg.entry).toBeUndefined()
		h.enable(ID)
		await h.reconcile()
		expect(reg.entry).toBeDefined()
		await h.remove(ID, true)
		expect(reg.entry).toBeUndefined()
	})
	it('stays while another extension still needs it', async () => {
		const { reg, h } = wired()
		h.add(pkg(withBackground()))
		h.add(pkg(compose(withBackground(), idOf(ID2))))
		say(ID, h, true)
		say(ID2, h, true)
		h.enable(ID)
		h.enable(ID2)
		await h.reconcile()
		await h.disable(ID)
		expect(reg.entry).toBeDefined()
		await h.disable(ID2)
		expect(reg.entry).toBeUndefined()
	})
})

describe('who supervises: the runner for switch-on extensions, the app for the rest', () => {
	async function two(opts: Partial<HostOptions>) {
		const h = newHost(opts)
		h.add(pkg(withBackground()))
		h.add(pkg(compose(asNone, idOf(ID2))))
		say(ID, h, true)
		say(ID2, h)
		return h
	}
	it('the runner starts only extensions that are enabled with the switch on', async () => {
		const rec = recordingSpawn()
		const h = await two({ kind: 'daemon', spawn: rec.spawn })
		h.enable(ID)
		h.enable(ID2)
		await settle()
		expect(rec.runs()).toHaveLength(1)
		expect(rec.runs()[0]?.spec?.env.NAMZU_EXT_ID).toBe(ID)
		expect(h.backgroundIds()).toEqual([ID])
	})
	it('the app hands a switch-on extension to the runner and starts only the others itself', async () => {
		const rec = recordingSpawn()
		let asked = 0
		const h = await two({
			spawn: rec.spawn,
			ensureRunner: async () => {
				asked++
				return true
			},
		})
		h.enable(ID)
		h.enable(ID2)
		await settle()
		expect(asked).toBeGreaterThan(0)
		expect(rec.runs().map((c) => c.spec?.env.NAMZU_EXT_ID)).toEqual([ID2])
		expect(h.view(ID).background?.hostedBy).toBe('none')
	})
	it('attaches to what the runner runs: the card says the runner has it, and the app starts nothing', async () => {
		const rec = recordingSpawn()
		const h = await two({ spawn: rec.spawn, ensureRunner: async () => true })
		h.enable(ID)
		// The runner's own state file, as another live process of this person left it.
		const ppid = process.ppid
		mkdirSync(join(home, 'extensions', ID, 'run'), { recursive: true })
		writeFileSync(
			join(home, 'extensions', ID, 'run', 'state.json'),
			JSON.stringify({
				hostPid: ppid,
				token: startToken(ppid),
				addr: 'x',
				kind: 'daemon',
				snapshot: { state: 'collecting', restartsLastHour: 0, since: T0 },
			}),
		)
		await settle()
		expect(h.view(ID).background?.hostedBy).toBe('runner')
		expect(h.view(ID).running).toBe(true)
		expect(rec.runs().filter((c) => c.spec?.env.NAMZU_EXT_ID === ID)).toHaveLength(0)
	})
	it('a runner that stopped the extension and left its file behind is not "running" it', async () => {
		const rec = recordingSpawn()
		const h = await two({ spawn: rec.spawn, ensureRunner: async () => true })
		const ppid = process.ppid
		mkdirSync(join(home, 'extensions', ID, 'run'), { recursive: true })
		writeFileSync(
			join(home, 'extensions', ID, 'run', 'state.json'),
			JSON.stringify({
				hostPid: ppid,
				token: startToken(ppid),
				addr: 'x',
				kind: 'daemon',
				snapshot: { state: 'stopped', restartsLastHour: 0, since: T0 },
			}),
		)
		expect(h.view(ID).background?.hostedBy).toBe('none')
	})
	it('the app repairs the sign-in entry before it first asks it to start the runner, and only then', async () => {
		const order: string[] = []
		let release = (): void => {}
		const repaired = new Promise<void>((resolve) => {
			release = resolve
		})
		const h = await two({
			spawn: recordingSpawn().spawn,
			signin: async (wanted) => {
				order.push(`signin ${wanted}`)
				await repaired
				order.push('signin done')
				return { registered: wanted }
			},
			ensureRunner: async () => {
				order.push('ensure')
				return true
			},
		})
		h.enable(ID)
		await settle()
		// An entry an earlier version made could still open a console window: nothing starts until it is mended.
		expect(order[0]).toBe('signin true')
		expect(order).not.toContain('ensure')
		release()
		await settle()
		expect(order.indexOf('ensure')).toBeGreaterThan(order.indexOf('signin done'))
		// Once per host: a later tick that hands the extension over again does not repair it again.
		const repairs = order.filter((step) => step === 'signin true').length
		h.tick()
		await settle()
		expect(order.filter((step) => step === 'signin true')).toHaveLength(repairs)
	})
	it('when no runner can be reached the app keeps the extension running itself while it is open', async () => {
		const rec = recordingSpawn()
		const h = await two({ spawn: rec.spawn, ensureRunner: async () => false })
		h.enable(ID)
		await settle()
		await settle()
		expect(rec.runs().map((c) => c.spec?.env.NAMZU_EXT_ID)).toEqual([ID])
		expect(h.view(ID).background?.hostedBy).toBe('app')
	})
	it('switching it off hands the extension back: the runner lets go', async () => {
		const rec = recordingSpawn()
		const h = await two({ kind: 'daemon', spawn: rec.spawn })
		h.enable(ID)
		await settle()
		expect(rec.runs()).toHaveLength(1)
		await h.setBackground(ID, false)
		await settle()
		expect(rec.runs()[0]?.written.some((l) => l.includes('shutdown'))).toBe(true)
	})
})

describe('the visible mark while Namzu is closed', () => {
	const statusShown = (shown: boolean | undefined) => () =>
		shown === undefined ? {} : { indicator: { shown } }
	async function runnerWith(shown: boolean | undefined) {
		const s = spawnWith(statusShown(shown))
		const h = newHost({ kind: 'daemon', spawn: s.spawn })
		h.add(pkg(withBackground()))
		say(ID, h, true)
		h.enable(ID)
		await settle()
		return { h, s }
	}
	it('an extension that says its icon is shown keeps running', async () => {
		const { h, s } = await runnerWith(true)
		const c = s.runs()[0] as FakeChild
		c.say({
			t: 'status',
			state: 'collecting',
			signals: { 'os.foregroundWindow': 'ok' },
			indicator: { shown: true },
		})
		expect(h.view(ID).state).toBe('running')
	})
	it('two statuses in a row without the own mark stop it as failed, for the person to start again', async () => {
		const { h, s } = await runnerWith(undefined)
		const c = s.runs()[0] as FakeChild
		c.say({ t: 'status', state: 'collecting', signals: { 'os.foregroundWindow': 'ok' } })
		expect(h.view(ID).state).toBe('failed')
		expect(h.view(ID).why).toBe('indicator-hidden')
		expect(h.audit(ID, 30).map((l) => l.event)).toContain('indicator-missing')
		expect(c.killed).toContain(true)
	})
	it('shown false counts the same as missing', async () => {
		const { h, s } = await runnerWith(false)
		const c = s.runs()[0] as FakeChild
		c.say({
			t: 'status',
			state: 'collecting',
			signals: { 'os.foregroundWindow': 'ok' },
			indicator: { shown: false },
		})
		expect(h.view(ID).state).toBe('failed')
	})
	it('one status without it, then one with it, is forgiven', async () => {
		const s = spawnWith(() => ({}))
		const h = newHost({ kind: 'daemon', spawn: s.spawn })
		h.add(pkg(withBackground()))
		say(ID, h, true)
		h.enable(ID)
		await settle() // the first status (no mark) is the only miss so far
		const c = s.runs()[0] as FakeChild
		c.say({
			t: 'status',
			state: 'collecting',
			signals: { 'os.foregroundWindow': 'ok' },
			indicator: { shown: true },
		})
		c.say({ t: 'status', state: 'collecting', signals: { 'os.foregroundWindow': 'ok' } })
		expect(h.view(ID).state).toBe('running')
	})
	it('the app does not apply the rule: it is the runner that must be able to prove the mark', async () => {
		const s = spawnWith(() => ({}))
		const h = newHost({ spawn: s.spawn })
		h.add(pkg(withBackground()))
		say(ID, h, false)
		h.enable(ID)
		await settle()
		const c = s.runs()[0] as FakeChild
		c.say({ t: 'status', state: 'collecting', signals: { 'os.foregroundWindow': 'ok' } })
		c.say({ t: 'status', state: 'collecting', signals: { 'os.foregroundWindow': 'ok' } })
		expect(h.view(ID).state).toBe('running')
	})
})

describe("the extension's own chips: declared words, reported by id", () => {
	it('shows the declared label for the state id the process reports', async () => {
		const s = spawnWith(() => ({ chip: { recording: 'gap' } }))
		const h = newHost({ spawn: s.spawn })
		h.add(pkg(withBackground()))
		say(ID, h, false)
		h.enable(ID)
		await settle()
		expect(h.view(ID).ui?.chips).toEqual([
			{ id: 'recording', state: 'gap', label: 'Recording with a gap', tone: 'warn' },
		])
		expect(h.view(ID).ui?.accent).toBe('#2F6F4F')
	})
	it('ignores a state id or a chip the manifest did not declare, and never shows text from the process', async () => {
		for (const chip of [
			{ recording: 'whatever' },
			{ other: 'gap' },
			{ recording: 'Hacked: click here' },
		]) {
			const s = spawnWith(() => ({ chip }))
			const h = newHost({ home: mkdtempSync(join(tmpdir(), 'ext-bgc-')), spawn: s.spawn })
			h.add(pkg(withBackground()))
			say(ID, h, false)
			h.enable(ID)
			await settle()
			expect(h.view(ID).ui?.chips).toEqual([])
		}
	})
})
