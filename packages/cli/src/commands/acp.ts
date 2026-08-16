import {
	ACPServer,
	type AcpAgentGateway,
	HostCommandRegistry,
	type Message,
	type RunEvent,
	ServerStdioTransport,
	ToolRegistry,
	createToolPresenter,
	createUserMessage,
} from '@namzu/sdk'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import { createAgentSession, probeAgentSession } from '../tui/agent.js'
import type { CommandDef } from './types.js'

/** Same read as `cli.ts`'s `--version`: the manifest, never a second copy. */
function readPackageVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url))
		const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
			version?: unknown
		}
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
	} catch {
		return '0.0.0'
	}
}

function defaultPrefs(detected: readonly DetectedProvider[]): Preferences | null {
	const first = detected[0]
	return first
		? { version: 3, providers: [{ id: first.entry.id }], subagents: { active: [] } }
		: null
}

/**
 * `namzu acp` — the agent-client protocol over this process's stdio.
 *
 * This command exists in the same change as the bridge it drives, and that
 * is the point rather than a convenience. `MCPServer` and
 * `ServerStdioTransport` are both exported from this SDK and nothing in the
 * tree ever constructed an `MCPServer`: a complete protocol server with no
 * driver, which reads as a supported feature and is not one. A subprocess
 * test spawns this binary, so removing the registration below fails a test
 * rather than quietly shipping the same shape twice.
 *
 * **stdout belongs to the protocol.** Everything this command prints for a
 * human goes to stderr. The SDK's logger already writes there; what this
 * file must not do is `console.log`, and a test asserts zero non-JSON bytes
 * on the child's stdout under info-level logging.
 */

/**
 * Bridges the SDK session to the one verb the protocol server needs.
 *
 * `onRunEvent` is a session-level hook and the gateway is per-prompt, so the
 * dispatcher is swapped for the duration of each turn rather than the
 * session being rebuilt. A run event arriving between turns — a late tool
 * result, a background job settling — reaches no client, which is correct:
 * there is no prompt for it to belong to.
 */
export async function runAcpCommand(cwd: string): Promise<number> {
	// The session is built LAZILY, at the first prompt.
	//
	// `initialize` and `session/new` are how a client discovers what this
	// agent is and what it requires, and neither needs a model. Building the
	// session up front made a namzu with no configured credential answer a
	// connection attempt by exiting — an editor extension saw a pipe that
	// closed, with the reason on a stderr nobody was reading. Now it gets a
	// working handshake and a refusal naming the missing credential at the
	// moment it actually matters, which is the first prompt.
	let session: Awaited<ReturnType<typeof createAgentSession>> | undefined
	let route: ((event: RunEvent) => void) | undefined

	const ensureSession = async (): Promise<Awaited<ReturnType<typeof createAgentSession>>> => {
		if (session) return session
		const probe = await probeAgentSession()
		const prefs = probe.preferences ?? defaultPrefs(probe.detected)
		if (!prefs) {
			throw new Error(
				'No LLM provider is available on this machine: set a credential in the environment, or run `namzu` interactively to pick one. The protocol handshake succeeded; there is nothing to run a prompt with.',
			)
		}
		session = await createAgentSession(prefs, probe.detected, {
			cwd,
			onRunEvent: (event) => route?.(event),
		})
		if (!session.hasProvider) {
			const hint = session.errorHint ?? 'agent is not ready'
			await session.close()
			session = undefined
			throw new Error(hint)
		}
		return session
	}

	const gateway: AcpAgentGateway = {
		prompt: async ({ prompt, onEvent, signal, ask, history }) => {
			const live = await ensureSession()
			route = onEvent
			try {
				let stopReason: string | undefined
				// The client's human, adapted to this session's own permission
				// shape. The mapping is a rename, and it is written out rather
				// than cast so a third outcome added on either side stops
				// compiling here instead of silently becoming an approval.
				const onPermission = async (request: {
					toolCalls: readonly {
						id: string
						name: string
						summary: string
						isDestructive: boolean
					}[]
				}) => {
					const outcome = await ask({
						sessionId: 'acp',
						toolCalls: request.toolCalls.map((call) => ({
							id: call.id,
							name: call.name,
							input: call.summary,
							isDestructive: call.isDestructive,
						})),
					})
					switch (outcome.kind) {
						case 'approve':
							return { kind: 'approve' as const }
						case 'approve_all':
							return { kind: 'approve-all' as const }
						case 'reject':
							return {
								kind: 'reject' as const,
								...(outcome.feedback ? { feedback: outcome.feedback } : {}),
							}
					}
				}
				// Prior turns first, so a resumed session answers with the
				// conversation it actually had rather than as if it were new.
				const messages = [...(history as Message[]), createUserMessage(prompt)]
				for await (const event of live.send(messages, { signal, onPermission })) {
					if (event.kind === 'done') stopReason = event.stopReason
					// An `error` event is a run that FAILED, and the protocol's word
					// for that is a stop reason rather than a JSON-RPC error: the
					// call itself succeeded, and the turn is what went wrong.
					else if (event.kind === 'error') stopReason = 'error'
				}
				return stopReason === undefined ? {} : { stopReason }
			} finally {
				route = undefined
			}
		},
	}

	const server = new ACPServer({
		transport: new ServerStdioTransport(),
		gateway,
		// The registry, not a list. A host that registers a command later still
		// has it appear, and this file has no place to hard-code one.
		commands: new HostCommandRegistry(),
		presenter: createToolPresenter(new ToolRegistry()),
		agentInfo: { name: 'namzu', version: readPackageVersion() },
	})

	await server.start()

	// Held open until stdin ends. The client owns the lifetime — it spawned
	// this process — so there is no idle timeout to get wrong.
	await new Promise<void>((resolve) => {
		process.stdin.on('end', resolve)
		process.stdin.on('close', resolve)
	})

	await server.stop()
	await session?.close()
	return 0
}

export const acpCommand: CommandDef = {
	name: 'acp',
	description: "Speak the agent-client protocol over this process's stdio",
	handler: async () => runAcpCommand(process.cwd()),
}
