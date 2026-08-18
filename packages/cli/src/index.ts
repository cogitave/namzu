/**
 * @namzu/cli library entry — for embedded usage where consumers want to
 * invoke runDoctor() in their own process so app-registered checks are
 * visible. The standalone CLI binary lives at ./bin.ts.
 */

// Doctor library API (pre-M0; preserved for embedded consumers).
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
	computerUseInstalledCheck,
	credentialSourcesCheck,
	cwdWritableCheck,
	filesInstalledCheck,
	providerChainCheck,
	providersRegisteredCheck,
	sandboxInstalledCheck,
	sandboxPlatformCheck,
	telemetryInstalledCheck,
	tmpdirWritableCheck,
	vaultRegisteredCheck,
} from './doctor/checks/index.js'

export {
	type CapabilityProbe,
	NAMZU_OPTIONAL_CAPABILITIES,
	probeCapabilities,
	probeOptionalPackage,
} from './context/capabilities.js'

export { runDoctorCommand } from './commands/doctor.js'

// Shell + extension surface for the CLI.
export { runCli, type RunCliOptions } from './cli.js'
export type {
	CommandContext,
	CommandDef,
	CommandHandler,
	CommandHandlerArgs,
} from './commands/types.js'
export {
	registerAll,
	registerCommand,
	type RegisterOptions,
} from './commands/registry.js'
export {
	createFormatter,
	type FormatName,
	type Formatter,
	type FormatterOptions,
	isFormatName,
} from './output/index.js'
export {
	ConfigLoadError,
	ConfigValueError,
	loadConfig,
	loadConfigWithProvenance,
	type ConfigProvenance,
	type ConfigSource,
	type ConfigValueSource,
	type LoadConfigOptions,
} from './config/load.js'
export {
	DEFAULT_CONFIG,
	type NamzuCliConfig,
	type TerminalNotificationEvent,
	type TerminalNotificationMethod,
	type TuiConfig,
} from './config/schema.js'
