/** Discovery directories */
export const PROJECT_PLUGIN_DIR = '.namzu/plugins'
export const USER_PLUGIN_DIR = '.namzu/plugins'

/** Manifest file name */
export const PLUGIN_MANIFEST_FILENAME = 'plugin.json'

/** Namespacing separator between plugin name and component name */
export const PLUGIN_NAMESPACE_SEPARATOR = ':'

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
export const HOOK_MAX_CONCURRENT = 10
