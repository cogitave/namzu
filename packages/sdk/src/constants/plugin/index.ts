/** Discovery directories */
export const PROJECT_PLUGIN_DIR = '.namzu/plugins'
export const USER_PLUGIN_DIR = '.namzu/plugins'

/** Manifest file name */
export const PLUGIN_MANIFEST_FILENAME = 'plugin.json'

/**
 * Namespacing separator between plugin name and component name.
 *
 * `__`, not `:`. A tool name reaches the provider verbatim, and the major
 * message APIs accept `[a-zA-Z0-9_-]` only — so a colon made EVERY
 * plugin-contributed tool name illegal, unconditionally. Those tools are
 * registered deferred, so the rejection fired the moment one was activated
 * and took down the whole request rather than that one tool, with nothing
 * naming the culprit.
 *
 * Double underscore rather than single so the boundary stays legible in a
 * name that already contains underscores, and it matches the separator the
 * remote-tool bridge next door already uses.
 */
export const PLUGIN_NAMESPACE_SEPARATOR = '__'

/** Plugin name validation */
export const PLUGIN_NAME_MAX_LENGTH = 64
export const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Per-plugin contribution limits */
export const MAX_TOOLS_PER_PLUGIN = 50
export const MAX_HOOKS_PER_PLUGIN = 20
export const MAX_MCP_SERVERS_PER_PLUGIN = 5
export const MAX_SKILLS_PER_PLUGIN = 20
export const MAX_CONNECTORS_PER_PLUGIN = 10
export const MAX_PERSONAS_PER_PLUGIN = 5

/** Hook execution */
export const HOOK_TIMEOUT_MS = 5_000

/**
 * Priority a hook gets when it does not declare one.
 *
 * Mid-scale on purpose: a guard can sort itself decisively ahead of every
 * existing hook without having to know what they chose, and an observer
 * can sort itself after.
 */
export const DEFAULT_HOOK_PRIORITY = 100
export const HOOK_MAX_CONCURRENT = 10
