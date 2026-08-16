export { InMemoryCredentialVault } from './InMemoryCredentialVault.js'

// Where a credential comes from, as a seam a host can implement — parallel
// to the connector-scoped `CredentialVault`, which answers a different
// question and holds a whole `AuthConfig` per connector.
export {
	EnvCredentialProvider,
	ReadOnlyCredentialProviderError,
} from './CredentialProvider.js'
export type {
	CredentialDescription,
	CredentialProvider,
	CredentialRef,
	EnvCredentialProviderOptions,
	ResolvedCredential,
} from './CredentialProvider.js'
