import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { expiryNotice } from '../monitor-stream.js'
import {
	type BackgroundJob,
	BackgroundJobLimitError,
	BackgroundJobRegistry,
	type MonitorEvent,
	UnknownBackgroundJobError,
	bindOwner,
	describeMonitorEnd,
} from '../registry.js'

/**
 * A process the test drives by hand: it writes when told and closes when told,
 * so what the registry does with the bytes is the only thing under test, and
 * the clock is vitest's rather than the machine's.
 */
function fakeProcess() {
	const child = Object.assign(new EventEmitter(), {
		pid: undefined as number | undefined,
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
	})
	const signals: NodeJS.Signals[] = []
	return {
		child,
		signals,
		out: (text: string) => child.stdout.emit('data', Buffer.from(text)),
		err: (text: string) => child.stderr.emit('data', Buffer.from(text)),
		close: (code: number | null, signal: NodeJS.Signals | null = null) =>
			child.emit('close', code, signal),
		// The process dies when asked to, which is what a real group does.
		spawn: () => ({
			child: child as unknown as ReturnType<typeof spawn>,
			kill: (signal: NodeJS.Signals) => {
				signals.push(signal)
				child.emit('close', null, signal)
			},
		}),
	}
}

function collect(registry: BackgroundJobRegistry) {
	const log: string[] = []
	const events: MonitorEvent[] = []
	registry.onMonitorEvent((event) => {
		events.push(event)
		log.push(`event:${event.kind}:${event.text}`)
	})
	registry.onExit((job) => log.push(`exit:${job.status}`))
	return { log, events }
}

function start(
	registry: BackgroundJobRegistry,
	proc: ReturnType<typeof fakeProcess>,
	overrides: { owner?: string; timeoutMs?: number; description?: string } = {},
): BackgroundJob {
	return registry.start({
		owner: overrides.owner ?? 'turn-1',
		command: 'watch --thing',
		workingDirectory: process.cwd(),
		spawn: proc.spawn,
		monitor: {
			description: overrides.description ?? 'the thing',
			timeoutMs: overrides.timeoutMs ?? 300_000,
		},
	})
}

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

describe('a monitor delivers its stdout as events', () => {
	it('batches stdout lines into events that name the job, the owner and the description', () => {
		const registry = new BackgroundJobRegistry()
		const { events } = collect(registry)
		const proc = fakeProcess()
		const job = start(registry, proc, { description: 'errors in deploy log' })

		proc.out('first\nsecond\n')
		vi.advanceTimersByTime(200)

		expect(job).toMatchObject({ kind: 'monitor', description: 'errors in deploy log' })
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			id: `${job.id}:1`,
			jobId: job.id,
			owner: 'turn-1',
			description: 'errors in deploy log',
			kind: 'output',
			text: 'first\nsecond',
		})
		proc.out('third\n')
		vi.advanceTimersByTime(200)
		expect(events[1]?.id).toBe(`${job.id}:2`)
	})

	it('does not make stderr an event, and still retains both streams for `read`', () => {
		const registry = new BackgroundJobRegistry()
		const { events } = collect(registry)
		const proc = fakeProcess()
		const job = start(registry, proc)

		proc.err('warning: slow\n')
		proc.out('hello\n')
		vi.advanceTimersByTime(200)

		expect(events.map((e) => e.text)).toEqual(['hello'])
		expect(registry.read(job.id).chunk).toBe('warning: slow\nhello\n')
	})

	it('emits the last batch before it announces the exit', () => {
		const registry = new BackgroundJobRegistry()
		const { log } = collect(registry)
		const proc = fakeProcess()
		start(registry, proc)

		// Closed inside the window: the batch is still pending when the process ends.
		proc.out('final words\nno newline')
		proc.close(0)

		expect(log).toEqual(['event:output:final words\nno newline', 'exit:exited'])
	})

	it('survives a listener that throws', () => {
		const registry = new BackgroundJobRegistry()
		registry.onMonitorEvent(() => {
			throw new Error('listener bug')
		})
		const { events } = collect(registry)
		const proc = fakeProcess()
		start(registry, proc)
		proc.out('still delivered\n')
		vi.advanceTimersByTime(200)
		expect(events).toHaveLength(1)
	})

	it('does not report events for a job that is not a monitor', () => {
		const registry = new BackgroundJobRegistry()
		const { events } = collect(registry)
		const proc = fakeProcess()
		registry.start({
			owner: 'turn-1',
			command: 'plain',
			workingDirectory: process.cwd(),
			spawn: proc.spawn,
		})
		proc.out('not an event\n')
		vi.advanceTimersByTime(1000)
		expect(events).toEqual([])
	})
})

describe('a monitor ends on a schedule and on a ration', () => {
	it('flushes, says it expired, and stops the command with the shared kill', async () => {
		const registry = new BackgroundJobRegistry()
		const { events, log } = collect(registry)
		const proc = fakeProcess()
		const job = start(registry, proc, { timeoutMs: 5000 })
		expect(job.expiresAt).toBe(job.startedAt + 5000)

		proc.out('before the end\n')
		await vi.advanceTimersByTimeAsync(5000)

		expect(events.map((e) => `${e.kind}:${e.text}`)).toEqual([
			'output:before the end',
			'notice:[Monitor expired after 5s with 1 events delivered. Start it again if you still need the watch.]',
		])
		expect(proc.signals).toEqual(['SIGTERM'])
		expect(registry.get(job.id)).toMatchObject({ status: 'killed', stopReason: 'expired' })
		expect(log.at(-1)).toBe('exit:killed')
	})

	it('says so when it expired without a single event', async () => {
		const registry = new BackgroundJobRegistry()
		const { events } = collect(registry)
		const proc = fakeProcess()
		start(registry, proc, { timeoutMs: 300_000 })
		await vi.advanceTimersByTimeAsync(300_000)
		expect(events.map((e) => e.text)).toEqual([
			'[Monitor expired after 5m with no events delivered. Start it again if you still need the watch — and widen the filter if silence was unexpected.]',
		])
	})

	it('does not expire a monitor whose command ended first', async () => {
		const registry = new BackgroundJobRegistry()
		const { events } = collect(registry)
		const proc = fakeProcess()
		const job = start(registry, proc, { timeoutMs: 5000 })
		proc.close(0)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(events).toEqual([])
		expect(registry.get(job.id)).toMatchObject({ status: 'exited' })
		expect(registry.get(job.id).stopReason).toBeUndefined()
	})

	it('stops a source that keeps outrunning its ration, and says why', async () => {
		const registry = new BackgroundJobRegistry()
		const { events } = collect(registry)
		const proc = fakeProcess()
		const job = start(registry, proc)

		// One line per 250 ms: each is its own batch, and the bucket earns an
		// eighth of a token per batch, so the ration runs out and stays out.
		for (let i = 0; i < 400 && registry.get(job.id).stopReason === undefined; i++) {
			proc.out(`line ${i}\n`)
			await vi.advanceTimersByTimeAsync(250)
		}

		expect(registry.get(job.id)).toMatchObject({ status: 'killed', stopReason: 'too_much_output' })
		const last = events.at(-1)
		expect(last?.kind).toBe('notice')
		expect(last?.text).toMatch(
			/^\[Monitor stopped — too much output \(\d+ events suppressed over \d+s\)\. Restart it with a more selective command\.\]$/,
		)
		expect(events.some((e) => e.text.includes('events suppressed — output rate too high'))).toBe(
			true,
		)
		expect(proc.signals).toEqual(['SIGTERM'])
	})

	it('records `stopped` when a kill is asked for from outside', async () => {
		const registry = new BackgroundJobRegistry()
		const proc = fakeProcess()
		const job = start(registry, proc)
		await registry.kill(job.id)
		expect(registry.get(job.id)).toMatchObject({ status: 'killed', stopReason: 'stopped' })
	})

	it('says nothing after a stop was asked for, but delivers what was already complete', async () => {
		const registry = new BackgroundJobRegistry()
		const { log } = collect(registry)
		// A process that outlives the signal: the exit comes later, by hand.
		const proc = fakeProcess()
		proc.spawn = () => ({
			child: proc.child as unknown as ReturnType<typeof spawn>,
			kill: (signal: NodeJS.Signals) => {
				proc.signals.push(signal)
			},
		})
		const job = start(registry, proc)
		proc.out('last complete line\n')
		const stopping = registry.kill(job.id)
		proc.out('after the stop\n')
		await vi.advanceTimersByTimeAsync(1000)
		proc.close(null, 'SIGTERM')
		await stopping
		expect(log.filter((entry) => entry.startsWith('event:'))).toEqual([
			'event:output:last complete line',
		])
	})

	it('leaves an ordinary job without a stop reason when it is killed', async () => {
		const registry = new BackgroundJobRegistry()
		const proc = fakeProcess()
		const job = registry.start({
			owner: 'turn-1',
			command: 'plain',
			workingDirectory: process.cwd(),
			spawn: proc.spawn,
		})
		await registry.kill(job.id)
		expect(registry.get(job.id).stopReason).toBeUndefined()
	})
})

describe('a monitor is a job of its owner', () => {
	it('counts toward the per-owner cap like any job', () => {
		const registry = new BackgroundJobRegistry({ maxJobsPerOwner: 1 })
		start(registry, fakeProcess())
		expect(() => start(registry, fakeProcess())).toThrow(BackgroundJobLimitError)
		// Another owner is not refused for it.
		expect(() => start(registry, fakeProcess(), { owner: 'turn-2' })).not.toThrow()
	})

	it('is reachable only through its owner’s binding, and clamps the timeout it is given', async () => {
		const registry = new BackgroundJobRegistry()
		const theirs = bindOwner(registry, 'turn-2')
		const started: string[] = []
		const bound = bindOwner(registry, 'turn-1', {
			monitorTimeoutCapMs: 600_000,
			onMonitorStarted: (id) => started.push(id),
		})

		// Not a real shell: this only needs the record, and the process is killed below.
		const { job, timeoutMs } = bound.startMonitor({
			command: 'sleep 60',
			description: 'long watch',
			timeoutMs: 3_600_000,
		})

		expect(timeoutMs).toBe(600_000)
		expect(registry.get(job.id).expiresAt).toBe(registry.get(job.id).startedAt + 600_000)
		expect(started).toEqual([job.id])
		expect(theirs.list()).toEqual([])
		expect(bound.list().map((j) => `${j.kind}:${j.description}`)).toEqual(['monitor:long watch'])
		expect(() => theirs.get(job.id)).toThrow(UnknownBackgroundJobError)
		await registry.killOwner('turn-1')
	})

	it('uses 30 minutes as the ceiling when the host sets none', async () => {
		const registry = new BackgroundJobRegistry()
		const bound = bindOwner(registry, 'turn-1')
		const { timeoutMs } = bound.startMonitor({
			command: 'sleep 60',
			description: 'long watch',
			timeoutMs: 3_600_000,
		})
		expect(timeoutMs).toBe(1_800_000)
		await registry.killOwner('turn-1')
	})
})

describe('describing how a monitor ended', () => {
	const base = { description: 'deploy log', status: 'exited' as const }

	it.each([
		[{ ...base, exitCode: 0 }, 5, 'completed', 'Monitor "deploy log" stream ended'],
		[
			{ ...base, exitCode: 0 },
			0,
			'completed',
			'Monitor "deploy log" ended without producing output (exit 0)',
		],
		[{ ...base, exitCode: 2 }, 5, 'failed', 'Monitor "deploy log" script failed (exit 2)'],
		[
			{ ...base, exitCode: undefined, signal: 'SIGSEGV' },
			5,
			'failed',
			'Monitor "deploy log" script failed (SIGSEGV)',
		],
		[{ ...base, status: 'killed' as const }, 5, 'killed', 'Monitor "deploy log" stopped'],
	])('%j with %i characters of stdout', (job, stdoutChars, status, summary) => {
		expect(describeMonitorEnd(job, { stdoutChars })).toEqual({ status, summary })
	})
})

// A real shell, real pipes and a real exit: the one place the fake process
// above could be hiding a difference. It waits on the process's own exit
// rather than on a clock, so the only bound is Vitest's per-test timeout,
// raised because starting a shell is legitimately slower on a loaded runner.
describe('a monitor around a real command', () => {
	beforeEach(() => {
		vi.useRealTimers()
	})

	it('reports stdout lines, keeps stderr out of the events, and ends with the exit', async () => {
		const registry = new BackgroundJobRegistry()
		const { events, log } = collect(registry)
		const job = registry.start({
			owner: 'turn-1',
			command: 'echo one; echo two; echo oops >&2',
			workingDirectory: process.cwd(),
			monitor: { description: 'a real echo', timeoutMs: 60_000 },
		})

		const ended = await registry.waitForExit(job.id)

		expect(ended).toMatchObject({ status: 'exited', exitCode: 0, kind: 'monitor' })
		// One batch or two, depending on whether the window fell between the echoes.
		expect(
			events
				.filter((e) => e.kind === 'output')
				.map((e) => e.text)
				.join('\n'),
		).toBe('one\ntwo')
		expect(log.at(-1)).toBe('exit:exited')
		expect(registry.read(job.id).chunk).toContain('oops')
		expect(describeMonitorEnd(ended, registry.monitorStats(job.id)).summary).toBe(
			'Monitor "a real echo" stream ended',
		)
	}, 30_000)

	it('says nothing after the expiry notice from a command that ignores SIGTERM', async () => {
		const registry = new BackgroundJobRegistry()
		const { events } = collect(registry)
		const job = registry.start({
			owner: 'turn-1',
			// Ignores the polite signal and keeps printing until the SIGKILL that
			// follows the grace period; the test awaits that exit, not a clock.
			command: `trap '' TERM; while true; do echo tick; sleep 0.05; done`,
			workingDirectory: process.cwd(),
			monitor: { description: 'a stubborn loop', timeoutMs: 1000 },
		})

		const ended = await registry.waitForExit(job.id)

		expect(ended).toMatchObject({ status: 'killed', stopReason: 'expired' })
		const notice = events.findIndex((e) => e.kind === 'notice')
		expect(notice).toBeGreaterThan(-1)
		expect(events.slice(notice + 1)).toEqual([])
	}, 30_000)

	it('stops a command that outlives its deadline', async () => {
		const registry = new BackgroundJobRegistry()
		const { events } = collect(registry)
		const job = registry.start({
			owner: 'turn-1',
			command: 'echo started; sleep 30',
			workingDirectory: process.cwd(),
			// The schema minimum: the only wait in this test is the deadline itself.
			monitor: { description: 'a slow command', timeoutMs: 1000 },
		})

		const ended = await registry.waitForExit(job.id)

		expect(ended).toMatchObject({ status: 'killed', stopReason: 'expired' })
		// Whether the shell printed before the deadline depends on the machine, so
		// the assertion is the invariant: the notice is last and counts exactly the
		// batches that were delivered before it.
		const output = events.filter((e) => e.kind === 'output')
		expect(events.at(-1)?.text).toBe(expiryNotice(1000, output.length))
		expect(events.at(-1)?.kind).toBe('notice')
	}, 30_000)
})
