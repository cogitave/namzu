/**
 * A closed workspace takes no new conversation from the CLI either.
 *
 * The kernel gained a workspace-closed gate and it was applied to the SDK's own
 * ingress paths. `startConversation` calls `createSession` on the store
 * DIRECTLY, and a store deliberately holds no view of workspace status, so the
 * invariant did not reach here.
 *
 * Whether that mattered turned on one question a grep cannot answer: does the
 * CLI ever reach a project it did not just create? It does. `openSessions`
 * reads the project id back out of `.namzu/cli.json` and creates a new project
 * only when the pointer is missing or stale — so every run after the first
 * attaches to a project that already existed and may since have been closed.
 *
 * That is why this test archives a project created by an EARLIER `openSessions`
 * and then reopens the same directory. A test that archived a project it made
 * itself, in one call, would pass against the first-run case the gate can never
 * fire on.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ProjectManager, type TenantId, UNKNOWN_TENANT_ID } from '@namzu/sdk'

import { openSessions, startConversation } from '../store.js'

let cwd: string

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'namzu-archived-'))
})

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true })
})

describe('a workspace its owner has closed', () => {
	it('refuses a new conversation, instead of quietly accepting work', async () => {
		// First run: creates the project and writes the pointer.
		const first = await openSessions(cwd)
		await new ProjectManager({ store: first.store }).archive(
			first.projectId,
			UNKNOWN_TENANT_ID as TenantId,
		)

		// A later run in the same directory reaches the SAME project through the
		// pointer — the case that exists only from the second run onward.
		const later = await openSessions(cwd)
		expect(later.projectId, 'the pointer has to be what makes this reachable').toBe(first.projectId)

		await expect(startConversation(later)).rejects.toThrow(/archiv|closed/i)
	})

	it('still starts a conversation in an open one', async () => {
		// The other half. A gate nothing can get past has broken the product,
		// and this is the assertion that would catch a `requireOpenProject` call
		// wired to the wrong project id.
		const sessions = await openSessions(cwd)

		const id = await startConversation(sessions)

		expect(typeof id).toBe('string')
		expect(id.length).toBeGreaterThan(0)
	})

	it('names the workspace in the refusal', async () => {
		// A refusal that does not say which workspace sends the reader nowhere:
		// the whole point is that an owner closed this one on purpose.
		const first = await openSessions(cwd)
		await new ProjectManager({ store: first.store }).archive(
			first.projectId,
			UNKNOWN_TENANT_ID as TenantId,
		)

		const later = await openSessions(cwd)

		await expect(startConversation(later)).rejects.toThrow(new RegExp(later.projectId))
	})
})
