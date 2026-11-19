import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { recordingSpawn } from '../integrations/extensions/__fixtures__/fake-child.js'
import { FakeLicenseService } from '../integrations/extensions/__fixtures__/fake-license-service.js'
import {
	buildPackage,
	makeKey,
	sampleManifest,
	trustedFrom,
} from '../integrations/extensions/__fixtures__/package-builder.js'
import { ExtensionHost } from '../integrations/extensions/host.js'
import { EXTENSIONS_METHODS, createExtensionsRpc } from './desktop-extensions.js'

const pub = makeKey('pub-rpc2')
const ID = 'com.example.stub-recorder'
type Mut = (m: Record<string, any>) => void

let dir: string
let host: ExtensionHost
let rpc: ReturnType<typeof createExtensionsRpc>
let svc: FakeLicenseService

const call = (name: string, params: Record<string, unknown> = {}) =>
	(rpc[`namzu/extensions/${name}`] as (p: Record<string, unknown>) => Promise<any>)(params)

const withPages: Mut = (m) => {
	m.licensing = { kind: 'none' }
	m.contributes.endpoint.protocol = 'namzu-ext-query/2'
	m.contributes.endpoint.actions = [
		{
			id: 'pick-day',
			paramsSchema: 'schemas/params.json',
			schema: 'schemas/result.json',
			maxBytes: 512,
			purpose: { en: 'Choose which day the page shows' },
			changes: 'view',
		},
		{
			id: 'clear-today',
			paramsSchema: 'schemas/params.json',
			schema: 'schemas/result.json',
			maxBytes: 512,
			purpose: { en: 'Delete today rows' },
			changes: 'own-data-delete',
			needsGesture: true,
		},
	]
	m.ui = {
		icon: 'ui/icon.svg',
		accent: '#2F6F4F',
		pages: [
			{
				id: 'today',
				title: { en: "Today's record" },
				slot: 'settings',
				entry: 'ui/pages/today.html',
				minHeight: 360,
				bridge: {
					allow: ['query:counts', 'action:pick-day', 'action:clear-today'],
					host: ['theme', 'state'],
				},
			},
		],
		chips: [],
	}
}
const pkg = (mut: Mut) =>
	buildPackage({
		manifest: sampleManifest(mut as never, { keyId: pub.id }),
		publisherKey: pub,
		licenseKey: makeKey('lic-rpc2'),
		files: {
			'ui/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
			'ui/pages/today.html': '<!doctype html><title>Today</title><script src="today.js"></script>',
			'ui/pages/today.js': 'document.title = "x"',
			'ui/pages/today.css': 'body{color:red}',
			'schemas/params.json': JSON.stringify({
				type: 'object',
				required: ['day'],
				properties: { day: { type: 'string' } },
				additionalProperties: false,
			}),
			'schemas/result.json': JSON.stringify({
				type: 'object',
				required: ['ok'],
				properties: { ok: { type: 'boolean' } },
				additionalProperties: false,
			}),
		},
	})

let server: Server | undefined
const seen: unknown[] = []
/** A process that speaks `namzu-ext-query/2`: a length-prefixed JSON request, a length-prefixed answer. */
function listen(reply: (req: any) => unknown): Promise<string> {
	const addr = join(dir, 'q.sock')
	return new Promise((resolve) => {
		server = createServer((s) => {
			let buf = Buffer.alloc(0)
			s.on('data', (c) => {
				buf = Buffer.concat([buf, c])
				if (buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return
				const req = JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString())
				seen.push(req)
				const body = Buffer.from(JSON.stringify(reply(req)))
				const head = Buffer.alloc(4)
				head.writeUInt32BE(body.length)
				s.end(Buffer.concat([head, body]))
			})
		})
		server.listen(addr, () => resolve(addr))
	})
}
const running = (addr: string) => {
	mkdirSync(join(dir, 'home', 'extensions', ID, 'run'), { recursive: true })
	writeFileSync(
		join(dir, 'home', 'extensions', ID, 'run', 'state.json'),
		JSON.stringify({
			hostPid: process.pid,
			token: 't',
			addr,
			kind: 'cli',
			snapshot: { state: 'collecting' },
		}),
	)
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'ext-rpc2-'))
	seen.length = 0
	svc = new FakeLicenseService(ID)
	await svc.listen()
	host = new ExtensionHost({
		home: join(dir, 'home'),
		hostVersion: '53.5.0',
		kind: 'desktop',
		oneShot: true,
		env: {},
		locale: () => 'en',
		compiledKeys: [trustedFrom(pub)],
		spawn: recordingSpawn().spawn,
	})
	rpc = createExtensionsRpc(() => host)
})
afterEach(async () => {
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
	server = undefined
	await host.stopSupervision()
	await svc.close()
	removeTempDir(dir)
})

describe('namzu/extensions/ui, action, background and runner', () => {
	it('are part of the methods the app probes for', () => {
		for (const m of ['ui', 'action', 'background/get', 'background/set', 'runner'])
			expect(EXTENSIONS_METHODS).toContain(`namzu/extensions/${m}`)
	})

	it("ui answers the page list in the person's words, the signed hash of every file a page may load, and no file outside ui/", async () => {
		const f = join(dir, 'p.nzx')
		writeFileSync(f, pkg(withPages))
		await call('add', { path: f })
		const { ui } = await call('ui', { id: ID })
		expect(ui.accent).toBe('#2F6F4F')
		expect(ui.pages).toEqual([
			{
				id: 'today',
				title: "Today's record",
				slot: 'settings',
				entry: 'ui/pages/today.html',
				minHeight: 360,
				usesNetwork: false,
				bridge: {
					allow: ['query:counts', 'action:pick-day', 'action:clear-today'],
					host: ['theme', 'state'],
				},
				hosts: [],
			},
		])
		expect(ui.files.map((x: { path: string }) => x.path)).toEqual([
			'ui/icon.svg',
			'ui/pages/today.css',
			'ui/pages/today.html',
			'ui/pages/today.js',
		])
		expect(ui.files[0].sha256).toMatch(/^[0-9a-f]{64}$/)
		expect(ui.dir).toBe(join(dir, 'home', 'extensions', ID, 'versions', '1.0.0'))
		expect(ui.methods).toEqual(
			expect.arrayContaining([
				{ method: 'query:counts', maxBytes: 4096 },
				{ method: 'action:pick-day', maxBytes: 512 },
			]),
		)
		expect(ui.actions).toEqual([
			{ id: 'pick-day', needsGesture: false },
			{ id: 'clear-today', needsGesture: true },
		])
	})
	it('an extension with no ui answers null', async () => {
		const f = join(dir, 'p.nzx')
		writeFileSync(
			f,
			pkg((m) => {
				m.licensing = { kind: 'none' }
			}),
		)
		await call('add', { path: f })
		expect((await call('ui', { id: ID })).ui).toBeNull()
	})

	describe('action: only what the manifest declares, checked both ways', () => {
		async function setup(reply: (req: any) => unknown) {
			const f = join(dir, 'p.nzx')
			writeFileSync(f, pkg(withPages))
			await call('add', { path: f })
			running(await listen(reply))
		}
		it('a declared action reaches the process with its params and answers', async () => {
			await setup(() => ({ v: 1, ok: true, result: { ok: true } }))
			expect(
				await call('action', { id: ID, action: 'pick-day', params: { day: 'today' } }),
			).toEqual({ ok: true })
			expect(seen[0]).toMatchObject({ v: 1, action: 'pick-day', params: { day: 'today' } })
		})
		it('an action that is not declared never reaches the process and is audited', async () => {
			await setup(() => ({ v: 1, ok: true, result: { ok: true } }))
			expect(await call('action', { id: ID, action: 'format-disk', params: {} })).toMatchObject({
				error: { code: 'R1' },
			})
			expect(seen).toHaveLength(0)
			expect(
				(await call('audit', { id: ID })).lines.map((l: { detail?: string }) => l.detail),
			).toContain('R1 action format-disk')
		})
		it('params that do not fit are refused before they reach the process', async () => {
			await setup(() => ({ v: 1, ok: true, result: { ok: true } }))
			expect(
				await call('action', { id: ID, action: 'pick-day', params: { day: 3 } }),
			).toMatchObject({
				error: { code: 'bad-params' },
			})
			expect(
				await call('action', { id: ID, action: 'pick-day', params: { day: 'x', extra: 1 } }),
			).toMatchObject({
				error: { code: 'bad-params' },
			})
			expect(seen).toHaveLength(0)
		})
		it('an action that needs a gesture is forwarded only with a real click or key', async () => {
			await setup(() => ({ v: 1, ok: true, result: { ok: true } }))
			expect(
				await call('action', { id: ID, action: 'clear-today', params: { day: 'x' } }),
			).toMatchObject({
				error: { code: 'gesture-required' },
			})
			expect(seen).toHaveLength(0)
			expect(
				await call('action', {
					id: ID,
					action: 'clear-today',
					params: { day: 'x' },
					activation: true,
				}),
			).toEqual({ ok: true })
		})
		it('an answer that does not fit its schema, or is too large, is dropped', async () => {
			await setup(() => ({ v: 1, ok: true, result: { ok: 'yes' } }))
			expect(
				await call('action', { id: ID, action: 'pick-day', params: { day: 'x' } }),
			).toMatchObject({
				error: { code: 'R2' },
			})
			await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
			mkdirSync(dir, { recursive: true })
			running(await listen(() => ({ v: 1, ok: true, result: { ok: true, pad: 'x'.repeat(600) } })))
			expect(
				await call('action', { id: ID, action: 'pick-day', params: { day: 'x' } }),
			).toMatchObject({
				error: { code: expect.stringMatching(/R2|query-too-big/) },
			})
		})
		it('a stopped extension answers not-running, so the page shows its own empty state', async () => {
			const f = join(dir, 'p.nzx')
			writeFileSync(f, pkg(withPages))
			await call('add', { path: f })
			expect(
				await call('action', { id: ID, action: 'pick-day', params: { day: 'x' } }),
			).toMatchObject({
				error: { code: 'not-running' },
			})
		})
	})

	it('background/get and set, and the switch is refused before the notice', async () => {
		const f = join(dir, 'p.nzx')
		writeFileSync(
			f,
			pkg((m) => {
				m.licensing = { kind: 'none' }
				m.permissions.push({
					id: 'background.signin',
					level: 'high',
					optional: false,
					personalData: false,
					summary: { en: 'Starts when you sign in.' },
					purposes: [{ id: 'whole-day', text: { en: 'So the record covers the day.' } }],
				})
				m.background = {
					runAt: 'signin',
					permission: 'background.signin',
					defaultOn: true,
					indicator: { kind: 'tray', label: { en: 'Recording is running.' } },
				}
			}),
		)
		await call('add', { path: f })
		expect((await call('background/get', { id: ID })).background).toMatchObject({
			indicator: 'tray',
			enabled: false,
		})
		expect(await call('background/set', { id: ID, on: true })).toMatchObject({
			error: { code: 'needs-notice' },
		})
		const n = await call('notice', { id: ID })
		await call('acknowledge', {
			id: ID,
			noticeVersion: n.noticeVersion,
			scopeHash: n.scopeHash,
			startAtSignin: false,
		})
		expect((await call('background/get', { id: ID })).background.enabled).toBe(false)
		expect((await call('background/set', { id: ID, on: true })).view.background.enabled).toBe(true)
	})

	it('runner is read-only: it reports, it never starts or stops anything', async () => {
		const r = await call('runner')
		expect(typeof r.running).toBe('boolean')
		expect(Object.keys(r).sort()).toEqual(['pid', 'running', 'signin', 'since'])
	})
})
