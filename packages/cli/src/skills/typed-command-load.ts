/**
 * The steps that turn a command the person typed into the text that goes on,
 * in the order that keeps a refusal free of side effects:
 *
 * 1. `user_prompt_expansion` hooks are asked first, so a hook that blocks the
 *    expansion leaves nothing run;
 * 2. the hooks the skill carries are attached, so its own `pre_tool_use` and
 *    `pre_skill_shell_command` entries guard its own commands;
 * 3. the shell commands the text holds run.
 *
 * A load that fails takes the skill's hooks off again: they stay only for a
 * command whose text went on.
 */

export interface TypedCommandLoad {
	/** Ask the `user_prompt_expansion` hooks; absent when no hook is asked. */
	readonly expansion?: () => Promise<{ readonly blocked?: string; readonly context?: string }>
	/** Attach the skill's own hooks, before its commands run; the handle takes them off. */
	readonly attachHooks?: () => { readonly remove: () => void } | undefined
	/** Run the text's shell commands; absent when it holds none to run. */
	readonly expand?: () => Promise<string>
}

export type TypedCommandLoadResult =
	| { readonly kind: 'blocked'; readonly reason: string }
	| { readonly kind: 'failed'; readonly error: unknown }
	| {
			readonly kind: 'loaded'
			/** The text with its commands' output in place; absent when none ran. */
			readonly text?: string
			/** What the expansion hooks want the model to read beside the prompt. */
			readonly context?: string
			/** The skill's own hooks attached for the load; take them off if the line is never sent. */
			readonly hooks?: { readonly remove: () => void }
	  }

export async function loadTypedCommand(load: TypedCommandLoad): Promise<TypedCommandLoadResult> {
	let context: string | undefined
	if (load.expansion) {
		const verdict = await load
			.expansion()
			.catch(() => ({}) as { blocked?: string; context?: string })
		if (verdict.blocked !== undefined) return { kind: 'blocked', reason: verdict.blocked }
		context = verdict.context
	}
	let text: string | undefined
	let attached: { readonly remove: () => void } | undefined
	if (load.expand) {
		attached = load.attachHooks?.()
		try {
			text = await load.expand()
		} catch (error) {
			attached?.remove()
			return { kind: 'failed', error }
		}
	}
	return {
		kind: 'loaded',
		...(text !== undefined ? { text } : {}),
		...(context !== undefined ? { context } : {}),
		...(attached ? { hooks: attached } : {}),
	}
}
