import { ProviderRequestError, parseVersionedModelId } from '@namzu/sdk'
import type { ThinkingConfig, ToolChoice } from '@namzu/sdk'

import {
	MODEL_ID_GRAMMAR,
	type ResolvedThinkingBody,
	resolveThinkingBody,
	resolveThinkingCapability,
} from './thinking-capability.js'
import { type VersionFloor, reachesFloor } from './version-floor.js'

/**
 * Models that refuse a forced tool choice whatever the thinking settings.
 *
 * `tool_choice: {type: "any"}` and `{type: "tool", name}` come back 400 —
 * `tool_choice: type "tool" and "any" are not supported for this model.` — on
 * Claude Opus 5.5, Claude Fable 5.1 and Claude Mythos 5.1, and on the
 * token-counting endpoint too. That list is the vendor's, stated identically
 * in its error reference and in the "Forcing tool use" table of its tool
 * definition page. Opus 5 and Fable 5 still take a forced choice, so these are
 * version floors and not family rules — and not the always-on line in
 * `thinking-capability.ts` either: Fable 5 cannot stop thinking and accepts a
 * forced choice all the same.
 *
 * SOURCED, NOT MEASURED. The wire has not been asked from here; the live
 * contract suite carries the probe for when a key is present. Mythos Preview
 * is deliberately absent: neither vendor page names it, and this table holds
 * what the vendor says, not what seems likely.
 */
const REFUSES_FORCED_TOOL_CHOICE_FROM: readonly VersionFloor[] = [
	{ family: 'opus', major: 5, minor: 5 },
	{ family: 'fable', major: 5, minor: 1 },
	{ family: 'mythos', major: 5, minor: 1 },
]

/** `'required'` or a named function: the two choices that make a call mandatory. */
function isForced(toolChoice: ToolChoice | undefined): boolean {
	return (
		toolChoice === 'required' || (typeof toolChoice === 'object' && toolChoice.type === 'function')
	)
}

/**
 * Why a forced choice would be refused for this model and thinking body, or
 * `undefined` when it would be taken.
 *
 * Two causes, both from the vendor's table. The model may refuse it outright.
 * Or the request may carry manual extended thinking — `thinking: {type:
 * "enabled"}` — which rejects a forced choice on every model that has it.
 * Adaptive thinking does not: Opus 5 takes a forced choice with thinking on.
 *
 * The second is decided on the RESOLVED body, not on the caller's intent,
 * because that is what the vendor sees: an `adaptive` intent becomes `enabled`
 * on a manual-only model, and an `enabled` intent becomes `adaptive` on an
 * adaptive-only one.
 */
function forcedToolChoiceRefusal(
	model: string,
	thinkingBody: ResolvedThinkingBody,
): 'model' | 'manual-thinking' | undefined {
	const version = parseVersionedModelId(model, MODEL_ID_GRAMMAR)
	if (version && reachesFloor(version, REFUSES_FORCED_TOOL_CHOICE_FROM)) return 'model'
	if (thinkingBody?.type === 'enabled') return 'manual-thinking'
	return undefined
}

/**
 * Whether this model takes a forced tool choice — `toolChoice: 'required'` or
 * a named function — under the thinking configuration you intend to send.
 *
 * Built from the same resolution the request path uses, so a caller deciding
 * whether to force a step and the request it then sends cannot disagree.
 * `false` means the driver will refuse that request before sending it; use
 * `toolChoice: 'auto'` and say in the prompt which tool to call.
 */
export function acceptsForcedToolChoice(model: string, thinking?: ThinkingConfig): boolean {
	const body = resolveThinkingBody(thinking, resolveThinkingCapability(model))
	return forcedToolChoiceRefusal(model, body) === undefined
}

/**
 * Refuse, before transport, a forced tool choice the vendor is certain to reject.
 *
 * The same trade `resolveEffort` makes for an effort level. Sending it costs a
 * round trip to learn what is already known here. Quietly sending `auto`
 * instead would be worse: a forced choice is a contract that the model calls a
 * tool, and a caller relying on it — a step that must produce a structured
 * answer — would get prose back and be told the request succeeded.
 *
 * The error is the `bad_request` `ProviderRequestError` the vendor's 400 would
 * have become, with its own code, so a caller's handling does not change.
 */
export function assertForcedToolChoiceAccepted(
	toolChoice: ToolChoice | undefined,
	thinkingBody: ResolvedThinkingBody,
	model: string,
): void {
	if (!isForced(toolChoice)) return
	const refusal = forcedToolChoiceRefusal(model, thinkingBody)
	if (refusal === undefined) return
	throw new ProviderRequestError({
		kind: 'bad_request',
		providerId: 'anthropic',
		providerCode: 'forced_tool_choice_unsupported',
		detail:
			refusal === 'model'
				? `Model "${model}" does not accept a forced tool choice (toolChoice "required" or a named function). Use toolChoice "auto" and say in the prompt which tool to call, or responseFormat for a fixed JSON shape.`
				: `A forced tool choice (toolChoice "required" or a named function) cannot be combined with manual extended thinking, which this request's thinking setting resolves to on model "${model}". Use toolChoice "auto", or leave thinking off for this step.`,
	})
}
