import type { DoctorCheck } from '@namzu/sdk'

import { providerChainCheck } from './chain.js'
import { credentialSourcesCheck } from './credentials.js'
import { providersRegisteredCheck } from './providers.js'
import { cwdWritableCheck, tmpdirWritableCheck } from './runtime.js'
import { sandboxPlatformCheck } from './sandbox.js'
import { telemetryInstalledCheck } from './telemetry.js'
import { vaultRegisteredCheck } from './vault.js'

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
	telemetryInstalledCheck,
]
