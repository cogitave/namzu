import { describe, expect, it } from 'vitest'

import {
	MAX_SKILL_HOOKS_SOURCE_CHARS,
	MAX_SKILL_HOOK_ENTRIES,
	MAX_SKILL_HOOK_MATCHER_CHARS,
	readSkillHooks,
} from './skill-hooks-reader.js'

/**
 * A skill's `hooks` block goes through the config loader's own reader. What
 * differs is what one bad entry costs: the skill still loads, but an entry on
 * a guarding event that cannot be loaded costs it its hooks and its tool
 * pre-approval, and the reader says so in `guardLost`.
 */

const read = (text: string) => readSkillHooks(text, 'skill s')

describe('a skill’s hooks, in either shape', () => {
	it('reads the common shape: PascalCase events, groups with a matcher, written tool names', () => {
		const out = read(
			[
				'hooks:',
				'  PreToolUse:',
				'    - matcher: Bash',
				'      hooks:',
				'        - type: command',
				'          command: ./guard.sh',
				'          args: ["--strict"]',
				'          timeout: 5',
				'          once: true',
			].join('\n'),
		)
		expect(out.guardLost).toBe(false)
		expect(out.problems).toEqual([])
		expect(out.count).toBe(1)
		expect(out.hooks.pre_tool_use).toEqual([
			{
				command: './guard.sh',
				args: ['--strict'],
				matcher: 'Bash',
				timeoutMs: 5000,
				once: true,
				toolNames: 'written',
			},
		])
	})

	it('reads our own shape: event to a flat list', () => {
		const out = read(
			['hooks:', '  pre_tool_use:', '    - command: ./guard.sh', '      matcher: bash'].join('\n'),
		)
		expect(out.guardLost).toBe(false)
		expect(out.hooks.pre_tool_use).toEqual([{ command: './guard.sh', matcher: 'bash' }])
	})

	it('reads both spellings of an event in one block, their entries joined', () => {
		const out = read(
			[
				'hooks:',
				'  pre_tool_use:',
				'    - command: a',
				'  PreToolUse:',
				'    - hooks:',
				'        - command: b',
			].join('\n'),
		)
		expect(out.hooks.pre_tool_use?.map((entry) => (entry as { command: string }).command)).toEqual([
			'a',
			'b',
		])
	})

	it('reads http and prompt hooks', () => {
		const out = read(
			[
				'hooks:',
				'  Stop:',
				'    - hooks:',
				'        - type: http',
				'          url: https://example.invalid/hook',
				'        - type: prompt',
				'          prompt: is it done?',
			].join('\n'),
		)
		expect(out.count).toBe(2)
		expect(out.guardLost).toBe(false)
	})

	it('says nothing and loads nothing for a key with nothing after it', () => {
		expect(read('hooks:')).toMatchObject({ count: 0, guardLost: false, problems: [] })
	})
})

describe('an entry that cannot be loaded', () => {
	it('on a guarding event loses the guard, by name, and the other entries still read', () => {
		const out = read(
			[
				'hooks:',
				'  PreToolUse:',
				'    - hooks:',
				'        - type: command',
				'          args: ["a"]',
				'        - command: ./fine.sh',
			].join('\n'),
		)
		expect(out.guardLost).toBe(true)
		expect(out.problems).toContainEqual(
			expect.objectContaining({
				event: 'PreToolUse',
				severity: 'problem',
				message: expect.stringContaining('has no "command"'),
			}),
		)
		// One hook that cannot be read never switches off the others.
		expect(out.hooks.pre_tool_use).toEqual([{ command: './fine.sh', toolNames: 'written' }])
	})

	it('in our own shape, with a wrong value, is set aside by position on a guarding event', () => {
		const out = read(
			[
				'hooks:',
				'  pre_tool_use:',
				'    - command: ./a.sh',
				'      matcher: [1]',
				'    - command: ./b.sh',
			].join('\n'),
		)
		expect(out.guardLost).toBe(true)
		expect(out.problems[0]?.message).toContain('entry 1')
		expect(out.problems[0]?.message).toContain('matcher')
		expect(out.hooks.pre_tool_use).toEqual([{ command: './b.sh' }])
	})

	it('on a non-guarding event is dropped with a note and does not cost the guard', () => {
		const out = read(
			[
				'hooks:',
				'  session_start:',
				'    - command: ./a.sh',
				'      timeoutMs: soon',
				'  pre_tool_use:',
				'    - command: ./guard.sh',
			].join('\n'),
		)
		expect(out.guardLost).toBe(false)
		expect(out.problems).toEqual([
			expect.objectContaining({ event: 'session_start', severity: 'note' }),
		])
		expect(out.hooks.session_start ?? []).toEqual([])
		expect(out.hooks.pre_tool_use).toEqual([{ command: './guard.sh' }])
	})

	it('under an event this kernel does not have is dropped with a note', () => {
		const out = read(
			[
				'hooks:',
				'  SomethingElse:',
				'    - hooks:',
				'        - command: x',
				'  Stop:',
				'    - hooks:',
				'        - command: y',
			].join('\n'),
		)
		expect(out.guardLost).toBe(false)
		expect(out.problems).toEqual([
			expect.objectContaining({ event: 'SomethingElse', severity: 'note' }),
		])
		expect(out.hooks.turn_end).toBeDefined()
	})

	it('under a renamed event whose replacement guards something loses the guard; one whose replacement does not is a note', () => {
		// `run_end` became `turn_end`, an event that can send the model back to work.
		const guard = read(['hooks:', '  run_end:', '    - command: x'].join('\n'))
		expect(guard.guardLost).toBe(true)
		expect(guard.problems[0]?.message).toContain('turn_end')
		// `run_start` became `turn_start`, which only starts a turn.
		const quiet = read(['hooks:', '  run_start:', '    - command: x'].join('\n'))
		expect(quiet.guardLost).toBe(false)
		expect(quiet.problems[0]).toMatchObject({ event: 'run_start', severity: 'note' })
	})

	it('that is not a list loses the guard on a guarding event', () => {
		const out = read(['hooks:', '  PreToolUse:', '    matcher: Bash'].join('\n'))
		expect(out.guardLost).toBe(true)
		expect(out.count).toBe(0)
	})
})

describe('a block that cannot be told from a guard', () => {
	it('that is not YAML loses the guard', () => {
		const out = read('hooks:\n  PreToolUse: [\n')
		expect(out.guardLost).toBe(true)
		expect(out.problems[0]?.message).toContain('YAML')
	})

	it('that is not a mapping loses the guard', () => {
		const out = read('hooks:\n  - PreToolUse')
		expect(out.guardLost).toBe(true)
	})
})

describe('bounds', () => {
	const many = (n: number) =>
		[
			'hooks:',
			'  session_start:',
			...Array.from({ length: n }, (_, i) => `    - command: c${i}`),
		].join('\n')

	it('allows as many entries as the bound', () => {
		const out = read(many(MAX_SKILL_HOOK_ENTRIES))
		expect(out.guardLost).toBe(false)
		expect(out.count).toBe(MAX_SKILL_HOOK_ENTRIES)
	})

	it('loses the guard beyond the bound on entries, even when they are all of a quiet event', () => {
		const out = read(many(MAX_SKILL_HOOK_ENTRIES + 1))
		expect(out.guardLost).toBe(true)
		expect(out.count).toBe(0)
		expect(out.problems[0]?.message).toContain(`${MAX_SKILL_HOOK_ENTRIES}`)
	})

	it('loses the guard when a matcher is longer than the bound', () => {
		const long = 'a'.repeat(MAX_SKILL_HOOK_MATCHER_CHARS + 1)
		const out = read(
			['hooks:', '  pre_tool_use:', '    - command: x', `      matcher: ${long}`].join('\n'),
		)
		expect(out.guardLost).toBe(true)
		expect(out.count).toBe(0)
	})

	it('loses the guard when the text is longer than the bound', () => {
		const out = read(
			`hooks:\n  pre_tool_use:\n    - command: ${'x'.repeat(MAX_SKILL_HOOKS_SOURCE_CHARS)}`,
		)
		expect(out.guardLost).toBe(true)
	})
})
