import type { Attributes } from '@opentelemetry/api'
import { isProviderRequestError } from '../provider/errors.js'
import type { TokenUsage } from '../types/common/index.js'
import { GENAI } from './attributes.js'

/**
 * The OpenTelemetry semantic conventions for generative AI, as far as the
 * spans of this kernel follow them.
 *
 * The convention is still marked "Development", so its names can change
 * between releases. What the kernel emits is therefore pinned to ONE released
 * version, and says so: the instrumentation scope carries the schema URL of
 * that version. The text of the convention was published in the
 * `semantic-conventions` repository up to and including v1.41.1; later
 * releases only point to a new repository. Moving the pin means reading the
 * new text, changing {@link GENAI_SEMCONV_VERSION} and the table in
 * `docs/sdk/telemetry-genai.md` together; a test fails when an attribute name
 * is emitted that is not in {@link GENAI_SEMCONV_ATTRIBUTES}.
 *
 * Everything here is additive: the kernel's own names (`namzu.*`, and the
 * `gen_ai.*` names it already wrote) are untouched. One process-wide switch
 * turns the new names off for a backend that bills by attribute.
 */
export const GENAI_SEMCONV_VERSION = '1.41.1'

/** Schema URL of the pinned version; set on the tracer's instrumentation scope. */
export const GENAI_SEMCONV_SCHEMA_URL = `https://opentelemetry.io/schemas/${GENAI_SEMCONV_VERSION}`

/** `gen_ai.operation.name` values this kernel uses; all three are in the pinned convention's list. */
export const GENAI_OPERATION = {
	CHAT: 'chat',
	EXECUTE_TOOL: 'execute_tool',
	INVOKE_AGENT: 'invoke_agent',
} as const

/** The convention's name for the error class of a failed operation (stable). */
export const ERROR_TYPE = 'error.type'

/** The convention's fallback `error.type` value. */
export const ERROR_TYPE_OTHER = '_OTHER'

/**
 * Every attribute name the pinned convention version defines for the three
 * span kinds this kernel emits (inference, execute tool, invoke agent) that
 * the kernel may write, whether the kernel's own earlier code or the additions
 * wrote it. A span's `gen_ai.*` / `error.type` keys must all be in here, with
 * the one exception named in {@link GENAI_NON_CONVENTION_NAMES}.
 */
export const GENAI_SEMCONV_ATTRIBUTES: readonly string[] = [
	GENAI.OPERATION_NAME,
	GENAI.PROVIDER_NAME,
	ERROR_TYPE,
	GENAI.CONVERSATION_ID,
	GENAI.AGENT_NAME,
	GENAI.AGENT_ID,
	GENAI.REQUEST_MODEL,
	GENAI.REQUEST_STREAM,
	GENAI.REQUEST_TEMPERATURE,
	GENAI.REQUEST_MAX_TOKENS,
	GENAI.RESPONSE_MODEL,
	GENAI.RESPONSE_ID,
	GENAI.RESPONSE_FINISH_REASONS,
	GENAI.USAGE_INPUT_TOKENS,
	GENAI.USAGE_OUTPUT_TOKENS,
	GENAI.USAGE_CACHE_READ_INPUT_TOKENS,
	GENAI.USAGE_CACHE_CREATION_INPUT_TOKENS,
	GENAI.USAGE_REASONING_OUTPUT_TOKENS,
	GENAI.TOOL_NAME,
	GENAI.TOOL_CALL_ID,
	GENAI.TOOL_TYPE,
]

/**
 * `gen_ai.*` names the kernel writes that are NOT in the pinned convention.
 * `gen_ai.system` is what the convention's `gen_ai.provider.name` replaced;
 * it stays because it is existing output that nothing may remove.
 */
export const GENAI_NON_CONVENTION_NAMES: readonly string[] = [GENAI.SYSTEM]

let enabled = true

/**
 * Turn the convention's attribute names (and the schema URL) on or off for
 * every span the kernel starts from now on. On by default. `@namzu/telemetry`
 * calls this from `TelemetryConfig.genAiAttributes`; a host that does not use
 * that package can call it directly.
 */
export function setGenAiConventions(on: boolean): void {
	enabled = on
}

export function genAiConventionsEnabled(): boolean {
	return enabled
}

/**
 * The convention's provider name for a kernel provider id, or `undefined`
 * when the convention lists no value that fits. A custom value is allowed by
 * the convention, but inventing one here would be a claim about someone
 * else's product, so the attribute is left out instead (`gen_ai.system` still
 * carries our own id). `google` is `gcp.gen_ai`: the convention's value for
 * "any Google generative AI endpoint", since our id does not say which one.
 */
export function genAiProviderName(providerId: string | undefined): string | undefined {
	switch (providerId) {
		case 'anthropic':
			return 'anthropic'
		case 'bedrock':
			return 'aws.bedrock'
		case 'deepseek':
			return 'deepseek'
		case 'google':
			return 'gcp.gen_ai'
		case 'openai':
		case 'codex':
			return 'openai'
		default:
			return undefined
	}
}

/**
 * A low-cardinality class for a failure, for `error.type`: the provider
 * error kind for a classified provider failure, the error's own class name
 * for an exception, `_OTHER` for anything else (a thrown string, a plain
 * `Error`).
 */
export function genAiErrorType(err: unknown): string {
	if (isProviderRequestError(err)) return err.kind
	if (err instanceof Error) {
		const name = err.name
		return name && name !== 'Error' ? name : ERROR_TYPE_OTHER
	}
	return ERROR_TYPE_OTHER
}

/** Added when a turn (an agent run, a sub-agent included) starts. */
export function agentRunAttributes(providerId: string | undefined): Attributes {
	if (!enabled) return {}
	const provider = genAiProviderName(providerId)
	return {
		[GENAI.OPERATION_NAME]: GENAI_OPERATION.INVOKE_AGENT,
		...(provider !== undefined ? { [GENAI.PROVIDER_NAME]: provider } : {}),
	}
}

/** Added when a model call starts. Every model call is streamed. */
export function chatStartAttributes(providerId: string | undefined): Attributes {
	if (!enabled) return {}
	const provider = genAiProviderName(providerId)
	return {
		...(provider !== undefined ? { [GENAI.PROVIDER_NAME]: provider } : {}),
		[GENAI.REQUEST_STREAM]: true,
	}
}

/**
 * Added when a model call answers. A count is written only when the driver
 * reported a positive one: the record cannot tell "none" from "not
 * reported", so a zero is left out rather than stated.
 */
export function chatUsageAttributes(usage: TokenUsage): Attributes {
	if (!enabled) return {}
	return {
		...(usage.cachedTokens > 0
			? { [GENAI.USAGE_CACHE_READ_INPUT_TOKENS]: usage.cachedTokens }
			: {}),
		...(usage.cacheWriteTokens > 0
			? { [GENAI.USAGE_CACHE_CREATION_INPUT_TOKENS]: usage.cacheWriteTokens }
			: {}),
		...(usage.reasoningTokens !== undefined && usage.reasoningTokens > 0
			? { [GENAI.USAGE_REASONING_OUTPUT_TOKENS]: usage.reasoningTokens }
			: {}),
	}
}

/** Added when a tool call starts. */
export function toolCallAttributes(): Attributes {
	if (!enabled) return {}
	return { [GENAI.OPERATION_NAME]: GENAI_OPERATION.EXECUTE_TOOL }
}

/** The `error.type` of a tool call the kernel refused (not available, not allowed, plan mode); a custom low-cardinality value, which the convention allows. */
export const PERMISSION_DENIED = 'permission_denied'

/** Added to a span whose operation ended in an error. */
export function errorTypeAttributes(errorType: string): Attributes {
	if (!enabled) return {}
	return { [ERROR_TYPE]: errorType }
}
