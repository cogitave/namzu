export {
	SKILL_FRONTMATTER_KEYS,
	SKILL_FRONTMATTER_RAW_KEYS,
	SKILL_FRONTMATTER_TOLERATED_KEYS,
	SKILL_FRONTMATTER_HOOK_EVENT_KEYS,
	skillHooksSource,
	loadSkill,
	parseSkillMarkdown,
	discoverSkills,
} from './loader.js'
export { SkillCollisionError, SkillRegistry, resolveSkillChain } from './registry.js'
export {
	INLINE_SHELL_COMMAND_SHOWN_CHARS,
	INLINE_SHELL_MAX_COMMANDS,
	INLINE_SHELL_MAX_COMMAND_CHARS,
	INLINE_SHELL_MAX_OUTPUT_CHARS,
	INLINE_SHELL_REASON_CHARS,
	InlineShellError,
	SHELL_OFF_PLACEHOLDER,
	SHELL_PRELOAD_PLACEHOLDER,
	SHELL_REMOTE_PLACEHOLDER,
	SHELL_UNTRUSTED_PLACEHOLDER,
	escapeInlineShell,
	expandInlineShell,
	findInlineShell,
	normalizeInlineShellText,
	shapeShellOutput,
	splitShellToolOutput,
	substituteEscaped,
} from './inline-shell.js'
export type {
	InlineShellBlock,
	InlineShellHookVerdict,
	InlineShellHost,
	InlineShellKind,
	InlineShellMarker,
	InlineShellOptions,
	InlineShellOutcome,
} from './inline-shell.js'
export {
	PRE_SKILL_SHELL_COMMAND_EVENT,
	SKILL_SHELL_TOOL_NAME,
	createPreToolUseShellHook,
	createSkillShellHook,
	createToolSkillShellHost,
	outcomeOf as skillShellOutcomeOf,
	skillShellAllow,
	skillShellHookVerdict,
} from './inline-shell-host.js'
export type {
	SkillShellHookOptions,
	ToolSkillShellHostOptions,
} from './inline-shell-host.js'
