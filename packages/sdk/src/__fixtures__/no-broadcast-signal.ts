import { afterEach } from 'vitest'

/**
 * Vitest `setupFiles` entry (unit suite only): a test must never signal pid 1
 * or a group of pid 1 or 0.
 *
 * `process.kill(-1, sig)` signals every process the user may signal and
 * `process.kill(0, sig)` the caller's own process group. A fake pid of 1
 * reaching a real kill takes down the runner itself, and a code path that
 * swallows the error (as the kill helpers do, for a group that is already gone)
 * would hide it. So the call is recorded and NOT forwarded, and the test that
 * made it fails in `afterEach`, where nothing can catch the error.
 *
 * The wrapper wraps whatever `process.kill` is at setup, so a test's own
 * `vi.spyOn(process, 'kill')` still sits on top of it and is restored to it.
 */
const forwarded = process.kill.bind(process)
const attempts: string[] = []

process.kill = ((pid: number, signal?: string | number): true => {
	const target = Math.abs(pid)
	if (typeof pid !== 'number' || !(target > 1)) {
		attempts.push(`process.kill(${String(pid)}, ${String(signal)})`)
		return true
	}
	return forwarded(pid, signal)
}) as typeof process.kill

afterEach(() => {
	if (attempts.length === 0) return
	const seen = attempts.splice(0).join(', ')
	throw new Error(
		`A test signalled pid 0 or 1, which addresses every process of the user or the runner's own group: ${seen}`,
	)
})
