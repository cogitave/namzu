import type { LLMProvider, ProviderCapabilities } from '../types/provider/index.js'

/**
 * Fully-resolved capability set: every flag present, no optionals left.
 * What the query runtime branches on after applying the permissive default.
 */
export interface ResolvedProviderCapabilities {
	supportsTools: boolean
	supportsStreaming: boolean
	supportsFunctionCalling: boolean
	supportsVision: boolean
	maxOutputTokens?: number
}

/**
 * THE permissive default: a provider that declares nothing is assumed to
 * handle everything — exactly the pre-negotiation behavior, so third-party
 * providers written before `LLMProvider.capabilities` existed keep working
 * without a warning storm. Shipped drivers always declare explicitly.
 */
export const PERMISSIVE_PROVIDER_CAPABILITIES: ResolvedProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
}

/**
 * Resolve a provider's declared capabilities against the permissive
 * default. Absent declaration ⇒ everything `true`; a partial declaration
 * (e.g. one missing `supportsVision`, added later) fills the gap
 * permissively per field.
 */
export function resolveProviderCapabilities(
	provider: Pick<LLMProvider, 'capabilities'>,
): ResolvedProviderCapabilities {
	const declared: ProviderCapabilities | undefined = provider.capabilities
	return {
		supportsTools: declared?.supportsTools ?? PERMISSIVE_PROVIDER_CAPABILITIES.supportsTools,
		supportsStreaming:
			declared?.supportsStreaming ?? PERMISSIVE_PROVIDER_CAPABILITIES.supportsStreaming,
		supportsFunctionCalling:
			declared?.supportsFunctionCalling ?? PERMISSIVE_PROVIDER_CAPABILITIES.supportsFunctionCalling,
		supportsVision: declared?.supportsVision ?? PERMISSIVE_PROVIDER_CAPABILITIES.supportsVision,
		maxOutputTokens: declared?.maxOutputTokens,
	}
}
