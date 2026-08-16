/**
 * Advance through a declared provider chain when a member cannot serve.
 *
 * The sibling of `withProviderRetry`, one level out: retry asks "will the SAME
 * member succeed if I ask again?", this asks "will ANOTHER member succeed if I
 * ask it instead?". They compose in exactly one order —
 * `fallback(retry(m0), retry(m1), …)` — and that order is the policy, not an
 * implementation detail:
 *
 *  - the primary is the operator's choice and gets its retries first, so a
 *    throttle or a 5xx only reaches this decorator once the inner budget is
 *    spent;
 *  - a failure the inner loop refuses to retry (`auth`, `not_found`) arrives
 *    here immediately, which is what "fall over at once on a bad credential"
 *    means — retrying a wrong key just spends the turn;
 *  - a server-directed `Retry-After` is honoured by the inner loop before any
 *    error escapes, so a transient wait is a wait and not a swap.
 *
 * None of those three behaviours is implemented here. They fall out of the
 * nesting, which is why `query()` builds the composition rather than letting a
 * host assemble it in whichever order it happens to pick.
 */

import { classifyProviderError, isAbortError } from '../types/provider/errors.js'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../types/provider/index.js'
import type { Logger } from '../utils/logger.js'

/**
 * One member of the chain: a constructed provider, and the model to ask it for.
 *
 * `model` overrides {@link ChatCompletionParams.model} for this member's
 * requests and nothing else. Every shipped driver reads that field
 * (`params.model`, or `params.model || <its configured default>`), so a member
 * needs no reconstruction to be asked for a different model — which is what
 * keeps this decorator ignorant of credentials, base URLs and registries. A
 * chain is an ordered list of (provider, model); building one is the host's
 * job, walking it is this file's.
 *
 * Absent means "whatever the request already asked for", which is the right
 * default for a member declared without a model: the registry default was
 * resolved into the request before it got here.
 */
export interface ProviderChainMember {
	readonly provider: LLMProvider
	readonly model?: string
}

/**
 * The member serving from now on.
 *
 * `index` is a position in the chain the host declared, so a reader can name
 * the member without holding the chain: "member 2 of 4" is the sentence an
 * operator writes in an incident note.
 */
export interface ServingMember {
	readonly index: number
	readonly providerId: string
	/** Absent for a member declared without one — see {@link ProviderChainMember.model}. */
	readonly model?: string
}

export interface WithProviderFallbackOptions {
	readonly log?: Logger
	/**
	 * Called once per swap, with the member that serves from here on.
	 *
	 * A callback is enough to describe the WHOLE truth, not a sample of it,
	 * and that is a property of the cursor rather than of this option: the
	 * chain never rewinds, so "who is serving" is exactly "the head, plus
	 * every swap so far". A listener that starts at member 0 and applies each
	 * call is never behind.
	 *
	 * It exists beside the in-band `fallback` chunk rather than instead of it
	 * because the two have different observers and neither covers the other's
	 * case. The chunk reaches whoever is iterating the stream, at the moment
	 * of the swap — that is the operator. This reaches a party that has to
	 * know AFTER the request is over and may never have iterated the stream at
	 * all — that is the run record. Two things follow that the chunk alone
	 * cannot give it:
	 *
	 *  - the cursor outlives the request, so a swap on the turn at step 3
	 *    still describes steps 4..N, which emit no further chunk;
	 *  - a side call that aggregates the stream through `collectChatCompletion()` — the
	 *    compaction verifier and the forced-final summary both do — drops the
	 *    `fallback` chunk on the floor, so a swap inside one is invisible to
	 *    every chunk consumer. (The advisory executor calls its OWN advisor's
	 *    provider, not the run's, so it is not one of these.)
	 *
	 * ## Fired when the replacement is ASKED, not when the cursor moves
	 *
	 * The two are not the same instant and the difference is observable. The
	 * cursor moves inside the catch; the notice chunk is then yielded, and the
	 * replacement request is only issued when the consumer comes back for
	 * another chunk. A consumer that stops there — a Stop, a `break`, a host
	 * that abandons the iterator — leaves a chain that selected a member and
	 * never asked it.
	 *
	 * Announcing at cursor-move would report that member as serving, and a
	 * ledger saying a provider served a turn it was never sent is the exact
	 * defect this callback exists to end, reintroduced one layer down. So the
	 * announcement sits at the top of the loop, immediately before the
	 * replacement's `chatStream` — the earliest moment at which the member is
	 * actually being asked.
	 *
	 * ## One stream at a time
	 *
	 * `cursor` is shared by every concurrent `chatStream` on this wrapper, so
	 * two overlapping calls can advance it under one another: one call's
	 * failure moves the cursor while the other is still being served by the
	 * head, and a listener would hear about a member that answered nothing for
	 * that call. Nothing here serializes or refuses concurrency — the
	 * property held before this option existed and is not introduced by it.
	 * `query()` issues its main turn and its side calls in sequence, which is
	 * what makes the reading exact there.
	 */
	readonly onSwap?: (to: ServingMember) => void
}

/**
 * Failures that are a property of the REQUEST rather than of the member serving
 * it.
 *
 * This is the whole decision, stated once. A request fault reproduces
 * identically on the next member, so falling over would spend a second
 * provider's money to buy the same error. Everything else — a throttle, an
 * outage, a rejected credential, a model this provider does not have, a stream
 * that came back malformed — is a fact about the member, and the next member is
 * worth asking.
 *
 * The three entries, and what each of them being here means:
 *
 * - `context_length_exceeded` — the run's own remedy is compaction, which sheds
 *   history and asks again. Falling over instead would carry the same oversized
 *   prompt to a provider that has not been given the chance to fit it. Note the
 *   limit of that reasoning: a chain MAY pair a small window with a larger one,
 *   and then a fallback genuinely could have succeeded. Compaction is still
 *   preferred because it is cheaper and it keeps the operator on the provider
 *   they chose.
 * - `invalid_request` — namzu built a request the provider rejected. The
 *   counter-case is real and is recorded here rather than hidden: drivers
 *   translate the same tool schema differently onto the wire, so a 400 about a
 *   JSON Schema dialect (see `provider/errors.ts`) is provider-specific and
 *   another member might accept it. Abort still wins, because the common case
 *   is a request that is wrong everywhere, and spending the entire chain to
 *   rediscover one defect is the worse failure.
 * - `content_filter` — a refusal. No shipped driver reaches this through a
 *   THROW today: the drivers that surface a filtered completion do so as
 *   `finishReason: 'content_filter'`, which is a finished stream, not an error.
 *   The input that makes this entry fire is a driver that throws instead — the
 *   classifier maps a `content_policy_violation` structural code onto it, and
 *   `ProviderError` is a public type a third-party driver constructs directly.
 *   Named rather than omitted for that reason; see
 *   `docs/conventions/a-check-that-cannot-fail.md` for why an unnameable one
 *   would have been left out.
 */
const REQUEST_FAULT_CODES: ReadonlySet<string> = new Set([
	'context_length_exceeded',
	'invalid_request',
	'content_filter',
])

/**
 * Does this failure justify asking the next member?
 *
 * The classification is taken from `classifyProviderError` and not re-derived.
 * A second classifier that disagreed with the first would be two answers to one
 * question, and the retry decorator already stands on that same answer.
 *
 * `status === 404` is read ALONGSIDE the code, and it is not a second opinion —
 * it is a second field of the one classification. A 404 reaches `not_found`
 * only on the unclassified path (`codeFromStatus`). A driver that classified
 * its own 404 into a `ProviderRequestError` gets `kind: 'bad_request'` from
 * `classifyProviderHttpStatus`, which `KIND_TO_CODE` maps to
 * `invalid_request` — a request fault, so the run would ABORT on a model the
 * next member may well have. The status survives on both paths; the code does
 * not, so the status is what this reads.
 */
function shouldFallOver(err: unknown, providerId: string): boolean {
	const classified = classifyProviderError(err, providerId)
	if (classified.status === 404) return true
	return !REQUEST_FAULT_CODES.has(classified.code)
}

/**
 * Has the consumer already been handed something a restart would duplicate?
 *
 * Deliberately NOT the retry decorator's rule, and the difference is the bug
 * this function exists to prevent. Retry treats every chunk that is not
 * error-only as output, which is correct INSIDE retry because each attempt
 * starts with the flag cleared. Reused one level out it is wrong in the worst
 * possible place: the inner decorator emits a backoff notice through this
 * stream on its way to sleeping, that notice is not error-only, and a fallback
 * reading it as output would refuse to advance for the rest of the turn — for
 * the 429/5xx path, which is the main reason a chain is declared at all.
 *
 * So this asks the narrow question instead: did a chunk carry something the
 * orchestrator turned into a visible event? `text_delta`, tool-input fragments
 * and their per-tool boundary, reasoning blocks and citations all did.
 * `usage`, `finishReason` and the two control notices did not.
 */
function isOutputChunk(chunk: StreamChunk): boolean {
	if (chunk.retry !== undefined || chunk.fallback !== undefined) return false
	const { content, toolCalls, toolCallEnd, reasoning, citation } = chunk.delta
	return Boolean(
		content ||
			toolCalls?.length ||
			toolCallEnd ||
			reasoning !== undefined ||
			citation !== undefined,
	)
}

/**
 * Wrap an ordered chain so a member that cannot serve is replaced in place.
 *
 * ## The cursor's lifetime IS the scope
 *
 * Once this decorator advances, every later request in its life goes to the new
 * member; the chain never rewinds. That is deliberate and it is how "the
 * primary is restored at each new user message" is implemented — by NOT
 * implementing it. `query()` builds one of these per call and a host's call is
 * its turn, so the cursor cannot outlive the turn because the object cannot.
 * There is no reset to forget to call, and no way for a rate limit at 14:00 to
 * leave an operator on a cheaper model at 17:00.
 *
 * Rewinding within the turn would be the alternative, and it is worse: the
 * member that just failed would be re-asked on the next iteration of the same
 * turn, which is a retry wearing a chain's clothes and which the inner
 * decorator already declined to do.
 *
 * ## Each member is tried at most once per turn, and the whole chain is walked
 *
 * A chain of N members yields up to N attempts, not one. An operator who
 * declares four members and is served only by the second on a bad day has been
 * given three decorative entries — that is the declared-but-undriven defect
 * this file exists to remove, and stopping after one step would reintroduce it
 * at position 2 instead of position 1. When the last member fails, its error is
 * thrown untouched and ordinary error handling takes over.
 *
 * ## Once output is out, there is no fallback
 *
 * Inherited from retry, for the same reason and not a weaker one: a stream that
 * has emitted bytes cannot be restarted without duplicating them, and the
 * consumer has already appended them to a message it is rendering. A mid-stream
 * failure after output is surfaced, never swapped. See {@link isOutputChunk} —
 * the definition of "output" is where this property is actually won or lost.
 *
 * ## Capabilities are the head's
 *
 * The getters below are transparent, so a run negotiates tools, vision and
 * documents ONCE against `members[0]` and keeps that answer after a swap. This
 * is a real limitation and it is why the host is expected to refuse a chain
 * whose members disagree before ever building one (`@namzu/cli` does, and only
 * runs a mismatched chain when the operator has said so explicitly). Taking the
 * intersection here instead would cost the primary a capability on every run to
 * guard against a failure that happens rarely.
 */
export function withProviderFallback(
	members: readonly ProviderChainMember[],
	options: WithProviderFallbackOptions = {},
): LLMProvider {
	const first = members[0]
	if (!first) {
		throw new Error('withProviderFallback needs at least one member')
	}
	// A one-member chain is the identity. Returning the provider itself rather
	// than a wrapper that can never advance keeps the no-chain path byte-identical
	// to what it was before this file existed.
	//
	// `onSwap` is therefore never called on this path, and that is the correct
	// reading rather than a hole: a listener starts at member 0 and a one-member
	// chain never leaves it. Announcing member 0 here would say "the chain
	// advanced" about a chain that cannot.
	if (members.length === 1) return first.provider

	const log = options.log
	let cursor = 0
	/**
	 * The last position {@link WithProviderFallbackOptions.onSwap} was told
	 * about. Lags `cursor` for exactly as long as the consumer has the notice
	 * chunk and has not come back for more — which is the window in which a
	 * selected member has not been asked anything. See that option's doc.
	 */
	let announced = 0

	async function* chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		for (;;) {
			const member = members[cursor]
			// Unreachable while `cursor` only ever moves to an index this loop has
			// bounds-checked below; kept because the alternative on a future edit is
			// calling `chatStream` on undefined, which names neither the field nor
			// the fix.
			if (!member) throw new Error(`provider chain has no member at position ${cursor}`)

			if (announced !== cursor) {
				announced = cursor
				options.onSwap?.({
					index: cursor,
					providerId: member.provider.id,
					...(member.model !== undefined ? { model: member.model } : {}),
				})
			}

			const request = member.model !== undefined ? { ...params, model: member.model } : params
			let produced = false
			try {
				for await (const chunk of member.provider.chatStream(request)) {
					if (isOutputChunk(chunk)) produced = true
					yield chunk
				}
				return
			} catch (err) {
				// A Stop is control flow, not a provider failure. Without this the
				// classifier — which has no concept of cancellation — would file an
				// abort as some ordinary failure and the run would walk the entire
				// chain re-issuing an already-cancelled request, one member at a
				// time, instead of settling as `cancelled`. The retry decorator
				// guards the same way and for the same reason.
				if (isAbortError(err) || params.signal?.aborted) throw err

				const next = cursor + 1
				const to = members[next]
				if (produced || !to || !shouldFallOver(err, member.provider.id)) {
					log?.warn('Provider chain: not falling over', {
						provider: member.provider.id,
						position: cursor,
						reason: produced
							? 'stream already produced output — cannot restart without duplicating it'
							: !to
								? 'chain exhausted'
								: 'the failure is a property of the request, not of the provider',
					})
					throw err
				}

				const classified = classifyProviderError(err, member.provider.id)
				cursor = next
				log?.warn('Provider chain: falling over', {
					from: member.provider.id,
					fromPosition: cursor - 1,
					to: to.provider.id,
					toPosition: cursor,
					code: classified.code,
					status: classified.status,
				})

				// In-band, exactly like the retry notice and for the same reason: the
				// consumer is blocked inside this iterator, so the stream is the only
				// channel that reaches it at the moment the swap happens rather than
				// after the replacement request has already run.
				yield {
					id: '',
					delta: {},
					fallback: {
						fromIndex: cursor - 1,
						fromProviderId: member.provider.id,
						...(member.model !== undefined ? { fromModel: member.model } : {}),
						toIndex: cursor,
						toProviderId: to.provider.id,
						...(to.model !== undefined ? { toModel: to.model } : {}),
						code: classified.code,
						...(classified.status !== undefined ? { status: classified.status } : {}),
						reason: classified.message,
					},
				}
			}
		}
	}

	// Transparent to capability negotiation and identity, like the retry
	// decorator. The head's declarations are what a run is configured from; see
	// the note on capabilities above for the limitation that carries.
	return {
		get id() {
			return first.provider.id
		},
		get name() {
			return first.provider.name
		},
		get capabilities() {
			return first.provider.capabilities
		},
		chatStream,
		...(first.provider.listModels ? { listModels: () => first.provider.listModels?.() } : {}),
		// Forwarded for the reason `retry.ts` forwards it: a wrapper that drops
		// the model turns a probe the caller could answer into one it cannot.
		...(first.provider.healthCheck
			? { healthCheck: (model?: string) => first.provider.healthCheck?.(model) }
			: {}),
		...(first.provider.doctorCheck
			? { doctorCheck: (model?: string) => first.provider.doctorCheck?.(model) }
			: {}),
		// The HEAD's answer, like every other member here, and that is the
		// right reading rather than a limitation: the window is resolved once
		// at the start of a run, when the head is what is serving. A chain
		// that swaps mid-run has bigger differences between its members than
		// a context size, and re-resolving on every swap would put a network
		// call on the recovery path — which is the last place that can afford
		// one.
		...(first.provider.effortLevelsFor
			? {
					effortLevelsFor: (
						model: string,
						thinking?: Parameters<NonNullable<LLMProvider['effortLevelsFor']>>[1],
					) => first.provider.effortLevelsFor?.(model, thinking) ?? [],
				}
			: {}),
		...(first.provider.resolveContextWindow
			? {
					resolveContextWindow: (model: string, signal?: AbortSignal) =>
						first.provider.resolveContextWindow?.(model, signal) ?? Promise.resolve(undefined),
				}
			: {}),
	} as LLMProvider
}
