// The words a person types for a mode: `--permission-mode`, `/permissions
// <mode>` and the `permissions.defaultMode` setting. They are the CLI's
// vocabulary, not the kernel's: `auto` here is the kernel's `classify` and
// `bypass` its `bypass`, while the kernel's own `auto` (approve whatever no
// escalation stopped) is what unattended runs use and has no name here.
//
// The root command lists them as `--permission-mode` choices. `mode.ts` maps
// them to the SDK's review modes, which loads the whole runtime; this file has
// no runtime import, and `permissions/__tests__/mode-names.test.ts` fails when
// the two disagree.

export const PERMISSION_MODE_NAMES = [
	'prompt',
	'accept-edits',
	'plan',
	'bypass',
	'auto',
	'strict',
] as const

export type PermissionModeName = (typeof PERMISSION_MODE_NAMES)[number]
