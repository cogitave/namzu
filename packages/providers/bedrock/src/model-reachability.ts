/**
 * Whether this driver's wire can serve a given model id.
 *
 * This driver speaks `Converse` / `ConverseStream` with ARN-versioned model
 * ids — `anthropic.claude-sonnet-4-5-20250929-v1:0`, usually behind an
 * inference-profile prefix (`us.`, `eu.`, `global.`). That is the integration
 * documented for Claude 4.6 and earlier.
 *
 * The current generation is not on it. Claude Opus 5, Sonnet 5, Fable 5, Opus
 * 4.8 and Opus 4.7 are served by a different Bedrock integration that speaks
 * the Messages API shape, and their ids carry no version suffix at all
 * (`anthropic.claude-opus-5`). The vendor's own legacy page states the reason
 * they are absent from its model table: they do not have ARN-versioned model
 * ids.
 *
 * So a caller passing a 5-series id here is not making a small mistake that a
 * shrug would absorb — they are pointing a wire at models it was not built
 * for, and the answer they get back is an opaque AWS validation error naming
 * neither the cause nor the fix. Refusing with both is the whole value of
 * knowing this.
 *
 * **This is a reachability check, not a capability table.** It does not claim
 * to know which models exist, only which id SHAPE this wire accepts. A new
 * ARN-versioned model passes without this file changing, which is the correct
 * failure direction for a list that will go stale.
 */

/** Inference-profile prefixes the Converse wire accepts on a model id. */
const PROFILE_PREFIXES = ['global.', 'us.', 'eu.', 'jp.', 'apac.']

function stripProfilePrefix(modelId: string): string {
	for (const prefix of PROFILE_PREFIXES) {
		if (modelId.startsWith(prefix)) return modelId.slice(prefix.length)
	}
	return modelId
}

/**
 * A Claude id with no ARN version suffix — the shape the newer Bedrock
 * integration uses, and the one this wire cannot serve.
 *
 * Matched positively rather than by excluding known-good names: the set of
 * versioned models grows, and a check that has to be edited for every new
 * model is a check that will be wrong before it is read.
 */
const UNVERSIONED_CLAUDE = /^anthropic\.claude-(?:haiku|sonnet|opus|fable|mythos)-[a-z0-9.-]*$/

function hasArnVersion(modelId: string): boolean {
	return /-v\d+(?::\d+)?$/.test(modelId)
}

/**
 * Whether this id names a model Anthropic serves.
 *
 * Converse is a multi-vendor wire — the same request shape carries Claude,
 * Llama, Mistral and more — so a property of the Anthropic models is not a
 * property of the wire. Tool input schemas are one: Anthropic's serving layer
 * validates them against JSON Schema 2020-12 regardless of which front door the
 * request came through, while nothing says the other vendors on this wire do.
 * Rendering the dialect Anthropic requires, only for the models that require
 * it, is the claim that can actually be defended.
 */
export function isAnthropicServedModel(modelId: string): boolean {
	return stripProfilePrefix(modelId.trim().toLowerCase()).startsWith('anthropic.')
}

export function assertModelReachable(modelId: string): void {
	const bare = stripProfilePrefix(modelId.trim().toLowerCase())
	if (!bare.startsWith('anthropic.')) return
	if (hasArnVersion(bare)) return
	if (!UNVERSIONED_CLAUDE.test(bare)) return

	throw new Error(
		`This driver cannot reach "${modelId}". It speaks Bedrock's Converse API, which serves ARN-versioned model ids such as "us.anthropic.claude-sonnet-4-5-20250929-v1:0" — Claude 4.6 and earlier. Models with no version suffix (Opus 5, Sonnet 5, Fable 5, Opus 4.8, Opus 4.7) are served by the newer Bedrock integration, which speaks the Messages API shape at a different endpoint and is not what this driver talks to. Use a versioned model id here, or reach the newer models through a driver built for that endpoint.`,
	)
}
