import { type ReviewMode, isReviewMode } from '@namzu/sdk'

import { PERMISSION_MODE_NAMES, type PermissionModeName } from './mode-names.js'

/**
 * How a turn resolves the calls no rule decided.
 *
 * The `[permissions]` table says what a tool may do. The kernel's review
 * policy (`createReviewHandler` in `@namzu/sdk`) says what happens to
 * everything it did not cover; the modes and their words live there, and
 * this file resolves which one a turn gets from the flag and the terminal.
 *
 * The two axes are separate on purpose: a rule is
 * a durable statement an operator reviewed, and a mode is a property of ONE
 * invocation — the difference between "we never force-push" and "this turn is
 * unattended".
 *
 * ## Precedence between a flag and the config file
 *
 * A mode only governs calls the gate routed to REVIEW. A rule that denied a
 * call already stopped it, and a rule that allowed one never asked, so neither
 * reaches the mode at all. **A mode can therefore never reopen what a rule
 * closed, and `--permission-mode` cannot widen a `deny`.**
 *
 * That direction is deliberate. The config file is written once, read by
 * whoever reviews the repository, and changed on purpose; a flag is typed in a
 * hurry by someone who wants to get on with it. Letting the hurried thing
 * overrule the considered one would make every `deny` in the file advisory, and
 * a prohibition that a flag can lift is not a prohibition. The dangerous-pattern
 * floor sits above both and no mode reaches it either.
 */
export type PermissionMode = ReviewMode

/**
 * The kernel modes a person can choose, in the order the picker lists them.
 *
 * The CLI works in the kernel's mode names inside and the CLI's own words at
 * the edge (`permissionModeFromName`, `permissionModeName`): the word `auto`
 * means the classifier to a person and `classify` to the kernel, while the
 * kernel's `auto` stays what an unattended run uses. The kernel's `auto` is
 * not in this list because nobody picks it.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = [
	'prompt',
	'accept-edits',
	'plan',
	'bypass',
	'classify',
	'strict',
]

const NAME_TO_MODE: Readonly<Record<PermissionModeName, PermissionMode>> = {
	prompt: 'prompt',
	'accept-edits': 'accept-edits',
	plan: 'plan',
	bypass: 'bypass',
	auto: 'classify',
	strict: 'strict',
}

/** The mode a typed name means, or undefined for a word that is not one. */
export function permissionModeFromName(name: unknown): PermissionMode | undefined {
	return typeof name === 'string' && Object.hasOwn(NAME_TO_MODE, name)
		? NAME_TO_MODE[name as PermissionModeName]
		: undefined
}

/** Whether a typed word names a mode a person can choose. */
export function isPermissionModeName(value: unknown): value is PermissionModeName {
	return permissionModeFromName(value) !== undefined
}

/** The word a person uses for a kernel mode. The kernel's `auto` is the unattended default. */
export function permissionModeName(mode: PermissionMode): string {
	switch (mode) {
		case 'classify':
			return 'auto'
		case 'auto':
			return 'unattended'
		default:
			return mode
	}
}

export { ACCEPT_EDITS_TOOLS, PLAN_MODE_REFUSAL } from '@namzu/sdk'

/** Whether a value is a kernel review mode (what the wire between Desktop and the CLI carries). */
export const isPermissionMode: (value: unknown) => value is PermissionMode = isReviewMode

export function permissionModeLabel(mode: PermissionMode): string {
	switch (mode) {
		case 'prompt':
			return 'Ask before changes'
		case 'accept-edits':
			return 'Auto-approve edits'
		case 'plan':
			return 'Plan (read-only)'
		case 'bypass':
			return 'Bypass permissions'
		case 'classify':
			return 'Auto'
		case 'strict':
			return 'Preapproved tools only'
		case 'auto':
			return 'Unattended'
	}
}

/**
 * What Shift+Tab can reach in this session: the two modes that stop asking are
 * opt-in, so each is a door that is open or shut, not a mode in a list.
 */
export interface ModeAvailability {
	readonly bypass: boolean
	readonly auto: boolean
}

/** The cycle with every stop on it. */
export const FULL_AVAILABILITY: ModeAvailability = { bypass: true, auto: true }

/**
 * The mode Shift+Tab moves to. The cycle runs default, accept
 * edits, plan, then bypass and auto when the session may use them, then back
 * to default. `strict` is not on it, and neither is the kernel's unattended
 * `auto`: leaving either goes back to `prompt`.
 */
export function nextCycleMode(
	current: PermissionMode,
	available: ModeAvailability,
): PermissionMode {
	switch (current) {
		case 'prompt':
			return 'accept-edits'
		case 'accept-edits':
			return 'plan'
		case 'plan':
			return available.bypass ? 'bypass' : available.auto ? 'classify' : 'prompt'
		case 'bypass':
			return available.auto ? 'classify' : 'prompt'
		case 'classify':
		case 'strict':
		case 'auto':
			return 'prompt'
	}
}

/**
 * Whether bypass may be entered in this session.
 *
 * A flag that names it (`--yolo`, `--dangerously-skip-permissions`,
 * `--allow-dangerously-skip-permissions`, `--permission-mode bypass`) or the
 * operator's own `permissions.defaultMode: bypass` opens the door; the
 * `permissions.disableBypassMode` setting shuts it for good. The loader has
 * already dropped a project file's `defaultMode: bypass`, so what arrives here
 * is trusted.
 */
export function bypassAvailable(opts: {
	readonly flagged: boolean
	readonly defaultMode?: PermissionModeName | undefined
	readonly disabled?: boolean | undefined
}): boolean {
	if (opts.disabled === true) return false
	return opts.flagged || opts.defaultMode === 'bypass'
}

/** Whether auto may be entered: on unless switched off, and only with a model to ask. */
export function autoAvailable(opts: {
	readonly disabled?: boolean | undefined
	readonly classifierUsable: boolean
}): boolean {
	return opts.disabled !== true && opts.classifierUsable
}

/** The behavior shown by both the permission selector and the session report. */
export function permissionModeDescription(mode: PermissionMode): string {
	switch (mode) {
		case 'prompt':
			return 'Ask before changes and shell commands.'
		case 'accept-edits':
			return 'Allow file edits and simple file commands in your folders; ask before anything else.'
		case 'plan':
			return 'Read-only: block changes until you leave plan mode.'
		case 'bypass':
			return 'Run everything without asking, except what always needs you: removing a home or top-level directory, leaving the sandbox, and anything your rules say to ask about.'
		case 'classify':
			return 'A second model checks each call you would be asked about, and blocks the risky ones.'
		case 'strict':
			return 'Allow preapproved tools; refuse other calls without asking.'
		case 'auto':
			return 'No one is asked: routine calls run and anything out of bounds is refused.'
	}
}

/** The reason a typed name is not a mode, naming the ones that are. */
export function unknownPermissionModeMessage(flag: string): string {
	return `--permission-mode must be one of: ${PERMISSION_MODE_NAMES.join(', ')} (got "${flag}")`
}

/**
 * The mode for a turn, from the flag, the bypass alias, and whether anyone is
 * there to answer.
 *
 * `--yolo` and `--dangerously-skip-permissions` mean `bypass`. A rule that
 * denies, a rule that asks, the dangerous-pattern floor and the few things no
 * mode may approve in advance still hold; everything else runs without a
 * question, including a path outside the folder and a program the line does
 * not name.
 *
 * With nobody to ask and no flag the kernel's unattended `auto` applies: it
 * approves routine calls and refuses whatever would have been a question.
 */
export function resolvePermissionMode(opts: {
	readonly flag?: string | null
	readonly skipPermissions?: boolean
	readonly interactive: boolean
}): { mode: PermissionMode } | { error: string } {
	if (opts.flag != null && opts.flag !== '') {
		const mode = permissionModeFromName(opts.flag)
		if (mode === undefined) return { error: unknownPermissionModeMessage(opts.flag) }
		return { mode }
	}
	if (opts.skipPermissions) return { mode: 'bypass' }
	// No terminal means nobody to ask, so `prompt` would silently become `auto`
	// anyway. Saying so here keeps the resolved mode honest in a log.
	return { mode: opts.interactive ? 'prompt' : 'auto' }
}
