import { describe, expect, it } from 'vitest'

import type { CompactionConfig } from '../../config/runtime.js'
import { extractFromUserMessage } from '../extractor.js'
import { WorkingStateManager } from '../manager.js'
import { serializeState } from '../serializer.js'

function manager(): WorkingStateManager {
	return new WorkingStateManager({
		maxListSize: 25,
		keepFirstEntries: 3,
		maxCharsPerTask: 400,
		maxCharsPerRequirement: 300,
		maxCharsPerNote: 500,
	} as CompactionConfig)
}

describe('the files list says what was done to each file', () => {
	it('gives the path and then the action, once each', () => {
		const m = manager()
		m.trackFile('src/a.ts', { type: 'read', summary: 'read' })
		m.trackFile('src/a.ts', { type: 'read', summary: 'read' })
		m.trackFile('src/a.ts', { type: 'edit', detail: 'modified' })
		m.trackFile('src/b.ts', { type: 'edit', detail: 'export const b = 1\nexport const c = 2' })
		m.trackFile('src/c.ts', { type: 'delete' })
		const text = serializeState(m.getState())
		expect(text).toContain('## Files\n')
		expect(text).toContain('- `src/a.ts`: read; changed')
		expect(text).toContain('- `src/b.ts`: changed (export const b = 1 export const c = 2)')
		expect(text).toContain('- `src/c.ts`: deleted')
		expect(text).not.toContain('read: read')
		expect(text).not.toContain('Files Touched')
	})
})

describe('the goal is restated', () => {
	it('names the newest request in its own section, just before the open items', () => {
		const m = manager()
		extractFromUserMessage(m, 'Port the loader.', true)
		extractFromUserMessage(m, 'Then rename the store.', false)
		m.addAssistantNote('I will add the tests next.')
		const text = serializeState(m.getState())
		expect(text).toContain('## Current Goal\n\nThen rename the store.')
	})

	it('falls back to the task when nothing newer was asked', () => {
		const m = manager()
		extractFromUserMessage(m, 'Port the loader.', true)
		expect(serializeState(m.getState())).toContain('## Current Goal\n\nPort the loader.')
	})

	it('writes none for an empty state', () => {
		expect(serializeState(manager().getState())).not.toContain('Current Goal')
	})
})
