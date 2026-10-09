import { describe, expect, it } from 'vitest'
import { engineStartName, startingLabel, startsAProcess } from './engine-starting.js'

describe('the engine starting label', () => {
	it('names the engine without its suffix and shows no count at first', () => {
		expect(engineStartName('Codex CLI')).toBe('Codex')
		expect(engineStartName('Claude Code')).toBe('Claude Code')
		expect(startingLabel('Codex CLI', 0)).toBe('Starting Codex…')
		expect(startingLabel('Codex CLI', 999)).toBe('Starting Codex…')
	})

	it('counts whole seconds from the first second on', () => {
		expect(startingLabel('Codex CLI', 1000)).toBe('Starting Codex… 1s')
		expect(startingLabel('Codex CLI', 3999)).toBe('Starting Codex… 3s')
		expect(startingLabel('Claude Code', 12_000)).toBe('Starting Claude Code… 12s')
	})

	it('only external engines start a process', () => {
		expect(startsAProcess('codex-cli')).toBe(true)
		expect(startsAProcess('claude-code')).toBe(true)
		expect(startsAProcess('namzu')).toBe(false)
		expect(startsAProcess(undefined)).toBe(false)
	})
})
