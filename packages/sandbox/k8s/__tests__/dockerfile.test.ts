/**
 * Textual checks on `../Dockerfile` — NOT a build. Building this image
 * (Debian base pull, `apt-get install`, `docker build`) is out of reach of
 * this package's normal `pnpm --filter @namzu/sandbox test` tier the same
 * way a real Kubernetes cluster is (see `manifests.test.ts`'s own doc
 * comment for why that file only parses YAML rather than dry-running it
 * against an API server).
 *
 * What THIS file catches: the set-id-stripping step (#491's acceptance
 * criterion "`find / -xdev -perm /6000 -type f` … prints nothing") landing
 * in the wrong stage — before the packages that actually carry set-id
 * binaries are installed, for instance, where it would strip nothing and
 * still look like it passed a text-only check. A build-and-scan run
 * (`docker build` then `find` inside the built image) proves the RESULT;
 * this file proves the INSTRUCTION ORDER that result depends on, without
 * needing a working container runtime in the test environment.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCKERFILE_PATH = join(HERE, '../Dockerfile')
const DOCKERFILE = readFileSync(DOCKERFILE_PATH, 'utf8')

/** The exact command the issue's acceptance criteria and this Dockerfile's
 * own comments both name — kept as one constant so a future edit that
 * changes the flags in only one place fails this test rather than drifting
 * silently between the two. */
const SET_ID_STRIP_COMMAND = 'find / -xdev -perm /6000 -type f -exec chmod ug-s {} +'

/** The first index of a RUN instruction whose command line contains
 * `needle`, or -1. Deliberately line-based and case-sensitive — this is a
 * Dockerfile, not free text, and a RUN instruction always starts a
 * logical line even when its own body wraps with `\`. */
function indexOfRunContaining(needle: string): number {
	return DOCKERFILE.indexOf(needle)
}

describe('Dockerfile strips set-id bits (#491)', () => {
	it(`runs \`${SET_ID_STRIP_COMMAND}\``, () => {
		expect(DOCKERFILE).toContain(SET_ID_STRIP_COMMAND)
	})

	it('the set-id strip runs on its own RUN line (not chained after apt-get/useradd with &&)', () => {
		const lines = DOCKERFILE.split('\n')
		const stripLine = lines.find((line) => line.includes(SET_ID_STRIP_COMMAND))
		expect(stripLine).toBeDefined()
		expect(stripLine?.trim().startsWith('RUN ')).toBe(true)
	})

	it('runs AFTER apt-get installs util-linux/e2fsprogs (#491: "after the package … layers")', () => {
		const aptIndex = indexOfRunContaining('apt-get install')
		const stripIndex = indexOfRunContaining(SET_ID_STRIP_COMMAND)
		expect(aptIndex).toBeGreaterThan(-1)
		expect(stripIndex).toBeGreaterThan(-1)
		expect(stripIndex).toBeGreaterThan(aptIndex)
	})

	it('runs AFTER useradd/groupadd create the namzu user (#491: "after the package and user … layers")', () => {
		const useraddIndex = indexOfRunContaining('useradd')
		const stripIndex = indexOfRunContaining(SET_ID_STRIP_COMMAND)
		expect(useraddIndex).toBeGreaterThan(-1)
		expect(stripIndex).toBeGreaterThan(-1)
		expect(stripIndex).toBeGreaterThan(useraddIndex)
	})

	it('runs BEFORE the image declares its ENTRYPOINT (the last thing this image does)', () => {
		const stripIndex = indexOfRunContaining(SET_ID_STRIP_COMMAND)
		const entrypointIndex = DOCKERFILE.indexOf('ENTRYPOINT ["/entrypoint.sh"]')
		expect(entrypointIndex).toBeGreaterThan(-1)
		expect(stripIndex).toBeLessThan(entrypointIndex)
	})

	it('the header tells a derived image to repeat this exact step after its own installs', () => {
		// Not a strict string match on prose — just that the header names the
		// actual command, so a future edit to the flags cannot silently leave
		// the guidance describing a command that no longer exists.
		const headerEnd = DOCKERFILE.indexOf('ARG NODE_VERSION')
		const header = DOCKERFILE.slice(0, headerEnd === -1 ? undefined : headerEnd)
		expect(header).toMatch(/set-id/i)
		expect(header).toMatch(/repeat/i)
	})
})

describe('Dockerfile sets no image-level USER (#491)', () => {
	it('declares no `USER` instruction — sandboxtemplate-task.yaml overrides at the pod level instead', () => {
		const userInstruction = DOCKERFILE.split('\n').find((line) => /^\s*USER\b/.test(line))
		expect(userInstruction).toBeUndefined()
	})

	it('AGENT_UID/AGENT_GID default to 1001, matching the task template\'s runAsUser/runAsGroup', () => {
		expect(DOCKERFILE).toMatch(/ARG\s+AGENT_UID=1001\b/)
		expect(DOCKERFILE).toMatch(/ARG\s+AGENT_GID=1001\b/)
	})
})
