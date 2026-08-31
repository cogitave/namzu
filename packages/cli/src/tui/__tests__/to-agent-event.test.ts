import { describe, expect, it } from 'vitest'

import { type RunEvent, type RunId, ToolRegistry, createToolPresenter } from '@namzu/sdk'

import { toAgentEvent } from '../agent.js'

/** No tool is involved in any event here; the registry-backed presenter with an
 * empty registry gives exactly the generic fallback these assertions expect. */
const presenter = createToolPresenter(new ToolRegistry())

/**
 * The seam between the kernel and the command.
 *
 * The SDK test proves `run_completed` carries a stop reason and the `run` test
 * proves the command acts on one, and both of those passed while this function
 * threw the field away in between — the mutation that reverted it to a bare
 * `{ kind: 'done' }` was caught by nothing. Two tested ends and an untested
 * middle is the shape that lets a value be produced and consumed and still
 * never arrive.
 */

const runId = 'run_test' as RunId

describe('toAgentEvent carries the stop reason across', () => {
	it.each(['tools', 'vision', 'documents'] as const)(
		'carries a %s capability warning without turning it into a terminal error',
		(capability) => {
			const mapped = toAgentEvent(
				{
					type: 'capability_warning',
					runId,
					capability,
					providerId: 'deepseek',
					message: `cannot serve ${capability}`,
				},
				presenter,
			)

			expect(mapped).toEqual({
				kind: 'capability-warning',
				capability,
				text: `cannot serve ${capability}`,
			})
			expect(mapped?.kind).not.toBe('error')
		},
	)

	it('preserves that a vision warning came from a tool result', () => {
		const mapped = toAgentEvent(
			{
				type: 'capability_warning',
				runId,
				capability: 'vision',
				contentSource: 'tool-result',
				providerId: 'text-only',
				message: 'image tool result will use a text fallback',
			},
			presenter,
		)

		expect(mapped).toEqual({
			kind: 'capability-warning',
			capability: 'vision',
			contentSource: 'tool-result',
			text: 'image tool result will use a text fallback',
		})
	})

	it('carries measured history-repair counts as a non-terminal warning', () => {
		const mapped = toAgentEvent(
			{
				type: 'message_history_repaired',
				runId,
				source: 'abandoned-checkpoint',
				duplicateToolResultsRemoved: 1,
				orphanedToolResultsRemoved: 2,
				syntheticToolResultsInserted: 3,
			},
			presenter,
		)

		expect(mapped).toEqual({
			kind: 'history-repair',
			source: 'abandoned-checkpoint',
			text: 'Tool history repaired before the model call: 1 duplicate result removed; 2 orphaned results removed; 3 interrupted calls closed with unknown outcome. Verify external state before retrying non-idempotent tools.',
		})
		expect(mapped?.kind).not.toBe('error')
	})

	it('explains provider-rejected image delivery without claiming the bytes were deleted', () => {
		const mapped = toAgentEvent(
			{
				type: 'message_history_repaired',
				runId,
				source: 'provider-rejected-image',
				duplicateToolResultsRemoved: 0,
				orphanedToolResultsRemoved: 0,
				syntheticToolResultsInserted: 0,
				providerRejectedImagesSuppressed: 2,
			},
			presenter,
		)

		expect(mapped).toEqual({
			kind: 'history-repair',
			source: 'provider-rejected-image',
			text: 'The provider rejected 2 image occurrences. The original attachment bytes were kept, but that image will be omitted from later model requests; attach a corrected copy to try again.',
		})
	})

	it('passes a non-normal stop through to the done event', () => {
		const mapped = toAgentEvent(
			{
				type: 'run_completed',
				runId,
				result: '',
				stopReason: 'output_guardrail',
			} as RunEvent,
			presenter,
		)

		expect(mapped).toEqual({ kind: 'done', stopReason: 'output_guardrail' })
	})

	it('passes end_turn through rather than inventing it downstream', () => {
		// The command treats a MISSING reason as success, so the difference
		// between "finished normally" and "we did not say" must be preserved
		// here rather than reconstructed by whoever reads it.
		const mapped = toAgentEvent(
			{
				type: 'run_completed',
				runId,
				result: 'hi',
				stopReason: 'end_turn',
			} as RunEvent,
			presenter,
		)

		expect(mapped).toEqual({ kind: 'done', stopReason: 'end_turn' })
	})

	it('still maps a completion that carries no reason', () => {
		const mapped = toAgentEvent(
			{ type: 'run_completed', runId, result: 'hi' } as RunEvent,
			presenter,
		)

		expect(mapped).toEqual({ kind: 'done' })
	})

	it('maps a failure to an error, not to done', () => {
		const mapped = toAgentEvent(
			{
				type: 'run_failed',
				runId,
				error: 'boom',
			} as RunEvent,
			presenter,
		)

		expect(mapped).toEqual({ kind: 'error', message: 'boom' })
	})
})

describe('compaction is reported, not silent', () => {
	// Compaction deletes messages irrecoverably. The kernel emits both outcomes
	// specifically so a host can surface the loss; this host used to drop them
	// at `default: return null`, one function from the screen.
	it('says which counts became which, and nothing it cannot substantiate', () => {
		const mapped = toAgentEvent(
			{
				type: 'compaction_completed',
				runId: 'run_1',
				iteration: 3,
				messagesBefore: 42,
				messagesAfter: 9,
				tokensBefore: 120_000,
				tokensAfter: 38_000,
				measuredBy: 'provider',
				contextWindowTokens: 200_000,
				windowSource: 'model-table',
				reachedResetThreshold: true,
			} as never,
			presenter,
		)

		expect(mapped).toMatchObject({ kind: 'context', shed: true })
		const text = (mapped as { text: string }).text
		expect(text).toContain('42')
		expect(text).toContain('9')
		expect(text).toContain('120k')
		// It must NOT claim to know what was lost — only the counts are checkable.
		expect(text).not.toMatch(/turns? \d+-\d+|removed the/i)
	})

	it('marks an estimate as an estimate', () => {
		// Quoting an estimate as a measurement is the same lie as quoting a
		// summary as an enumeration, in miniature.
		const mapped = toAgentEvent(
			{
				type: 'compaction_completed',
				runId: 'run_1',
				iteration: 3,
				messagesBefore: 10,
				messagesAfter: 4,
				tokensBefore: 9000,
				tokensAfter: 3000,
				measuredBy: 'estimate',
				contextWindowTokens: 200_000,
				windowSource: 'default',
				reachedResetThreshold: false,
			} as never,
			presenter,
		)

		expect((mapped as { text: string }).text).toContain('estimated')
	})
})

describe('the three decline causes get three sentences', () => {
	// Collapsing them into "compaction failed" puts the reader back where the
	// silence did — the same reason a rule denial had to quote the rule.
	function failure(cause: string, error?: string): string {
		const mapped = toAgentEvent(
			{
				type: 'compaction_failed',
				runId: 'run_1',
				iteration: 2,
				cause,
				messages: 31,
				...(error ? { error } : {}),
			} as never,
			presenter,
		)
		expect(mapped).toMatchObject({ kind: 'context', shed: false })
		return (mapped as { text: string }).text
	}

	it('a thrown reducer may work next time, and carries its own error', () => {
		const text = failure('reducer_threw', 'provider returned 400')

		expect(text).toContain('provider returned 400')
		expect(text).toContain('a later pass may succeed')
	})

	it('shedding nothing is a fact, not an error, and will not change', () => {
		const text = failure('shed_nothing')

		expect(text).toContain('later passes will answer the same')
		// Not dressed as a failure: an irreducible history is a true statement
		// about the conversation, and calling it one sends someone hunting a
		// bug that is not there.
		expect(text).not.toMatch(/failed|error/i)
	})

	it('a split tool pair is a reducer bug and suggests no user action', () => {
		const text = failure('split_tool_pair')

		expect(text).toContain('bug in the reducer')
		expect(text).not.toMatch(/try again|later pass|retry/i)
	})

	it('every cause states the history is unchanged', () => {
		for (const cause of ['reducer_threw', 'shed_nothing', 'split_tool_pair']) {
			expect(failure(cause)).toContain('31 messages unchanged')
		}
	})

	it('no two causes produce the same sentence', () => {
		const texts = ['reducer_threw', 'shed_nothing', 'split_tool_pair'].map((c) => failure(c))

		expect(new Set(texts).size).toBe(3)
	})
})

/**
 * A tool the summary list does not know still gets a label, not a blob.
 *
 * `Agent` requires a `description` on its schema — the model writes one every
 * call — and the summariser picked from a key list that did not include it, so
 * a delegation was rendered as a truncated `JSON.stringify` of its own
 * arguments. The label was demanded and then discarded.
 *
 * Driven through `toAgentEvent` rather than the summariser directly: the
 * helper's own behaviour was never in doubt, only whether the caller reaches
 * it with this input.
 */
describe('toAgentEvent labels a delegation with the label it required', () => {
	const executing = (toolName: string, input: unknown) =>
		toAgentEvent(
			{
				type: 'tool_executing',
				toolName,
				toolUseId: 'tu_1',
				input,
			} as RunEvent,
			presenter,
		)

	it('summarises an Agent call with its description', () => {
		const mapped = executing('Agent', {
			description: 'Audit the auth flow',
			prompt: 'Read every file under src/auth and report risks.',
			role: 'You are a security auditor',
		})

		expect(mapped).toMatchObject({ summary: 'Audit the auth flow' })
	})

	it('does not render the arguments as JSON', () => {
		const mapped = executing('Agent', {
			description: 'Audit the auth flow',
			prompt: 'x',
		})

		expect((mapped as { summary: string }).summary).not.toContain('{')
		expect((mapped as { summary: string }).summary).not.toContain('prompt')
	})

	it('still prefers a more specific field when one exists', () => {
		// `description` is the LAST fallback. A tool with a real subject keeps
		// it, so adding this key cannot quietly relabel the tools that already
		// summarised correctly.
		const mapped = executing('bash', {
			command: 'ls -la',
			description: 'list files',
		})

		expect(mapped).toMatchObject({ summary: 'ls -la' })
	})
})

/**
 * The context figures cross the same seam, and used to stop at it.
 *
 * The kernel measured the context and resolved a window; the status gauge
 * consumed a fraction. Both ends worked. This function threw the four fields
 * away in between, so the gauge fell back to dividing CUMULATIVE spend by a
 * window guessed from the model name — a number that rose with turn count and
 * read FULL on a conversation with room left. Producing a value and consuming
 * one are not the same as carrying it.
 */
describe('toAgentEvent carries the context figures across', () => {
	const COST = { totalCost: 0.5, cacheDiscount: 0, unpricedTokens: 0 }
	const usageEvent = (extra: Record<string, unknown>) =>
		toAgentEvent(
			{
				type: 'token_usage_updated',
				runId,
				usage: { totalTokens: 90 },
				cost: COST,
				...extra,
			} as unknown as RunEvent,
			presenter,
		)

	it('carries both terms and both provenances', () => {
		expect(
			usageEvent({
				contextTokens: 12_000,
				contextMeasuredBy: 'provider',
				contextWindowTokens: 200_000,
				windowSource: 'model-table',
			}),
		).toEqual({
			kind: 'usage',
			totalTokens: 90,
			cost: COST,
			contextTokens: 12_000,
			contextMeasuredBy: 'provider',
			contextWindowTokens: 200_000,
			windowSource: 'model-table',
		})
	})

	it('leaves an unreported context absent rather than zero', () => {
		// The kernel omits all four when a run resolved no window. A `0` here
		// would be indistinguishable from an empty context and would render a
		// gauge reading 0% — a confident wrong answer where the contract is
		// to show no proportion at all.
		const mapped = usageEvent({})

		expect(mapped).toEqual({ kind: 'usage', totalTokens: 90, cost: COST })
		expect(mapped).not.toHaveProperty('contextTokens')
		expect(mapped).not.toHaveProperty('contextWindowTokens')
	})

	it('keeps context distinct from cumulative spend', () => {
		// The defect in one assertion. Ten turns over a 200k window accumulate
		// far more spend than the window holds, because every turn re-sends the
		// history and counts it again — while the context stays modest. Any
		// mapping that reaches for `totalTokens` fails here.
		expect(
			usageEvent({
				usage: { totalTokens: 500_000 },
				contextTokens: 40_000,
				contextMeasuredBy: 'provider',
				contextWindowTokens: 200_000,
				windowSource: 'model-table',
			}),
		).toMatchObject({ totalTokens: 500_000, contextTokens: 40_000 })
	})
})
