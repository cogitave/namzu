import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { BackgroundJobRegistry, bindOwner } from '../../../runtime/jobs/registry.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'
import { JobTool } from '../job.js'

/**
 * A background job belongs to the run that started it.
 *
 * The scoping is structural, not a check: the executor binds the owner
 * before a tool ever sees the registry, so there is no argument a tool could
 * pass to reach another run's jobs. These prove that the binding is what is
 * actually in force, and that `bash` refuses rather than degrading when no
 * registry is there.
 *
 * Process-level because the properties are about real processes.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-jobtool-'))
	dirs.push(dir)
	return dir
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error('timed out')
		await settle(25)
	}
}

function contextFor(
	registry: BackgroundJobRegistry | undefined,
	runId: string,
	cwd: string,
): ToolContext {
	return {
		runId: runId as RunId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...(registry ? { backgroundJobs: bindOwner(registry, runId, { workingDirectory: cwd }) } : {}),
	}
}

describe('bash refuses to background when the host offers nowhere to put it', () => {
	it('says so rather than falling back to `cmd &`', async () => {
		// The fallback is not a lesser version of this. Under the sandbox's
		// `linux-namespace` tier the shell that backgrounds the work is PID 1
		// of a fresh PID namespace, so the job dies as that shell exits — in
		// milliseconds, on the successful path, looking like it worked.
		const cwd = await workdir()

		const result = await BashTool.execute(
			{ command: 'sleep 5', timeout: 1000, run_in_background: true },
			contextFor(undefined, 'run_x', cwd),
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/no background job registry/i)
	})

	it('still runs an ordinary foreground command with no registry', async () => {
		// The refusal is scoped to the request that cannot be honoured.
		const cwd = await workdir()

		const result = await BashTool.execute(
			{ command: 'echo hello', timeout: 5000 },
			contextFor(undefined, 'run_x', cwd),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('hello')
	})
})

describe('bash and job are one capability', () => {
	it('hands back an id the job tool can read', async () => {
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()
		const context = contextFor(registry, 'run_a', cwd)

		const started = await BashTool.execute(
			{ command: 'echo working; sleep 0.3; echo done', timeout: 1000, run_in_background: true },
			context,
		)
		const jobId = (started.data as { jobId: string }).jobId

		await waitFor(() => registry.get(jobId).status === 'exited')
		const read = await JobTool.execute({ action: 'read', id: jobId }, context)

		expect(started.success).toBe(true)
		expect(read.output).toContain('working')
		expect(read.output).toContain('done')
		expect(read.output).toMatch(/exited with code 0/)
	})

	it('reads only what is new when handed back its own next_offset', async () => {
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()
		const context = contextFor(registry, 'run_a', cwd)
		const started = await BashTool.execute(
			{ command: 'echo first; sleep 0.3; echo second', timeout: 1000, run_in_background: true },
			context,
		)
		const jobId = (started.data as { jobId: string }).jobId

		await waitFor(() => registry.read(jobId).chunk.includes('first'))
		const first = await JobTool.execute({ action: 'read', id: jobId }, context)
		const offset = (first.data as { nextOffset: number }).nextOffset
		await waitFor(() => registry.get(jobId).status === 'exited')
		const second = await JobTool.execute(
			{ action: 'read', id: jobId, from_offset: offset },
			context,
		)

		// A poller that re-read the whole buffer every tick would show the
		// model the same build failure four times.
		expect(second.output).not.toContain('first')
		expect(second.output).toContain('second')
	})

	it('lists the jobs of this run and stops one on request', async () => {
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()
		const context = contextFor(registry, 'run_a', cwd)
		const started = await BashTool.execute(
			{ command: 'sleep 30', timeout: 1000, run_in_background: true },
			context,
		)
		const jobId = (started.data as { jobId: string }).jobId

		const listed = await JobTool.execute({ action: 'list' }, context)
		expect(listed.output).toContain(jobId)

		const killed = await JobTool.execute({ action: 'kill', id: jobId }, context)
		expect(killed.output).toMatch(/killed/)
	})

	it('states the number of bytes it dropped, not merely that it dropped some', async () => {
		// The count is the actionable half. "Some output was dropped" leaves
		// the model unable to tell a truncated tail from a truncated build.
		const registry = new BackgroundJobRegistry({ maxOutputBytesPerJob: 200 })
		const cwd = await workdir()
		const context = contextFor(registry, 'run_a', cwd)
		const started = await BashTool.execute(
			{
				command: 'for i in $(seq 1 400); do echo "line $i"; done',
				timeout: 1000,
				run_in_background: true,
			},
			context,
		)
		const jobId = (started.data as { jobId: string }).jobId
		await waitFor(() => registry.get(jobId).status === 'exited')

		const read = await JobTool.execute({ action: 'read', id: jobId }, context)
		const dropped = (read.data as { droppedBytes: number }).droppedBytes

		expect(dropped).toBeGreaterThan(0)
		expect(read.output).toContain(`${dropped} bytes were dropped`)
	})

	it('refuses read and kill without an id, and names the way out', async () => {
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()
		const context = contextFor(registry, 'run_a', cwd)

		const result = await JobTool.execute({ action: 'read' }, context)

		expect(result.success).toBe(false)
		expect(result.error).toContain('list')
	})
})

describe('one run cannot reach the job of another run', () => {
	it('reads as unknown, not as forbidden', async () => {
		// The same answer the tenant checks give elsewhere in this tree, and
		// for the same reason: refusing would confirm the job is there.
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()
		const mine = contextFor(registry, 'run_a', cwd)
		const theirs = contextFor(registry, 'run_b', cwd)

		const started = await BashTool.execute(
			{ command: 'sleep 30', timeout: 1000, run_in_background: true },
			mine,
		)
		const jobId = (started.data as { jobId: string }).jobId

		const read = await JobTool.execute({ action: 'read', id: jobId }, theirs)
		const killed = await JobTool.execute({ action: 'kill', id: jobId }, theirs)

		expect(read.success).toBe(false)
		expect(read.error).toMatch(/No background job/)
		expect(killed.success).toBe(false)
		// And it is still running: the refusal was not a partial success.
		expect(registry.get(jobId).status).toBe('running')
		await registry.killOwner('run_a')
	})

	it('lists nothing for a run that started nothing', async () => {
		const registry = new BackgroundJobRegistry()
		const cwd = await workdir()
		await BashTool.execute(
			{ command: 'sleep 30', timeout: 1000, run_in_background: true },
			contextFor(registry, 'run_a', cwd),
		)

		const listed = await JobTool.execute({ action: 'list' }, contextFor(registry, 'run_b', cwd))

		expect(listed.output).toBe('No background jobs.')
		await registry.killOwner('run_a')
	})
})

describe('the per-owner cap reaches the model as a refusal it can act on', () => {
	it('names the limit rather than failing generically', async () => {
		const registry = new BackgroundJobRegistry({ maxJobsPerOwner: 1 })
		const cwd = await workdir()
		const context = contextFor(registry, 'run_a', cwd)
		await BashTool.execute({ command: 'sleep 30', timeout: 1000, run_in_background: true }, context)

		const second = await BashTool.execute(
			{ command: 'sleep 30', timeout: 1000, run_in_background: true },
			context,
		)

		expect(second.success).toBe(false)
		expect(second.error).toMatch(/kill one before starting another/)
		await registry.killOwner('run_a')
	})
})
