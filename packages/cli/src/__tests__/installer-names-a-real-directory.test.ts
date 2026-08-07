/**
 * When `install.sh` cannot find `namzu` on PATH, the directory it names holds
 * the binary.
 *
 * The installer's whole argument is that it verifies rather than assumes — it
 * refuses to trust the package manager's exit code and checks that the binary
 * answers. One place did the opposite: the "not on PATH" message hard-coded
 * `$NAMZU_PREFIX/bin`, which is correct only on the FALLBACK branch, while the
 * check runs after both. So a successful GLOBAL install that was not on PATH
 * sent the operator to a directory holding zero files while the four files sat
 * somewhere else.
 *
 * It fires for exactly the person the message exists for: anyone whose npm
 * global bin is not already on PATH, which is the normal state under a version
 * manager and common on Windows. The install worked, the instruction was wrong,
 * and the reasonable conclusion is that the installer is broken.
 *
 * Asserting the exit code, or that the words "not on PATH" appear, passes with
 * the defect present. The assertion has to be that the named directory CONTAINS
 * the binary, which is the only claim the message actually makes.
 *
 * ## Why the scenario is a shell script rather than inline here
 *
 * It builds a stub `npm`, a PATH, and two directories, then reads the message
 * back — all of it POSIX-shaped. Driving that from Node means marshalling
 * Windows paths into a `sh` script and a `:`-separated PATH whose entries
 * contain drive-letter colons, which is how the first version of this test
 * failed with no output at all. The fixture runs in the environment it is
 * about; this file runs the fixture.
 *
 * Verified in both directions before landing: exit 1 against the installer as
 * it was, exit 0 against the fix.
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const INSTALLER = join(REPO_ROOT, 'install.sh')
const SCENARIO = join(import.meta.dirname, '__fixtures__', 'installer-not-on-path.sh')

/**
 * `sh` is required, not optional.
 *
 * Probed so the reporter says "skipped" on a machine without it rather than
 * "passed" — a test that reports green having run nothing is the failure this
 * repository keeps finding. CI is Linux and always takes the real path, so the
 * check always runs where it decides anything.
 */
function hasSh(): boolean {
	try {
		execFileSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

describe.skipIf(!hasSh())('install.sh, when the binary is not on PATH', () => {
	it('names a directory that actually contains the binary', () => {
		// The fixture simulates a SUCCESSFUL GLOBAL install whose bin directory
		// is not on PATH, with a stub npm — no network, no touching the real
		// global prefix. It exits non-zero when the named directory does not
		// hold `namzu`, and prints both locations when it does not.
		let output = ''
		let status = 0
		try {
			output = execFileSync('sh', [SCENARIO, INSTALLER], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			})
		} catch (err) {
			const e = err as { status?: number; stdout?: string; stderr?: string }
			status = e.status ?? -1
			output = `${e.stdout ?? ''}${e.stderr ?? ''}`
		}

		expect(status, output).toBe(0)
		expect(output).toContain('RESULT: PASS')
	})
})
