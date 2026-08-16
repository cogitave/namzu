import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { TenantId, TopicId } from '../../../types/ids/index.js'
import { StaleTopicStateError } from '../../../types/topic/state.js'
import { DiskTopicStateStore, InMemoryTopicStateStore } from '../state.js'

/**
 * The collaboration mode was resolved once per run and copied into the
 * executor.
 *
 * Enforcement was real; the LIFETIME was the problem. Leaving plan mode
 * meant ending the run and starting a fresh one with
 * `permissionMode: 'auto'` — discarding the in-flight step and the
 * tool-schema context to change one enum. So the look-around, propose,
 * get-approval, continue-in-the-same-conversation flow could not be built
 * on it, and `approve_plan` already existed with its approval changing
 * nothing about the mode.
 */

const TOPIC = 'top_mode' as TopicId
const TENANT = 'tnt_mode' as TenantId
const OTHER = 'tnt_other' as TenantId

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function diskStore(): Promise<{ rootDir: string; store: DiskTopicStateStore }> {
	const rootDir = await mkdtemp(join(tmpdir(), 'namzu-topic-state-'))
	dirs.push(rootDir)
	return { rootDir, store: new DiskTopicStateStore({ rootDir }) }
}

describe.each([
	['in-memory', () => Promise.resolve({ store: new InMemoryTopicStateStore(), rootDir: '' })],
	['disk', diskStore],
])('a topic remembers the mode it was left in (%s)', (_label, make) => {
	it('has no state before anything writes one', async () => {
		const { store } = await make()

		expect(await store.getState(TOPIC, TENANT)).toBeNull()
	})

	it('starts a record at revision 1', async () => {
		const { store } = await make()

		const state = await store.setPermissionMode(TOPIC, TENANT, 'plan', { revision: 0 })

		expect(state.revision).toBe(1)
		expect(state.permissionMode).toBe('plan')
	})

	it('refuses a stale revision and leaves the mode untouched', async () => {
		// Two hosts on one conversation is not hypothetical — a TUI and a
		// webhook — and last-write-wins there silently reopens a mode
		// somebody just closed. Re-read after the throw, so a store that
		// threw AFTER writing fails too.
		const { store } = await make()
		await store.setPermissionMode(TOPIC, TENANT, 'plan', { revision: 0 })

		await expect(store.setPermissionMode(TOPIC, TENANT, 'auto', { revision: 0 })).rejects.toThrow(
			StaleTopicStateError,
		)

		const state = await store.getState(TOPIC, TENANT)
		expect(state?.permissionMode).toBe('plan')
		expect(state?.revision).toBe(1)
	})

	it('accepts the revision it actually holds', async () => {
		const { store } = await make()
		const first = await store.setPermissionMode(TOPIC, TENANT, 'plan', { revision: 0 })

		const second = await store.setPermissionMode(TOPIC, TENANT, 'auto', {
			revision: first.revision,
		})

		expect(second.revision).toBe(2)
		expect(second.permissionMode).toBe('auto')
	})

	it('reads another tenant as absent rather than refusing', async () => {
		// Refusing confirms that somebody else's topic is there, which is the
		// leak the project listing already avoids the same way.
		const { store } = await make()
		await store.setPermissionMode(TOPIC, TENANT, 'plan', { revision: 0 })

		expect(await store.getState(TOPIC, OTHER)).toBeNull()
	})
})

describe('the mode survives the store instance that wrote it', () => {
	it('is readable through a fresh instance over the same directory', async () => {
		// The whole point of durability, and the assertion an in-memory-only
		// implementation cannot pass. A second run on the same topic has to
		// start where the first one left it.
		const { rootDir, store } = await diskStore()
		await store.setPermissionMode(TOPIC, TENANT, 'plan', { revision: 0 })

		const reopened = new DiskTopicStateStore({ rootDir })

		expect(await reopened.getState(TOPIC, TENANT)).toMatchObject({
			permissionMode: 'plan',
			revision: 1,
		})
	})

	it('carries the revision across, so a stale write is still refused', async () => {
		// A fresh instance that reset the counter would accept a write the
		// first instance had already superseded.
		const { rootDir, store } = await diskStore()
		await store.setPermissionMode(TOPIC, TENANT, 'plan', { revision: 0 })

		const reopened = new DiskTopicStateStore({ rootDir })

		await expect(
			reopened.setPermissionMode(TOPIC, TENANT, 'auto', { revision: 0 }),
		).rejects.toThrow(StaleTopicStateError)
	})
})
