import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

/**
 * Built-in provider probe is intentionally inconclusive in v1.
 *
 * Provider auto-discovery requires walking `ProviderRegistry`, which is
 * a module-private map populated by side-effecting calls in consumer
 * code. Standalone `runDoctor()` invoked from a different process won't
 * see those registrations. Two consumer paths:
 *
 * 1. Consumers running doctor in their own process via `runDoctor()`
 *    can register a custom provider check that iterates their
 *    `ProviderRegistry.getAll()` and calls `provider.doctorCheck?.()`
 *    on each.
 * 2. The standalone `namzu doctor` CLI command (Phase 5) inherits
 *    this same behavior — it can only check providers that are visible
 *    to its process. Plugin-registered providers ARE visible.
 */
export const providersRegisteredCheck: DoctorCheck = {
	id: 'providers.registered',
	category: 'providers',
	run: async (): Promise<DoctorCheckResult> => ({
		status: 'inconclusive',
		message:
			'no provider auto-discovery in v1; register a provider check via registerDoctorCheck for your specific provider configuration (call provider.doctorCheck?() per registered provider)',
	}),
}
