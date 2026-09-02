import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import { RepeatCallTracker } from '../repeat-call.js'

/**
 * Nothing observed cross-call repetition.
 *
 * The guardrails screen calls in isolation — input at run start, output at
 * run end, one result at a time — so a model re-running a failing command
 * got no correction from anything in the kernel. The only lever was an
 * iteration checkpoint, which fires on a count regardless of whether
 * anything is repeating and needs a human at the other end.
 *
 * It advises and does not deny a repeat that succeeds, and that is a
 * decision rather than caution: polling for a build to finish is the same
 * call by design, and a tracker that refused would break that case to fix
 * a different one. The one refusal it makes — the same call failing the
 * same way over and over — is in its own test. What the
 * model lacks is not permission but the observation — each turn it sees a
 * history, not a count.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const call = (args: Record<string, unknown>, id: string): MockTurn => ({
	toolCalls: [{ id, name: 'probe', args }],
	finishReason: 'tool_calls',
})

function tools(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(
		defineTool({
			name: 'probe',
			description: 'answers the same way every time',
			inputSchema: z.object({
				q: z.string().optional(),
				a: z.number().optional(),
				b: z.number().optional(),
			}),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'same answer' }),
		}),
	)
	return registry
}

async function run(opts: {
	readonly turns: readonly MockTurn[]
	readonly advisory?: boolean
}): Promise<Message[]> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-repeat-'))
	dirs.push(workingDirectory)

	const result = await drainQuery({
		provider: new MockLLMProvider({ turns: [...opts.turns, { text: 'done' }] }),
		tools: tools(),
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 10 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: 'ses_r' as SessionId,
		topicId: 'top_r' as TopicId,
		projectId: 'prj_r' as ProjectId,
		tenantId: 'tnt_r' as TenantId,
		...(opts.advisory === false ? { repeatCallAdvisory: false } : {}),
	})
	return result.messages
}

const toolText = (messages: readonly Message[]): string[] =>
	messages
		.filter((m) => m.role === 'tool' && typeof m.content === 'string')
		.map((m) => m.content as string)

describe('a model repeating itself is told, not stopped', () => {
	it('says nothing for the first two identical calls and speaks on the third', async () => {
		const same = { q: 'x' }
		const messages = await run({
			turns: [call(same, 'c1'), call(same, 'c2'), call(same, 'c3')],
		})

		const results = toolText(messages)
		expect(results).toHaveLength(3)
		expect(results[0], 'advised on the first call').not.toContain('identical arguments')
		expect(results[1], 'advised on the second call').not.toContain('identical arguments')
		expect(results[2]).toContain('call 3 of `probe` with identical arguments')
	})

	it('still runs the repeated call and returns its real result', async () => {
		// The advisory must not become a gate. If the third call were denied,
		// its own output would be missing from the batch it rode out on.
		const same = { q: 'x' }
		const messages = await run({
			turns: [call(same, 'c1'), call(same, 'c2'), call(same, 'c3')],
		})

		expect(toolText(messages)[2]).toContain('same answer')
	})

	it('treats a key-order difference as the same call, and a value difference as not', async () => {
		// Proves the key goes through `stableStringify`. Built with
		// `JSON.stringify` instead, the first three below hash three ways and
		// nothing is ever reported.
		const messages = await run({
			turns: [
				call({ a: 1, b: 2 }, 'c1'),
				call({ b: 2, a: 1 }, 'c2'),
				call({ a: 1, b: 2 }, 'c3'),
				call({ a: 1, b: 99 }, 'c4'),
			],
		})

		const results = toolText(messages)
		expect(results[2], 'key order was treated as a different call').toContain('call 3 of `probe`')
		expect(results[3], 'a genuinely different argument was counted as a repeat').not.toContain(
			'identical arguments',
		)
	})

	it('escalates once, not on every subsequent turn', async () => {
		const same = { q: 'x' }
		const messages = await run({
			turns: Array.from({ length: 6 }, (_, i) => call(same, `c${i + 1}`)),
		})

		const results = toolText(messages)
		const escalated = results.filter((r) => r.includes('Repeating it again'))
		const noticed = results.filter((r) => r.includes('is call'))

		expect(escalated, 'escalated more than once').toHaveLength(1)
		expect(noticed, 'the mild notice repeated').toHaveLength(1)
	})

	it('adds nothing at all when the host opts out', async () => {
		// The opt-out removes the tracker rather than gating a branch, so an
		// opted-out run is byte-identical to one from before this existed.
		const same = { q: 'x' }
		const messages = await run({
			turns: [call(same, 'c1'), call(same, 'c2'), call(same, 'c3'), call(same, 'c4')],
			advisory: false,
		})

		for (const text of toolText(messages)) {
			expect(text).not.toContain('identical arguments')
		}
	})

	it('starts at zero for a second run, so a count cannot leak across runs', async () => {
		// Run-scoped, like `ToolGrantSet`. A module-level map would carry the
		// first run's three calls into the second and advise on its first.
		//
		// The argument is unique to this test on purpose. Sharing `{ q: 'x' }`
		// with the cases above made this pass under a module-scoped tracker —
		// by then the key had already been announced, so the suppression that
		// stops a notice repeating also hid the leak. A test that cannot fail
		// because an earlier test exhausted its subject is not testing this.
		// TWO calls in the first run, one in the second — chosen so the second
		// run's single call is the one that would cross `notifyAfter: 3` if the
		// counts carried. Three-then-one does NOT discriminate: a shared
		// tracker would already have announced at three, and the suppression
		// that stops a notice repeating would then hide the leak.
		const mine = { q: 'leak-check' }
		await run({ turns: [call(mine, 'c1'), call(mine, 'c2')] })
		const second = await run({ turns: [call(mine, 'c1')] })

		expect(toolText(second)[0]).not.toContain('identical arguments')
	})
})

describe('the tracker itself', () => {
	it('counts by call identity, not by tool name', () => {
		const tracker = new RepeatCallTracker()

		expect(tracker.record('probe', { a: 1 })).toBeUndefined()
		expect(tracker.record('probe', { a: 2 })).toBeUndefined()
		expect(tracker.record('probe', { a: 1 })).toBeUndefined()
		// Third of THIS call, though it is the fourth `probe` overall.
		expect(tracker.record('probe', { a: 1 })?.count).toBe(3)
	})
})
