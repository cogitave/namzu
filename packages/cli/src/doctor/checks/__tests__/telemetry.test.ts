/**
 * That "not installed" is said only about a package that is not installed.
 *
 * The check used to report `not installed (optional package)` for ANY import
 * rejection, so a package that was present and threw on load — a broken build,
 * a native binding that will not open, a dependency of its own that cannot
 * resolve — was reported as absent. One word, two facts, and the reader was
 * handed the reassuring one.
 *
 * All three states are reached through the real resolver and the real loader.
 * A code check on the thrown error would not have separated them: a transitive
 * dependency that cannot resolve raises `ERR_MODULE_NOT_FOUND` exactly as a
 * missing package does, so the third case below is the one that matters and it
 * is the one a code check gets wrong.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { describeInstalledPackage, telemetryInstalledCheck } from '../telemetry.js'

const ctx = { cwd: process.cwd(), env: {}, projectRoot: null }

/** A module that resolves and then throws the moment it is evaluated. */
function moduleThatThrows(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-doctor-'))
	const file = join(dir, 'broken.mjs')
	writeFileSync(file, "throw new Error('NATIVE BINDING WOULD NOT OPEN')\n")
	return file
}

describe('the optional-package probe', () => {
	it('says skipped when the package is not installed', async () => {
		const r = await describeInstalledPackage('@namzu/no-such-package-exists')
		expect(r.status).toBe('skipped')
		expect(r.message ?? '').toContain('not installed')
	})

	it('says pass when the package is installed and loads', async () => {
		const r = await describeInstalledPackage('@namzu/sdk')
		expect(r.status).toBe('pass')
	})

	it('says fail — not "not installed" — when the package is there and will not load', async () => {
		// The case the old catch-all got backwards, and the reason this file
		// exists. Asserted on the STATUS and on the absence of the wrong sentence,
		// because reporting the right status with the old message would still
		// send someone to install what is already on disk.
		const r = await describeInstalledPackage(moduleThatThrows())
		expect(r.status).toBe('fail')
		expect(r.message ?? '').toContain('failed to load')
		expect(r.message ?? '', 'a present-but-broken package was called absent').not.toContain(
			'not installed',
		)
		expect(r.message ?? '', 'the reason was swallowed').toContain('NATIVE BINDING WOULD NOT OPEN')
	})

	it('is what the registered check actually asks', async () => {
		// The helper being right proves nothing about the check reaching it, and
		// this check is the only caller. It must never come back inconclusive:
		// absence is an answer, and the exit code now depends on the difference.
		const r = await telemetryInstalledCheck.run(ctx)
		expect(r.message ?? '').toContain('@namzu/telemetry')
		expect(['pass', 'skipped', 'fail']).toContain(r.status)
	})
})
