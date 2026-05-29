/**
 * `namzu run-stream [--session <key>] "<prompt>"` — headless STREAMING
 * one-shot. Same engine as `run`, but instead of buffering the final text it
 * emits one compact NDJSON line per `AgentEvent` to stdout
 * (`{"kind":"delta","text":…}`, `{"kind":"tool-start",…}`,
 * `{"kind":"error","message":…}`, `{"kind":"done"}`). A host process (the
 * clawtool desktop) line-scans stdout and renders the turn live — the
 * equivalent of the TUI, driven from another runtime.
 *
 * History: with `--session <key>` the turn is bound to a persisted
 * conversation in the cwd's `.namzu` store (keyed by the embedder's own
 * session id), so prior turns are loaded as context and the new
 * user+assistant pair is appended — that's what lets a reopened session show
 * its past messages (`namzu history --session <key>`). Without `--session`,
 * prior history may be supplied on stdin as a JSON `Message[]` and nothing is
 * persisted (stateless one-shot).
 *
 * Status lines never hit stdout (logger silenced) so every stdout line is a
 * valid JSON event. Provider/credential failures are emitted as a final
 * `{"kind":"error",…}` line (exit 0) so the host surfaces them in-band.
 */

import { configureLogger, type Message } from '@namzu/sdk'

import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import {
	appendMessages,
	loadConversation,
	openSessions,
	resolveConversation,
} from '../integrations/sessions/store.js'
import type { CommandDef } from './types.js'

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return ''
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
	return Buffer.concat(chunks).toString('utf8')
}

function defaultPrefs(detected: readonly DetectedProvider[]): Preferences | null {
	const first = detected[0]
	return first ? { version: 2, provider: first.entry.id, subagents: { active: [] } } : null
}

/** Pull `--session <key>` out of rawArgs; return the key + the remaining (prompt) args. */
function extractSessionFlag(rawArgs: readonly string[]): { key: string | null; rest: string[] } {
	const rest: string[] = []
	let key: string | null = null
	for (let i = 0; i < rawArgs.length; i++) {
		const a = rawArgs[i]
		if (a === '--session' && i + 1 < rawArgs.length) {
			key = rawArgs[++i]
		} else if (a.startsWith('--session=')) {
			key = a.slice('--session='.length)
		} else {
			rest.push(a)
		}
	}
	return { key: key?.trim() || null, rest }
}

/** Parse stdin as a prior Message[]; tolerate the UI's {role,content} shape. */
function parsePriorMessages(raw: string): Message[] {
	const trimmed = raw.trim()
	if (!trimmed) return []
	try {
		const parsed = JSON.parse(trimmed)
		if (!Array.isArray(parsed)) return []
		const out: Message[] = []
		for (const m of parsed) {
			if (!m || typeof m !== 'object') continue
			const role = (m as { role?: unknown }).role
			const content = (m as { content?: unknown }).content
			if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
				const ts = (m as { timestamp?: unknown }).timestamp
				out.push({ role, content, timestamp: typeof ts === 'number' ? ts : Date.now() } as Message)
			}
		}
		return out
	} catch {
		return []
	}
}

export const runStreamCommand: CommandDef = {
	name: 'run-stream',
	description: 'Run a single prompt and stream AgentEvents as NDJSON (for host UIs)',
	passThrough: true,
	handler: async ({ rawArgs }) => {
		const write = (o: unknown): void => {
			process.stdout.write(`${JSON.stringify(o)}\n`)
		}
		const fail = (message: string): number => {
			write({ kind: 'error', message })
			write({ kind: 'done' })
			return 0
		}

		const { key: sessionKey, rest } = extractSessionFlag(rawArgs)
		const prompt = rest.join(' ').trim()
		if (!prompt) return fail('no prompt — pass it as an argument')

		// Resolve the persisted conversation (if a session key was given) so we
		// load prior turns as context and can append this turn afterward. Falls
		// back to stdin-supplied history when running stateless.
		let cli: Awaited<ReturnType<typeof openSessions>> | null = null
		let conversationId: string | null = null
		let prior: Message[] = []
		if (sessionKey) {
			try {
				cli = await openSessions(process.cwd())
				conversationId = await resolveConversation(cli, sessionKey)
				prior = await loadConversation(cli, conversationId as never)
			} catch {
				cli = null // persistence unavailable — run stateless rather than fail
			}
		}
		if (!cli) {
			prior = parsePriorMessages(await readStdin())
		}

		configureLogger({ level: 'silent' })
		const { probeAgentSession, createAgentSession } = await import('../tui/agent.js')
		const probe = await probeAgentSession()
		const prefs = probe.preferences ?? defaultPrefs(probe.detected)
		if (!prefs) {
			return fail(
				'no LLM provider available — set a credential (e.g. ANTHROPIC_API_KEY) or run `namzu` to pick one',
			)
		}

		const session = await createAgentSession(prefs, probe.detected)
		if (!session.hasProvider) return fail(session.errorHint ?? 'agent is not ready')

		const userMessage: Message = { role: 'user', content: prompt, timestamp: Date.now() } as Message
		const messages: Message[] = [...prior, userMessage]

		let assistantText = ''
		try {
			for await (const event of session.send(messages)) {
				if (event.kind === 'delta') assistantText += event.text
				write(event)
			}
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err))
		}

		// Persist the turn so a later `history --session <key>` (and the next
		// turn's context) sees it. Best-effort — a store failure must not lose
		// the reply the user already saw stream.
		if (cli && conversationId) {
			try {
				const assistant: Message = {
					role: 'assistant',
					content: assistantText,
					timestamp: Date.now(),
				} as Message
				await appendMessages(cli, conversationId as never, [userMessage, assistant])
			} catch {
				// non-fatal
			}
		}

		write({ kind: 'done' })
		return 0
	},
}

export const historyCommand: CommandDef = {
	name: 'history',
	description: "Print a session's persisted messages as JSON (for host UIs)",
	passThrough: true,
	handler: async ({ rawArgs }) => {
		const { key } = extractSessionFlag(rawArgs)
		if (!key) {
			process.stdout.write('[]\n')
			return 0
		}
		try {
			const cli = await openSessions(process.cwd())
			const map = await import('../integrations/sessions/store.js')
			// Resolve WITHOUT creating: only emit history for an existing mapping.
			const existing = await resolveExisting(cli, key)
			if (!existing) {
				process.stdout.write('[]\n')
				return 0
			}
			const messages = await loadConversation(cli, existing as never)
			const out = messages
				.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
				.map((m) => ({ role: m.role, content: m.content }))
			process.stdout.write(`${JSON.stringify(out)}\n`)
			void map
			return 0
		} catch {
			process.stdout.write('[]\n')
			return 0
		}
	},
}

/** Look up an existing desktop-key → conversation mapping without creating one. */
async function resolveExisting(
	cli: Awaited<ReturnType<typeof openSessions>>,
	key: string,
): Promise<string | null> {
	const { readFileSync } = await import('node:fs')
	const { join } = await import('node:path')
	try {
		const raw = JSON.parse(readFileSync(join(cli.root, 'desktop-sessions.json'), 'utf8'))
		const id = raw?.[key]
		if (typeof id === 'string' && (await cli.store.getSession(id as never, cli.tenantId))) {
			return id
		}
	} catch {
		// no map / wiped
	}
	return null
}
