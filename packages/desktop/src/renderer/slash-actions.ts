import type { SlashEntry } from './composer-menu-model.js'

/**
 * The rows of the "/" menu that run today. Every one is something this window already does, so
 * choosing it never starts a reply. A row whose condition does not hold is left out, never greyed:
 * the caller gives a handler only for the rows that can run right now.
 */
export type SlashId =
	| 'btw'
	| 'fork'
	| 'mcp'
	| 'plugins'
	| 'model'
	| 'effort'
	| 'plan'
	| 'permissions'
	| 'rename'
	| 'export'
	| 'diff'
	| 'terminal'
	| 'browser'
	| 'files'
	| 'tasks'
	| 'config'
	| 'theme'
	| 'hooks'
	| 'resume'
	| 'login'
	| 'copy'
	| 'new'
	| 'archive'
	| 'release-notes'

export interface SlashDefinition extends SlashEntry {
	readonly id: SlashId
	/** Hidden on the new-conversation screen, where there is nothing yet to act on. */
	readonly needsConversation: boolean
}

const def = (
	id: SlashId,
	tooltip: string,
	needsConversation: boolean,
	extra: Pick<SlashEntry, 'aliases' | 'argHint'> = {},
): SlashDefinition => ({ id, name: id, tooltip, needsConversation, ...extra })

/** In the order the menu lists them: the conversation first, then panes, then settings, then housekeeping. */
export const SLASH_DEFINITIONS: readonly SlashDefinition[] = [
	def('btw', 'Ask a quick side question without adding to this conversation', true, {
		aliases: ['side'],
	}),
	def('fork', 'Fork this conversation into a new one', true),
	def('mcp', "See this project's tool servers", false, { aliases: ['tools'] }),
	def('plugins', 'See and switch plugins', false),
	def('model', 'Choose the model for the next message', false),
	def('effort', 'Choose how long the model thinks', false, {
		argHint: '[low, medium, high, extra, max, default]',
	}),
	def('plan', 'Switch to plan mode: Namzu reads and plans, nothing changes', false, {
		argHint: '[what to plan]',
	}),
	def('permissions', 'Choose when Namzu checks with you', false, { aliases: ['mode'] }),
	def('rename', 'Rename this conversation', true, { aliases: ['name'], argHint: '[new title]' }),
	def('export', 'Copy this conversation as Markdown', true),
	def('diff', "Show or hide this conversation's changes", true, { aliases: ['changes'] }),
	def('terminal', 'Show or hide a terminal in this folder', true),
	def('browser', 'Show or hide the browser', true),
	def('files', "Show or hide the project's files", true),
	def('tasks', 'See what is running in the background', true, { aliases: ['bashes'] }),
	def('config', 'Open Settings', false, { aliases: ['settings'] }),
	def('theme', 'Choose light, dark or follow the system', false),
	def('hooks', 'See what runs by itself in this folder', false),
	def('resume', 'Find an earlier conversation', false),
	def('login', 'Connect a provider or sign in', false),
	def('copy', 'Copy the latest reply', true),
	def('new', 'Start a new conversation', false, { aliases: ['clear'] }),
	def('archive', 'Archive this conversation', true),
	def('release-notes', 'See what changed in this version', false),
]

/**
 * What a row does with the text after its name. A string it returns goes back in the box (the
 * rest of a "/plan ..." line is for the person to send); nothing returned empties the box.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: a handler that has nothing to give back returns nothing.
export type SlashHandler = (argument: string) => string | undefined | void

export type SlashHandlers = Partial<Record<SlashId, SlashHandler>>

export interface SlashRow extends SlashDefinition {
	readonly run: SlashHandler
}

/**
 * The rows to list: those that have a handler, and on the new-conversation screen only those that
 * need no conversation.
 */
export function slashRows(
	handlers: SlashHandlers,
	options: { newConversation: boolean },
): SlashRow[] {
	const rows: SlashRow[] = []
	for (const definition of SLASH_DEFINITIONS) {
		const run = handlers[definition.id]
		if (!run) continue
		if (options.newConversation && definition.needsConversation) continue
		rows.push({ ...definition, run })
	}
	return rows
}

/** True when the new-conversation screen has rows it left out, so the menu says more come later. */
export function slashRowsHeldBack(handlers: SlashHandlers, newConversation: boolean): boolean {
	return (
		newConversation &&
		SLASH_DEFINITIONS.some((definition) => definition.needsConversation && handlers[definition.id])
	)
}
