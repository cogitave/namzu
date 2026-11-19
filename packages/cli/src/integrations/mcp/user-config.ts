import { existsSync, readFileSync } from 'node:fs'
import { isMap, parseDocument } from 'yaml'

import {
	type UserConfigWriteOptions,
	deleteUserConfigValue,
	editUserConfigDocument,
	setUserConfigValue,
	userConfigPath,
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
	if (doc.errors.length > 0) {
		throw new Error(
			`${file} is not valid YAML (${doc.errors[0]?.message ?? 'parse error'}); fix it first`,
		)
	}
	if (doc.contents !== null && !isMap(doc.contents)) {
		throw new Error(`${file} is not a mapping of settings; fix it first`)
	}
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
	if (readUserMcpServers(opts).some((entry) => entry.name === name)) {
		throw new Error(`server "${name}" already exists in ${userConfigPath(opts)}`)
	}
	return setUserConfigValue(['mcpServers', name], spec, opts)
}

export function removeUserMcpServer(name: string, opts: UserConfigWriteOptions = {}): boolean {
	return deleteUserConfigValue(['mcpServers', name], opts)
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
}

export const MCP_NAME_RULE =
	'A server name starts with a letter and uses only letters, digits, _ or -, up to 64 characters.'

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
	const remoteInsecure =
		parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
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
		return { url }
	}
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
	const checked = checkUserMcpServerSave(mode, name, input, opts)
	if (mode === 'add') {
		addUserMcpServer(name, checked as McpServerSpec, opts)
		return
	}
	editUserConfigDocument((doc) => {
		const at = ['mcpServers', name]
		if (checked.url !== undefined) {
			doc.setIn([...at, 'url'], checked.url)
			doc.deleteIn([...at, 'command'])
			doc.deleteIn([...at, 'args'])
			return
		}
		doc.setIn([...at, 'command'], checked.command)
		if (checked.args && checked.args.length > 0) doc.setIn([...at, 'args'], [...checked.args])
		else doc.deleteIn([...at, 'args'])
		doc.deleteIn([...at, 'url'])
	}, opts)
}
