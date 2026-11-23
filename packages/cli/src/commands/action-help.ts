/**
 * Help for one action of a command area: `namzu schedule add --help`,
 * `namzu help schedule service install`.
 *
 * A command module with actions declares one table of them. The registry
 * answers `--help` from it before the handler runs, so no module parses help
 * words itself and the area's own parsing stays as it is.
 */

export interface ActionFlag {
	/** The flag as a person types it, with its value: `--when <spec>` or `-s, --scope <user|project>`. */
	readonly flag: string
	readonly description: string
}

export interface ActionHelp {
	/** The words that name the action: `['add']`, or `['service', 'install']`. */
	readonly path: readonly string[]
	/** Operands after the words: `<job>`, `[path]`. */
	readonly operands?: string
	/** One sentence. */
	readonly summary: string
	readonly flags?: readonly ActionFlag[]
	/** One complete command line, starting with `namzu`. */
	readonly example: string
}

const HELP_FLAG: ActionFlag = { flag: '-h, --help', description: 'Show this help.' }

/** The flag names (`--when`, `-s`) a declared flag string spells. */
export function flagNames(flag: string): string[] {
	return [...flag.matchAll(/(?:^|[\s,|])(--?[A-Za-z][\w-]*)/g)].map((m) => m[1] as string)
}

function usageLine(area: string, action: ActionHelp): string {
	const words = [`namzu ${area}`, ...action.path]
	if (action.operands) words.push(action.operands)
	if (action.flags && action.flags.length > 0) words.push('[options]')
	return words.join(' ')
}

/** The help for one action: usage, what it does, its flags, one example. */
export function renderActionHelp(area: string, action: ActionHelp): string {
	const rows = [...(action.flags ?? []), HELP_FLAG]
	const width = Math.max(...rows.map((r) => r.flag.length))
	return [
		usageLine(area, action),
		'',
		action.summary,
		'',
		'Options:',
		...rows.map((r) => `  ${r.flag.padEnd(width)}  ${r.description}`),
		'',
		'Example:',
		`  ${action.example}`,
		'',
		`namzu ${area} --help lists every ${area} command.`,
	].join('\n')
}

function listing(rows: readonly (readonly [string, string])[]): string[] {
	const width = Math.max(...rows.map(([head]) => head.length))
	return rows.map(([head, text]) => `  ${head.padEnd(width)}  ${text}`)
}

/** One line per action, for the end of an area's own help. */
export function renderActionIndex(area: string, actions: readonly ActionHelp[]): string {
	const rows = actions.map((a): [string, string] => [
		[...a.path, ...(a.operands ? [a.operands] : [])].join(' '),
		a.summary,
	])
	return ['Actions:', ...listing(rows), '', `namzu ${area} <action> --help for details.`].join('\n')
}

/** The actions under a group word (`service`), for `namzu schedule service --help`. */
function renderGroup(area: string, group: string, actions: readonly ActionHelp[]): string {
	const rows = actions
		.filter((a) => a.path.length > 1 && a.path[0] === group)
		.map((a): [string, string] => [
			[...a.path.slice(1), ...(a.operands ? [a.operands] : [])].join(' '),
			a.summary,
		])
	return [
		`namzu ${area} ${group} <action>`,
		'',
		'Actions:',
		...listing(rows),
		'',
		`namzu ${area} ${group} <action> --help for details.`,
	].join('\n')
}

/**
 * The help for the words before the first flag of `args`: the action whose
 * path is the longest match, a group's listing when they stop at a group word,
 * or undefined when they name no action (the area's help answers then).
 */
export function resolveActionHelp(
	area: string,
	actions: readonly ActionHelp[],
	args: readonly string[],
): string | undefined {
	const words: string[] = []
	for (const arg of args) {
		if (arg.startsWith('-')) break
		words.push(arg)
	}
	let best: ActionHelp | undefined
	for (const action of actions) {
		const fits = action.path.every((word, i) => words[i] === word)
		if (fits && (best === undefined || action.path.length > best.path.length)) best = action
	}
	if (best !== undefined) return renderActionHelp(area, best)
	const group = words[0]
	if (group !== undefined && actions.some((a) => a.path.length > 1 && a.path[0] === group)) {
		return renderGroup(area, group, actions)
	}
	return undefined
}
