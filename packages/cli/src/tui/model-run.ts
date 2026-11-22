import type { HostCommandModelRun, SerializableHostCommand } from '@namzu/sdk'

/**
 * What the model may do with a slash command when the person asks for it in
 * words. See {@link HostCommandModelRun} for the three classes.
 */
export type ModelRunClass = HostCommandModelRun

/**
 * A command whose class depends on the words that follow it: `/tasks list`
 * reads, `/schedule add ...` changes. `listed` is the class the command is
 * shown under; `of` answers for the form actually typed.
 */
export interface ModelRunByForm {
	readonly listed: ModelRunClass
	of(args: readonly string[]): ModelRunClass
}

export type ModelRunDeclaration = ModelRunClass | ModelRunByForm

export function byForm(
	listed: ModelRunClass,
	of: (args: readonly string[]) => ModelRunClass,
): ModelRunByForm {
	return { listed, of }
}

/** The class of one typed form. A command that declares nothing is `never`. */
export function modelRunOf(
	declaration: ModelRunDeclaration | undefined,
	args: readonly string[],
): ModelRunClass {
	if (declaration === undefined) return 'never'
	return typeof declaration === 'string' ? declaration : declaration.of(args)
}

/** The class a command is listed under. */
export function listedModelRun(declaration: ModelRunDeclaration | undefined): ModelRunClass {
	if (declaration === undefined) return 'never'
	return typeof declaration === 'string' ? declaration : declaration.listed
}

/**
 * Commands that end or replace the conversation, or move it to another model.
 * Run from a reply, they wait until the reply is over: the model must finish
 * its turn on the conversation it started in.
 */
export const AFTER_TURN_COMMANDS: ReadonlySet<string> = new Set([
	'clear',
	'new',
	'resume',
	'abandon',
	'fork',
	'branch',
	'rewind',
	'undo',
	'checkpoint',
	'restore',
	'compact',
	'worktree',
	'model',
])

/** A kernel command's declaration, as the same shape a local command uses. */
export function declarationOf(
	descriptor: Pick<SerializableHostCommand, 'modelRun' | 'modelRunReads'>,
): ModelRunDeclaration {
	const base = descriptor.modelRun ?? 'never'
	const reads = descriptor.modelRunReads
	if (!reads || reads.length === 0 || base === 'run') return base
	return byForm(base, (args) => (reads.includes(args[0] ?? '') ? 'run' : base))
}
