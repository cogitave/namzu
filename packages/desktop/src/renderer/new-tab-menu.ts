/** What the tab strip's + button offers on right-click, Shift+F10 or the context-menu key. */
export type NewTabActionId =
	| 'conversation'
	| 'terminal'
	| 'conversation-right'
	| 'conversation-below'
	| 'terminal-right'
	| 'terminal-below'
	| 'window'

export type NewTabPlacement = 'right' | 'bottom' | 'window'

export type NewTabIconId = 'plus' | 'terminal' | 'right' | 'below' | 'window'

export interface NewTabEntry {
	id: NewTabActionId
	label: string
	icon: NewTabIconId
	/** Why the entry is unavailable; present means shown disabled. */
	reason?: string
}

export interface NewTabMenuInput {
	/** Absent when terminals work here. */
	terminalReason?: string
	/** Absent when a conversation can start here. */
	conversationReason?: string
	/** Absent when a tab can leave for a window of its own. */
	windowReason?: string
}

export function newTabMenuGroups(input: NewTabMenuInput): NewTabEntry[][] {
	const c = input.conversationReason
	const t = input.terminalReason
	return [
		[
			{ id: 'conversation', label: 'New conversation', icon: 'plus', reason: c },
			{ id: 'terminal', label: 'New terminal', icon: 'terminal', reason: t },
		],
		[
			{
				id: 'conversation-right',
				label: 'New conversation to the right',
				icon: 'right',
				reason: c,
			},
			{ id: 'conversation-below', label: 'New conversation below', icon: 'below', reason: c },
			{ id: 'terminal-right', label: 'New terminal to the right', icon: 'right', reason: t },
			{ id: 'terminal-below', label: 'New terminal below', icon: 'below', reason: t },
		],
		[{ id: 'window', label: 'New window', icon: 'window', reason: input.windowReason }],
	]
}

/** The reason terminals are unavailable in this pane, or undefined when they are available. */
export function terminalUnavailableReason(input: {
	bridge: boolean
	project: { trusted?: boolean; status?: string; palId?: string } | undefined
}): string | undefined {
	if (!input.bridge) return 'Terminals are not available in this build.'
	if (!input.project) return 'Open a project to use a terminal.'
	if (input.project.palId) return 'Terminals do not open in a Pal workspace.'
	if (!input.project.trusted) return 'Trust this project to open a terminal.'
	if (input.project.status !== 'ready') return 'The project is not ready yet.'
	return undefined
}
