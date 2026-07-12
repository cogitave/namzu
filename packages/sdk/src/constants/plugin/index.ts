/** Discovery directories */
export const PROJECT_PLUGIN_DIR = '.namzu/plugins'
export const USER_PLUGIN_DIR = '.namzu/plugins'

/** Manifest file name */
export const PLUGIN_MANIFEST_FILENAME = 'plugin.json'

/**
 * Namespacing separator between plugin name and component name.
 *
 * `__` rather than `:` because a composed name is the name the model sees and
 * calls: strict providers reject `:` in a tool name. Composition is injective
 * because no component may itself contain `__` (see PLUGIN_COMPONENT_PATTERN),
 * so every `__` in a composed name is necessarily a boundary.
 */
export const PLUGIN_NAMESPACE_SEPARATOR = '__'

/**
 * The legacy separator, still accepted on lookup so that runs persisted before
 * the `__` change replay. Never used for composition.
 *
 * @deprecated Removal target: @namzu/sdk 0.6.0.
 */
export const LEGACY_PLUGIN_NAMESPACE_SEPARATOR = ':'

/** Plugin name validation */
export const PLUGIN_NAME_MAX_LENGTH = 64
export const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * A single component of a composed tool name (plugin name, MCP server name, leaf
 * tool name). Single underscores are legal — MCP servers routinely ship
 * `read_file` / `write_file` — but a component may never contain the `__`
 * separator itself; that is checked separately, since a regex cannot express
 * "matches this character class AND excludes this substring" readably.
 */
export const PLUGIN_COMPONENT_PATTERN = /^[a-zA-Z0-9_-]+$/

/** Per-plugin contribution limits */
export const MAX_TOOLS_PER_PLUGIN = 50
export const MAX_HOOKS_PER_PLUGIN = 20
export const MAX_MCP_SERVERS_PER_PLUGIN = 5
export const MAX_SKILLS_PER_PLUGIN = 20
export const MAX_CONNECTORS_PER_PLUGIN = 10
export const MAX_PERSONAS_PER_PLUGIN = 5

/** Hook execution */
export const HOOK_TIMEOUT_MS = 5_000
export const HOOK_MAX_CONCURRENT = 10
