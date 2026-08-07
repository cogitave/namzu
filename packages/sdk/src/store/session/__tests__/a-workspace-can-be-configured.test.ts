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
		// Eight, spaced past the millisecond `createdAt` is measured in, so this
		// is an assertion about age rather than about the tie-break below. With
		// the sort dropped the disk store returns them in directory order, which
		// is id-ascending — it matches creation order once in 8!.
		const store = await build()
		const created = []
		for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
			created.push(await store.createProject({ tenantId: TENANT, name }, TENANT))
			// Long enough to clear a coarse clock, not only a millisecond one.
			// `Date.now()` advances in ~15.6ms steps on Windows by default, and
			// virtualised CI hosts coalesce timers too — a 2ms gap left several
			// records sharing a timestamp there, so the tie-break decided the
			// order and this assertion failed as if the sort were wrong.
			await new Promise((resolve) => setTimeout(resolve, 20))
		}

		// The premise, asserted before the conclusion that depends on it.
		//
		// This test means "older records come first", which is only a question
		// if the records have distinct ages. When the clock does not advance,
		// the correct behaviour is the tie-break — so the failure would be a
		// true statement about a test whose premise had quietly evaporated,
		// reported as "these two ids are swapped". Checking it here makes the
		// message name the real cause.
		const stamps = created.map((p) => p.createdAt.getTime())
		const strictlyIncreasing = stamps.every((t, i) => i === 0 || t > (stamps[i - 1] ?? 0))
		expect({ strictlyIncreasing, stamps }).toEqual({ strictlyIncreasing: true, stamps })

		const listed = await store.listProjects?.(TENANT)

		expect(listed?.map((p) => p.id)).toEqual(created.map((p) => p.id))
	})

	it('stays a total order when several are created in the same millisecond', async () => {
		// CI found this and a slower machine could not: on a fast filesystem
		// projects routinely share a `createdAt`, and "oldest first" alone left
		// the rest to `readdir`. A caller paginating a listing that reorders
		// under it sees the same project twice and never sees another.
		const store = await build()
		for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
			await store.createProject({ tenantId: TENANT, name }, TENANT)
		}

		const listed = (await store.listProjects?.(TENANT)) ?? []

		expect(listed).toHaveLength(8)
		for (let i = 1; i < listed.length; i++) {
			const before = listed[i - 1]
			const after = listed[i]
			if (before === undefined || after === undefined) throw new Error('short listing')
			const olderFirst = before.createdAt.getTime() < after.createdAt.getTime()
			const tieByName =
				before.createdAt.getTime() === after.createdAt.getTime() && before.id < after.id
			expect({ pair: [before.name, after.name], ordered: olderFirst || tieByName }).toEqual({
				pair: [before.name, after.name],
				ordered: true,
			})
		}
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
