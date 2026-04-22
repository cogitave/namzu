/**
 * @namzu/cli library entry — for embedded usage where consumers want to
 * invoke runDoctor() in their own process so app-registered checks are
 * visible. The standalone CLI binary lives at ./bin.ts.
 */

export {
	createDoctorRegistry,
	doctor,
	DoctorRegistry,
	registerDoctorCheck,
	runDoctor,
} from './doctor/registry.js'
export type { RunDoctorOptions } from './doctor/registry.js'

export {
	builtInDoctorChecks,
	cwdWritableCheck,
	providersRegisteredCheck,
	sandboxPlatformCheck,
	telemetryInstalledCheck,
	tmpdirWritableCheck,
	vaultRegisteredCheck,
} from './doctor/checks/index.js'

export { runDoctorCommand } from './commands/doctor.js'
