import { isExperimentalFreeZenModel } from '@namzu/zen/catalogue'
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
 * Anonymous Zen selection admits the driver's explicit experimental free list.
 * The helper also checks zero prices on the session's active catalogue, which
 * the background refresh can replace. The separate supportsAnonymousAccess
 * flag retains its meaning of verified direct access.
 */
export function requiresCredentialForModel(entry: ProviderRegistryEntry, model: string): boolean {
	return (
		entry.requiresApiKey ||
		(entry.id === 'zen' && !isExperimentalFreeZenModel('zen', findActiveZenModel('zen', model)))
	)
}

export function canSelectModel(
	entry: ProviderRegistryEntry,
	apiKey: string | undefined,
	model: string,
): boolean {
	return hasApiCredential(entry, apiKey) || !requiresCredentialForModel(entry, model)
}
