/**
 * The text a person typed to start a turn, or undefined when something else
 * did. A turn can begin with a user-role message the host wrote itself: the
 * note that a job ended, a peer's mail, a goal round, the prompt a skill flow
 * composes. Only the words the person sent can set a token target such as
 * `+500k`, so those messages must never be read for one.
 */
export function typedInputOf(prompt: {
	readonly kind: string
	readonly text: string
	readonly skillFlow?: true
	readonly recallText?: string
}): string | undefined {
	if (prompt.kind !== 'human' || prompt.skillFlow === true) return undefined
	return prompt.recallText ?? prompt.text
}
