import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { recordingSpawn, settle } from '../integrations/extensions/__fixtures__/fake-child.js'
import {
	buildPackage,
	makeKey,
	makeLicense,
	sampleManifest,
	trustedFrom,
} from '../integrations/extensions/__fixtures__/package-builder.js'
import { ExtensionHost, type StateEvent } from '../integrations/extensions/host.js'
import { EXTENSIONS_METHODS, createExtensionsRpc } from './desktop-extensions.js'

const pub = makeKey('pub-rpc')
const lic = makeKey('lic-rpc')
const ID = 'com.example.stub-recorder'
let dir: string
let host: ExtensionHost
let rpc: ReturnType<typeof createExtensionsRpc>
const events: StateEvent[] = []

const call = (name: string, params: Record<string, unknown> = {}) =>
	(rpc[`namzu/extensions/${name}`] as (p: Record<string, unknown>) => Promise<any>)(params)
const file = (name: string, mut?: (m: any) => void, version = '1.0.0') => {
	const f = join(dir, name)
	writeFileSync(
		f,
		buildPackage({
			manifest: sampleManifest(mut as never, { version, keyId: pub.id }),
			publisherKey: pub,
			licenseKey: lic,
		}),
	)
	return f
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ext-rpc-'))
	events.length = 0
	host = new ExtensionHost({
		home: join(dir, 'home'),
		hostVersion: '53.5.0',
		kind: 'desktop',
		env: {},
		compiledKeys: [trustedFrom(pub)],
		spawn: recordingSpawn().spawn,
		onState: (e) => events.push(e),
	})
	rpc = createExtensionsRpc(() => host)
})
afterEach(async () => {
	await host.stopSupervision()
	removeTempDir(dir)
})

describe('namzu/extensions/*', () => {
	it('offers exactly the methods the app probes for', () => {
		expect(Object.keys(rpc).sort()).toEqual([...EXTENSIONS_METHODS].sort())
	})

	it('E21: the whole flow through the methods, in the person’s language', async () => {
		expect((await call('list')).extensions).toEqual([])
		const added = await call('add', { path: file('a.nzx'), locale: 'tr' })
		expect(added.view).toMatchObject({
			id: ID,
			state: 'added',
			name: 'Deneme Kaydedici',
			chip: 'Eklendi',
		})
		expect(added.disclosure.permissions[0].purposes[0]).toBe(
			'Her programda geçen süreyi saymak için.',
		)
		const lic1 = await call('license', { id: ID, token: makeLicense(lic) })
		expect(lic1).toMatchObject({ ok: true, customer: 'Test Company', seats: 25 })
		const n = await call('notice', { id: ID, locale: 'tr' })
		expect(n).toMatchObject({ noticeVersion: '1.0', locale: 'tr', record: null })
		expect(n.text).toContain('Notice in tr')
		// A page that echoes a different notice version or scope hash is refused with a typed error.
		expect(
			await call('acknowledge', { id: ID, noticeVersion: '9.9', scopeHash: n.scopeHash }),
		).toEqual({ error: { code: 'stale-notice', check: 'echo', message: expect.any(String) } })
		expect(
			await call('acknowledge', {
				id: ID,
				noticeVersion: n.noticeVersion,
				scopeHash: '0'.repeat(64),
			}),
		).toMatchObject({ error: { code: 'stale-notice' } })
		expect(await call('enable', { id: ID })).toMatchObject({ error: { code: 'needs-notice' } })
		expect(
			await call('acknowledge', {
				id: ID,
				noticeVersion: n.noticeVersion,
				scopeHash: n.scopeHash,
				locale: 'tr',
			}),
		).toEqual({ ok: true })
		expect(host.consent.read(ID)?.via).toBe('desktop')
		const en = await call('enable', { id: ID })
		expect(en.view.enabled).toBe(true)
		await settle()
		expect(events.at(-1)).toMatchObject({
			id: ID,
			state: 'running',
			indicator: { level: 'ok', label: 'Deneme Kaydedici öndeki programı sayıyor.' },
		})
		expect((await call('audit', { id: ID, limit: 5 })).lines.length).toBeGreaterThan(0)
		await call('disable', { id: ID })
		expect((await call('list')).extensions[0].state).toBe('ready')
		expect(await call('remove', { id: ID, deleteData: true })).toEqual({ ok: true })
	})

	it('a refused package answers a typed error and writes nothing', async () => {
		const f = join(dir, 'bad.nzx')
		writeFileSync(
			f,
			buildPackage({
				manifest: sampleManifest(undefined, { keyId: pub.id }),
				publisherKey: pub,
				licenseKey: lic,
				tamper: 'bin/stub.cjs',
			}),
		)
		expect(await call('add', { path: f })).toMatchObject({
			error: { code: 'tampered', check: 'file-hash' },
		})
		expect((await call('list')).extensions).toEqual([])
		const notPkg = join(dir, 'x.nzx')
		writeFileSync(notPkg, 'not a zip at all, nothing like one in any way')
		expect(await call('add', { path: notPkg })).toMatchObject({ error: { code: 'bad-package' } })
	})

	it('the licence is given as text or as a file, not both and not neither', async () => {
		await call('add', { path: file('a.nzx') })
		await expect(call('license', { id: ID })).rejects.toThrow(/text or as a file/)
		await expect(call('license', { id: ID, token: 'x', path: 'y' })).rejects.toThrow(/not both/)
		const lf = join(dir, 'k.nzlic')
		writeFileSync(lf, makeLicense(lic))
		expect(await call('license', { id: ID, path: lf })).toMatchObject({ ok: true })
	})

	it('settings: a secret is never returned, a setting that is not declared is refused (R7), a query that is not declared is refused (R1)', async () => {
		await call('add', { path: file('a.nzx') })
		const set = await call('settings/set', {
			id: ID,
			key: 'modelKey',
			provider: 'openai',
			value: 'sk-abcdefgh-1234',
		})
		expect(set).toEqual({ hasValue: true, masked: '********1234' })
		const got = await call('settings/get', { id: ID, key: 'modelKey', provider: 'openai' })
		expect(JSON.stringify(got)).not.toContain('abcdefgh')
		expect(await call('settings/get', { id: ID, key: 'other' })).toMatchObject({
			error: { code: 'R7' },
		})
		expect(await call('query', { id: ID, query: 'dump' })).toMatchObject({ error: { code: 'R1' } })
	})

	it('a staged update is reported with its reasons, and acknowledging it swaps', async () => {
		await call('add', { path: file('a.nzx') })
		await call('license', { id: ID, token: makeLicense(lic) })
		const n = await call('notice', { id: ID })
		await call('acknowledge', { id: ID, noticeVersion: n.noticeVersion, scopeHash: n.scopeHash })
		const up = await call('add', {
			path: file(
				'b.nzx',
				(m) => {
					m.legal.noticeVersion = '1.1'
				},
				'1.1.0',
			),
		})
		expect(up.update.waiting).toBe(true)
		expect(up.view.updateWaiting.version).toBe('1.1.0')
		const staged = await call('notice', { id: ID, staged: true })
		expect(staged.diff.join(' ')).toMatch(/notice version/)
		await call('acknowledge', {
			id: ID,
			noticeVersion: staged.noticeVersion,
			scopeHash: staged.scopeHash,
			staged: true,
		})
		expect((await call('list')).extensions[0].version).toBe('1.1.0')
	})

	it('parameters are checked: ids and paths must be text', async () => {
		await expect(call('enable', {})).rejects.toThrow(/id must be text/)
		await expect(call('add', { path: 5 })).rejects.toThrow(/path must be text/)
	})
})
