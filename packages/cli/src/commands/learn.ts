import { runLearningCommand } from './learning.js'
import type { CommandDef } from './types.js'

/**
 * Learning is a feature of the whole kernel, not of residents. These two
 * commands are the front door; `namzu resident learn` and
 * `namzu resident learning` stay as the same thing under their old names.
 */
export const learnCommand: CommandDef = {
	name: 'learn',
	description: 'Learn from what conversations kept, now; list or undo what was learned',
	passThrough: true,
	help: [
		'Usage: namzu learn [--cwd <path>]',
		'       namzu learn --list [--cwd <path>]',
		'       namzu learn --undo [cycle-id] [--cwd <path>]',
		'       namzu learn <experiment.learning.js> [--trust] [--sessions] [--cwd <path>] [--agent <name>]',
		'',
		'Namzu learns from the failures and recoveries conversations in this folder',
		'kept, by itself and in the background of the terminal, unless',
		'`learningGenerator: false` is set. With no module, this command runs one',
		"cycle now: it proposes a revision of this folder's guidance, checks it with",
		'paired verification and a fresh confirmation round, and activates it only if',
		'both pass. `--list` shows what was learned and which revision is active;',
		'`--undo` restores the guidance an activation replaced.',
		'',
		'With a module, run one learning experiment from a host module you chose. The module',
		'supplies how a candidate is made and how it is judged; Namzu runs the',
		'independent check, asks you to confirm, and activates only the exact',
		'revision that passed. Nothing is started in the background.',
		'',
		'Without --sessions an agent must already exist in the folder (`namzu resident',
		"add`): the result becomes that agent's saved guidance. Failures an ordinary",
		'conversation hits are kept as local observations (turn off with',
		'`learningObservations: false`). With --sessions the experiment starts from',
		"those observations and a confirmed result becomes this project's guidance,",
		'which later conversations here start with; no resident is needed.',
		'`namzu learning --sessions` lists what was kept.',
		'',
		'  --list          List what Namzu learned for this folder (no module)',
		'  --undo [id]     Restore the guidance an activation replaced (no module)',
		"  --sessions      Learn from this folder's conversations, into its project guidance",
		'  --trust         Allow the module to run in this folder',
		'  --cwd <path>    Work in another folder',
		'  --agent <name>  The agent whose guidance this changes (default: default)',
		'',
		'Exit: 0 done, 64 invalid arguments, 77 untrusted execution.',
	].join('\n'),
	handler: ({ ctx, rawArgs }) => runLearningCommand({ ctx, rawArgs: ['learn', ...rawArgs] }),
}

export const learningCommand: CommandDef = {
	name: 'learning',
	description: 'Inspect learning experiments and the observations they start from',
	passThrough: true,
	help: [
		'Usage: namzu learning [cycle-id] [--events] [--after <n>] [--before <n>] [--limit <n>]',
		'       namzu learning --observations [--after <n>] [--limit <n>]',
		'       namzu learning --sessions [--after <n>] [--limit <n>]',
		'',
		'List experiments, show one with its events, or list the failures and',
		'recoveries that were kept as observations. Read-only. `--observations` reads a',
		"resident's; `--sessions` reads what conversations kept and needs no resident.",
		'',
		'  --cwd <path>    Look in another folder',
		'  --agent <name>  The agent whose records to read (default: default)',
	].join('\n'),
	handler: ({ ctx, rawArgs }) => runLearningCommand({ ctx, rawArgs: ['learning', ...rawArgs] }),
}
