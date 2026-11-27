import { isAbsolute } from 'node:path'
import type {
	PluginMCPServerConfig,
	PluginRemoteMCPServerConfig,
} from '../../types/plugin/index.js'
import { COMMON_USER_CONFIG_PREFIX } from '../common-layout-names.js'
import { type PluginPathValues, expandPluginPaths } from './paths.js'
import type { LayoutFinding, LayoutSetupServer } from './types.js'

/** One servers map and the file (or manifest) it was read from. */
export interface McpSource {
	readonly origin: string
	readonly map: Readonly<Record<string, unknown>>
}

export interface McpReadResult {
	readonly local: readonly PluginMCPServerConfig[]
	readonly remote: readonly PluginRemoteMCPServerConfig[]
	readonly findings: readonly LayoutFinding[]
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const KNOWN_KEYS = new Set(['command', 'args', 'env', 'type', 'url', 'headers', 'connectTimeoutMs'])
const REMOTE_TYPES = new Set(['http', 'sse', 'streamable-http'])

function isMapping(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The servers of one parsed file or inline value: `{ "mcpServers": { name: spec } }`
 * or the flat `{ name: spec }`.
 */
export function serversOf(value: unknown): Record<string, unknown> | undefined {
	if (!isMapping(value)) return undefined
	if (isMapping(value.mcpServers)) return value.mcpServers
	return value
}

interface Expanded {
	readonly text: string
	readonly needs: readonly string[]
}

class Reader {
	readonly findings: LayoutFinding[] = []
	readonly local: PluginMCPServerConfig[] = []
	readonly remote: PluginRemoteMCPServerConfig[] = []
	private readonly seen = new Set<string>()

	constructor(
		private readonly values: PluginPathValues,
		private readonly environment: Readonly<Record<string, string | undefined>>,
	) {}

	add(finding: LayoutFinding): void {
		this.findings.push(finding)
	}

	/** Path names, then (only in an `env` value) bare environment references; the rest is said. */
	private expand(
		text: string,
		field: string,
		name: string,
		mode: 'env' | 'keep' | 'none',
	): Expanded {
		const needs: string[] = []
		let expanded: string
		try {
			const result = expandPluginPaths(text, this.values)
			expanded = result.text
			for (const unresolved of result.unresolved) {
				needs.push(`\${${unresolved}} has no folder here (${field})`)
			}
		} catch (error) {
			needs.push(error instanceof Error ? error.message : String(error))
			expanded = text
		}
		expanded = expanded.replace(/\$\{([^}]*)\}/g, (whole: string, inner: string) => {
			if (inner.startsWith(COMMON_USER_CONFIG_PREFIX)) {
				needs.push(`${whole} is a saved option, which is not supported yet (${field})`)
				return whole
			}
			if ((mode === 'env' || mode === 'keep') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) {
				const value = this.environment[inner]
				if (value === undefined || value === '') {
					needs.push(`${inner} is not set`)
					return whole
				}
				// A header keeps its reference as written: the value is read when it connects.
				return mode === 'keep' ? whole : value
			}
			needs.push(`${whole} is not expanded in ${field}`)
			return whole
		})
		const bare = expanded.replace(/\$\{[^}]*\}/g, '')
		if (/\$[A-Za-z_]|`|%[A-Za-z_][A-Za-z0-9_]*%/.test(bare)) {
			this.add({
				level: 'ignored',
				code: 'mcp-text-left-as-is',
				field: `mcpServers.${name}.${field}`,
				message: `${name}: ${field} holds a $-name, backtick or %NAME% that is left as written; no shell reads it.`,
			})
		}
		return { text: expanded, needs }
	}

	private refuse(name: string, code: string, message: string): void {
		this.add({ level: 'refused', code, field: `mcpServers.${name}`, message })
	}

	private needsSetup(
		name: string,
		needs: readonly string[],
		server?: Omit<LayoutSetupServer, 'name'>,
	): void {
		this.add({
			...(server !== undefined ? { server: { name, ...server } } : {}),
			level: 'notUsed',
			code: 'mcp-needs-setup',
			field: `mcpServers.${name}`,
			message: `${name} needs setup: ${needs.join('; ')}. It is not started.`,
		})
	}

	readSource(source: McpSource): void {
		for (const [name, spec] of Object.entries(source.map)) {
			if (this.seen.has(name)) {
				this.add({
					level: 'ignored',
					code: 'mcp-server-duplicate',
					field: `mcpServers.${name}`,
					message: `${name} is named twice; the first one in ${source.origin} order is kept.`,
				})
				continue
			}
			this.seen.add(name)
			this.readOne(name, spec)
		}
	}

	private readOne(name: string, spec: unknown): void {
		if (!SERVER_NAME.test(name)) {
			this.refuse(name, 'mcp-name-invalid', `"${name}" is not a usable server name.`)
			return
		}
		if (!isMapping(spec)) {
			this.add({
				level: 'ignored',
				code: 'mcp-server-empty',
				field: `mcpServers.${name}`,
				message: `${name} has no settings.`,
			})
			return
		}
		for (const key of Object.keys(spec)) {
			if (!KNOWN_KEYS.has(key)) {
				this.add({
					level: 'ignored',
					code: 'mcp-key-ignored',
					field: `mcpServers.${name}.${key}`,
					message: `${name}: "${key}" is not read.`,
				})
			}
		}
		const hasCommand = typeof spec.command === 'string' && spec.command.length > 0
		const hasUrl = typeof spec.url === 'string' && spec.url.length > 0
		const type = typeof spec.type === 'string' ? spec.type : undefined
		if (hasCommand && hasUrl) {
			this.refuse(name, 'mcp-server-both', `${name} names both a command and an address; use one.`)
			return
		}
		if (!hasCommand && !hasUrl) {
			this.add({
				level: 'ignored',
				code: 'mcp-server-empty',
				field: `mcpServers.${name}`,
				message: `${name} names neither a command nor an address.`,
			})
			return
		}
		if (hasUrl) {
			if (type !== undefined && !REMOTE_TYPES.has(type)) {
				this.refuse(name, 'mcp-type-unsupported', `${name}: the type "${type}" is not supported.`)
				return
			}
			this.readRemote(name, spec, type)
			return
		}
		if (type !== undefined && type !== 'stdio') {
			this.refuse(name, 'mcp-type-unsupported', `${name}: the type "${type}" is not supported.`)
			return
		}
		this.readLocal(name, spec)
	}

	private readLocal(name: string, spec: Record<string, unknown>): void {
		const needs: string[] = []
		const command = this.expand(spec.command as string, 'command', name, 'none')
		needs.push(...command.needs)
		const looksRelative =
			/[\\/]/.test(command.text) && !isAbsolute(command.text) && !/^[A-Za-z]:/.test(command.text)
		if (looksRelative && command.text.split(/[\\/]/).includes('..')) {
			this.refuse(name, 'mcp-command-escapes', `${name}: the command leaves the plugin with "..".`)
			return
		}
		let args: string[] | undefined
		if (spec.args !== undefined) {
			if (!Array.isArray(spec.args) || !spec.args.every((arg) => typeof arg === 'string')) {
				this.refuse(name, 'mcp-args-invalid', `${name}: "args" must be a list of text.`)
				return
			}
			args = (spec.args as string[]).map((arg) => {
				const expanded = this.expand(arg, 'args', name, 'none')
				needs.push(...expanded.needs)
				return expanded.text
			})
		}
		let env: Record<string, string> | undefined
		if (spec.env !== undefined) {
			if (
				!isMapping(spec.env) ||
				!Object.values(spec.env).every((value) => typeof value === 'string')
			) {
				this.refuse(name, 'mcp-env-invalid', `${name}: "env" must map names to text.`)
				return
			}
			env = {}
			for (const [key, value] of Object.entries(spec.env as Record<string, string>)) {
				const expanded = this.expand(value, `env.${key}`, name, 'env')
				needs.push(...expanded.needs)
				env[key] = expanded.text
			}
		}
		let connectTimeoutMs: number | undefined
		if (typeof spec.connectTimeoutMs === 'number') {
			if (
				!Number.isInteger(spec.connectTimeoutMs) ||
				spec.connectTimeoutMs <= 0 ||
				spec.connectTimeoutMs > 3_600_000
			) {
				this.refuse(name, 'mcp-timeout-invalid', `${name}: "connectTimeoutMs" is out of range.`)
				return
			}
			connectTimeoutMs = spec.connectTimeoutMs
		}
		if (needs.length > 0) {
			this.needsSetup(name, [...new Set(needs)], {
				kind: 'local',
				target: spec.command as string,
				args: Array.isArray(spec.args) ? (spec.args as string[]) : [],
				values: isMapping(spec.env) ? (spec.env as Record<string, string>) : {},
			})
			return
		}
		this.local.push({
			name,
			command: command.text,
			...(args !== undefined ? { args } : {}),
			...(env !== undefined ? { env } : {}),
			...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
		})
		this.add({
			level: 'used',
			code: 'mcp-server-local',
			field: `mcpServers.${name}`,
			message: `${name} starts as a local program while the plugin is on.`,
		})
	}

	private readRemote(name: string, spec: Record<string, unknown>, type: string | undefined): void {
		const url = this.expand(spec.url as string, 'url', name, 'none')
		const asWritten = (): Omit<LayoutSetupServer, 'name'> => ({
			kind: 'remote',
			target: spec.url as string,
			transport: type === 'sse' ? 'sse' : 'http',
			values:
				isMapping(spec.headers) &&
				Object.values(spec.headers).every((value) => typeof value === 'string')
					? (spec.headers as Record<string, string>)
					: {},
		})
		if (url.needs.length > 0) {
			this.needsSetup(name, url.needs, asWritten())
			return
		}
		let parsed: URL
		try {
			parsed = new URL(url.text)
		} catch {
			this.refuse(name, 'mcp-url-invalid', `${name}: the address is not a valid URL.`)
			return
		}
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
			this.refuse(
				name,
				'mcp-url-invalid',
				`${name}: the address must start with https:// or http://.`,
			)
			return
		}
		if (parsed.username !== '' || parsed.password !== '') {
			this.refuse(
				name,
				'mcp-url-invalid',
				`${name}: the address must not hold a user name or password.`,
			)
			return
		}
		let headers: Record<string, string> | undefined
		if (spec.headers !== undefined) {
			if (
				!isMapping(spec.headers) ||
				!Object.values(spec.headers).every((value) => typeof value === 'string')
			) {
				this.refuse(name, 'mcp-headers-invalid', `${name}: "headers" must map names to text.`)
				return
			}
			headers = {}
			const needs: string[] = []
			for (const [key, value] of Object.entries(spec.headers as Record<string, string>)) {
				// A `${VAR}` stays as written: the host that connects reads the variable
				// then, and the plugin file never holds the value.
				const expanded = this.expand(value, `headers.${key}`, name, 'keep')
				needs.push(...expanded.needs)
				headers[key] = expanded.text
			}
			if (needs.length > 0) {
				this.needsSetup(name, [...new Set(needs)], asWritten())
				return
			}
		}
		const transport = type === 'sse' ? 'sse' : 'http'
		this.remote.push({
			name,
			url: url.text,
			transport,
			...(headers !== undefined ? { headers } : {}),
		})
		this.add({
			level: 'notUsed',
			code: 'mcp-server-remote',
			field: `mcpServers.${name}`,
			message: `${name} is a remote server at ${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}. It is read and listed, and it is not started yet.`,
		})
	}
}

/** Read every server of every source, applying the path and environment rules. */
export function readMcpSources(
	sources: readonly McpSource[],
	values: PluginPathValues,
	environment: Readonly<Record<string, string | undefined>>,
): McpReadResult {
	const reader = new Reader(values, environment)
	for (const source of sources) reader.readSource(source)
	return {
		local: reader.local,
		remote: reader.remote,
		findings: reader.findings,
	}
}
