import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PalComputerSetupState } from '../shared/pal-computer-setup.js'
import { createComputerCli } from './pal-computer-cli.js'
import { ConsentStore, canAutoContinue, consentFor } from './pal-computer-consent.js'
import type { ComputerLine, ComputerPlan } from './pal-computer-lines.js'
import { type ComputerCli, PalComputerSetupService, classifyStatus } from './pal-computer-setup.js'

const MB = 1024 * 1024
const step = (kind: string, extra: Partial<ComputerPlan['steps'][number]> = {}) => ({
	kind,
	elevated: kind === 'install-wsl' || kind === 'enable-windows-features',
	estimatedSeconds: 60,
	mayRequireRestart: kind === 'install-wsl',
	...extra,
})
const plan = (
	id: string,
	steps: ComputerPlan['steps'],
	extra: Partial<ComputerPlan> = {},
): ComputerPlan => ({
	id,
	state: 'wsl-missing',
	steps,
	elevationPrompts: steps.some((s) => s.elevated) ? 1 : 0,
	mayRequireRestart: steps.some((s) => s.mayRequireRestart),
	...extra,
})
const FULL = plan('full', [
	step('download-wsl', { downloadBytes: 350 * MB }),
	step('install-wsl'),
	step('load-image'),
])
const IMAGE = plan('image', [step('load-image')], { state: 'image-missing' })
const statusLine = (readiness: string, p: ComputerPlan, extra = {}): ComputerLine => ({
	kind: 'status',
	readiness: { state: readiness, ...extra },
	plan: p,
})

/** A CLI that answers each command from a script. */
function scripted(answers: {
	status: () => ComputerLine[]
	setup?: (args: string[]) => ComputerLine[]
	idle?: () => ComputerLine[]
}) {
	const calls: string[][] = []
	const cli: ComputerCli = {
		run: async (args, onLine) => {
			calls.push(args)
			const lines =
				args[1] === 'status'
					? answers.status()
					: args[1] === 'setup'
						? (answers.setup?.(args) ?? [])
						: (answers.idle?.() ?? [])
			for (const line of lines) onLine(line)
			return { exitCode: 0 }
		},
	}
	return { cli, calls }
}

function make(cli: ComputerCli, consent?: ConsentStore) {
	const published: PalComputerSetupState[] = []
	const store = consent ?? {
		read: () => undefined,
		write: vi.fn(),
		clear: vi.fn(),
	}
	let now = Date.parse('2026-10-12T10:00:00Z')
	const service = new PalComputerSetupService({
		enabled: true,
		cli,
		consent: store,
		resumeCommand: '"C:\\Namzu.exe" --continue-pal-computer-setup',
		now: () => now,
		publish: (state) => published.push(state),
	})
	return {
		service,
		published,
		store,
		tick: (ms: number) => {
			now += ms
		},
	}
}

describe('classifyStatus', () => {
	it('tells ready, image only, setup, restart and blocked apart', () => {
		expect(classifyStatus({ state: 'ready' }, plan('r', [])).phase).toBe('ready')
		expect(classifyStatus({ state: 'image-missing' }, IMAGE).phase).toBe('image-only')
		const needs = classifyStatus({ state: 'wsl-missing' }, FULL)
		expect(needs.phase).toBe('needs-setup')
		expect(needs.plan).toEqual({
			id: 'full',
			steps: ['download', 'install', 'load-image'],
			downloadBytes: 350 * MB,
			seconds: 180,
			elevationPrompts: 1,
			mayRestart: true,
		})
		expect(
			classifyStatus({ state: 'restart-pending' }, plan('x', [step('restart'), step('load-image')]))
				.phase,
		).toBe('restart-pending')
		expect(
			classifyStatus(
				{ state: 'virtualization-off' },
				plan('v', [], { blocked: 'virtualization-off' }),
			),
		).toMatchObject({ phase: 'blocked', blocked: { reason: 'virtualization-off' } })
		expect(
			classifyStatus(
				{ state: 'blocked-by-policy' },
				plan('b', [], { blocked: 'blocked-by-policy' }),
			).blocked?.reason,
		).toBe('organisation-policy')
		expect(
			classifyStatus({ state: 'sdk-mismatch' }, plan('b', [], { blocked: 'sdk-mismatch' })).blocked
				?.reason,
		).toBe('update-needed')
		expect(
			classifyStatus(
				{ state: 'unsupported', unsupportedReason: 'windows-build' },
				plan('u', [], { blocked: 'unsupported' }),
			).blocked?.reason,
		).toBe('windows-version')
		expect(
			classifyStatus(
				{ state: 'unsupported', unsupportedReason: 'architecture' },
				plan('u', [], { blocked: 'unsupported' }),
			).blocked?.reason,
		).toBe('processor')
	})

	it('is unavailable off Windows and unknown for a plan it cannot read', () => {
		expect(
			classifyStatus(
				{ state: 'unsupported', unsupportedReason: 'platform' },
				plan('u', [], { blocked: 'unsupported' }),
			).available,
		).toBe(false)
		expect(classifyStatus({ state: 'wsl-missing' }, plan('odd', [step('teleport')])).phase).toBe(
			'unknown',
		)
		expect(classifyStatus({ state: 'wsl-missing' }, plan('none', [])).phase).toBe('unknown')
	})
})

describe('PalComputerSetupService', () => {
	it('checks once, then reuses the answer until asked for a fresh one', async () => {
		const { cli, calls } = scripted({ status: () => [statusLine('wsl-missing', FULL)] })
		const { service, tick } = make(cli)
		expect((await service.view()).phase).toBe('needs-setup')
		await service.view()
		expect(calls).toHaveLength(1)
		await service.view(true)
		expect(calls).toHaveLength(2)
		tick(6_000)
		await service.view()
		expect(calls).toHaveLength(3)
	})

	it('keeps the row ordinary when the check cannot run', async () => {
		const { service } = make({ run: async () => Promise.reject(new Error('spawn failed')) })
		expect(await service.view()).toMatchObject({ available: true, phase: 'unknown' })
		const quiet = make({ run: async () => ({ exitCode: 70 }) })
		expect((await quiet.service.view()).phase).toBe('unknown')
	})

	it('is unavailable when disabled and never calls the CLI', async () => {
		const run = vi.fn()
		const service = new PalComputerSetupService({
			enabled: false,
			cli: { run },
			consent: { read: () => undefined, write: vi.fn(), clear: vi.fn() },
			resumeCommand: 'x',
			now: () => 0,
			publish: vi.fn(),
		})
		expect(await service.view()).toEqual({ available: false, phase: 'unknown' })
		await expect(service.run('full')).rejects.toThrow()
		expect(await service.stopIdle()).toBe('not-running')
		expect(run).not.toHaveBeenCalled()
	})

	it('refuses a plan id it did not compute, and does not run the CLI for it', async () => {
		const { cli, calls } = scripted({ status: () => [statusLine('wsl-missing', FULL)] })
		const { service, store } = make(cli)
		await service.view()
		for (const bad of ['forged', '', undefined, 7, { id: 'full' }])
			await expect(service.run(bad, 'kiro')).rejects.toThrow(/changed/)
		expect(calls.every((call) => call[1] === 'status')).toBe(true)
		expect(store.write).not.toHaveBeenCalled()
	})

	it('treats a plan that changed because the PC is ready by now as a finished run', async () => {
		let checks = 0
		const { cli } = scripted({
			status: () =>
				++checks === 1
					? [statusLine('image-missing', IMAGE)]
					: [statusLine('ready', plan('none', []))],
			setup: () => [{ kind: 'result', result: { outcome: 'plan-changed' } }],
		})
		const { service } = make(cli)
		await service.view()
		const final = await service.run('image', 'kiro')
		expect(final).toMatchObject({ phase: 'ready', completed: { palId: 'kiro', ranSetup: false } })
		expect(final.outcome).toBeUndefined()
	})

	it('never falls back to silence when the plan changed and the PC is still not ready', async () => {
		const { cli } = scripted({
			status: () => [statusLine('image-missing', IMAGE)],
			setup: () => [{ kind: 'result', result: { outcome: 'plan-changed' } }],
		})
		const { service, store } = make(cli)
		await service.view()
		const final = await service.run('image', 'kiro')
		expect(final.phase).toBe('image-only')
		expect(final.outcome).toMatchObject({ kind: 'failed' })
		expect(store.clear).toHaveBeenCalled()
	})

	it('says so when the setup run ended with no result at all', async () => {
		const { cli } = scripted({
			status: () => [statusLine('image-missing', IMAGE)],
			setup: () => [],
		})
		const { service } = make(cli)
		await service.view()
		expect((await service.run('image', 'kiro')).outcome).toMatchObject({ kind: 'failed' })
	})

	it('forgets what was agreed when a run is cancelled or fails', async () => {
		for (const result of [
			{ outcome: 'cancelled' as const },
			{ outcome: 'needs-administrator' as const },
		]) {
			const { cli } = scripted({
				status: () => [statusLine('wsl-missing', FULL)],
				setup: () => [{ kind: 'result', result }],
			})
			const { service, store } = make(cli)
			await service.view()
			await service.run('full', 'kiro')
			expect(store.clear).toHaveBeenCalled()
		}
	})

	it('refuses to run before any check, and a blocked or restart plan', async () => {
		const { cli } = scripted({
			status: () => [
				statusLine('virtualization-off', plan('v', [], { blocked: 'virtualization-off' })),
			],
		})
		const { service } = make(cli)
		await expect(service.run('v')).rejects.toThrow()
		await service.view()
		await expect(service.run('v')).rejects.toThrow(/cannot run/)
		const restart = scripted({
			status: () => [statusLine('restart-pending', plan('rs', [step('restart')]))],
		})
		const second = make(restart.cli)
		await second.service.view()
		await expect(second.service.run('rs')).rejects.toThrow(/cannot run/)
	})

	it('runs the agreed plan with the resume command, streams progress and ends ready', async () => {
		const { cli, calls } = scripted({
			status: () => [statusLine('wsl-missing', FULL)],
			setup: () => [
				{ kind: 'progress', progress: { step: 'download-wsl', phase: 'started' } },
				{
					kind: 'progress',
					progress: {
						step: 'download-wsl',
						phase: 'progress',
						done: 120 * MB,
						total: 350 * MB,
						unit: 'bytes',
					},
				},
				{ kind: 'progress', progress: { step: 'install-wsl', phase: 'started' } },
				{ kind: 'progress', progress: { step: 'load-image', phase: 'started' } },
				{ kind: 'result', result: { outcome: 'ready' } },
			],
		})
		const { service, published, store } = make(cli)
		await service.view()
		const final = await service.run('full', 'kiro')
		expect(calls.at(-1)).toEqual([
			'computer',
			'setup',
			'--json',
			'--plan',
			'full',
			'--resume-command',
			'"C:\\Namzu.exe" --continue-pal-computer-setup',
		])
		// The first publication is the check that came before the run.
		expect(published.slice(1).map((s) => s.running?.step)).toEqual([
			'checking',
			'download',
			'download',
			'install',
			'load-image',
			undefined,
		])
		expect(published[3]?.running).toEqual({ step: 'download', done: 120 * MB, total: 350 * MB })
		expect(final).toMatchObject({
			phase: 'ready',
			completed: { seq: 1, palId: 'kiro', ranSetup: true },
		})
		expect(final.running).toBeUndefined()
		expect(store.write).toHaveBeenCalledWith(
			expect.objectContaining({
				steps: ['download-wsl', 'install-wsl', 'load-image'],
				palId: 'kiro',
			}),
		)
		expect(store.clear).toHaveBeenCalled()
	})

	it('says the image alone is not a setup', async () => {
		const { cli } = scripted({
			status: () => [statusLine('image-missing', IMAGE)],
			setup: () => [{ kind: 'result', result: { outcome: 'ready' } }],
		})
		const { service } = make(cli)
		await service.view()
		expect((await service.run('image', 'kiro')).completed).toEqual({
			seq: 1,
			palId: 'kiro',
			ranSetup: false,
		})
	})

	it('reports a restart as the state, not as a plan', async () => {
		const { cli } = scripted({
			status: () => [statusLine('wsl-missing', FULL)],
			setup: () => [{ kind: 'result', result: { outcome: 'restart-required' } }],
		})
		const { service } = make(cli)
		await service.view()
		expect(service.restartIsDue()).toBe(false)
		const final = await service.run('full', 'kiro')
		expect(final).toMatchObject({ phase: 'restart-pending', outcome: { kind: 'restart-required' } })
		expect(final.plan).toBeUndefined()
		expect(service.restartIsDue()).toBe(true)
	})

	it('keeps how a run ended through the next check, and clears it when ready', async () => {
		let readiness = 'wsl-missing'
		const { cli } = scripted({
			status: () => [statusLine(readiness, readiness === 'ready' ? plan('r', []) : FULL)],
			setup: () => [{ kind: 'result', result: { outcome: 'cancelled' } }],
		})
		const { service } = make(cli)
		await service.view()
		const after = await service.run('full')
		expect(after).toMatchObject({ phase: 'needs-setup', outcome: { kind: 'cancelled' } })
		expect(after.plan?.id).toBe('full')
		readiness = 'ready'
		const ready = await service.view(true)
		expect(ready.phase).toBe('ready')
		expect(ready.outcome).toBeUndefined()
	})

	it('turns a failure into a plain sentence with the detail kept for the fold', async () => {
		const { cli } = scripted({
			status: () => [statusLine('wsl-missing', FULL)],
			setup: () => [
				{
					kind: 'result',
					result: {
						outcome: 'failed',
						step: 'download-wsl',
						code: 'download-failed',
						detail: 'The server answered 503.',
					},
				},
			],
		})
		const { service } = make(cli)
		await service.view()
		const final = await service.run('full')
		expect(final.outcome).toEqual({
			kind: 'failed',
			sentence: 'Linux support could not be downloaded. Check the internet connection.',
			details: 'The server answered 503.',
		})
		expect(JSON.stringify(final)).not.toMatch(/download-failed|wsl|HRESULT|0x8/i)
	})

	it('fails plainly when the setup process ends without a result', async () => {
		const { cli } = scripted({ status: () => [statusLine('wsl-missing', FULL)], setup: () => [] })
		const { service } = make(cli)
		await service.view()
		expect((await service.run('full')).outcome).toEqual({
			kind: 'failed',
			sentence: 'Setup stopped before it finished.',
		})
	})

	it('does not run two setups at once', async () => {
		let release: (() => void) | undefined
		const cli: ComputerCli = {
			run: (args, onLine) => {
				if (args[1] === 'status') {
					onLine(statusLine('wsl-missing', FULL))
					return Promise.resolve({ exitCode: 0 })
				}
				return new Promise((resolve) => {
					release = () => {
						onLine({ kind: 'result', result: { outcome: 'ready' } })
						resolve({ exitCode: 0 })
					}
				})
			},
		}
		const { service } = make(cli)
		await service.view()
		const first = service.run('full')
		await expect(service.run('full')).rejects.toThrow(/already running/)
		expect(service.current().running).toBeDefined()
		release?.()
		await first
	})

	it('stops idle through the CLI and reports what it answered', async () => {
		const { cli, calls } = scripted({
			status: () => [],
			idle: () => [{ kind: 'stop-idle', outcome: 'busy' }],
		})
		const { service } = make(cli)
		expect(await service.stopIdle()).toBe('busy')
		expect(calls[0]).toEqual(['computer', 'stop-idle', '--json'])
		const silent = make({ run: async () => ({ exitCode: 1 }) })
		expect(await silent.service.stopIdle()).toBe('failed')
	})
})

describe('continuing after a restart', () => {
	let directory: string | undefined
	afterEach(() => {
		if (directory) rmSync(directory, { recursive: true, force: true })
		directory = undefined
	})
	const store = () => {
		directory = mkdtempSync(join(tmpdir(), 'namzu-consent-'))
		return new ConsentStore(join(directory, 'nested', 'record.json'))
	}

	it('goes on by itself with the rest of what was agreed', async () => {
		const consent = store()
		consent.write(consentFor(FULL, new Date('2026-10-12T10:00:00Z'), 'kiro'))
		const rest = plan('rest', [step('load-image')], { state: 'image-missing' })
		const { cli, calls } = scripted({
			status: () => [statusLine('image-missing', rest)],
			setup: () => [{ kind: 'result', result: { outcome: 'ready' } }],
		})
		const { service } = make(cli, consent)
		await service.continueAfterRestart()
		expect(calls.at(-1)?.slice(0, 5)).toEqual(['computer', 'setup', '--json', '--plan', 'rest'])
		expect(service.current()).toMatchObject({ phase: 'ready', completed: { palId: 'kiro' } })
		expect(consent.read()).toBeUndefined()
	})

	it('shows Continuing while it does', async () => {
		const consent = store()
		consent.write(consentFor(FULL, new Date('2026-10-12T10:00:00Z'), 'kiro'))
		const rest = plan('rest', [step('load-image')])
		const { cli } = scripted({
			status: () => [statusLine('image-missing', rest)],
			setup: () => [
				{ kind: 'progress', progress: { step: 'load-image', phase: 'started' } },
				{ kind: 'result', result: { outcome: 'ready' } },
			],
		})
		const { service, published } = make(cli, consent)
		await service.continueAfterRestart()
		expect(published.filter((s) => s.running).every((s) => s.running?.continuing)).toBe(true)
	})

	it('asks again for anything new: a download, a permission, or no record', async () => {
		const consent = store()
		consent.write(consentFor(FULL, new Date('2026-10-12T10:00:00Z')))
		const newer = plan('newer', [step('download-wsl', { downloadBytes: MB }), step('load-image')])
		const asked = scripted({ status: () => [statusLine('wsl-missing', newer)] })
		const first = make(asked.cli, consent)
		await first.service.continueAfterRestart()
		expect(asked.calls.every((call) => call[1] === 'status')).toBe(true)
		expect(first.service.current().phase).toBe('needs-setup')

		const elevated = plan('elev', [step('install-wsl')])
		const second = scripted({ status: () => [statusLine('wsl-missing', elevated)] })
		await make(second.cli, consent).service.continueAfterRestart()
		expect(second.calls.every((call) => call[1] === 'status')).toBe(true)

		const none = scripted({ status: () => [statusLine('image-missing', IMAGE)] })
		await make(none.cli, store()).service.continueAfterRestart()
		expect(none.calls.every((call) => call[1] === 'status')).toBe(true)
	})

	it('shows the restart row, not a run, while a restart is still due', async () => {
		const consent = store()
		consent.write(consentFor(FULL, new Date('2026-10-12T10:00:00Z')))
		const { cli, calls } = scripted({
			status: () => [
				statusLine('restart-pending', plan('rs', [step('restart'), step('load-image')])),
			],
		})
		const { service } = make(cli, consent)
		await service.continueAfterRestart()
		expect(calls.every((call) => call[1] === 'status')).toBe(true)
		expect(service.current().phase).toBe('restart-pending')
	})
})

describe('canAutoContinue', () => {
	const record = consentFor(FULL, new Date())
	it('needs every step agreed, none elevated, none downloading', () => {
		expect(canAutoContinue(record, plan('a', [step('load-image')]))).toBe(true)
		expect(canAutoContinue(record, plan('a', [step('restart'), step('load-image')]))).toBe(false)
		expect(
			canAutoContinue(
				consentFor(plan('w', [step('restart'), step('load-image')]), new Date()),
				plan('a', [step('restart'), step('load-image')]),
			),
		).toBe(true)
		expect(canAutoContinue(record, plan('a', [step('install-wsl')]))).toBe(false)
		expect(canAutoContinue(record, plan('a', [step('download-wsl', { downloadBytes: 5 })]))).toBe(
			false,
		)
		expect(canAutoContinue(record, plan('a', [step('enable-windows-features')]))).toBe(false)
		expect(canAutoContinue(undefined, plan('a', [step('load-image')]))).toBe(false)
		// An agreement is for one setup: a day later it is no longer the person's word.
		const dayAndMore = new Date(record.at).getTime() + 25 * 60 * 60 * 1000
		expect(canAutoContinue(record, plan('a', [step('load-image')]), dayAndMore)).toBe(false)
		expect(
			canAutoContinue(
				record,
				plan('a', [step('load-image')]),
				new Date(record.at).getTime() + 1000,
			),
		).toBe(true)
		expect(canAutoContinue({ ...record, at: 'not a date' }, plan('a', [step('load-image')]))).toBe(
			false,
		)
		expect(canAutoContinue(record, plan('a', []))).toBe(false)
		expect(
			canAutoContinue(record, plan('a', [step('load-image')], { blocked: 'unsupported' })),
		).toBe(false)
		expect(
			canAutoContinue({ ...record, steps: ['restart'] }, plan('a', [step('load-image')])),
		).toBe(false)
	})
})

describe('ConsentStore', () => {
	it('round-trips, clears, and reads damage as no agreement', () => {
		const directory = mkdtempSync(join(tmpdir(), 'namzu-consent-'))
		try {
			const consent = new ConsentStore(join(directory, 'a', 'record.json'))
			expect(consent.read()).toBeUndefined()
			const record = consentFor(FULL, new Date('2026-10-12T10:00:00Z'), 'kiro')
			consent.write(record)
			expect(consent.read()).toEqual(record)
			consent.clear()
			expect(consent.read()).toBeUndefined()
			consent.clear()
			const broken = new ConsentStore(join(directory, 'broken.json'))
			broken.write({ steps: ['load-image'], at: 'x' })
			expect(broken.read()?.steps).toEqual(['load-image'])
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})

describe('createComputerCli', () => {
	function fakeSpawn() {
		const child = Object.assign(new EventEmitter(), {
			stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
		})
		const spawnProcess = vi.fn(() => child)
		return { child, spawnProcess }
	}

	it('runs the CLI entry with computer arguments and yields whole lines', async () => {
		const { child, spawnProcess } = fakeSpawn()
		const cli = createComputerCli(
			{ program: 'electron', prefix: ['--use-system-ca', 'cli.js'], env: { A: '1' } },
			spawnProcess as never,
		)
		const lines: ComputerLine[] = []
		const done = cli.run(['computer', 'stop-idle', '--json'], (line) => lines.push(line))
		child.stdout.emit('data', '{"version":1,"outc')
		child.stdout.emit('data', 'ome":"stopped"}\n')
		child.emit('close', 0)
		expect(await done).toEqual({ exitCode: 0 })
		expect(lines).toEqual([{ kind: 'stop-idle', outcome: 'stopped' }])
		expect(spawnProcess).toHaveBeenCalledWith(
			'electron',
			['--use-system-ca', 'cli.js', 'computer', 'stop-idle', '--json'],
			expect.objectContaining({ env: { A: '1' }, windowsHide: true }),
		)
	})

	it('stops waiting, and stops the child, when a timeout is given and the child never answers', async () => {
		vi.useFakeTimers()
		try {
			const { child, spawnProcess } = fakeSpawn()
			const kill = vi.fn()
			Object.assign(child, { kill })
			const done = createComputerCli(
				{ program: 'x', prefix: [], env: {} },
				spawnProcess as never,
			).run(['computer', 'stop-idle', '--json'], () => {}, { timeoutMs: 5000 })
			await vi.advanceTimersByTimeAsync(4999)
			expect(kill).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			expect(await done).toEqual({ exitCode: null })
			expect(kill).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it('rejects when the process cannot start', async () => {
		const { child, spawnProcess } = fakeSpawn()
		const done = createComputerCli(
			{ program: 'x', prefix: [], env: {} },
			spawnProcess as never,
		).run([], () => {})
		child.emit('error', new Error('ENOENT'))
		await expect(done).rejects.toThrow('ENOENT')
	})
})
