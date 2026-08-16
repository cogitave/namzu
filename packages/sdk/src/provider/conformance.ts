import type {
	ConformanceDescribe,
	ConformanceExpect,
	ConformanceIt,
} from '../store/run/conformance.js'
import type { LLMProvider } from '../types/provider/interface.js'
import type { ProviderRetryConfig } from './retry.js'

/**
 * The driver contract, as a suite every driver package runs.
 *
 * Seven packages implement `LLMProvider` and there was nowhere to write a
 * rule binding all of them. Each carried a hand-written error-taxonomy
 * test covering the same ground differently, and every provider finding in
 * the audit was a behaviour present in exactly ONE driver and absent from
 * the other six — which is what you get when a contract lives in seven
 * copies of a test rather than in one place. Nothing failed when an eighth
 * package appeared implementing none of it.
 *
 * The mechanism already existed for a different interface: the checkpoint
 * store publishes its contract at `@namzu/sdk/testing` and takes its
 * runner as an argument. This copies that shape exactly, for the same two
 * reasons — the SDK gains no test dependency from publishing a suite, and
 * a caller can pass a RECORDING `describe`/`it` and run the whole contract
 * as ordinary code, which is how a deliberately wrong driver is shown to
 * fail it.
 *
 * ## What is in it, and what is deliberately not
 *
 * Seeded only with rules that pass for every driver today. A suite that
 * ships red is a suite somebody switches off in its first week, and the
 * point of it is to hold the line while the four known gaps are closed one
 * at a time — each of which adds a rule here in the commit that fixes it.
 *
 * ## Consuming it
 *
 * ```typescript
 * import { describe, expect, it } from 'vitest'
 * import { defineProviderDriverConformance } from '@namzu/sdk/testing'
 *
 * defineProviderDriverConformance({
 *   describe, it, expect,
 *   label: 'anthropic',
 *   registryType: 'anthropic',
 *   makeProvider: () => new AnthropicProvider({ apiKey: 'test' }),
 * })
 * ```
 */

/** The contract revision a driver declares itself written against. */
export const PROVIDER_DRIVER_CONTRACT_VERSION = 1

export interface ProviderDriverConformanceOptions {
	readonly describe: ConformanceDescribe
	readonly it: ConformanceIt
	readonly expect: ConformanceExpect
	/**
	 * The string this driver is registered under. Asserted to equal `id`,
	 * because the two are used interchangeably at call sites — a chain
	 * member names one and a `ProviderRegistry` lookup uses the other — and
	 * a driver where they differ resolves for some callers and not others.
	 */
	readonly registryType: string
	/**
	 * Built once per case. No case may depend on another's state, and a
	 * driver that holds a connection gets a fresh one rather than a shared
	 * instance the suite would then have to clean.
	 */
	readonly makeProvider: () => LLMProvider | Promise<LLMProvider>
	/**
	 * What this driver declares as its retry defaults, restated here.
	 *
	 * REQUIRED, and required as a value rather than inferred from the
	 * driver, so a new package cannot skip the decision by not thinking
	 * about it. `undefined` is a legitimate answer — it means the generic
	 * default suits this vendor — but it has to be written down, which is
	 * the difference between a decision and an omission.
	 */
	readonly retryDefaults: Partial<ProviderRetryConfig> | undefined
	/** Names the driver in test output. Defaults to `provider driver`. */
	readonly label?: string
}

export function defineProviderDriverConformance(options: ProviderDriverConformanceOptions): void {
	const { describe, it, expect, makeProvider, registryType } = options
	const label = options.label ?? 'provider driver'

	describe(`${label} — driver contract v${PROVIDER_DRIVER_CONTRACT_VERSION}`, () => {
		it('has a non-empty id and name', async () => {
			// Both reach a human or a log line. An empty one produces a
			// provider-chain entry that names nothing, which is worse than a
			// wrong name because there is nothing to search for.
			const provider = await makeProvider()

			expect(typeof provider.id).toBe('string')
			expect(provider.id.length > 0).toBe(true)
			expect(typeof provider.name).toBe('string')
			expect(provider.name.length > 0).toBe(true)
		})

		it('has an id equal to the string it is registered under', async () => {
			// A chain member names the registry type; a lookup uses `id`. A
			// driver where they differ resolves through one path and not the
			// other, and the failure appears at whichever call site the host
			// happens to reach second.
			const provider = await makeProvider()

			expect(provider.id).toBe(registryType)
		})

		it('exposes chatStream as a function', async () => {
			// The single entry point. Asserted because a driver can satisfy
			// the type by declaring it and still ship an object literal that
			// forgot it — the interface is structural.
			const provider = await makeProvider()

			expect(typeof provider.chatStream).toBe('function')
		})

		it('declares capabilities honestly or not at all', async () => {
			// Optional BY DESIGN: an absent declaration resolves to the
			// permissive default, which is the behaviour every driver had
			// before the field existed. What is not allowed is a declaration
			// that is present and not a capability record — that reaches the
			// runtime as "supports nothing" and silently strips tool surfaces.
			const provider = await makeProvider()
			if (provider.capabilities === undefined) return

			expect(typeof provider.capabilities.supportsTools).toBe('boolean')
			expect(typeof provider.capabilities.supportsStreaming).toBe('boolean')
			expect(typeof provider.capabilities.supportsFunctionCalling).toBe('boolean')
		})

		// NOT A RULE HERE, and the reason is worth keeping.
		//
		// NZ-PROV-05 makes `contextWindow`/`maxOutputTokens` optional so a
		// driver stops writing `0` for "I do not know" — zero is not a
		// window, and it reads to every consumer as a measurement of a model
		// that can hold nothing.
		//
		// The obvious place to enforce that is here, reading `listModels`.
		// It was here, and it was worse than nothing twice over. For every
		// in-tree driver `listModels` needs a live service, so the rule
		// returned early and asserted NOTHING in CI — verified by putting a
		// zero back and watching the driver's run stay green. And lmstudio's
		// does not throw, it HANGS: the rule timed out that package's whole
		// conformance run. A check that cannot fail, attached to a suite it
		// can take down.
		//
		// The reintroduction of a literal zero is caught by a source scan in
		// `provider/__tests__/conformance-fails-a-wrong-driver.test.ts`,
		// which depends on reaching nothing.

		it('declares the retry defaults its conformance run says it does', async () => {
			// The option above forces the decision; this asserts the answer is
			// TRUE of the driver. Without it a package could declare one thing
			// in its test and ship another, which is the same gap as no
			// declaration at all with an extra place to look.
			const provider = await makeProvider()

			expect(JSON.stringify(provider.retryDefaults ?? null)).toBe(
				JSON.stringify(options.retryDefaults ?? null),
			)
		})

		it('builds a second instance independent of the first', async () => {
			// The property the suite itself relies on, and one a driver can
			// break by caching a client on the module. Every case above calls
			// `makeProvider` again; if that returned a shared object, a
			// driver's state would leak between cases and this suite would
			// report on whichever one ran first.
			const a = await makeProvider()
			const b = await makeProvider()

			expect(a === b).toBe(false)
		})
	})
}
