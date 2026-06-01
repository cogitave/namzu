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

import type { DetectedProvider, Preferences, ProviderId } from '../integrations/providers/index.js'
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

/**
 * Parsed run-stream flags. A host UI (the clawtool desktop's Namzu tab) drives
 * which namzu persona answers (--instance), with which model (--model) and
 * skills (--skills a,b,c), bound to a persisted conversation (--session).
 * Everything else is the prompt.
 */
interface RunStreamFlags {
	session: string | null
	model: string | null
	provider: string | null
	instance: string | null
	skills: string[]
	rest: string[]
}

function parseRunStreamFlags(rawArgs: readonly string[]): RunStreamFlags {
	const out: RunStreamFlags = {
		session: null,
		model: null,
		provider: null,
		instance: null,
		skills: [],
		rest: [],
	}
	const take = (a: string, name: string, set: (v: string) => void, i: { v: number }): boolean => {
		if (a === `--${name}` && i.v + 1 < rawArgs.length) {
			set(rawArgs[++i.v])
			return true
		}
		if (a.startsWith(`--${name}=`)) {
			set(a.slice(name.length + 3))
			return true
		}
		return false
	}
	for (const idx = { v: 0 }; idx.v < rawArgs.length; idx.v++) {
		const a = rawArgs[idx.v]
		if (take(a, 'session', (v) => (out.session = v.trim() || null), idx)) continue
		if (take(a, 'model', (v) => (out.model = v.trim() || null), idx)) continue
		if (take(a, 'provider', (v) => (out.provider = v.trim() || null), idx)) continue
		if (take(a, 'instance', (v) => (out.instance = v.trim() || null), idx)) continue
		if (
			take(
				a,
				'skills',
				(v) => {
					out.skills = v
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean)
				},
				idx,
			)
		)
			continue
		out.rest.push(a)
	}
	return out
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

		const flags = parseRunStreamFlags(rawArgs)
		const sessionKey = flags.session
		const prompt = flags.rest.join(' ').trim()
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
		let prefs = probe.preferences ?? defaultPrefs(probe.detected)
		if (!prefs) {
			return fail(
				'no LLM provider available — set a credential (e.g. ANTHROPIC_API_KEY) or run `namzu` to pick one',
			)
		}
		// --provider/--model override the persona's configured provider+model for
		// this run, so the Namzu tab's picks win over ~/.namzu/preferences.json.
		if (flags.provider) prefs = { ...prefs, provider: flags.provider as ProviderId }
		if (flags.model) prefs = { ...prefs, model: flags.model }

		const session = await createAgentSession(prefs, probe.detected)
		if (!session.hasProvider) return fail(session.errorHint ?? 'agent is not ready')

		// --skills <a,b,c>: load the named skills' bodies and inject them as the
		// turn's extra system context (the same channel the TUI's /skill uses).
		let extraSystem: string | undefined
		if (flags.skills.length > 0) {
			try {
				const { discoverSkills, loadSkillBody, composeSkillsPrompt } = await import(
					'../skills/store.js'
				)
				const all = discoverSkills({ cwd: process.cwd() })
				const wanted = new Set(flags.skills)
				const active = all
					.filter((s) => wanted.has(s.name))
					.map((s) => ({ name: s.name, body: loadSkillBody(s) }))
				extraSystem = composeSkillsPrompt(active) ?? undefined
			} catch {
				// skills unavailable — run without them rather than fail the turn.
			}
		}

		const userMessage: Message = { role: 'user', content: prompt, timestamp: Date.now() } as Message
		const messages: Message[] = [...prior, userMessage]

		let assistantText = ''
		try {
			for await (const event of session.send(messages, extraSystem ? { extraSystem } : undefined)) {
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
		const key = parseRunStreamFlags(rawArgs).session
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

// skills-json — read-only skill discovery for a host UI (the Namzu tab's skill
// chips). Prints the cwd-resolved skills as a JSON array of {name, description,
// source}. Distinct from the milestone-owned `skills` management command; this
// is the thin enumeration the desktop polls. Empty array on any failure.
export const skillsJSONCommand: CommandDef = {
	name: 'skills-json',
	description: 'Print discovered skills as JSON (for host UIs)',
	passThrough: true,
	handler: async () => {
		try {
			const { discoverSkills } = await import('../skills/store.js')
			const skills = discoverSkills({ cwd: process.cwd() }).map((s) => ({
				name: s.name,
				description: s.description,
				source: s.source,
			}))
			process.stdout.write(`${JSON.stringify(skills)}\n`)
		} catch {
			process.stdout.write('[]\n')
		}
		return 0
	},
}

// providers-json — read-only provider+model discovery for a host UI (the Namzu
// tab's provider/model pickers). Emits every PROVIDER_REGISTRY entry with
// detection state + a best-effort live model list. Distinct from the `providers`
// profile-management command. Empty models[] → the host falls back to a
// free-text model field seeded with `default`. Never throws.
export const providersJSONCommand: CommandDef = {
	name: 'providers-json',
	description: 'Print providers + per-provider models as JSON (for host UIs)',
	passThrough: true,
	handler: async () => {
		try {
			const { configureLogger } = await import('@namzu/sdk')
			configureLogger({ level: 'silent' })
			const { PROVIDER_REGISTRY, ALL_PROVIDER_IDS, findDetected } = await import(
				'../integrations/providers/index.js'
			)
			const { probeAgentSession, listProviderModels } = await import('../tui/agent.js')
			const probe = await probeAgentSession()
			const out: Array<{
				provider: string
				label: string
				detected: boolean
				default: string
				models: Array<{ id: string; name: string }>
			}> = []
			for (const id of ALL_PROVIDER_IDS) {
				const entry = PROVIDER_REGISTRY[id]
				const det = findDetected(probe.detected, id) ?? null
				const models = det ? await listProviderModels(id, det).catch(() => []) : []
				out.push({
					provider: id,
					label: entry.label,
					detected: Boolean(det),
					default: entry.defaultModel,
					models,
				})
			}
			// Detected providers first, so the picker defaults to a usable one.
			out.sort((a, b) => Number(b.detected) - Number(a.detected))
			process.stdout.write(`${JSON.stringify(out)}\n`)
		} catch {
			process.stdout.write('[]\n')
		}
		return 0
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
