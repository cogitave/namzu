import { describe, expect, it } from 'vitest'
import type { HarnessView } from '../shared/protocol.js'
import { committableEngine } from './harness-picker.js'

const view: HarnessView = {
	selected: 'namzu',
	locked: false,
	engines: [
		{ id: 'namzu', label: 'Namzu', available: true },
		{ id: 'codex-cli', label: 'Codex CLI', available: true },
		{ id: 'claude-code', label: 'Claude Code', available: false },
	],
}
const idle = { busy: false, disabled: false }

describe('committableEngine', () => {
	it('commits an available engine', () => {
		expect(committableEngine(view, 'codex-cli', idle)).toBe('codex-cli')
	})
	it('refuses an engine that is not installed', () => {
		expect(committableEngine(view, 'claude-code', idle)).toBeUndefined()
	})
	it('refuses unknown values and a missing view', () => {
		expect(committableEngine(view, 'other', idle)).toBeUndefined()
		expect(committableEngine(undefined, 'namzu', idle)).toBeUndefined()
	})
	it('refuses while busy or disabled', () => {
		expect(committableEngine(view, 'codex-cli', { busy: true, disabled: false })).toBeUndefined()
		expect(committableEngine(view, 'codex-cli', { busy: false, disabled: true })).toBeUndefined()
	})
})
