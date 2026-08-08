/**
 * `constructible` and the switch arms are one fact in two places, and this is
 * what stops them drifting.
 *
 * The registry entry is data five consumers read as truth; `ensureRegistered`
 * is the only thing that knows which drivers this build actually bundles. The
 * flag exists so the other four can know it too — which is worth nothing if the
 * flag can go stale, and staleness is exactly the defect being fixed (#257).
 *
 * Both directions matter and they fail differently:
 *
 *  - a flag saying `true` with no arm is the original defect, restored: the
 *    picker offers a row that throws;
 *  - an arm with the flag saying `false` refuses a provider that works, which
 *    nothing else in the codebase would catch, because refusing looks like the
 *    fix.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { ensureRegistered, isRegistered } from '../register.js'
import { ALL_PROVIDER_IDS, PROVIDER_REGISTRY, unsupportedProviderMessage } from '../registry.js'

/**
 * Ask `ensureRegistered` itself rather than re-reading its source.
 *
 * A test that parsed the switch for `case` labels would be asserting against a
 * copy of the thing it is checking; this drives the real function and reads the
 * real outcome. A provider whose driver is bundled registers (or throws
 * something OTHER than the refusal, on a broken install); one that is not
 * bundled throws the refusal.
 */
async function bundlesADriver(id: (typeof ALL_PROVIDER_IDS)[number]): Promise<boolean> {
	try {
		await ensureRegistered(id)
		return true
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return message !== unsupportedProviderMessage(id)
	}
}

const UNBUNDLED_IDS = ALL_PROVIDER_IDS.filter((id) => !PROVIDER_REGISTRY[id].constructible)

/** The dependency list this package actually ships with. */
const CLI_DEPENDENCIES: Record<string, string> = JSON.parse(
	readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
).dependencies

/**
 * The flag is checked against the DEPENDENCY LIST, which is what makes it true.
 *
 * Two earlier drafts were worse, and both were caught by mutation rather than
 * by reading:
 *
 *  - iterating a list derived from `constructible` meant flipping a flag simply
 *    removed that id from the loop, so the mutation restoring the original
 *    defect passed. A guard filtered by the thing it guards cannot fail
 *    (`docs/conventions/a-check-that-cannot-fail.md`).
 *  - driving `ensureRegistered` for all seven ids caught it, at the cost of
 *    pulling four driver module graphs through vite's transform in this worker.
 *    That starved a neighbouring render-loop test badly enough to fail it in
 *    two runs out of three — and widening that test's wall-clock budget did not
 *    help, because it then consumed whatever ceiling it was given. The cost was
 *    not marginal and paying it was not an option.
 *
 * A dependency this package does not declare cannot be imported, so
 * `package.json` is not a proxy for the truth here — it IS the truth, and
 * comparing against it is both cheaper and more direct than comparing against
 * the switch that reads it. The switch is still driven below, once, and for the
 * unbundled ids, which is where the refusal has to be exact.
 */
describe('constructible agrees with what this package actually depends on', () => {
	it.each([...ALL_PROVIDER_IDS])('%s', (id) => {
		expect(`@namzu/${id}` in CLI_DEPENDENCIES).toBe(PROVIDER_REGISTRY[id].constructible)
	})

	it.each([...UNBUNDLED_IDS])('refuses %s, rather than merely being flagged', async (id) => {
		// The flag and the refusal are two things, and a flag nothing enforces is
		// the shape of the defect being fixed. Cheap: these ids reach the
		// `default:` arm without importing anything.
		expect(await bundlesADriver(id)).toBe(false)
	})

	it('registers a bundled driver, so `isRegistered` reports it afterwards', async () => {
		// The flag promising a driver is worth nothing if registration does not
		// happen. Without this, a switch whose arms all fell through to a no-op
		// would satisfy every case above.
		const id = ALL_PROVIDER_IDS.find((candidate) => PROVIDER_REGISTRY[candidate].constructible)
		if (!id) throw new Error('no constructible provider in the registry')
		await ensureRegistered(id)
		expect(isRegistered(id)).toBe(true)
	})

	it('leaves an unbundled provider unregistered rather than half-registered', async () => {
		const id = UNBUNDLED_IDS[0]
		if (!id) throw new Error('no unbuildable provider in the registry')
		await expect(ensureRegistered(id)).rejects.toThrow(/not available in this build/)
		expect(isRegistered(id)).toBe(false)
	})
})

describe('the refusal names what an operator can act on', () => {
	it('names the provider, the reason, and only providers that actually work', () => {
		const id = UNBUNDLED_IDS[0]
		if (!id) throw new Error('no unbuildable provider in the registry')
		const message = unsupportedProviderMessage(id)

		expect(message).toContain(PROVIDER_REGISTRY[id].label)
		expect(message).toMatch(/not available in this build/)
		// The suggestions must be usable. Listing an unbuildable provider as the
		// remedy for an unbuildable provider is the failure mode this sentence
		// exists to avoid.
		for (const id of ALL_PROVIDER_IDS) {
			if (PROVIDER_REGISTRY[id].constructible) continue
			expect(message.includes('Pick one of:')).toBe(true)
			expect(message.split('Pick one of:')[1] ?? '').not.toContain(id)
		}
	})
})
