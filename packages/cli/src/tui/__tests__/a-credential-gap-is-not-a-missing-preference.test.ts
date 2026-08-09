/**
 * A missing credential is reported WITHOUT disturbing the preferences it read.
 *
 * The obvious way to route the TUI into the picker is to null `preferences` and
 * reuse `needsRepickReason`, and it would have been a silent regression for
 * every scripted run. `run`, `run-stream` and `drain` all do
 * `probe.preferences ?? defaultPrefs(probe.detected)` — so a null there does not
 * refuse, it FALLS BACK, and a run pinned to a provider whose key had lapsed
 * would quietly have moved onto whatever else the machine happened to have.
 *
 * That is the failure the headless refusal exists to prevent, so the gap is a
 * field of its own and the preferences come back untouched. This file is the
 * only place that claim is checked; the TUI tests cannot see it, because the
 * TUI is the caller that is supposed to act on it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
	DetectedProvider,
	Preferences,
	ProviderId,
} from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/registry.js'

/** Ids are wire values and stay in literals; entries are looked up by them. */
const SAVED: ProviderId = 'anthropic'
const LOCAL: ProviderId = 'ollama'
const SAVED_ENTRY = PROVIDER_REGISTRY[SAVED]

const savedChain = (): Preferences => ({
	version: 3,
	providers: [{ id: SAVED }],
	subagents: { active: [] },
})

const world: { prefs: Preferences; detected: readonly DetectedProvider[] } = {
	prefs: savedChain(),
	detected: [],
}

vi.mock('../../integrations/providers/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/index.js')>()
	return {
		...actual,
		readPreferences: () => ({ status: 'ok' as const, prefs: world.prefs }),
		discoverProviders: async () => world.detected,
	}
})

const { probeAgentSession } = await import('../agent.js')

/** A credential for the saved provider, as discovery would report one. */
const WITH_KEY: readonly DetectedProvider[] = [
	{
		entry: SAVED_ENTRY,
		source: { kind: 'env', envName: SAVED_ENTRY.envVars[0] ?? 'A_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

/** A local server: detected, needs no key, and not the saved provider. */
const LOCAL_ONLY: readonly DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY[LOCAL],
		source: { kind: 'probe', url: 'http://localhost:11434' },
		alternatives: [],
	},
]

beforeEach(() => {
	world.prefs = savedChain()
	world.detected = []
})

describe('probing with a saved provider that has no credential', () => {
	it('reports the gap and still hands back the chain it read', async () => {
		const probe = await probeAgentSession()

		expect(probe.credentialGap?.providerId).toBe(SAVED)
		// The half a headless caller depends on. Nulling this would turn a refusal
		// into a silent provider switch.
		expect(probe.preferences, 'the saved chain was thrown away').toEqual(world.prefs)
		expect(probe.needsRepickReason, 'a valid file was reported as unreadable').toBeNull()
	})

	it('names the provider and what was looked for', async () => {
		const probe = await probeAgentSession()
		const reason = probe.credentialGap?.reason ?? ''

		expect(reason).toContain(SAVED_ENTRY.label)
		for (const envVar of SAVED_ENTRY.envVars) {
			expect(reason, envVar).toContain(envVar)
		}
	})

	it('still reports the gap when something else is running', async () => {
		// A detected provider is not a credential for the saved one, and the
		// membership test has to be per-provider rather than "did discovery find
		// anything at all".
		world.detected = LOCAL_ONLY
		expect((await probeAgentSession()).credentialGap?.providerId).toBe(SAVED)
	})
})

describe('probing when nothing is missing', () => {
	it('reports no gap when the credential is there', async () => {
		world.detected = WITH_KEY
		const probe = await probeAgentSession()

		expect(probe.credentialGap).toBeNull()
		expect(probe.preferences).toEqual(world.prefs)
	})

	it('reports no gap for a provider that takes no credential', async () => {
		// A local server needs no key, so "no key found" is not a fact about it.
		// Reporting one would route the operator into the picker to fix something
		// that was never wrong.
		world.prefs = { version: 3, providers: [{ id: LOCAL }], subagents: { active: [] } }
		world.detected = LOCAL_ONLY

		expect((await probeAgentSession()).credentialGap).toBeNull()
	})
})
