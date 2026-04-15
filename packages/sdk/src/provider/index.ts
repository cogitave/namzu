export { ProviderRegistry, UnknownProviderError, DuplicateProviderError } from './registry.js'
export { MockLLMProvider } from './mock.js'
export { registerMock, MOCK_CAPABILITIES } from './mock-register.js'

// Transitional: these re-exports + auto-registration will move to their own
// packages (@namzu/bedrock, @namzu/openrouter) in subsequent phases.
export { BedrockProvider } from './bedrock/client.js'
export { OpenRouterProvider } from './openrouter/client.js'
export { registerBedrock, BEDROCK_CAPABILITIES } from './bedrock-register.js'
export { registerOpenRouter, OPENROUTER_CAPABILITIES } from './openrouter-register.js'
