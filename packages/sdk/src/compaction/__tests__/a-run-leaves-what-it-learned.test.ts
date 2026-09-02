import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import { CONSOLIDATION_TAG, consolidationEntry } from '../consolidation.js'
import { WorkingStateManager } from '../manager.js'

/**
 * Episodic memory dies with the run; consolidation writes down the part a
 * later run can use — decisions, discoveries, failures — and nothing else.
 */

describe('consolidationEntry', () => {
	const meta = { runId: 'run_1', at: 1_700_000_000_000 }

	it('is null for a run that learned nothing', () => {
		const manager = new WorkingStateManager(CompactionConfigSchema.parse({}))
		manager.setTask('rename a variable')
		manager.trackFile('src/a.ts', { type: 'read', summary: 'read it' })
		expect(consolidationEntry(manager.getState(), meta)).toBeNull()
	})

	it('carries decisions, discoveries and failures, tagged as a learning, and not the task machinery', () => {
		const manager = new WorkingStateManager(CompactionConfigSchema.parse({}))
		manager.setTask('Fix the slug bug\nlong explanation')
		manager.addDecision('normalise with NFKD before stripping marks')
		manager.addDiscovery('node --test refuses a directory on Node 24; use a glob')
		manager.addFailure('first edit broke the accent test; the regex missed combining marks')
		manager.addUserRequirement('keep the CLI flags')
		manager.trackFile('src/slug.mjs', { type: 'edit', detail: 'normalise' })
		manager.trackFile('README.md', { type: 'read', summary: 'read' })
		const entry = consolidationEntry(manager.getState(), meta)
		expect(entry).not.toBeNull()
		if (!entry) return
		expect(entry.title).toBe('Learned: Fix the slug bug')
		expect(entry.summary).toBe('1 decision, 1 discovery, 1 failure from run run_1.')
		expect(entry.tags).toEqual([CONSOLIDATION_TAG, 'run:run_1'])
		expect(entry.content).toContain('## Decisions\n\n- normalise with NFKD')
		expect(entry.content).toContain('## Discoveries\n\n- node --test refuses')
		expect(entry.content).toContain('## Failures and what was done about them')
		expect(entry.content).toContain('- `src/slug.mjs`')
		expect(entry.content).not.toContain('README.md')
		expect(entry.content).not.toContain('keep the CLI flags')
		expect(entry.metadata).toMatchObject({ runId: 'run_1', kind: 'consolidation' })
	})
})
