import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { rewriteStateFileBackups } from '@namzu/sdk'
import { isMap, parseDocument } from 'yaml'

import {
	type UserConfigWriteOptions,
	deleteUserConfigValue,
	editUserConfigDocument,
	setUserConfigValue,
	unreadableUserConfig,
	userConfigPath,
	withUserConfigLock,
} from '../../config/user-config.js'
import type { McpServerSpec } from './servers.js'

const MCP_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export interface UserMcpServer {
	readonly name: string
	readonly spec: unknown
}

/** Read only the user's own entries, not project/profile/managed overrides. */
export function readUserMcpServers(opts: UserConfigWriteOptions = {}): readonly UserMcpServer[] {
	const file = userConfigPath(opts)
	if (!existsSync(file)) return []
	const doc = parseDocument(readFileSync(file, 'utf8'))
	if (doc.errors.length > 0)
		throw unreadableUserConfig(
			file,
			`is not valid YAML (${doc.errors[0]?.message ?? 'parse error'})`,
		)
	if (doc.contents !== null && !isMap(doc.contents))
		throw unreadableUserConfig(file, 'is not a mapping of settings')
	const node = doc.get('mcpServers', true)
	if (node === undefined) return []
	if (!isMap(node)) throw new Error(`${file}: mcpServers is not a mapping; fix it first`)
	return Object.entries(node.toJSON() as Record<string, unknown>).map(([name, spec]) => ({
		name,
		spec,
	}))
}

export function isUserMcpName(name: string): boolean {
	return MCP_NAME.test(name)
}

/** Never replace an entry silently: the existing server may carry permissions. */
export function addUserMcpServer(
	name: string,
	spec: McpServerSpec,
	opts: UserConfigWriteOptions = {},
): string {
	if (!isUserMcpName(name)) {
		throw new Error(
			'server name must start with a letter and contain only letters, digits, _ or - (up to 64 characters)',
		)
	}
	// The check and the write are one change: another process may be adding the same name.
	return withUserConfigLock(() => {
		if (readUserMcpServers(opts).some((entry) => entry.name === name)) {
			throw new Error(`server "${name}" already exists in ${userConfigPath(opts)}`)
		}
		return setUserConfigValue(['mcpServers', name], spec, opts)
	}, opts)
}

/**
 * Remove one server. Its headers and environment can hold tokens, so its entry
 * is also cut out of every recovery copy of `config.yaml`, under the same lock.
 */
export function removeUserMcpServer(name: string, opts: UserConfigWriteOptions = {}): boolean {
	const file = userConfigPath(opts)
	return withUserConfigLock(() => {
		const removed = deleteUserConfigValue(['mcpServers', name], opts)
		if (removed)
			rewriteStateFileBackups(dirname(file), 'config.yaml', (text) => withoutServer(text, name))
		return removed
	}, opts)
}

/**
 * A recovery copy of the settings without one server. A copy that does not
 * parse is left as it is: the server cannot be found in it safely, and the
 * rest of it is what the copy is for.
 */
function withoutServer(text: string, name: string): string {
	const doc = parseDocument(text)
	if (doc.errors.length > 0 || !doc.hasIn(['mcpServers', name])) return text
	doc.deleteIn(['mcpServers', name])
	const servers = doc.getIn(['mcpServers'], true)
	if (isMap(servers) && servers.items.length === 0) doc.deleteIn(['mcpServers'])
	return doc.toString()
}

export interface UserMcpServerSummary {
	readonly name: string
	readonly transport: 'stdio' | 'http' | 'invalid'
	readonly command?: string
	readonly endpoint?: string
	readonly argumentCount?: number
	readonly envNames?: readonly string[]
	readonly headerNames?: readonly string[]
	readonly inheritEnv?: readonly string[]
}

/** Display metadata only. Headers, environment values, and argv can contain secrets. */
export function summarizeUserMcpServer(entry: UserMcpServer): UserMcpServerSummary {
	const spec = entry.spec
	if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
		return { name: entry.name, transport: 'invalid' }
	}
	const value = spec as Record<string, unknown>
	const command = typeof value.command === 'string' ? value.command : undefined
	const url = typeof value.url === 'string' ? value.url : undefined
	if (command && !url) {
		return {
			name: entry.name,
			transport: 'stdio',
			command,
			argumentCount: Array.isArray(value.args) ? value.args.length : 0,
			envNames: mappingKeys(value.env),
			inheritEnv: stringList(value.inheritEnv),
		}
	}
	if (url && !command) {
		let endpoint: string
		try {
			const parsed = new URL(url)
			// Tokenized MCP endpoints can carry credentials in path segments. Show
			// only the origin in both human and structured summaries.
			endpoint = parsed.origin
		} catch {
			endpoint = '(invalid URL)'
		}
		return {
			name: entry.name,
			transport: 'http',
			endpoint,
			headerNames: mappingKeys(value.headers),
		}
	}
	return { name: entry.name, transport: 'invalid' }
}

function mappingKeys(value: unknown): readonly string[] {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? Object.keys(value)
		: []
}

function stringList(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: []
}

/** What a person types for a tool server: a command with arguments, or an address. */
export interface UserMcpServerInput {
	readonly command?: string
	readonly args?: readonly string[]
	readonly url?: string
	/** Header name to a value that is an environment reference (`${EXAMPLE_TOKEN}`). Address only. */
	readonly headers?: Readonly<Record<string, string>>
}

export const MCP_HEADERS_MAX = 20
/** A header name: letters, digits and dashes. */
export const MCP_HEADER_NAME = /^[A-Za-z0-9-]+$/
/** A header value that is an environment reference, with or without `Bearer `, and nothing else. */
export const MCP_HEADER_REFERENCE = /^(?:Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
export const MCP_HEADER_LITERAL_MESSAGE =
	'A header value is written as an environment reference such as ${EXAMPLE_TOKEN}, so no secret is stored here.'

/** The headers a person gave, checked: names plain, values environment references only. */
export function checkUserMcpHeaders(
	headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	const entries = Object.entries(headers)
	if (entries.length > MCP_HEADERS_MAX) throw new Error(`Use at most ${MCP_HEADERS_MAX} headers.`)
	const seen = new Set<string>()
	const out: Record<string, string> = {}
	for (const [rawName, rawValue] of entries) {
		const name = rawName.trim()
		if (name.length > 100 || !MCP_HEADER_NAME.test(name))
			throw new Error(`"${rawName.slice(0, 40)}" cannot be a header name.`)
		if (seen.has(name.toLowerCase())) throw new Error(`The header ${name} is listed twice.`)
		seen.add(name.toLowerCase())
		if (typeof rawValue !== 'string' || !MCP_HEADER_REFERENCE.test(rawValue.trim()))
			throw new Error(MCP_HEADER_LITERAL_MESSAGE)
		out[name] = rawValue.trim()
	}
	return out
}

export const MCP_NAME_RULE =
	'A server name starts with a letter and uses only letters, digits, _ or -, up to 64 characters.'

const isLocalHost = (hostname: string): boolean =>
	['localhost', '127.0.0.1', '[::1]'].includes(hostname)

/** Why an address cannot be a tool server's, in plain words; absent when it can. */
export function mcpAddressProblem(url: string): string | undefined {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return 'Enter a full web address that starts with http or https.'
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
		return 'The address must start with http or https.'
	if (parsed.username || parsed.password)
		return 'Do not put a user name or password in the address.'
	const remoteInsecure = parsed.protocol === 'http:' && !isLocalHost(parsed.hostname)
	if (remoteInsecure && parsed.search)
		return 'An address with a query needs https, or must point at this computer.'
	return undefined
}

/**
 * The entry a person's input stands for, or the sentence that says why not. Exactly one of a
 * command and an address; arguments only with a command.
 */
export function checkUserMcpServerInput(input: UserMcpServerInput): UserMcpServerInput {
	const command = input.command?.trim() ?? ''
	const url = input.url?.trim() ?? ''
	if (command !== '' && url !== '') throw new Error('Give a command or an address, not both.')
	if (command === '' && url === '') throw new Error('Give a command or an address.')
	if (url !== '') {
		if (input.args !== undefined && input.args.length > 0)
			throw new Error('Arguments go with a command, not an address.')
		if (url.length > 2000) throw new Error('That address is too long.')
		const problem = mcpAddressProblem(url)
		if (problem) throw new Error(problem)
		const headers =
			input.headers !== undefined && Object.keys(input.headers).length > 0
				? checkUserMcpHeaders(input.headers)
				: undefined
		// A header travels with every request, so it never goes over plain http to another computer.
		if (headers && new URL(url).protocol === 'http:' && !isLocalHost(new URL(url).hostname))
			throw new Error('Headers need an https address, or one that points at this computer.')
		// An empty set is kept as one: an edit reads it as "clear the headers".
		return { url, ...(headers ? { headers } : input.headers !== undefined ? { headers: {} } : {}) }
	}
	if (input.headers !== undefined && Object.keys(input.headers).length > 0)
		throw new Error('Headers go with an address, not a command.')
	if (command.length > 2000) throw new Error('That command is too long.')
	const args = (input.args ?? []).map((arg) => arg.trim()).filter((arg) => arg !== '')
	if (args.some((arg) => arg.length > 2000)) throw new Error('An argument is too long.')
	return { command, ...(args.length > 0 ? { args } : {}) }
}

/** One of the user's own tool servers as the Settings form edits it. Never env or headers. */
export interface UserMcpServerForm {
	readonly name: string
	/** `other` is an entry this form cannot read (neither a command nor an address): edit it in the file. */
	readonly kind: 'command' | 'address' | 'other'
	readonly command?: string
	readonly args?: readonly string[]
	readonly url?: string
}

/**
 * A server as the list shows it: the program (never its arguments, which may carry a key) and only
 * the origin of an address (its path or query may carry a token). The full entry is read by name
 * when one is edited.
 */
export interface UserMcpServerListEntry {
	readonly name: string
	readonly kind: 'command' | 'address' | 'other'
	readonly command?: string
	readonly argCount?: number
	readonly origin?: string
}

export function listEntryForUserMcpServer(form: UserMcpServerForm): UserMcpServerListEntry {
	if (form.kind === 'command')
		return {
			name: form.name,
			kind: 'command',
			...(form.command ? { command: form.command } : {}),
			...(form.args && form.args.length > 0 ? { argCount: form.args.length } : {}),
		}
	if (form.kind === 'address') {
		let origin: string | undefined
		try {
			origin = form.url ? new URL(form.url).origin : undefined
		} catch {}
		return { name: form.name, kind: 'address', ...(origin ? { origin } : {}) }
	}
	return { name: form.name, kind: 'other' }
}

export function readUserMcpServerForms(
	opts: UserConfigWriteOptions = {},
): readonly UserMcpServerForm[] {
	return readUserMcpServers(opts).map((entry): UserMcpServerForm => {
		const spec = entry.spec
		if (typeof spec !== 'object' || spec === null || Array.isArray(spec))
			return { name: entry.name, kind: 'other' }
		const value = spec as Record<string, unknown>
		const command = typeof value.command === 'string' ? value.command : undefined
		const url = typeof value.url === 'string' ? value.url : undefined
		const args = Array.isArray(value.args) ? value.args : []
		if (command && !url && args.every((arg) => typeof arg === 'string'))
			return {
				name: entry.name,
				kind: 'command',
				command,
				...(args.length > 0 ? { args: args as string[] } : {}),
			}
		if (url && !command) return { name: entry.name, kind: 'address', url }
		return { name: entry.name, kind: 'other' }
	})
}

/**
 * Add a server, or change the command or address of one the user file holds. An edit sets only
 * what the form shows (the command and its arguments, or the address); every other field of the
 * entry (variables, headers, anything else) stays exactly as it is in the file, and is not read
 * here. Changing between a command and an address drops the other kind's command, arguments or
 * address, nothing more.
 */
export function checkUserMcpServerSave(
	mode: 'add' | 'edit',
	name: string,
	input: UserMcpServerInput,
	opts: UserConfigWriteOptions = {},
): UserMcpServerInput {
	if (!isUserMcpName(name)) throw new Error(MCP_NAME_RULE)
	const checked = checkUserMcpServerInput(input)
	const existing = readUserMcpServers(opts).find((entry) => entry.name === name)
	if (mode === 'add' && existing) throw new Error(`There is already a server called ${name}.`)
	if (mode === 'edit' && !existing) throw new Error(`There is no server called ${name} here.`)
	if (
		mode === 'edit' &&
		(typeof existing?.spec !== 'object' || existing.spec === null || Array.isArray(existing.spec))
	)
		throw new Error('Edit this server in the config file.')
	return checked
}

export function saveUserMcpServer(
	mode: 'add' | 'edit',
	name: string,
	input: UserMcpServerInput,
	opts: UserConfigWriteOptions = {},
): void {
	withUserConfigLock(() => saveCheckedServer(mode, name, input, opts), opts)
}

function saveCheckedServer(
	mode: 'add' | 'edit',
	name: string,
	input: UserMcpServerInput,
	opts: UserConfigWriteOptions,
): void {
	const checked = checkUserMcpServerSave(mode, name, input, opts)
	if (mode === 'add') {
		const { headers, ...rest } = checked
		const spec = headers && Object.keys(headers).length > 0 ? checked : rest
		addUserMcpServer(name, spec as McpServerSpec, opts)
		return
	}
	editUserConfigDocument((doc) => {
		const at = ['mcpServers', name]
		if (checked.url !== undefined) {
			doc.setIn([...at, 'url'], checked.url)
			// Omitted headers are kept (the Settings form never shows them); an empty set clears them.
			if (checked.headers !== undefined) {
				if (Object.keys(checked.headers).length > 0)
					doc.setIn([...at, 'headers'], { ...checked.headers })
				else doc.deleteIn([...at, 'headers'])
			}
			doc.deleteIn([...at, 'command'])
			doc.deleteIn([...at, 'args'])
			return
		}
		doc.setIn([...at, 'command'], checked.command)
		if (checked.args && checked.args.length > 0) doc.setIn([...at, 'args'], [...checked.args])
		else doc.deleteIn([...at, 'args'])
		doc.deleteIn([...at, 'url'])
		// Headers belong to an address; a command server keeps none.
		doc.deleteIn([...at, 'headers'])
	}, opts)
}
