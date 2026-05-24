export {
	type DetectedProvider,
	type DetectionSource,
	type DiscoverOptions,
	discoverProviders,
	findDetected,
} from './discover.js'
export {
	type ClaudeCodeOAuthCredential,
	isAnthropicOAuthToken,
	readClaudeCodeKeychainCredential,
} from './keychain.js'
export { maskSecret } from './mask.js'
export {
	type Preferences,
	PREFERENCES_FILE_VERSION,
	PreferencesError,
	preferencesPath,
	type ReadResult,
	readPreferences,
	writePreferences,
} from './preferences.js'
export {
	ALL_PROVIDER_IDS,
	PROVIDER_REGISTRY,
	type ProviderId,
	type ProviderRegistryEntry,
	type SdkProviderType,
} from './registry.js'
export { clawtoolSecretsPath, readClawtoolSecrets, type SecretCandidate } from './secrets.js'
// Manual-profile escape hatch — kept for users who configure providers
// by API key directly without going through the auto-discovery picker.
export {
	type AnthropicProfile,
	type BaseProfile,
	type BedrockProfile,
	type HttpProfile,
	type LMStudioProfile,
	type OllamaProfile,
	type OpenAIProfile,
	type OpenRouterProfile,
	PROVIDER_TYPES,
	type ProviderProfile,
	type ProviderType,
	type ProvidersFile,
	PROVIDERS_FILE_VERSION,
	ProfileValidationError,
	TYPE_ENV_FALLBACK,
	isProviderType,
	validateProfile,
} from './schema.js'
export {
	ProvidersStoreError,
	assertInvariants,
	findDefault,
	providersPath,
	readProfiles,
	resolveApiKey,
	writeProfiles,
} from './store.js'
