/**
 * What a "don't ask again" answer remembers, for the rest of the session.
 *
 * The reference turns an answer into a permission suggestion that "yes"
 * applies. This is the Namzu side of that: an allow the operator gave at a
 * prompt, kept in memory, consulted as one rule behind the operator's own
 * `[permissions]` table. It sits AFTER that table and the dangerous-pattern
 * floor (first match wins), so a `deny` or an explicit `ask` still decides
 * first, and a kernel escalation (a sandbox escape, a path outside the
 * roots) is reviewed whatever any rule says.
 *
 * Each entry is as narrow as the thing the person saw: the exact command
 * line, the host of a fetched URL, one MCP tool. Nothing here is a glob.
 */

import type { AuthorizationRule } from '@namzu/sdk'

export type SessionAllow =
	| { readonly kind: 'command'; readonly tool: string; readonly command: string }
	| { readonly kind: 'host'; readonly tool: string; readonly host: string }
	| { readonly kind: 'tool'; readonly tool: string }

/** The slice of a reviewed call this module reads. */
export interface AllowableCall {
	readonly name: string
	readonly input: unknown
	readonly isDestructive?: boolean
	readonly requiresApproval?: boolean
	readonly authorization?: { readonly explicitReview?: boolean }
	readonly escalation?: unknown
}

export const WEB_FETCH_TOOL = 'web_fetch'
const MAX_LABEL_COMMAND = 60

/** Tools whose command line is one argument; `bash` today. */
export type CommandArguments = ReadonlyMap<string, string>

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A call a rule must never cover: it asks every time, whatever was said before. */
function alwaysAsked(call: AllowableCall): boolean {
	return (
		call.escalation !== undefined ||
		call.requiresApproval === true ||
		call.authorization?.explicitReview === true ||
		call.isDestructive === true
	)
}

/**
 * The allow a "don't ask again" answer would remember for one call, or none.
 * The line must be a single plain command: a glob character would widen it,
 * and a compound line is matched command by command so an exact line would
 * never be consulted.
 */
export function allowFor(
	call: AllowableCall,
	commands: CommandArguments,
): SessionAllow | undefined {
	if (alwaysAsked(call)) return undefined
	const input = isRecord(call.input) ? call.input : undefined
	const commandArgument = commands.get(call.name)
	if (commandArgument !== undefined) {
		const line = input?.[commandArgument]
		if (typeof line !== 'string') return undefined
		const command = line.trim()
		if (command === '' || /[\n\r;&|<>`$()*?{}\\]/.test(command)) return undefined
		if (input?.dangerously_disable_sandbox === true) return undefined
		return { kind: 'command', tool: call.name, command }
	}
	if (call.name === WEB_FETCH_TOOL) {
		const url = input?.url
		if (typeof url !== 'string') return undefined
		try {
			const host = new URL(url).hostname
			if (host === '' || host.includes('*')) return undefined
			return { kind: 'host', tool: call.name, host }
		} catch {
			return undefined
		}
	}
	if (call.name.startsWith('mcp__')) return { kind: 'tool', tool: call.name }
	return undefined
}

/**
 * The allows that cover every call of a batch, or none when any call has no
 * allow of its own: an answer is offered only where it holds for the whole
 * batch.
 */
export function allowsForBatch(
	calls: readonly AllowableCall[],
	commands: CommandArguments,
): readonly SessionAllow[] | undefined {
	if (calls.length === 0) return undefined
	const out: SessionAllow[] = []
	for (const call of calls) {
		const allow = allowFor(call, commands)
		if (!allow) return undefined
		if (!out.some((existing) => sameAllow(existing, allow))) out.push(allow)
	}
	return out
}

export function sameAllow(a: SessionAllow, b: SessionAllow): boolean {
	if (a.kind !== b.kind || a.tool !== b.tool) return false
	if (a.kind === 'command' && b.kind === 'command') return a.command === b.command
	if (a.kind === 'host' && b.kind === 'host') return a.host === b.host
	return true
}

function shorten(text: string): string {
	return text.length > MAX_LABEL_COMMAND ? `${text.slice(0, MAX_LABEL_COMMAND - 1)}…` : text
}

/** The phrase after "don't ask again for", short enough for one line. */
export function describeAllows(allows: readonly SessionAllow[]): string {
	const parts = allows.map((allow) => {
		switch (allow.kind) {
			case 'command':
				return `${shorten(allow.command)} commands`
			case 'host':
				return allow.host
			case 'tool':
				return allow.tool.replace(/^mcp__/, '').replace(/__/g, ' ')
		}
	})
	return parts.length <= 1
		? (parts[0] ?? '')
		: `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

export interface SessionAllows {
	add(allows: readonly SessionAllow[]): void
	list(): readonly SessionAllow[]
	/** One kernel rule that consults the store at every call. */
	readonly rule: AuthorizationRule
}

function matches(
	allow: SessionAllow,
	toolName: string,
	toolInput: unknown,
	commands: CommandArguments,
): boolean {
	if (allow.tool !== toolName) return false
	switch (allow.kind) {
		case 'tool':
			return true
		case 'host': {
			const url = isRecord(toolInput) ? toolInput.url : undefined
			if (typeof url !== 'string') return false
			try {
				return new URL(url).hostname === allow.host
			} catch {
				return false
			}
		}
		case 'command': {
			const argument = commands.get(toolName)
			if (argument === undefined || !isRecord(toolInput)) return false
			const line = toolInput[argument]
			return (
				typeof line === 'string' &&
				line.trim() === allow.command &&
				toolInput.dangerously_disable_sandbox !== true
			)
		}
	}
}

export function createSessionAllows(commands: CommandArguments): SessionAllows {
	const entries: SessionAllow[] = []
	return {
		add(allows) {
			for (const allow of allows) {
				if (!entries.some((existing) => sameAllow(existing, allow))) entries.push(allow)
			}
		},
		list: () => [...entries],
		rule: {
			type: 'predicate',
			description: 'allowed for this session by an answer at a prompt',
			decide: (call) =>
				entries.some((allow) => matches(allow, call.toolName, call.toolInput, commands))
					? 'allow'
					: null,
		},
	}
}
