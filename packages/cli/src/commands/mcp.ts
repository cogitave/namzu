import { loadConfig } from '../config/load.js'
import { userConfigPath } from '../config/user-config.js'
import { EXIT_BAD_CONFIG, EXIT_FAIL, EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import { clearMcpOAuthCredentials } from '../integrations/mcp/oauth-store.js'
import { type McpServerSpec, transportFor } from '../integrations/mcp/servers.js'
import {
	addUserMcpServer,
	isUserMcpName,
	readUserMcpServers,
	removeUserMcpServer,
	summarizeUserMcpServer,
} from '../integrations/mcp/user-config.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { loginMcpServer } from './mcp-oauth-login.js'
import type { CommandDef } from './types.js'

const HELP = [
	'Usage: namzu mcp <list|get|add|remove|login|logout> [arguments]',
	'',
	'Manage tool servers in your user config (~/.namzu/config.yaml).',
	'Project and managed config can override these entries.',
	'',
	'  namzu mcp list',
	'  namzu mcp get <name>',
	"  namzu mcp add <name> --url <http-url> [--header 'NAME=Bearer \u0024{ENV_VAR}']",
	'  namzu mcp add <name> [--env ENV_VAR] -- <command> [arguments...]',
	'  namzu mcp remove <name>',
	'  namzu mcp login <name> [--no-browser] [--timeout <seconds>]',
	'  namzu mcp logout <name>',
	'',
	'Use --format json for structured output. Values of headers, environment',
	'variables and command arguments are hidden in list/get output.',
].join('\n')

type McpAction =
	| { readonly kind: 'list' }
	| { readonly kind: 'get' | 'remove'; readonly name: string }
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
	if (verb !== 'add' || !name || !isUserMcpName(name)) {
		return {
			kind: 'error',
			message:
				'Usage: namzu mcp <list|get|add|remove|login|logout>; new server names must start with a letter and use only letters, digits, _ or -.',
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
