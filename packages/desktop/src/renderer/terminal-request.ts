import type { ReasoningEffort, ReviewMode } from '@namzu/sdk'
import type { TerminalEngine } from '../shared/terminal-tabs.js'
import type { TerminalOpenRequest } from '../shared/terminal-view.js'

/** What the composer shows when "CLI" is chosen and the person sends. */
export interface ComposerTerminalChoices {
	engine: TerminalEngine
	projectId: string
	groupId: string
	/** The composer's provider and model. */
	provider?: string
	model?: string
	/** The model is "the engine's own default", not a pick: an installed engine's CLI then chooses itself. */
	modelIsDefault?: boolean
	effort?: ReasoningEffort
	permissionMode?: ReviewMode
	/** The composer's text. */
	draft: string
}

/** The terminal's initial size; the view fits itself to its pane and tells the host as soon as it is shown. */
export const INITIAL_TERMINAL_SIZE = { cols: 100, rows: 30 } as const

/**
 * The request that opens the engine's own command line with the composer's choices. The Namzu terminal
 * app starts empty (its flags carry the provider, model, effort and mode); an installed engine starts
 * on the message and, unless the model was only the default, the model.
 */
export function engineTerminalRequest(choices: ComposerTerminalChoices): TerminalOpenRequest {
	const namzu = choices.engine === 'namzu'
	const model = !namzu && choices.modelIsDefault ? undefined : choices.model || undefined
	const prompt = namzu ? undefined : choices.draft.trim() || undefined
	return {
		kind: 'engine',
		engine: choices.engine,
		projectId: choices.projectId,
		groupId: choices.groupId,
		...INITIAL_TERMINAL_SIZE,
		...(namzu && choices.provider ? { provider: choices.provider } : {}),
		...(model ? { model } : {}),
		...(choices.effort ? { effort: choices.effort } : {}),
		permissionMode: choices.permissionMode ?? 'prompt',
		...(prompt ? { prompt } : {}),
	}
}

export function shellTerminalRequest(projectId: string, groupId: string): TerminalOpenRequest {
	return { kind: 'shell', projectId, groupId, ...INITIAL_TERMINAL_SIZE }
}
