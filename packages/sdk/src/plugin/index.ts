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
export { PluginLifecycleManager } from './lifecycle.js'
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
export {
	fileChangedMatcherNote,
	fileChangedMatcherPaths,
	fileChangedMatches,
} from './shell-hook.js'
export {
	HOOK_ENV_EVENTS,
	MAX_HOOK_ENV_FILE_BYTES,
	MAX_HOOK_ENV_VALUE_CHARS,
	MAX_HOOK_ENV_VARIABLES,
	refusedHookEnvName,
	SessionHookEnv,
} from './session-hook-env.js'
export type { HookEnvEvent, SessionHookEnvOptions } from './session-hook-env.js'
export { FILE_SETTLE_MS, FileChangeWatcher, MAX_WATCHED_PATHS } from './file-change-watch.js'
export type {
	FileChange,
	FileChangeWatcherOptions,
	WatchDirectory,
} from './file-change-watch.js'
export { FileChangeHooks } from './file-change-hooks.js'
export type { FileChangeHooksOptions } from './file-change-hooks.js'
export {
	WORKTREE_HOOK_SHOWN_CHARS,
	worktreeHookPrinted,
	worktreeHookVerdict,
} from './worktree-hook-answer.js'
