export {
	assertEnableable,
	discoverPlugins,
	loadPluginManifest,
	discoverAllPluginDirs,
	parsePluginManifestText,
} from './loader.js'
export { definePlugin } from './define.js'
export type { DefinedPlugin, DefinePluginOptions } from './define.js'
export type { PluginDiscoveryOptions, PluginEnablementCapabilities } from './loader.js'
export {
	boundCompactionSummary,
	boundHookContext,
	boundHookReplacement,
	boundLastAssistantMessage,
	compactionHookInstructions,
	frameOperatorHookContext,
	MAX_COMPACTION_SUMMARY_HOOK_CHARS,
	MAX_HOOK_CONTEXT_CHARS,
	MAX_HOOK_REPLACEMENT_CHARS,
	MAX_LAST_MESSAGE_HOOK_CHARS,
	sessionStartHookContext,
} from './hook-context.js'
export { isHookEntriesPath, PluginLifecycleManager } from './lifecycle.js'
export { PluginResolver } from './resolver.js'
export {
	attachShellHooks,
	createShellHook,
	DEFAULT_SHELL_HOOK_TIMEOUT_MS,
	MAX_SHELL_HOOK_TIMEOUT_MS,
	runShellHook,
	SHELL_HOOK_EVENTS,
	SHELL_HOOK_PASCAL_EVENT_NAMES,
	SHELL_HOOKS_PLUGIN_ID,
	shellHookIfMatches,
	shellHookIfProblem,
	shellHookMatcherProblem,
	shellHookMatches,
	shellHookVerdict,
} from './shell-hook.js'
export {
	assignedWithin,
	isPluginFolderVariable,
	isShellOwnVariable,
	MOVED_FOLDER_ENDINGS,
	referencedVariables,
	SHELL_HOOK_RESERVED_ENV,
	shellHookEnvNameProblem,
	shellHookEnvProblems,
	substitutePluginFolders,
} from './shell-hook-env.js'
export {
	SHELL_HOOK_WRITTEN_TOOL_NAMES,
	type ShellHookToolNames,
	shellHookToolName,
} from './shell-hook-tool-names.js'
export type {
	HttpHookEntry,
	PromptHookEntry,
	ShellHookEntry,
	ShellHookEvent,
	ShellHookHandler,
	ShellHookJudge,
	ShellHookOnFailure,
	ShellHookCall,
	ShellHookInput,
	ShellHookOptions,
	ShellHookPathFilter,
	ShellHookOutcome,
	ShellHooksConfig,
} from './shell-hook.js'
