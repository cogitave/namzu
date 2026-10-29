import type { PermissionMode } from './mode.js'

/**
 * The mode a delegated agent runs under when its agent file names one.
 *
 * A file may only narrow. The modes that already ask less than the file's, or
 * that the operator chose on purpose for this conversation, win over it:
 *
 * - a parent in accept-edits, plan, auto or bypass keeps its own mode in the
 *   child, so a file cannot pull a child out of plan mode or back to asking;
 * - a parent in strict (nothing outside the rules runs) keeps it, so a file
 *   cannot widen it either;
 * - a file asking for bypass or auto is not granted either: bypass would need
 *   the parent to be in it already (then the parent's mode is the answer), and
 *   whether the classifier is usable is a fact about the live session that a
 *   file cannot assert. The child keeps the parent's mode.
 *
 * What is left is a parent that asks before changes: its child may run in
 * accept-edits, plan, or the same ask-first mode.
 */
export function delegatedAgentMode(input: {
	readonly parent: PermissionMode
	/** The file's `permissionMode:` word, in the CLI's vocabulary, or `inherit`. */
	readonly declared: string | undefined
}): PermissionMode {
	const { parent, declared } = input
	if (parent !== 'prompt') return parent
	switch (declared) {
		case 'accept-edits':
			return 'accept-edits'
		case 'plan':
			return 'plan'
		default:
			return parent
	}
}
