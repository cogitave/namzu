import { existsSync, readFileSync } from 'node:fs'
import { isMap, parseDocument } from 'yaml'

import {
	type UserConfigWriteOptions,
	deleteUserConfigValue,
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
