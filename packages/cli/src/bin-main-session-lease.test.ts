import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DiskSessionLog, generateSessionId, isLeaseLive } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from './__fixtures__/temp-dir.js'

vi.mock('./cli.js', () => ({ runCli: async () => 0 }))

it('lets a new process claim a normally exited command’s unfinished session immediately', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-normal-exit-lease-'))
	const sessionId = generateSessionId()
	const options = {
		sessionId,
		file: join(root, `${sessionId}.jsonl`),
		sessionDir: join(root, sessionId),
	}
	try {
		const log = new DiskSessionLog(options)
		const held = await log.claim({ holder: 'unfinished-cleanup', ttlMs: 300_000 })
		expect(held).not.toBeNull()
		expect(isLeaseLive(await log.lease(), Date.now())).toBe(true)
		const { handleTerminationSignals } = await import('./termination.js')
		// A TUI may return after its bounded close while the query still owns
		// a lease. Normal command exit must release it just as signal exit does.
		const handling = handleTerminationSignals()
		handling.dispose()
		vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
		const { main } = await import('./bin-main.js')
		await main('/fixture/bin.js')
		expect(process.exit).toHaveBeenCalledWith(0)
		expect(isLeaseLive(await log.lease(), Date.now())).toBe(false)

		const script = `
			const { DiskSessionLog } = await import(process.argv[1]);
			const log = new DiskSessionLog(JSON.parse(process.argv[2]));
			const lease = await log.claim({ holder: 'successor', ttlMs: 300000 });
			process.stdout.write(JSON.stringify({ claimed: lease !== null, fence: lease?.fence }));
			if (lease) await log.release(lease);
		`
		const { stdout } = await promisify(execFile)(process.execPath, [
			'--input-type=module',
			'-e',
			script,
			import.meta.resolve('@namzu/sdk'),
			JSON.stringify(options),
		])
		const successor = JSON.parse(stdout) as { claimed: boolean; fence: number }
		expect(successor.claimed).toBe(true)
		expect(successor.fence).toBeGreaterThan(held?.fence ?? 0)
		await expect(log.claim({ holder: 'late-renewal', ttlMs: 300_000 })).rejects.toMatchObject({
			name: 'SessionLeasesReleasedError',
		})
	} finally {
		removeTempDir(root)
	}
	// A real second process verifies writer admission, not a deadline race.
}, 30_000)

afterEach(() => vi.restoreAllMocks())
