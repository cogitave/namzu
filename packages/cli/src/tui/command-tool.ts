import { type ToolDefinition, defineTool, mcpJsonSchemaToZod } from '@namzu/sdk'

import {
	AFTER_TURN_COMMANDS,
	type ModelRunClass,
	type ModelRunDeclaration,
	listedModelRun,
	modelRunOf,
} from './model-run.js'
import { parseSlash } from './slash-parse.js'

/** The tool's name, as the model calls it and as the approval box recognises it. */
export const COMMAND_TOOL_NAME = 'command'

/**
 * How many characters the listing in the tool description may use. A fixed
 * cap rather than a share of the window: the list is short, and it rides every
 * request of a small-window model.
 */
export const COMMAND_LISTING_BUDGET = 1536

/** A cap on what the `list` action answers with. */
const COMMAND_LIST_ACTION_LIMIT = 6000

/** What the tool result says a command printed, at most. */
const COMMAND_OUTPUT_LIMIT = 400

export interface CommandCatalogueEntry {
	readonly name: string
	readonly description: string
	readonly modelRun?: ModelRunDeclaration
	/** Where the command comes from. Only built-in commands are offered to the model. */
	readonly source: 'builtin' | 'user'
	/** Left out of every listing; still answered when named. */
	readonly hidden?: boolean
}

export type CommandRunOutcome =
	| { readonly kind: 'ran'; readonly output?: string }
	| { readonly kind: 'queued' }
	| { readonly kind: 'refused'; readonly reason: string }

/** What the interactive terminal gives the tool; the tool never reaches into the TUI itself. */
export interface CommandToolHost {
	/** The commands the model is told about; built from the registry, never typed by hand. */
	readonly catalogue: readonly CommandCatalogueEntry[]
	/** Why the command cannot run in this conversation right now, or `undefined`. */
	unavailable?(name: string, args: readonly string[]): string | undefined
	/**
	 * Run one normalised line through the same dispatch typed input takes and
	 * show its output to the person as if they had typed it. `deferred` asks for
	 * the line to wait until the current turn has finished.
	 */
	run(
		line: string,
		options: { readonly deferred: boolean; readonly signal?: AbortSignal },
	): Promise<CommandRunOutcome>
}

/** The words of a call, as one line a person could type. */
export function commandLineOf(name: string, args: readonly string[] = []): string {
	const words = [name, ...args]
		.join(' ')
		.split(/\s+/u)
		.filter((word) => word.length > 0)
	if (words[0]?.startsWith('/')) words[0] = words[0].slice(1)
	return `/${words.join(' ')}`
}

export interface ResolvedCommand {
	readonly entry: CommandCatalogueEntry
	readonly name: string
	readonly args: readonly string[]
	readonly line: string
	readonly modelRun: ModelRunClass
}

export function resolveCommand(
	catalogue: readonly CommandCatalogueEntry[],
	name: string,
	args: readonly string[] = [],
): ResolvedCommand | undefined {
	const line = commandLineOf(name, args)
	const parsed = parseSlash(line)
	if (!parsed) return undefined
	const entry = catalogue.find((candidate) => candidate.name === parsed.name)
	if (!entry) return undefined
	const normalised = `/${[parsed.name, ...parsed.args].join(' ')}`
	return {
		entry,
		name: parsed.name,
		args: parsed.args,
		line: normalised,
		// Only a built-in command is the model's to run at all.
		modelRun: entry.source === 'builtin' ? modelRunOf(entry.modelRun, parsed.args) : 'never',
	}
}

function shorten(text: string, limit: number): string {
	const flat = text.replace(/\s+/gu, ' ').trim()
	const first = flat.split(/(?<=[.:;])\s/u)[0] ?? flat
	const sentence = first.replace(/[.:;]$/u, '')
	if (sentence.length <= limit) return sentence
	if (limit <= 0) return ''
	const cut = sentence.slice(0, limit)
	const space = cut.lastIndexOf(' ')
	return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

function listedEntries(
	catalogue: readonly CommandCatalogueEntry[],
	cls: ModelRunClass,
): CommandCatalogueEntry[] {
	return catalogue.filter(
		(entry) =>
			entry.source === 'builtin' && entry.hidden !== true && listedModelRun(entry.modelRun) === cls,
	)
}

/**
 * Two or three words for a command whose name does not say enough. A command
 * absent here is listed by name alone; `action: "list"` carries every full
 * description. Kept short because the whole listing shares one fixed budget.
 */
const COMMAND_BLURBS: Readonly<Record<string, string>> = {
	rename: 'rename chat',
	vim: 'vim keys',
	tui: 'screen mode',
	doctor: 'health check',
	tasks: 'list background work',
	context: 'context use',
	mcp: 'tool servers',
	copy: 'copy reply',
	raw: 'plain copy mode',
	recap: 'recap',
	btw: 'side question',
	plan: 'plan mode',
	goal: 'set a goal',
	schedule: 'scheduled jobs',
	loop: 'repeat a prompt',
	worktree: 'git worktree',
	rewind: 'undo changes',
	restore: 'restore files',
	memory: 'saved notes',
	skills: 'skill list',
	resume: 'continue reply',
	abandon: 'drop paused reply',
	model: 'switch model',
	review: 'code review',
	compact: 'shrink history',
	run: 'run a command',
	export: 'save chat',
	effort: 'reasoning level',
	hypermode: 'workflow mode',
	fast: 'fast replies',
	ultrafast: 'fastest replies',
	orchestrate: 'old hypermode',
	init: 'write AGENTS.md',
}

const LISTING_HEAD =
	'Runs the person’s Namzu commands when they ask in words, e.g. {name:"goal",args:["write","the","changelog"]}: the command word and its words as typed. Say one ran only after the result says so. Give the form, e.g. tasks list, goal status; a bare /tasks, /goal, /model, /memory or /skills opens a screen and is refused.'

/**
 * The listing the tool description carries, generated from the catalogue so it
 * cannot drift, and held to `budget` characters. Blurbs go first when space is
 * short; then confirm commands are left to the `list` action.
 */
export function renderCommandListing(
	catalogue: readonly CommandCatalogueEntry[],
	budget: number = COMMAND_LISTING_BUDGET,
): string {
	const run = listedEntries(catalogue, 'run')
	const confirm = listedEntries(catalogue, 'confirm')
	const never = listedEntries(catalogue, 'never')
	const neverLine =
		never.length > 0
			? `The person types these themselves; never run them, tell them to: ${never.map((e) => `/${e.name}`).join(' ')}.`
			: ''
	const render = (blurbs: boolean, keepConfirm: number): string => {
		const row = (entry: CommandCatalogueEntry) => {
			const blurb = blurbs ? COMMAND_BLURBS[entry.name] : undefined
			return blurb ? `/${entry.name} (${blurb})` : `/${entry.name}`
		}
		const shown = confirm.slice(0, keepConfirm)
		const more = confirm.length - shown.length
		return [
			LISTING_HEAD,
			run.length > 0 ? `Run at once: ${run.map(row).join(', ')}.` : '',
			shown.length > 0
				? `The person approves each call first: ${shown.map(row).join(', ')}${more > 0 ? `, and ${more} more (action list)` : ''}.`
				: '',
			neverLine,
		]
			.filter((part) => part.length > 0)
			.join('\n')
	}
	for (const blurbs of [true, false]) {
		const text = render(blurbs, confirm.length)
		if (text.length <= budget) return text
	}
	for (let keep = confirm.length - 1; keep >= 0; keep--) {
		const text = render(false, keep)
		if (text.length <= budget) return text
	}
	return render(false, 0).slice(0, budget)
}

/** The full answer to `action: "list"`: every runnable and confirmable command. */
export function renderCommandList(catalogue: readonly CommandCatalogueEntry[]): string {
	const lines = (cls: ModelRunClass) =>
		listedEntries(catalogue, cls).map(
			(entry) => `/${entry.name} - ${shorten(entry.description, 90)}`,
		)
	const never = listedEntries(catalogue, 'never').map((entry) => `/${entry.name}`)
	const text = [
		'Run at once:',
		...lines('run'),
		'',
		'The person approves each call first:',
		...lines('confirm'),
		'',
		`The person types these themselves: ${never.join(' ')}.`,
		'A command can read freely and still ask before it changes something; for example /tasks list runs, /schedule add asks.',
	].join('\n')
	return text.length <= COMMAND_LIST_ACTION_LIMIT
		? text
		: `${text.slice(0, COMMAND_LIST_ACTION_LIMIT)}…`
}

interface CommandInput {
	readonly action?: 'run' | 'list'
	readonly name?: string
	readonly args?: readonly string[]
}

/**
 * The one tool through which the model runs the person's Namzu commands.
 *
 * A command is classified by what it does (`modelRun`): `run` goes ahead,
 * `confirm` asks the person through the per-call approval, `never` is refused
 * here without asking. Mounted only in the main interactive session.
 */
export function buildCommandTool(
	host: CommandToolHost,
	catalogue: readonly CommandCatalogueEntry[] = host.catalogue,
): ToolDefinition {
	const resolve = (input: CommandInput) =>
		input.name ? resolveCommand(catalogue, input.name, input.args ?? []) : undefined
	const unavailable = (input: CommandInput): string | undefined => {
		const resolved = resolve(input)
		return resolved ? host.unavailable?.(resolved.name, resolved.args) : undefined
	}
	return defineTool({
		name: COMMAND_TOOL_NAME,
		description: renderCommandListing(catalogue),
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['run', 'list'],
					description: 'run (default) runs a command; list answers with every command you may run.',
				},
				name: {
					type: 'string',
					maxLength: 64,
					description: 'The command word without the slash, for example goal.',
				},
				args: {
					type: 'array',
					maxItems: 400,
					items: { type: 'string', maxLength: 2000 },
					description: 'The words after the command, as the person would type them.',
				},
			},
			additionalProperties: false,
		}),
		category: 'custom',
		permissions: [],
		// Only a call that goes on to change something is not read-only. One that
		// is refused, or cannot run here, does nothing, so it is not asked about.
		readOnly: (input) => {
			const typed = input as CommandInput
			if (typed.action === 'list') return true
			return resolve(typed)?.modelRun !== 'confirm' || unavailable(typed) !== undefined
		},
		destructive: false,
		concurrencySafe: false,
		// Asks for a `confirm` command, every time, whatever a standing allow says.
		// A command that cannot run here, or that is refused, asks nothing.
		requiresApproval: (input) => {
			const typed = input as CommandInput
			if (typed.action === 'list') return false
			return resolve(typed)?.modelRun === 'confirm' && unavailable(typed) === undefined
		},
		classifierInput: (input) => {
			const typed = input as CommandInput
			return typed.name ? commandLineOf(typed.name, typed.args ?? []) : 'list commands'
		},
		presentCall: (input) => ({
			kind: 'generic',
			label:
				(input as CommandInput).action === 'list' || !(input as CommandInput).name
					? 'Commands'
					: commandLineOf((input as CommandInput).name ?? '', (input as CommandInput).args ?? []),
		}),
		// The command's own output is already in the transcript, as if typed.
		presentResult: (_input, result) =>
			result.success ? { kind: 'generic', label: result.output, visibility: 'hidden' } : undefined,
		timeoutMs: 15_000,
		async execute(rawInput, context) {
			const input = rawInput as CommandInput
			context.abortSignal?.throwIfAborted()
			if (input.action === 'list') return { success: true, output: renderCommandList(catalogue) }
			if (!input.name || input.name.trim().length === 0) {
				return {
					success: false,
					output: '',
					error:
						'Name a command, for example {name:"goal", args:["write","the","changelog"]}, or use action list.',
				}
			}
			const resolved = resolve(input)
			if (!resolved) {
				return {
					success: false,
					output: '',
					error: `There is no command ${commandLineOf(input.name, input.args ?? [])}. Commands are keywords exactly as typed (no hyphens or aliases); use action list to see them. Skills are used with the skill tool.`,
				}
			}
			if (resolved.modelRun === 'never') {
				return {
					success: false,
					output: '',
					error: `${resolved.line} is for the person to run. Do not run it and do not claim it ran. Ask the person to type ${resolved.line} themselves.`,
				}
			}
			const reason = host.unavailable?.(resolved.name, resolved.args)
			if (reason) {
				return {
					success: false,
					output: '',
					error: `${resolved.line} cannot run now: ${reason} Nothing changed.`,
				}
			}
			let outcome: CommandRunOutcome
			try {
				outcome = await host.run(resolved.line, {
					deferred: AFTER_TURN_COMMANDS.has(resolved.name),
					...(context.abortSignal ? { signal: context.abortSignal } : {}),
				})
			} catch {
				context.abortSignal?.throwIfAborted()
				return {
					success: false,
					output: '',
					error: `${resolved.line} could not be run. Nothing is known to have changed; do not say it ran.`,
				}
			}
			if (outcome.kind === 'refused') {
				return {
					success: false,
					output: '',
					error: `${resolved.line} was not run: ${outcome.reason}`,
				}
			}
			if (outcome.kind === 'queued') {
				return {
					success: true,
					output: `Queued ${resolved.line}. It runs when this turn ends, not now; do not describe its effect as done.`,
					data: { status: 'queued', command: resolved.line },
				}
			}
			const printed = outcome.output?.trim()
			return {
				success: true,
				output: printed
					? `Ran ${resolved.line}. It showed the person: ${printed.length > COMMAND_OUTPUT_LIMIT ? `${printed.slice(0, COMMAND_OUTPUT_LIMIT)}…` : printed}`
					: `${resolved.line} finished and printed nothing, so it may not have changed anything (the person may have declined its question). Do not say it did what it was for; check with a read form first.`,
				data: { status: printed ? 'ran' : 'no-output', command: resolved.line },
			}
		},
	})
}
