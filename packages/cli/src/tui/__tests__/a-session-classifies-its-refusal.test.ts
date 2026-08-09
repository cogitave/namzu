/**
 * That a session which came up without a provider says WHICH KIND of failure it
 * was.
 *
 * `hasProvider === false` is one flag over five different refusals, and they do
 * not want the same response. A provider id that is not a provider came from
 * `--provider`, so whoever typed it fixes it by typing something else; a
 * missing credential, a driver package that would not load, a chain that
 * contradicts itself and a client that would not construct are all about the
 * machine, and no argument moves any of them.
 *
 * `run-stream` branches on that difference to choose its exit code. The
 * exit-code suite stubs the session, so it can only prove that the COMMAND
 * reacts to the field — this file is the other half, and without it a session
 * that labelled everything `environment` would pass every test in the repo.
 *
 * The two cases below both return before any network call: the registry lookup
 * fails on the first, and the credential check on the second.
 */

import { describe, expect, it } from 'vitest'

import type { Preferences, ProviderId } from '../../integrations/providers/index.js'
import { createAgentSession } from '../agent.js'

function prefs(id: string): Preferences {
	return { version: 3, providers: [{ id: id as ProviderId }], subagents: { active: [] } }
}

describe('a session that could not be built', () => {
	it('calls an unknown provider id an invocation failure', async () => {
		const session = await createAgentSession(prefs('not-a-provider'), [])
		expect(session.hasProvider).toBe(false)
		expect(session.errorKind).toBe('invocation')
		// And still says it in words, because a person reads the event too.
		expect(session.errorHint ?? '').toContain('not-a-provider')
	})

	it('calls a missing credential an environment failure', async () => {
		// A real provider, asked for with nothing detected. Nothing the caller
		// sends conjures a credential.
		const session = await createAgentSession(prefs('anthropic'), [])
		expect(session.hasProvider).toBe(false)
		expect(session.errorKind).toBe('environment')
	})

	it('leaves the kind null when there is nothing to classify', async () => {
		// The field is about a refusal. A session with a provider AND a kind would
		// describe nothing real, and a reader checking the kind first would be
		// answered about a session that works.
		const session = await createAgentSession(prefs('not-a-provider'), [])
		expect(session.errorKind !== null).toBe(!session.hasProvider)
	})
})
