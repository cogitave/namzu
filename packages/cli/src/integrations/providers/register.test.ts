import { describe, expect, it } from 'vitest'

import { constructProvider } from '../../tui/agent.js'
import { ensureRegistered, isRegistered } from './register.js'
import { ALL_PROVIDER_IDS, PROVIDER_REGISTRY } from './registry.js'

/**
 * The agreement `register.ts` says this file holds — and did not.
 *
 * Its doc comment reads: "the arms below are exactly the entries flagged
 * `constructible` in `PROVIDER_REGISTRY`, and `register.test.ts` holds the two
 * in agreement." There was no `register.test.ts`. The claim was checkable, was
 * checked by nobody, and the two sides could drift in either direction without
 * a single test noticing — found by deleting a switch arm whose registry entry
 * stayed, and watching 146 tests pass.
 *
 * Both directions matter and they fail differently:
 *
 * - **Entry without an arm** — the picker offers the provider, the operator
 *   chooses it, and the session dies on `default:` at the last possible moment,
 *   on a screen where "pick another" is not an action they can take.
 * - **Arm without an entry** — dead code carrying a driver dependency nothing
 *   can reach, and an import cost paid by a build that can never use it.
 *
 * And there are THREE switches, not two — `one-site-is-not-every-site`.
 * `constructProvider` in `tui/agent.ts` decides the same thing a third time,
 * and adding `deepseek` to the registry and to `ensureRegistered` while
 * missing that one produced the sharpest possible symptom: a refusal that
 * listed the refused provider among the alternatives. "deepseek is not
 * available in this build — pick one of: anthropic, openai, deepseek, …".
 */

const CONSTRUCTIBLE = ALL_PROVIDER_IDS.filter((id) => PROVIDER_REGISTRY[id].constructible)
const NOT_CONSTRUCTIBLE = ALL_PROVIDER_IDS.filter((id) => !PROVIDER_REGISTRY[id].constructible)

function constructionCredential(id: (typeof ALL_PROVIDER_IDS)[number]) {
	if (id === 'codex') {
		return {
			apiKey: 'codex-access',
			codex: { accountId: 'account-agreement', origin: 'codex-file' as const },
		} as never
	}
	return { apiKey: 'sk-agreement' } as never
}

describe('ensureRegistered agrees with PROVIDER_REGISTRY.constructible', () => {
	it('has at least one of each kind, so neither loop below is vacuous', () => {
		// Without this, emptying `ALL_PROVIDER_IDS` would make both suites pass
		// by having nothing to check.
		expect(CONSTRUCTIBLE.length).toBeGreaterThan(0)
		expect(NOT_CONSTRUCTIBLE.length).toBeGreaterThan(0)
	})

	it.each(CONSTRUCTIBLE)('registers %s, which the registry says is constructible', async (id) => {
		await expect(ensureRegistered(id)).resolves.toBeUndefined()
		expect(isRegistered(id)).toBe(true)
	})

	it.each(CONSTRUCTIBLE)('constructs %s, the third site that decides this', async (id) => {
		await ensureRegistered(id)
		// A credential shaped like one and reaching nothing: what is under test
		// is that an arm EXISTS, not that the vendor answers.
		expect(() => constructProvider(id, constructionCredential(id), 'a-model')).not.toThrow()
	})

	it.each(NOT_CONSTRUCTIBLE)(
		'refuses %s, which the registry says is not constructible',
		async (id) => {
			// Refused by name rather than by a generic failure: an operator who
			// asked for a driver this build does not ship gets told that, not a
			// module-resolution error from three layers down.
			await expect(ensureRegistered(id)).rejects.toThrow(id)
			expect(isRegistered(id)).toBe(false)
		},
	)
})
