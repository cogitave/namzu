/**
 * Everything the command shell uses that needs `@namzu/sdk`, behind one
 * dynamic import.
 *
 * `cli.ts` imports this module from its `preAction` hook, once a command is
 * going to run, and not at the top: commander answers `--version` and
 * `--help` before any hook, and a static import of the config reader, the
 * logger or the permission compiler made them compile the SDK first (about
 * 400 ms to print a version). The functions are re-exported unchanged.
 */

export { emitBootNarrative } from './boot-narrative.js'
export { createConfigDebugSnapshot } from './config/debug.js'
export {
	ConfigLoadError,
	ConfigValueError,
	loadBootstrapConfigWithProvenance,
	loadConfigWithProvenance,
} from './config/load.js'
export { startZenCatalogueRefresh } from './integrations/providers/zen-catalogue.js'
export { resolveNamzuHome } from './integrations/state/home.js'
export {
	cliLogger,
	createStderrSink,
	installCliLogging,
	resolveLogFormat,
	resolveLogLevel,
} from './logging.js'
export { compileBrowserSites, withBrowserSiteRules } from './permissions/browser-sites.js'
export { hasAcknowledgedBypass, acknowledgeBypass } from './permissions/consent.js'
export { askBypassConsent } from './permissions/consent-prompt.js'
export { planLaunchMode } from './permissions/launch.js'
export { permissionModeFromName } from './permissions/mode.js'
export {
	compilePermissionLayers,
	compilePermissions,
	permissionLayersOf,
	warnLegacyMcpPermissionNames,
} from './permissions/rules.js'
