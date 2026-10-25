/**
 * What a slash command typed while an agent is on screen does.
 *
 * The composer is the conversation's, and it stays live while an agent is
 * viewed, so a command typed there could mean the agent or the conversation.
 * Each command settles it on its own when the prompt is submitted:
 *
 * - a command the host answers itself (every built-in
 *   here) is never sent to the agent. Most simply run against the
 *   conversation, as they do with no agent open;
 * - `model` and `fast` only say they would change the conversation's, not the
 *   agent's, and do nothing;
 * - `compact`, `clear` (and its alias `new`) and `rewind` act on the conversation's history, so they ask first
 *   and name that;
 * - anything else that starts with `/` (a skill, a custom command, a typo) is
 *   text for the agent like any other line.
 */

export type AgentViewCommandClass =
	| {
			/** Nothing runs; the notice says why. */
			readonly kind: 'block'
			readonly notice: string
	  }
	| {
			/** Asks, then runs against the conversation. */
			readonly kind: 'confirm'
			readonly title: string
			readonly confirmLabel: string
	  }

/**
 * How the named built-in command is treated while an agent is viewed, or
 * `undefined` when it simply runs against the conversation.
 */
export function agentViewCommandClass(name: string): AgentViewCommandClass | undefined {
	switch (name) {
		case 'model':
		case 'fast':
			return {
				kind: 'block',
				notice: `/${name} changes the main conversation's ${name === 'model' ? 'model' : 'fast mode'}, not this agent's`,
			}
		case 'compact':
		case 'clear':
		case 'new':
		case 'rewind':
		case 'undo':
		case 'checkpoint':
			return {
				kind: 'confirm',
				title: `/${name} acts on the main conversation, not this agent`,
				confirmLabel: `Run /${name} on the main conversation`,
			}
		default:
			return undefined
	}
}
