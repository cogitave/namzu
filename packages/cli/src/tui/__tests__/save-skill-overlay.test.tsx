/**
 * The save-skill screen shows the whole file with hidden characters revealed,
 * where each choice writes and what it replaces, opens on Cancel, and saves
 * atomically only on an explicit choice.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type SaveSkillAnswer,
	type SaveSkillRequest,
	buildSaveSkillTool,
} from '../../skills/save.js'
import { SaveSkillOverlay } from '../SaveSkillOverlay.js'

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

let home: string
let cwd: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-overlay-home-'))
	cwd = mkdtempSync(join(tmpdir(), 'namzu-overlay-cwd-'))
})
afterEach(() => {
	removeTempDir(home)
	removeTempDir(cwd)
})

/**
 * Drive the real tool with the real overlay as its confirmation: the tool
 * builds the request, the overlay answers it from keys.
 */
async function proposeAndAnswer(
	input: Record<string, unknown>,
	keys: readonly string[],
): Promise<{ frame: string; answer: SaveSkillAnswer; request: SaveSkillRequest; result: unknown }> {
	let frame = ''
	let request: SaveSkillRequest | undefined
	let answer: SaveSkillAnswer | undefined
	const tool = buildSaveSkillTool({
		cwd: () => cwd,
		home: () => home,
		sessionId: () => 'session-7',
		confirm: (req) =>
			new Promise<SaveSkillAnswer>((resolve) => {
				request = req
				const harness = render(
					<SaveSkillOverlay
						request={req}
						cwd={cwd}
						columns={100}
						rows={60}
						onAnswer={(value) => {
							answer = value
							harness.unmount()
							resolve(value)
						}}
					/>,
				)
				void (async () => {
					await tick()
					frame = harness.lastFrame() ?? ''
					for (const key of keys) {
						harness.stdin.write(key)
						await tick()
					}
				})()
			}),
	})
	const result = await tool.execute(tool.inputSchema.parse(input) as never, {} as never)
	return {
		frame,
		answer: answer as SaveSkillAnswer,
		request: request as SaveSkillRequest,
		result,
	}
}

const draft = {
	name: 'skill-creator',
	description: 'My own skill creator. Use when the user asks to make a skill.',
	body: 'Ask first.\nThen draft.\u200b\n\n```sh\n    indented line kept\n```',
	scope: 'user',
}

describe('the save-skill screen', () => {
	it('renders the full SKILL.md with hidden characters revealed, the targets and what it replaces', async () => {
		const { frame } = await proposeAndAnswer(draft, ['\u001b'])
		expect(frame).toContain('Save skill "skill-creator"')
		expect(frame).toContain('PROPOSED BY THE MODEL')
		expect(frame).toContain('namzu-origin: created')
		expect(frame).toContain('namzu-session: "session-7"')
		expect(frame).toContain('Then draft.<U+200B>')
		expect(frame).not.toContain('\u200b')
		expect(frame).toContain('│     indented line kept')
		expect(frame).toContain('./.namzu/skills/skill-creator/SKILL.md')
		expect(frame).toContain('(suggested)')
		// The user save shadows the built-in skill of the same name.
		// A long path wraps inside the box; read it with the rows joined.
		const flat = frame.replace(/[│\s]/g, '')
		expect(flat).toMatch(/replacesbuilt-inskill\S*packages\/cli\/skills\/skill-creator\/SKILL\.md/)
		expect(frame).toContain('Warning  The skill contains invisible or direction-changing characters.')
		expect(frame).toContain('Save to user')
		expect(frame).toContain('Save to project')
		expect(frame).toContain('Cancel')
	})

	it('opens on Cancel: Enter alone writes nothing', async () => {
		const { answer, result } = await proposeAndAnswer(draft, ['\r'])
		expect(answer).toBe('cancel')
		expect((result as { success: boolean }).success).toBe(false)
		expect(existsSync(join(home, '.namzu', 'skills'))).toBe(false)
		expect(existsSync(join(cwd, '.namzu'))).toBe(false)
	})

	it('Esc cancels', async () => {
		const { answer } = await proposeAndAnswer(draft, ['\u001b'])
		expect(answer).toBe('cancel')
		expect(existsSync(join(home, '.namzu', 'skills'))).toBe(false)
	})

	it('saves to the user tier on 1 then Enter, writing SKILL.md only, exactly as shown', async () => {
		const { answer, request, result } = await proposeAndAnswer(draft, ['1', '\r'])
		expect(answer).toBe('user')
		expect((result as { success: boolean }).success).toBe(true)
		const dir = join(home, '.namzu', 'skills', 'skill-creator')
		expect(readdirSync(dir)).toEqual(['SKILL.md'])
		expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(request.markdown)
		expect((result as { output: string }).output).toContain('replaces built-in skill')
	})

	it('saves to the project tier on 2 then Enter', async () => {
		const { answer } = await proposeAndAnswer(draft, ['2', '\r'])
		expect(answer).toBe('project')
		expect(existsSync(join(cwd, '.namzu', 'skills', 'skill-creator', 'SKILL.md'))).toBe(true)
		expect(existsSync(join(home, '.namzu', 'skills'))).toBe(false)
	})
})
