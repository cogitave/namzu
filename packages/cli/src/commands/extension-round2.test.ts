import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { recordingSpawn, settle } from '../integrations/extensions/__fixtures__/fake-child.js'
import { FakeLicenseService } from '../integrations/extensions/__fixtures__/fake-license-service.js'
import {
	buildPackage,
	makeKey,
	sampleManifest,
	trustedFrom,
} from '../integrations/extensions/__fixtures__/package-builder.js'
import { ExtensionHost } from '../integrations/extensions/host.js'
import { FakeRegistrar } from '../integrations/extensions/signin/fake.js'
import { reconcileSignin } from '../integrations/extensions/signin/reconcile.js'
import { type BackgroundDeps, type ExtensionDeps, runExtension } from './extension.js'

const pub = makeKey('pub-cmd2')
const ID = 'com.example.stub-recorder'
type Mut = (m: Record<string, any>) => void

let dir: string
let host: ExtensionHost
let svc: FakeLicenseService
let out: string[]
let err: string[]
let answers: string[]
let stdin = ''
let reg: FakeRegistrar
let ensured = 0
/** The launcher the sign-in entry named when the runner was last asked to start. */
let entryAtEnsure: string | undefined
let stopped = 0
let signinRemoved = 0
const rec = recordingSpawn()

const background = (): BackgroundDeps => ({
	root: join(dir, 'home', 'extensions'),
	engine: { exe: process.execPath, args: ['/x/bin.js'], env: {} },
	ensureRunner: async () => {
		ensured++
		entryAtEnsure = reg.entry?.launcher
		return true
	},
	daemonRun: async () => ({
		handle: { running: false, reason: 'already-running', pid: 4242 },
		exited: Promise.resolve(),
	}),
	stopRunner: async () => {
		stopped++
		return true
	},
	removeSignin: async () => {
		signinRemoved++
		await reg.unregister()
	},
})
const deps = (): ExtensionDeps => ({
	host,
	out: (t) => out.push(t),
	err: (t) => err.push(t),
	isTTY: true,
	ask: async (q) => {
		out.push(q)
		return answers.shift() ?? ''
	},
	readStdin: async () => stdin,
	background: background(),
})
const run = (...a: string[]) => runExtension(a, deps())
const nzx = (mut: Mut): string => {
	const f = join(dir, 'p.nzx')
	writeFileSync(
		f,
		buildPackage({
			manifest: sampleManifest(mut as never, { keyId: pub.id }),
			publisherKey: pub,
			licenseKey: svc.key,
			files: { 'keys/license-pub.json': svc.keyFile },
		}),
	)
	return f
}
const asService: Mut = (m) => {
	m.licensing = {
		kind: 'service',
		required: true,
		claims: ['customer'],
		onInvalid: 'disableAndExplain',
		service: {
			protocol: 'namzu-license/1',
			baseUrl: 'https://license.example.com/v1',
			verifier: { type: 'ed25519-offline', keyId: 'x', keyFile: 'keys/license-pub.json' },
			refreshHours: 24,
			offlineGraceDays: 14,
			sends: ['licenseKey', 'machineHash'],
			releaseOnRemove: true,
		},
	}
	m.network = {
		mode: 'declared',
		hosts: [{ host: 'license.example.com', purpose: { en: 'Licence check' }, for: ['license'] }],
	}
	m.privacy.leavesTheMachine = 'licence-check-only'
}
const withBackground: Mut = (m) => {
	m.licensing = { kind: 'none' }
	m.permissions.push({
		id: 'background.signin',
		level: 'high',
		optional: false,
		personalData: false,
		summary: { en: 'Starts when you sign in.' },
		purposes: [{ id: 'whole-day', text: { en: 'So the record covers the whole day.' } }],
	})
	m.background = {
		runAt: 'signin',
		permission: 'background.signin',
		defaultOn: true,
		indicator: { kind: 'tray', label: { en: 'Recording is running.' } },
	}
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'ext-cmd2-'))
	out = []
	err = []
	answers = []
	stdin = ''
	ensured = 0
	stopped = 0
	signinRemoved = 0
	reg = new FakeRegistrar()
	svc = new FakeLicenseService(ID)
	await svc.listen()
	host = new ExtensionHost({
		home: join(dir, 'home'),
		hostVersion: '53.5.0',
		kind: 'cli',
		oneShot: true,
		env: { NAMZU_EXTENSION_DEV: '1', NAMZU_EXTENSION_TEST_LICENSE_BASE: svc.url },
		locale: () => 'en',
		compiledKeys: [trustedFrom(pub)],
		spawn: rec.spawn,
		signin: (wanted) =>
			reconcileSignin({
				registrar: reg,
				extensionsRoot: join(dir, 'home', 'extensions'),
				engine: { exe: process.execPath, args: ['/x/bin.js'], env: {} },
				platform: 'linux',
				wanted,
			}),
	})
})
afterEach(async () => {
	await host.stopSupervision()
	await svc.close()
	removeTempDir(dir)
})

describe('licence kind service from the command line', () => {
	it('add says what the check sends; the key is read from standard input and never shown again', async () => {
		expect(await run('add', nzx(asService))).toBe(0)
		expect(out.join('\n')).toMatch(/Licence check: contacts license\.example\.com/)
		expect(out.join('\n')).toMatch(/It sends: your licence key and a code for this computer\./)
		out.length = 0
		stdin = `${svc.goodKey}\n`
		expect(await runExtension(['license', ID, '--key-stdin'], { ...deps(), isTTY: false })).toBe(0)
		expect(out.join('\n')).toMatch(
			/Licence accepted: Example Customer, checked with license\.example\.com\./,
		)
		expect(out.join('\n')).not.toContain(svc.goodKey)
		expect(host.view(ID).needs).toEqual(['notice'])
	})
	it('a key as an argument is not a thing; a wrong key is refused in words and exits 1', async () => {
		await run('add', nzx(asService))
		expect(await runExtension(['license', ID], { ...deps(), isTTY: false })).toBe(64)
		stdin = 'WRONG'
		expect(await runExtension(['license', ID, '--key-stdin'], deps())).toBe(1)
		expect(err.concat(out).join('\n')).toMatch(/That licence key was not found\./)
	})
	it('--refresh checks now and --release frees this computer', async () => {
		await run('add', nzx(asService))
		stdin = svc.goodKey
		await runExtension(['license', ID, '--key-stdin'], deps())
		out.length = 0
		expect(await run('license', ID, '--refresh')).toBe(0)
		expect(out.join('\n')).toMatch(/Checked with license\.example\.com\./)
		out.length = 0
		expect(await run('license', ID, '--release')).toBe(0)
		expect(out.join('\n')).toMatch(/Released/)
		expect(host.view(ID).needs).toContain('license')
	})
	it('status shows the service, when it was last checked, and the offline grace', async () => {
		await run('add', nzx(asService))
		stdin = svc.goodKey
		await runExtension(['license', ID, '--key-stdin'], deps())
		out.length = 0
		await run('status', ID)
		expect(out.join('\n')).toMatch(/Licence service: license\.example\.com, last checked 20/)
	})
})

describe('start at sign-in from the command line', () => {
	async function readyToEnable(): Promise<void> {
		await run('add', nzx(withBackground))
	}
	it('enable shows the switch with its words and default, records the answer, starts the runner and registers the entry', async () => {
		await readyToEnable()
		answers = ['y', 'y'] // acknowledge the notice, then leave the switch at its default
		expect(await run('enable', ID)).toBe(0)
		const text = out.join('\n')
		expect(text).toMatch(/Starts when you sign in and keeps running when Namzu is closed\./)
		expect(text).toMatch(/While Namzu is closed it shows: Recording is running\./)
		expect(text).toMatch(/Start when I sign in\? \[Y\/n\]/)
		expect(text).toMatch(/runs in the background now and starts again when you sign in/)
		expect(ensured).toBe(1)
		expect(reg.entry?.launcher).toMatch(/start\.sh$/)
	})
	it('saying no at the switch enables the extension without any sign-in entry', async () => {
		await readyToEnable()
		answers = ['y', 'n']
		expect(await run('enable', ID)).toBe(0)
		expect(reg.entry).toBeUndefined()
		expect(ensured).toBe(0)
		expect(host.view(ID).background?.enabled).toBe(false)
	})
	it('background on, off and status; turning it off removes the entry', async () => {
		await readyToEnable()
		answers = ['y', 'n']
		await run('enable', ID)
		out.length = 0
		expect(await run('background', ID, 'on')).toBe(0)
		expect(out.join('\n')).toMatch(/starts when you sign in and keeps running when Namzu is closed/)
		expect(reg.entry).toBeDefined()
		out.length = 0
		await run('background', ID, 'status')
		expect(out.join('\n')).toMatch(/Start at sign-in: on/)
		expect(out.join('\n')).toMatch(/While Namzu is closed it shows: Recording is running\./)
		expect(await run('background', ID, 'off')).toBe(0)
		expect(reg.entry).toBeUndefined()
		expect(await run('background', ID, 'maybe')).toBe(64)
	})
	it('an extension without the block says so', async () => {
		await run(
			'add',
			nzx((m) => {
				m.licensing = { kind: 'none' }
			}),
		)
		expect(await run('background', ID, 'status')).toBe(0)
		expect(out.join('\n')).toMatch(/does not start when you sign in/)
		expect(await run('background', ID, 'on')).toBe(1)
	})
	it('daemon start, stop and status go to the runner; run reports one that is already there', async () => {
		expect(await run('daemon', 'start')).toBe(0)
		expect(ensured).toBe(1)
		expect(await run('daemon', 'stop')).toBe(0)
		expect(stopped).toBe(1)
		out.length = 0
		expect(await run('daemon', 'status')).toBe(0)
		expect(out.join('\n')).toMatch(/The runner is not running\./)
		out.length = 0
		expect(await run('daemon', 'run')).toBe(0)
		expect(out.join('\n')).toMatch(/already running/)
		expect(await run('daemon', 'bogus')).toBe(64)
	})
	it('daemon start mends an entry an earlier version left before it asks it to start the runner', async () => {
		await readyToEnable()
		answers = ['y', 'y']
		await run('enable', ID)
		// What an earlier version registered: on Windows, the console file itself.
		reg.entry = { launcher: join(dir, 'old', 'start.cmd'), kind: 'xdg' }
		expect(await run('daemon', 'start')).toBe(0)
		expect(entryAtEnsure).toMatch(/_runner[\\/]start\.sh$/)
	})
	it('signin remove --all removes the entry and nothing else', async () => {
		await readyToEnable()
		answers = ['y', 'y']
		await run('enable', ID)
		expect(reg.entry).toBeDefined()
		expect(await run('signin', 'remove', '--all')).toBe(0)
		expect(signinRemoved).toBe(1)
		expect(reg.entry).toBeUndefined()
		expect(existsSync(join(dir, 'home', 'extensions', ID, 'state.json'))).toBe(true)
		expect(await run('signin', 'remove')).toBe(64)
	})
	it('disable removes the entry through the same path', async () => {
		await readyToEnable()
		answers = ['y', 'y']
		await run('enable', ID)
		await run('disable', ID)
		expect(reg.entry).toBeUndefined()
		await settle()
	})
})
