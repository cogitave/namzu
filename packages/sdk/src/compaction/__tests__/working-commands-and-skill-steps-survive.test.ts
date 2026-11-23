import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import { renderLoadedSkills, withoutExampleSections } from '../loaded-skills.js'
import { MAX_WORKING_COMMANDS, WorkingStateManager } from '../manager.js'
import {
	carriedWorkingCommands,
	isRunnerCommand,
	recordRestorable,
	renderRestoredContext,
} from '../restore.js'
import { restoreWorkingState, snapshotWorkingState } from '../wire.js'

const config = CompactionConfigSchema.parse({})
const manager = () => new WorkingStateManager(config)
const ran = (m: WorkingStateManager, command: string, success = true) =>
	recordRestorable(m, { toolName: 'bash', input: { command }, output: 'ok', success })

describe('the commands that worked are put back after a compaction', () => {
	it('keeps a successful runner command and ignores a failed or unrelated one', () => {
		const m = manager()
		ran(m, 'node --test src/a.test.js')
		ran(m, 'node.exe --test "$(wslpath -w src)"', false)
		ran(m, 'ls -la')
		const text = renderRestoredContext(m.getState()) ?? ''
		expect(text).toContain('### Working commands')
		expect(text).toContain('- `node --test src/a.test.js`')
		expect(text).not.toContain('ls -la')
		expect(text).not.toContain('wslpath')
	})

	it('lists a repeated command once, newest last, and keeps the newest few', () => {
		const m = manager()
		for (let i = 0; i < MAX_WORKING_COMMANDS + 3; i += 1) ran(m, `cargo test case${i}`)
		ran(m, 'cargo test case5')
		const commands = m.getState().restorable?.commands ?? []
		expect(commands).toHaveLength(MAX_WORKING_COMMANDS)
		expect(commands[commands.length - 1]).toBe('cargo test case5')
		expect(commands.filter((command) => command === 'cargo test case5')).toHaveLength(1)
	})

	it('survives a snapshot and is read back from the summary it was written into', () => {
		const m = manager()
		ran(m, 'pnpm --filter x test')
		const again = restoreWorkingState(snapshotWorkingState(m), config)
		expect(again.getState().restorable?.commands).toEqual(['pnpm --filter x test'])
		const text = renderRestoredContext(m.getState()) ?? ''
		expect(carriedWorkingCommands(`summary\n\n${text}\n\n### File: a.ts\n\nbody`)).toEqual([
			'pnpm --filter x test',
		])
		const next = manager()
		next.adoptWorkingCommands(carriedWorkingCommands(text))
		ran(next, 'cargo build')
		expect(next.getState().restorable?.commands).toEqual(['pnpm --filter x test', 'cargo build'])
	})

	it('knows a runner command from other shell lines', () => {
		expect(isRunnerCommand('cd app && npm test')).toBe(true)
		expect(isRunnerCommand('git status')).toBe(false)
	})
})

describe('a skill is put back without its worked examples', () => {
	const body =
		'# Check\n\n## Steps\n\n1. Do the thing.\n\n## Example report\n\nA long sample.\n\n## Never\n\nSkip it.'

	it('drops an Example section and keeps the sections around it', () => {
		const { text, dropped } = withoutExampleSections(body)
		expect(dropped).toBe(true)
		expect(text).toContain('1. Do the thing.')
		expect(text).toContain('## Never')
		expect(text).not.toContain('A long sample.')
	})

	it('leaves a skill with no example alone, and renders the rest with a note', () => {
		expect(withoutExampleSections('# A\n\n## Steps\n\nGo.').dropped).toBe(false)
		const rendered = renderLoadedSkills([{ name: 'check', body }])
		expect(rendered.text).toContain('1. Do the thing.')
		expect(rendered.text).not.toContain('A long sample.')
		expect(rendered.text).toContain('Example sections left out')
	})
})
