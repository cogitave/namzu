/**
 * The literal names of the common plugin layout, in one file.
 *
 * Plugins written for other tools share one on-disk shape, and Namzu reads it
 * so a folder made for that shape runs here unchanged. The file and variable
 * names below belong to that shape, not to Namzu: they are compatibility
 * literals, kept here and nowhere else so the rest of the code, its comments
 * and the docs say "the common plugin layout" and name no one. Every
 * Namzu-facing path and variable keeps its own name (`.namzu`, `NAMZU_*`).
 *
 * This file is allowlisted in `scripts/audit-external-names.mjs` for that
 * reason. Adding a name here is a compatibility decision, not a naming one.
 */

/** The folder that holds the common layout's manifest. */
export const COMMON_MANIFEST_DIR = '.claude-plugin'

/** The manifest's file name inside {@link COMMON_MANIFEST_DIR}. */
export const COMMON_MANIFEST_FILE = 'plugin.json'

/** The file of servers at the plugin's root. */
export const COMMON_MCP_FILE = '.mcp.json'

/** The folder of hook entries and the file inside it. */
export const COMMON_HOOKS_FILE = 'hooks/hooks.json'

/** The folders the layout auto-scans, and the root file of a one-skill plugin. */
export const COMMON_SKILLS_DIR = 'skills'
export const COMMON_COMMANDS_DIR = 'commands'
export const COMMON_AGENTS_DIR = 'agents'
export const COMMON_ROOT_SKILL_FILE = 'SKILL.md'

/** Folders that name a component Namzu has no place for. */
export const COMMON_UNUSED_DIRS: readonly string[] = [
	'output-styles',
	'themes',
	'monitors',
	'workflows',
	'bin',
]

/**
 * The sidecar a marketplace install writes beside the plugin, holding the
 * allow-listed fields of the marketplace entry. Namzu's own name; read only
 * when an install record names the folder.
 */
export const ENTRY_SIDECAR_FILE = '.namzu-entry.json'

/** Variables a plugin's configuration and text may name, as the layout spells them. */
export const COMMON_ROOT_VARIABLE = 'CLAUDE_PLUGIN_ROOT'
export const COMMON_DATA_VARIABLE = 'CLAUDE_PLUGIN_DATA'
export const COMMON_PROJECT_VARIABLE = 'CLAUDE_PROJECT_DIR'

/** The same three, spelled for Namzu. */
export const NAMZU_ROOT_VARIABLE = 'NAMZU_PLUGIN_ROOT'
export const NAMZU_DATA_VARIABLE = 'NAMZU_PLUGIN_DATA'
export const NAMZU_PROJECT_VARIABLE = 'NAMZU_PROJECT_DIR'

/** The text a plugin's configuration uses for saved options; not supported yet. */
export const COMMON_USER_CONFIG_PREFIX = 'user_config.'

/** A command spelled `/<plugin>:<command>` in the layout's own documentation. */
export const COMMON_COMMAND_SEPARATOR = ':'

/** A marketplace catalog's file name; it sits in {@link COMMON_MANIFEST_DIR} of the marketplace folder. */
export const COMMON_MARKETPLACE_FILE = 'marketplace.json'

/**
 * Marketplace names the layout's own official catalogs use. A marketplace added
 * from anywhere else may not take one, nor a name built from the two words the
 * layout's maker goes by, so a catalog cannot pass itself off as an official one.
 */
export const COMMON_OFFICIAL_MARKETPLACE_NAMES: readonly string[] = [
	'claude-code-marketplace',
	'claude-code-plugins',
	'claude-plugins-official',
	'anthropic-marketplace',
	'anthropic-plugins',
	'agent-skills',
	'anthropic-agent-skills',
	'life-sciences',
	'knowledge-work-plugins',
	'claude-for-legal',
	'claude-for-financial-services',
	'financial-services-plugins',
	'first-party-plugins',
	'claude-tag-plugins',
	'claude-community',
	'claude-plugins-community',
	'healthcare',
]

/** Whether a marketplace name is an official one of the layout, or built to look like one. */
export function isOfficialLookingMarketplaceName(name: string): boolean {
	const lower = name.toLowerCase()
	if (COMMON_OFFICIAL_MARKETPLACE_NAMES.includes(lower)) return true
	return /(^|[-_.])(claude|anthropic)([-_.]|$)/.test(lower)
}
