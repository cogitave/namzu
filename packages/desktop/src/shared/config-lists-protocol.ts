/**
 * What Settings reads and writes for the rows that are lists of things the engine knows about:
 * the installed skills, and the tool servers in the person's own config file. The engine answers
 * these over its own methods; every reader here accepts only the shape it expects and drops the
 * rest, so an answer from another version never reaches a screen as it came.
 */

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

const short = (value: unknown, max: number): string | undefined =>
	typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined

/** One installed skill: its name and where it lives, in the person's words. Nothing else. */
export interface InstalledSkillView {
	name: string
	where: string
}

export interface InstalledSkillsView {
	skills: InstalledSkillView[]
}

export function readInstalledSkills(value: unknown): InstalledSkillsView {
	const list = record(value)?.skills
	const skills: InstalledSkillView[] = []
	if (Array.isArray(list))
		for (const item of list.slice(0, 500)) {
			const row = record(item)
			const name = short(row?.name, 200)
			const where = short(row?.where, 200)
			if (name && where && !skills.some((s) => s.name === name)) skills.push({ name, where })
		}
	return { skills }
}

/** A tool server in the user's file: what the form edits. Variables and headers are never here. */
export interface UserMcpServerView {
	name: string
	/** `other` is an entry the form cannot read; it is edited in the file. */
	kind: 'command' | 'address' | 'other'
	command?: string
	args?: string[]
	url?: string
	/** In the list, only how many arguments and the origin of an address; the entry is read whole to edit. */
	argCount?: number
	origin?: string
}

export interface UserMcpServersView {
	file: string
	servers: UserMcpServerView[]
}

export function readUserMcpServersView(value: unknown): UserMcpServersView {
	const answer = record(value)
	const servers: UserMcpServerView[] = []
	if (Array.isArray(answer?.servers))
		for (const item of answer.servers.slice(0, 500)) {
			const row = record(item)
			const name = short(row?.name, 64)
			if (!name || !row) continue
			const kind = row.kind === 'command' || row.kind === 'address' ? row.kind : 'other'
			const command = short(row.command, 2000)
			const url = short(row.url, 2000)
			const args =
				Array.isArray(row.args) && row.args.every((arg) => typeof arg === 'string')
					? (row.args as string[]).slice(0, 200)
					: undefined
			servers.push({
				name,
				kind,
				...(kind === 'command' && command ? { command } : {}),
				...(kind === 'command' && args && args.length > 0 ? { args } : {}),
				...(kind === 'address' && url ? { url } : {}),
				...(kind === 'command' && typeof row.argCount === 'number' && row.argCount > 0
					? { argCount: Math.min(Math.floor(row.argCount), 200) }
					: {}),
				...(kind === 'address' && short(row.origin, 2000)
					? { origin: short(row.origin, 2000) }
					: {}),
			})
		}
	return { file: typeof answer?.file === 'string' ? answer.file : '', servers }
}

/** A person's input for one tool server: a command with arguments, or an address. */
export interface UserMcpServerChange {
	mode: 'add' | 'edit'
	name: string
	command?: string
	args?: string[]
	url?: string
}

export type UserMcpServerResult =
	| { status: 'saved'; view: UserMcpServersView }
	| { status: 'confirm'; view: UserMcpServersView; token: string; message: string }

/** Reads a change from the window; main never trusts the shape it was sent. */
export function readUserMcpServerChange(raw: unknown): UserMcpServerChange {
	const row = record(raw)
	const bad = new Error('Choose what the tool server runs or reaches.')
	if (!row || (row.mode !== 'add' && row.mode !== 'edit')) throw bad
	const name = short(row.name, 64)
	if (!name) throw new Error('Name the tool server.')
	if (row.command !== undefined && typeof row.command !== 'string') throw bad
	if (row.url !== undefined && typeof row.url !== 'string') throw bad
	if (typeof row.command === 'string' && row.command.length > 2000) throw bad
	if (typeof row.url === 'string' && row.url.length > 2000) throw bad
	if (
		row.args !== undefined &&
		(!Array.isArray(row.args) ||
			row.args.length > 200 ||
			row.args.some((arg) => typeof arg !== 'string' || arg.length > 2000))
	)
		throw bad
	if (
		commandLine({
			command: row.command as string | undefined,
			args: row.args as string[] | undefined,
		}).length > COMMAND_LINE_LIMIT
	)
		throw new Error(
			`The command and its arguments are longer than ${COMMAND_LINE_LIMIT} characters. Use a shorter command line, or edit the file.`,
		)
	return {
		mode: row.mode,
		name,
		...(typeof row.command === 'string' ? { command: row.command } : {}),
		...(Array.isArray(row.args) ? { args: row.args as string[] } : {}),
		...(typeof row.url === 'string' ? { url: row.url } : {}),
	}
}

/** The command line a server would start, one line, as the question names it. */
export function commandLine(change: { command?: string; args?: readonly string[] }): string {
	const line = [change.command ?? '', ...(change.args ?? [])]
		.map((part) => part.trim())
		.filter((part) => part !== '')
		.join(' ')
		.replace(/[\r\n\t]+/g, ' ')
	return line
}

/** The longest command line the question shows whole; a longer one is refused, never cut. */
export const COMMAND_LINE_LIMIT = 1000

/** The question asked before a server that runs a command is saved. */
export function commandConfirmation(change: {
	command?: string
	args?: readonly string[]
}): string {
	return `This server starts ${commandLine(change)} when a conversation starts.`
}

/**
 * Whether saving this change must ask first: it runs a command, and it is new or the command or its
 * arguments differ from what the file already holds. Changing nothing, or only an address, asks
 * nothing.
 */
export function startsNewCommand(
	change: UserMcpServerChange,
	held: UserMcpServerView | undefined,
): boolean {
	const command = change.command?.trim() ?? ''
	if (command === '') return false
	if (change.mode === 'edit' && held?.kind === 'command') {
		const args = (change.args ?? []).map((a) => a.trim()).filter((a) => a !== '')
		const same =
			held.command === command && JSON.stringify(held.args ?? []) === JSON.stringify(args)
		return !same
	}
	return true
}
