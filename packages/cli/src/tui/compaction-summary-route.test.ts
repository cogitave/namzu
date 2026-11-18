import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `compaction.modelSummary` and the small model reach the automatic summary only if the turn runner
 * hands the route on to the kernel. It was once built and then dropped here, so the setting did
 * nothing; this keeps the three places that carry it in step.
 */
describe('the compaction summary route through the turn runner', () => {
	const source = readFileSync(new URL('./agent.ts', import.meta.url), 'utf8')
	it('is declared, read from the parameters and forwarded to the query', () => {
		expect(source).toContain('readonly compactionSummaryRoute?: CompactionSummaryRouter')
		expect(source).toMatch(/\tpostCompactionContext,\n\tcompactionSummaryRoute,\n/)
		expect(source).toContain('...(compactionSummaryRoute ? { compactionSummaryRoute } : {}),')
	})
})
