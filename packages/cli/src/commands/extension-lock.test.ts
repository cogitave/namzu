import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { recordingSpawn } from '../integrations/extensions/__fixtures__/fake-child.js'
import {
	buildPackage,
	makeKey,
	makeLicense,
	sampleManifest,
	trustedFrom,
} from '../integrations/extensions/__fixtures__/package-builder.js'
import { ExtensionHost } from '../integrations/extensions/host.js'
import { EXTENSIONS_METHODS, createExtensionsRpc } from './desktop-extensions.js'
import { type ExtensionDeps, parseExtensionArgs, runExtension } from './extension.js'

/** The administrator lock from the command line and from Desktop's methods. */
const pub = makeKey('pub-cmd')
const lic = makeKey('lic-cmd')
const ID = 'com.example.stub-recorder'
const PW = 'correct horse battery'

let dir: string
let host: ExtensionHost
let out: string[]
let err: string[]
let stdin = ''
const rec = recordingSpawn()
const hosts: ExtensionHost[] = []

const deps = (over: Partial<ExtensionDeps> = {}): ExtensionDeps => ({
	host,
	out: (t) => out.push(t),
	err: (t) => err.push(t),
	isTTY: false,
	ask: async () => '',
	readStdin: async () => stdin,
	...over,
})
const run = (...a: string[]) => runExtension(a, deps())
const managed = (m: Record<string, any>): void => {
	m.management = {
		lock: 'administrator-password',
		purpose: { en: 'Your organisation keeps this on so its records stay complete.' },
	}
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'ext-lock-cmd-'))
	out = []
	err = []
	stdin = ''
	host = new ExtensionHost({
		home: join(dir, 'home'),
		hostVersion: '53.5.0',
		kind: 'cli',
		env: {},
		locale: () => 'en',
		compiledKeys: [trustedFrom(pub)],
		spawn: rec.spawn,
	})
	hosts.push(host)
	const f = join(dir, 'a.nzx')
	writeFileSync(
		f,
		buildPackage({
			manifest: sampleManifest(managed as never, { keyId: pub.id }),
			publisherKey: pub,
			licenseKey: lic,
		}),
	)
	host.add(await import('node:fs').then((fs) => fs.readFileSync(f)))
	host.setLicense(ID, makeLicense(lic))
	const n = host.notice(ID)
	host.acknowledge(ID, { noticeVersion: n.noticeVersion, scopeHash: n.scopeHash, locale: n.locale })
})
afterEach(async () => {
	for (const h of hosts.splice(0)) await h.stopSupervision()
	removeTempDir(dir)
})

describe('namzu extension: the administrator password', () => {
	it('knows the flag, and never takes the password as an argument', () => {
		expect(
			parseExtensionArgs(['disable', 'x', '--admin-password-stdin']).flags.has(
				'--admin-password-stdin',
			),
		).toBe(true)
		expect(parseExtensionArgs(['disable', 'x', '--admin-password', 'abc']).error).toMatch(
			/unknown option/,
		)
	})
	it('enable needs it the first time, and says how to give it', async () => {
		expect(await run('enable', ID)).toBe(1)
		expect(err.join('\n')).toMatch(/Set an administrator password/)
		expect(err.join('\n')).toMatch(/--admin-password-stdin/)
		expect(host.view(ID).enabled).toBe(false)
		stdin = `${PW}\n`
		expect(await run('enable', ID, '--admin-password-stdin')).toBe(0)
		expect(host.view(ID)).toMatchObject({ enabled: true, management: { locked: true } })
	})
	it('disable, remove and the rest are refused without it and done with it', async () => {
		stdin = `${PW}\n`
		await run('enable', ID, '--admin-password-stdin')
		err.length = 0
		expect(await run('disable', ID)).toBe(1)
		expect(err.join('\n')).toMatch(/locked by your administrator/)
		expect(await run('remove', ID, '--delete-data')).toBe(1)
		expect(await run('revoke', ID, 'os.screenChange')).toBe(1)
		expect(await run('background', ID, 'off')).not.toBe(2)
		stdin = 'a wrong password\n'
		expect(await run('disable', ID, '--admin-password-stdin')).toBe(1)
		expect(err.join('\n')).toMatch(/not the administrator password/)
		expect(host.view(ID).enabled).toBe(true)
		// a wrong try makes the next wait: the right one is not looked at yet
		stdin = `${PW}\n`
		expect(await run('disable', ID, '--admin-password-stdin')).toBe(1)
		expect(err.join('\n')).toMatch(/Wait \d+ seconds/)
	})
	it('--json refusals carry the code and the hint', async () => {
		stdin = `${PW}\n`
		await run('enable', ID, '--admin-password-stdin')
		out.length = 0
		expect(await run('disable', ID, '--json')).toBe(1)
		const j = JSON.parse(out.join(''))
		expect(j).toMatchObject({ ok: false, code: 'admin-locked' })
		expect(j.message).toContain('--admin-password-stdin')
	})
	it('the first line is the password and the rest is the key, so one pipe carries both', async () => {
		stdin = `${PW}\n`
		await run('enable', ID, '--admin-password-stdin')
		stdin = `${PW}\n${makeLicense(lic)}`
		expect(await run('license', ID, '--admin-password-stdin')).toBe(0)
		expect(out.join('\n')).toMatch(/Licence accepted/)
	})
	it('unlock takes the lock off with the password', async () => {
		stdin = `${PW}\n`
		await run('enable', ID, '--admin-password-stdin')
		expect(await run('unlock', ID)).toBe(1)
		expect(await run('unlock', ID, '--admin-password-stdin')).toBe(0)
		expect(host.view(ID).management?.locked).toBe(false)
		expect(await run('disable', ID)).toBe(0)
	})
	it('list and status say it is locked, with the reason', async () => {
		stdin = `${PW}\n`
		await run('enable', ID, '--admin-password-stdin')
		out.length = 0
		await run('list')
		expect(out.join('\n')).toContain('LOCKED BY ADMINISTRATOR')
		out.length = 0
		await run('status', ID)
		expect(out.join('\n')).toContain(
			'Locked by your administrator: Your organisation keeps this on',
		)
	})
})

describe("Desktop's methods", () => {
	const rpc = () => createExtensionsRpc(() => host)
	it('has an unlock method, and every guarded method takes the password as `admin`', async () => {
		expect(EXTENSIONS_METHODS).toContain('namzu/extensions/unlock')
		const r = rpc()
		const refused = (await r['namzu/extensions/enable']?.({ id: ID })) as {
			error: { code: string }
		}
		expect(refused.error.code).toBe('admin-needed')
		const on = (await r['namzu/extensions/enable']?.({ id: ID, admin: PW })) as {
			view: { management: { locked: boolean } }
		}
		expect(on.view.management.locked).toBe(true)
		const off = (await r['namzu/extensions/disable']?.({ id: ID })) as { error: { code: string } }
		expect(off.error.code).toBe('admin-locked')
		const rm = (await r['namzu/extensions/remove']?.({ id: ID })) as { error: { code: string } }
		expect(rm.error.code).toBe('admin-locked')
		const key = (await r['namzu/extensions/settings/set']?.({
			id: ID,
			key: 'modelKey',
			value: 'abcdefgh',
			provider: 'p',
		})) as { error: { code: string } }
		expect(key.error.code).toBe('admin-locked')
		const bad = (await r['namzu/extensions/unlock']?.({ id: ID, admin: 'not the password' })) as {
			error: { code: string }
		}
		expect(bad.error.code).toBe('admin-wrong')
	})
})
