import { describe, expect, it } from 'vitest'
import { childScratchpadFact } from '../subagent-scratchpad-fact.js'

const fact = () => ({ scratchpadDirectory: '/tmp/namzu-u/p/s/scratchpad' })

describe('childScratchpadFact', () => {
	it('names the parent folder for a host child', () => {
		expect(childScratchpadFact(fact, { sandboxed: false })).toEqual(fact())
	})
	it('names nothing for a sandboxed session, whose tools do not have the host folder', () => {
		expect(childScratchpadFact(fact, { sandboxed: true })).toEqual({})
	})
	it('names nothing for an ephemeral session', () => {
		expect(childScratchpadFact(fact, { ephemeral: true, sandboxed: false })).toEqual({})
	})
})
