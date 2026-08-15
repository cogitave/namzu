import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../__fixtures__/temp-dir.js'
import {
	SkillRegistry,
	configureLogger,
	discoverSkills,
	loadSkill,
	resolveSkillChain,
} from '../../index.js'

/**
 * `loadSkill`, `discoverSkills`, `SkillRegistry.registerAll` and
 * `resolveSkillChain` used to resolve their logger at module scope
 * (`skills/loader.ts:12`, `skills/registry.ts:10`), and `child()` bakes
 * `minLevel` into a closure at the moment it runs — see `utils/logger.ts`.
 * This package's `test-setup.ts` calls `configureLogger({ level: 'silent' })`
 * from `setupFiles`, which runs BEFORE a test file's own imports resolve the
 * modules under test — so under the old code the frozen level was always
 * 'silent', and no `configureLogger()` call afterwards, from a test or from
 * a host application, could ever reach it.
 *
 * Imports below go through `../../index.js` — the package's own public
 * barrel — rather than a direct relative import, because the property
 * under test is specifically about surviving barrel-import order: a host
 * consumes the barrel, and the barrel's import graph is what froze these
 * loggers before `configureLogger()` ever got a chance to run.
 *
 * `process.stderr.write` is intercepted by direct reassignment with manual
 * restore, matching `packages/cli/src/output/formatter.test.ts` — not
 * `vi.spyOn`, since that is the established idiom here for capturing
 * stream writes.
 *
 * Four `it` blocks, one per fixed call site, so a partial revert of any
 * ONE of the four is caught precisely rather than reading as "some fix is
 * missing":
 *   1. registerAll — against a real, existing, empty directory (the
 *      literal reading of "empty directory"). Its debug call is
 *      unconditional after the discovery loop.
 *   2. discoverSkills — against a directory that was never created; its
 *      one debug call lives in the readdir-throws catch branch. (An
 *      existing-but-empty directory produces no log from this function at
 *      all — readdir succeeds with [], the loop body never runs — which is
 *      why scenario 1 uses registerAll instead.)
 *   3. loadSkill — needs a REAL SKILL.md to succeed at all; an empty
 *      directory throws in readFile before ever reaching its debug call.
 *      Writes one with mkdir+writeFile, mirroring skills/loader.test.ts's
 *      own writeSkill helper.
 *   4. resolveSkillChain — called with (undefined, undefined, 'metadata').
 *      Per registry.ts, passing undefined for both directories skips
 *      registerAll entirely, so this isolates resolveSkillChain's own
 *      unconditional final debug call from registerAll's, with zero
 *      filesystem I/O.
 */
describe('skill loader logger reachability', () => {
	let stderr: string
	let originalStderrWrite: typeof process.stderr.write
	let root: string

	beforeEach(async () => {
		stderr = ''
		originalStderrWrite = process.stderr.write.bind(process.stderr)
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
			return true
		}) as typeof process.stderr.write
		root = await mkdtemp(join(tmpdir(), 'namzu-skills-logger-'))
	})

	afterEach(async () => {
		process.stderr.write = originalStderrWrite
		configureLogger({ level: 'silent' })
		await removeTempDirAsync(root)
	})

	it('SkillRegistry.registerAll against an empty directory is reachable by a later configureLogger', async () => {
		configureLogger({ level: 'debug' })
		await new SkillRegistry().registerAll(root)
		expect(stderr).toContain('Registered skills from directory')

		stderr = ''
		configureLogger({ level: 'silent' })
		await new SkillRegistry().registerAll(root)
		expect(stderr).not.toContain('Registered skills from directory')
	})

	it('discoverSkills against a missing directory is reachable by a later configureLogger', async () => {
		const missing = join(root, 'does-not-exist')

		configureLogger({ level: 'debug' })
		await discoverSkills(missing)
		expect(stderr).toContain('Skills directory not found')

		stderr = ''
		configureLogger({ level: 'silent' })
		await discoverSkills(missing)
		expect(stderr).not.toContain('Skills directory not found')
	})

	it('loadSkill is reachable by a later configureLogger', async () => {
		const dir = join(root, 'reachability-skill')
		await mkdir(dir, { recursive: true })
		await writeFile(
			join(dir, 'SKILL.md'),
			[
				'---',
				'name: reachability-skill',
				'description: Proves loadSkill logs at call time, not at import time.',
				'---',
				'Body.',
				'',
			].join('\n'),
			'utf8',
		)

		configureLogger({ level: 'debug' })
		await loadSkill(dir, 'metadata')
		expect(stderr).toContain('Loaded skill')

		stderr = ''
		configureLogger({ level: 'silent' })
		await loadSkill(dir, 'metadata')
		expect(stderr).not.toContain('Loaded skill')
	})

	it('resolveSkillChain is reachable by a later configureLogger', async () => {
		configureLogger({ level: 'debug' })
		await resolveSkillChain(undefined, undefined, 'metadata')
		expect(stderr).toContain('Resolved skill chain')

		stderr = ''
		configureLogger({ level: 'silent' })
		await resolveSkillChain(undefined, undefined, 'metadata')
		expect(stderr).not.toContain('Resolved skill chain')
	})
})
