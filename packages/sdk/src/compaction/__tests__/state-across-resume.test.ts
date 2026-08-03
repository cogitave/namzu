import { describe, expect, it } from 'vitest'

import type { CompactionConfig } from '../../config/runtime.js'
import { WorkingStateManager } from '../manager.js'
import { serializeState } from '../serializer.js'
import { restoreWorkingState, snapshotWorkingState } from '../wire.js'

/**
 * Compaction replaces older history with a summary and drops any PRIOR
 * summary, on the grounds that `serializeState` is cumulative so the new
 * one supersedes it. Within a process that is true.
 *
 * Across a resume it was not: the manager was rebuilt empty on every
 * `query()`, so a resumed run's second compaction summarized only
 * post-resume activity and deleted the block holding everything before it
 * — the block the restore path had deliberately carried forward as the
 * only surviving record of the compacted history.
 */

function config(): CompactionConfig {
	return {
		strategy: 'structured',
		triggerThreshold: 0.7,
		resetThreshold: 0.4,
		keepRecentMessages: 4,
		clearToolResults: true,
		keepRecentToolResults: 3,
		minToolResultCharsToClear: 1_000,
		maxToolResults: 30,
		maxListSize: 25,
		keepFirstEntries: 3,
		llmVerification: false,
		llmVerificationMaxTokens: 2048,
		richStateThreshold: 15,
		convoTextBudget: 12_000,
		maxSentencesPerTurn: 5,
		maxCharsPerNote: 500,
		maxCharsPerRequirement: 300,
		maxCharsPerTask: 400,
	} as CompactionConfig
}

/** A manager holding the kind of state a first hour of work produces. */
function firstHour(): WorkingStateManager {
	const m = new WorkingStateManager(config())
	m.setTask('migrate the billing schema')
	m.addDecision('chose an additive migration over a rewrite')
	m.addFailure('the first attempt deadlocked on the invoices table')
	m.addDiscovery('invoices has a partial index nobody documented')
	m.trackFile('src/billing/schema.ts', { type: 'edit', detail: 'added the additive columns' })
	return m
}

describe('working state survives a process boundary', () => {
	it('round-trips every slot', () => {
		const before = firstHour()
		const after = restoreWorkingState(snapshotWorkingState(before), config())

		expect(serializeState(after.getState())).toBe(serializeState(before.getState()))
	})

	it('carries the file map, which JSON alone would flatten to nothing', () => {
		// `WorkingState.files` is a Map. `JSON.stringify` renders a Map as
		// `{}`, so a naive snapshot would silently lose every tracked file.
		const restored = restoreWorkingState(snapshotWorkingState(firstHour()), config())
		expect(restored.getState().files.get('src/billing/schema.ts')).toBeDefined()
	})

	it('carries the eviction counters, so a resumed summary still admits its losses', () => {
		// The state that survives compaction is the only record of the
		// history it replaced. A resumed summary that forgot what it had
		// already dropped would claim a completeness it does not have.
		const m = new WorkingStateManager(config())
		for (let i = 0; i < 40; i++) m.addDecision(`decision ${i}`)
		expect(m.getState().evicted.decisions).toBeGreaterThan(0)

		const restored = restoreWorkingState(snapshotWorkingState(m), config())
		expect(restored.getState().evicted.decisions).toBe(m.getState().evicted.decisions)
	})

	it('keeps accumulating after the restore rather than starting over', () => {
		// This is the property the whole fix exists for: the SECOND
		// compaction of a resumed run must summarize the first hour AND what
		// followed, because it is about to delete the block that held the
		// first hour.
		const restored = restoreWorkingState(snapshotWorkingState(firstHour()), config())
		restored.addDecision('after the resume, switched to a batched backfill')

		const serialized = serializeState(restored.getState())
		expect(serialized).toContain('additive migration')
		expect(serialized).toContain('batched backfill')
	})

	it('an empty snapshot restores to an empty manager', () => {
		const empty = new WorkingStateManager(config())
		const restored = restoreWorkingState(snapshotWorkingState(empty), config())
		expect(restored.slotCount()).toBe(empty.slotCount())
	})
})
