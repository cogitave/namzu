export {
	type DetectedProvider,
	type DetectionSource,
	type DiscoverOptions,
	discoverProviders,
	findDetected,
} from './discover.js'
export {
	type AgentOAuthCredential,
	isAnthropicOAuthToken,
	readAgentKeychainCredential,
} from './keychain.js'
export {
	clearStoredSubscriptionCredential,
	CREDENTIALS_FILE_VERSION,
	CredentialStoreError,
	credentialsPath,
	readStoredSubscriptionCredential,
	writeStoredSubscriptionCredential,
} from './credential-store.js'
export { OAUTH_SCOPES, REDIRECT_URI } from './identity.js'
export {
	CredentialPublicationError,
	CredentialWithdrawnError,
	type CredentialOrigin,
	ensureFreshAnthropicToken,
	type OAuthMetadata,
	readSubscriptionCredential,
	refreshAgentOAuthToken,
} from './oauth.js'
export {
	beginSubscriptionLogin,
	type LoginOutcome,
	parsePastedInput,
	type SubscriptionLogin,
	type SubscriptionLoginOptions,
	subscriptionDetectedProvider,
} from './subscription-login.js'
export {
	type CapabilityDisagreement,
	chainCapabilityDisagreements,
	describeAcceptedMismatch,
	describeCapabilityRefusal,
	type MemberCapabilities,
	unresolvedMembers,
} from './chain-capabilities.js'
export {
	chainPositionName,
	type Preferences,
	PREFERENCES_FILE_VERSION,
	PreferencesError,
	preferencesPath,
	primaryProvider,
	type ProviderChoice,
	type ReadResult,
	readPreferences,
	writePreferences,
} from './preferences.js'
export {
	ALL_PROVIDER_IDS,
	missingCredentialMessage,
	PROVIDER_REGISTRY,
	type ProviderId,
	type ProviderRegistryEntry,
	type SdkProviderType,
	unsupportedProviderMessage,
} from './registry.js'
export {
	ensureRegistered,
	isRegistered,
	resolveChainCapabilities,
} from './register.js'
