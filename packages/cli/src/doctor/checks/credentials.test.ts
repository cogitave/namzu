/**
 * The removed credential source is explained where someone would look for it.
 *
 * A user whose key lived only in the removed daemon's secrets file does not get
 * an error when it goes — they get an absence: discovery returns nothing and
 * the picker opens as though they never had a credential. `doctor` is the
 * command reached for at that moment, so the explanation has to be there.
 */

import { describe, expect, it, vi } from 'vitest'

const discoverProviders = vi.fn()
vi.mock('../../integrations/providers/discover.js', () => ({
	discoverProviders: () => discoverProviders(),
}))

const { credentialSourcesCheck } = await import('./credentials.js')

const ctx = { cwd: '/tmp', env: {}, projectRoot: null }

describe('the credential-sources doctor check', () => {
	it('warns when nothing is found, and says the secrets file is no longer read', async () => {
		discoverProviders.mockResolvedValue([])

		const result = await credentialSourcesCheck.run(ctx)

		expect(result.status).toBe('warn')
		// The load-bearing part is the remediation, not the status: a bare "no
		// credential found" is what the picker already says, and repeating it
		// here would leave the user exactly where the silence did.
		expect(result.remediation).toMatch(/no longer reads the secrets file/i)
		expect(result.remediation).toMatch(/ANTHROPIC_API_KEY/)
	})

	it('names the source each credential actually came from', async () => {
		discoverProviders.mockResolvedValue([
			{ entry: { id: 'anthropic' }, source: { kind: 'keychain', service: 'a-keychain-item' } },
			{ entry: { id: 'openai' }, source: { kind: 'env', envName: 'OPENAI_API_KEY' } },
		])

		const result = await credentialSourcesCheck.run(ctx)

		expect(result.status).toBe('pass')
		expect(result.message).toContain('anthropic (keychain · a-keychain-item)')
		expect(result.message).toContain('openai (env · OPENAI_API_KEY)')
	})

	it('does not report "no credentials" when discovery itself failed', async () => {
		// Discovery is documented as non-throwing. If that ever stops being true,
		// the two states must stay distinguishable — "none found" would send the
		// user hunting for a key that is already set.
		discoverProviders.mockRejectedValue(new Error('keychain unreadable'))

		const result = await credentialSourcesCheck.run(ctx)

		expect(result.status).toBe('inconclusive')
		expect(result.message).toContain('keychain unreadable')
	})
})
