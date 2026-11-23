import { resolve } from 'node:path'

import { loadConfig, pendingProjectMcpServers } from '../config/load.js'
import { userConfigPath } from '../config/user-config.js'
import { EXIT_BAD_CONFIG, EXIT_FAIL, EXIT_OK, EXIT_UNTRUSTED, EXIT_USAGE } from '../exit-codes.js'
import { clearMcpOAuthCredentials, isSecureMcpOAuthUrl } from '../integrations/mcp/oauth-store.js'
import {
	approveProjectMcpServers,
	startNewMcpApprovals,
} from '../integrations/mcp/project-approval.js'
import {
	addProjectMcpServer,
	projectMcpServerNames,
	removeProjectMcpServer,
} from '../integrations/mcp/project-file.js'
import {
	type McpServerSpec,
	connectDeadlineFor,
	connectMcpServers,
	mcpServerSpecProblem,
	transportFor,
} from '../integrations/mcp/servers.js'
import {
	MCP_NAME_RULE,
	addUserMcpServer,
	isUserMcpName,
	mcpAddressProblem,
	readUserMcpServers,
	removeUserMcpServer,
	summarizeUserMcpServer,
} from '../integrations/mcp/user-config.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { loginMcpServer } from './mcp-oauth-login.js'
import type { CommandContext, CommandDef } from './types.js'

const HELP = [
	'Usage: namzu mcp <list|get|add|remove|approve|test|login|logout|serve> [arguments]',
	'',
	'Manage tool servers in your user config (~/.namzu/config.yaml) or in this',
	"project's .mcp.json. Project and managed config can override user entries.",
	'',
	'  namzu mcp list',
	'  namzu mcp get <name>',
	"  namzu mcp add <name> --url <http-url> [-H 'NAME: Bearer \u0024{ENV_VAR}']",
	"  namzu mcp add -t http <name> <http-url> [-H 'NAME: Bearer \u0024{ENV_VAR}']",
	'  namzu mcp add <name> [-e NAME=value]... -- <command> [arguments...]',
	'  namzu mcp add json <name> <json>    Add from one JSON object, the shape of one .mcp.json entry',
	'  namzu mcp remove <name> [-s user|project]',
	'      -s, --scope user|project   where to write (default user); a project server waits for',
	'                                 namzu mcp approve before it starts',
	'      -t, --transport stdio|http  what kind of server (default stdio)',
	'      -e, --env NAME=value       environment for a command server; repeat. Use NAME=\u0024{OTHER} to',
	'                                 read the value from your environment when the server starts',
	'      -H, --header "NAME: value" header for an HTTP server; repeat. The value must be',
	'                                 \u0024{ENV_VAR} or Bearer \u0024{ENV_VAR}; literal secrets are refused',
	"  namzu mcp approve [name...] [--new-list]    Start this project's .mcp.json servers (all when no name);",
	'      --new-list starts a new approvals list when ~/.namzu/mcp-approvals.json cannot be read',
	'      (the old one is kept in ~/.namzu/backups/)',
	'  namzu mcp test <name> [--trust]    Check the effective server and its tools',
	'  namzu mcp login <name> [--no-browser] [--timeout <seconds>]',
	'  namzu mcp logout <name>',
	'  namzu mcp serve [--permission-mode <mode>] [--allowed-tools <list>] [--disallowed-tools <list>]',
	'                  [--add-dir <path>] [--trust]',
	"      Serve Namzu's file and shell tools to another program over stdin and stdout.",
	'      Your permission rules apply to every call. A call that would need your approval is',
	'      refused (nobody can be asked), and the refusal names the rule to add.',
	'',
	'In `add json <name> <json>`, json is the JSON form when exactly two arguments follow it and',
	'the second is a JSON object; otherwise "json" is an ordinary server name.',
	'',
	'Use --format json for structured output. Values of headers, environment',
	'variables and command arguments are hidden in list/get/test output.',
].join('\n')

type McpScope = 'user' | 'project'

type McpAction =
	| { readonly kind: 'list' }
	| { readonly kind: 'get'; readonly name: string }
	| { readonly kind: 'remove'; readonly name: string; readonly scope: McpScope }
	| { readonly kind: 'serve'; readonly args: readonly string[] }
	| { readonly kind: 'test'; readonly name: string; readonly trust: boolean }
	| {
			readonly kind: 'add'
			readonly name: string
			readonly spec: McpServerSpec
			readonly scope: McpScope
	  }
	| {
			readonly kind: 'login'
			readonly name: string
			readonly noBrowser: boolean
			readonly timeoutMs: number
	  }
	| { readonly kind: 'logout'; readonly name: string }
	| { readonly kind: 'approve'; readonly names: readonly string[]; readonly newList: boolean }
	| { readonly kind: 'error'; readonly message: string }

/** Answer yes for the servers this project's `.mcp.json` declares, as it reads now. */
function approveProjectServers(
	names: readonly string[],
	newList: boolean,
	ctx: CommandContext,
): number {
	try {
		const cwd = process.cwd()
		// Asked for by name: the old list's bytes are kept and read back before it is replaced.
		const kept = newList ? startNewMcpApprovals(resolveNamzuHome()) : undefined
		const started = kept
			? `Started a new tool server approvals list; the old one is kept in ${oneLine(kept)}.`
			: undefined
		const { declared, pending } = pendingProjectMcpServers({ cwd })
		const known = Object.keys(declared)
		if (known.length === 0) {
			ctx.formatter.print({
				approved: [],
				...(kept ? { keptAt: kept } : {}),
				text: [started, "This project's .mcp.json declares no tool servers."]
					.filter(Boolean)
					.join('\n'),
			})
			return EXIT_OK
		}
		const missing = names.filter((name) => !known.includes(name))
		if (missing.length > 0) {
			ctx.formatter.error({
				message: `.mcp.json has no tool server named ${missing.map(oneLine).join(', ')}.`,
			})
			return EXIT_USAGE
		}
		const chosen = names.length > 0 ? names : pending
		if (chosen.length === 0) {
			ctx.formatter.print({
				approved: [],
				...(kept ? { keptAt: kept } : {}),
				text: [started, 'Every tool server in .mcp.json is already approved.']
					.filter(Boolean)
					.join('\n'),
			})
			return EXIT_OK
		}
		const approved = approveProjectMcpServers(resolveNamzuHome(), cwd, declared, chosen)
		const lines = approved.map((name) => {
			const entry = declared[name] as { command?: string; url?: string }
			return `  ${oneLine(name)}: ${oneLine(entry.command ?? entry.url ?? 'invalid entry')}`
		})
		ctx.formatter.print({
			approved,
			...(kept ? { keptAt: kept } : {}),
			text: [
				...(started ? [started] : []),
				`Approved ${approved.length === 1 ? '1 tool server' : `${approved.length} tool servers`}:`,
				...lines,
			].join('\n'),
		})
		return EXIT_OK
	} catch (error) {
		ctx.formatter.error({
			message: error instanceof Error ? oneLine(error.message) : 'Could not read .mcp.json.',
		})
		return EXIT_BAD_CONFIG
	}
}

export const mcpCommand: CommandDef = {
	name: 'mcp',
	description: 'Manage user tool servers',
	passThrough: true,
	help: HELP,
	handler: async ({ ctx, rawArgs }) => {
		const action = parseMcpAction(rawArgs)
		if (action.kind === 'error') {
			// A retired spelling is the bare line naming the new form, as for a retired command.
			if (action.message === RETIRED_ENV || action.message === RETIRED_HEADER) {
				process.stderr.write(`${action.message}\n`)
				return EXIT_USAGE
			}
			ctx.formatter.error({ message: action.message })
			return EXIT_USAGE
		}
		if (action.kind === 'serve') {
			const { runMcpServe } = await import('./mcp-serve.js')
			return runMcpServe({
				args: action.args,
				ctx,
				input: process.stdin,
				output: process.stdout,
				cwd: process.cwd(),
			})
		}
		if (action.kind === 'approve') return approveProjectServers(action.names, action.newList, ctx)
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
		if ((action.kind === 'add' || action.kind === 'remove') && action.scope === 'project') {
			return changeProjectFile(action, ctx)
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

/** `add` and `remove` with `--scope project`: the project's own `.mcp.json`, in this folder. */
function changeProjectFile(
	action: Extract<McpAction, { kind: 'add' }> | Extract<McpAction, { kind: 'remove' }>,
	ctx: CommandContext,
): number {
	const cwd = resolve(process.cwd())
	try {
		if (action.kind === 'remove') {
			if (!removeProjectMcpServer(cwd, action.name)) {
				ctx.formatter.error({
					message: `No tool server named "${oneLine(action.name)}" in .mcp.json.`,
				})
				return EXIT_USAGE
			}
			ctx.formatter.print({
				file: '.mcp.json',
				name: action.name,
				text: `Removed tool server ${oneLine(action.name)} from .mcp.json.`,
			})
			return EXIT_OK
		}
		if (projectMcpServerNames(cwd).includes(action.name)) {
			ctx.formatter.error({
				message: `Tool server "${oneLine(action.name)}" already exists in .mcp.json.`,
			})
			return EXIT_USAGE
		}
		const file = addProjectMcpServer(cwd, action.name, action.spec)
		const server = summarizeUserMcpServer({ name: action.name, spec: action.spec })
		ctx.formatter.print({
			file,
			server,
			approval: 'waiting',
			text: `Added tool server ${oneLine(action.name)} to ${oneLine(file)}. It does not start until you run: namzu mcp approve ${oneLine(action.name)}`,
		})
		return EXIT_OK
	} catch (error) {
		ctx.formatter.error({
			message: error instanceof Error ? oneLine(error.message) : 'Could not change .mcp.json.',
		})
		return EXIT_BAD_CONFIG
	}
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
			reason = safeTestReason(failed.reason, spec)
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
export function safeTestReason(reason: string, spec: McpServerSpec): string {
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
		'requestTimeoutMs',
		'resetTimeoutOnProgress',
		'maxTotalTimeoutMs',
		'allow',
		'deny',
		'maxRetries',
		'requireApproval',
		'readOnlyHintTrusted',
		'instructions',
		'alwaysLoad',
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
				? 'HTTP 401: sign in to this server with namzu mcp login <name>'
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

/** Why an old spelling is gone, in one line naming the new form. */
const RETIRED_ENV = '`--env NAME` is now `--env NAME=${NAME}`.'
const RETIRED_HEADER = "`--header NAME=VALUE` is now `--header 'NAME: VALUE'`."

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[A-Za-z0-9-]+$/
const HEADER_REFERENCE = /^(?:Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
const LITERAL_SECRET =
	'--header needs a value of the form ${ENV_VAR} or Bearer ${ENV_VAR}; literal secrets are refused so they are not written to a file.'

/** The scope word, or the sentence saying which words there are. */
function scopeOf(value: string | undefined): McpScope | { readonly error: string } {
	if (value === 'user' || value === 'project') return value
	return { error: '--scope must be user or project.' }
}

/** A JSON object written as one argument, or undefined when the argument is anything else. */
function jsonObjectOf(text: string | undefined): Record<string, unknown> | undefined {
	if (text === undefined) return undefined
	try {
		const parsed: unknown = JSON.parse(text)
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}

/** The arguments of `add` with any `--scope` pair taken out, and the scope they named. */
function takeScope(
	args: readonly string[],
): { readonly rest: readonly string[]; readonly scope: McpScope } | { readonly error: string } {
	const rest: string[] = []
	let scope: McpScope = 'user'
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string
		if (arg === '--') {
			rest.push(...args.slice(index))
			break
		}
		if (arg === '-s' || arg === '--scope') {
			const found = scopeOf(args[++index])
			if (typeof found !== 'string') return found
			scope = found
			continue
		}
		rest.push(arg)
	}
	return { rest, scope }
}

/** What is wrong with a header value written for `--header` or inside a JSON entry. */
function headerValueProblem(headers: Record<string, unknown>): string | undefined {
	for (const [name, value] of Object.entries(headers)) {
		if (!HEADER_NAME.test(name) || typeof value !== 'string' || !HEADER_REFERENCE.test(value)) {
			return LITERAL_SECRET
		}
	}
	return undefined
}

/** The checks `add` has always made on an address and its headers, in one place. */
function remoteProblem(url: string, headers: Record<string, unknown>): string | undefined {
	const address = mcpAddressProblem(url)
	if (address) return address
	if (Object.keys(headers).length > 0) {
		const parsed = new URL(url)
		const remoteInsecure =
			parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
		if (remoteInsecure) return 'Credential headers require HTTPS or a loopback endpoint.'
	}
	return undefined
}

/** `add json <name> <json>`: one entry, checked the way a session checks it when it starts the server. */
function parseAddJson(name: string, entry: Record<string, unknown>, scope: McpScope): McpAction {
	if (!isUserMcpName(name)) return { kind: 'error', message: MCP_NAME_RULE }
	const { type, ...spec } = entry
	if (type === 'sse') {
		return {
			kind: 'error',
			message: 'Servers that need Server-Sent Events are not supported. Use an http server.',
		}
	}
	if (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'streamable-http') {
		return { kind: 'error', message: '"type" must be stdio or http.' }
	}
	const problem = mcpServerSpecProblem(spec)
	if (problem) return { kind: 'error', message: `The server entry is not valid: ${problem}.` }
	if (typeof spec.url === 'string') {
		const headers = (spec.headers ?? {}) as Record<string, unknown>
		const bad = headerValueProblem(headers) ?? remoteProblem(spec.url, headers)
		if (bad) return { kind: 'error', message: bad }
	}
	return { kind: 'add', name, spec: spec as McpServerSpec, scope }
}

function parseMcpAction(args: readonly string[]): McpAction {
	const [verb, name] = args
	if (verb === 'serve') return { kind: 'serve', args: args.slice(1) }
	if (verb === 'approve') {
		const rest = args.slice(1)
		const newList = rest.includes('--new-list')
		const names = rest.filter((entry) => entry !== '--new-list')
		const flag = names.find((entry) => entry.startsWith('-'))
		return flag
			? { kind: 'error', message: `Unknown mcp approve option: ${oneLine(flag)}` }
			: { kind: 'approve', names, newList }
	}
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
	if (verb === 'get' && args.length === 2 && name !== undefined) return { kind: 'get', name }
	if (verb === 'remove') {
		const taken = takeScope(args.slice(1))
		if ('error' in taken) return { kind: 'error', message: taken.error }
		if (taken.rest.length === 1 && taken.rest[0] !== undefined && !taken.rest[0].startsWith('-')) {
			return { kind: 'remove', name: taken.rest[0], scope: taken.scope }
		}
	}
	if (
		verb === 'test' &&
		name &&
		(args.length === 2 || (args.length === 3 && args[2] === '--trust'))
	) {
		return { kind: 'test', name, trust: args[2] === '--trust' }
	}
	if (verb !== 'add') {
		return {
			kind: 'error',
			message:
				'Usage: namzu mcp <list|get|add|remove|test|login|logout|serve>; new server names must start with a letter and use only letters, digits, _ or -.',
		}
	}
	return parseMcpAdd(args.slice(1))
}

function parseMcpAdd(args: readonly string[]): McpAction {
	const taken = takeScope(args)
	if ('error' in taken) return { kind: 'error', message: taken.error }
	const { scope } = taken
	// `add json <name> <json>`: the JSON form only when exactly two arguments follow `json` and the
	// second is a JSON object. Anything else keeps "json" as an ordinary server name.
	if (taken.rest.length === 3 && taken.rest[0] === 'json') {
		const entry = jsonObjectOf(taken.rest[2])
		if (entry !== undefined) return parseAddJson(taken.rest[1] as string, entry, scope)
	}
	let name: string | undefined
	let url: string | undefined
	let transport: 'stdio' | 'http' | undefined
	const env: Record<string, string> = {}
	const headers: Record<string, string> = {}
	let tail: readonly string[] | undefined
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string
		if (arg === '-s' || arg === '--scope') {
			index++
			continue
		}
		if (arg === '--') {
			tail = args.slice(index + 1)
			break
		}
		if (arg === '--url') {
			url = args[++index]
			if (!url) return { kind: 'error', message: '--url requires an HTTP URL.' }
			continue
		}
		if (arg === '-t' || arg === '--transport') {
			const value = args[++index]
			if (value === 'sse') {
				return {
					kind: 'error',
					message: 'Servers that need Server-Sent Events are not supported. Use --transport http.',
				}
			}
			if (value !== 'stdio' && value !== 'http') {
				return { kind: 'error', message: '--transport must be stdio or http.' }
			}
			transport = value
			continue
		}
		if (arg === '-e' || arg === '--env') {
			const entry = args[++index]
			const split = entry?.indexOf('=') ?? -1
			if (entry !== undefined && split === -1 && ENV_NAME.test(entry)) {
				return { kind: 'error', message: RETIRED_ENV }
			}
			if (!entry || split <= 0 || !ENV_NAME.test(entry.slice(0, split))) {
				return { kind: 'error', message: '--env requires NAME=value.' }
			}
			env[entry.slice(0, split)] = entry.slice(split + 1)
			continue
		}
		if (arg === '-H' || arg === '--header') {
			const header = args[++index]
			if (header !== undefined && /^[A-Za-z0-9-]+=/.test(header)) {
				return { kind: 'error', message: RETIRED_HEADER }
			}
			const split = header?.indexOf(':') ?? -1
			if (!header || split <= 0) {
				return {
					kind: 'error',
					message: "--header requires 'NAME: ${ENV_VAR}' or 'NAME: Bearer ${ENV_VAR}'.",
				}
			}
			const headerName = header.slice(0, split).trim()
			const value = header.slice(split + 1).trim()
			if (!HEADER_NAME.test(headerName) || !HEADER_REFERENCE.test(value)) {
				return { kind: 'error', message: LITERAL_SECRET }
			}
			headers[headerName] = value
			continue
		}
		if (arg.startsWith('-')) {
			return { kind: 'error', message: `Unknown mcp add option: ${oneLine(arg)}` }
		}
		if (name === undefined) {
			name = arg
			continue
		}
		// With `-t http` before it, the word after the name is the address and flags may follow it.
		if (transport === 'http' && url === undefined) {
			url = arg
			continue
		}
		// Otherwise it starts the command, and everything after it belongs to the command.
		tail = args.slice(index)
		break
	}
	if (!name || !isUserMcpName(name)) {
		return {
			kind: 'error',
			message:
				'Usage: namzu mcp add <name> (--url <http-url> | -- <command> [arguments...]); new server names must start with a letter and use only letters, digits, _ or -.',
		}
	}
	if (url && tail) return { kind: 'error', message: 'Choose --url or a command, not both.' }
	if (url) {
		if (transport === 'stdio') {
			return { kind: 'error', message: '--url is for an http server, not --transport stdio.' }
		}
		if (Object.keys(env).length > 0) {
			return { kind: 'error', message: '--env applies only to a command server.' }
		}
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
		return {
			kind: 'add',
			name,
			scope,
			spec: { url, ...(Object.keys(headers).length ? { headers } : {}) },
		}
	}
	if (Object.keys(headers).length > 0)
		return { kind: 'error', message: '--header applies only to an HTTP server.' }
	if (transport === 'http') {
		return { kind: 'error', message: 'An http server needs an address: add <name> <http-url>.' }
	}
	if (!tail?.[0]) return { kind: 'error', message: 'Provide --url or -- <command> [arguments...].' }
	return {
		kind: 'add',
		name,
		scope,
		spec: {
			command: tail[0],
			...(tail.length > 1 ? { args: tail.slice(1) } : {}),
			...(Object.keys(env).length > 0 ? { env } : {}),
		},
	}
}

function oneLine(value: string): string {
	return terminalDisplayText(value).replaceAll('\n', ' ').replaceAll('\t', ' ')
}
