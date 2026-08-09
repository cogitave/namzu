import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The two branches of the claim publish that no filesystem here can reach.
 *
 * A mutation table said so before this file existed: reverting the
 * no-hard-link refusal, and reverting the guard on a repeated scratch name,
 * each failed nothing. Neither is dead code — one is the decision that a
 * volume without hard links gets an error instead of a silently non-exclusive
 * claim, and the other is what stops a broken scratch name from reading as an
 * ordinary lost race. They are unreachable on any disk this suite can mount,
 * which per `docs/conventions/mutation-check-every-test.md` is precisely the
 * shape that hides in a green table: "the branch you never mutated, because no
 * test would have noticed either way".
 *
 * So the filesystem is faked. `vi.mock` is module-level and this suite needs
 * `link` and `writeFile` to misbehave for the whole file, which is why these
 * live apart from the other claim tests rather than beside them.
 */

let linkFails: NodeJS.ErrnoException | null = null
let writeFileFails: NodeJS.ErrnoException | null = null

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		link: async (...args: Parameters<typeof actual.link>) => {
			if (linkFails) throw linkFails
			return actual.link(...args)
		},
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			if (writeFileFails) throw writeFileFails
			return actual.writeFile(...args)
		},
	}
})

const { acquireClaim } = await import('../claim-disk.js')

function errno(code: string): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error(`mock ${code}`)
	err.code = code
	return err
}

describe('a filesystem that cannot publish a claim', () => {
	let dir: string
	let runDir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-fs-'))
		runDir = join(dir, 'run_a')
		await mkdir(runDir, { recursive: true })
		linkFails = null
		writeFileFails = null
	})

	afterEach(() => {
		linkFails = null
		writeFileFails = null
	})

	// Every code a volume without hard-link support is known to answer with,
	// plus EXDEV — which cannot come from a platform limit here, only from the
	// scratch file being moved out of the claims directory.
	for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']) {
		it(`refuses rather than degrading when link answers ${code}`, async () => {
			linkFails = errno(code)

			// Not `null`. `null` is the ordinary "somebody else holds it", and a
			// host that cannot arbitrate at all would read that as a busy queue
			// and keep polling a run it will never be able to take.
			await expect(
				acquireClaim(runDir, { holder: 'w1', ttlMs: 60_000, now: 1_000 }),
			).rejects.toThrow(/cannot publish a run claim/)
		})
	}

	it('names the code, the directory and the way out', async () => {
		linkFails = errno('ENOTSUP')

		// The refusal is only useful if it tells an operator which volume to
		// move and what the alternative is. "Unsupported operation" from deep
		// inside a claim is a bug report; this is a one-line fix.
		await expect(acquireClaim(runDir, { holder: 'w1', ttlMs: 60_000, now: 1_000 })).rejects.toThrow(
			/ENOTSUP[\s\S]*hard-link support[\s\S]*single writer per run/,
		)
	})

	it('does not swallow an error that means something else', async () => {
		// A full disk is not a missing capability, and reporting it as one
		// sends an operator to reformat a volume that was fine.
		linkFails = errno('ENOSPC')

		await expect(acquireClaim(runDir, { holder: 'w1', ttlMs: 60_000, now: 1_000 })).rejects.toThrow(
			/mock ENOSPC/,
		)
	})

	it('does not let a repeated scratch name read as a lost race', async () => {
		// EEXIST from the scratch write and EEXIST from the publish mean
		// opposite things. From the publish it means another worker took this
		// fence — ordinary, and the caller re-reads and returns `null`. From
		// the scratch write it means two publishes are sharing one scratch
		// name, which is how a claim comes to publish a body it did not write.
		// Letting it fall through would report the second as the first, and
		// `acquireClaim` would answer `null`: "somebody else holds it", for a
		// run nobody holds.
		writeFileFails = errno('EEXIST')

		await expect(acquireClaim(runDir, { holder: 'w1', ttlMs: 60_000, now: 1_000 })).rejects.toThrow(
			/scratch name .* already exists/,
		)
	})
})
