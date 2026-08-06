import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { TenantIsolationError } from '../../../session/errors.js'
import type { TenantId } from '../../../types/ids/index.js'
import type { SessionStore } from '../../../types/session/store.js'
import { DiskSessionStore } from '../disk.js'
import { InMemorySessionStore } from '../memory.js'

/**
 * Every project in existence ran at depth 4 and width 8.
 *
 * The config was hardcoded identically in both stores, `CreateProjectParams`
 * was `{tenantId, name}`, and there was no `updateProject`. So a tenant with
 * several workspaces could not give them different limits — which is most of
 * what having several workspaces is for.
 *
 * Only the two fields something READS are settable. `ProjectConfig` declares
 * eight; five enforcement sites read two of them. Exposing the other six would
 * make dead fields easier to set, and a host that configures a retention policy
 * and gets no error believes retention is on. `maxInterventionDepth` looks like
 * an exception and is not: its three apparent readers are all comments.
 *
 * Both stores are driven by the same cases, because a reference implementation
 * that disagrees with the durable one is worse than having only one.
 */

const TENANT = 'tnt_cfg' as TenantId
const OTHER = 'tnt_other' as TenantId

const dirs: string[] = []
afterEach(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
	dirs.length = 0
})

async function diskStore(): Promise<SessionStore> {
	const rootDir = await mkdtemp(join(tmpdir(), 'namzu-cfg-'))
	dirs.push(rootDir)
	return new DiskSessionStore({ rootDir })
}

const IMPLEMENTATIONS: ReadonlyArray<readonly [string, () => Promise<SessionStore>]> = [
	['in memory', async () => new InMemorySessionStore()],
	['on disk', diskStore],
]

describe.each(IMPLEMENTATIONS)('a workspace carries its own limits (%s)', (_name, build) => {
	it('takes the limits it was created with', async () => {
		const store = await build()

		const project = await store.createProject(
			{ tenantId: TENANT, name: 'w', config: { maxDelegationDepth: 2, maxDelegationWidth: 3 } },
			TENANT,
		)

		expect(project.config.maxDelegationDepth).toBe(2)
		expect(project.config.maxDelegationWidth).toBe(3)
	})

	it('keeps the defaults for anything not given', async () => {
		const store = await build()

		const project = await store.createProject(
			{ tenantId: TENANT, name: 'w', config: { maxDelegationDepth: 2 } },
			TENANT,
		)

		expect(project.config.maxDelegationDepth).toBe(2)
		expect(project.config.maxDelegationWidth).toBe(8)
	})

	it('lets two workspaces of one tenant differ, which is the point', async () => {
		const store = await build()

		const narrow = await store.createProject(
			{ tenantId: TENANT, name: 'narrow', config: { maxDelegationWidth: 1 } },
			TENANT,
		)
		const wide = await store.createProject(
			{ tenantId: TENANT, name: 'wide', config: { maxDelegationWidth: 16 } },
			TENANT,
		)

		expect(narrow.config.maxDelegationWidth).toBe(1)
		expect(wide.config.maxDelegationWidth).toBe(16)
	})

	it('changes a limit after the fact, and the change is readable back', async () => {
		const store = await build()
		const project = await store.createProject({ tenantId: TENANT, name: 'w' }, TENANT)

		await store.updateProject?.(project.id, { maxDelegationWidth: 12 }, TENANT)

		expect((await store.getProject(project.id, TENANT))?.config.maxDelegationWidth).toBe(12)
	})

	it('leaves a limit it was not asked to change', async () => {
		// Per field, not whole-value: raising the width says nothing about the
		// depth, and resetting it would be an answer to a question nobody asked.
		const store = await build()
		const project = await store.createProject(
			{ tenantId: TENANT, name: 'w', config: { maxDelegationDepth: 2 } },
			TENANT,
		)

		await store.updateProject?.(project.id, { maxDelegationWidth: 12 }, TENANT)

		const reloaded = await store.getProject(project.id, TENANT)
		expect(reloaded?.config.maxDelegationDepth).toBe(2)
		expect(reloaded?.config.maxDelegationWidth).toBe(12)
	})

	it('treats an explicitly undefined limit as "leave it", not "clear it"', async () => {
		// The case the per-field guard exists for, and the one a plain spread
		// gets wrong: `{...config}` with an explicit `undefined` key writes the
		// undefined through and erases a limit the caller never mentioned. A
		// caller building an update object programmatically produces exactly
		// this shape.
		const store = await build()
		const project = await store.createProject(
			{ tenantId: TENANT, name: 'w', config: { maxDelegationDepth: 3 } },
			TENANT,
		)

		await store.updateProject?.(
			project.id,
			{ maxDelegationDepth: undefined, maxDelegationWidth: 12 },
			TENANT,
		)

		const reloaded = await store.getProject(project.id, TENANT)
		expect(reloaded?.config.maxDelegationDepth).toBe(3)
		expect(reloaded?.config.maxDelegationWidth).toBe(12)
	})

	it('lists what this tenant owns, oldest first', async () => {
		const store = await build()
		const first = await store.createProject({ tenantId: TENANT, name: 'a' }, TENANT)
		const second = await store.createProject({ tenantId: TENANT, name: 'b' }, TENANT)

		const listed = await store.listProjects?.(TENANT)

		expect(listed?.map((p) => p.id)).toEqual([first.id, second.id])
	})

	it('omits another tenant from the listing rather than refusing', async () => {
		// A listing is a question about what you own. Refusing would confirm
		// that somebody else's project is there, which is the leak the tenant
		// boundary exists to prevent.
		const store = await build()
		await store.createProject({ tenantId: TENANT, name: 'mine' }, TENANT)
		await store.createProject({ tenantId: OTHER, name: 'theirs' }, OTHER)

		expect((await store.listProjects?.(TENANT))?.map((p) => p.name)).toEqual(['mine'])
	})

	it('refuses to reconfigure another tenant project', async () => {
		// Reading a listing is a question; writing to somebody else's workspace
		// is not, so this one throws.
		const store = await build()
		const theirs = await store.createProject({ tenantId: OTHER, name: 'theirs' }, OTHER)

		await expect(
			store.updateProject?.(theirs.id, { maxDelegationWidth: 99 }, TENANT),
		).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('returns null for a project that does not exist', async () => {
		const store = await build()

		expect(await store.updateProject?.('prj_missing' as never, {}, TENANT)).toBeNull()
	})
})
