/**
 * One place that knows the shape of an `AgentSession`.
 *
 * Four test files each built this stub by hand, so every field added to
 * `AgentSession` broke four unrelated suites at once and the fix was to paste
 * the same default into each of them. The interface is the thing under test in
 * none of those files — they stub it to get past it — so the duplication bought
 * nothing and charged rent.
 *
 * The return type is `AgentSession`, deliberately and not `Partial` or a
 * structural literal: a new REQUIRED field on the interface must fail
 * type-checking HERE, once, with the compiler naming the field. A fixture typed
 * loosely enough to absorb the change would hide exactly the event it exists to
 * surface.
 *
 * Defaults describe a session that came up cleanly — a provider, no failures,
 * nothing skipped — because that is the uninteresting case every caller wants
 * as a baseline. Anything a test actually cares about it passes in, and the
 * override is then the only unusual thing in the file, which is what a reader
 * should see. A fixture whose defaults do not resemble a real session tests a
 * system that does not ship
 * (`docs/conventions/fixture-must-match-production.md`).
 */

import type { Message } from '@namzu/sdk'

import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'

/**
 * A session that yields one `done` and nothing else.
 *
 * `send` is the field most callers replace. The default is the shortest
 * well-formed turn rather than an empty iterable, because a consumer that
 * waits for `done` hangs on the latter — a stub that never terminates is a
 * timeout with extra steps, and this package has already paid for one of those.
 */
export function fakeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		hasProvider: true,
		// Unconfined, because that is what a fake session is: no provider was
		// built, so claiming enforcement here would make every test that reads
		// it believe in a sandbox that does not exist.
		sandbox: { unconfined: true, enforced: [], required: [] },
		// Nothing to shed, which is a real answer and the one a fake session can
		// honestly give. Returning a fabricated result would let a test assert a
		// compaction that never ran.
		compact: async () => null,
		providerSummary: 'mock',
		modelSummary: 'mock-model',
		toolNames: () => [],
		errorHint: null,
		// No failure, so nothing to classify. A test about the refusal codes sets
		// this and `hasProvider` together — they are one fact in two fields, and a
		// session with a kind and a provider describes nothing real.
		errorKind: null,
		instructionFiles: [],
		skippedInstructionFiles: [],
		mcpConnected: [],
		mcpFailed: [],
		agentIds: [],
		// A healthy single-provider chain has nothing to report, which is the
		// ordinary production state this fixture is meant to resemble.
		configNotices: [],
		// Nothing has been approved on a fresh session. A test about the latch
		// overrides this; every other test wants the ordinary state.
		approvalLatched: () => false,
		promptExemptTools: () => [],
		send: (_messages: readonly Message[], _opts?: SendOptions): AsyncIterable<AgentEvent> =>
			(async function* () {
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			})(),
		// Refuses rather than reporting `no-checkpoint`. A default that answered
		// "there is nothing to continue" would let a drain test pass while
		// resuming nothing, which is the shape of failure this whole seam
		// exists to make impossible.
		resumeDurable: async () => {
			throw new Error('fakeAgentSession: resumeDurable was not stubbed for this test')
		},
		close: async () => {},
		...overrides,
	}
}
