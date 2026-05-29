/**
 * `namzu run-stream "<prompt>"` — headless STREAMING one-shot. Same engine
 * as `run`, but instead of buffering the final text it emits one compact
 * NDJSON line per `AgentEvent` to stdout (`{"kind":"delta","text":…}`,
 * `{"kind":"tool-start",…}`, `{"kind":"error","message":…}`, `{"kind":"done"}`).
 * A host process (the clawtool desktop) line-scans stdout and renders the
 * turn live — the equivalent of the TUI, driven from another runtime.
 *
 * Prior conversation history is read from stdin as a JSON `Message[]` (the
 * host owns persistence); the prompt comes from the arguments. This command
 * stays stateless — it does not write a session store — so the host can key
 * history by its own session id (cwd-optional sessions).
 *
 * Status lines never hit stdout (logger is silenced) so every stdout line is
 * a valid JSON event. Provider/credential failures are emitted as a final
 * `{"kind":"error",…}` line (exit 0) so the host surfaces them in-band rather
 * than guessing from a non-zero exit.
 */

import { configureLogger, type Message } from '@namzu/sdk'

import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
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
				out.push({
					role,
					content,
					timestamp: typeof ts === 'number' ? ts : Date.now(),
				} as Message)
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

		const prompt = rawArgs.join(' ').trim()
		if (!prompt) return fail('no prompt — pass it as an argument')

		const stdinRaw = await readStdin()
		const prior = parsePriorMessages(stdinRaw)

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

		const messages: Message[] = [
			...prior,
			{ role: 'user', content: prompt, timestamp: Date.now() } as Message,
		]

		try {
			for await (const event of session.send(messages)) write(event)
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err))
		}
		// session.send already yields a terminal done/error; emit a final done
		// as a safety net so the host's scanner always sees a turn boundary.
		write({ kind: 'done' })
		return 0
	},
}
