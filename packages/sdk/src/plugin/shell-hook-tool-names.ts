/**
 * The names a shell hook may be sent for a tool.
 *
 * A hook sees the tool's own name (`bash`, `web_fetch`) unless its entry asks
 * for the written one (`toolNames: 'written'`), the capitalised name a person
 * writes in a matcher for that tool (`Bash`, `WebFetch`). An entry read from
 * the common hook contract asks for it by default.
 *
 * ONE table, from the name a tool is registered under to its written name.
 * A tool with no common name is not in it and keeps its own; a tool-server
 * tool (`mcp__<server>__<tool>`) is never in it. The table is documented in
 * `docs/sdk/hooks.md`, and a test holds the two equal.
 */

/** Which spelling of a tool's name an entry receives. */
export type ShellHookToolNames = 'namzu' | 'written'

/** Our tool name to the name written for it. Every key is lower case. */
export const SHELL_HOOK_WRITTEN_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
	Agent: 'Agent',
	ask_user_question: 'AskUserQuestion',
	bash: 'Bash',
	edit: 'Edit',
	glob: 'Glob',
	grep: 'Grep',
	ls: 'LS',
	lsp: 'LSP',
	monitor: 'Monitor',
	read: 'Read',
	search_tools: 'ToolSearch',
	skill: 'Skill',
	task_create: 'TaskCreate',
	task_list: 'TaskList',
	task_update: 'TaskUpdate',
	web_fetch: 'WebFetch',
	web_search: 'WebSearch',
	write: 'Write',
})

/** The name a hook is sent for `toolName` under the entry's `toolNames`. */
export function shellHookToolName(toolName: string, mode: ShellHookToolNames | undefined): string {
	if (mode !== 'written') return toolName
	return Object.hasOwn(SHELL_HOOK_WRITTEN_TOOL_NAMES, toolName)
		? (SHELL_HOOK_WRITTEN_TOOL_NAMES[toolName] as string)
		: toolName
}
