import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sandbox } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import { createSkillDirectoryResolver } from './directory.js'

/**
 * Which directory the CLI tells the model it can open for a skill (#536): the
 * real one on the host, the mounted one in the sandbox, and none for a skill
 * the sandbox does not mount — never a host path the sandbox refuses.
 */

let root: string
let project: string
let home: string
let added: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-skill-dir-'))
	project = join(root, 'project')
	home = join(root, 'home')
	added = join(root, 'added')
	for (const dir of [
		join(project, '.agents', 'skills', 'release-notes'),
		join(home, '.namzu', 'skills', 'house-style'),
		join(added, 'skills', 'shared'),
	])
		mkdirSync(dir, { recursive: true })
})

afterEach(() => {
	removeTempDir(root)
})

/** The handle the kernel puts on a sandboxed turn's tool context. */
function sandboxAt(rootDir: string): Sandbox {
	return { id: 'sbx', rootDir, environment: 'bwrap' } as unknown as Sandbox
}

const projectSkill = () => join(project, '.agents', 'skills', 'release-notes')
const userSkill = () => join(home, '.namzu', 'skills', 'house-style')

describe('on the host', () => {
	it('gives the directory the skill was read from, wherever it is', async () => {
		const resolve = createSkillDirectoryResolver({ sandboxMounts: () => [] })

		expect(await resolve({ name: 'house-style', directory: userSkill() }, {})).toBe(userSkill())
		expect(await resolve({ name: 'release-notes', directory: projectSkill() }, {})).toBe(
			projectSkill(),
		)
	})

	it('gives none for a registry that does not say where the skill is', async () => {
		const resolve = createSkillDirectoryResolver({ sandboxMounts: () => [] })

		expect(await resolve({ name: 'x', directory: undefined }, {})).toBeUndefined()
	})
})

describe('in a sandbox rooted at the working directory', () => {
	it('gives a project skill its path, which the sandbox mounts as it is', async () => {
		const resolve = createSkillDirectoryResolver({ sandboxMounts: () => [] })

		expect(
			await resolve(
				{ name: 'release-notes', directory: projectSkill() },
				{ sandbox: sandboxAt(project) },
			),
		).toBe(projectSkill())
	})

	it('gives none for a user skill, which the sandbox does not mount', async () => {
		const resolve = createSkillDirectoryResolver({ sandboxMounts: () => [] })

		expect(
			await resolve(
				{ name: 'house-style', directory: userSkill() },
				{ sandbox: sandboxAt(project) },
			),
		).toBeUndefined()
	})

	it('gives a skill under an added directory its path, read when asked', async () => {
		const mounts: string[] = []
		const resolve = createSkillDirectoryResolver({ sandboxMounts: () => mounts })
		const shared = join(added, 'skills', 'shared')
		const ask = () =>
			resolve({ name: 'shared', directory: shared }, { sandbox: sandboxAt(project) })

		expect(await ask()).toBeUndefined()
		// `/add-dir` during the session.
		mounts.push(added)
		expect(await ask()).toBe(shared)
	})

	it('gives none for a project skill that is a link to somewhere unmounted', async () => {
		const linked = join(project, '.namzu', 'skills', 'house-style')
		mkdirSync(join(project, '.namzu', 'skills'), { recursive: true })
		symlinkSync(userSkill(), linked, 'dir')
		const resolve = createSkillDirectoryResolver({ sandboxMounts: () => [] })

		expect(
			await resolve({ name: 'house-style', directory: linked }, { sandbox: sandboxAt(project) }),
		).toBeUndefined()
	})
})

describe('in an ephemeral sandbox', () => {
	it('gives none, even for a project skill: nothing of the host is mounted', async () => {
		const scratch = mkdtempSync(join(root, 'ephemeral-'))
		// An ephemeral workspace binds no added directories.
		const resolve = createSkillDirectoryResolver({ sandboxMounts: () => [] })

		expect(
			await resolve(
				{ name: 'release-notes', directory: projectSkill() },
				{ sandbox: sandboxAt(scratch) },
			),
		).toBeUndefined()
	})
})
