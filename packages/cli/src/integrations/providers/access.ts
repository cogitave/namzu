import type { ProviderRegistryEntry } from './registry.js'
import { findActiveZenModel } from './zen-catalogue.js'

/** The service's public marker is not an account credential. */
export function hasApiCredential(
	entry: ProviderRegistryEntry,
	apiKey: string | undefined,
): boolean {
	if (entry.id === 'zen' || entry.id === 'zen-go') {
		return Boolean(apiKey?.trim() && apiKey.trim() !== 'public')
	}
	return Boolean(apiKey)
}

/**
 * Direct anonymous Zen admission uses the driver's curated access flag, not
 * every model the service advertises as free. Read the session's active
 * catalogue, which the background refresh can replace.
 */
export function requiresCredentialForModel(entry: ProviderRegistryEntry, model: string): boolean {
	return (
		entry.requiresApiKey ||
		(entry.id === 'zen' && findActiveZenModel('zen', model)?.supportsAnonymousAccess !== true)
	)
}

export function canSelectModel(
	entry: ProviderRegistryEntry,
	apiKey: string | undefined,
	model: string,
): boolean {
	return hasApiCredential(entry, apiKey) || !requiresCredentialForModel(entry, model)
}
