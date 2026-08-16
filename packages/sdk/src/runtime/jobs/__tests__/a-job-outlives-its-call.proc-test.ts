import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import {
	BackgroundJobLimitError,
	BackgroundJobRegistry,
	UnknownBackgroundJobError,
} from '../registry.js'

/**
 * Work that outlives a tool call, and dies with its owner.
 *
 * A process-level test because every property here is about a real process:
 * that it keeps running after the call returns, that killing it reaches what
 * it forked, and that tearing down its owner leaves nothing behind. A mock
 * child proves none of those.
 *
 * `bash` could not simply grow a background branch. On the `linux-namespace`
 * tier the wrapping `sh` is PID 1 of a fresh PID namespace and the kernel
 * destroys the namespace when init exits, so `long-thing &` inside that
 * shell dies on the successful path while looking like it worked. The
 * registry holds the process for its whole life instead.
 */

const OWNER = 'run_a'
const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-jobs-'))
	dirs.push(dir)
	return dir
}

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for the job')
		await settle(25)
	}
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

describe('a background job survives the call that started it', () => {
	it('is still running when start() returns, and finishes on its own', async () => {
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()

		const job = registry.start({
			owner: OWNER,
			command: 'sleep 0.4; echo finished',
			workingDirectory: cwd,
		})

		// The property `sh -c "… &"` cannot give: still alive after the call.
		expect(job.status).toBe('running')
		await waitFor(() => registry.get(job.id).status === 'exited')
		expect(registry.read(job.id).chunk).toContain('finished')
		expect(registry.get(job.id).exitCode).toBe(0)
	})

	it('reports a non-zero exit rather than only that it stopped', async () => {
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()

		const job = registry.start({ owner: OWNER, command: 'exit 3', workingDirectory: cwd })
		await waitFor(() => registry.get(job.id).status === 'exited')

		expect(registry.get(job.id).exitCode).toBe(3)
	})

	it('carries stderr as well as stdout', async () => {
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()

		const job = registry.start({
			owner: OWNER,
			command: 'echo out; echo err 1>&2',
			workingDirectory: cwd,
		})
		await waitFor(() => registry.get(job.id).status === 'exited')

		const output = registry.read(job.id).chunk
		expect(output).toContain('out')
		expect(output).toContain('err')
	})
})

describe('polling does not re-read or skip', () => {
	it('returns only what is new since the offset it was handed', async () => {
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()
		const job = registry.start({
			owner: OWNER,
			command: 'echo first; sleep 0.3; echo second',
			workingDirectory: cwd,
		})

		await waitFor(() => registry.read(job.id).chunk.includes('first'))
		const first = registry.read(job.id)
		await waitFor(() => registry.get(job.id).status === 'exited')
		const second = registry.read(job.id, { fromOffset: first.nextOffset })

		expect(first.chunk).toContain('first')
		// Not both. A poller that re-read the whole buffer every tick would
		// show the model the same build failure four times.
		expect(second.chunk).not.toContain('first')
		expect(second.chunk).toContain('second')
	})

	it('says how much the cap dropped instead of closing over the gap', async () => {
		// A job whose tail vanished quietly reads as a complete result that
		// happens to be short — the model concludes the build passed.
		const registry = new BackgroundJobRegistry({ maxOutputBytesPerJob: 200 })
		const cwd = await workdir()

		const job = registry.start({
			owner: OWNER,
			command: 'for i in $(seq 1 400); do echo "line $i"; done',
			workingDirectory: cwd,
		})
		await waitFor(() => registry.get(job.id).status === 'exited')

		const read = registry.read(job.id, { fromOffset: 0 })
		expect(read.droppedBytes).toBeGreaterThan(0)
		// Oldest first: the newest lines are the ones a poller is waiting for.
		expect(read.chunk).toContain('line 400')
		expect(read.chunk).not.toContain('line 1\n')
	})

	it('keeps offsets counted over the whole stream, not the retained tail', async () => {
		// If `nextOffset` counted only what is retained, a caller resuming
		// after a drop would re-read bytes it had already seen and never
		// notice — the seamless-looking excerpt this exists to prevent.
		const registry = new BackgroundJobRegistry({ maxOutputBytesPerJob: 100 })
		const cwd = await workdir()

		const job = registry.start({
			owner: OWNER,
			command: 'for i in $(seq 1 200); do echo "x$i"; done',
			workingDirectory: cwd,
		})
		await waitFor(() => registry.get(job.id).status === 'exited')

		const read = registry.read(job.id)
		expect(read.nextOffset).toBeGreaterThan(100)
		// Reading again from the offset it just gave yields nothing new.
		expect(registry.read(job.id, { fromOffset: read.nextOffset }).chunk).toBe('')
	})
})

describe('a job dies with its owner', () => {
	it('kills the tree, not just the wrapping shell', async () => {
		// The property `child.kill()` does not have: the grandchild keeps
		// running past both a cancel and a timeout.
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()
		const job = registry.start({
			owner: OWNER,
			command: 'sleep 30 & echo $!; wait',
			workingDirectory: cwd,
		})

		await waitFor(() => registry.read(job.id).chunk.trim().length > 0)
		const grandchild = Number(registry.read(job.id).chunk.trim().split('\n')[0])
		expect(alive(grandchild)).toBe(true)

		await registry.kill(job.id)
		await settle(200)

		expect(alive(grandchild)).toBe(false)
		expect(registry.get(job.id).status).toBe('killed')
	})

	it('killOwner leaves nothing of that owner running', async () => {
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()
		const mine = [
			registry.start({ owner: OWNER, command: 'sleep 30', workingDirectory: cwd }),
			registry.start({ owner: OWNER, command: 'sleep 30', workingDirectory: cwd }),
		]
		const theirs = registry.start({
			owner: 'run_b',
			command: 'sleep 30',
			workingDirectory: cwd,
		})

		await registry.killOwner(OWNER)

		for (const job of mine) expect(registry.get(job.id).status).toBe('killed')
		// Scoped. One run tearing down must not reach into another's work.
		expect(registry.get(theirs.id).status).toBe('running')
		await registry.killOwner('run_b')
	})

	it('says `killed`, not `exited`, for a job this registry stopped', async () => {
		// Two different answers to "why did my job stop", and a reader should
		// not have to interpret a signal name to tell them apart.
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()
		const job = registry.start({ owner: OWNER, command: 'sleep 30', workingDirectory: cwd })

		const killed = await registry.kill(job.id)

		expect(killed.status).toBe('killed')
	})

	it('refuses to forget a job that is still running', async () => {
		// Forgetting a live job is exactly how it becomes an orphan: the
		// process keeps going and the id that could have killed it is gone.
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()
		const job = registry.start({ owner: OWNER, command: 'sleep 30', workingDirectory: cwd })

		expect(() => registry.forget(job.id)).toThrow(/still running/)

		await registry.kill(job.id)
		registry.forget(job.id)
		expect(() => registry.get(job.id)).toThrow(UnknownBackgroundJobError)
	})
})

describe('the bounds refuse rather than adjust', () => {
	it('refuses a start past the per-owner cap', async () => {
		const registry = new BackgroundJobRegistry({ maxJobsPerOwner: 2 })
		const cwd = await workdir()
		registry.start({ owner: OWNER, command: 'sleep 30', workingDirectory: cwd })
		registry.start({ owner: OWNER, command: 'sleep 30', workingDirectory: cwd })

		// Not queued. A queue would accept the call and start the work against
		// a run that has since ended, having told the model it was running.
		expect(() =>
			registry.start({ owner: OWNER, command: 'sleep 30', workingDirectory: cwd }),
		).toThrow(BackgroundJobLimitError)

		await registry.killOwner(OWNER)
	})

	it('counts the cap per owner, not globally', async () => {
		// One run spawning a hundred watchers must not be able to refuse a
		// different run its first.
		const registry = new BackgroundJobRegistry({ maxJobsPerOwner: 1 })
		const cwd = await workdir()
		registry.start({ owner: OWNER, command: 'sleep 30', workingDirectory: cwd })

		const theirs = registry.start({ owner: 'run_b', command: 'sleep 30', workingDirectory: cwd })

		expect(theirs.status).toBe('running')
		await registry.killOwner(OWNER)
		await registry.killOwner('run_b')
	})

	it('frees a slot when a job ends', async () => {
		const registry = new BackgroundJobRegistry({ maxJobsPerOwner: 1 })
		const cwd = await workdir()
		const first = registry.start({ owner: OWNER, command: 'exit 0', workingDirectory: cwd })
		await waitFor(() => registry.get(first.id).status === 'exited')

		expect(() =>
			registry.start({ owner: OWNER, command: 'exit 0', workingDirectory: cwd }),
		).not.toThrow()
	})

	it('throws a named error for an id it does not know', async () => {
		const registry = new BackgroundJobRegistry()

		expect(() => registry.get('job_nope')).toThrow(UnknownBackgroundJobError)
		expect(() => registry.read('job_nope')).toThrow(UnknownBackgroundJobError)
		await expect(registry.kill('job_nope')).rejects.toThrow(UnknownBackgroundJobError)
	})
})

describe('a job does not inherit the operator credentials', () => {
	it('is scrubbed the same way the foreground path is', async () => {
		// A background job outlives the call that started it, which makes the
		// leak longer-lived than the foreground one, not smaller.
		process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-travel'
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()

		const job = registry.start({
			owner: OWNER,
			command: 'echo "[${ANTHROPIC_API_KEY:-absent}]"',
			workingDirectory: cwd,
		})
		await waitFor(() => registry.get(job.id).status === 'exited')

		expect(registry.read(job.id).chunk).toContain('[absent]')
		process.env.ANTHROPIC_API_KEY = undefined
	})
})
