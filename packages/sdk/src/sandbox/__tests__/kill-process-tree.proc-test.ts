import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { SANDBOX_KILL_GRACE_MS } from '../../constants/sandbox/index.js'
import { getRootLogger } from '../../utils/logger.js'
import { LocalSandboxProvider } from '../provider/local.js'

/**
 * `spawnProcess` killed only the outermost wrapper pid on cancel. Every
 * caller reaches it through `/bin/sh -c "cmd"` (bash.ts) and, on this
 * class's own `linux-namespace` isolation tier, that shell is wrapped
 * again in `unshare` (`buildLimitedSpawn`). Either way, `child.pid` names
 * the wrapper — `cmd`, and anything it forked, ran on past both the
 * caller's abort and the grace-period SIGKILL, orphaned rather than
 * stopped, and in the common case where the shell forks a real child the
 * orphan kept `child`'s own stdio pipes open, so `sandbox.exec()` itself
 * never resolved at all.
 *
 * This runs a real process tree and checks the OS's own view of it after
 * the kill, because a stub asserting "kill was called with -pid" would
 * pass against code that still targeted the wrong pid — the bug was never
 * "no kill happens", it is "the wrong process receives it". That is
 * exactly what a real spawn is needed to observe, which is why this lives
 * in the proc suite (`vitest.proc.config.ts`) rather than beside
 * `exec-cancellation.test.ts` in the unit one.
 *
 * The held process's presence is checked via a unique token in its OWN
 * argv, read back with `pgrep -f` from the HOST's process table —
 * deliberately not via the held process's self-reported `process.pid`.
 * On a host where `LocalSandboxProvider` selects the `linux-namespace`
 * tier (unprivileged `unshare --pid` succeeds — true in this repo's own
 * dev container and on many WSL2/modern-Linux boxes), the command runs
 * inside a fresh PID namespace and only knows its OWN namespace-local pid
 * (observed as 1 or 2), which names an unrelated, always-alive, host
 * process when read from outside. `pgrep -f`, run from this process, sees
 * every descendant in the host's own table regardless of which PID
 * namespace it lives in, so it is not fooled by that.
 *
 * POSIX only. Windows has no process-group id to sign a `-pid` kill with —
 * `killTree` falls back to `taskkill /T` there instead — and CI's Build &
 * Test job runs ubuntu-latest exclusively, so there is no Windows leg this
 * would run under anyway.
 *
 * ## What these three do NOT pin, measured rather than assumed
 *
 * Mutating the SIGKILL site alone — `killTree(child, 'SIGKILL')` back to
 * `child.kill('SIGKILL')` — survives all three, including the
 * SIGTERM-ignoring case below that exists to catch exactly it. That is not
 * a gap in the assertions; it is the `linux-namespace` tier making the
 * mutation unobservable. The group SIGTERM reaches the wrapping shell, that
 * shell is PID 1 of the fresh PID namespace `unshare --pid --fork` created,
 * and the kernel tears the whole namespace down when its init exits —
 * taking the stubborn descendant with it regardless of where the later
 * SIGKILL was addressed.
 *
 * So that site's tree-addressing is load-bearing only on the `basic` tier,
 * where there is no namespace to collapse, and this suite cannot select a
 * tier: `LocalSandboxProvider` detects one at construction. Pinning it would
 * need a host that fails the `unshare` probe. Recorded here rather than
 * left for the next reader to rediscover, and rather than implied to be
 * covered when it is not.
 */
const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs) removeTempDir(dir)
	dirs.length = 0
})

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-killtree-'))
	dirs.push(dir)
	return dir
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * True while a process whose argv contains `token` is still alive, as seen
 * from this process's own view of the HOST process table. See the file
 * docstring for why this — and not the held process's self-reported pid —
 * is what makes the assertion below mean anything under every isolation
 * tier `LocalSandboxProvider` can select.
 */
function isRunning(token: string): boolean {
	return survivors(token).length > 0
}

/**
 * The full command line of everything still matching `token`, so a failure
 * NAMES what outlived the kill instead of asserting `true` was `false`.
 *
 * **`spawnSync`, not `execSync`, and that is the whole reason this suite
 * ever went red.** `execSync` runs its argument through `/bin/sh -c`, which
 * puts the token in that SHELL's own argv — and `pgrep -f` matches on the
 * full command line, excluding only its own pid. Whether the shell is still
 * there to be matched depends on the shell: `bash` exec-replaces itself with
 * a lone simple command, so nothing is left and the probe answers honestly;
 * `dash` (which is `/bin/sh` on ubuntu-latest, and so in CI) does not, so the
 * probe matched ITSELF and every one of these three tests failed on a kill
 * that had worked perfectly.
 *
 * `spawnSync` takes argv directly. There is no shell, so there is nothing
 * holding the token but the processes this test is actually asking about.
 * Verified both ways: under a `/bin/sh` that does not exec-optimize, the
 * `execSync` form returns one phantom match and this form returns none.
 *
 * `-a` rather than a bare pid list: which process survived is the whole
 * diagnosis. A wrapping shell left behind says the group signal never
 * reached past the leader; the held `node` says it reached nothing at all.
 */
function survivors(token: string): string[] {
	// pgrep exits 1 when nothing matched, which is the ordinary "all gone"
	// answer — so the status is not read, only the output.
	const found = spawnSync('pgrep', ['-af', token], { encoding: 'utf-8' })
	return (found.stdout ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
}

describe.skipIf(process.platform === 'win32')('cancelling a sandboxed shell command', () => {
	it('kills the process the shell launched, not just the shell', async () => {
		const dir = tempDir()
		const token = `namzu-killtree-${process.pid}-${Date.now()}`

		// A held-open process the shell launches. The token is passed as a
		// plain CLI arg purely so it lands in this process's argv, where
		// `pgrep -f` can find it from the host side.
		const script = join(dir, 'hold.js')
		writeFileSync(script, 'setInterval(() => {}, 1000)')

		const provider = new LocalSandboxProvider(getRootLogger())
		const sandbox = await provider.create()
		const controller = new AbortController()

		// A trailing `; true` stops `sh` from exec-replacing itself with
		// `node` as a tail-call optimization for a lone last command — some
		// `/bin/sh` implementations do that, which would make the shell and
		// `node` the SAME os process and prove nothing about killing a tree.
		const running = sandbox.exec('/bin/sh', ['-c', `node ${script} ${token}; true`], {
			timeout: 60_000,
			signal: controller.signal,
		})

		while (!isRunning(token)) {
			await sleep(20)
		}

		controller.abort()
		// Against the bug this replaces, `running` can hang forever here —
		// the orphaned descendant keeps `child`'s own stdio pipe open, so
		// `close` never fires. That is a stronger failure signature than a
		// wrong assertion, and it is exactly the second half of what this
		// patch fixes.
		await running

		// Room for the grace-period SIGKILL to land even if SIGTERM alone
		// did not finish the job.
		await sleep(SANDBOX_KILL_GRACE_MS + 1_000)

		expect(survivors(token)).toEqual([])

		await sandbox.destroy()
	}, 30_000)

	it('reaches the tree with the SIGTERM, not only with the grace-period SIGKILL', async () => {
		// The test above deliberately allows the grace period to elapse, so it
		// passes whenever EITHER kill site reaches the group — the two are an
		// escalation pair and each alone finishes the job. That makes it blind
		// to a mutation of one site: replacing only the SIGTERM `killTree` with
		// `child.kill` survives it, because the SIGKILL three seconds later
		// still catches the tree.
		//
		// Three seconds of a wedged turn is the difference this pins down. The
		// descendant has to be gone WELL inside the grace period, which is only
		// true if the first signal was addressed to the group.
		const dir = tempDir()
		const token = `namzu-killtree-term-${process.pid}-${Date.now()}`
		const script = join(dir, 'hold.js')
		writeFileSync(script, 'setInterval(() => {}, 1000)')

		const provider = new LocalSandboxProvider(getRootLogger())
		const sandbox = await provider.create()
		const controller = new AbortController()

		const running = sandbox.exec('/bin/sh', ['-c', `node ${script} ${token}; true`], {
			timeout: 60_000,
			signal: controller.signal,
		})

		while (!isRunning(token)) {
			await sleep(20)
		}

		const abortedAt = Date.now()
		controller.abort()

		// Polled rather than awaiting `running` first: under the single-site
		// mutation `running` itself does not settle until the SIGKILL lands,
		// so awaiting it would spend the very interval being measured.
		while (isRunning(token) && Date.now() - abortedAt < SANDBOX_KILL_GRACE_MS) {
			await sleep(20)
		}
		const elapsed = Date.now() - abortedAt

		expect(survivors(token), 'the descendant outlived the SIGTERM').toEqual([])
		expect(elapsed, 'the tree only died once the grace period expired').toBeLessThan(
			SANDBOX_KILL_GRACE_MS,
		)

		await running
		await sandbox.destroy()
	}, 30_000)

	it('reaches a SIGTERM-ignoring descendant with the grace-period SIGKILL', async () => {
		// The remaining single-site mutation: the SIGKILL `killTree` can be
		// swapped for `child.kill` and both tests above still pass, because a
		// descendant that honours SIGTERM is already gone before the grace
		// period ends. The backstop exists for the process that does NOT
		// honour it, and if that signal only reaches the wrapper, such a
		// process is not killed late — it is never killed at all.
		const dir = tempDir()
		const token = `namzu-killtree-kill9-${process.pid}-${Date.now()}`
		const script = join(dir, 'stubborn.js')
		// Ignores SIGTERM outright. SIGKILL cannot be trapped, so the only
		// thing that ends this is a SIGKILL that actually reaches it.
		writeFileSync(script, "process.on('SIGTERM', () => {})\nsetInterval(() => {}, 1000)")

		const provider = new LocalSandboxProvider(getRootLogger())
		const sandbox = await provider.create()
		const controller = new AbortController()

		const running = sandbox.exec('/bin/sh', ['-c', `node ${script} ${token}; true`], {
			timeout: 60_000,
			signal: controller.signal,
		})

		while (!isRunning(token)) {
			await sleep(20)
		}

		controller.abort()
		await running
		await sleep(SANDBOX_KILL_GRACE_MS + 1_000)

		expect(survivors(token), 'a SIGTERM-ignoring descendant survived the kill').toEqual([])

		await sandbox.destroy()
	}, 30_000)
})
