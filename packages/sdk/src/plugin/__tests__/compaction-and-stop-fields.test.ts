/**
 * What a shell hook is told on `pre_compact`, `post_compact`, `turn_end` and
 * `subagent_stop` (`trigger`, `custom_instructions`, `compact_summary`,
 * `last_assistant_message`), what it can answer, and what a matcher tests.
 */

import { describe, expect, it } from 'vitest'

import type { PluginHookContext, PluginHookDefinition } from '../../types/plugin/index.js'
import { asSessionId } from '../../utils/id.js'
import { compactionHookInstructions } from '../hook-context.js'
import { createShellHook, shellHookPayload, shellHookVerdict } from '../shell-hook.js'

const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'
const entry = { command: 'x' }
const out = (stdout: unknown, exitCode = 0, stderr = '') => ({
	exitCode,
	timedOut: false,
	stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
	stderr,
})
const payload = (input: Parameters<typeof shellHookPayload>[0]) =>
	JSON.parse(shellHookPayload(input)) as Record<string, unknown>

describe('the compaction payload', () => {
	const info = {
		reason: 'manual',
		trigger: 'manual',
		tokensBefore: 900,
		contextWindowTokens: 2000,
	} as const

	it('keeps the compaction object and adds trigger and custom_instructions on pre_compact', () => {
		const body = payload({
			event: 'pre_compact',
			cwd: '/p',
			sessionId: SESSION,
			compaction: { ...info, instructions: 'keep the tests' },
		})
		expect(body.compaction).toEqual(info)
		expect(body.trigger).toBe('manual')
		expect(body.custom_instructions).toBe('keep the tests')
		expect(body).not.toHaveProperty('compact_summary')
	})

	it('sends custom_instructions as null when there are none', () => {
		const body = payload({
			event: 'pre_compact',
			cwd: '/p',
			sessionId: SESSION,
			compaction: { ...info, trigger: 'auto', instructions: null },
		})
		expect(body.custom_instructions).toBeNull()
		expect(body.trigger).toBe('auto')
	})

	it('sends compact_summary on post_compact and no custom_instructions', () => {
		const body = payload({
			event: 'post_compact',
			cwd: '/p',
			sessionId: SESSION,
			compaction: { ...info, tokensAfter: 100, summary: 'the summary' },
		})
		expect(body.compact_summary).toBe('the summary')
		expect(body).not.toHaveProperty('custom_instructions')
		expect(body.compaction).toEqual({ ...info, tokensAfter: 100 })
	})

	it('still works for a context without a trigger', () => {
		const body = payload({
			event: 'pre_compact',
			cwd: '/p',
			sessionId: SESSION,
			compaction: { reason: 'threshold', tokensBefore: 1, contextWindowTokens: 2 },
		})
		expect(body).not.toHaveProperty('trigger')
	})
})

describe('last_assistant_message', () => {
	it('is sent on turn_end and subagent_stop, and left out when absent', () => {
		for (const event of ['turn_end', 'subagent_stop'] as const) {
			expect(
				payload({ event, cwd: '/p', sessionId: SESSION, lastAssistantMessage: 'All done.' })
					.last_assistant_message,
			).toBe('All done.')
			expect(payload({ event, cwd: '/p', sessionId: SESSION })).not.toHaveProperty(
				'last_assistant_message',
			)
		}
	})
})

describe('what a pre_compact hook can answer', () => {
	it('takes plain stdout as instructions for the summariser', () => {
		expect(shellHookVerdict('pre_compact', entry, out('keep ticket 4242\n'))).toEqual({
			action: 'annotate',
			text: 'keep ticket 4242',
		})
	})

	it('takes additionalContext from the JSON answer', () => {
		const verdict = shellHookVerdict(
			'pre_compact',
			entry,
			out({ hookSpecificOutput: { hookEventName: 'PreCompact', additionalContext: ' keep it ' } }),
		)
		expect(verdict).toEqual({ action: 'continue', context: 'keep it' })
	})

	it('says nothing for a hook that printed nothing', () => {
		expect(shellHookVerdict('pre_compact', entry, out(''))).toEqual({ action: 'continue' })
	})

	it('still refuses on exit 2 and on decision block', () => {
		expect(shellHookVerdict('pre_compact', entry, out('', 2, 'freeze'))).toMatchObject({
			action: 'skip',
			reason: 'freeze',
		})
		expect(
			shellHookVerdict('pre_compact', entry, out({ decision: 'block', reason: 'no' })),
		).toMatchObject({
			action: 'skip',
			reason: 'no',
		})
	})

	it('does not turn post_compact stdout into anything', () => {
		expect(shellHookVerdict('post_compact', entry, out('saved'))).toEqual({ action: 'continue' })
	})
})

describe('the instructions a set of answers gives', () => {
	it('joins annotate, continue context and refusal context in answer order, trimmed', () => {
		expect(
			compactionHookInstructions([
				{ action: 'annotate', text: ' one ' },
				{ action: 'continue', context: 'two' },
				{ action: 'skip', reason: 'r', context: 'three' },
				{ action: 'continue' },
				{ action: 'error', message: 'x' },
			]),
		).toBe('one\n\ntwo\n\nthree')
	})

	it('is undefined when nothing was said, and bounded to 8000 characters', () => {
		expect(compactionHookInstructions([{ action: 'continue' }])).toBeUndefined()
		const long = compactionHookInstructions([{ action: 'annotate', text: 'y'.repeat(9000) }])
		expect(long?.length).toBe(8000 + '\n[truncated]'.length)
	})
})

describe('a matcher on the compaction events', () => {
	async function ran(
		event: 'pre_compact' | 'post_compact',
		matcher: string,
		trigger: 'manual' | 'auto',
	) {
		const hook = createShellHook(
			event,
			{ command: `echo '{"continue":false}'`, matcher },
			{ cwd: process.cwd() },
		) as PluginHookDefinition & {
			handler: (c: PluginHookContext) => Promise<{ action: string }>
		}
		const context = {
			event,
			pluginId: 'p',
			sessionId: asSessionId(SESSION),
			compaction: { reason: 'manual', trigger, tokensBefore: 1, contextWindowTokens: 2 },
		} as unknown as PluginHookContext
		// The command asks for a stop, so a hook that RAN answers `continue` with a `halt`; one that
		// did not match is a bare `continue`.
		const verdict = await hook.handler(context)
		return JSON.stringify(verdict) !== JSON.stringify({ action: 'continue' })
	}

	it('tests the trigger', async () => {
		expect(await ran('pre_compact', 'manual', 'manual')).toBe(true)
		expect(await ran('pre_compact', 'manual', 'auto')).toBe(false)
		expect(await ran('pre_compact', 'auto', 'auto')).toBe(true)
		expect(await ran('post_compact', 'manual|auto', 'auto')).toBe(true)
		expect(await ran('pre_compact', '*', 'manual')).toBe(true)
	})
})
