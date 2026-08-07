/**
 * Choosing a model changes what the next turn is sent with.
 *
 * The gap this closes: `Picker`'s `onSubmit` accepted `{ provider, model? }`,
 * `App` wrote `model` into `Preferences`, and `agent.ts` read
 * `prefs.model ?? entry.defaultModel` — a chain wired end to end except that
 * the picker never produced a model. `/model` re-opened a *provider* list, so
 * someone who wanted a different model picked a provider and nothing changed.
 *
 * `Preferences` gaining a key proves none of that. The claim is that the value
 * survives to `runConfig.model`, which is what the kernel is handed and what
 * the provider is actually called with — so that is what is asserted.
 *
 * What this covers: the store→session→query leg, driven through the real
 * `createAgentSession`. What it cannot cover: that the model step renders and
 * accepts a keypress in a terminal. `model-choices.test.ts` pins the logic that
 * step is made of; only the owner running it can confirm the screen.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../integrations/providers/index.js'

/**
 * The default a session actually uses.
 *
 * Read from the registry rather than written here, because `createAgentSession`
 * takes its entry from `PROVIDER_REGISTRY[prefs.provider]` and NOT from the
 * detected provider it is handed. The first version of this file asserted a
 * hardcoded default that the fixture supplied and the session ignored, and it
 * failed — correctly. A literal here would also go stale silently the day the
 * default changes.
 */
// Indexed with a string literal rather than dot access. The external-name audit
// forbids a vendor name as an IDENTIFIER and exempts it as a wire value; a
// registry key is a wire value, and dot access reads as the former. (Spelling
// the rejected form in this comment trips the same check — it scans prose too.)
const REGISTRY_DEFAULT = PROVIDER_REGISTRY['anthropic'].defaultModel

/** Deliberately not the default, so "it changed" and "it did not" differ. */
const CHOSEN = 'claude-haiku-4-5'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

let cwd: string

beforeEach(() => {
	queryCalls.length = 0
	cwd = mkdtempSync(join(tmpdir(), 'namzu-model-'))
})

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true })
})

function detectedAnthropic(): DetectedProvider[] {
	return [
		{
			entry: {
				id: 'anthropic',
				label: 'Anthropic',
				// NOT the default the session uses — it reads
				// `PROVIDER_REGISTRY[prefs.provider]` instead of this entry. Set to
				// the registry's own value so the fixture cannot imply otherwise;
				// a different literal here reads as meaningful and is inert.
				defaultModel: REGISTRY_DEFAULT,
				requiresApiKey: true,
				envVars: ['ANTHROPIC_API_KEY'],
			},
			source: 'env',
			apiKey: 'sk-ant-not-a-real-key',
			alternatives: [],
		} as unknown as DetectedProvider,
	]
}

async function modelSentFor(prefs: Preferences): Promise<string | undefined> {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detectedAnthropic(), { cwd })
	for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
		// drain
	}
	const runConfig = queryCalls[0]?.runConfig as { model?: string } | undefined
	return runConfig?.model
}

describe('the model a run is sent with', () => {
	it('is the provider default when nothing was chosen', async () => {
		const model = await modelSentFor({
			version: 2,
			provider: 'anthropic',
			subagents: { active: [] },
		} as Preferences)
		expect(model).toBe(REGISTRY_DEFAULT)
	})

	it('is the chosen model when the picker recorded one', async () => {
		// The whole gap in one assertion: a model in preferences reaches the
		// kernel. Before the picker could produce one, this value had no way of
		// being set except by hand-editing the preferences file.
		const model = await modelSentFor({
			version: 2,
			provider: 'anthropic',
			model: CHOSEN,
			subagents: { active: [] },
		} as Preferences)
		expect(model).toBe(CHOSEN)
		// The assertion that makes the one above mean something: an earlier draft
		// used a value that happened to equal the registry default, so it passed
		// while proving nothing.
		expect(CHOSEN).not.toBe(REGISTRY_DEFAULT)
		expect(model).not.toBe(REGISTRY_DEFAULT)
	})

	it('is reported back on the session, so the picker can start on it', async () => {
		const { createAgentSession } = await import('../tui/agent.js')
		const session = await createAgentSession(
			{
				version: 2,
				provider: 'anthropic',
				model: CHOSEN,
				subagents: { active: [] },
			} as Preferences,
			detectedAnthropic(),
			{ cwd },
		)
		// `App` passes this to `Picker` as `currentModel`; without it, re-opening
		// the picker would reset to the default and quietly undo the choice.
		expect(session.modelSummary).toBe(CHOSEN)
	})
})
