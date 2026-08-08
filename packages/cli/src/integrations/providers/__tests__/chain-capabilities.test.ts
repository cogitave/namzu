import type { ResolvedProviderCapabilities } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	type MemberCapabilities,
	chainCapabilityDisagreements,
	describeAcceptedMismatch,
	describeCapabilityRefusal,
} from '../chain-capabilities.js'
import type { ProviderChoice } from '../preferences.js'

const FULL: ResolvedProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
	supportsDocuments: true,
}

function known(over: Partial<ResolvedProviderCapabilities> = {}): MemberCapabilities {
	return { kind: 'known', capabilities: { ...FULL, ...over } }
}

const chain: readonly ProviderChoice[] = [{ id: 'anthropic' }, { id: 'ollama' }]

describe('a chain whose members agree', () => {
	it('produces no disagreement', () => {
		expect(chainCapabilityDisagreements(chain, [known(), known()])).toEqual([])
	})

	it('produces no refusal', () => {
		expect(describeCapabilityRefusal([])).toBeNull()
	})

	it('is not a disagreement when a single member is the whole chain', () => {
		expect(
			chainCapabilityDisagreements([{ id: 'ollama' }], [known({ supportsTools: false })]),
		).toEqual([])
	})
})

describe('a disagreement names both members and the capability', () => {
	it('says which member lacks it, which has it, and what is lost', () => {
		const out = chainCapabilityDisagreements(chain, [known(), known({ supportsTools: false })])
		expect(out).toHaveLength(1)
		const sentence = out[0]?.sentence ?? ''
		// The requirement in one assertion: an operator reading this can act on
		// it without reordering things at random.
		expect(sentence).toContain('fallback #1')
		expect(sentence).toContain('primary provider')
		expect(sentence).toContain('cannot call tools')
		expect(sentence).toContain('tools become unavailable')
	})

	it('says DECLARES rather than asserting what the provider is', () => {
		// The check is type-level; the SDK treats the constructed instance's own
		// declaration as authoritative. Overstating that is how someone later
		// finds the runtime disagreed and stops believing the check.
		const out = chainCapabilityDisagreements(chain, [known(), known({ supportsTools: false })])
		expect(out[0]?.sentence).toContain('declares')
	})

	it('makes no claim about THIS run — only about falling over', () => {
		// The check runs before a turn does, so nothing has fallen over yet and a
		// sentence claiming the current run is degraded would be false. Failover
		// landing does not change that: the conditional is about the moment the
		// check speaks, not about whether a swap is possible.
		const out = chainCapabilityDisagreements(chain, [known(), known({ supportsTools: false })])
		const sentence = out[0]?.sentence ?? ''
		expect(sentence).toContain('if the chain falls over')
		expect(sentence).not.toMatch(/this run|currently|right now/i)
	})

	it('reports every disagreeing capability, not just the first', () => {
		const out = chainCapabilityDisagreements(chain, [
			known(),
			known({ supportsTools: false, supportsVision: false, supportsDocuments: false }),
		])
		expect(out).toHaveLength(3)
	})

	it('reports against the FIRST member that declares the capability', () => {
		const three = [{ id: 'anthropic' }, { id: 'openai' }, { id: 'ollama' }] as const
		const out = chainCapabilityDisagreements(three, [
			known(),
			known(),
			known({ supportsTools: false }),
		])
		expect(out).toHaveLength(1)
		expect(out[0]?.declaredBy).toBe(0)
		expect(out[0]?.missingFrom).toBe(2)
	})

	it('detects a weaker PRIMARY too, not only a weaker fallback', () => {
		const out = chainCapabilityDisagreements(chain, [known({ supportsTools: false }), known()])
		expect(out).toHaveLength(1)
		expect(out[0]?.missingFrom).toBe(0)
	})
})

describe('a smaller output ceiling is a disagreement', () => {
	it('names both numbers and the cap that would apply', () => {
		const out = chainCapabilityDisagreements(chain, [
			known({ maxOutputTokens: 8192 }),
			known({ maxOutputTokens: 4096 }),
		])
		expect(out).toHaveLength(1)
		const sentence = out[0]?.sentence ?? ''
		expect(sentence).toContain('8192')
		expect(sentence).toContain('4096')
		expect(sentence).toContain('capped at 4096')
	})

	it('is not a disagreement when the ceilings match', () => {
		const out = chainCapabilityDisagreements(chain, [
			known({ maxOutputTokens: 4096 }),
			known({ maxOutputTokens: 4096 }),
		])
		expect(out).toEqual([])
	})

	it('needs two declared ceilings — one alone says nothing about the other', () => {
		const out = chainCapabilityDisagreements(chain, [known({ maxOutputTokens: 4096 }), known()])
		expect(out).toEqual([])
	})
})

describe('a member whose declaration could not be read', () => {
	it('is not counted as agreement', () => {
		// "I could not check this" must not become "this is fine".
		const out = chainCapabilityDisagreements(chain, [
			known(),
			{ kind: 'unresolved', reason: 'not wired' },
		])
		expect(out).toEqual([])
	})

	it('does not suppress a real disagreement elsewhere in the chain', () => {
		const three = [{ id: 'anthropic' }, { id: 'bedrock' }, { id: 'ollama' }] as const
		const out = chainCapabilityDisagreements(three, [
			known(),
			{ kind: 'unresolved', reason: 'not wired' },
			known({ supportsTools: false }),
		])
		expect(out).toHaveLength(1)
		expect(out[0]?.missingFrom).toBe(2)
	})
})

describe('the messages an operator reads', () => {
	it('the refusal names the escape hatch and what it costs', () => {
		const out = chainCapabilityDisagreements(chain, [known(), known({ supportsTools: false })])
		const refusal = describeCapabilityRefusal(out) ?? ''
		expect(refusal).toContain('allowCapabilityMismatch')
		expect(refusal).toContain('printed on every launch')
		// Says why neither default was chosen, so the refusal reads as a
		// decision rather than an inability.
		expect(refusal).toContain('Neither is chosen for you')
	})

	it('the accepted notice states the same facts without re-offering the flag', () => {
		const out = chainCapabilityDisagreements(chain, [known(), known({ supportsTools: false })])
		const notice = describeAcceptedMismatch(out) ?? ''
		expect(notice).toContain('you have accepted that')
		expect(notice).toContain('cannot call tools')
		expect(notice).not.toContain('allowCapabilityMismatch')
	})

	it('both are null when there is nothing to say', () => {
		expect(describeCapabilityRefusal([])).toBeNull()
		expect(describeAcceptedMismatch([])).toBeNull()
	})
})
