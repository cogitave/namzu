import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

/**
 * Built-in provider probe is intentionally `skipped` in v1.
 *
 * `skipped` rather than `inconclusive` for the reason spelled out on
 * `vault.registered`: there is no discovery mechanism here to fail, so this is
 * a permanent absence of a subject rather than a question that went unanswered,
 * and only the latter is worth an exit code.
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
		status: 'skipped',
		message:
			'no provider auto-discovery in v1; register a provider check via registerDoctorCheck for your specific provider configuration (call provider.doctorCheck?() per registered provider)',
	}),
}
