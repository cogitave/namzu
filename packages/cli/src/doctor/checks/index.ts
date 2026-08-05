import type { DoctorCheck } from '@namzu/sdk'

import { credentialSourcesCheck } from './credentials.js'
import { providersRegisteredCheck } from './providers.js'
import { cwdWritableCheck, tmpdirWritableCheck } from './runtime.js'
import { sandboxPlatformCheck } from './sandbox.js'
import { telemetryInstalledCheck } from './telemetry.js'
import { vaultRegisteredCheck } from './vault.js'

export {
	credentialSourcesCheck,
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
	vaultRegisteredCheck,
	telemetryInstalledCheck,
]
