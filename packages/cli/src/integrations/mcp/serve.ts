/**
 * `namzu mcp serve`: Namzu's built-in file and shell tools as a tool server over stdio, so another
 * program that speaks MCP can use them.
 *
 * The protocol (`initialize`, `tools/list`, `tools/call`, one JSON message per line) is the kernel's
 * `MCPServer` on its stdio transport; nothing but protocol goes to stdout. What lives here is the
 * judgement of every call, by the same rules a Namzu session applies:
 *
 *  1. A tool a rule refuses by name is not listed, and a call to it is refused.
 *  2. The call's arguments must fit the tool's input shape.
 *  3. The gate decides. A `deny` always wins, and nothing below reopens it.
 *  4. A call the rules allow runs. A call they leave to a person is refused, because there is no
 *     person on this channel: the refusal names the allow rule that would let it run. Only the
 *     launch flags widen that (`--permission-mode accept-edits` approves `edit` and `write`;
 *     `bypass` approves whatever no rule asked about). A rule that says `ask` is never approved
 *     by a mode.
 */

import type { Readable, Writable } from 'node:stream'
import {
	AuthorizationGate,
	type AuthorizationRule,
	MCPServer,
	type MCPServerToolProvider,
	type MCPToolDefinition,
	type MCPToolResult,
	NOOP_LOGGER,
	ServerStdioTransport,
	type ToolContext,
	type ToolDefinition,
	generateSessionId,
	generateTurnId,
	zodToMCPJsonSchema,
} from '@namzu/sdk'

import type { PermissionMode } from '../../permissions/mode.js'
import { cliGate } from '../../permissions/read-only-gate.js'

/** Tools of the kernel that need a running session around them, which this server does not have. */
const NOT_SERVED: ReadonlySet<string> = new Set(['job', 'wait_for_job', 'verify_outputs'])

/** What an `accept-edits` launch approves without a person. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['edit', 'write'])

export interface McpToolServerOptions {
	readonly cwd: string
	readonly additionalDirectories?: readonly string[]
	/** The compiled permission rules, flags included. */
	readonly rules: readonly AuthorizationRule[]
	/** Tools a rule refuses by name: left out of the list. */
	readonly withheld?: readonly string[]
	/** From `--permission-mode`; absent means every call that needs a person is refused. */
	readonly mode?: PermissionMode
	readonly tools: readonly ToolDefinition[]
}

function refused(text: string): MCPToolResult {
	return { content: [{ type: 'text', text }], isError: true }
}

/** The allow rule that would let this call run, written the way `--allowed-tools` takes it. */
export function allowRuleFor(toolName: string, input: unknown): string {
	const command =
		typeof input === 'object' && input !== null
			? (input as Record<string, unknown>).command
			: undefined
	if (toolName === 'bash' && typeof command === 'string') {
		const words = command.trim().split(/\s+/u).slice(0, 2).join(' ')
		if (words !== '' && !/[()*?]/u.test(words)) return `bash(${words} *)`
	}
	return toolName
}

/**
 * One tool as the protocol lists it. Whether a call only reads can depend on its input (a shell
 * command), so a tool whose answer needs one lists no hint rather than a guess.
 */
function describeTool(tool: ToolDefinition): MCPToolDefinition {
	let readOnlyHint: boolean | undefined
	try {
		readOnlyHint = tool.isReadOnly?.(undefined as never)
	} catch {
		readOnlyHint = undefined
	}
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: (tool.modelInputSchema ??
			zodToMCPJsonSchema(tool.inputSchema)) as MCPToolDefinition['inputSchema'],
		...(readOnlyHint !== undefined ? { annotations: { readOnlyHint } } : {}),
	}
}

export class NamzuToolProvider implements MCPServerToolProvider {
	private readonly byName = new Map<string, ToolDefinition>()
	private readonly gate: AuthorizationGate
	private readonly sessionId = generateSessionId()

	constructor(private readonly options: McpToolServerOptions) {
		const withheld = new Set(options.withheld ?? [])
		for (const tool of options.tools) {
			if (!NOT_SERVED.has(tool.name) && !withheld.has(tool.name)) this.byName.set(tool.name, tool)
		}
		this.gate = new AuthorizationGate(cliGate(options.rules), NOOP_LOGGER)
	}

	listTools(): MCPToolDefinition[] {
		return [...this.byName.values()].map(describeTool)
	}

	/** Calls that have started and not answered; the server waits for them when its input ends. */
	private readonly running = new Set<Promise<unknown>>()

	async idle(): Promise<void> {
		while (this.running.size > 0) {
			await Promise.allSettled([...this.running])
			// The answer is written a few microtasks after the call settles: let them run.
			await new Promise<void>((done) => setImmediate(done))
		}
	}

	callTool(name: string, args: Record<string, unknown> = {}): Promise<MCPToolResult> {
		const call = this.runCall(name, args)
		this.running.add(call)
		call.finally(() => this.running.delete(call)).catch(() => {})
		return call
	}

	private async runCall(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
		const tool = this.byName.get(name)
		if (!tool) return refused(`Unknown tool: ${name}`)
		const parsed = tool.inputSchema.safeParse(args)
		if (!parsed.success) return refused(`Invalid arguments for ${name}: ${parsed.error.message}`)
		const input = parsed.data
		const why = this.refusal(tool, input)
		if (why) return refused(why)
		try {
			const result = await tool.execute(input, this.context())
			const text = result.success ? result.output : (result.error ?? result.output)
			return { content: [{ type: 'text', text }], ...(result.success ? {} : { isError: true }) }
		} catch (error) {
			return refused(`${name} failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/** Why this call does not run, in words for the program that made it; undefined when it runs. */
	private refusal(tool: ToolDefinition, input: unknown): string | undefined {
		const verdict = this.gate.evaluate({ toolName: tool.name, toolInput: input, toolDef: tool })
		if (verdict.decision === 'deny') return `Refused: ${verdict.reason}.`
		const mode = this.options.mode
		if (mode === 'plan' && tool.isReadOnly?.(input) !== true) {
			return `Refused: ${tool.name} changes things and this server was started with --permission-mode plan, which only allows reading.`
		}
		if (verdict.decision === 'allow') return undefined
		// The gate sent it to a person. Nobody is here to answer.
		const rule = allowRuleFor(tool.name, input)
		const how = `To allow it, add the rule permissions.${tool.name} = "allow" to your settings, or start the server with --allowed-tools "${rule}".`
		if (verdict.matchedRule !== null) {
			return `Refused: a rule asks about this call, and there is no person to answer on this channel. ${how}`
		}
		if (mode === 'bypass') return undefined
		if (mode === 'accept-edits' && EDIT_TOOLS.has(tool.name)) return undefined
		return `Refused: ${tool.name} needs a person's approval and there is no person on this channel. ${how}`
	}

	private context(): ToolContext {
		const turnId = generateTurnId()
		return {
			sessionId: this.sessionId,
			turnId,
			workingDirectory: this.options.cwd,
			additionalDirectories: [...(this.options.additionalDirectories ?? [])],
			abortSignal: new AbortController().signal,
			env: {},
			log: () => {},
			// A search tool skips a file a read rule denies, as it does in a session.
			readDenied: (absolutePath: string) =>
				this.gate.evaluate({
					toolName: 'read',
					toolInput: { path: absolutePath },
					toolDef: this.byName.get('read'),
				}).decision === 'deny',
			permissionContext: {
				mode: this.options.mode ?? 'strict',
				sessionId: this.sessionId,
				turnId,
				workingDirectory: this.options.cwd,
			},
		} as unknown as ToolContext
	}
}

/** Serve `provider` on the given streams until the input ends. */
export async function serveMcpTools(
	provider: NamzuToolProvider,
	streams: { readonly input: Readable; readonly output: Writable },
	version: string,
): Promise<void> {
	const server = new MCPServer({ name: 'namzu', version }, provider)
	const transport = new ServerStdioTransport(streams)
	const ended = new Promise<void>((resolve) => {
		streams.input.once('end', resolve)
		streams.input.once('close', resolve)
	})
	await server.start(transport)
	await ended
	// A client that closes its end right after its last request still gets the answer.
	await provider.idle()
	await server.stop()
}
