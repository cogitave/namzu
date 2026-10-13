import type { ReviewMode } from '@namzu/sdk'

// The root command lists these as `--permission-mode` choices. `mode.ts` takes
// them from the SDK's `REVIEW_MODES`, which loads the whole runtime; this copy
// has only a type import, and `permissions/__tests__/mode-names.test.ts` fails
// when the two lists differ.

export const PERMISSION_MODE_NAMES = [
	'prompt',
	'accept-edits',
	'auto',
	'strict',
	'plan',
] as const satisfies readonly ReviewMode[]
