/**
 * `namzu run-stream [--session <key>] "<prompt>"` — headless STREAMING
 * one-shot. Same engine as `run`, but instead of buffering the final text it
 * emits one compact NDJSON line per `AgentEvent` to stdout
 * (`{"kind":"delta","text":…}`, `{"kind":"tool-start",…}`,
 * `{"kind":"error","message":…}`, `{"kind":"done"}`). A host process — a
 * desktop app embedding namzu, say — line-scans stdout and renders the turn
 * live: the equivalent of the TUI, driven from another runtime.
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
 *
 * ONE condition breaks that rule and exits non-zero: a working directory the
 * operator has not trusted. Exit 0 is right for a run that STARTED and failed,
 * which a host renders and may sensibly retry; a folder that was never trusted
 * is a refusal to start, and a host that cannot tell the two apart retries the
 * one thing retrying cannot fix. That case gets both — the explanation as an
 * event, and `77` as the fact that nothing ran.
 */

import { type Message, configureLogger } from '@namzu/sdk'

import { EXIT_UNTRUSTED } from '../exit-codes.js'
import type { DetectedProvider, Preferences, ProviderId } from '../integrations/providers/index.js'
import {
	appendMessages,
	loadConversation,
	openSessions,
	resolveConversation,
} from '../integrations/sessions/store.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { resolvePermissionMode } from '../permissions/mode.js'
import { compilePermissions } from '../permissions/rules.js'
import {
	loadSkillsContext,
	parseRunFlags,
	resolveWorkingDirectory,
	unknownOptionMessage,
} from './run-flags.js'
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
	help: [
		'Usage: namzu run-stream <prompt...> [--session <id>] [--cwd <path>]',
		'',
		'Run a single prompt and stream one JSON event per line as the turn',
		'unfolds — text deltas, tool starts and ends, usage, then a terminal',
		'event. Built for a host UI that renders progress rather than waiting',
		'for a final string.',
		'',
		'Takes the same options as `namzu run`, including --permission-mode and',
		'the [permissions] table from the config file.',
		'',
		'The folder has to be trusted: run `namzu` here once and accept the',
		'prompt, or pass --trust for one run. An untrusted folder emits an error',
		'event and exits 77 without running anything — the one case where this',
		'command exits non-zero, because nothing started and a retry cannot help.',
		'',
		'Needs a provider. Set a credential in the environment, or run namzu',
		'once to pick one interactively.',
	].join('\n'),
	handler: async ({ ctx, rawArgs }) => {
		const write = (o: unknown): void => {
			process.stdout.write(`${JSON.stringify(o)}\n`)
		}
		const fail = (message: string): number => {
			write({ kind: 'error', message })
			write({ kind: 'done' })
			return 0
		}

		const flags = parseRunFlags(rawArgs)
		if (flags.unknown.length > 0) return fail(unknownOptionMessage(flags.unknown))
		const sessionKey = flags.session
		const prompt = flags.rest.join(' ').trim()
		if (!prompt) return fail('no prompt — pass it as an argument')
		const resolved = resolveWorkingDirectory(flags.cwd)
		if ('error' in resolved) return fail(resolved.error)
		const cwd = resolved.cwd

		// Before the session store is opened, before anything is read or run in
		// that directory.
		//
		// Reported BOTH ways, which is the one place this command departs from
		// its "every failure is an in-band event and the exit code is 0" rule.
		// That rule is about a run that STARTED and failed, which a host should
		// render and may sensibly retry. This is a refusal to start at all, and
		// a host that cannot tell the two apart will retry the one that must not
		// be retried — so the event carries the explanation and the exit code
		// carries the fact that nothing ran.
		const trust = decideHeadlessTrust({ cwd, trustFlag: flags.trust })
		if (!trust.allowed) {
			write({ kind: 'error', message: trust.message ?? 'folder not trusted' })
			write({ kind: 'done' })
			return EXIT_UNTRUSTED
		}

		// Resolve the persisted conversation (if a session key was given) so we
		// load prior turns as context and can append this turn afterward. Falls
		// back to stdin-supplied history when running stateless.
		let cli: Awaited<ReturnType<typeof openSessions>> | null = null
		let conversationId: string | null = null
		let prior: Message[] = []
		if (sessionKey) {
			try {
				cli = await openSessions(cwd)
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

		// The operator's rules and mode reach this command too. They did not:
		// `[permissions]` was compiled for `run` and never for `run-stream`, so a
		// host UI ran with an empty rule list whatever the config said — the same
		// shape as a flag that parses and does nothing, one level larger, and
		// silent in exactly the same way.
		const modeResult = resolvePermissionMode({
			flag: flags.permissionMode,
			skipPermissions: flags.skipPermissions,
			interactive: false,
		})
		if ('error' in modeResult) return fail(modeResult.error)

		const permissions = compilePermissions(ctx.config.permissions)
		for (const d of permissions.diagnostics) {
			const where = d.pattern ? `permissions.${d.tool}."${d.pattern}"` : `permissions.${d.tool}`
			// In band, because a host line-scanning stdout has no other channel —
			// and a permission the operator believes is in force must never be
			// dropped without saying so.
			write({ kind: 'error', message: `${where}: ${d.message}` })
		}

		// The resolved `--cwd` is what the agent's tools resolve against, not just
		// where the session store lives — a run told to work in another checkout
		// has to glob, read and edit files there.
		const session = await createAgentSession(prefs, probe.detected, {
			cwd,
			rules: permissions.rules,
			permissionMode: modeResult.mode,
			...(ctx.config.mcpServers ? { mcpServers: ctx.config.mcpServers } : {}),
		})
		if (!session.hasProvider) {
			await session.close()
			return fail(session.errorHint ?? 'agent is not ready')
		}
		// A configured tool server that is not here means the turn cannot do what
		// the operator set it up to do, and this command answers a host, not a
		// person who might notice. Refused rather than run short — in band, like
		// every other failure here, because that is what the host reads.
		if (session.mcpFailed.length > 0) {
			const said = session.mcpFailed
				.map((f) => `tool server "${f.name}" is not available: ${f.reason}`)
				.join('; ')
			await session.close()
			return fail(said)
		}

		// --skills <a,b,c>: load the named skills' bodies and inject them as the
		// turn's extra system context (the same channel the TUI's /skill uses).
		const extraSystem = await loadSkillsContext(cwd, flags.skills)

		const userMessage: Message = { role: 'user', content: prompt, timestamp: Date.now() } as Message
		const messages: Message[] = [...prior, userMessage]

		let assistantText = ''
		try {
			for await (const event of session.send(messages, extraSystem ? { extraSystem } : undefined)) {
				if (event.kind === 'delta') assistantText += event.text
				write(event)
			}
		} catch (err) {
			await session.close()
			return fail(err instanceof Error ? err.message : String(err))
		}
		// A stdio tool server is a child process; a command that returns without
		// closing leaves it running.
		await session.close()

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
	help: [
		'Usage: namzu history [--session <id>] [--cwd <path>]',
		'',
		"Print a session's persisted messages as JSON. With no session id the",
		'most recent session for the working directory is used.',
		'',
		'An empty array means the session exists and has no messages yet — it',
		'is not an error.',
	].join('\n'),
	handler: async ({ rawArgs }) => {
		const flags = parseRunFlags(rawArgs)
		const key = flags.session
		if (!key) {
			process.stdout.write('[]\n')
			return 0
		}
		try {
			// `--cwd` is in this command's help too, and picks the `.namzu` store
			// the session is read from. Reading the process's own directory
			// instead means a host asking about a session in another checkout is
			// told `[]` — indistinguishable from a session with no messages.
			const resolved = resolveWorkingDirectory(flags.cwd)
			if ('error' in resolved) {
				process.stdout.write('[]\n')
				return 0
			}
			const cli = await openSessions(resolved.cwd)
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
	help: [
		'Usage: namzu skills-json [--cwd <path>]',
		'',
		'Print the skills discovered for a working directory as JSON. Project',
		'skills come from that directory; user skills come from the home',
		'directory either way.',
		'',
		'An empty array means no skills were found — it is not an error.',
	].join('\n'),
	handler: async ({ rawArgs }) => {
		// Project skills live under the working directory, so a host listing the
		// skills for one checkout while the process sits in another was shown
		// the wrong project's chips — and then `run-stream --cwd <that
		// checkout> --skills <name>` could not find the skill it had just
		// offered. Same flag, same directory, both ends.
		const resolved = resolveWorkingDirectory(parseRunFlags(rawArgs).cwd)
		if ('error' in resolved) {
			process.stdout.write('[]\n')
			return 0
		}
		try {
			const { discoverSkills } = await import('../skills/store.js')
			const skills = discoverSkills({ cwd: resolved.cwd }).map((s) => ({
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
