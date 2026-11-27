export {
	CLASSIC_HOOK_EVENTS,
	MODULE_HOOK_EVENTS,
	classicEventName,
	classicWrittenName,
	resolvePattern,
} from './events.js'
export type { ResolvedPattern } from './events.js'
export {
	MAX_MODULE_FILE_BYTES,
	MAX_MODULE_FILES,
	MAX_MODULE_TOTAL_BYTES,
	SUPPORTED_CAPABILITY_CALLS,
	locateHookModule,
	readPluginFile,
	scanHookModule,
} from './scan.js'
export type {
	HookModuleLocation,
	HookModuleProgram,
	HookModuleScan,
	PluginFileRead,
	ScanRefusal,
	ScannedCall,
	ScannedHook,
} from './scan.js'
export {
	HOOK_MODULE_BUDGET_MS,
	HOOK_MODULE_CATCH_MS,
	startHookModule,
	workerTransport,
} from './host.js'
export type {
	HookModuleClock,
	HookModuleHandle,
	HookModuleTransport,
	HookModuleTransportFactory,
	StartHookModuleOptions,
} from './host.js'
export {
	createCapabilityBridge,
	MAX_CAPABILITY_BYTES,
	MAX_STORE_BYTES,
	STORE_FILE,
} from './capabilities.js'
export type { CapabilityBridge, CapabilityBridgeOptions } from './capabilities.js'
export {
	hookModuleConsentEntry,
	hookModuleConsentLines,
	summarizeHookModule,
} from './consent.js'
export type { HookModuleConsentEntry, HookModuleSummary } from './consent.js'
