/**
 * A primary bound to a saved, labelled account is not a missing key.
 *
 * The account carries its own credential and base URL, which discovery never
 * looks at; the session builder resolves it. The start-up check used to read
 * only discovery, so a person whose preferences named such an account was told
 * "No API key found" and shown the provider picker, while `namzu exec` ran.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openCliAccounts } from '../../integrations/accounts/open.js'
import type { Preferences } from '../../integrations/providers/index.js'
import { credentialGap } from '../agent.js'

const prefs = (account?: string): Preferences => ({
	version: 3,
	providers: [{ id: 'openrouter', model: 'some/model', ...(account ? { account } : {}) }],
	subagents: { active: [] },
})

describe('credentialGap with a saved account', () => {
	it('accepts an account that is set up, and still reports a gap for a missing one', () => {
		const home = mkdtempSync(join(tmpdir(), 'acct-'))
		const accounts = openCliAccounts({ home })
		const added = accounts.registry.add({
			provider: 'openrouter',
			label: 'proxy',
			kind: 'api-key',
			apiKey: 'sk-or-not-real',
			baseUrl: 'http://127.0.0.1:1/v1',
			defaultModel: 'some/model',
		})
		const id = added.id
		expect(credentialGap(prefs(id), [], () => accounts)).toBeNull()
		expect(credentialGap(prefs('openrouter:gone'), [], () => accounts)?.providerId).toBe(
			'openrouter',
		)
		expect(credentialGap(prefs(), [], () => accounts)?.providerId).toBe('openrouter')
	})
})
