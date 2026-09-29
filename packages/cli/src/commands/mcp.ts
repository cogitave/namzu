import { loadConfig } from '../config/load.js'
import { userConfigPath } from '../config/user-config.js'
import { EXIT_BAD_CONFIG, EXIT_FAIL, EXIT_OK, EXIT_UNTRUSTED, EXIT_USAGE } from '../exit-codes.js'
import { clearMcpOAuthCredentials, isSecureMcpOAuthUrl } from '../integrations/mcp/oauth-store.js'
import {
	type McpServerSpec,
	connectDeadlineFor,
	connectMcpServers,
	transportFor,
} from '../integrations/mcp/servers.js'
import {
	addUserMcpServer,
	isUserMcpName,
	readUserMcpServers,
	removeUserMcpServer,
	summarizeUserMcpServer,
} from '../integrations/mcp/user-config.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { loginMcpServer } from './mcp-oauth-login.js'
import type { CommandContext, CommandDef } from './types.js'

const HELP = [
	'Usage: namzu mcp <list|get|add|remove|test|login|logout> [arguments]',
	'',
	'Manage tool servers in your user config (~/.namzu/config.yaml).',
	'Project and managed config can override these entries.',
	'',
	'  namzu mcp list',
	'  namzu mcp get <name>',
	"  namzu mcp add <name> --url <http-url> [--header 'NAME=Bearer \u0024{ENV_VAR}']",
	'  namzu mcp add <name> [--env ENV_VAR] -- <command> [arguments...]',
	'  namzu mcp remove <name>',
	'  namzu mcp test <name> [--trust]    Check the effective server and its tools',
	'  namzu mcp login <name> [--no-browser] [--timeout <seconds>]',
	'  namzu mcp logout <name>',
	'',
	'Use --format json for structured output. Values of headers, environment',
	'variables and command arguments are hidden in list/get/test output.',
].join('\n')

type McpAction =
	| { readonly kind: 'list' }
	| { readonly kind: 'get' | 'remove'; readonly name: string }
	| { readonly kind: 'test'; readonly name: string; readonly trust: boolean }
	| { readonly kind: 'add'; readonly name: string; readonly spec: McpServerSpec }
	| {
			readonly kind: 'login'
			readonly name: string
			readonly noBrowser: boolean
			readonly timeoutMs: number
	  }
	| { readonly kind: 'logout'; readonly name: string }
	| { readonly kind: 'error'; readonly message: string }

export const mcpCommand: CommandDef = {
	name: 'mcp',
	description: 'Manage user tool servers',
	passThrough: true,
	help: HELP,
	handler: async ({ ctx, rawArgs }) => {
		const action = parseMcpAction(rawArgs)
		if (action.kind === 'error') {
			ctx.formatter.error({ message: action.message })
			return EXIT_USAGE
		}
		if (action.kind === 'test') {
			return testMcpServer(action.name, action.trust, ctx)
		}
		if (action.kind === 'login' || action.kind === 'logout') {
			try {
				// `mcp` uses a recovery context so list/add/remove can repair a
				// broken config. Login and logout need the effective server entry,
				// including a project/profile override, so load it only here.
				const spec = loadConfig({ profile: ctx.selectedProfile }).mcpServers?.[action.name]
				if (!spec || !spec.url || spec.command) {
					ctx.formatter.error({
						message: `MCP server "${oneLine(action.name)}" must be a configured HTTP server to use OAuth.`,
					})
					return EXIT_USAGE
				}
				if (action.kind === 'logout') {
					const removed = clearMcpOAuthCredentials(spec.url)
					ctx.formatter.print({
						name: action.name,
						removed,
						text: removed
							? `Removed saved MCP sign-in for ${oneLine(action.name)}.`
							: `No saved MCP sign-in for ${oneLine(action.name)}.`,
					})
					return EXIT_OK
				}
				const resolved = transportFor(spec, process.cwd())
				if (typeof resolved === 'string' || resolved.type !== 'streamable-http') {
					ctx.formatter.error({
						message: `MCP server "${oneLine(action.name)}" cannot start OAuth: ${typeof resolved === 'string' ? oneLine(resolved) : 'it is not an HTTP server'}.`,
					})
					return EXIT_BAD_CONFIG
				}
				if (
					Object.keys(resolved.headers ?? {}).some((key) => key.toLowerCase() === 'authorization')
				) {
					ctx.formatter.error({
						message: `MCP server "${oneLine(action.name)}" already has an Authorization header. Remove that header before OAuth sign-in.`,
					})
					return EXIT_BAD_CONFIG
				}
				await loginMcpServer({
					name: action.name,
					endpoint: resolved.url,
					...(resolved.headers ? { headers: resolved.headers } : {}),
					noBrowser: action.noBrowser,
					timeoutMs: action.timeoutMs,
					print: (value) => ctx.formatter.print(value),
				})
				return EXIT_OK
			} catch (error) {
				ctx.formatter.error({
					message: error instanceof Error ? oneLine(error.message) : 'MCP sign-in failed.',
				})
				return EXIT_FAIL
			}
		}
		try {
			const entries = readUserMcpServers()
			const file = userConfigPath()
			if (action.kind === 'list') {
				const servers = entries.map(summarizeUserMcpServer)
				const lines =
					servers.length === 0
						? ['No user tool servers are configured.']
						: servers.map(
								(server) =>
									`  ${oneLine(server.name)}: ${server.transport}${server.command ? ` (${oneLine(server.command)})` : ''}${server.endpoint ? ` (${oneLine(server.endpoint)})` : ''}`,
							)
				ctx.formatter.print({ file, servers, text: ['User tool servers:', ...lines].join('\n') })
				return EXIT_OK
			}
			const existing = entries.find((entry) => entry.name === action.name)
			if (action.kind === 'get') {
				if (!existing) {
					ctx.formatter.error({
						message: `No user tool server named "${oneLine(action.name)}".`,
					})
					return EXIT_USAGE
				}
				const server = summarizeUserMcpServer(existing)
				const detail =
					server.transport === 'http'
						? server.endpoint
						: server.transport === 'stdio'
							? server.command
							: 'invalid entry'
				ctx.formatter.print({
					file,
					server,
					text: `${oneLine(server.name)}: ${server.transport} (${oneLine(detail ?? '')})\nConfig: ${oneLine(file)}`,
				})
				return EXIT_OK
			}
			if (action.kind === 'add') {
				if (existing) {
					ctx.formatter.error({
						message: `User tool server "${oneLine(action.name)}" already exists in ${oneLine(file)}.`,
					})
					return EXIT_USAGE
				}
				addUserMcpServer(action.name, action.spec)
				const server = summarizeUserMcpServer({ name: action.name, spec: action.spec })
				ctx.formatter.print({
					file,
					server,
					text: `Added user tool server ${oneLine(action.name)} to ${oneLine(file)}.`,
				})
				return EXIT_OK
			}
			if (!existing || !removeUserMcpServer(action.name)) {
				ctx.formatter.error({
					message: `No user tool server named "${oneLine(action.name)}".`,
				})
				return EXIT_USAGE
			}
			ctx.formatter.print({
				file,
				name: action.name,
				text: `Removed user tool server ${oneLine(action.name)} from ${oneLine(file)}.`,
			})
			return EXIT_OK
		} catch (error) {
			ctx.formatter.error({
				message:
					error instanceof Error
						? oneLine(error.message)
						: 'Could not read or write the user tool servers.',
			})
			return EXIT_BAD_CONFIG
		}
	},
}

/** Probe only the named effective server; a test must not start its siblings. */
async function testMcpServer(
	name: string,
	trustFlag: boolean,
	ctx: CommandContext,
): Promise<number> {
	const displayName = oneLine(name)
	const report = (
		status: 'connected' | 'unavailable',
		transport: 'stdio' | 'http' | 'invalid',
		toolCount: number,
		reason?: string,
		warning?: string,
		resourceHelperCount = 0,
	): void => {
		ctx.formatter.print({
			name: displayName,
			status,
			transport,
			toolCount,
			...(resourceHelperCount > 0 ? { resourceHelperCount } : {}),
			...(reason ? { reason } : {}),
			...(warning ? { warning } : {}),
			text:
				status === 'connected'
					? `${displayName}: connected; ${toolCount} server ${toolCount === 1 ? 'tool or prompt' : 'tools or prompts'}.${resourceHelperCount > 0 ? ` ${resourceHelperCount} resource helpers available.` : ''}${warning ? ` ${warning}` : ''}`
					: `${displayName}: unavailable; ${reason ?? 'the server did not become ready'}.`,
		})
	}

	const trust = decideHeadlessTrust({ cwd: process.cwd(), trustFlag })
	if (!trust.allowed) {
		report(
			'unavailable',
			'invalid',
			0,
			'project is not trusted; open namzu here or pass --trust for this test',
		)
		return EXIT_UNTRUSTED
	}
	let selected: unknown
	try {
		// `mcp list/get` intentionally read the user file for repair. A test
		// instead checks what a new session would run, including project,
		// selected-profile and managed overrides.
		selected = loadConfig({ profile: ctx.selectedProfile, cwd: trust.cwd }).mcpServers?.[name]
	} catch {
		report('unavailable', 'invalid', 0, 'effective MCP configuration could not be loaded')
		return EXIT_BAD_CONFIG
	}
	if (selected === undefined) {
		report('unavailable', 'invalid', 0, 'no server with this name in effective MCP configuration')
		return EXIT_USAGE
	}
	if (typeof selected !== 'object' || selected === null || Array.isArray(selected)) {
		report('unavailable', 'invalid', 0, 'server specification must be a mapping')
		return EXIT_BAD_CONFIG
	}
	const spec = selected as McpServerSpec
	const hasCommand = typeof spec.command === 'string' && spec.command.trim().length > 0
	const hasUrl = typeof spec.url === 'string' && spec.url.trim().length > 0
	const transport =
		hasCommand && hasUrl ? 'invalid' : hasCommand ? 'stdio' : hasUrl ? 'http' : 'invalid'
	let toolCount = 0
	let resourceHelperCount = 0
	let reason: string | undefined
	let warning: string | undefined
	let connection: Awaited<ReturnType<typeof connectMcpServers>> | undefined
	try {
		connection = await connectMcpServers({ [name]: spec }, { cwd: trust.cwd })
		const current = connection.current()
		const failed = current.failed.find((server) => server.name === name)
		if (failed) {
			reason = safeTestReason(failed.reason, spec, displayName)
		} else {
			const connected = current.connected.find((server) => server.name === name)
			// The MCP toolset's first entry contains server tools and prompts;
			// its second entry contains deferred resource helpers. Counting both
			// as server tools can turn an empty tools/list and resources/list into
			// a misleading "2 usable tools" diagnosis.
			toolCount = connected ? (connection.toolsets[0]?.tools().length ?? 0) : 0
			resourceHelperCount = connected ? (connection.toolsets[1]?.tools().length ?? 0) : 0
			if (!connected) reason = 'server did not reach a connected state'
			else if (toolCount === 0) warning = 'No server tools or prompts were exposed.'
		}
	} catch {
		reason = 'MCP connection or tool discovery failed; inspect the server logs'
	} finally {
		try {
			await connection?.close()
		} catch {
			reason = 'MCP connection shutdown failed; inspect the server process'
		}
	}
	report(
		reason ? 'unavailable' : 'connected',
		transport,
		toolCount,
		reason,
		warning,
		resourceHelperCount,
	)
	return reason ? EXIT_FAIL : EXIT_OK
}

/** Never print a transport's raw error: it can contain URLs, credentials or server stderr. */
export function safeTestReason(reason: string, spec: McpServerSpec, name: string): string {
	if (reason === 'server spec must be a mapping') return reason
	if (reason.startsWith('it declares both a command and a url')) {
		return 'server declares both a command and a URL; choose one'
	}
	if (reason.startsWith('it declares neither a command nor a url')) {
		return 'server declares neither a command nor a URL'
	}
	const badShape = /^(command|url|cwd|args|inheritEnv|env|headers) must be\b/.exec(reason)
	if (badShape) return `invalid ${badShape[1]} setting`
	const unsetVariable = /^references \$\{([A-Za-z_][A-Za-z0-9_]*)\}, which is not set/.exec(reason)
	if (unsetVariable) return `environment variable ${unsetVariable[1]} is not set`
	for (const field of [
		'connectTimeoutMs',
		'eraProbeTimeoutMs',
		'allow',
		'deny',
		'maxRetries',
		'requireApproval',
		'readOnlyHintTrusted',
		'instructions',
	]) {
		if (reason.startsWith(`${field} `)) return `invalid ${field} setting`
	}
	if (/HTTP 401\b|authorization required|authentication required/i.test(reason)) {
		const hasAuthorizationHeader = Object.keys(spec.headers ?? {}).some(
			(key) => key.toLowerCase() === 'authorization',
		)
		return hasAuthorizationHeader
			? 'HTTP 401: check the configured Authorization header'
			: canSignInToMcpUrl(spec.url)
				? `HTTP 401: sign in with namzu mcp login ${name}`
				: 'HTTP 401: OAuth sign-in requires HTTPS or a loopback endpoint'
	}
	if (/HTTP 403\b/i.test(reason))
		return 'HTTP 403: server refused access; check account permissions'
	if (/HTTP 404\b/i.test(reason)) return 'HTTP 404: check the configured MCP endpoint'
	const httpStatus = /HTTP ([45]\d\d)\b/i.exec(reason)
	if (httpStatus) return `HTTP ${httpStatus[1]}: server rejected the request`
	if (/did not answer within|timed out|timeout/i.test(reason)) {
		const deadline = connectDeadlineFor(spec)
		return typeof deadline === 'number'
			? `connection or tool discovery timed out after ${deadline}ms; check server logs`
			: 'connection or tool discovery timed out; check connectTimeoutMs and server logs'
	}
	if (/\bENOENT\b/i.test(reason)) return 'server command could not be found'
	if (/\bEACCES\b|\bEPERM\b/i.test(reason)) return 'server command could not be executed'
	if (/StdioTransport: not connected or stdin not writable/i.test(reason)) {
		return 'stdio server did not start or closed before the handshake; check command, cwd and server logs'
	}
	if (/\bECONNREFUSED\b/i.test(reason)) return 'connection refused by the server'
	if (/\bENOTFOUND\b|\bEAI_AGAIN\b/i.test(reason)) return 'server hostname could not be resolved'
	if (/certificate|\bTLS\b/i.test(reason)) return 'TLS certificate validation failed'
	if (/tools\/list|discovering its tools/i.test(reason)) {
		return 'server connected but tool discovery failed; inspect the server logs'
	}
	return 'MCP connection or tool discovery failed; inspect the server logs'
}

function canSignInToMcpUrl(raw: string | undefined): boolean {
	if (!raw) return false
	try {
		return isSecureMcpOAuthUrl(new URL(raw))
	} catch {
		return false
	}
}

function parseMcpAction(args: readonly string[]): McpAction {
	const [verb, name] = args
	if (verb === 'list' && args.length === 1) return { kind: 'list' }
	if (verb === 'logout' && args.length === 2 && name && !name.startsWith('-')) {
		return { kind: 'logout', name }
	}
	if (verb === 'login' && name && !name.startsWith('-')) {
		let noBrowser = false
		let timeoutMs = 300_000
		for (let index = 2; index < args.length; index++) {
			const arg = args[index]
			if (arg === '--no-browser' && !noBrowser) {
				noBrowser = true
				continue
			}
			if (arg === '--timeout') {
				const value = args[++index]
				const seconds = Number(value)
				if (!value || !Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
					return { kind: 'error', message: '--timeout requires seconds between 0 and 3600.' }
				}
				timeoutMs = seconds * 1000
				continue
			}
			return { kind: 'error', message: `Unknown mcp login option: ${oneLine(arg ?? '')}` }
		}
		return { kind: 'login', name, noBrowser, timeoutMs }
	}
	if ((verb === 'get' || verb === 'remove') && args.length === 2 && name !== undefined) {
		return { kind: verb, name }
	}
	if (
		verb === 'test' &&
		name &&
		(args.length === 2 || (args.length === 3 && args[2] === '--trust'))
	) {
		return { kind: 'test', name, trust: args[2] === '--trust' }
	}
	if (verb !== 'add' || !name || !isUserMcpName(name)) {
		return {
			kind: 'error',
			message:
				'Usage: namzu mcp <list|get|add|remove|test|login|logout>; new server names must start with a letter and use only letters, digits, _ or -.',
		}
	}
	let url: string | undefined
	const inheritEnv: string[] = []
	const headers: Record<string, string> = {}
	let command: readonly string[] | undefined
	for (let index = 2; index < args.length; index++) {
		const arg = args[index]
		if (arg === '--') {
			command = args.slice(index + 1)
			break
		}
		if (arg === '--url') {
			url = args[++index]
			if (!url) return { kind: 'error', message: '--url requires an HTTP URL.' }
			continue
		}
		if (arg === '--env') {
			const variable = args[++index]
			if (!variable || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
				return { kind: 'error', message: '--env requires an environment variable name.' }
			}
			inheritEnv.push(variable)
			continue
		}
		if (arg === '--header') {
			const header = args[++index]
			const split = header?.indexOf('=') ?? -1
			if (
				!header ||
				split <= 0 ||
				!/^[A-Za-z0-9-]+$/.test(header.slice(0, split)) ||
				!/^(?:Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(header.slice(split + 1))
			) {
				return {
					kind: 'error',
					message:
						'--header requires NAME=\u0024{ENV_VAR} or NAME=Bearer \u0024{ENV_VAR}; literal secrets are refused.',
				}
			}
			headers[header.slice(0, split)] = header.slice(split + 1)
			continue
		}
		if (arg && !arg.startsWith('-')) {
			command = args.slice(index)
			break
		}
		return { kind: 'error', message: `Unknown mcp add option: ${oneLine(arg ?? '')}` }
	}
	if (url && command) return { kind: 'error', message: 'Choose --url or a command, not both.' }
	if (url) {
		if (inheritEnv.length > 0)
			return { kind: 'error', message: '--env applies only to a command server.' }
		let parsed: URL
		try {
			parsed = new URL(url)
		} catch {
			return { kind: 'error', message: '--url requires an HTTP URL.' }
		}
		if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
			return { kind: 'error', message: '--url requires an HTTP URL without embedded credentials.' }
		}
		const remoteInsecure =
			parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
		if (remoteInsecure && parsed.search) {
			return {
				kind: 'error',
				message: 'URL query parameters require HTTPS or a loopback endpoint.',
			}
		}
		if (Object.keys(headers).length > 0 && remoteInsecure) {
			return { kind: 'error', message: 'Credential headers require HTTPS or a loopback endpoint.' }
		}
		return { kind: 'add', name, spec: { url, ...(Object.keys(headers).length ? { headers } : {}) } }
	}
	if (Object.keys(headers).length > 0)
		return { kind: 'error', message: '--header applies only to an HTTP server.' }
	if (!command?.[0])
		return { kind: 'error', message: 'Provide --url or -- <command> [arguments...].' }
	return {
		kind: 'add',
		name,
		spec: {
			command: command[0],
			...(command.length > 1 ? { args: command.slice(1) } : {}),
			...(inheritEnv.length > 0 ? { inheritEnv } : {}),
		},
	}
}

function oneLine(value: string): string {
	return terminalDisplayText(value).replaceAll('\n', ' ').replaceAll('\t', ' ')
}
