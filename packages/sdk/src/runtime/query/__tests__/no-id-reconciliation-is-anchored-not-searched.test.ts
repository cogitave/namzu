import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * A third round of review found the suffix-search fallback
 * (`a-cached-suffix-or-a-stripped-cache-still-reconciles.test.ts`'s own
 * `largestSuffixAlignment`) was itself unsound: searching for SOME aligned
 * position cannot tell a caller echoing old content from a caller writing
 * new content that happens to match, in either direction. Replaced with an
 * ANCHORED rule (`reconcileNoIdAgainstFold` in `prepare-turn.ts`): the only
 * shape ever recognized as "my cache, trimmed to a prefix of the fold" is
 * the caller's own no-id messages starting with an EXACT match of the
 * fold's own remaining no-id-eligible messages, from position zero. A
 * cache with fewer messages than that, or one that diverges from the very
 * first message, is never matched by value at all — every message it sent
 * is new. This is the documented trade-off: a host without ids reconciles
 * a trimmed (partial) cache correctly only when ids are involved elsewhere
 * in the same call; a wholly no-id partial cache is not reconciled by
 * value beyond the exact prefix case, and must adopt ids instead.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workingDirectory(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-anchored-noid-'))
	dirs.push(dir)
	return dir
}

function identity() {
	return {
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		projectId: generateProjectId(),
		tenantId: generateTenantId(),
	}
}

const turnConfig = { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 4 }

/** A provider whose stream never resolves until aborted, like a dropped connection. */
class HeldProvider extends MockLLMProvider {
	override async *chatStream(params: Parameters<MockLLMProvider['chatStream']>[0]) {
		this.requests.push(params)
		let onAbort: () => void = () => {}
		await new Promise<void>((resolve) => {
			onAbort = resolve
			params.signal?.addEventListener('abort', onAbort, { once: true })
		})
		params.signal?.removeEventListener('abort', onAbort)
		params.signal?.throwIfAborted()
	}
}

describe('no-id reconciliation is anchored to the fold, never searched', () => {
	it('does not swallow a genuinely new message that repeats an interrupted turn’s own trailing prompt', async () => {
		const cwd = await workingDirectory()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })
		const controller = new AbortController()
		const cancelled = drainQuery({
			provider: new HeldProvider(),
			tools: new ToolRegistry(),
			messages: [createUserMessage('yes')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			signal: controller.signal,
			...scope,
		})
		controller.abort()
		await cancelled.catch(() => undefined)

		// A single no-id message, the caller's ENTIRE request, whose content
		// coincidentally equals the fold's only (and last) message — the
		// exact shape a wholly no-id caller cannot tell apart from an echo,
		// so it must be new by this rule's own design.
		const provider2 = new MockLLMProvider({ responseText: 'turn two reply' })
		const run2 = await drainQuery({
			provider: provider2,
			tools: new ToolRegistry(),
			messages: [{ role: 'user', content: 'yes' } as Message],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})

		expect(run2.status).toBe('completed')
		const sent = provider2.requests[0]?.messages ?? []
		const yesCount = sent.filter((m) => m.role === 'user' && m.content === 'yes').length
		expect(yesCount).toBe(2)
	})

	it('keeps both messages of a new batch, unrefused, when the first coincides with an old non-tail message', async () => {
		const cwd = await workingDirectory()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })
		await drainQuery({
			provider: new MockLLMProvider({ responseText: 'hi there' }),
			tools: new ToolRegistry(),
			messages: [createUserMessage('hello')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})
		await drainQuery({
			provider: new MockLLMProvider({ responseText: 'good' }),
			tools: new ToolRegistry(),
			messages: [createUserMessage('how are you')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})

		// Two new, no-id messages in one call. The first repeats the fold's
		// FIRST (non-tail) message; the second is unique. Fewer messages
		// than the fold (2 < 4) means this is `'new'` outright — never
		// checked for alignment, so never refused as `'unaligned'` either.
		const provider = new MockLLMProvider({ responseText: 'turn reply' })
		const run = await drainQuery({
			provider,
			tools: new ToolRegistry(),
			messages: [
				{ role: 'user', content: 'hello' } as Message,
				{ role: 'user', content: 'a brand new, never-before-seen message' } as Message,
			],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})

		expect(run.status).toBe('completed')
		const sent = provider.requests[0]?.messages ?? []
		expect(sent.filter((m) => m.role === 'user' && m.content === 'hello')).toHaveLength(2)
		expect(
			sent.filter(
				(m) => m.role === 'user' && m.content === 'a brand new, never-before-seen message',
			),
		).toHaveLength(1)
	})

	it('drops a full resend and keeps a repeated final message as new, without duplicating or erroring', async () => {
		const cwd = await workingDirectory()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })
		const run1 = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'ok' }),
			tools: new ToolRegistry(),
			messages: [createUserMessage('yes')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})
		expect(run1.status).toBe('completed')
		const stripped = run1.messages
			.filter((m) => m.role !== 'system')
			.map(({ id: _id, ...rest }) => rest as Message)

		const provider2 = new MockLLMProvider({ responseText: 'turn two reply' })
		const run2 = await drainQuery({
			provider: provider2,
			tools: new ToolRegistry(),
			// The whole prior turn, unmodified, PLUS a new final message that
			// happens to repeat the earlier "yes". It is never compared to
			// anything — it sits after the exactly-matched prefix — so it
			// cannot be swallowed.
			messages: [...stripped, { role: 'user', content: 'yes' } as Message],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})

		expect(run2.status).toBe('completed')
		const sent = provider2.requests[0]?.messages ?? []
		expect(sent.filter((m) => m.role === 'user' && m.content === 'yes')).toHaveLength(2)
		expect(sent.filter((m) => m.role === 'assistant' && m.content === 'ok')).toHaveLength(1)
	})

	it('refuses a diverged full resend as stale_cached_history/unaligned, never a duplicate or a silent drop', async () => {
		const cwd = await workingDirectory()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })
		const run1 = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'ok' }),
			tools: new ToolRegistry(),
			messages: [createUserMessage('yes')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})
		const stripped = run1.messages
			.filter((m) => m.role !== 'system')
			.map(({ id: _id, ...rest }) => rest as Message)

		// The first message still matches the fold's first, but the second
		// (the assistant's answer) does not — an attempted full resend of a
		// fold this log does not actually hold.
		const diverged = stripped.map((message, index) =>
			index === 1 ? { ...message, content: 'EDITED answer' } : message,
		)

		const refusal = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'unused' }),
			tools: new ToolRegistry(),
			messages: [...diverged, createUserMessage('a new message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		}).catch((error: unknown) => error)

		expect(refusal).toMatchObject({ code: 'stale_cached_history', details: { kind: 'unaligned' } })
	})

	it('treats every message as new against an empty fold — the trivial case of a full resend', async () => {
		const cwd = await workingDirectory()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })
		const provider = new MockLLMProvider({ responseText: 'first reply' })

		const run = await drainQuery({
			provider,
			tools: new ToolRegistry(),
			messages: [createUserMessage('first ever message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})

		expect(run.status).toBe('completed')
		const sent = provider.requests[0]?.messages ?? []
		expect(sent.some((m) => m.role === 'user' && m.content === 'first ever message')).toBe(true)
	})

	it('is new-only (never matched by value) for a cache with fewer messages than the fold, even one whose first equals the fold’s first', async () => {
		// Documents the trade-off deliberately: a partial, no-id cache SHORTER
		// than what remains of the fold is never recognized as "part of the
		// fold" by value — only a length exactly matching or exceeding it can
		// be. A host that wants a partial cache reconciled correctly (no
		// duplication) must adopt `.id`; see docs/sdk/session-log.md.
		const cwd = await workingDirectory()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })
		await drainQuery({
			provider: new MockLLMProvider({ responseText: 'hi there' }),
			tools: new ToolRegistry(),
			messages: [createUserMessage('hello')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})
		await drainQuery({
			provider: new MockLLMProvider({ responseText: 'good' }),
			tools: new ToolRegistry(),
			messages: [createUserMessage('how are you')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})

		// One message: fewer than the fold's remaining 4. Its content equals
		// the fold's own first message, but that is never checked — the
		// length test alone routes this to "new", so it is kept (and, as
		// documented, this is where a no-id host's genuine trim would
		// duplicate; only ids resolve that correctly).
		const provider = new MockLLMProvider({ responseText: 'turn reply' })
		const run = await drainQuery({
			provider,
			tools: new ToolRegistry(),
			messages: [{ role: 'user', content: 'hello' } as Message],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})

		expect(run.status).toBe('completed')
		const sent = provider.requests[0]?.messages ?? []
		expect(sent.filter((m) => m.role === 'user' && m.content === 'hello')).toHaveLength(2)
	})

	it('recognizes an exact full resend with nothing new when an id-carrying message anchors the same call', async () => {
		// The one place `>` alone (with no exception) would itself crash: a
		// wholesale history replacement (`TurnRecorder.replaceMessages`,
		// used by compaction and by provider-rejected-image recovery) is
		// recorded as one bulk, no-id segment — real production shape, see
		// `provider-rejected-image-recovery.test.ts`. Resending exactly that
		// segment back, unmodified, alongside an id-carrying message from
		// the SAME turn (the kernel's own settled answer), must be
		// recognized as fully durable, not re-sent as new — new content
		// duplicating a tool call there would trip `validateToolCallIds`.
		const cwd = await workingDirectory()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })
		const run1 = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'settled answer' }),
			tools: new ToolRegistry(),
			messages: [createUserMessage('question')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})
		expect(run1.status).toBe('completed')
		const settled = run1.messages.filter((m) => m.role !== 'system')
		// The user's own message never got an id in this fixture (it is not
		// durably distinguishable from a bulk-replaced segment for this
		// test's purpose) — strip it to model that; keep the assistant
		// reply's real id, the anchor.
		const noIdPrefixPlusIdTail = settled.map((message, index) =>
			index === settled.length - 1 ? message : ({ ...message, id: undefined } as Message),
		)

		const provider2 = new MockLLMProvider({ responseText: 'reply after resend' })
		const run2 = await drainQuery({
			provider: provider2,
			tools: new ToolRegistry(),
			messages: noIdPrefixPlusIdTail,
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})

		expect(run2.status).toBe('completed')
		const sent = provider2.requests[0]?.messages ?? []
		expect(sent.filter((m) => m.role === 'user' && m.content === 'question')).toHaveLength(1)
		expect(
			sent.filter((m) => m.role === 'assistant' && m.content === 'settled answer'),
		).toHaveLength(1)
	})
})
