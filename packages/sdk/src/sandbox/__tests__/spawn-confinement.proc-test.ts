import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { isolationOf } from '../isolation.js'
import { LocalSandboxProvider, buildBwrapArgs } from '../provider/local.js'

/**
 * `ISOLATION_BY_ENVIRONMENT` says `linux-bwrap` enforces `filesystem`. This is
 * what makes that a measurement rather than a claim.
 *
 * The table is the load-bearing thing in this subsystem — `assertIsolation`
 * refuses a run whose required control a tier cannot supply, and every caller
 * that turns isolation on is trusting one row of it. The sibling tier is
 * exactly why: `linux-namespace` unshares a mount namespace, sounds confined,
 * and reports `filesystem: false` because the child still sees the whole host.
 * A row asserted only in a unit test would be a restatement of the table, not
 * a check on it.
 *
 * So this spawns for real, through the provider a caller uses, and asks the
 * child what it can reach. It is a `proc-test` because it needs a real process
 * and a real kernel refusal; the unit suite cannot produce either.
 *
 * **The assertion is ENOENT, not EACCES.** Under this tier a host path is not
 * present in the child's mount table at all, which is a stronger statement
 * than being unwritable and is the one the `filesystem` control promises. A
 * tier that merely made the host read-only would still leak every secret on
 * it.
 */

const dirs: string[] = []
const files: string[] = []

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
	for (const file of files.splice(0)) rmSync(file, { force: true })
})

/** Does this host actually run the tier? Reported, never silently skipped. */
function bwrapUsable(): boolean {
	if (process.platform !== 'linux') return false
	try {
		execFileSync('bwrap', [...buildBwrapArgs(tmpdir()), '--', '/bin/true'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

const usable = bwrapUsable()

describe('linux-bwrap enforces the filesystem control it declares', () => {
	it('declares filesystem, network and process isolation', () => {
		// Runs everywhere, including hosts without bwrap: the table is a
		// declaration and a wrong row should fail on any machine, not only on
		// one that can spawn the tier.
		expect(isolationOf('linux-bwrap')).toEqual({
			filesystem: true,
			network: true,
			process: true,
		})
	})

	it.runIf(usable)('cannot see a host file outside the sandbox root', async () => {
		// Written OUTSIDE the sandbox, by this process, so the file certainly
		// exists and certainly is readable by this user. Anything the child
		// reports about it is the sandbox's doing and nothing else's.
		const outside = mkdtempSync(join(tmpdir(), 'namzu-outside-'))
		dirs.push(outside)
		const secret = join(outside, 'secret.txt')
		writeFileSync(secret, 'host-only')

		const provider = new LocalSandboxProvider(NOOP_LOGGER)
		const sandbox = await provider.create()
		try {
			expect(sandbox.environment).toBe('linux-bwrap')

			const read = await sandbox.exec('sh', ['-c', `cat ${secret} 2>&1`])
			expect(read.exitCode).not.toBe(0)
			// Absent, not merely unreadable — see this file's header.
			expect(`${read.stdout}${read.stderr}`).toMatch(/No such file or directory/)
			expect(`${read.stdout}${read.stderr}`).not.toContain('host-only')
		} finally {
			await sandbox.destroy()
		}
	})

	it.runIf(usable)('cannot write outside the sandbox root', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'namzu-outside-'))
		dirs.push(outside)
		const target = join(outside, 'written-by-sandbox.txt')

		const provider = new LocalSandboxProvider(NOOP_LOGGER)
		const sandbox = await provider.create()
		try {
			const write = await sandbox.exec('sh', ['-c', `echo escaped > ${target} 2>&1`])
			expect(write.exitCode).not.toBe(0)
			// Checked on the HOST, not from the child's report. A child that
			// wrote and then lied about it would satisfy an exit-code
			// assertion on its own.
			expect(() => execFileSync('cat', [target], { stdio: 'ignore' })).toThrow()
		} finally {
			await sandbox.destroy()
		}
	})

	it.runIf(usable)('exposes no host mount beyond the paths it binds on purpose', async () => {
		// The assertion the two above cannot make. They prove ONE host path is
		// absent, which a change that mounted the host somewhere ELSE would
		// still satisfy — caught by mutation: binding `/` at `/host` left both
		// of them green while every secret on the machine was readable one
		// directory over.
		//
		// The set is the check. Anything newly mounted shows up here as a
		// top-level entry nobody listed, whatever it is called.
		const provider = new LocalSandboxProvider(NOOP_LOGGER)
		const sandbox = await provider.create()
		try {
			const listing = await sandbox.exec('sh', ['-c', 'ls -1 /'])
			const seen = listing.stdout.trim().split('\n').filter(Boolean).sort()
			// Derived, not hard-coded. The tier binds the interpreter's own
			// prefix, which on a home-directory install puts a `home` at the
			// root — legitimately. Writing that into a literal list would let
			// the NEXT unintended bind under the same top-level name through,
			// which is the failure this test exists to catch.
			const systemTops = ['bin', 'dev', 'etc', 'lib', 'lib64', 'opt', 'proc', 'sbin', 'tmp', 'usr']
			const interpreterTop = dirname(dirname(realpathSync(process.execPath))).split('/')[1]
			const allowed = new Set([...systemTops, ...(interpreterTop ? [interpreterTop] : [])])
			expect(seen.filter((entry) => !allowed.has(entry))).toEqual([])
			// And not vacuous: a child that saw nothing at all would pass the
			// line above.
			expect(seen).toContain('usr')

			// The top-level name being allowed does not make the whole tree
			// allowed. A file in the user's home but OUTSIDE the interpreter
			// prefix has to stay unreachable, or "bind the runtime" has
			// quietly become "bind the home directory".
			const homeSecret = join(homedir(), `.namzu-confinement-probe-${process.pid}`)
			writeFileSync(homeSecret, 'home-only')
			files.push(homeSecret)
			const reach = await sandbox.exec('sh', ['-c', `cat ${homeSecret} 2>&1`])
			expect(`${reach.stdout}${reach.stderr}`).not.toContain('home-only')
		} finally {
			await sandbox.destroy()
		}
	})

	it.runIf(usable)('can still read and write inside the sandbox root', async () => {
		// The other half, and the one that makes the tier usable rather than
		// merely safe: a confinement that also blocked the workspace would
		// pass every assertion above and be worthless.
		const provider = new LocalSandboxProvider(NOOP_LOGGER)
		const sandbox = await provider.create()
		try {
			const result = await sandbox.exec('sh', ['-c', 'echo inside > f.txt && cat f.txt'])
			expect(result.exitCode).toBe(0)
			expect(result.stdout.trim()).toBe('inside')
		} finally {
			await sandbox.destroy()
		}
	})

	it('says so when this host cannot run the tier, rather than passing quietly', () => {
		// A `runIf` that silences three tests leaves a green suite that
		// measured nothing, and the greenness is indistinguishable from
		// coverage. This one line is the difference.
		if (!usable) {
			// biome-ignore lint/suspicious/noConsole: the announcement IS the assertion — a skipped confinement test that says nothing is a green suite that measured nothing
			console.warn(
				'spawn-confinement: bwrap unavailable on this host — the three confinement tests did not run.',
			)
		}
		expect(typeof usable).toBe('boolean')
	})
})
