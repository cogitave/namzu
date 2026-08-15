import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { capabilityCheckId } from '../../context/capabilities.js'
import { providerChainCheck } from './chain.js'
import { credentialSourcesCheck } from './credentials.js'
import { providersRegisteredCheck } from './providers.js'
import { cwdWritableCheck, tmpdirWritableCheck } from './runtime.js'
import { sandboxPlatformCheck } from './sandbox.js'
import { describeInstalledPackage, telemetryInstalledCheck } from './telemetry.js'
import { vaultRegisteredCheck } from './vault.js'

/**
 * Build an `installed` check for one optional package, over the same
 * absent/present/broken mapping `telemetryInstalledCheck` already used.
 *
 * `telemetryInstalledCheck` keeps its own hand-written definition below
 * rather than being rebuilt through this factory — it shipped first, and
 * `doctor/checks/__tests__/telemetry.test.ts` already exercises that exact
 * object with zero edits required by NZ-BOOT-02. A fifth optional package
 * needs one call to this factory, not a fourth hand-written check that can
 * drift from the other three.
 */
function installedCheck(specifier: string, category: DoctorCheck['category']): DoctorCheck {
	return {
		id: capabilityCheckId(specifier),
		category,
		run: (): Promise<DoctorCheckResult> => describeInstalledPackage(specifier),
	}
}

// `sandboxPlatformCheck` already owns the `sandbox` category for a different
// question (does THIS PLATFORM enforce isolation); this check asking IS THE
// PACKAGE HERE fits the same category. `DoctorCategory` has no `files` or
// `computer-use` member, and widening that union is an SDK type change this
// task does not make, so those two register under `custom` — the category
// the registry's own tests already use for exactly this situation.
export const sandboxInstalledCheck: DoctorCheck = installedCheck('@namzu/sandbox', 'sandbox')
export const filesInstalledCheck: DoctorCheck = installedCheck('@namzu/files', 'custom')
export const computerUseInstalledCheck: DoctorCheck = installedCheck(
	'@namzu/computer-use',
	'custom',
)

// NOTE the fix versus the original submission: sandboxInstalledCheck /
// filesInstalledCheck / computerUseInstalledCheck are NOT repeated here.
// They already carry their own `export` keyword above; naming them again in
// this aggregation block is a duplicate-export declaration and fails
// `tsc --build` with TS2323/TS2484 (confirmed by building this exact file).
export {
	credentialSourcesCheck,
	providerChainCheck,
	providersRegisteredCheck,
	cwdWritableCheck,
	tmpdirWritableCheck,
	sandboxPlatformCheck,
	telemetryInstalledCheck,
	vaultRegisteredCheck,
}

export const builtInDoctorChecks: readonly DoctorCheck[] = [
	sandboxPlatformCheck,
	cwdWritableCheck,
	tmpdirWritableCheck,
	providersRegisteredCheck,
	credentialSourcesCheck,
	// After the credential scan: this one reports which of the credentials that
	// found are actually WIRED INTO the chain, which only reads sensibly once
	// the operator has seen what was found.
	providerChainCheck,
	vaultRegisteredCheck,
	sandboxInstalledCheck,
	filesInstalledCheck,
	computerUseInstalledCheck,
	telemetryInstalledCheck,
]
