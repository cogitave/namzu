import { spawn } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { recordingSpawn, settle } from '../__fixtures__/fake-child.js'
import {
	buildPackage,
	makeKey,
	sampleManifest,
	trustedFrom,
} from '../__fixtures__/package-builder.js'
import { ExtensionHost } from '../host.js'
import { ownerLive } from '../proc-start.js'
import { ctlAddress, ctlRequest, startCtlServer } from './ctl.js'
import { ensureRunner, runDaemon } from './daemon.js'
import {
	acquireRunnerLock,
	liveRunner,
	readRunnerLock,
	releaseRunnerLock,
	runnerLockPath,
	startTokenOf,
} from './lock.js'

const pub = makeKey('pub-test')
const lic = makeKey('lic-test')
const ID = 'com.example.stub-recorder'
let home: string
let root: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'ext-run-'))
	root = join(home, 'extensions')
	mkdirSync(join(root, '_runner'), { recursive: true })
})
afterEach(() => {
	vi.useRealTimers()
	removeTempDir(home)
})

/** A pid that is certainly gone: a child that has exited. */
async function deadPid(): Promise<number> {
	const c = spawn(process.execPath, ['-e', ''])
	const pid = c.pid as number
	await new Promise((r) => c.once('exit', r))
	return pid
}

describe('one runner per user: the lock', () => {
	it('the first runner takes it and a second finds it held', () => {
		expect(acquireRunnerLock(root, 1)).toBe(true)
		expect(readRunnerLock(root)).toMatchObject({ pid: process.pid, kind: 'daemon' })
		// The parent process stands in for another live runner.
		expect(acquireRunnerLock(root, 2, process.ppid)).toBe(false)
		expect(liveRunner(root)?.pid).toBe(process.pid)
	})
	it('a lock whose owner is gone is taken over, and a recycled pid is not mistaken for the owner', async () => {
		writeFileSync(
			runnerLockPath(root),
			JSON.stringify({ pid: await deadPid(), token: 'x', kind: 'daemon', since: 1 }),
		)
		expect(liveRunner(root)).toBeUndefined()
		expect(acquireRunnerLock(root, 3)).toBe(true)
		// A live pid with the wrong start token is a different process that reused the number.
		writeFileSync(
			runnerLockPath(root),
			JSON.stringify({ pid: process.ppid, token: 'not-its-start-time', kind: 'daemon', since: 1 }),
		)
		if (startTokenOf(process.ppid) !== '') {
			expect(liveRunner(root)).toBeUndefined()
			expect(acquireRunnerLock(root, 4)).toBe(true)
		}
	})
	it('where the system gives no start time, a lock written before this boot is stale', () => {
		const pid = process.pid
		const live = { alive: () => true, startTokenOf: () => '' }
		const nowMs = 10_000_000
		// the computer started 1000 s ago; the lock is 5000 s old, so its pid was reused since
		expect(
			ownerLive(
				{ pid, token: '', since: nowMs - 5_000_000 },
				{ ...live, now: nowMs, uptimeSeconds: 1000 },
			),
		).toBe(false)
		expect(
			ownerLive(
				{ pid, token: '', since: nowMs - 10_000 },
				{ ...live, now: nowMs, uptimeSeconds: 1000 },
			),
		).toBe(true)
		// a start time that differs is a different process, whatever the lock's age
		expect(
			ownerLive({ pid, token: 'a', since: nowMs }, { alive: () => true, startTokenOf: () => 'b' }),
		).toBe(false)
	})
	it('of two runners that both see one stale lock, only one takes it', async () => {
		writeFileSync(
			runnerLockPath(root),
			JSON.stringify({
				pid: await deadPid(),
				token: 'x',
				kind: 'daemon',
				since: 1,
			}),
		)
		// The second runner is the parent process, standing in for another live process.
		expect(acquireRunnerLock(root, 5, process.pid)).toBe(true)
		expect(acquireRunnerLock(root, 6, process.ppid)).toBe(false)
		expect(readRunnerLock(root)?.pid).toBe(process.pid)
		// a takeover folder left behind by a crashed runner does not block for ever
		const gate = `${runnerLockPath(root)}.takeover`
		rmSync(runnerLockPath(root))
		mkdirSync(gate)
		const old = new Date(Date.now() - 60_000)
		utimesSync(gate, old, old)
		writeFileSync(
			runnerLockPath(root),
			JSON.stringify({
				pid: process.pid,
				token: 'not-mine',
				kind: 'daemon',
				since: 1,
			}),
		)
		expect(acquireRunnerLock(root, 7, process.ppid)).toBe(true)
		expect(existsSync(gate)).toBe(false)
	})
	it('only the owner releases it', () => {
		acquireRunnerLock(root, 1)
		releaseRunnerLock(root, process.ppid)
		expect(existsSync(runnerLockPath(root))).toBe(true)
		releaseRunnerLock(root)
		expect(existsSync(runnerLockPath(root))).toBe(false)
	})
})

describe('the control channel: four operations, local only, with a token', () => {
	const calls: string[] = []
	const handlers = {
		reload: () => {
			calls.push('reload')
			return { ok: true }
		},
		status: () => ({ ok: true, pid: 1 }),
		stop: () => {
			calls.push('stop')
			return { ok: true }
		},
		restart: (id: string) => {
			calls.push(`restart ${id}`)
			return { ok: id === ID }
		},
	}
	beforeEach(() => {
		calls.length = 0
	})
	it('answers reload, status, stop and restart, and nothing else', async () => {
		const s = await startCtlServer(root, handlers)
		try {
			expect(await ctlRequest(root, { op: 'reload' })).toEqual({ ok: true })
			expect(await ctlRequest(root, { op: 'status' })).toEqual({ ok: true, pid: 1 })
			expect(await ctlRequest(root, { op: 'restart', id: ID })).toEqual({ ok: true })
			expect(await ctlRequest(root, { op: 'restart', id: ID.replace('.', '/') })).toEqual({
				ok: false,
				error: 'bad-request',
			})
			expect(await ctlRequest(root, { op: 'stop' })).toEqual({ ok: true })
			expect(calls).toEqual(['reload', `restart ${ID}`, 'stop'])
			const raw = (line: string) =>
				new Promise<string>((resolve) => {
					const sock = connect(s.address)
					let buf = ''
					sock.setEncoding('utf8')
					sock.on('connect', () => sock.write(`${line}\n`))
					sock.on('data', (c: string) => {
						buf += c
					})
					sock.on('end', () => resolve(buf.trim()))
					sock.on('error', () => resolve(''))
				})
			const token = readFileSync(join(root, '_runner', 'ctl.token'), 'utf8').trim()
			expect(JSON.parse(await raw(JSON.stringify({ op: 'status' })))).toEqual({
				ok: false,
				error: 'not-allowed',
			})
			expect(JSON.parse(await raw(JSON.stringify({ op: 'status', auth: 'wrong' })))).toEqual({
				ok: false,
				error: 'not-allowed',
			})
			expect(JSON.parse(await raw(JSON.stringify({ op: 'exec', auth: token })))).toEqual({
				ok: false,
				error: 'unknown-op',
			})
			expect(JSON.parse(await raw('not json'))).toEqual({ ok: false, error: 'bad-request' })
			expect(calls).toEqual(['reload', `restart ${ID}`, 'stop'])
		} finally {
			await s.close()
		}
	})
	it('the socket and the token are private to this user, and nobody answering is a plain undefined', async () => {
		const s = await startCtlServer(root, handlers)
		if (process.platform !== 'win32') {
			expect(statSync(s.address).mode & 0o077).toBe(0)
			expect(statSync(join(root, '_runner', 'ctl.token')).mode & 0o077).toBe(0)
		}
		await s.close()
		expect(await ctlRequest(root, { op: 'status' })).toBeUndefined()
	})
	it('a very long home keeps the socket in a private per-user folder instead', () => {
		const long = join(home, 'x'.repeat(120), 'extensions')
		const a = ctlAddress(long, 'linux')
		expect(a).not.toContain('x'.repeat(120))
		expect(Buffer.byteLength(a)).toBeLessThan(108)
		expect(ctlAddress(root, 'win32')).toMatch(/^\\\\\.\\pipe\\namzu-runner-[0-9a-f]{8}$/)
	})
})

describe('the runner', () => {
	const make = (id = ID, version = '1.0.0') =>
		buildPackage({
			manifest: sampleManifest(
				((m: Record<string, any>) => {
					m.licensing = { kind: 'none' }
					m.id = id
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
				}) as never,
				{ version, keyId: pub.id },
			),
			publisherKey: pub,
			licenseKey: lic,
		})
	const prepare = (): ExtensionHost => {
		const h = new ExtensionHost({
			home,
			hostVersion: '53.5.0',
			kind: 'cli',
			env: {},
			oneShot: true,
			locale: () => 'en',
			compiledKeys: [trustedFrom(pub)],
		})
		h.add(make())
		const n = h.notice(ID)
		h.acknowledge(ID, {
			noticeVersion: n.noticeVersion,
			scopeHash: n.scopeHash,
			locale: n.locale,
			startAtSignin: true,
		})
		h.enable(ID)
		return h
	}
	const engine = { exe: process.execPath, args: ['/x/bin.js'], env: {} }
	const env = () => ({ XDG_CONFIG_HOME: join(home, 'xdg'), HOME: home })

	it('takes the lock, runs only background extensions, answers on its channel, and stops them cleanly', async () => {
		prepare()
		const rec = recordingSpawn()
		const d = await runDaemon({
			home,
			hostVersion: '53.5.0',
			engine,
			env: env(),
			hostOptions: { spawn: rec.spawn, compiledKeys: [trustedFrom(pub)], locale: () => 'en' },
		})
		if (!d.running) throw new Error('did not start')
		try {
			await settle()
			expect(liveRunner(root)?.pid).toBe(process.pid)
			expect(rec.runs()).toHaveLength(1)
			const st = await ctlRequest(root, { op: 'status' })
			expect(st).toMatchObject({ ok: true, pid: process.pid })
			expect((st?.extensions as { id: string }[]).map((e) => e.id)).toEqual([ID])
			// The sign-in entry exists because the runner reconciled it, under the temp config folder only.
			await vi.waitFor(() =>
				expect(existsSync(join(home, 'xdg', 'autostart', 'namzu-extension-runner.desktop'))).toBe(
					true,
				),
			)
		} finally {
			await d.stop()
		}
		expect(rec.runs()[0]?.written.some((l) => l.includes('shutdown'))).toBe(true)
		expect(existsSync(runnerLockPath(root))).toBe(false)
		const log = readFileSync(join(root, '_runner', 'daemon.log'), 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l).event)
		expect(log).toContain('runner-start')
		expect(log).toContain('runner-stop')
	})
	it('a second runner for the same person exits at once, and the first is untouched', async () => {
		prepare()
		const first = await runDaemon({
			home,
			hostVersion: '53.5.0',
			engine,
			env: env(),
			hostOptions: { spawn: recordingSpawn().spawn, compiledKeys: [trustedFrom(pub)] },
		})
		if (!first.running) throw new Error('did not start')
		try {
			// Another process of the same person: the lock names a live pid that is not this one.
			releaseRunnerLock(root)
			writeFileSync(
				runnerLockPath(root),
				JSON.stringify({
					pid: process.ppid,
					token: startTokenOf(process.ppid),
					kind: 'daemon',
					since: 1,
				}),
			)
			if (startTokenOf(process.ppid) === '') return
			const second = await runDaemon({ home, hostVersion: '53.5.0', engine, env: env() })
			expect(second).toEqual({ running: false, reason: 'already-running', pid: process.ppid })
		} finally {
			releaseRunnerLock(root, process.ppid)
			await first.stop()
		}
	})
	it('exits by itself a minute after nothing needs it (fake clock), and gives the lock back', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
		const h = new ExtensionHost({
			home,
			hostVersion: '53.5.0',
			kind: 'cli',
			env: {},
			oneShot: true,
			compiledKeys: [],
		})
		h.store.ensureRoot()
		const d = await runDaemon({ home, hostVersion: '53.5.0', engine, env: env(), idleMs: 60_000 })
		if (!d.running) throw new Error('did not start')
		expect(liveRunner(root)).toBeDefined()
		await vi.advanceTimersByTimeAsync(59_999)
		expect(liveRunner(root)).toBeDefined()
		await vi.advanceTimersByTimeAsync(2)
		expect(liveRunner(root)).toBeUndefined()
		const log = readFileSync(join(root, '_runner', 'daemon.log'), 'utf8')
		expect(log).toContain('runner-idle-exit')
	})
	it('stop answers ok even when there is nothing to shut down first', async () => {
		let code: number | undefined
		const d = await runDaemon({
			home,
			hostVersion: '53.5.0',
			engine,
			env: env(),
			onExit: (c) => {
				code = c
			},
		})
		if (!d.running) throw new Error('did not start')
		expect(await ctlRequest(root, { op: 'stop' })).toEqual({ ok: true })
		await vi.waitFor(() => expect(code).toBe(0))
		expect(existsSync(runnerLockPath(root))).toBe(false)
	})
	it('an extension the runner stopped because it was disabled is started again when it is enabled, and the answer to reload comes after the stop', async () => {
		const h = prepare()
		const rec = recordingSpawn()
		const d = await runDaemon({
			home,
			hostVersion: '53.5.0',
			engine,
			env: env(),
			hostOptions: {
				spawn: rec.spawn,
				compiledKeys: [trustedFrom(pub)],
				locale: () => 'en',
			},
		})
		if (!d.running) throw new Error('did not start')
		try {
			await settle()
			expect(rec.runs()).toHaveLength(1)
			const lock = join(h.store.runDir(ID), 'lock')
			expect(existsSync(lock)).toBe(true)
			await h.disable(ID)
			expect(await ctlRequest(root, { op: 'reload' })).toEqual({ ok: true })
			// the answer came after the stop: the process was told to shut down and its lock is free
			expect(rec.runs()[0]?.written.some((l) => l.includes('shutdown'))).toBe(true)
			expect(existsSync(lock)).toBe(false)
			h.enable(ID)
			expect(await ctlRequest(root, { op: 'reload' })).toEqual({ ok: true })
			await settle()
			expect(rec.runs()).toHaveLength(2)
		} finally {
			await d.stop()
		}
	})
	it('the stop operation on its channel shuts it down', async () => {
		prepare()
		const rec = recordingSpawn()
		let code: number | undefined
		const d = await runDaemon({
			home,
			hostVersion: '53.5.0',
			engine,
			env: env(),
			onExit: (c) => {
				code = c
			},
			hostOptions: { spawn: rec.spawn, compiledKeys: [trustedFrom(pub)] },
		})
		if (!d.running) throw new Error('did not start')
		expect(await ctlRequest(root, { op: 'stop' })).toEqual({ ok: true })
		await vi.waitFor(() => expect(code).toBe(0))
		expect(existsSync(runnerLockPath(root))).toBe(false)
	})
})

describe('ensureRunner: attach to a live runner, or start one detached and wait for its lock', () => {
	const engine = { exe: process.execPath, args: ['/x/bin.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }
	it('a live runner is attached to and nothing is started', async () => {
		acquireRunnerLock(root, 1)
		let started = 0
		const ok = await ensureRunner({
			root,
			engine,
			spawnDetached: () => {
				started++
				return { onExit: () => {} }
			},
		})
		expect(ok).toBe(true)
		expect(started).toBe(0)
	})
	it('starts `extension daemon run` with the engine as it is now, and resolves when the lock appears', async () => {
		const seen: { exe: string; args: string[]; env: unknown; detached: unknown }[] = []
		const ok = await ensureRunner({
			root,
			engine,
			spawnDetached: (exe, args, opts) => {
				seen.push({ exe, args, env: opts.env?.ELECTRON_RUN_AS_NODE, detached: opts.detached })
				// The runner comes up a moment later and takes its lock (the parent stands in for it).
				setTimeout(
					() =>
						writeFileSync(
							runnerLockPath(root),
							JSON.stringify({
								pid: process.ppid,
								token: startTokenOf(process.ppid),
								kind: 'daemon',
								since: 1,
							}),
						),
					0,
				)
				return { onExit: () => {} }
			},
		})
		if (startTokenOf(process.ppid) === '') return
		expect(ok).toBe(true)
		expect(seen).toEqual([
			{
				exe: process.execPath,
				args: ['/x/bin.js', 'extension', 'daemon', 'run'],
				env: '1',
				detached: true,
			},
		])
	})
	it('a runner that exits at once without a lock is a failure, not a hang', async () => {
		const ok = await ensureRunner({
			root,
			engine,
			spawnDetached: () => ({ onExit: (cb) => queueMicrotask(cb) }),
		})
		expect(ok).toBe(false)
	})
})
