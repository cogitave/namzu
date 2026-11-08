import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateProjectId, hashedSlugForCwd, slugForCwd } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findProject } from './project-lookup.js'

let stateRoot: string
let workspace: string
beforeEach(() => {
	stateRoot = mkdtempSync(join(tmpdir(), 'namzu-lookup-state-'))
	workspace = mkdtempSync(join(tmpdir(), 'namzu-lookup-work-'))
})
afterEach(() => {
	rmSync(stateRoot, { recursive: true, force: true })
	rmSync(workspace, { recursive: true, force: true })
})

describe('findProject', () => {
	it('finds a project filed under the hashed slug, and never creates one', async () => {
		const canonical = realpathSync(workspace)
		const plain = join(stateRoot, 'projects', slugForCwd(canonical))
		const hashed = join(stateRoot, 'projects', hashedSlugForCwd(canonical))
		const document = (cwd: string, slug: string) =>
			JSON.stringify({
				v: 1,
				kind: 'project',
				projectId: generateProjectId(),
				cwd,
				slug,
				createdAt: new Date(0).toISOString(),
			})
		expect(await findProject(stateRoot, canonical)).toBeNull()
		expect(existsSync(join(stateRoot, 'projects'))).toBe(false)
		// Two directories that slug alike: the plain slug belongs to the other.
		mkdirSync(plain, { recursive: true })
		writeFileSync(join(plain, 'project.json'), document('/elsewhere', slugForCwd(canonical)))
		expect(await findProject(stateRoot, canonical)).toBeNull()
		mkdirSync(hashed, { recursive: true })
		writeFileSync(join(hashed, 'project.json'), document(canonical, hashedSlugForCwd(canonical)))
		expect(await findProject(stateRoot, canonical)).toMatchObject({
			slug: hashedSlugForCwd(canonical),
		})
	})
})
