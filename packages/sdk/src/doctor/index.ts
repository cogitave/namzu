export {
	createDoctorRegistry,
	doctor,
	DoctorRegistry,
	registerDoctorCheck,
	runDoctor,
} from './registry.js'
export type { RunDoctorOptions } from './registry.js'

export {
	builtInDoctorChecks,
	cwdWritableCheck,
	providersRegisteredCheck,
	sandboxPlatformCheck,
	telemetryInstalledCheck,
	tmpdirWritableCheck,
	vaultRegisteredCheck,
} from './checks/index.js'
