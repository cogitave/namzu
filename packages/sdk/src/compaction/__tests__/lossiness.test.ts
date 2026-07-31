import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import { extractFromToolResult } from '../extractor.js'
import { WorkingStateManager } from '../manager.js'
import { serializeState } from '../serializer.js'

/**
 * What survives compaction is the ONLY record of the history it replaced.
 * Two ways that record was quietly degrading:
 *
 * 1. Capped lists evicted with `shift()` — oldest-first — so on a long run
 *    the 26th assistant note silently deleted the 1st. The early entries
 *    are the load-bearing ones (the original requirement, the decision
 *    that set the approach); the recent ones are still in the un-compacted
 *    tail of the conversation.
 * 2. Every tool the builtin name-sets did not recognise — every MCP tool,
 *    every custom tool — collapsed into a flat 120-character head slice,
 *    which on JSON spends the whole budget on syntax.
 */

function config(overrides: Record<string, unknown> = {}) {
	return CompactionConfigSchema.parse({ maxListSize: 5, keepFirstEntries: 2, ...overrides })
}

describe('capped lists keep their head', () => {
	it('evicts from the middle, not the front', () => {
		const m = new WorkingStateManager(config())
		for (let i = 1; i <= 8; i++) m.addDecision(`decision ${i}`)

		const { decisions } = m.getState()
		expect(decisions).toHaveLength(5)
		// The first two survive…
		expect(decisions.slice(0, 2)).toEqual(['decision 1', 'decision 2'])
		// …and the newest do too. The middle is what went.
		expect(decisions.slice(-2)).toEqual(['decision 7', 'decision 8'])
	})

	it('counts what it dropped', () => {
		const m = new WorkingStateManager(config())
		for (let i = 1; i <= 8; i++) m.addDecision(`d${i}`)
		expect(m.getState().evicted.decisions).toBe(3)
	})

	it('counts each slot separately', () => {
		const m = new WorkingStateManager(config())
		for (let i = 1; i <= 7; i++) m.addFailure(`f${i}`)
		for (let i = 1; i <= 6; i++) m.addDiscovery(`x${i}`)

		expect(m.getState().evicted.failures).toBe(2)
		expect(m.getState().evicted.discoveries).toBe(1)
		expect(m.getState().evicted.decisions).toBeUndefined()
	})

	it('never evicts below the pinned head, even with a tiny cap', () => {
		const m = new WorkingStateManager(config({ maxListSize: 2, keepFirstEntries: 5 }))
		for (let i = 1; i <= 6; i++) m.addDecision(`d${i}`)

		const { decisions } = m.getState()
		expect(decisions).toHaveLength(2)
		// keepFirst is clamped below the cap, so the list still admits new
		// entries rather than freezing on its first two forever.
		expect(decisions[0]).toBe('d1')
		expect(decisions[1]).toBe('d6')
	})

	it('keeps tool results newest-first — recency genuinely wins there', () => {
		// An old `read` of a file that has since been edited is worse than
		// useless, so this slot is the one exception.
		const m = new WorkingStateManager(config({ maxToolResults: 3 }))
		for (let i = 1; i <= 5; i++) {
			m.addToolResult({ tool: 't', summary: `s${i}`, timestamp: i })
		}
		expect(m.getState().toolResults.map((r) => r.summary)).toEqual(['s3', 's4', 's5'])
		expect(m.getState().evicted.toolResults).toBe(2)
	})
})

describe('the summary admits what it lost', () => {
	it('names the dropped count in the rendered section', () => {
		const m = new WorkingStateManager(config())
		for (let i = 1; i <= 8; i++) m.addDecision(`d${i}`)

		const rendered = serializeState(m.getState())
		expect(rendered).toContain('3 entries dropped')
	})

	it('says nothing when nothing was dropped', () => {
		const m = new WorkingStateManager(config())
		m.addDecision('only one')
		expect(serializeState(m.getState())).not.toContain('dropped')
	})

	it('uses the singular for one', () => {
		const m = new WorkingStateManager(config())
		for (let i = 1; i <= 6; i++) m.addDecision(`d${i}`)
		expect(serializeState(m.getState())).toContain('1 entry dropped')
	})
})

describe('unrecognised tools get a useful summary', () => {
	const m = () => new WorkingStateManager(config({ maxToolResults: 30 }))

	it('describes the shape of a JSON array instead of slicing its syntax', () => {
		const mgr = m()
		const payload = JSON.stringify(
			Array.from({ length: 40 }, (_, i) => ({ id: `row-${i}`, name: 'x'.repeat(30) })),
		)
		extractFromToolResult(mgr, 'mcp_crm_list_deals', payload, false)

		const summary = mgr.getState().toolResults[0]?.summary ?? ''
		expect(summary).toContain('array of 40')
		expect(summary).toContain('id')
		expect(summary).toContain('name')
	})

	it('lists the keys of a JSON object', () => {
		const mgr = m()
		const payload = JSON.stringify({
			status: 'ok',
			total: 12,
			items: Array.from({ length: 50 }, (_, i) => `item-${i}-${'x'.repeat(20)}`),
		})
		extractFromToolResult(mgr, 'mcp_docs_search', payload, false)

		const summary = mgr.getState().toolResults[0]?.summary ?? ''
		expect(summary).toContain('object{')
		expect(summary).toContain('status')
		expect(summary).toContain('items')
	})

	it('keeps head AND tail of long plain text', () => {
		const mgr = m()
		extractFromToolResult(mgr, 'custom_tool', `START${'.'.repeat(4000)}END`, false)

		const summary = mgr.getState().toolResults[0]?.summary ?? ''
		expect(summary).toContain('START')
		expect(summary).toContain('END')
		expect(summary).toContain('chars omitted')
	})

	it('leaves a short result completely alone', () => {
		const mgr = m()
		extractFromToolResult(mgr, 'custom_tool', 'all good', false)
		expect(mgr.getState().toolResults[0]?.summary).toBe('all good')
	})

	it('gives an unknown tool more room than the old flat 120 chars', () => {
		const mgr = m()
		extractFromToolResult(mgr, 'custom_tool', 'z'.repeat(5000), false)
		expect((mgr.getState().toolResults[0]?.summary ?? '').length).toBeGreaterThan(120)
	})
})
