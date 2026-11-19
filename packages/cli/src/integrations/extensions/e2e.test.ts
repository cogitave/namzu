import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import { ExtensionHost, type StateEvent } from './host.js'
import { spawnChild } from './spawn.js'

/**
 * Real processes: the stub extension is spawned the way a person's host spawns it, talks the stdio
 * protocol and serves the query socket. Nothing here waits on the clock: each step awaits an event (a
 * state notification, a process exit) and Vitest's own per-test timeout catches a real hang.
 */

const linux = process.platform === 'linux'
const pub = makeKey('pub-e2e')
const lic = makeKey('lic-e2e')
const ID = 'com.example.stub-recorder'

let home: string
let host: ExtensionHost
const events: StateEvent[] = []
const waiters: { pred: (e: StateEvent) => boolean; done: () => void }[] = []

function waitFor(pred: (e: StateEvent) => boolean): Promise<void> {
	if (events.some(pred)) return Promise.resolve()
	return new Promise((resolve) => waiters.push({ pred, done: resolve }))
}

function scenario(sc: unknown): void {
	mkdirSync(join(home, 'extensions', ID, 'data'), { recursive: true })
	writeFileSync(join(home, 'extensions', ID, 'data', 'scenario.json'), JSON.stringify(sc))
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'ext-e2e-'))
	events.length = 0
	waiters.length = 0
	host = new ExtensionHost({
		home,
		hostVersion: '53.5.0',
		kind: 'cli',
		env: { LANG: 'C.UTF-8', NAMZU_HOME: '/never', OPENAI_API_KEY: 'sk-never' },
		locale: () => 'en',
		compiledKeys: [trustedFrom(pub)],
		onState: (e) => {
			events.push(e)
			for (const w of [...waiters]) {
				if (w.pred(e)) {
					waiters.splice(waiters.indexOf(w), 1)
					w.done()
				}
			}
		},
	})
	host.add(
		buildPackage({
			manifest: sampleManifest(undefined, { keyId: pub.id }),
			publisherKey: pub,
			licenseKey: lic,
		}),
	)
	host.setLicense(ID, makeLicense(lic))
	const n = host.notice(ID)
	host.acknowledge(ID, { noticeVersion: n.noticeVersion, scopeHash: n.scopeHash, locale: n.locale })
})
afterEach(async () => {
	await host.stopSupervision()
	removeTempDir(home)
})

describe.skipIf(!linux)('real stub extension', () => {
	it('E8, E9, E10: starts with a clean environment, the indicator arrives, the queries answer', async () => {
		scenario({})
		host.setKey(ID, 'openai', 'sk-model-key-5678')
		host.enable(ID)
		await waitFor((e) => e.state === 'running')
		expect(
			events.some(
				(e) => e.state === 'starting' && e.indicator?.label === 'Starting: Stub Recorder',
			),
		).toBe(true)
		expect(events.at(-1)?.indicator).toEqual({
			level: 'ok',
			label: 'Stub Recorder is counting which program is in front.',
		})
		const data = join(home, 'extensions', ID, 'data')
		const env = JSON.parse(readFileSync(join(data, 'env.json'), 'utf8')) as Record<string, string>
		for (const k of Object.keys(env)) {
			if (k.startsWith('NAMZU_')) expect(k.startsWith('NAMZU_EXT_')).toBe(true)
			expect(k).not.toMatch(/API_KEY/)
		}
		expect(JSON.stringify(env)).not.toContain('sk-')
		// And read the live process's own environment from the system, not from what it says about itself.
		const pid = readFileSync(join(data, 'pid.txt'), 'utf8')
		const live = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
		expect(live.some((l) => /^NAMZU_(?!EXT_)/.test(l))).toBe(false)
		expect(live.some((l) => /API_KEY|sk-never|sk-model/.test(l))).toBe(false)
		expect(await host.query(ID, 'status')).toEqual({ signals: { 'os.foregroundWindow': 'ok' } })
		expect(await host.query(ID, 'counts')).toEqual({ kind: 'stub.app.minute', count: 3 })
		const rows = (await host.query(ID, 'rows')) as { columns: string[] }
		const declared = ['minute', 'exe', 'seconds']
		expect(rows.columns).toEqual(declared)
		expect(host.status(ID).process?.state).toBe('collecting')
		expect(host.status(ID).signals).toEqual({ 'os.foregroundWindow': 'ok' })
	})

	it('E11: answers the manifest did not declare are refused, audited, and three in a row mark it degraded', async () => {
		scenario({
			answers: {
				counts: { kind: 'stub.screen.minute', count: 1 },
				rows: { kind: 'stub.app.minute', columns: ['minute', 'title'], rows: [] },
				status: { signals: {}, extra: 1 },
			},
		})
		host.enable(ID)
		await waitFor((e) => e.state === 'running')
		await expect(host.query(ID, 'counts')).rejects.toMatchObject({ code: 'R3' })
		await expect(host.query(ID, 'rows')).rejects.toMatchObject({ code: 'R3' })
		await expect(host.query(ID, 'status')).rejects.toMatchObject({ code: 'R2' })
		const lines = host
			.audit(ID, 50)
			.filter((l) => l.event === 'query-refused')
			.map((l) => l.detail)
		expect(lines).toEqual(['R3 counts', 'R3 rows', 'R2 status'])
		expect(host.view(ID).indicator).toEqual({ level: 'warn', label: 'Stub Recorder has gaps.' })
		// A good answer afterwards clears the count.
		scenario({})
		expect(await host.query(ID, 'counts')).toEqual({ kind: 'stub.app.minute', count: 3 })
		expect(host.view(ID).indicator?.level).toBe('ok')
	})

	it('E11: an oversize answer and a wrongly typed one are dropped', async () => {
		scenario({
			answers: {
				rows: { kind: 'stub.app.minute', columns: ['minute'], rows: [['x'.repeat(6000)]] },
				counts: { kind: 'stub.app.minute', count: 'three' },
			},
		})
		host.enable(ID)
		await waitFor((e) => e.state === 'running')
		await expect(host.query(ID, 'rows')).rejects.toMatchObject({
			code: expect.stringMatching(/query-too-big|R2/),
		})
		await expect(host.query(ID, 'counts')).rejects.toMatchObject({ code: 'R2' })
	})

	it('E11: a process that names an undeclared permission in hello is stopped and shown failed', async () => {
		scenario({ uses: ['os.foregroundWindow', 'os.clipboard'] })
		host.enable(ID)
		await waitFor((e) => e.state === 'failed')
		expect(host.view(ID).why).toBe('undeclared-permission')
		expect(host.view(ID).indicator?.label).toBe(
			'Stub Recorder stopped after repeated failures. Nothing is being recorded.',
		)
	})

	it('E16: the process exits by itself when its stdin closes, and the next host kills a leftover', async () => {
		scenario({})
		const data = join(home, 'extensions', ID, 'data')
		const bin = join(home, 'extensions', ID, 'versions', '1.0.0', 'bin', 'stub.cjs')
		const env = { NAMZU_EXT_DATA: data, NAMZU_EXT_QUERY_ADDR: '', PATH: process.env.PATH ?? '' }
		const child = spawnChild({
			exe: bin,
			args: [],
			cwd: join(home, 'extensions', ID, 'versions', '1.0.0'),
			env,
		})
		const exited = new Promise<number | null>((resolve) => child.onExit((code) => resolve(code)))
		const said = new Promise<void>((resolve) =>
			child.onLine((l) => l.includes('"hello"') && resolve()),
		)
		await said
		child.endInput()
		expect(await exited).toBe(0)
		expect(existsSync(join(data, 'stdin-closed'))).toBe(true)
		// A leftover of this extension (its executable inside the extension folder) is killed by the next host.
		scenario({})
		const left = spawnChild({
			exe: bin,
			args: [],
			cwd: join(home, 'extensions', ID, 'versions', '1.0.0'),
			env,
		})
		const gone = new Promise<void>((resolve) => left.onExit(() => resolve()))
		await new Promise<void>((resolve) => left.onLine((l) => l.includes('"hello"') && resolve()))
		mkdirSync(join(home, 'extensions', ID, 'run'), { recursive: true })
		writeFileSync(join(home, 'extensions', ID, 'run', 'pid'), String(left.pid))
		host.enable(ID)
		await gone
		await waitFor((e) => e.state === 'running')
		expect(host.audit(ID, 50).some((l) => /leftover pid \d+ killed/.test(l.detail ?? ''))).toBe(
			true,
		)
	})

	it('E12: disable runs the maintenance command, and enabling again asks nothing', async () => {
		scenario({})
		host.enable(ID)
		await waitFor((e) => e.state === 'running')
		await host.disable(ID)
		const log = readFileSync(join(home, 'extensions', ID, 'data', 'maintenance.log'), 'utf8')
		expect(log).toMatch(/purge/)
		host.enable(ID)
		await waitFor(
			(e) => e.state === 'running' && events.filter((x) => x.state === 'running').length >= 2,
		)
		expect(host.audit(ID, 100).filter((l) => l.event === 'acknowledged')).toHaveLength(1)
	})

	it('a process that ignores shutdown is force-stopped after the grace period', async () => {
		scenario({ mode: 'ignore-shutdown' })
		host.enable(ID)
		await waitFor((e) => e.state === 'running')
		await host.disable(ID)
		expect(host.audit(ID, 100).some((l) => l.event === 'stopped')).toBe(true)
	}, 20_000)
})
