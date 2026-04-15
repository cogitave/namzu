export { ProviderRegistry, UnknownProviderError, DuplicateProviderError } from './registry.js'
export { MockLLMProvider } from './mock.js'
export { registerMock, MOCK_CAPABILITIES } from './mock-register.js'

// Transitional: these re-exports + auto-registration will move to their own
// packages (@namzu/openrouter) in subsequent phases.
// BedrockProvider has been extracted to @namzu/bedrock (ADR-0001).
export { OpenRouterProvider } from './openrouter/client.js'
export { registerOpenRouter, OPENROUTER_CAPABILITIES } from './openrouter-register.js'
