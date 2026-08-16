import { describe, expect, it } from 'vitest'

import { SpawnError, hasExecutable, runCommand, runCommandOrThrow } from '../util/spawn.js'

/**
 * `util/spawn.ts` is how every adapter in this package reaches the platform —
 * `screencapture`, `xdotool`, `grim`, PowerShell — and nothing tested it.
 *
 * Real processes, not a mocked `child_process`. The properties that matter
 * here are the ones a mock cannot have: that a byte sequence survives as
 * bytes, that a timeout actually ends a process, and above all that
 * `shell: false` means an argument holding shell metacharacters reaches the
 * program as one literal string. A stub asserting "spawn was called with
 * shell: false" would pass against a wrapper that then handed the argv to a
 * shell anyway.
 *
 * `node` is the program under test's counterpart because it is the one
 * executable this suite can assume exists.
 *
 * ## What these do NOT pin, measured rather than assumed
 *
 * Six mutations were run against `spawn.ts`; five die here. The survivor is
 * `hasExecutable`'s `result.stdout.length > 0` — replacing it with `true`
 * leaves every test green, because `which` and `where` both print the
 * resolved path whenever they exit 0, so no probe this suite can write
 * reaches the case that clause guards. It is recorded in the source as
 * undriven. The other five: `shell: false` becoming `shell: true` (12
 * failures), stdout through a utf-8 round trip, the timeout not killing,
 * stdin left open when the caller supplied none, and the `<no stderr>`
 * fallback dropped.
 */

const node = process.execPath

describe('runCommand', () => {
	it('keeps stdout as bytes and decodes stderr as text', async () => {
		// 0x00 and 0xFF do not survive a utf-8 round trip. A screenshot is
		// exactly this, several hundred thousand times over, which is why
		// stdout is a Buffer and stderr is not.
		const result = await runCommand(node, [
			'-e',
			'process.stdout.write(Buffer.from([0,255,10,0])); process.stderr.write("diagnostic")',
		])

		expect(result.exitCode).toBe(0)
		expect([...result.stdout]).toEqual([0, 255, 10, 0])
		expect(result.stderr).toBe('diagnostic')
	})

	it('reports a non-zero exit rather than throwing', async () => {
		const result = await runCommand(node, ['-e', 'process.exit(3)'])

		// The distinction `runCommandOrThrow` exists to add. A caller that
		// wants to read the code has to be able to.
		expect(result.exitCode).toBe(3)
		expect(result.timedOut).toBe(false)
	})

	it('does not interpret an argument through a shell', async () => {
		// The security property. Every adapter passes user- or model-derived
		// strings here — a window title, a typed string — and `shell: false`
		// is what stops `; rm -rf ~` from being two commands. The argument
		// arrives whole, including the metacharacters.
		const hostile = '; echo pwned > /tmp/namzu-spawn-should-not-exist; $(id)'
		const result = await runCommand(node, ['-e', 'process.stdout.write(process.argv[1])', hostile])

		expect(result.stdout.toString('utf8')).toBe(hostile)
	})

	it('writes stdin and closes it, so a reader terminates', async () => {
		const result = await runCommand(
			node,
			[
				'-e',
				'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(s.toUpperCase()))',
			],
			{ stdin: 'from the caller' },
		)

		// Without the `end()`, the child waits on a pipe nobody will close
		// and this test times out rather than failing — which is the louder
		// signature of the two.
		expect(result.stdout.toString('utf8')).toBe('FROM THE CALLER')
	})

	it('closes stdin even when the caller supplied none', async () => {
		// `resume()` because a paused stdin never reaches `end` — the child
		// has to be reading for the close to be observable at all.
		const result = await runCommand(node, [
			'-e',
			'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write("saw eof"))',
		])

		expect(result.stdout.toString('utf8')).toBe('saw eof')
	})

	it('kills a process that outlives its timeout, and says that is what happened', async () => {
		const started = Date.now()
		const result = await runCommand(node, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300 })

		expect(result.timedOut).toBe(true)
		expect(result.signal).toBe('SIGKILL')
		// Well inside the 15s default. A timeout that only fires at the
		// default would pass every assertion above it.
		expect(Date.now() - started).toBeLessThan(5_000)
	})

	it('leaves timedOut false and clears the timer for a process that finishes in time', async () => {
		const result = await runCommand(node, ['-e', 'process.stdout.write("quick")'], {
			timeoutMs: 5_000,
		})

		expect(result.timedOut).toBe(false)
		expect(result.signal).toBe(null)
	})

	it('passes cwd and env through', async () => {
		const result = await runCommand(
			node,
			['-e', 'process.stdout.write(process.env.NAMZU_SPAWN_PROBE ?? "unset")'],
			{ env: { ...process.env, NAMZU_SPAWN_PROBE: 'threaded' } },
		)

		expect(result.stdout.toString('utf8')).toBe('threaded')
	})

	it('rejects when the executable does not exist', async () => {
		// The `error` path, not the `close` path: there is no exit code to
		// report, and resolving with -1 would make "could not start" look
		// like "ran and failed".
		await expect(runCommand('namzu-no-such-binary-xyz', [])).rejects.toThrow()
	})
})

describe('runCommandOrThrow', () => {
	it('returns the result unchanged on success', async () => {
		const result = await runCommandOrThrow(node, ['-e', 'process.stdout.write("ok")'])
		expect(result.stdout.toString('utf8')).toBe('ok')
	})

	it('throws SpawnError naming the exit code and the stderr', async () => {
		const failing = runCommandOrThrow(node, [
			'-e',
			'process.stderr.write("the reason"); process.exit(2)',
		])

		await expect(failing).rejects.toThrow(SpawnError)
		await expect(failing).rejects.toThrow(/exited with code 2/)
		// The stderr is the diagnosis. A message that dropped it would send
		// the caller back to the terminal to reproduce by hand.
		await expect(failing).rejects.toThrow(/the reason/)
	})

	it('says <no stderr> rather than trailing an empty colon', async () => {
		await expect(runCommandOrThrow(node, ['-e', 'process.exit(4)'])).rejects.toThrow(/<no stderr>/)
	})

	it('distinguishes a timeout from a non-zero exit', async () => {
		const timing = runCommandOrThrow(node, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300 })

		// Both are SpawnError, and the message is the only thing that tells a
		// caller whether to retry with a longer budget or fix the command.
		await expect(timing).rejects.toThrow(/timed out after 300ms/)
		await expect(timing).rejects.not.toThrow(/exited with code/)
	})

	it('carries the failing result and argv on the error', async () => {
		try {
			await runCommandOrThrow(node, ['-e', 'process.exit(7)'])
			expect.unreachable('should have thrown')
		} catch (err) {
			expect(err).toBeInstanceOf(SpawnError)
			const spawnError = err as SpawnError
			expect(spawnError.result.exitCode).toBe(7)
			expect(spawnError.command).toBe(node)
			expect(spawnError.args).toEqual(['-e', 'process.exit(7)'])
		}
	})
})

describe('hasExecutable', () => {
	it('finds one that is on PATH', async () => {
		// `node` is running this test, so it is on PATH by construction.
		expect(await hasExecutable('node')).toBe(true)
	})

	it('answers false for one that is not, without throwing', async () => {
		// `which` exits non-zero here. The contract is a boolean, not an
		// exception — a caller probing five optional tools should not have to
		// wrap each one.
		expect(await hasExecutable('namzu-no-such-binary-xyz')).toBe(false)
	})

	it('answers false rather than throwing when the probe itself cannot run', async () => {
		// An empty name makes `which` fail differently on different systems,
		// and on some it is `runCommand` that rejects. Either way the answer
		// is false: "never throws" is the documented contract.
		await expect(hasExecutable('')).resolves.toBe(false)
	})
})
