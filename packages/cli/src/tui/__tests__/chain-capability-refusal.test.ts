import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createAgentSession } from '../agent.js'

/**
 * The comparison itself is proven in
 * `integrations/providers/__tests__/chain-capabilities.test.ts`. What is proven
 * HERE is the hop from a session to that comparison — a helper that is correct
 * and never called refuses nothing
 * (`docs/conventions/reachability-is-its-own-property.md`).
 *
 * These drive the real registry and the real driver declarations, deliberately.
 * A stub declaring a synthetic mismatch would pass against a `createAgentSession`
 * that never looked at the chain at all.
 */

const detectedAnthropic = [
	{
		entry: {
			id: 'anthropic',
			label: 'Anthropic',
			defaultModel: 'a-model',
			requiresApiKey: true,
			envVars: ['ANTHROPIC_API_KEY'],
		},
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
] as never

const open: { close: () => Promise<void> }[] = []

afterEach(async () => {
	for (const session of open.splice(0)) await session.close()
})

function cwd(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-caps-'))
}

async function session(prefs: unknown) {
	const s = await createAgentSession(prefs as never, detectedAnthropic, { cwd: cwd() })
	open.push(s)
	return s
}

describe('a chain whose providers disagree', () => {
	it('is refused, and the refusal reaches the operator', async () => {
		// The pairing an operator would most naturally build: a cloud primary
		// with a local fallback. Those two genuinely disagree about tools, which
		// is why this needs no synthetic capability set.
		const s = await session({ version: 3, providers: [{ id: 'anthropic' }, { id: 'ollama' }] })

		expect(s.hasProvider).toBe(false)
		const hint = s.errorHint ?? ''
		expect(hint).toContain('fallback #1')
		expect(hint).toContain('primary provider')
		expect(hint).toContain('cannot call tools')
		expect(hint).toContain('allowCapabilityMismatch')
	})

	it('starts when the operator has accepted it, and says so', async () => {
		const s = await session({
			version: 3,
			providers: [{ id: 'anthropic' }, { id: 'ollama' }],
			allowCapabilityMismatch: true,
		})

		expect(s.hasProvider).toBe(true)
		const notices = s.configNotices.join('\n')
		expect(notices).toContain('you have accepted that')
		expect(notices).toContain('cannot call tools')
	})
})

describe('a chain whose providers agree', () => {
	it('starts with nothing to report', async () => {
		const s = await session({ version: 3, providers: [{ id: 'anthropic' }] })

		expect(s.hasProvider).toBe(true)
		// The case that keeps the refusal honest: a single-provider setup, which
		// is what almost everyone has, must gain no new noise from this.
		expect(s.configNotices).toEqual([])
	})

	it('starts for two providers that declare the same abilities', async () => {
		const s = await session({ version: 3, providers: [{ id: 'anthropic' }, { id: 'openai' }] })

		expect(s.hasProvider).toBe(true)
		expect(s.configNotices).toEqual([])
	})
})

describe('a member whose declaration cannot be read', () => {
	it('does not refuse the chain, and is reported rather than assumed fine', async () => {
		// `bedrock` is in the registry and has no construction path yet
		// (cogitave/namzu#257), so its declaration cannot be established here.
		// That is not a disagreement, and refusing over it would fail a chain on
		// a question that was never answered.
		const s = await session({ version: 3, providers: [{ id: 'anthropic' }, { id: 'bedrock' }] })

		expect(s.hasProvider).toBe(true)
		const notices = s.configNotices.join('\n')
		expect(notices).toContain('could not be established')
		expect(notices).toContain('fallback #1')
	})
})
