/**
 * `run-stream --session <key>` never answers against a different history than
 * the one it was given, and never claims to have saved a turn it did not.
 *
 * Two failures at opposite ends of the same command, both of which used to be
 * a bare `catch` and an ordinary success.
 *
 * **Before the turn.** Opening the conversation set `cli = null` on any error
 * and fell through to reading prior turns from STDIN — so a caller who named a
 * conversation got a confident answer composed against somebody else's history,
 * or none, reported as exit 0. `run.ts` already refuses the equivalent, and
 * says why in the source: someone who asked for a specific conversation and got
 * a new one that looks the same finds out several turns later, having already
 * acted on it.
 *
 * It cannot be softened to a warning-and-continue, because the command cannot
 * say what was lost. `resolveConversation` CREATES the key on first use, so a
 * fresh key legitimately has no prior turns — and the failure is precisely what
 * stopped it finding out which case it is in. "Could not look" is not "there
 * was nothing there."
 *
 * **After the turn.** The append that makes `history --session` correct was
 * wrapped in `catch {}` marked `// non-fatal`. Non-fatal is right; silent is
 * not. It is the one failure here that makes a LATER command wrong — the stream
 * ends `done`, the process exits 0, and `history` then comes back missing a
 * turn the user watched arrive, with nothing connecting the two.
 */

import { type Message, createAssistantMessage } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	appendMessages,
	openSessions,
	replaceConversation,
	resolveConversation,
} from '../../integrations/sessions/store.js'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import { runStreamCommand } from '../run-stream.js'
import type { CommandContext } from '../types.js'

vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: vi.fn(async () => ({}) as never),
	resolveConversation: vi.fn(async () => 'conv-1' as never),
	loadConversation: vi.fn(async () => []),
	appendMessages: vi.fn(async () => undefined),
	replaceConversation: vi.fn(async () => undefined),
}))

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 2, provider: 'anthropic', subagents: { active: [] } },
		needsRepickReason: null,
		detected: [],
	})),
	createAgentSession: vi.fn(async () =>
		fakeAgentSession({
			providerSummary: 'stub',
			modelSummary: 'stub',
			// A reply the operator watches arrive. It is what makes the silent
			// persistence failure a lie rather than merely a gap: the words were
			// on screen, so the turn plainly happened.
			send: async function* (messages: readonly Message[], options) {
				yield { kind: 'delta', text: 'an answer' } as never
				options?.onConversationMessages?.([
					...messages,
					createAssistantMessage('an answer', undefined, [
						{ type: 'redacted_thinking', encrypted: 'OPAQUE_RUN_STREAM_STATE' },
					]),
				])
			},
		}),
	),
}))

const ctx = { config: {} } as unknown as CommandContext

function capture(): { lines: string[]; restore: () => void } {
	const lines: string[] = []
	const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
		lines.push(String(chunk))
		return true
	})
	return { lines, restore: () => spy.mockRestore() }
}

async function run(rawArgs: string[]): Promise<string> {
	const { lines, restore } = capture()
	try {
		await runStreamCommand.handler({ rawArgs, ctx } as never)
	} finally {
		restore()
	}
	return lines.join('')
}

/**
 * Restored in `afterEach`; see below for why it is set at all.
 */
let stdinWasTTY: boolean | undefined

beforeEach(() => {
	// A terminal, so the stateless path reads nothing and returns at once.
	//
	// This is about the QUALITY of the failure, not about convenience. With the
	// refusal mutated away the command falls through to reading prior turns from
	// stdin, and under vitest stdin is an inherited pipe that never ends — so the
	// three tests below "died" by 15-second timeout rather than by assertion.
	// A timeout is a poor kill: it is slow, it says "hung" instead of "answered
	// against a history nobody asked for", and it is a flake waiting for a loaded
	// CI box. It is also an artifact of the harness — a host piping NDJSON closes
	// its end, so production does not hang here either.
	stdinWasTTY = process.stdin.isTTY
	Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
	vi.mocked(openSessions).mockClear()
	vi.mocked(resolveConversation).mockClear()
	vi.mocked(appendMessages).mockClear()
	vi.mocked(replaceConversation).mockClear()
	vi.mocked(openSessions).mockImplementation(async () => ({}) as never)
	vi.mocked(resolveConversation).mockImplementation(async () => 'conv-1' as never)
	vi.mocked(appendMessages).mockImplementation(async () => undefined)
	vi.mocked(replaceConversation).mockImplementation(async () => undefined)
})

afterEach(() => {
	Object.defineProperty(process.stdin, 'isTTY', { value: stdinWasTTY, configurable: true })
	vi.restoreAllMocks()
})

describe('when the named conversation cannot be opened', () => {
	it('refuses, instead of answering against whatever stdin held', async () => {
		vi.mocked(openSessions).mockImplementation(async () => {
			throw new Error('EACCES: permission denied')
		})

		const out = await run(['--session', 'nightly-build', 'what did we decide?'])

		expect(out, 'the failure was not reported').toContain('"kind":"error"')
		expect(out, 'did not name the conversation that was asked for').toContain('nightly-build')
		expect(out, "did not carry the store's own reason").toContain('EACCES')
		// The refusal is the point: no turn may have run.
		expect(out, 'the model answered anyway, against a history nobody asked for').not.toContain(
			'an answer',
		)
	})

	it('tells the caller how to get the turn they wanted', async () => {
		// A refusal an operator cannot act on is a dead end. Running stateless is
		// a legitimate thing to want; it just has to be asked for.
		vi.mocked(openSessions).mockImplementation(async () => {
			throw new Error('EACCES')
		})

		expect(await run(['--session', 'k', 'hi'])).toContain('--session')
	})

	it('still ends the stream, so a host scanning stdout is not left hanging', async () => {
		// The NDJSON contract is that every run ends with `done`, refusals
		// included.
		vi.mocked(openSessions).mockImplementation(async () => {
			throw new Error('EACCES')
		})

		expect(await run(['--session', 'k', 'hi'])).toContain('"kind":"done"')
	})
})

describe('when the turn cannot be saved', () => {
	it('says so, rather than ending on an unqualified done', async () => {
		vi.mocked(appendMessages).mockImplementation(async () => {
			throw new Error('ENOSPC: no space left on device')
		})

		const out = await run(['--session', 'nightly-build', 'hello'])

		expect(out, 'the reply did not stream').toContain('an answer')
		expect(out, 'the failed write was silent').toContain('not saved')
		expect(out, "did not carry the store's own reason").toContain('ENOSPC')
	})

	it('names the consequence, not just the fault', async () => {
		// "Could not persist" does not tell a host that its OWN later reads are
		// now incomplete, which is the part that costs something.
		vi.mocked(appendMessages).mockImplementation(async () => {
			throw new Error('ENOSPC')
		})

		const out = await run(['--session', 'k', 'hello'])

		expect(out).toContain('history')
		expect(out).toContain('context')
	})

	it('is a notice and not an error, because the run did succeed', async () => {
		// A host that treated this as a failed run would be wrong: the reply is
		// complete and correct. Only the record of it is missing.
		vi.mocked(appendMessages).mockImplementation(async () => {
			throw new Error('ENOSPC')
		})

		const out = await run(['--session', 'k', 'hello'])

		expect(out).toContain('"kind":"notice"')
		expect(out, 'a successful run was reported as an error').not.toContain('"kind":"error"')
	})

	it('says nothing when the save succeeded, so the notice means something', async () => {
		// The other half. A notice printed either way is noise, and a host would
		// learn to ignore it.
		const out = await run(['--session', 'k', 'hello'])

		expect(out).toContain('an answer')
		expect(out, 'reported a failure on the success path').not.toContain('not saved')
	})

	it('persists exact opaque assistant state without writing it to NDJSON', async () => {
		const out = await run(['--session', 'k', 'hello'])
		const persisted = vi.mocked(appendMessages).mock.calls.at(-1)?.[2]

		expect(persisted?.[1]).toMatchObject({
			role: 'assistant',
			content: 'an answer',
			reasoning: [{ type: 'redacted_thinking', encrypted: 'OPAQUE_RUN_STREAM_STATE' }],
		})
		expect(replaceConversation).not.toHaveBeenCalled()
		expect(out).not.toContain('OPAQUE_RUN_STREAM_STATE')
	})
})
